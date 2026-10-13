import assert from "node:assert/strict";
import { mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { GhostAdminClient } from "../src/ghost-admin-client.mjs";
import { installationEnvironment } from "../src/installation.mjs";
import { nativePublication, syncPublications } from "../src/publication-sync.mjs";
import { MAX_STATE_BYTES, readStateFile, serializedState, validState } from "../src/state-file.mjs";
import { StateStore } from "../src/state-store.mjs";

const config = { adapterOrigin: "https://adapter.example", ghostOrigin: "https://ghost.example", serverUrl: "https://forum.example", ghostAdminApiKey: `${"a".repeat(24)}:${"b".repeat(64)}` };
const resourceId = "11111111-1111-4111-8111-111111111111";
const nativeId = "a".repeat(24);
function source(mode = "full") {
  return { resource_id: resourceId, direction: "from_discourse", state: "healthy", topic_id: 42, title: "Source article", content_html: "<p>Owned body</p>",
    source: { platform: "discourse", origin: config.serverUrl, topic_id: 42, topic_url: `${config.serverUrl}/t/native/42`, post_id: 99, post_number: 1, post_version: 1, revision: "post:99:version:1", edition: "a".repeat(64), author: { name: "Source Writer", profile_url: `${config.serverUrl}/u/writer` }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-12T00:00:00Z" },
    bindings: [{ role: "presentation", state: "active", native_materialization: true, presentation_mode: mode, canonical_url: `${config.ghostOrigin}/native/` }] };
}
function memoryStore(prior) {
  return { state: { version: 1, posts: {}, presentations: {}, publications: prior ? { [resourceId]: structuredClone(prior) } : {} }, async read() { return structuredClone(this.state); }, async update(callback) { await callback(this.state); } };
}
function bridge(getRecord) { return { async records() { return { bridge_records: [structuredClone(getRecord())], pagination: { page: 1, pages: 1, total: 1, snapshot: "stable" } }; } }; }
function ghost(nativeType, state, { loseCreate = false } = {}) {
  return { object: null, creates: 0, updates: 0, visible: !loseCreate,
    async findByResource(id, _budget, selected) { assert.equal(id, resourceId); assert.equal(selected, nativeType); return this.visible && this.object ? [structuredClone(this.object)] : []; },
    async get(id, _budget, selected) { assert.equal(id, nativeId); assert.equal(selected, nativeType); return structuredClone(this.object); },
    async create(payload, selected) {
      assert.equal(selected, nativeType); this.creates++;
      assert.equal(state.state.publications[resourceId].ghost_native_type, nativeType);
      assert.equal(state.state.publications[resourceId].create_outcome_uncertain, true);
      this.object = { ...structuredClone(payload), type: nativeType, id: nativeId, url: `${config.ghostOrigin}/native/`, updated_at: "2026-10-12T01:00:00Z" };
      if (loseCreate) throw new Error("Synthetic lost create receipt");
    },
    async update(id, payload, selected) { assert.equal(id, nativeId); assert.equal(selected, nativeType); this.updates++; Object.assign(this.object, structuredClone(payload), { updated_at: `2026-10-12T02:00:${String(this.updates).padStart(2, "0")}Z` }); },
  };
}
const json = (payload) => new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });

