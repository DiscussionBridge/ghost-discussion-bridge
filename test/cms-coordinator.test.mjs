import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cmsMutation, newCmsReservation, synchronizeCms } from "../src/cms-coordinator.mjs";
import { validateCmsRoute } from "../lib/cms-runtime.mjs";
import { StateStore } from "../src/state-store.mjs";
import { assertNativeContentRepresentable } from "../src/native-content-preservation.mjs";

const config = { serverUrl: "https://forum.example", ghostOrigin: "https://ghost.example", connectionId: `dbc_${"a".repeat(24)}`, publicationType: "post" };
const resourceId = "11111111-1111-4111-8111-111111111111", mappingId = "22222222-2222-4222-8222-222222222222", workId = "33333333-3333-4333-8333-333333333333";
const sha = (text) => createHash("sha256").update(text).digest("hex");
const body = "<p>Exact source</p>";
const source = { source_id: "source/雪%?", source_revision: "opaque-revision", topic_id: "42", topic_url: `${config.serverUrl}/t/source/42`, title: "Source", content_sha256: sha(body), content_bytes: Buffer.byteLength(body), source_created_at: null, source_updated_at: null, source_authors: [{ id: "writer", name: "Source author" }] };
const policy = { policy_revision: "policy-1", enabled: true, selection: "all_public", category_ids: [], include_topic_ids: [], exclude_topic_ids: [], include_unlisted: false, publication_kind: "dynamic", presentation_mode: "full", author_ids: [], taxonomy_ids: [] };
const connection = { connection_id: config.connectionId, profile: "ghost", destination_origin: config.ghostOrigin, scope_revision: "scope-1", forum_name: "Native Forum", directions: ["from_discourse"], policy, publication_lane: "default", native_capabilities: { native_revision: "capabilities-1", supported_presentations: ["simple", "full", "interactive"], publication_kind: "dynamic", complete_content_supported: true } };
const memoryStore = () => ({ state: { version: 1, posts: {}, presentations: {}, publications: {} }, async read() { return structuredClone(this.state); }, async update(callback) { const next = structuredClone(this.state); await callback(next); this.state = next; } });
function fixture({ disabled = false, staleGeneration = false, prepareLost = false } = {}) {
  const store = memoryStore(), calls = [], p = { ...policy, enabled: !disabled }, c = { ...connection, policy: p };
  let mapping, claimed = false, lost = prepareLost;
  const work = { work_id: workId, mapping_id: mappingId, source_id: source.source_id, source_revision: source.source_revision, policy_revision: p.policy_revision, action: "publish_revision", state: "leased", attempt_cycle: workId, attempt: 1, lease_generation: 2, retry_at: null, last_failure_code: null };
  const lease = () => ({ work: structuredClone(work), lease_token: Buffer.alloc(32, 7).toString("base64url"), lease_generation: 2, server_time: "2026-10-14T00:00:00.000Z", expires_at: "2026-10-14T00:05:00.000Z" });
  const client = {
    connection: async () => structuredClone(c), policy: async () => structuredClone(p),
    sources: async (query) => {
      calls.push({ query });
      return query.stream === "initial" ? { stream: "initial", items: [{ event_type: "publication", event_id: resourceId, event_sequence: "1", source }], next_cursor: null, checkpoint_cursor: "checkpoint-1" } : { stream: "changes", items: [], next_cursor: null, checkpoint_cursor: "checkpoint-2" };
    },
    prepareMutation(routeId, request, path = {}) { validateCmsRoute(routeId, { body: request, path }); return { routeId, request: structuredClone(request), path }; },
    async execute({ routeId, request, path }) {
      calls.push({ routeId, request, path });
      if (routeId === "V4-09") {
        mapping = { mapping_id: mappingId, resource_id: resourceId, connection_id: config.connectionId, source_id: source.source_id, external_id: request.external_id, mapping_revision: "mapping-1", destination_native_id: null, canonical_url: request.canonical_url, retired_url_count: 0, mapping_state: "pending", presentation_mode: p.presentation_mode, desired_source_revision: source.source_revision, synchronized_source_revision: null, publicly_verified_source_revision: null, destination_native_revision: null, source_created_at: null, source_updated_at: null, synchronized_at: null, publicly_verified_at: null };
        if (lost) { lost = false; throw Object.assign(new Error("Uncertain synthetic prepare"), { requestOutcomeUncertain: true }); }
        return structuredClone(mapping);
      }
      if (routeId === "V4-13") { if (claimed) return undefined; claimed = true; if (staleGeneration) store.state.publications[resourceId].cms.last_lease_generation = 9; return lease(); }
      if (routeId === "V4-15") return lease();
      if (routeId === "V4-16") {
        work.state = request.stage;
        if (request.stage === "synchronized") mapping.destination_native_id = request.native_result.native_id;
        return { work: structuredClone(work), mapping: structuredClone(mapping), lease_expires_at: lease().expires_at };
      }
      if (routeId === "V4-17") { work.state = "attention"; return { work: structuredClone(work), mapping: structuredClone(mapping), lease_expires_at: null }; }
      throw new Error("Unexpected synthetic route");
    },
    async work() { return { work: structuredClone(work), mapping: structuredClone(mapping), lease_expires_at: lease().expires_at }; },
    async completeSource(expected, { beforeChunk }) { await beforeChunk(); assert.deepEqual(expected, source); return { bytes: Buffer.from(body), html: body }; },
  };
  let nativeCalls = 0;
  const native = {
    async synchronize({ mapping: owned, work: current, content, assertAuthority, changed }) {
      await assertAuthority(); nativeCalls++; changed(); assert.equal(content.html, body);
      return { outcome: "created", nativeResult: { kind: current.action, native_id: "a".repeat(24), external_id: owned.external_id, canonical_url: owned.canonical_url, native_revision: "native-1", ownership_receipt_sha256: "b".repeat(64), representation: { kind: "full", source_content_sha256: source.content_sha256 } } };
    },
    async verify({ mapping: owned, assertAuthority }) { await assertAuthority(); return { kind: "published", url: owned.canonical_url, native_id: "a".repeat(24), source_revision: source.source_revision, source_content_sha256: source.content_sha256, native_publication_sha256: "c".repeat(64), verification_profile: "synthetic-test-profile", checked_at: "2026-10-14T00:00:01.000Z", representation: { kind: "full", source_content_sha256: source.content_sha256 } }; },
  };
  return { store, client, native, calls, work, count: () => nativeCalls };
}

