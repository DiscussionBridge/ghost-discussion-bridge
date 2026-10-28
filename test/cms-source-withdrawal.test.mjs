import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CmsClient } from "../lib/cms-client.mjs";
import { publishSource } from "../src/source-write.mjs";
import { observeGhostSourceLifecycle } from "../src/cms-source-withdrawal.mjs";
import { StateStore } from "../src/state-store.mjs";
import { buildServer } from "../src/service.mjs";
import { operatorCsrfToken } from "../src/operator-surface.mjs";
import { createHmac } from "node:crypto";

const config = { ghostOrigin: "https://ghost.example", serverUrl: "https://forum.example", adapterOrigin: "https://adapter.example", connectionId: "dbc_0123456789abcdef01234567", connectionSecret: "s".repeat(48) };
const id = "a".repeat(24), key = `ghost-post:${id}`, resource = "11111111-1111-4111-8111-111111111111", topic = "9223372036854775807", revision = "accepted-native-edition";
const metadata = () => ({ resource_id: resource, direction: "to_discourse", state: "active", topic_id: topic, topic_url: `${config.serverUrl}/t/original/${topic}`, external_id: key, canonical_url: `${config.ghostOrigin}/original/`, source_revision: revision, source_created_at: null, source_updated_at: null, synchronized_at: "2026-10-14T01:00:00.000Z", mapping_id: null });
const scope = () => ({ native_id: id, native_type: "post", ghost_origin: config.ghostOrigin, admin_origin: config.ghostOrigin });
const connection = () => ({ connection_id: config.connectionId, profile: "ghost", destination_origin: config.ghostOrigin, scope_revision: "current-scope", forum_name: "Forum", directions: ["to_discourse"], publication_lane: "ghost",
  policy: { policy_revision: "policy", enabled: true, selection: "all_public", category_ids: [], include_topic_ids: [], exclude_topic_ids: [], include_unlisted: false, publication_kind: "dynamic", presentation_mode: "full", author_ids: [], taxonomy_ids: [] },
  native_capabilities: { native_revision: "native", supported_presentations: ["simple", "full", "interactive"], publication_kind: "dynamic", complete_content_supported: true } });
function startingState() {
  const record = metadata();
  // Known-safe fixture supplies the already accepted current baseline. This
  // never claims that production source HTML preparation has been qualified.
  return { version: 1, posts: { [key]: { source_protocol: "v4", resource_id: resource, topic_id: topic, topic_url: record.topic_url, canonical_url: record.canonical_url, source_revision: revision, outcome: "created", cms_source: { accepted_revision: revision, accepted_receipt: record, accepted_input: { known_safe_fixture: true }, accepted_history: [], native_source_scope: scope() } } }, presentations: {}, publications: {} };
}
function memoryStore() {
  const state = startingState(); let tail = Promise.resolve();
  return { state, async read() { return structuredClone(state); }, async update(callback) { await callback(state); }, async withNativeLock(callback) { const running = tail.then(() => callback(async () => {})); tail = running.catch(() => {}); return running; } };
}
function fixture(store = memoryStore()) {
  const f = { store, remote: metadata(), authority: connection(), bodies: [], saved: new Map(), lose: false, commitLost: true, forbid: false, native: { id, type: "post", status: "published", tags: [{ name: "#discussionbridge" }], html: "<p>Known native content</p>" } };
  f.client = new CmsClient({ serviceOrigin: config.serverUrl, connectionId: config.connectionId, connectionSecret: config.connectionSecret }, { fetchImplementation: async (address, options) => {
    const path = new URL(address).pathname;
    const respond = (body, status = 200) => { const response = new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); Object.defineProperty(response, "url", { value: address }); return response; };
    if (options.method === "GET") return respond(path.endsWith("connection.json") ? f.authority : f.remote);
    assert.ok(path.endsWith(`/${resource}/withdraw.json`), "no resolve/move/native delete/hide call");
    assert.equal(options.headers["X-DiscussionBridge-Connection"], config.connectionId);
    const body = JSON.parse(options.body), job = (await store.read()).posts[key].cms_source.withdrawal;
    assert.equal(JSON.stringify(job.body), options.body); assert.equal(job.request_state, "uncertain"); f.bodies.push(body);
    if (f.forbid) return respond({ outcome: "rejected", code: "scope_changed", retryable: false, retry_after_seconds: null, correlation_id: null, core_fallback: false }, 409);
    if (f.raceBefore05) { f.remote.source_revision = "pending-native-B"; return respond({ outcome: "rejected", code: "revision_conflict", retryable: false, retry_after_seconds: null, correlation_id: null, core_fallback: false }, 409); }
    if (f.lose && !f.commitLost) { f.lose = false; throw new Error("Synthetic unknown response without commitment"); }
    const receipt = f.saved.get(body.mutation_id) ?? { ...f.remote, state: "withdrawn" };
    f.saved.set(body.mutation_id, receipt); f.remote = structuredClone(receipt);
    if (f.lose) { f.lose = false; throw new Error("Synthetic lost accepted response"); }
    return respond(receipt);
  } });
  f.ghost = { getSource: async () => { if (f.deleted || f.native.type === "page") throw Object.assign(new Error("Native source missing"), { status: 404 }); return structuredClone(f.native); }, get: async () => { if (f.native.type === "page") return structuredClone(f.native); throw Object.assign(new Error("Native page missing"), { status: 404 }); } };
  f.stop = () => publishSource({ native_id: id, withdrawal: { reason: "policy_excluded", facts: { native_id: id, actor: "discussionbridge", observation: "protected_native_operator_stop_delivery" } } }, config, store, f.client);
  f.event = () => publishSource({ native_id: id }, config, store, f.client, { observeSourceLifecycle: (nativeId, prior) => observeGhostSourceLifecycle(config, f.ghost, nativeId, prior), loadCurrentSource: () => f.ghost.getSource(id) });
  return f;
}

