import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseDocument } from "htmlparser2";
import { fixture, sha, resourceId } from "./fixtures/cms-native-fixture.mjs";
import { ghostCmsNative } from "../src/cms-native-publication.mjs";
import { CmsClient } from "../lib/cms-client.mjs";
import { readGhostPresentation } from "../src/presentation-reader.mjs";
import { buildServer } from "../src/service.mjs";
import { browserDeployment } from "../src/browser-deployment.mjs";
import { normalizeCommentsMode, isInteractiveCommentsMode } from "../src/comments-mode.mjs";
import { isTopicIdentity } from "../src/topic-identity.mjs";
import { assertNativeConversionPreserved } from "../src/native-content-preservation.mjs";

// Synthetic native APIs, private transport and request events only. No socket,
// Ghost process, browser, provider, install, persistent store or source rewrite.
function sourceContent(f, html) {
  const bytes = Buffer.from(html);
  f.context.content = { bytes, html };
  f.context.source.content_sha256 = sha(bytes);
  f.context.source.content_bytes = bytes.length;
}

function nativeFor(f) {
  return ghostCmsNative(f.ghost, { publicFetch: async () => new Response(`<article>${f.object().html}</article>`, { headers: { "Content-Type": "text/html" } }) });
}

async function published(f) {
  const native = nativeFor(f), result = await native.synchronize(f.context);
  return { result, proof: await native.verify({ ...f.context, result }) };
}

test("actual native writer and verification preserve ordered-list numbering", async () => {
  const f = fixture();
  sourceContent(f, '<ol start="5"><li>Five</li><li value="9">Nine</li></ol>');
  const original = structuredClone(f.context.source), bytes = Buffer.from(f.context.content.bytes);
  const { result, proof } = await published(f);
  assert.match(f.object().html, /<ol start="5"><li>Five<\/li><li value="9">Nine<\/li><\/ol>/u);
  assert.equal(result.nativeResult.representation.kind, "full");
  assert.equal(proof.kind, "published");
  assert.deepEqual(f.context.source, original);
  assert.deepEqual(f.context.content.bytes, bytes);
});

test("actual native writer anchors protocol-relative image before sanitizer and verification", async () => {
  const f = fixture(); sourceContent(f, '<img src="//images.example/diagram.png" alt="Diagram">');
  const original = f.context.content.html, bytes = Buffer.from(f.context.content.bytes);
  const { proof } = await published(f);
  assert.match(f.object().html, /src="https:\/\/images\.example\/diagram\.png"/u);
  assert.equal(proof.kind, "published");
  assert.equal(proof.source_content_sha256, sha(bytes));
  assert.equal(f.context.content.html, original);
  assert.deepEqual(f.context.content.bytes, bytes);
});

const passiveHtml = '<ol start="5" reversed type="I"><li value="9">Nine</li></ol><table><tr><th scope="col" colspan="2" abbr="Meaning">Heading</th><td headers="heading" rowspan="2">Value</td></tr></table>';
test("already supported list and table elements retain passive meaning-bearing attributes", async () => {
  const f = fixture(); sourceContent(f, passiveHtml);
  const { proof } = await published(f);
  assert.equal(proof.kind, "published");
  for (const attribute of ['start="5"', 'reversed', 'type="I"', 'value="9"', 'scope="col"', 'colspan="2"', 'abbr="Meaning"', 'headers="heading"', 'rowspan="2"']) assert.ok(f.object().html.includes(attribute), attribute);
});

test("loss observer follows actual retained output rather than banning classes, IDs or unknown handlers", () => {
  const retained = '<p id="anchor" class="custom" onwheel="zoom()">Body</p>';
  assert.doesNotThrow(() => assertNativeConversionPreserved(retained, retained));
  assert.throws(() => assertNativeConversionPreserved(retained, '<p id="anchor" class="custom">Body</p>'), (error) => error.localNativeLimitation === true && error.unsupportedNativeFunctions.includes("source onwheel handler"));
});