test("typed coordinator durably stages sources before reservation, renews exact work, and keeps verification separate", async () => {
  const f = fixture();
  assert.equal((await synchronizeCms(config, f.store, f.client, f.native)).created, 1);
  assert.equal(f.store.state.cms_feed.checkpoint_cursor, "checkpoint-1");
  assert.equal(Object.keys(f.store.state.publications).length, 1);
  assert.deepEqual(f.calls.find((call) => call.routeId === "V4-09").request.canonical_url, newCmsReservation(source.source_id, config).canonical_url);
  const acknowledgements = f.calls.filter((call) => call.routeId === "V4-16");
  assert.deepEqual(acknowledgements.map((call) => call.request.stage), ["synchronized", "verified"]);
  assert.equal(acknowledgements[0].request.authority.lease_generation, 2);
  assert.notEqual(acknowledgements[1].request.verification.native_publication_sha256, source.content_sha256);
  assert.equal(f.store.state.publications[resourceId].cms.last_lease_generation, 2);
  await synchronizeCms(config, f.store, f.client, f.native);
  assert.equal(f.calls.filter((call) => call.query).at(-1).query.cursor, "checkpoint-1");
});

test("uncertain mapping reservation resumes exact mutation/body without rewinding the staged feed", async () => {
  const f = fixture({ prepareLost: true });
  await assert.rejects(synchronizeCms(config, f.store, f.client, f.native), /Uncertain/);
  assert.equal(f.store.state.cms_feed.checkpoint_cursor, "checkpoint-1"); assert.equal(f.count(), 0);
  await synchronizeCms(config, f.store, f.client, f.native);
  const prepares = f.calls.filter((call) => call.routeId === "V4-09");
  assert.equal(prepares.length, 2); assert.deepEqual(prepares[1], prepares[0]);
  assert.equal(f.calls.filter((call) => call.query?.stream === "initial").length, 1);
});