test("initialized withdrawal captures all four genuine reasons while retaining exact binding/discussion/native content", async () => {
  for (const reason of ["source_unpublished", "source_deleted", "source_ineligible", "policy_excluded"]) {
    const f = fixture(), before = structuredClone((await f.store.read()).posts[key]);
    if (reason === "source_unpublished") f.native.status = "draft";
    if (reason === "source_deleted") f.deleted = true;
    if (reason === "source_ineligible") f.native.tags = [];
    const nativeBefore = structuredClone(f.native), receipt = await (reason === "policy_excluded" ? f.stop() : f.event());
    assert.equal(receipt.state, "withdrawn"); assert.equal(receipt.topic_id, topic); assert.equal(receipt.resource_id, resource);
    assert.deepEqual(f.bodies[0], { mutation_id: f.bodies[0].mutation_id, expected_source_revision: revision, reason });
    const row = (await f.store.read()).posts[key]; assert.equal(row.canonical_url, before.canonical_url); assert.equal(row.source_revision, revision);
    assert.deepEqual(row.cms_source.accepted_input, before.cms_source.accepted_input); assert.deepEqual(row.cms_source.accepted_history, before.cms_source.accepted_history);
    assert.deepEqual(row.cms_source.withdrawal.original_response, { ...receipt }); assert.deepEqual(f.native, nativeBefore); assert.deepEqual((await f.store.read()).publications, {});
    await f.event(); assert.equal(f.bodies.length, 1, "no automatic resolve/reactivation/new withdrawal mutation");
  }
});

test("unknown withdrawal replays exact mutation/tree or recovers current record without inventing original acceptance", async () => {
  for (const committed of [true, false]) {
    const f = fixture(); f.lose = true; f.commitLost = committed; await assert.rejects(f.stop());
    const request = structuredClone((await f.store.read()).posts[key].cms_source.withdrawal.body);
    await f.event(); const job = (await f.store.read()).posts[key].cms_source.withdrawal;
    assert.deepEqual(job.body, request); assert.equal(job.state, "withdrawn");
    if (committed) { assert.equal(f.bodies.length, 1); assert.equal(job.original_response, null); assert.equal(job.receipt_origin, "current_record_recovery"); }
    else { assert.equal(f.bodies.length, 2); assert.deepEqual(f.bodies[1], request); assert.deepEqual(job.original_response, job.receipt); }
  }
});