test("installation accepts exactly post/page, while missing config preserves post", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ghost-types-config-"));
  for (const [name, value] of [["connection", "s".repeat(48)], ["webhook", "w".repeat(48)], ["admin", config.ghostAdminApiKey]]) await writeFile(join(directory, name), value);
  const environment = { DISCUSSIONBRIDGE_SERVER_URL: config.serverUrl, DISCUSSIONBRIDGE_GHOST_ORIGIN: config.ghostOrigin, DISCUSSIONBRIDGE_ADAPTER_ORIGIN: config.adapterOrigin, DISCUSSIONBRIDGE_CONNECTION_ID: "dbc_0123456789abcdef01234567", DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE: join(directory, "connection"), DISCUSSIONBRIDGE_GHOST_WEBHOOK_SECRET_FILE: join(directory, "webhook"), DISCUSSIONBRIDGE_GHOST_ADMIN_API_KEY_FILE: join(directory, "admin"), DISCUSSIONBRIDGE_STATE_FILE: join(directory, "state.json") };
  assert.equal(loadConfig(environment).publicationType, "post");
  for (const nativeType of ["post", "page"]) {
    assert.equal(loadConfig({ ...environment, DISCUSSIONBRIDGE_PUBLICATION_TYPE: nativeType }).publicationType, nativeType);
    assert.equal(installationEnvironment(`DISCUSSIONBRIDGE_PUBLICATION_TYPE=${nativeType}`).DISCUSSIONBRIDGE_PUBLICATION_TYPE, nativeType);
  }
  for (const invalid of ["", "pages", "Post", "article"]) assert.throws(() => loadConfig({ ...environment, DISCUSSIONBRIDGE_PUBLICATION_TYPE: invalid }), /PUBLICATION_TYPE/u);
});

for (const nativeType of ["post", "page"]) {
  test(`${nativeType} API uses matching paths/envelopes and cross-type resource census`, async () => {
    const calls = [];
    const client = new GhostAdminClient({ ...config, publicationType: nativeType }, async (address, options) => {
      const url = new URL(address), key = url.pathname.includes("/pages/") ? "pages" : "posts";
      calls.push({ url, options });
      if (options.body) assert.deepEqual(Object.keys(JSON.parse(options.body)), [key]);
      return json({ [key]: options.method === "GET" && url.searchParams.has("filter") ? [] : [{ id: nativeId }] });
    });
    assert.equal((await client.create({ title: "Source" })).type, nativeType);
    assert.equal((await client.get(nativeId)).type, nativeType);
    assert.equal((await client.update(nativeId, { title: "Edit" })).type, nativeType);
    assert.deepEqual(await client.findByResource(resourceId), []);
    assert.equal(calls.length, 5);
    for (const { url } of calls.slice(0, 3)) assert.match(url.pathname, new RegExp(`/ghost/api/admin/${nativeType}s/`, "u"));
    assert.equal(calls[3].url.pathname, `/ghost/api/admin/${nativeType}s/`);
    assert.equal(calls[4].url.pathname, `/ghost/api/admin/${nativeType === "post" ? "pages" : "posts"}/`);
  });

  for (const mode of ["simple", "full", "interactive"]) test(`${nativeType} ${mode} preserves identity, custom body/tags, withdrawal and restore`, async () => {
    const cfg = { ...config, publicationType: nativeType }, state = memoryStore(), remote = ghost(nativeType, state);
    let record = source(mode);
    const feed = bridge(() => record);
    assert.equal((await syncPublications(cfg, state, feed, remote)).created, 1);
    assert.equal(state.state.publications[resourceId].ghost_native_type, nativeType);
    assert.match(remote.object.html, new RegExp(`data-discussionbridge-comments="${mode}"`, "u"));
    remote.object.html = `<p>Operator prefix</p>${remote.object.html}<p>Operator suffix</p>`;
    remote.object.tags.unshift({ name: "Operator tag" });
    record.source.edition = "b".repeat(64); record.source.post_version = 2; record.source.revision = "post:99:version:2"; record.content_html = "<p>Wiki revision</p>";
    assert.equal((await syncPublications(cfg, state, feed, remote)).updated, 1);
    assert.match(remote.object.html, /^<p>Operator prefix/u); assert.match(remote.object.html, /Operator suffix<\/p>$/u);
    assert.equal(remote.object.tags[0].name, "Operator tag");
    const active = structuredClone(record);
    record.source = { status: "withdrawn", edition: "c".repeat(64) }; record.content_html = null;
    assert.equal((await syncPublications(cfg, state, feed, remote)).withdrawn, 1);
    assert.equal(remote.object.status, "draft"); assert.equal(state.state.publications[resourceId].ghost_native_type, nativeType);
    record = active; record.source.edition = "d".repeat(64);
    assert.equal((await syncPublications(cfg, state, feed, remote)).updated, 1);
    assert.equal(remote.object.status, "published"); assert.equal(remote.object.id, nativeId); assert.equal(remote.creates, 1);
  });

  test(`${nativeType} uncertain create stays fenced across retries/source edits and recovers same object`, async () => {
    const cfg = { ...config, publicationType: nativeType }, state = memoryStore(), remote = ghost(nativeType, state, { loseCreate: true });
    const record = source(), feed = bridge(() => record);
    assert.equal((await syncPublications(cfg, state, feed, remote)).failed, 1);
    for (const edition of ["b", "c"]) {
      record.source.edition = edition.repeat(64);
      assert.equal((await syncPublications(cfg, state, feed, remote)).failed, 1);
      assert.equal(remote.creates, 1); assert.equal(state.state.publications[resourceId].ghost_native_type, nativeType);
    }
    remote.visible = true;
    assert.equal((await syncPublications(cfg, state, feed, remote)).updated, 1);
    assert.equal(remote.creates, 1); assert.equal(state.state.publications[resourceId].ghost_post_id, nativeId);
  });
}

