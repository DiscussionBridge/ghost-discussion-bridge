import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CmsClient } from "../lib/cms-client.mjs";
import { createGeneratedExcerpt } from "../lib/cms-runtime.mjs";
import { prepareGhostSourceMove } from "../src/cms-source-move.mjs";
import { publishedGhostSource, nativeSourceBaseline } from "../src/ghost-source.mjs";

const config = { ghostOrigin: "https://ghost.example", serverUrl: "https://forum.example", connectionId: "dbc_0123456789abcdef01234567", connectionSecret: "s".repeat(48) };
const id = "a".repeat(24), key = `ghost-post:${id}`, resource = "11111111-1111-4111-8111-111111111111", moveId = "22222222-2222-4222-8222-222222222222", revision = "accepted-native-edition", topic = "9223372036854775807";
const sha = (value) => createHash("sha256").update(value).digest("hex");
function fixture(generated = false) {
  const native = { id, type: "post", title: "Native article", html: `<p>${generated ? "Safe fixture ".repeat(6000) : "Safe fixture"}</p>`, url: `${config.ghostOrigin}/old/`, status: "published", tags: [{ name: "#discussionbridge" }], authors: [{ id: "writer", name: "Writer" }], created_at: null, updated_at: null };
  const policy = { policy_revision: "policy", enabled: true, selection: "all_public", category_ids: [], include_topic_ids: [], exclude_topic_ids: [], include_unlisted: false, publication_kind: "dynamic", presentation_mode: "full", author_ids: [], taxonomy_ids: [] };
  const connection = { connection_id: config.connectionId, profile: "ghost", destination_origin: config.ghostOrigin, scope_revision: "scope", forum_name: "Forum", directions: ["to_discourse"], policy, publication_lane: "default", native_capabilities: { native_revision: "native", supported_presentations: ["full"], publication_kind: "dynamic", complete_content_supported: true } };
  const record = { resource_id: resource, direction: "to_discourse", state: "active", topic_id: topic, topic_url: `${config.serverUrl}/t/native/${topic}`, external_id: key, canonical_url: native.url, source_revision: revision, source_created_at: null, source_updated_at: null, synchronized_at: null, mapping_id: null };
  let input = { direction: "to_discourse", external_id: key, canonical_url: native.url, title: native.title, content_html: native.html, published: true, source_revision: revision, expected_source_revision: null, source_created_at: null, source_updated_at: null, source_content_sha256: sha(native.html), source_content_bytes: Buffer.byteLength(native.html), representation: { kind: "full" }, source_authors: [{ id: "ghost-author:writer", name: "Writer" }], primary_source_author_id: "ghost-author:writer" };
  if (generated) input = createGeneratedExcerpt(input, native.html, "<p>Selected known-safe prefix</p>");
  let state = { version: 1, posts: { [key]: { source_protocol: "v4", canonical_url: native.url, resource_id: resource, topic_id: topic, cms_source: { accepted_revision: revision, accepted_native_baseline: nativeSourceBaseline(native, publishedGhostSource(native, config)), accepted_input: { mutation_id: resource, bridge_record: input }, accepted_history: [] } } }, publications: {}, presentations: {} };
  const store = { read: async () => structuredClone(state), update: async (callback) => { const next = structuredClone(state); await callback(next); state = next; }, withNativeLock: async (callback) => callback(async () => {}) };
  const f = { native, record, connection, store, posts: [], calls: [], lost: false, paged: false, receipts: new Map() };
  f.client = new CmsClient({ serviceOrigin: config.serverUrl, connectionId: config.connectionId, connectionSecret: config.connectionSecret }, { fetchImplementation: async (address, options) => {
    const path = new URL(address); f.calls.push({ path: path.pathname, method: options.method });
    let payload, status = 200;
    if (path.pathname.endsWith("/connection.json")) payload = connection;
    else if (path.pathname.endsWith("/url-history.json")) payload = !f.paged ? { items: [], next_cursor: null } : path.searchParams.has("cursor") ? { items: [{ url: `${config.ghostOrigin}/ancestry2/`, retired_at: "2026-10-14T00:00:00.000Z", move_id: moveId }], next_cursor: null } : { items: [{ url: `${config.ghostOrigin}/ancestry1/`, retired_at: "2026-10-13T00:00:00.000Z", move_id: resource }], next_cursor: "history_page_2" };
    else if (options.method === "GET") payload = record;
    else {
      assert.equal(path.pathname, `/discussion-bridge/v4/bridge-records/${resource}/source-url-moves.json`);
      const body = JSON.parse(options.body); f.posts.push(body);
      const saved = (await store.read()).posts[key].cms_source.source_url_move;
      assert.deepEqual(saved.intent.body, body); assert.equal(saved.intent.request_state, "uncertain");
      payload = f.receipts.get(body.mutation_id) ?? { move_id: moveId, resource_id: resource, expected_source_revision: revision, old_url: native.url, new_url: body.new_url, proof_nonce: Buffer.alloc(32, 7).toString("base64url"), state: "prepared", prepared_at: "2026-10-14T01:00:00.000Z" }; f.receipts.set(body.mutation_id, payload); status = 201;
      if (f.lost) { f.lost = false; throw new Error("Synthetic accepted prepare loss"); }
    }
    const response = new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } }); Object.defineProperty(response, "url", { value: address }); return response;
  } });
  f.ghost = { getSource: async () => structuredClone(native), update: () => { throw new Error("Source URL write is not authorized by an undefined proof profile"); } };
  f.request = { native_id: id, expected_source_revision: revision, new_url: `${config.ghostOrigin}/new/` };
  f.prepare = () => prepareGhostSourceMove(f.request, config, store, f.client, f.ghost);
  return f;
}

