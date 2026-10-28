import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CmsClient } from "../lib/cms-client.mjs";
import { readGhostPresentation } from "../src/presentation-reader.mjs";

const config = { ghostOrigin: "https://ghost.example", serverUrl: "https://forum.example", connectionId: "dbc_0123456789abcdef01234567", connectionSecret: "s".repeat(48) };
const resource = "11111111-1111-4111-8111-111111111111", mappingId = "22222222-2222-4222-8222-222222222222", topic = "9223372036854775807";
const sha = (value) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const bytes = Buffer.from(`<p>${"雪".repeat(30000)}</p>`), source = { source_id: "native/source", source_revision: "revision", topic_id: topic, topic_url: `${config.serverUrl}/t/source/${topic}`, title: "Source", content_bytes: bytes.length, content_sha256: sha(bytes), source_created_at: null, source_updated_at: null, source_authors: [] };
  const policy = { policy_revision: "policy", enabled: true, selection: "all_public", category_ids: [], include_topic_ids: [], exclude_topic_ids: [], include_unlisted: false, publication_kind: "dynamic", presentation_mode: "full", author_ids: [], taxonomy_ids: [] };
  const connection = { connection_id: config.connectionId, profile: "ghost", destination_origin: config.ghostOrigin, scope_revision: "scope", forum_name: "Forum", directions: ["from_discourse"], policy, publication_lane: "default", native_capabilities: { native_revision: "native", supported_presentations: ["full"], publication_kind: "dynamic", complete_content_supported: true } };
  const record = { resource_id: resource, direction: "from_discourse", state: "active", topic_id: topic, topic_url: source.topic_url, external_id: "owned-native", canonical_url: `${config.ghostOrigin}/native/`, source_revision: source.source_revision, source_created_at: null, source_updated_at: null, synchronized_at: null, mapping_id: mappingId };
  const mapping = { mapping_id: mappingId, resource_id: resource, connection_id: config.connectionId, source_id: source.source_id, external_id: record.external_id, mapping_revision: "mapping", destination_native_id: "a".repeat(24), canonical_url: record.canonical_url, retired_url_count: 0, mapping_state: "active", presentation_mode: "full", desired_source_revision: source.source_revision, synchronized_source_revision: source.source_revision, publicly_verified_source_revision: source.source_revision, destination_native_revision: "native", source_created_at: null, source_updated_at: null, synchronized_at: null, publicly_verified_at: null };
  const state = { version: 1, posts: {}, presentations: { [resource]: {} }, publications: { [resource]: { canonical_url: record.canonical_url, topic_id: topic, cms: { mapping_id: mappingId, source_id: source.source_id, external_id: record.external_id } } }, cms_feed: { binding: { scope_revision: "scope", policy_revision: "policy" }, sources: { [sha(JSON.stringify([source.source_id, source.source_revision]))]: source } } };
  const f = { source, bytes, record, mapping, connection, state, calls: [], corrupt: false };
  f.client = new CmsClient({ serviceOrigin: config.serverUrl, connectionId: config.connectionId, connectionSecret: config.connectionSecret }, { fetchImplementation: async (address, options) => {
    assert.equal(options.method, "GET"); assert.equal(options.headers["X-DiscussionBridge-Secret"], config.connectionSecret); f.calls.push(address);
    const url = new URL(address); let payload;
    if (url.pathname.endsWith("/connection.json")) payload = connection;
    else if (url.pathname.includes("/bridge-records/")) payload = record;
    else if (url.pathname.includes("/mappings/")) payload = mapping;
    else {
      const offset = Number(url.searchParams.get("offset")), end = Math.min(bytes.length, offset + 32768), part = Buffer.from(bytes.subarray(offset, end)); if (f.corrupt) part[0] ^= 1;
      payload = { source_id: source.source_id, source_revision: source.source_revision, content_sha256: source.content_sha256, content_bytes: source.content_bytes, offset, content_base64: part.toString("base64"), next_offset: end === bytes.length ? null : end };
    }
    const result = new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } }); Object.defineProperty(result, "url", { value: address }); return result;
  } });
  f.read = () => readGhostPresentation(config, { read: async () => structuredClone(state) }, f.client, resource);
  return f;
}

test("actual V4 registered reader obtains full immutable chunks including split UTF8 and exact CoreId without resolve/work mutation", async () => {
  const f = fixture(), result = await f.read(); assert.equal(result.topic_id, topic); assert.equal(result.content_html, f.bytes.toString("utf8")); assert.ok(Buffer.byteLength(result.content_html) > 49152);
  assert.equal(f.calls.filter((address) => address.includes("/content.json")).length, 3); assert.ok(f.calls.every((address) => address.startsWith(`${config.serverUrl}/discussion-bridge/v4/`)));
});

test("current scope/binding/descriptor/hash disagreement stops the private reader", async () => {
  for (const kind of ["scope", "identity", "descriptor", "hash"]) {
    const f = fixture(); if (kind === "scope") f.connection.scope_revision = "changed"; if (kind === "identity") f.record.topic_id = "42"; if (kind === "descriptor") f.state.cms_feed.sources = {}; if (kind === "hash") f.corrupt = true;
    await assert.rejects(f.read());
  }
});

test("withdrawn current metadata returns withdrawal without fetching stale private source body", async () => {
  const f = fixture(); f.record.state = "withdrawn"; const result = await f.read(); assert.equal(result.state, "withdrawn"); assert.equal(result.content_html, undefined); assert.equal(f.calls.length, 2);
});

for (const mode of ["simple", "full", "interactive"]) {
  test(`registered reader retains selected ${mode} mode and effective forum name`, async () => {
    const f = fixture(); f.connection.policy.presentation_mode = mode;
    f.connection.native_capabilities.supported_presentations = [mode];
    f.mapping.presentation_mode = mode;
    const result = await f.read();
    assert.equal(result.presentation_mode, mode);
    assert.equal(result.forum_name, f.connection.forum_name);
    assert.equal(result.topic_id, topic);
  });
}

test("registered reader refuses unsupported selection and changed mapping mode before fetching content", async () => {
  for (const kind of ["unsupported", "mapping"]) {
    const f = fixture();
    if (kind === "unsupported") f.connection.native_capabilities.supported_presentations = ["simple"];
    else f.mapping.presentation_mode = "interactive";
    await assert.rejects(f.read(), /presentation.*mode|mode.*presentation/iu);
    assert.equal(f.calls.filter((address) => address.includes("/content.json")).length, 0);
  }
});