test("current To authority/revision/binding and source writer fence block mutation without an exception", async () => {
  for (const change of ["direction", "origin", "revision", "resource", "external", "topic", "pending"]) {
    const f = fixture();
    if (change === "direction") f.authority.directions = ["from_discourse"];
    if (change === "origin") f.authority.destination_origin = "https://other.example";
    if (change === "revision") f.remote.source_revision = "concurrent-edition";
    if (change === "resource") f.remote.resource_id = "22222222-2222-4222-8222-222222222222";
    if (change === "external") f.remote.external_id = "other-source";
    if (change === "topic") f.remote.topic_id = "42";
    if (change === "pending") await f.store.update(async (state) => { state.posts[key].cms_source.intent = { unresolved: true }; });
    await assert.rejects(f.stop()); assert.equal(f.bodies.length, 0, change); assert.equal((await f.store.read()).posts[key].resource_id, resource);
  }
});

test("From policy enablement is not a To withdrawal gate; receiver scope refusal still wins", async () => {
  const f = fixture(); f.authority.policy.enabled = false;
  assert.equal((await f.stop()).state, "withdrawn"); assert.equal(f.bodies.length, 1);
  const denied = fixture(); denied.authority.policy.enabled = false; denied.forbid = true;
  await assert.rejects(denied.stop()); assert.equal((await denied.store.read()).posts[key].outcome, "attention");
  assert.equal(denied.remote.state, "active");
});

