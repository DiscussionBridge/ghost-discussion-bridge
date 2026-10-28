import { open } from "node:fs/promises";

export const MAX_STATE_BYTES = 16 * 1024 * 1024;

const map = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function validState(parsed) {
  if (!map(parsed) || parsed.version !== 1 || !map(parsed.posts) || !map(parsed.presentations)) throw new Error("Invalid DiscussionBridge state file");
  if (!map(parsed.publications)) throw new Error("Invalid DiscussionBridge state file");
  if (Object.hasOwn(parsed, "forum_publications")) throw new Error("DiscussionBridge publication state requires reconciliation into one authority");
  if (parsed.cms_feed !== undefined && !map(parsed.cms_feed) || parsed.cms_journal !== undefined && !map(parsed.cms_journal) || parsed.cms_catalog_refresh !== undefined && !map(parsed.cms_catalog_refresh)) throw new Error("Invalid DiscussionBridge CMS operational state");
  for (const value of Object.values(parsed.publications)) {
    if (!map(value) || (value.ghost_native_type !== undefined && !["post", "page"].includes(value.ghost_native_type))) throw new Error("Invalid DiscussionBridge publication state");
  }
  return parsed;
}

export function serializedState(state) {
  const text = `${JSON.stringify(validState(state), null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error("DiscussionBridge state is too large");
  return text;
}

export async function readStateFile(path) {
  let handle;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Invalid DiscussionBridge state file");
    if (metadata.size > MAX_STATE_BYTES) throw new Error("DiscussionBridge state is too large");
    const chunks = [];
    let size = 0;
    for (;;) {
      // The extra byte detects growth after stat without an unbounded read.
      const chunk = Buffer.allocUnsafe(Math.min(65_536, MAX_STATE_BYTES - size + 1));
      const { bytesRead } = await handle.read(chunk);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_STATE_BYTES) throw new Error("DiscussionBridge state is too large");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return validState(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, posts: {}, presentations: {}, publications: {} };
    throw error;
  } finally { await handle?.close(); }
}