test("legacy post mapping and legacy uncertain intent refuse a page selection before remote access", async () => {
  for (const prior of [{ state: "complete", ghost_post_id: nativeId }, { state: "attention", create_outcome_uncertain: true }, { state: "attention" }]) {
    const state = memoryStore({ ...prior, canonical_url: `${config.ghostOrigin}/native/`, topic_id: 42 });
    const before = structuredClone(state.state), remote = { async findByResource() { throw new Error("Unexpected remote access"); } };
    const result = await syncPublications({ ...config, publicationType: "page" }, state, bridge(() => source()), remote);
    assert.equal(result.failed, 1); assert.match(result.errors[0].reason, /mapping changed/u); assert.deepEqual(state.state, before);
  }
});

test("explicit native type disagreement and duplicate cross-resource markers never create", async () => {
  const cfg = { ...config, publicationType: "page" }, record = source(), publication = nativePublication(record, cfg);
  const object = { id: nativeId, slug: publication.slug, url: publication.destination, type: "post", html: publication.html, tags: [{ name: publication.resourceTag }] };
  for (const matches of [[object], [object, { ...object, type: "page", id: "b".repeat(24) }]]) {
    const remote = { creates: 0, async findByResource() { return matches; }, async create() { this.creates++; } };
    assert.equal((await syncPublications(cfg, memoryStore(), bridge(() => record), remote)).failed, 1); assert.equal(remote.creates, 0);
  }
});

test("API refuses missing/wrong envelopes and explicit returned type disagreements", async () => {
  for (const payload of [{ posts: [] }, { pages: [{ type: "post" }] }, { pages: [], posts: [] }, { pages: [] }, { pages: [{}, {}] }]) {
    const client = new GhostAdminClient({ ...config, publicationType: "page" }, async () => json(payload));
    await assert.rejects(client.create({ title: "Source" }), /publication (response envelope|type disagreement)/u);
  }
});

test("state has one validated authority, rejects malformed maps/types and bounds read/write bytes", async () => {
  assert.deepEqual(validState({ version: 1, posts: {}, presentations: {} }).publications, {});
  for (const mutation of [{ posts: null }, { presentations: [] }, { publications: null }, { publications: { one: { ghost_native_type: "article" } } }, { forum_publications: {} }]) assert.throws(() => serializedState({ version: 1, posts: {}, presentations: {}, publications: {}, ...mutation }), /state/u);
  const directory = await mkdtemp(join(tmpdir(), "ghost-state-bound-")), path = join(directory, "state.json"), state = new StateStore(path);
  const initial = { version: 1, posts: {}, presentations: {}, publications: {} };
  await state.write(initial);
  const before = await readFile(path);
  await assert.rejects(state.write({ ...initial, padding: "x".repeat(MAX_STATE_BYTES) }), /too large/u);
  assert.deepEqual(await readFile(path), before);
  const handle = await open(path, "w"); try { await handle.truncate(MAX_STATE_BYTES + 1); } finally { await handle.close(); }
  await assert.rejects(readStateFile(path), /too large/u);
  await assert.rejects(state.read(), /Invalid DiscussionBridge state/u);
});

