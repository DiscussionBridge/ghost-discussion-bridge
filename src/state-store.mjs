import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { link, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 120_000;

export class StateStore {
  constructor(path, { lockTimeoutMs = LOCK_TIMEOUT_MS } = {}) {
    this.path = path;
    this.lockPath = `${path}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    this.tail = Promise.resolve();
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (!parsed || parsed.version !== 1 || typeof parsed.posts !== "object" || typeof parsed.presentations !== "object") throw new Error();
      if (parsed.publications === undefined) parsed.publications = {};
      if (!parsed.publications || typeof parsed.publications !== "object" || Array.isArray(parsed.publications)) throw new Error();
      return parsed;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, posts: {}, presentations: {}, publications: {} };
      throw new Error("Invalid DiscussionBridge state file");
    }
  }

  async write(state) {
    return this.withLock(() => this.writeUnlocked(state));
  }

  async writeUnlocked(state) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o750 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, this.path);
  }

  async update(callback) {
    const operation = this.tail.then(async () => {
      return this.withLock(async () => {
        const state = await this.read();
        await callback(state);
        await this.writeUnlocked(state);
        return state;
      });
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async withLock(callback) {
    const lease = process.platform === "linux"
      ? await this.acquireKernelLock()
      : await this.acquirePortableLock();
    try {
      return await Promise.race([callback(), lease.lost]);
    } finally {
      await lease.release();
    }
  }

  async acquireKernelLock() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o750 });
    const seconds = Math.max(0.001, this.lockTimeoutMs / 1000).toFixed(3);
    const child = spawn("/usr/bin/flock", [
      "--exclusive", "--timeout", seconds, this.lockPath,
      "/bin/sh", "-c", "printf 'acquired\\n'; cat >/dev/null",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let releasing = false;
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-1024); });
    await new Promise((resolve, reject) => {
      let stdout = "";
      const onData = (chunk) => {
        stdout += chunk;
        if (!stdout.includes("\n")) return;
        cleanup();
        if (stdout.trim() === "acquired") resolve();
        else reject(new Error("Invalid DiscussionBridge state lock handshake"));
      };
      const onExit = (code, signal) => {
        cleanup();
        reject(new Error(code === 1
          ? "Timed out waiting for DiscussionBridge state lock"
          : `DiscussionBridge state lock failed (${code ?? signal}): ${stderr.trim()}`));
      };
      const onError = (error) => { cleanup(); reject(error); };
      const cleanup = () => {
        child.stdout.off("data", onData);
        child.off("exit", onExit);
        child.off("error", onError);
      };
      child.stdout.on("data", onData);
      child.once("exit", onExit);
      child.once("error", onError);
    });
    const lost = new Promise((_, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (!releasing) reject(new Error(`DiscussionBridge state lock exited unexpectedly (${code ?? signal}): ${stderr.trim()}`));
      });
    });
    return {
      lost,
      release: async () => {
        releasing = true;
        child.stdin.end();
        if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
        if (child.exitCode !== 0) throw new Error(`DiscussionBridge state lock release failed (${child.exitCode})`);
      },
    };
  }

  async acquirePortableLock() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o750 });
    const deadline = Date.now() + this.lockTimeoutMs;
    while (Date.now() < deadline) {
      const token = randomUUID();
      const candidate = `${this.lockPath}.${process.pid}.${token}.candidate`;
      const handle = await open(candidate, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ token, pid: process.pid })}\n`, "utf8");
        await handle.sync();
        try {
          await link(candidate, this.lockPath);
          await unlink(candidate);
          return {
            lost: new Promise(() => undefined),
            release: () => this.releasePortableLock({ handle, token }),
          };
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      } catch (error) {
        await handle.close();
        await unlink(candidate).catch(() => undefined);
        throw error;
      }
      await handle.close();
      await unlink(candidate).catch(() => undefined);
      await delay(LOCK_WAIT_MS);
    }
    throw new Error("Timed out waiting for DiscussionBridge state lock");
  }

  async releasePortableLock({ handle, token }) {
    try {
      const [held, current, owner] = await Promise.all([
        handle.stat(), stat(this.lockPath), readFile(this.lockPath, "utf8").then(JSON.parse),
      ]);
      if (held.dev === current.dev && held.ino === current.ino && owner?.token === token) await unlink(this.lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally {
      await handle.close();
    }
  }
}