test("disabled policy starts no source/native work and an older native generation never writes", async () => {
  const disabled = fixture({ disabled: true });
  assert.equal((await synchronizeCms(config, disabled.store, disabled.client, disabled.native)).skipped, 1);
  assert.equal(disabled.calls.length, 0); assert.equal(disabled.count(), 0);
  const stale = fixture({ staleGeneration: true });
  assert.equal((await synchronizeCms(config, stale.store, stale.client, stale.native)).failed, 1);
  assert.equal(stale.count(), 0); assert.equal(stale.store.state.publications[resourceId].cms.last_lease_generation, 9);
});

test("scope or policy change stops the pinned continuation without silent rewind", async () => {
  const f = fixture(); await synchronizeCms(config, f.store, f.client, f.native);
  const changedPolicy = { ...policy, policy_revision: "policy-2" };
  f.client.policy = async () => changedPolicy;
  f.client.connection = async () => ({ ...connection, policy: changedPolicy });
  await assert.rejects(synchronizeCms(config, f.store, f.client, f.native), /explicit scope\/policy reconciliation/);
  assert.equal(f.calls.filter((call) => call.query?.stream === "initial").length, 1);
});

test("receiver source metadata cannot attach an unowned native publication", async () => {
  const f = fixture();
  f.store.state.publications[resourceId] = { state: "complete", topic_id: source.topic_id, ghost_post_id: "d".repeat(24), canonical_url: `${config.ghostOrigin}/unowned/` };
  await assert.rejects(synchronizeCms(config, f.store, f.client, f.native), /owned current mapping receipt/);
  assert.equal(f.count(), 0); assert.equal(f.calls.some((call) => call.routeId === "V4-09"), false);
  assert.equal(f.store.state.publications[resourceId].ghost_post_id, "d".repeat(24));
});

test("actual local media limitation retains claim evidence without inventing a wire Failure disposition", async () => {
  const f = fixture(); f.native.synchronize = async () => assertNativeContentRepresentable('<video src="https://media.example/video.mp4"></video>');
  assert.equal((await synchronizeCms(config, f.store, f.client, f.native)).failed, 1);
  assert.equal(f.calls.some((call) => call.routeId === "V4-17"), false); assert.equal(f.calls.some((call) => call.routeId === "V4-16"), false);
  assert.deepEqual(f.store.state.publications[resourceId].cms.local_native_limitation.elements, ["video"]);
  assert.equal(f.store.state.publications[resourceId].cms.local_native_limitation.receiver_failure_reported, false); assert.equal(f.store.state.cms_feed.pending_claim, undefined);
  assert.ok(f.store.state.cms_journal[f.store.state.publications[resourceId].cms.local_native_limitation.claim_key].completed);
});

test("specific lost source function is retained locally without a fabricated receiver failure or successful ACK", async () => {
  const f = fixture(); f.native.synchronize = async () => assertNativeContentRepresentable('<p onclick="calculate()">Interactive source</p>');
  assert.equal((await synchronizeCms(config, f.store, f.client, f.native)).failed, 1);
  const issue = f.store.state.publications[resourceId].cms.local_native_limitation;
  assert.deepEqual(issue.functions, ["source onclick handler"]); assert.deepEqual(issue.elements, []); assert.equal(issue.receiver_failure_reported, false);
  assert.equal(f.calls.some((call) => call.routeId === "V4-17" || call.routeId === "V4-16"), false);
  assert.equal(f.store.state.cms_feed.pending_claim, undefined); assert.ok(f.store.state.cms_journal[issue.claim_key].completed);
});