test("defined full/generated source prepare retains exact original article/binding and issued nonce with no native write or fake settlement", async () => {
  for (const generated of [false, true]) {
    const f = fixture(generated), before = await f.store.read(), html = f.native.html, result = await f.prepare(), after = await f.store.read();
    assert.equal(result.state, "native_verification_attention"); assert.equal(result.prepare_response.proof_nonce, Buffer.alloc(32, 7).toString("base64url"));
    assert.equal(after.posts[key].canonical_url, before.posts[key].canonical_url); assert.deepEqual(after.posts[key].cms_source.accepted_input, before.posts[key].cms_source.accepted_input); assert.equal(f.native.html, html);
    assert.ok(f.calls.every((call) => !/\/finalize\.json|\/abort\.json/u.test(call.path))); assert.equal(f.posts.length, 1);
    await f.prepare(); assert.equal(f.posts.length, 1);
  }
});

test("unknown source prepare replays the exact durable mutation/tree without another reservation", async () => {
  const f = fixture(); f.lost = true; await assert.rejects(f.prepare()); const first = (await f.store.read()).posts[key].cms_source.source_url_move.intent.body;
  await f.prepare(); assert.deepEqual(f.posts[1], first); assert.equal(f.receipts.size, 1);
});

test("actual changed article, current scope, revision and known native collision stop source reservation", async () => {
  for (const kind of ["article", "scope", "revision", "collision", "origin"]) {
    const f = fixture(); if (kind === "article") f.native.html = "<p>Different article</p>"; if (kind === "scope") f.connection.policy.enabled = false; if (kind === "revision") f.request.expected_source_revision = "other"; if (kind === "origin") f.request.new_url = "https://other.example/new/";
    if (kind === "collision") await f.store.update(async (state) => { state.publications.another = { canonical_url: f.request.new_url }; });
    await assert.rejects(f.prepare()); assert.equal(f.posts.length, 0);
  }
});

test("actual paged source URL ancestry is durably retained without guessed retired entries or cursor skips", async () => {
  const f = fixture(); f.paged = true; await f.prepare(); const history = (await f.store.read()).posts[key].cms_source.url_history;
  assert.equal(history.complete, true); assert.equal(history.items.length, 2); assert.equal(history.next_cursor, null); assert.deepEqual(history.items.map(({ url }) => url), [`${config.ghostOrigin}/ancestry1/`, `${config.ghostOrigin}/ancestry2/`]);
});