const removedFacilities = [
  ['<p onwheel="zoom()">Body</p>', "source onwheel handler"],
  ['<p onanimationend="finish()">Body</p>', "source onanimationend handler"],
  ['<style>.critical::before{content:"Required meaning"}</style><p class="critical"></p>', "source stylesheet content/data"],
  ['<p style="color:red">Red means urgent</p>', "source p style attribute"],
  ['<img src="/image.png" srcset="/small.png 1x, /large.png 2x" alt="Diagram">', "source img srcset attribute"],
];

for (const [html, facility] of removedFacilities) {
  test(`actual native conversion reports ${facility} before write or false full verification`, async () => {
    const f = fixture(); sourceContent(f, html);
    const before = structuredClone(f.context.store.state), source = structuredClone(f.context.source), bytes = Buffer.from(f.context.content.bytes);
    await assert.rejects(published(f), (error) => error.localNativeLimitation === true && error.unsupportedNativeFunctions.includes(facility));
    assert.deepEqual(f.counts(), { creates: 0, updates: 0, catalogReads: 0 });
    assert.deepEqual(f.context.store.state, before);
    assert.deepEqual(f.context.source, source);
    assert.deepEqual(f.context.content.bytes, bytes);
  });
}

test("known-loss preflight uses the same actual conversion before lease renewal", async () => {
  const f = fixture(); sourceContent(f, '<p onwheel="zoom()">Body</p>');
  await assert.rejects(nativeFor(f).preflight(f.context), (error) => error.localNativeLimitation && error.unsupportedNativeFunctions.includes("source onwheel handler"));
  assert.deepEqual(f.counts(), { creates: 0, updates: 0, catalogReads: 0 });
});

test("a newly detected loss retains complete prior native receipt, intent and original evidence", async () => {
  const f = fixture(); await published(f);
  const oldNative = structuredClone(f.object()), oldState = structuredClone(f.context.store.state), counts = f.counts();
  sourceContent(f, '<p onwheel="zoom()">Later edition</p>');
  f.context.source.source_revision = f.context.work.source_revision = "later-edition";
  await assert.rejects(published(f), (error) => error.localNativeLimitation === true);
  assert.deepEqual(f.object(), oldNative);
  assert.deepEqual(f.context.store.state, oldState);
  assert.deepEqual(f.counts(), counts);
});

test("working native math/code, escaped code and empty function placeholders remain representable", async () => {
  const f = fixture();
  sourceContent(f, '<div class="math">x^2</div><pre><code class="language-mermaid">A --&gt; B</code></pre><p>&lt;script&gt;example&lt;/script&gt;</p><script> </script><p onwheel="">Static</p>');
  const { proof } = await published(f);
  assert.equal(proof.kind, "published");
  assert.match(f.object().html, /class="math"/u);
  assert.match(f.object().html, /class="language-mermaid"/u);
  assert.match(f.object().html, /&lt;script&gt;example&lt;\/script&gt;/u);
});

const config = { ghostOrigin: "https://ghost.example", serverUrl: "https://forum.example", adapterOrigin: "https://adapter.example", connectionId: "dbc_0123456789abcdef01234567", connectionSecret: "s".repeat(48) };
const topicId = "9223372036854775807", mappingId = "22222222-2222-4222-8222-222222222222";