async function signedNativeNotification(f, run) {
  const runtime = { ...config, webhookSecret: "w".repeat(32) };
  const server = buildServer(runtime, f.store, {}, { publishNativeSource: async (nativeId) => { assert.equal(nativeId, id); return f.event(); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const send = (post, { valid = true, event = "post.deleted" } = {}) => {
    const raw = JSON.stringify({ post, event }), timestamp = String(Date.now());
    const signature = createHmac("sha256", runtime.webhookSecret).update(`${raw}${timestamp}`).digest("hex");
    return fetch(`http://127.0.0.1:${server.address().port}/webhooks/ghost`, { method: "POST", body: raw, headers: { "Content-Type": "application/json", "X-Ghost-Signature": `sha256=${valid ? signature : "0".repeat(64)}, t=${timestamp}` } });
  };
  try { await run(send); }
  finally { const closed = new Promise((resolve) => server.close(resolve)); server.closeAllConnections(); await closed; }
}

test("signed empty/null/omitted-current deletion signals use accepted ID scope and actual post/page absence", async () => {
  for (const post of [{ current: {}, previous: { id, status: "published" } }, { current: null, previous: { id } }, { previous: { id } }]) {
    const f = fixture(); f.deleted = true; const reads = [];
    const getSource = f.ghost.getSource, getPage = f.ghost.get;
    f.ghost.getSource = async (nativeId) => { reads.push(["post", nativeId]); return getSource(); };
    f.ghost.get = async (nativeId, maximumBytes, kind) => { reads.push([kind, nativeId]); return getPage(); };
    await signedNativeNotification(f, async (send) => {
      const response = await send(post); assert.equal(response.status, 200); assert.equal((await response.json()).outcome, "withdrawn");
    });
    assert.deepEqual(reads, [["post", id], ["page", id]]);
    assert.equal(f.bodies[0].reason, "source_deleted"); assert.equal(f.bodies[0].expected_source_revision, revision);
    assert.equal((await f.store.read()).posts[key].topic_id, topic);
  }
});

test("signed unpublish signal reads actual native state rather than stale event status or absent body", async () => {
  const f = fixture(); f.native.status = "draft";
  await signedNativeNotification(f, async (send) => {
    const response = await send({ current: { id, status: "published", html: "stale event" }, previous: { status: "published" } }, { event: "post.unpublished" });
    assert.equal(response.status, 200);
  });
  assert.equal(f.bodies[0].reason, "source_unpublished");
  for (const condition of ["published", "native-failure", "page"]) {
    const other = fixture();
    if (condition === "native-failure") other.ghost.getSource = async () => { throw Object.assign(new Error("Native read denied"), { status: 401 }); };
    if (condition === "page") other.native.type = "page";
    await signedNativeNotification(other, async (send) => { await send({ current: {}, previous: { id } }); });
    if (condition === "page") assert.equal(other.bodies[0].reason, "source_ineligible");
    else assert.equal(other.bodies.length, 0, "notification absence is not deletion proof or To dispatch authority");
  }
});

test("bad signatures, conflicting/malformed IDs and unbound/mismatched previous scope never dispatch the native writer", async () => {
  for (const condition of ["signature", "conflict", "malformed-current", "unknown-id", "scope"]) {
    const f = fixture(); let reads = 0; f.ghost.getSource = async () => { reads++; return f.native; };
    if (condition === "scope") await f.store.update(async (state) => { state.posts[key].cms_source.native_source_scope.admin_origin = "https://other.example"; });
    const post = condition === "conflict" ? { current: { id }, previous: { id: "b".repeat(24) } } : condition === "malformed-current" ? { current: { id: "bad" }, previous: { id } } : { current: null, previous: { id: condition === "unknown-id" ? "b".repeat(24) : id } };
    await signedNativeNotification(f, async (send) => { assert.equal((await send(post, { valid: condition !== "signature" })).status, condition === "signature" ? 404 : 502); });
    assert.equal(reads, 0); assert.equal(f.bodies.length, 0);
  }
});

test("signed deletion withdrawal survives restarted writer with the exact saved request and no automatic resolve", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ghost-signed-withdrawal-"));
  try {
    const path = join(directory, "state.json"), store = new StateStore(path); await store.write(startingState());
    const first = fixture(store); first.deleted = true; first.lose = true; first.commitLost = false;
    await signedNativeNotification(first, async (send) => { assert.equal((await send({ current: {}, previous: { id } })).status, 502); });
    const saved = structuredClone((await new StateStore(path).read()).posts[key].cms_source.withdrawal.body);
    const successor = fixture(new StateStore(path)); successor.deleted = true;
    await signedNativeNotification(successor, async (send) => { assert.equal((await send({ current: null, previous: { id } })).status, 200); });
    assert.deepEqual(successor.bodies[0], saved); assert.equal((await new StateStore(path).read()).posts[key].outcome, "withdrawn");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const pendingPublish = () => ({ body: { mutation_id: "22222222-2222-4222-8222-222222222222", bridge_record: { expected_source_revision: revision, source_revision: "pending-native-B" } }, request_state: "uncertain", capture: "synthetic opaque unresolved journal; never submitted or treated as a receipt" });

test("actual native close withdraws scoped accepted A while preserving uncertain B completely unreplayed", async () => {
  const f = fixture(), pending = pendingPublish(); f.native.status = "draft";
  await f.store.update(async (state) => { state.posts[key].cms_source.intent = structuredClone(pending); });
  await signedNativeNotification(f, async (send) => { assert.equal((await send({ current: { id }, previous: { status: "published" } }, { event: "post.unpublished" })).status, 200); });
  const row = (await f.store.read()).posts[key];
  assert.deepEqual(row.cms_source.intent, pending); assert.equal(row.cms_source.accepted_revision, revision);
  assert.equal(f.bodies.length, 1); assert.equal(f.bodies[0].expected_source_revision, revision);
  assert.deepEqual(row.cms_source.withdrawal.closed_pending_publish.intent, pending);
  assert.equal(row.cms_source.withdrawal.closed_pending_publish.current_record.source_revision, revision);
  assert.equal(row.cms_source.withdrawal.closed_pending_publish.state, "accepted_binding_observed");
  f.native.status = "published"; await f.event(); assert.equal(f.bodies.length, 1, "closed binding cannot automatically resolve B or reactivate");
});

test("pending B metadata mismatch or race is reconciliation, never guessed CAS or automatic resolve replay", async () => {
  for (const condition of ["current-B", "race", "source-move"]) {
    const f = fixture(), pending = pendingPublish(); f.native.status = "draft";
    await f.store.update(async (state) => { state.posts[key].cms_source.intent = structuredClone(pending); if (condition === "source-move") state.posts[key].cms_source.source_url_move = { intent: { unrelated: "retained" } }; });
    if (condition === "current-B") f.remote.source_revision = "pending-native-B";
    if (condition === "race") f.raceBefore05 = true;
    await assert.rejects(f.event());
    const row = (await f.store.read()).posts[key]; assert.deepEqual(row.cms_source.intent, pending);
    assert.equal(row.cms_source.accepted_revision, revision); assert.equal(row.outcome, "attention"); assert.equal(f.remote.state, "active");
    assert.equal(f.bodies.length, condition === "race" ? 1 : 0);
    if (condition === "source-move") assert.equal(row.cms_source.withdrawal, undefined, "source movement authority is not bypassed");
  }
});

test("closed-native A request and untouched B capture survive restart without replaying resolve", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ghost-closed-pending-"));
  try {
    const path = join(directory, "state.json"), store = new StateStore(path); await store.write(startingState());
    const pending = pendingPublish(); await store.update(async (state) => { state.posts[key].cms_source.intent = structuredClone(pending); });
    const first = fixture(store); first.native.status = "draft"; first.lose = true; first.commitLost = false;
    await assert.rejects(first.event()); const saved = (await new StateStore(path).read()).posts[key].cms_source.withdrawal.body;
    const successor = fixture(new StateStore(path)); await successor.event();
    const row = (await new StateStore(path).read()).posts[key]; assert.deepEqual(row.cms_source.intent, pending);
    assert.deepEqual(successor.bodies[0], saved); assert.equal(row.outcome, "withdrawn");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("current native facts distinguish conversion/absence and refuse incomplete metadata or unknown deletion scope", async () => {
  const converted = fixture(); converted.native.type = "page"; await converted.event(); assert.equal(converted.bodies[0].reason, "source_ineligible");
  for (const change of ["tags", "status", "scope"]) {
    const f = fixture(); if (change === "tags") delete f.native.tags; if (change === "status") f.native.status = "unknown";
    if (change === "scope") { f.deleted = true; await f.store.update(async (state) => { delete state.posts[key].cms_source.native_source_scope; }); }
    await assert.rejects(f.event()); assert.equal(f.bodies.length, 0);
  }
});

test("withdrawal historical original response stays immutable across current native topic slug observation", async () => {
  const f = fixture(); await f.stop(); const original = structuredClone((await f.store.read()).posts[key].cms_source.withdrawal.original_response);
  f.remote.topic_url = `${config.serverUrl}/t/changed-slug/${topic}`; await f.event();
  const row = (await f.store.read()).posts[key]; assert.deepEqual(row.cms_source.withdrawal.original_response, original);
  assert.equal(row.topic_url, f.remote.topic_url); assert.equal(row.cms_source.withdrawal.receipt.topic_url, f.remote.topic_url); assert.equal(f.bodies.length, 1);
});

test("durable initialized withdrawal survives restarted state reader and preserves one request/receipt authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ghost-withdrawal-"));
  try {
    const path = join(directory, "state.json"), store = new StateStore(path); await store.write(startingState()); const f = fixture(store); f.lose = true; f.commitLost = false;
    await assert.rejects(f.stop()); const saved = (await new StateStore(path).read()).posts[key].cms_source.withdrawal.body;
    const successor = fixture(new StateStore(path)); await successor.event(); assert.deepEqual(successor.bodies[0], saved);
    assert.equal((await new StateStore(path).read()).posts[key].outcome, "withdrawn");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("protected native stop-delivery action is single-source/auth/origin/CSRF guarded", async () => {
  const f = fixture(), password = "p".repeat(32), runtime = { ...config, operatorPassword: password, operatorOrigin: config.adapterOrigin };
  const server = buildServer(runtime, f.store, {}, { stopSourceDelivery: async (nativeId) => { assert.equal(nativeId, id); return f.stop(); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = `http://127.0.0.1:${server.address().port}`;
  const auth = `Basic ${Buffer.from(`discussionbridge:${password}`).toString("base64")}`, form = () => new URLSearchParams({ csrf: operatorCsrfToken(password), native_id: id });
  try {
    const request = (body, headers = {}) => fetch(`${address}/operator/stop-source`, { method: "POST", redirect: "manual", body, headers: { Authorization: auth, Origin: config.adapterOrigin, "Content-Type": "application/x-www-form-urlencoded", ...headers } });
    assert.equal((await request(form(), { Authorization: "" })).status, 401); assert.equal((await request(form(), { Origin: "https://other.example" })).status, 403);
    const bad = form(); bad.set("csrf", "bad"); assert.equal((await request(bad)).status, 403);
    const injected = form(); injected.set("reason", "source_deleted"); assert.equal((await request(injected)).status, 400);
    const duplicate = form(); duplicate.append("native_id", id); assert.equal((await request(duplicate)).status, 400); assert.equal(f.bodies.length, 0);
    assert.equal((await request(form())).status, 303); assert.equal(f.bodies[0].reason, "policy_excluded");
    const page = await fetch(`${address}/operator/`, { headers: { Authorization: auth } }); assert.match(await page.text(), /Stop source delivery/);
  } finally { await new Promise((resolve) => server.close(resolve)); server.closeAllConnections(); }
});
