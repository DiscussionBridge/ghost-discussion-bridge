import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CmsClient } from "../../lib/cms-client.mjs";
import { publishSource } from "../../src/source-write.mjs";
import { prepareGhostSourceHtml } from "../../src/source-preparation.mjs";

const config = { ghostOrigin: "https://ghost.example", serverUrl: "https://forum.example", connectionId: "dbc_0123456789abcdef01234567", connectionSecret: "s".repeat(48) };
const id = "a".repeat(24), key = `ghost-post:${id}`, resource = "11111111-1111-4111-8111-111111111111", topic = "9223372036854775807";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const policy = { policy_revision: "policy", enabled: true, selection: "all_public", category_ids: [], include_topic_ids: [], exclude_topic_ids: [], include_unlisted: false, publication_kind: "dynamic", presentation_mode: "full", author_ids: [], taxonomy_ids: [] };
const connection = { connection_id: config.connectionId, profile: "ghost", destination_origin: config.ghostOrigin, scope_revision: "scope", forum_name: "Forum", directions: ["to_discourse"], policy, publication_lane: "default", native_capabilities: { native_revision: "native", supported_presentations: ["full"], publication_kind: "dynamic", complete_content_supported: true } };
const current = () => ({ id, type: "post", title: "Current native source", html: "<p>Known safe fixture</p>", url: `${config.ghostOrigin}/source/`, status: "published", tags: [{ name: "#discussionbridge" }], authors: [{ id: "writer1", name: "First" }, { id: "writer2", name: "Second" }], created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-14T00:00:00Z" });
function fixture(storeOverride) {
  let state = { version: 1, posts: {}, publications: {}, presentations: {} }, tail = Promise.resolve();
  const store = storeOverride ?? { read: async () => structuredClone(state), update: async (callback) => { const next = structuredClone(state); await callback(next); state = next; }, withNativeLock(callback) { const next = tail.then(() => callback(async () => {})); tail = next.catch(() => {}); return next; } };
  const f = { native: current(), remote: null, store, bodies: [], requests: [], receipts: new Map(), lose: false, reject: false, authority: structuredClone(connection), reads: 0 };
  f.client = new CmsClient({ serviceOrigin: config.serverUrl, connectionId: config.connectionId, connectionSecret: config.connectionSecret }, { fetchImplementation: async (address, options) => {
    const path = new URL(address).pathname; f.requests.push(path);
    const reply = (body, status = 200) => { const result = new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); Object.defineProperty(result, "url", { value: address }); return result; };
    if (options.method === "GET") return reply(path.endsWith("/connection.json") ? f.authority : path.endsWith("/bridge-records.json") ? { items: f.remote ? [f.remote] : [], next_cursor: null } : f.remote);
    assert.equal(path, "/discussion-bridge/v4/bridge-records/resolve.json");
    const body = JSON.parse(options.body); f.bodies.push(body);
    assert.equal(JSON.stringify((await store.read()).posts[key].cms_source.intent.body), options.body);
    assert.equal((await store.read()).posts[key].cms_source.intent.request_state, "uncertain");
    if (f.preservationResponse) return reply(f.preservationResponse, 422);
    if (f.reject) return reply({ outcome: "reconciliation_required", reason: "native_ownership_conflict", resource_id: null, topic_id: null, topic_url: null, direction: "to_discourse", source_revision: null, synchronized_at: null, core_fallback: false }, 409);
    const result = f.receipts.get(body.mutation_id) ?? { outcome: f.remote ? "updated" : "created", reason: f.remote ? "source_revision_updated" : "record_created", resource_id: resource, topic_id: topic, topic_url: `${config.serverUrl}/t/source/${topic}`, direction: "to_discourse", source_revision: body.bridge_record.source_revision, synchronized_at: "2026-10-14T01:00:00.000Z", core_fallback: false };
    f.receipts.set(body.mutation_id, result);
    f.remote = { resource_id: resource, direction: "to_discourse", state: "active", topic_id: topic, topic_url: result.topic_url, external_id: key, canonical_url: f.native.url, source_revision: result.source_revision, source_created_at: body.bridge_record.source_created_at, source_updated_at: body.bridge_record.source_updated_at, synchronized_at: result.synchronized_at, mapping_id: null };
    if (f.lose) { f.lose = false; throw new Error("Synthetic accepted response loss"); }
    return reply(result, result.outcome === "created" ? 201 : 200);
  } });
  // Actual production preparer, native/receiver transports remain pure stubs.
  f.options = { loadCurrentSource: async () => { f.reads++; return structuredClone(f.native); }, prepareSourceHtml: prepareGhostSourceHtml };
  f.publish = (overrides = {}) => publishSource({ native_id: id }, config, store, f.client, { ...f.options, ...overrides });
  return f;
}


export { fixture, config, id, key, resource, topic, sha };