function registeredFixture(html) {
  const bytes = Buffer.from(html), captured = `${config.serverUrl}/t/captured-edition/${topicId}`;
  const source = { source_id: "native/source", source_revision: "immutable-edition", topic_id: topicId, topic_url: captured, title: "Source", content_bytes: bytes.length, content_sha256: sha(bytes), source_created_at: null, source_updated_at: null, source_authors: [] };
  const policy = { policy_revision: "policy", enabled: true, selection: "all_public", category_ids: [], include_topic_ids: [], exclude_topic_ids: [], include_unlisted: false, publication_kind: "dynamic", presentation_mode: "full", author_ids: [], taxonomy_ids: [] };
  const connection = { connection_id: config.connectionId, profile: "ghost", destination_origin: config.ghostOrigin, scope_revision: "scope", forum_name: "Forum", directions: ["from_discourse"], policy, publication_lane: "default", native_capabilities: { native_revision: "native", supported_presentations: ["full"], publication_kind: "dynamic", complete_content_supported: true } };
  const record = { resource_id: resourceId, direction: "from_discourse", state: "active", topic_id: topicId, topic_url: captured, external_id: "owned-native", canonical_url: `${config.ghostOrigin}/native/`, source_revision: source.source_revision, source_created_at: null, source_updated_at: null, synchronized_at: null, mapping_id: mappingId };
  const mapping = { mapping_id: mappingId, resource_id: resourceId, connection_id: config.connectionId, source_id: source.source_id, external_id: record.external_id, mapping_revision: "mapping", destination_native_id: "a".repeat(24), canonical_url: record.canonical_url, retired_url_count: 0, mapping_state: "active", presentation_mode: "full", desired_source_revision: source.source_revision, synchronized_source_revision: source.source_revision, publicly_verified_source_revision: source.source_revision, destination_native_revision: "native", source_created_at: null, source_updated_at: null, synchronized_at: null, publicly_verified_at: null };
  const state = { version: 1, posts: {}, presentations: { [resourceId]: {} }, publications: { [resourceId]: { canonical_url: record.canonical_url, topic_id: topicId, cms: { mapping_id: mappingId, source_id: source.source_id, external_id: record.external_id } } }, cms_feed: { binding: { scope_revision: "scope", policy_revision: "policy" }, sources: { [sha(JSON.stringify([source.source_id, source.source_revision]))]: source } } };
  const f = { state, source, record, bytes, calls: [], corrupt: false };
  const client = new CmsClient({ serviceOrigin: config.serverUrl, connectionId: config.connectionId, connectionSecret: config.connectionSecret }, { fetchImplementation: async (address, options) => {
    assert.equal(options.method, "GET"); f.calls.push(address);
    const url = new URL(address); let payload;
    if (url.pathname.endsWith("/connection.json")) payload = connection;
    else if (url.pathname.includes("/bridge-records/")) payload = record;
    else if (url.pathname.includes("/mappings/")) payload = mapping;
    else {
      const part = Buffer.from(bytes); if (f.corrupt) part[0] ^= 1;
      payload = { source_id: source.source_id, source_revision: source.source_revision, content_sha256: source.content_sha256, content_bytes: source.content_bytes, offset: 0, content_base64: part.toString("base64"), next_offset: null };
    }
    const response = new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } }); Object.defineProperty(response, "url", { value: address }); return response;
  } });
  f.request = () => new Promise((resolve) => {
    const store = { read: async () => structuredClone(state) };
    const server = buildServer(config, store, client, { readPresentation: () => readGhostPresentation(config, store, client, resourceId) });
    assert.equal(server.listening, false);
    server.emit("request", { method: "GET", url: `/presentation/${resourceId}`, headers: {} }, { setHeader() {}, writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body }); } });
  });
  return f;
}