test("saved 204 claim replay remains empty while a new poll uses another mutation", async () => {
  const f = fixture(); let dispatches = 0;
  f.client.execute = async () => { dispatches++; return undefined; };
  const first = await cmsMutation(f.store, f.client, "empty-poll-1", "V4-13", () => ({ mutation_id: workId }));
  assert.equal(first, undefined);
  await cmsMutation(f.store, f.client, "empty-poll-1", "V4-13", () => { throw new Error("must preserve old request"); });
  await cmsMutation(f.store, f.client, "empty-poll-2", "V4-13", () => ({ mutation_id: mappingId }));
  assert.equal(dispatches, 2);
});

function distinctFixture({ mediaFirst = false } = {}) {
  const store = memoryStore(), sources = ["source-a", "source-b"].map((sourceId, index) => ({ ...source, source_id: sourceId, source_revision: `revision-${index}`, topic_id: String(42 + index), topic_url: `${config.serverUrl}/t/source/${42 + index}` }));
  const bodies = [mediaFirst ? '<video src="https://media.example/video.mp4"></video>' : body, body];
  sources.forEach((source, index) => { source.content_bytes = Buffer.byteLength(bodies[index]); source.content_sha256 = sha(bodies[index]); });
  const mappings = [], works = [], acknowledgements = [], synchronizations = [], calls = [], claimed = new Set();
  const uuid = (value) => `${String(value).padStart(8, "0")}-1111-4111-8111-111111111111`;
  const lease = (work) => ({ work: structuredClone(work), lease_token: Buffer.alloc(32, work.lease_generation).toString("base64url"), lease_generation: work.lease_generation, server_time: "2026-10-14T00:00:00.000Z", expires_at: "2026-10-14T00:05:00.000Z" });
  const response = (work) => ({ work: structuredClone(work), mapping: structuredClone(mappings.find((item) => item.mapping_id === work.mapping_id)), lease_expires_at: lease(work).expires_at });
  const client = {
    connection: async () => connection, policy: async () => policy,
    sources: async ({ stream }) => ({ stream, items: stream === "initial" ? sources.map((source, index) => ({ event_type: "publication", event_id: uuid(index + 1), event_sequence: String(index + 1), source })) : [], next_cursor: null, checkpoint_cursor: "batch-checkpoint" }),
    prepareMutation(routeId, request, path = {}) { validateCmsRoute(routeId, { body: request, path }); return { routeId, request, path }; },
    async execute({ routeId, request, path }) {
      calls.push({ routeId, request: structuredClone(request), path });
      if (routeId === "V4-09") {
        const index = sources.findIndex((item) => item.source_id === request.source_id), selected = sources[index];
        const mapping = { mapping_id: uuid(10 + index), resource_id: uuid(20 + index), connection_id: config.connectionId, source_id: selected.source_id, external_id: request.external_id, mapping_revision: `mapping-${index}`, destination_native_id: null, canonical_url: request.canonical_url, retired_url_count: 0, mapping_state: "pending", presentation_mode: "full", desired_source_revision: selected.source_revision, synchronized_source_revision: null, publicly_verified_source_revision: null, destination_native_revision: null, source_created_at: null, source_updated_at: null, synchronized_at: null, publicly_verified_at: null };
        mappings.push(mapping); works.push({ work_id: uuid(30 + index), mapping_id: mapping.mapping_id, source_id: selected.source_id, source_revision: selected.source_revision, policy_revision: policy.policy_revision, action: "publish_revision", state: "leased", attempt_cycle: uuid(40 + index), attempt: 1, lease_generation: 2 + index, retry_at: null, last_failure_code: null }); return mapping;
      }
      if (routeId === "V4-13") {
        const next = works.find((work) => !claimed.has(work.work_id) && (!request.mapping_id || work.mapping_id === request.mapping_id));
        if (next) claimed.add(next.work_id);
        return next ? lease(next) : undefined;
      }
      const work = works.find((item) => item.work_id === path.work_id);
      if (routeId === "V4-15") return lease(work);
      if (routeId === "V4-16") { acknowledgements.push(structuredClone(request)); work.state = request.stage; if (request.stage === "synchronized") mappings.find((item) => item.mapping_id === work.mapping_id).destination_native_id = request.native_result.native_id; return response(work); }
      throw new Error("Unexpected distinct-work route");
    },
    work: async (id) => response(works.find((item) => item.work_id === id)),
    async completeSource(selected, { beforeChunk }) { await beforeChunk(); const index = sources.findIndex((item) => item.source_id === selected.source_id); assert.ok(index >= 0); return { bytes: Buffer.from(bodies[index]), html: bodies[index] }; },
  };
  const native = {
    preflight: async ({ content }) => assertNativeContentRepresentable(content.html),
    async synchronize({ mapping, work, source, content, authority, assertAuthority }) {
      assertNativeContentRepresentable(content.html);
      await assertAuthority(); synchronizations.push({ mapping: mapping.mapping_id, work: work.work_id, generation: authority.lease_generation });
      return { outcome: "created", nativeResult: { kind: "publish_revision", native_id: String(authority.lease_generation).repeat(24), external_id: mapping.external_id, canonical_url: mapping.canonical_url, native_revision: "native-1", ownership_receipt_sha256: "b".repeat(64), representation: { kind: "full", source_content_sha256: source.content_sha256 } } };
    },
    async verify({ mapping, work, source, result }) { return { kind: "published", url: mapping.canonical_url, native_id: result.nativeResult.native_id, source_revision: work.source_revision, source_content_sha256: source.content_sha256, native_publication_sha256: "c".repeat(64), verification_profile: "synthetic-test-profile", checked_at: "2026-10-14T00:00:01.000Z", representation: result.nativeResult.representation }; },
  };
  return { store, sources, mappings, works, acknowledgements, synchronizations, client, native, calls, claimed, uuid };
}

