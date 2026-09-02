import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, link, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 120_000;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const TRANSACTION_WORKER = fileURLToPath(new URL("./state-transaction-worker.mjs", import.meta.url));

export async function assertStateStoreRuntimePrerequisites() {
  if (process.platform !== "linux") return;
  try {
    await Promise.all([
      access("/usr/bin/flock", fsConstants.X_OK),
      access(process.execPath, fsConstants.X_OK),
    ]);
  } catch {
    throw new Error("DiscussionBridge requires executable /usr/bin/flock (util-linux) and the current Node runtime on Linux");
  }
}

export class StateStore {
  constructor(path, {
    lockTimeoutMs = LOCK_TIMEOUT_MS,
    transactionControlPath = "",
    transactionControlPhase = "",
  } = {}) {
    this.path = path;
    this.lockPath = `${path}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    this.transactionControlPath = transactionControlPath;
    this.transactionControlPhase = transactionControlPhase;
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
    if (process.platform === "linux") return this.runKernelTransaction(async () => state);
    return this.withPortableLock(() => this.writeUnlocked(state));
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
      if (process.platform === "linux") {
        return this.runKernelTransaction(async (state) => {
          await callback(state);
          return state;
        });
      }
      return this.withPortableLock(async () => {
        const state = await this.read();
        await callback(state);
        await this.writeUnlocked(state);
        return state;
      });
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async runKernelTransaction(callback) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o750 });
    const seconds = Math.max(0.001, this.lockTimeoutMs / 1000).toFixed(3);
    const child = spawn("/usr/bin/flock", [
      "--exclusive", "--no-fork", "--timeout", seconds, this.lockPath,
      process.execPath, TRANSACTION_WORKER, this.path,
      this.transactionControlPath, this.transactionControlPhase,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let stateReceived = false;
    let committed = false;
    let resolveState;
    let rejectState;
    let resolveCompletion;
    let rejectCompletion;
    const stateReady = new Promise((resolve, reject) => { resolveState = resolve; rejectState = reject; });
    const completion = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
    completion.catch(() => undefined);
    child.stdin.on("error", () => undefined);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2048); });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_STATE_BYTES * 2) {
        child.kill("SIGKILL");
        return;
      }
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("STATE ") && !stateReceived) {
          try {
            const decoded = Buffer.from(line.slice(6), "base64url").toString("utf8");
            if (Buffer.byteLength(decoded) > MAX_STATE_BYTES) throw new Error();
            stateReceived = true;
            resolveState(JSON.parse(decoded));
          } catch {
            child.kill("SIGKILL");
          }
        } else if (line === "COMMITTED" && stateReceived) {
          committed = true;
        } else {
          child.kill("SIGKILL");
        }
      }
    });
    const fail = (error) => {
      if (!stateReceived) rejectState(error);
      rejectCompletion(error);
    };
    child.once("error", fail);
    // `close` runs after stdout/stderr have drained, so a final COMMITTED frame
    // cannot be mistaken for a failed transaction merely because `exit` raced it.
    child.once("close", (code, signal) => {
      if (code === 0 && committed) resolveCompletion();
      else fail(new Error(code === 1 && !stateReceived
        ? "Timed out waiting for DiscussionBridge state lock"
        : `DiscussionBridge state transaction failed (${code ?? signal}): ${stderr.trim()}`));
    });

    try {
      const state = await stateReady;
      const nextState = await callback(state);
      const serialized = JSON.stringify(nextState);
      if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new Error("DiscussionBridge state is too large");
      child.stdin.end(`COMMIT ${Buffer.from(serialized).toString("base64url")}\n`);
      await completion;
      return nextState;
    } catch (error) {
      child.stdin.end();
      if (child.exitCode === null) child.kill("SIGTERM");
      await completion.catch(() => undefined);
      await unlink(`${this.path}.${child.pid}.tmp`).catch(() => undefined);
      throw error;
    }
  }

  async withPortableLock(callback) {
    const lease = await this.acquirePortableLock();
    try {
      return await callback();
    } finally {
      await lease.release();
    }
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
          return { release: () => this.releasePortableLock({ handle, token }) };
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
