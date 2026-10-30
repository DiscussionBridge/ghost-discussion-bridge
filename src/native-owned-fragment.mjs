import { createHash } from "node:crypto";
import { Parser, parseDocument } from "./html-sanitizer.mjs";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const check = (condition, detail) => { if (!condition) throw new Error(detail); };
const blocked = new Set(["template", "noscript", "textarea", "title", "xmp", "plaintext", "iframe", "svg", "math"]);

// Profile ghost-owned-fragment-v1 hashes UTF-8 JSON of the parsed fragment:
// ordered element/text tokens; attribute names sorted; entity text decoded;
// comments omitted. Whitespace text, tag structure and all attributes remain.
// Exactly one active ownership section is admitted; inactive lookalikes fail.
export function ghostOwnedFragment(html, expected = {}) {
  check(typeof html === "string", "Ghost native rendered content is unavailable");
  const contexts = []; let balanced = true;
  const parser = new Parser({ onopentag(name) { contexts.push(name); }, onclosetag(name, implied) { const previous = contexts.pop(); if (previous !== name || implied && blocked.has(name)) balanced = false; } });
  parser.end(html);
  check(balanced && contexts.length === 0, "Ghost native rendered context requires reconciliation");
  const document = parseDocument(html, { decodeEntities: true, withStartIndices: true, withEndIndices: true });
  const matches = [];
  const visit = (node, inactive = false) => {
    const attributes = node.attribs ?? {};
    const hidden = inactive || blocked.has(node.name) || Object.hasOwn(attributes, "hidden") || Object.hasOwn(attributes, "inert") || attributes["aria-hidden"] === "true" || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/iu.test(attributes.style ?? "");
    if (Object.hasOwn(attributes, "data-discussionbridge-owned")) {
      check(!hidden && node.name === "section", "Ghost publication fragment is inactive or unsupported");
      matches.push(node);
    }
    for (const child of node.children ?? []) visit(child, hidden);
  };
  visit(document);
  check(matches.length === 1, "Ghost public page does not have one owned publication fragment");
  const node = matches[0], attributes = node.attribs;
  for (const [key, value] of Object.entries(expected)) check(attributes[key] === value, "Ghost rendered ownership identity/revision differs");
  const tokens = [];
  const canonical = (item) => {
    if (item.type === "text") { tokens.push(["text", item.data]); return; }
    if (item.type === "comment") return;
    if (item.name) tokens.push(["open", item.name, Object.entries(item.attribs ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);
    for (const child of item.children ?? []) canonical(child);
    if (item.name) tokens.push(["close", item.name]);
  };
  canonical(node);
  return { bytes: Buffer.from(JSON.stringify(tokens)), hash: sha(JSON.stringify(tokens)), start: node.startIndex, end: node.endIndex + 1, html: html.slice(node.startIndex, node.endIndex + 1), attributes };
}