test("one bounded batch processes distinct work with separate mapping, lease, fence and acknowledgement identities", async () => {
  const { store, client, native, synchronizations, acknowledgements } = distinctFixture();
  const result = await synchronizeCms(config, store, client, native, { maximumWork: 2 });
  assert.equal(result.created, 2); assert.equal(result.failed, 0); assert.equal(Object.keys(store.state.publications).length, 2);
  assert.deepEqual(synchronizations.map((item) => item.generation), [2, 3]);
  assert.equal(new Set(synchronizations.map((item) => item.mapping)).size, 2);
  assert.deepEqual(acknowledgements.map((item) => item.stage), ["synchronized", "verified", "synchronized", "verified"]);
  assert.notEqual(acknowledgements[0].authority.work_id, acknowledgements[2].authority.work_id);
});

test("known local loss neither renews nor claims again while positive mapping selection progresses unrelated work", async () => {
  const f = distinctFixture({ mediaFirst: true });
  const result = await synchronizeCms(config, f.store, f.client, f.native, { maximumWork: 2 });
  assert.equal(result.failed, 1); assert.equal(result.created, 1);
  assert.deepEqual(f.calls.filter((call) => call.routeId === "V4-13").map((call) => call.request.mapping_id), [undefined, f.mappings[1].mapping_id]);
  assert.equal(f.calls.some((call) => call.routeId === "V4-17"), false);
  const issue = structuredClone(f.store.state.publications[f.mappings[0].resource_id].cms.local_native_limitation);
  const original = structuredClone(f.store.state.cms_journal[issue.claim_key]);
  const firstCalls = f.calls.length;
  await synchronizeCms(config, f.store, f.client, f.native, { maximumWork: 4 });
  const reentry = f.calls.slice(firstCalls);
  assert.equal(reentry.some((call) => call.routeId === "V4-15"), false);
  assert.equal(reentry.some((call) => call.routeId === "V4-13" && call.request.mapping_id !== f.mappings[1].mapping_id), false);
  assert.deepEqual(f.store.state.cms_journal[issue.claim_key], original);
  assert.equal(f.synchronizations.length, 1); assert.equal(f.works[0].attempt, 1); assert.equal(f.works[0].state, "leased");
});

