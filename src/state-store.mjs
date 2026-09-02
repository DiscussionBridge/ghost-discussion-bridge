import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { constants as fsConstants } from "node:fs";
import { access, link, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 120_000;

function failStopAfterKernelLockLoss(error) {
  process.stderr.write(`Fatal DiscussionBridge state-lock ownership loss: ${error.message}\n`);
  process.exit(70);
}

export async function assertStateStoreRuntimePrerequisites() {
  if (process.platform !== "linux") return;
  try {
    await Promise.all([
      access("/usr/bin/flock", fsConstants.X_OK),
      access("/bin/sh", fsConstants.X_OK),
    ]);
  } catch {
    throw new Error("DiscussionBridge requires executable /usr/bin/flock (util-linux) and /bin/sh on Linux");
  }
}

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
      return await callback();
    } finally {
      await lease.release();
    }
  }

  async acquireKernelLock() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o750 });
    const seconds = Math.max(0.001, this.lockTimeoutMs / 1000).toFixed(3);
    const child = spawn("/usr/bin/flock", [
      "--exclusive", "--no-fork", "--timeout", seconds, this.lockPath,
      "/bin/sh", "-c", "printf 'acquired\\n'; cat >/dev/null",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let acquired = false;
    let releasing = false;
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-1024); });
    await new Promise((resolve, reject) => {
      let stdout = "";
      let settled = false;
      const rejectHandshake = (error) => {
        if (settled) return;
        settled = true;
        child.stdout.off("data", onData);
        reject(error);
      };
      const onData = (chunk) => {
        stdout += chunk;
        if (!stdout.includes("\n")) return;
        if (stdout.trim() !== "acquired") {
          rejectHandshake(new Error("Invalid DiscussionBridge state lock handshake"));
          return;
        }
        acquired = true;
        settled = true;
        child.stdout.off("data", onData);
        resolve();
      };
      const onExit = (code, signal) => {
        const error = new Error(code === 1 && !acquired
          ? "Timed out waiting for DiscussionBridge state lock"
          : `DiscussionBridge state lock ${acquired ? "exited unexpectedly" : "failed"} (${code ?? signal}): ${stderr.trim()}`);
        if (!acquired) rejectHandshake(error);
        else if (!releasing) failStopAfterKernelLockLoss(error);
      };
      const onError = (error) => {
        if (!acquired) rejectHandshake(error);
        else if (!releasing) failStopAfterKernelLockLoss(error);
      };
      // Ownership-loss monitoring is live before the handshake can be accepted.
      // There is no listener-transition window in which helper exit can be missed.
      child.once("exit", onExit);
      child.once("error", onError);
      child.stdout.on("data", onData);
    });
    return {
      pid: child.pid,
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
