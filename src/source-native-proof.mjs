import { createHash } from "node:crypto";
import { Parser, parseDocument } from "./html-sanitizer.mjs";
import { parseCmsJson } from "../lib/cms-runtime.mjs";
import { boundedResponse } from "./bounded-response.mjs";
import { publishedGhostSource } from "./ghost-source.mjs";
import { nativeIntegrationInput } from "./native-integration-input.mjs";

export const SOURCE_NATIVE_PROFILE = "ghost-to-source-article-20261015-r1";
const RECEIPT_DOMAIN = "ghost-to-source-ownership-20261015-r1";
const BEGIN = "<!--discussionbridge-source-move:begin-->", END = "<!--discussionbridge-source-move:end-->";
const META = "discussionbridge-source-move";
export const sourceSha = (value) => createHash("sha256").update(value).digest("hex");
export const sortedTree = (value) => value && typeof value === "object" ? Array.isArray(value) ? value.map(sortedTree) : Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedTree(value[key])])) : value;
export const sourceExact = (a, b) => JSON.stringify(sortedTree(a)) === JSON.stringify(sortedTree(b));
const canonical = (value) => JSON.stringify(sortedTree(value));
const check = (value, reason) => { if (!value) throw new Error(`Ghost source native integration: ${reason}`); };
const closed = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export function sourceNativeIntegration(config) {
  const input = nativeIntegrationInput(config);
  check(closed(input, ["native_version", "theme_id", "permalink", "article", "title", "prefix", "suffix"]), "configure the installed native version/theme/permalink/full-article integration before native movement");
  for (const key of ["native_version", "theme_id"]) check(typeof input[key] === "string" && input[key].trim() && Buffer.byteLength(input[key]) <= 200 && !/[\p{Cc}]/u.test(input[key]), "native version/theme identity is unavailable");
  check(typeof input.permalink === "string" && input.permalink.startsWith("/") && input.permalink.endsWith("/") && input.permalink.split("{slug}").length === 2 && !/[?#\\%]/u.test(input.permalink), "installed literal permalink pattern is unsupported");
  for (const key of ["article", "title"]) check(closed(input[key], ["tag", "class"]) && /^[a-z][a-z0-9-]*$/u.test(input[key].tag) && /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(input[key].class), "exact installed article/title boundary is unavailable");
  check([input.prefix, input.suffix].every((text) => typeof text === "string" && /^\s*$/u.test(text) && text.length <= 256), "template padding must be exact bounded whitespace");
  return structuredClone(input);
}

export function sourceMoveSlug(integration, origin, current, newUrl) {
  check(typeof current.slug === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(current.slug), "native source slug is outside the supported installed permalink operation");
  const [prefix, suffix] = integration.permalink.split("{slug}");
  check(current.url === `${origin}${prefix}${current.slug}${suffix}`, "actual old URL does not match the installed permalink mapping");
  const url = new URL(newUrl);
  check(url.origin === origin && !url.search && !url.hash && !url.username && !url.password && url.pathname.startsWith(prefix) && url.pathname.endsWith(suffix), "requested URL does not match the installed permalink mapping");
  const slug = url.pathname.slice(prefix.length, suffix ? -suffix.length : undefined);
  check(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) && slug.length <= 191 && `${origin}${prefix}${slug}${suffix}` === newUrl, "requested URL cannot be expressed by the supported native slug operation");
  return slug;
}

export function captureSourceNative(post, config) {
  const source = publishedGhostSource(post, config);
  check(post.type === "post" && typeof post.lexical === "string" && typeof post.updated_at === "string", "complete original Lexical representation and actual updated_at CAS are required");
  return { native_id: post.id, native_type: post.type, uuid: post.uuid ?? null, url: post.url, slug: post.slug, updated_at: post.updated_at,
    html: post.html, lexical: post.lexical, title: post.title, authorship: source.authorship,
    tags: (post.tags ?? []).map(({ id, name, slug }) => ({ id: id ?? null, name: name ?? null, slug: slug ?? null })),
    status: post.status, visibility: post.visibility ?? null, created_at: post.created_at ?? null, published_at: post.published_at ?? null,
    canonical_url: post.canonical_url ?? null, codeinjection_head: post.codeinjection_head ?? null, codeinjection_foot: post.codeinjection_foot ?? null };
}

export function sameOriginalSource(before, after, expectedHead) {
  const omit = ({ url, slug, updated_at, codeinjection_head, ...original }) => original;
  check(sourceExact(omit(before), omit(after)) && after.codeinjection_head === expectedHead, "same-post native movement changed original article/title/authorship/identity or unrelated injection");
}

export function sourceChallenge(fields) {
  const payload = { profile: SOURCE_NATIVE_PROFILE, ...fields };
  const content = Buffer.from(canonical(payload)).toString("base64url");
  return { payload, content, block: `${BEGIN}<meta name="${META}" content="${content}">${END}` };
}

export function sourceHead(head, challenge, previousBlock = null) {
  const original = head ?? "";
  check(typeof original === "string", "native per-post injection is unavailable");
  const first = original.indexOf(BEGIN);
  if (first < 0) { check(!original.includes(END), "native owned challenge boundary is ambiguous"); return `${original}${challenge.block}`; }
  const end = original.indexOf(END, first);
  check(end >= first && original.indexOf(BEGIN, first + BEGIN.length) < 0 && original.indexOf(END, end + END.length) < 0 && previousBlock && original.slice(first, end + END.length) === previousBlock, "native challenge does not match retained same-object ancestry");
  return original.slice(0, first) + challenge.block + original.slice(end + END.length);
}

function documentWithDuplicates(html) {
  check(typeof html === "string" && Buffer.from(html).toString("utf8") === html, "native rendered article is not complete UTF8");
  const duplicates = []; let names, parser;
  parser = new Parser({ onopentagname() { names = new Set(); }, onattribute(name) { if (names.has(name)) duplicates.push(parser.startIndex); names.add(name); } }); parser.end(html);
  return { document: parseDocument(html, { decodeEntities: true, withStartIndices: true, withEndIndices: true }), duplicates };
}
function tokens(nodes) {
  const output = [];
  const visit = (node) => {
    if (node.type === "text" || node.type === "comment" || node.type === "directive") { output.push([node.type, node.data]); return; }
    if (node.name) output.push(["open", node.name, Object.entries(node.attribs ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);
    for (const child of node.children ?? []) visit(child);
    if (node.name) output.push(["close", node.name]);
  };
  for (const node of nodes) visit(node);
  return output;
}
function uniqueNode(document, selector) {
  const found = [];
  const walk = (node, inactive = false) => {
    const attrs = node.attribs ?? {}, hidden = inactive || ["template", "noscript", "textarea", "script", "style"].includes(node.name) || Object.hasOwn(attrs, "hidden") || Object.hasOwn(attrs, "inert") || attrs["aria-hidden"] === "true" || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/iu.test(attrs.style ?? "");
    if (node.name === selector.tag && (attrs.class ?? "").split(/\s+/u).includes(selector.class)) { check(!hidden, "configured native article/title is inactive"); found.push(node); }
    for (const child of node.children ?? []) walk(child, hidden);
  };
  walk(document); check(found.length === 1, "public page does not expose exactly one configured complete article/title"); return found[0];
}
const text = (node) => node.type === "text" ? node.data : (node.children ?? []).map(text).join("");

export function sourcePublicArticle(html, expectedHtml, expectedTitle, integration, challenge = null) {
  const parsed = documentWithDuplicates(html), expected = documentWithDuplicates(expectedHtml);
  check(expected.duplicates.length === 0, "duplicate original article attributes cannot be represented faithfully by this profile");
  const article = uniqueNode(parsed.document, integration.article), title = uniqueNode(parsed.document, integration.title);
  check(!parsed.duplicates.some((at) => [article, title].some((node) => at >= node.startIndex && at <= node.endIndex)), "ambiguous native article/title attributes require reconciliation");
  check(text(title).trim() === expectedTitle.trim(), "public native article title differs");
  const children = [...(article.children ?? [])];
  for (const [padding, index] of [[integration.prefix, 0], [integration.suffix, -1]]) if (padding) {
    const node = children.at(index); check(node?.type === "text" && (index === 0 ? node.data.startsWith(padding) : node.data.endsWith(padding)), "installed article template padding differs");
    const data = index === 0 ? node.data.slice(padding.length) : node.data.slice(0, -padding.length);
    if (data) children[index === 0 ? 0 : children.length - 1] = { ...node, data }; else if (index === 0) children.shift(); else children.pop();
  }
  const body = tokens(children), expectedBody = tokens(expected.document.children ?? []);
  check(canonical(body) === canonical(expectedBody), "complete observed native article differs from independently captured expected output");
  if (challenge) {
    const found = [];
    const walk = (node, inHead = false, inactive = false) => {
      const attrs = node.attribs ?? {}, hidden = inactive || ["template", "noscript", "textarea"].includes(node.name);
      if (node.name === "meta" && attrs.name === META) { check(inHead && !hidden && !parsed.duplicates.some((at) => at >= node.startIndex && at <= node.endIndex), "public challenge is not an unambiguous native head binding"); found.push(attrs.content); }
      for (const child of node.children ?? []) walk(child, inHead || node.name === "head", hidden);
    };
    walk(parsed.document); check(found.length === 1 && found[0] === challenge.content, "public issued challenge/native identity/current edition differs");
  }
  const bytes = Buffer.from(canonical([SOURCE_NATIVE_PROFILE, { title: expectedTitle.trim(), article: body, challenge: challenge?.payload ?? null }]));
  return { bytes: bytes.length, sha256: sourceSha(bytes) };
}

function assertSourceHtmlContentType(contentType) {
  const reject = () => { throw new Error("Ghost source proof requires unambiguous text/html metadata with absent charset or UTF-8"); };
  if (typeof contentType !== "string") return reject();
  const value = contentType.replace(/^[\t ]+|[\t ]+$/gu, "");
  const essence = /^text\/html(?=[\t ]*(?:;|$))/iu.exec(value);
  if (!essence) return reject();
  let rest = value.slice(essence[0].length).replace(/^[\t ]+/u, ""), charset = false;
  while (rest) {
    if (rest[0] !== ";") return reject();
    rest = rest.slice(1).replace(/^[\t ]+/u, "");
    const parameter = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)[\t ]*=[\t ]*(?:"((?:[\t\x20-\x21\x23-\x5b\x5d-\x7e]|\\[\t\x20-\x7e])*)"|([!#$%&'*+.^_`|~0-9A-Za-z-]+))[\t ]*/u.exec(rest);
    if (!parameter) return reject();
    if (parameter[1].toLowerCase() === "charset") {
      const encoding = parameter[2] === undefined ? parameter[3] : parameter[2].replace(/\\([\t\x20-\x7e])/gu, "$1");
      if (charset || encoding.toLowerCase() !== "utf-8") return reject();
      charset = true;
    }
    rest = rest.slice(parameter[0].length);
  }
}

export async function observeSourcePublic(config, integration, snapshot, address, challenge, { publicFetch = fetch, assertWriter = async () => {}, now = () => Date.now() } = {}) {
  check(new URL(address).origin === config.ghostOrigin, "public source URL is outside configured origin");
  await assertWriter();
  const { response, bytes } = await boundedResponse(publicFetch, address, { method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", headers: { Accept: "text/html", "Accept-Encoding": "identity" } }, { origin: config.ghostOrigin, mediaType: "text/html", maximumBytes: Math.max(1024 * 1024, Buffer.byteLength(snapshot.html) * 6 + 1024 * 1024), transportError: "Ghost source public verification is unavailable", originError: "Ghost source public origin differs", mediaError: "Ghost source public content is not HTML", limitError: "Ghost source public response exceeds verification transport budget" });
  check(response.status === 200 && !response.redirected && response.url === address, "public source is redirected, inaccessible or not exact configured URL");
  assertSourceHtmlContentType(response.headers.get("content-type"));
  const html = new TextDecoder("utf8", { fatal: true }).decode(bytes), observed = sourcePublicArticle(html, snapshot.html, snapshot.title, integration, challenge);
  await assertWriter(); return { ...observed, checked_at: new Date(now()).toISOString() };
}

export function sourceOwnershipReceipt(fields) {
  const bytes = Buffer.from(canonical([RECEIPT_DOMAIN, fields]));
  return { fields: structuredClone(fields), sha256: sourceSha(bytes), bytes: bytes.length };
}