test("actual supersession releases only its exact local cause before a fresh receiver poll", async () => {
  const f = fixture();
  f.native.synchronize = async () => assertNativeContentRepresentable('<audio src="https://media.example/audio.mp3"></audio>');
  await synchronizeCms(config, f.store, f.client, f.native, { maximumWork: 1 });
  f.work.state = "superseded";
  const originalExecute = f.client.execute;
  let actualClaim;
  f.client.execute = async (operation) => { if (operation.routeId === "V4-13") actualClaim = operation.request; return originalExecute(operation); };
  await synchronizeCms(config, f.store, f.client, f.native, { maximumWork: 1 });
  assert.equal(f.store.state.publications[resourceId].cms.local_native_limitation, undefined);
  assert.equal(f.store.state.publications[resourceId].cms.local_limitation_history[0].reconciled_work.state, "superseded");
  assert.ok(actualClaim); assert.equal(actualClaim.mapping_id, undefined);
});

test("faithful preflight repair resumes the retained live claim without another claim or attempt", async () => {
  const f = fixture(), supported = f.native.synchronize;
  const loss = async () => assertNativeContentRepresentable('<video src="https://media.example/video.mp4"></video>');
  f.native.preflight = loss; f.native.synchronize = loss;
  await synchronizeCms(config, f.store, f.client, f.native, { maximumWork: 1 });
  const issue = structuredClone(f.store.state.publications[resourceId].cms.local_native_limitation);
  const originalClaim = structuredClone(f.store.state.cms_journal[issue.claim_key]);
  f.native.preflight = async ({ content }) => assertNativeContentRepresentable(content.html);
  f.native.synchronize = supported;
  assert.equal((await synchronizeCms(config, f.store, f.client, f.native, { maximumWork: 1 })).created, 1);
  assert.equal(f.calls.filter((call) => call.routeId === "V4-13").length, 1);
  assert.deepEqual(f.store.state.cms_journal[issue.claim_key], originalClaim);
  assert.equal(f.work.attempt, 1); assert.equal(f.store.state.publications[resourceId].cms.local_native_limitation, undefined);
});

test("native mutation lock serializes distinct StateStore writers while their durable intents can commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ghost-native-lock-")), path = join(directory, "state.json");
  try {
    const first = new StateStore(path), second = new StateStore(path), order = [];
    let release, acquired;
    const entered = new Promise((resolve) => { acquired = resolve; });
    const hold = new Promise((resolve) => { release = resolve; });
    const a = first.withNativeLock(async (assertLock) => { await assertLock(); order.push("first"); await first.update(async (state) => { state.publications[resourceId] = { state: "pending", create_outcome_uncertain: true }; }); acquired(); await hold; await assertLock(); order.push("first-end"); });
    await entered;
    const b = second.withNativeLock(async (assertLock) => { await assertLock(); assert.equal((await second.read()).publications[resourceId].create_outcome_uncertain, true); order.push("second"); });
    await new Promise((resolve) => setTimeout(resolve, 50)); assert.deepEqual(order, ["first"]);
    release(); await Promise.all([a, b]); assert.deepEqual(order, ["first", "first-end", "second"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
