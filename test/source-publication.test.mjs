import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { BridgeClient, ghostRecord } from "../src/bridge-client.mjs";
import { nativePublication, syncPublications } from "../src/publication-sync.mjs";
import { publishSource } from "../src/source-write.mjs";
import { GhostAdminClient } from "../src/ghost-admin-client.mjs";
import { buildServer } from "../src/service.mjs";

const config = { ghostOrigin: "https://ghost.example", ghostAdminOrigin: "https://ghost.example", adapterOrigin: "https://adapter.example", serverUrl: "https://forum.example", connectionId: "dbc_0123456789abcdef01234567", connectionSecret: "s".repeat(48), ghostAdminApiKey: `${"a".repeat(24)}:${"b".repeat(64)}` };
const id = "11111111-1111-4111-8111-111111111111";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const store = () => ({ state: { version: 1, posts: {}, presentations: {}, publications: {} }, async read() { return structuredClone(this.state); }, async update(callback) { await callback(this.state); } });
const current = () => ({ id: "a".repeat(24), title: "Native original", html: "<p>Native original body</p>", url: `${config.ghostOrigin}/original/`, status: "published", tags: [{ name: "#discussionbridge" }], created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-12T00:00:00Z", authors: [{ id: "writer", name: "Writer", url: `${config.ghostOrigin}/author/writer/` }] });
function source(mode = "full") { return { resource_id: id, direction: "from_discourse", state: "healthy", topic_id: 42, topic_url: `${config.serverUrl}/t/native/42`, title: "Source article", content_html: "<p>Owned source body</p>", source: { platform: "discourse", origin: config.serverUrl, topic_id: 42, topic_url: `${config.serverUrl}/t/native/42`, post_id: 99, post_number: 1, post_version: 1, revision: "post:99:version:1", edition: "a".repeat(64), forum_name: "Source Forum", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-12T00:00:00Z", author: { name: "Source Writer", profile_url: `${config.serverUrl}/u/writer` } }, bindings: [{ role: "presentation", state: "active", native_materialization: true, presentation_mode: mode, canonical_url: `${config.ghostOrigin}/received/` }] }; }
function ghost() { return { post: null, creates: 0, updates: 0, async findByResource() { return this.post ? [structuredClone(this.post)] : []; }, async get() { return structuredClone(this.post); }, async create(payload) { this.creates++; this.post = { ...structuredClone(payload), id: "b".repeat(24), url: `${config.ghostOrigin}/received/`, updated_at: "2026-10-12T01:00:00Z" }; }, async update(_id, payload) { this.updates++; Object.assign(this.post, structuredClone(payload), { updated_at: "2026-10-12T02:00:00Z" }); } }; }

test("both publication directions reject normalized calendar dates and preserve exact timestamp chronology", () => {
  for (const invalid of ["2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z", "2026-02-29T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:00:00+01:60", "next Monday"]) {
    const native = { ...current(), updated_at: invalid };
    assert.throws(() => ghostRecord({ post: { current: native } }, config, "calendar"), /source creation\/update dates/u);
    const record = source(); record.source.updated_at = invalid;
    assert.throws(() => nativePublication(record, config), /native source date/u);
  }
  const record = source();
  record.source.created_at = "2024-02-29T10:00:00.123456789+02:00";
  record.source.updated_at = "2024-02-29T08:00:00.123456788Z";
  assert.throws(() => nativePublication(record, config), /precedes creation/u);
  const native = { ...current(), created_at: record.source.created_at, updated_at: record.source.updated_at };
  assert.throws(() => ghostRecord({ post: { current: native } }, config, "calendar"), /source creation\/update dates/u);
  record.source.updated_at = "2024-02-29T08:00:00.123456789Z";
  assert.equal(nativePublication(record, config).updatedAt, record.source.updated_at);
  native.updated_at = record.source.updated_at;
  assert.equal(ghostRecord({ post: { current: native } }, config, "calendar").source_publication.updated_at, record.source.updated_at);
});

test("Ghost To preserves complete original evidence, excerpts within the actual envelope and uses exact CAS retries", async () => {
  const native = current(); native.html = `<p>${'😀 "native" &amp; '.repeat(50000)}</p>`; const before = structuredClone(native), state = store(), requests = [];
  const client = { async resolve(record) { requests.push(structuredClone(record)); return { resource_id: id, topic_id: 42, topic_url: `${config.serverUrl}/t/${requests.length === 1 ? "old" : "new-title"}/42`, outcome: "resolved", core_fallback: false, source_revision: record.source_publication.revision, source_publication_outcome: "updated" }; } };
  const make = () => ghostRecord({ post: { current: native } }, config, `correlation-${requests.length}`);
  await publishSource(make(), config, state, client);
  assert.deepEqual(native, before); assert.ok(Buffer.byteLength(JSON.stringify({ bridge_record: requests[0] })) <= 65536);
  assert.equal(requests[0].source_publication.content_sha256, sha(native.html)); assert.equal(requests[0].source_publication.content_bytes, Buffer.byteLength(native.html)); assert.equal(requests[0].source_publication.excerpted, true); assert.match(requests[0].content_html, /Read more at the source/u);
  native.title = "Updated original"; native.updated_at = "2026-10-12T01:00:00Z"; await publishSource(make(), config, state, client); await publishSource(make(), config, state, client);
  assert.equal(requests[1].source_publication.previous_revision, requests[0].source_publication.revision); assert.deepEqual(requests[2], requests[1]);
  assert.equal(state.state.posts[`ghost-post:${native.id}`].topic_url, `${config.serverUrl}/t/new-title/42`);
  native.url = `${config.ghostOrigin}/moved/`; await assert.rejects(publishSource(make(), config, state, client), /reconciliation/u); assert.equal(requests.length, 3);
  assert.throws(() => ghostRecord({ post: { current: { ...native, tags: [{ name: "#discussionbridge" }, { name: "#discussionbridge-source" }] } } }, config, "c"), /received source-owned/u);
});

test("lost To receipt preserves its original CAS operand and a changed native identity is refused", async () => {
  const native = current(), state = store(), requests = []; let lose = true;
  const client = { async resolve(record) { requests.push(structuredClone(record)); if (lose) { lose = false; throw new Error("Lost receiver response"); } return { resource_id: id, topic_id: 42, topic_url: `${config.serverUrl}/t/native/42`, outcome: "resolved", core_fallback: false, source_revision: record.source_publication.revision, source_publication_outcome: "unchanged" }; } };
  const make = () => ghostRecord({ post: { current: native } }, config, "correlation");
  await assert.rejects(publishSource(make(), config, state, client), /Lost receiver/u); await publishSource(make(), config, state, client); assert.deepEqual(requests[0], requests[1]);
  await assert.rejects(publishSource(make(), config, state, { resolve: async (record) => ({ ...await client.resolve(record), topic_id: 43, topic_url: `${config.serverUrl}/t/other/43` }) }), /reconciliation/u);
  assert.equal(state.state.posts[`ghost-post:${native.id}`].topic_id, 42);
});

test("complete native From editions continue metadata/body while preserving selected mode and unrelated operator content", async () => {
  let record = source(), state = store(), remote = ghost(); const bridge = { records: async () => ({ bridge_records: [record], pagination: { page: 1, pages: 1, total: 1, snapshot: "one" } }) };
  assert.equal((await syncPublications(config, state, bridge, remote)).created, 1);
  assert.equal(remote.post.published_at, record.source.created_at); assert.match(remote.post.html, /Source Forum/u); assert.doesNotMatch(remote.post.html, /Ghost 6\.59\.0|>The Bridge</u);
  remote.post.html = `<p>Operator prefix.</p>${remote.post.html.replace('data-discussionbridge-comments="full"', 'data-discussionbridge-comments="simple"')}<p>Operator suffix.</p>`;
  remote.post.tags.push({ name: "Operator tag" }); record.title = "Edited source title"; record.content_html = "<h2>Edited complete body</h2>"; record.topic_url = `${config.serverUrl}/t/edited/42`; record.source.edition = "b".repeat(64); record.source.updated_at = "2026-10-12T02:00:00Z";
  assert.equal((await syncPublications(config, state, bridge, remote)).updated, 1); assert.equal(remote.creates, 1); assert.equal(remote.post.id, "b".repeat(24)); assert.equal(remote.post.title, record.title); assert.match(remote.post.html, /Edited complete body/u); assert.match(remote.post.html, /data-discussionbridge-comments="simple"/u); assert.match(remote.post.html, /^<p>Operator prefix/u); assert.match(remote.post.html, /Operator suffix.<\/p>$/u); assert.ok(remote.post.tags.some((tag) => tag.name === "Operator tag"));
  const active = structuredClone(record); record = { ...record, title: "Source publication withdrawn", content_html: null, source: { status: "withdrawn", reason: "source_unavailable", edition: "d".repeat(64) } };
  assert.equal((await syncPublications(config, state, bridge, remote)).withdrawn, 1); assert.equal(remote.post.status, "draft"); assert.equal(state.state.publications[id].public_withdrawal_verified, false); assert.equal(state.state.publications[id].topic_url, active.topic_url); assert.equal(Object.hasOwn(state.state.publications[id], "html"), false);
  record = active; record.source.edition = "e".repeat(64); assert.equal((await syncPublications(config, state, bridge, remote)).updated, 1); assert.equal(remote.post.status, "published"); assert.match(remote.post.html, /Operator suffix/u); assert.equal(remote.creates, 1);
  remote.post.title = "Operator changed managed title"; record.source.edition = "f".repeat(64); const edits = remote.updates; assert.equal((await syncPublications(config, state, bridge, remote)).failed, 1); assert.equal(remote.post.title, "Operator changed managed title"); assert.equal(remote.updates, edits);
});

test("negotiated large From source validates bytes and unchanged authorized editions avoid chunk retrieval", async () => {
  const record = source("interactive"), content = Buffer.from(`<p>${"Complete 😀 source ".repeat(50000)}</p>`), state = store(), remote = ghost(); record.content_html = null; record.source.content = { bytes: content.length, sha256: sha(content), chunk_bytes: 32768, path: `/discussion-bridge/v1/bridge-records/${id}/content.json` }; let chunks = 0;
  const bridge = new BridgeClient(config, async (address, options) => { const url = new URL(address); assert.equal(options.headers["X-DiscussionBridge-Secret"], config.connectionSecret); assert.equal(url.origin, config.serverUrl);
    if (url.pathname.endsWith("/bridge-records.json")) { assert.equal(url.searchParams.get("publication_contract"), "0.3.0-alpha.1"); return json({ bridge_records: [record], pagination: { page: 1, pages: 1, total: 1, snapshot: "one" } }); }
    if (url.pathname.endsWith("/content.json")) { chunks++; const offset = Number(url.searchParams.get("offset")), bytes = content.subarray(offset, offset + 32768), next = offset + bytes.length; return json({ resource_id: id, edition: record.source.edition, offset, total_bytes: content.length, content_sha256: sha(content), chunk_base64: bytes.toString("base64"), next_offset: next === content.length ? null : next }); }
    return json({ bridge_record: record });
  });
  assert.equal((await syncPublications(config, state, bridge, remote)).created, 1); assert.ok(chunks > 1); assert.match(remote.post.html, /Complete 😀 source/u); const count = chunks;
  assert.equal((await syncPublications(config, state, bridge, remote)).unchanged, 1); assert.equal(chunks, count);
  const admin = new GhostAdminClient(config, async (_address, options) => { assert.ok(Buffer.byteLength(options.body) > 256 * 1024); return json({ posts: [{ html: content.toString() }] }); });
  assert.equal((await admin.create({ html: content.toString(), status: "published" })).html, content.toString());
});

test("the chosen signed webhook transport budget admits a complete large original through the single publisher", async () => {
  const native = current(); native.html = `<p>${"Complete native source. ".repeat(12000)}</p>`;
  const state = store(), cfg = { ...config, webhookSecret: "w".repeat(48), webhookMaximumBytes: 1024 * 1024 };
  const payload = JSON.stringify({ post: { current: native } }), timestamp = String(Date.now()); assert.ok(Buffer.byteLength(payload) > 131072);
  const client = { async resolve(record) { assert.equal(record.source_publication.content_sha256, sha(native.html)); return { resource_id: id, topic_id: 42, topic_url: `${config.serverUrl}/t/native/42`, outcome: "resolved", core_fallback: false, source_revision: record.source_publication.revision, source_publication_outcome: "created" }; } };
  const server = buildServer(cfg, state, client); let response;
  const request = { method: "POST", url: "/webhooks/ghost", headers: { "content-type": "application/json", "x-ghost-signature": `sha256=${createHmac("sha256", cfg.webhookSecret).update(payload + timestamp).digest("hex")}, t=${timestamp}` }, async *[Symbol.asyncIterator]() { yield Buffer.from(payload); } };
  const output = { setHeader() {}, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { response = { status: this.status, body }; } };
  await server.listeners("request")[0](request, output);
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).accepted, true); assert.equal(Object.keys(state.state.posts).length, 1);
});

test("source-changing chunk responses refresh coherently and stop after three total attempts", async () => {
  const record = source(); record.content_html = null; record.source.content = { bytes: 20, sha256: "f".repeat(64), path: `/discussion-bridge/v1/bridge-records/${id}/content.json`, chunk_bytes: 32768 }; let details = 0, chunks = 0;
  const client = new BridgeClient(config, async (address) => { if (new URL(address).pathname.endsWith("/content.json")) { chunks++; return json({ outcome: "source_changed" }, 409); } details++; return json({ bridge_record: record }); });
  await assert.rejects(client.record(id), /source changed/u); assert.equal(details, 3); assert.equal(chunks, 3);
});