test("feed bounds and complete destination collision census run before any native writes", async () => {
  const native = source(), remote = { async findByResource() { throw new Error("Unexpected native access"); } };
  for (const records of [Array.from({ length: 101 }, () => native), [native, { ...native, resource_id: "22222222-2222-4222-8222-222222222222" }]]) {
    const feed = { async records() { return { bridge_records: records, pagination: { page: 1, pages: 1, total: records.length, snapshot: "stable" } }; } };
    await assert.rejects(syncPublications(config, memoryStore(), feed, remote), /Invalid publication feed|destination collision/u);
  }
  let reads = 0;
  const changed = { async records() { reads++; return { bridge_records: [{ ...native, title: reads === 1 ? "Before" : "Changed" }], pagination: { page: 1, pages: 1, total: 1, snapshot: "stable" } }; } };
  await assert.rejects(syncPublications(config, memoryStore(), changed, remote), /feed changed/u);
});

test("tag identity normalization preserves operator names and rejects ambiguous or foreign ownership", async () => {
  const cfg = { ...config, publicationType: "page" }, state = memoryStore(), remote = ghost("page", state);
  const record = source(), feed = bridge(() => record);
  assert.equal((await syncPublications(cfg, state, feed, remote)).created, 1);
  const operator = { id: "b".repeat(24), name: "Operator Tag", slug: "operator-tag", visibility: "public" };
  remote.object.tags.unshift(operator, { ...operator, name: "operator tag" });
  record.source.edition = "b".repeat(64);
  assert.equal((await syncPublications(cfg, state, feed, remote)).updated, 1);
  assert.deepEqual(remote.object.tags[0], operator);
  assert.equal(remote.object.tags.filter((tag) => tag.slug === "operator-tag").length, 1);
  const writes = remote.updates;
  for (const extra of [{ ...operator, id: "c".repeat(24) }, { name: "#discussionbridge-resource-22222222-2222-4222-8222-222222222222" }]) {
    remote.object.tags.push(extra); record.source.edition = "c".repeat(64);
    assert.equal((await syncPublications(cfg, state, feed, remote)).failed, 1); assert.equal(remote.updates, writes);
    remote.object.tags.pop();
  }
});

test("fallback native-ID lookup cannot re-adopt an object whose resource marker was removed", async () => {
  const state = memoryStore(), remote = ghost("post", state), record = source(), feed = bridge(() => record);
  assert.equal((await syncPublications(config, state, feed, remote)).created, 1);
  remote.object.tags = remote.object.tags.filter((tag) => tag.name !== nativePublication(record, config).resourceTag);
  remote.visible = false; record.source.edition = "b".repeat(64);
  const before = remote.updates;
  const result = await syncPublications(config, state, feed, remote);
  assert.equal(result.failed, 1); assert.match(result.errors[0].reason, /resource marker drift/u); assert.equal(remote.updates, before);
});

test("Ghost rate limits expose bounded actionable cooldown without retrying an uncertain write", async () => {
  let attempts = 0;
  const client = new GhostAdminClient(config, async () => {
    attempts++;
    return new Response(JSON.stringify({ errors: [{ message: "Protected arbitrary upstream detail" }] }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "30" } });
  });
  const error = await client.create({ title: "Source" }).catch((value) => value);
  assert.equal(attempts, 1); assert.equal(error.status, 429); assert.equal(error.code, "ghost_admin_rate_limited"); assert.equal(error.retryAfterSeconds, 30);
  assert.match(error.message, /rate limit/u); assert.doesNotMatch(error.message, /Protected arbitrary/u);
});