class Element {
  constructor(tag = "div", attributes = {}) { this.tagName = tag.toUpperCase(); this.attributes = attributes; this.dataset = {}; this.children = []; this._html = ""; this._text = ""; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  matches() { return false; }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  before() {}
  after() {}
  get innerHTML() { return this._html; }
  set innerHTML(html) {
    this._html = html;
    const opening = /<div\b([^>]*\bdata-discussionbridge-presentation-comments\b[^>]*)>/u.exec(html);
    if (opening) {
      const attributes = {};
      for (const match of opening[1].matchAll(/([\w-]+)="([^"]*)"/gu)) attributes[match[1]] = match[2];
      this.discussion = new Element("div", attributes);
    }
  }
  get textContent() { return this._text; }
  set textContent(text) { this._text = text; this._html = ""; }
  querySelector(selector) { return selector === "[data-discussionbridge-presentation-comments]" ? this.discussion ?? null : null; }
  querySelectorAll() { return []; }
}

const browserSource = (await readFile(new URL("../src/browser-loader.mjs", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gmu, "");
async function browserHandoff(result) {
  const target = new Element("div", { "data-discussionbridge-resource": resourceId });
  const document = { currentScript: { src: `${config.adapterOrigin}/discussionbridge/assets/loader.js` }, head: new Element("head"), querySelector: () => null, querySelectorAll: (selector) => selector === "[data-discussionbridge-resource]" ? [target] : [], createElement: (tag) => new Element(tag), createTreeWalker: () => ({ nextNode: () => false }) };
  const window = { location: { href: `${config.ghostOrigin}/native/` } };
  const fakeFetch = async (address) => { assert.equal(address, `${config.adapterOrigin}/discussionbridge/presentation/${resourceId}`); return { ok: result.status === 200, text: async () => result.body }; };
  // Execute the actual unchanged loader source against an in-process DOM fake.
  // No browser/virtual machine is launched and no fetch reaches a transport.
  new Function("document", "window", "URL", "NodeFilter", "normalizeCommentsMode", "isInteractiveCommentsMode", "isTopicIdentity", "browserDeployment", "mermaid", "katex", "fetch", browserSource)(document, window, URL, { SHOW_TEXT: 4 }, normalizeCommentsMode, isInteractiveCommentsMode, isTopicIdentity, browserDeployment, { initialize() {} }, {}, fakeFetch);
  await new Promise(setImmediate);
  return { target, window };
}

test("registered reader, handler and browser handoff retain captured relative, query, fragment, root and protocol-relative targets", async () => {
  const html = '<a href="../reference?q=1&amp;x=2">Relative</a><a href="?view=full">Query</a><a href="#part">Fragment</a><a href="/root?x=1#part">Root</a><img src="//images.example/diagram.png" alt="Image"><img src="/uploads/image.png" alt="Root image">';
  const f = registeredFixture(html), before = structuredClone(f.state), bytes = Buffer.from(f.bytes);
  const result = await f.request(); assert.equal(result.status, 200);
  const handoff = await browserHandoff(result); assert.equal(handoff.target.textContent, "");
  const actual = [];
  const visit = (node) => { for (const key of ["href", "src"]) if (node.attribs?.[key]) actual.push(node.attribs[key]); for (const child of node.children ?? []) visit(child); };
  visit(parseDocument(handoff.target.innerHTML, { decodeEntities: true }));
  const expected = ["../reference?q=1&x=2", "?view=full", "#part", "/root?x=1#part", "//images.example/diagram.png", "/uploads/image.png"].map((target) => new URL(target, f.source.topic_url).href);
  assert.deepEqual(actual.slice(0, expected.length), expected);
  assert.equal(handoff.window.DiscourseEmbed.topicId, topicId);
  assert.deepEqual(f.state, before);
  assert.deepEqual(f.bytes, bytes);
  assert.equal(f.source.content_sha256, sha(bytes));
});

test("registered immutable descriptor/base disagreement or corrupt bytes fail before browser insertion", async () => {
  for (const kind of ["base", "hash"]) {
    const f = registeredFixture('<a href="../reference">Source</a>');
    if (kind === "base") f.record.topic_url = `${config.serverUrl}/t/later-live-slug/${topicId}`;
    else f.corrupt = true;
    const result = await f.request(); assert.equal(result.status, 502);
    const handoff = await browserHandoff(result);
    assert.equal(handoff.target.innerHTML, "");
    assert.equal(handoff.target.textContent, "Discussion is temporarily unavailable.");
  }
});

test("registered conversion retains the same passive list and table attributes", async () => {
  const result = await registeredFixture(passiveHtml).request();
  assert.equal(result.status, 200);
  for (const attribute of ['start="5"', 'reversed', 'type="I"', 'value="9"', 'scope="col"', 'colspan="2"', 'abbr="Meaning"', 'headers="heading"', 'rowspan="2"']) assert.ok(result.body.includes(attribute), attribute);
});

for (const [html] of removedFacilities) test("registered handler exposes failure instead of inserting a lossy article: " + html.slice(0, 45), async () => {
  const f = registeredFixture(html), before = structuredClone(f.state);
  const result = await f.request(); assert.equal(result.status, 502);
  const handoff = await browserHandoff(result);
  assert.equal(handoff.target.innerHTML, "");
  assert.equal(handoff.target.textContent, "Discussion is temporarily unavailable.");
  assert.deepEqual(f.state, before);
});
