import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
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
    const lease = await this.acquireLock();
    try {
      return await callback();
    } finally {
      await this.releaseLock(lease);
    }
  }

  async acquireLock() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o750 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const token = randomUUID();
      const candidate = `${this.lockPath}.${process.pid}.${token}.candidate`;
      const handle = await open(candidate, "wx", 0o600);
      try {
        const owner = {
          token,
          pid: process.pid,
          process_start: await processStartToken(process.pid),
          acquired_at: new Date().toISOString(),
        };
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await handle.sync();
        try {
          await link(candidate, this.lockPath);
          await unlink(candidate);
          return { handle, token };
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
      const owner = await this.lockOwner();
      if (await staleOwner(owner)) {
        await this.quarantineLock(owner);
        continue;
      }
      await delay(LOCK_WAIT_MS);
    }
    throw new Error("Timed out waiting for DiscussionBridge state lock");
  }

  async releaseLock(lease) {
    try {
      const [held, current, owner] = await Promise.all([
        lease.handle.stat(),
        stat(this.lockPath),
        this.lockOwner(),
      ]);
      if (held.dev !== current.dev || held.ino !== current.ino || owner?.token !== lease.token) return;
      const released = `${this.lockPath}.released.${lease.token}`;
      await rename(this.lockPath, released);
      await rm(released, { force: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally {
      await lease.handle.close();
    }
  }

  async quarantineLock(expected) {
    const quarantined = `${this.lockPath}.stale.${randomUUID()}`;
    try {
      await rename(this.lockPath, quarantined);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    const moved = await lockOwnerAt(quarantined);
    if (!sameOwner(expected, moved)) {
      try {
        await link(quarantined, this.lockPath);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      await rm(quarantined, { force: true });
      return false;
    }
    await rm(quarantined, { force: true });
    return true;
  }

  async lockOwner() {
    return lockOwnerAt(this.lockPath);
  }
}

async function lockOwnerAt(path) {
  try {
    const info = await stat(path);
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!Number.isSafeInteger(parsed?.pid) || parsed.pid <= 0) return { malformed: true, mtimeMs: info.mtimeMs };
    return { ...parsed, mtimeMs: info.mtimeMs };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    try {
      return { malformed: true, mtimeMs: (await stat(path)).mtimeMs };
    } catch (statError) {
      if (statError.code === "ENOENT") return null;
      throw statError;
    }
  }
}

async function staleOwner(owner) {
  if (!owner) return false;
  if (owner.malformed) return Date.now() - owner.mtimeMs >= 5_000;
  if (!processExists(owner.pid)) return true;
  if (!owner.process_start) return false;
  const currentStart = await processStartToken(owner.pid);
  return currentStart !== null && currentStart !== owner.process_start;
}

function sameOwner(expected, actual) {
  if (!expected || !actual) return expected === actual;
  if (expected.malformed || actual.malformed) return expected.malformed === actual.malformed && expected.mtimeMs === actual.mtimeMs;
  return expected.token === actual.token && expected.pid === actual.pid && expected.process_start === actual.process_start;
}

async function processStartToken(pid) {
  if (process.platform !== "linux") return null;
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = value.lastIndexOf(")");
    if (close < 0) return null;
    const fields = value.slice(close + 2).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
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
