import { dirname } from "node:path";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 120_000;

export class StateStore {
  constructor(path) {
    this.path = path;
    this.lockPath = `${path}.lock`;
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
    const handle = await this.acquireLock();
    try {
      return await callback();
    } finally {
      await handle.close();
      await unlink(this.lockPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async acquireLock() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o750 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`, "utf8");
        await handle.sync();
        return handle;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = await this.lockOwner();
        if (owner && !processExists(owner.pid)) {
          await unlink(this.lockPath).catch((unlinkError) => {
            if (unlinkError.code !== "ENOENT") throw unlinkError;
          });
          continue;
        }
        await delay(LOCK_WAIT_MS);
      }
    }
    throw new Error("Timed out waiting for DiscussionBridge state lock");
  }

  async lockOwner() {
    try {
      const parsed = JSON.parse(await readFile(this.lockPath, "utf8"));
      return Number.isSafeInteger(parsed?.pid) && parsed.pid > 0 ? parsed : null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      return null;
    }
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
