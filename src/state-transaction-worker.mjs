import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MAX_STATE_BYTES, readStateFile, serializedState, validState } from "./state-file.mjs";

const [statePath, controlPath = "", controlPhase = ""] = process.argv.slice(2);
const temporary = `${statePath}.${process.pid}.tmp`;

async function pauseAt(phase) {
  if (!controlPath || controlPhase !== phase) return;
  await writeFile(`${controlPath}.${phase}.ready`, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  for (;;) {
    try {
      await readFile(`${controlPath}.${phase}.continue`);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await delay(10);
    }
  }
}

async function readCommit() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.byteLength;
    if (size > MAX_STATE_BYTES * 2) throw new Error("DiscussionBridge state transaction is too large");
    chunks.push(chunk);
  }
  const line = Buffer.concat(chunks).toString("utf8").trim();
  if (!line.startsWith("COMMIT ")) throw new Error("DiscussionBridge state transaction was not committed");
  const decoded = Buffer.from(line.slice(7), "base64url");
  if (decoded.byteLength > MAX_STATE_BYTES) throw new Error("DiscussionBridge state is too large");
  return validState(JSON.parse(decoded.toString("utf8")));
}

try {
  await pauseAt("before-read");
  const state = await readStateFile(statePath);
  await pauseAt("after-read");
  process.stdout.write(`STATE ${Buffer.from(JSON.stringify(state)).toString("base64url")}\n`);
  const nextState = await readCommit();
  const serialized = serializedState(nextState);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await pauseAt("after-write");
    await handle.sync();
    await pauseAt("after-sync");
  } finally {
    await handle.close();
  }
  await rename(temporary, statePath);
  await pauseAt("after-rename");
  const directory = await open(dirname(statePath), "r");
  try { await directory.sync(); } finally { await directory.close(); }
  await pauseAt("after-directory-sync");
  process.stdout.write("COMMITTED\n");
  await pauseAt("before-exit");
} catch (error) {
  await unlink(temporary).catch(() => undefined);
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
