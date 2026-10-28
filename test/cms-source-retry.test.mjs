// Pure stores and injected transports only; no HTTP/native process or file store.
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, key, resource, topic, sha } from "./fixtures/cms-source-fixture.mjs";
import { MAX_STATE_BYTES, serializedState } from "../src/state-file.mjs";

const errorBody = () => ({ outcome: "rejected", code: "invalid_field", retryable: false,
  retry_after_seconds: null, correlation_id: "actually-retained", core_fallback: false });
async function refuse(f, { accepted = false } = {}) {
  if (accepted) { await f.publish(); f.native.html = "<p>Genuine refused update</p>"; }
  f.preservationResponse = errorBody();
  await assert.rejects(f.publish(), (error) => error.code === "invalid_field" && error.status === 422 && error.requestOutcomeUncertain === false);
  return structuredClone((await f.store.read()).posts[key].cms_source.intent);
}
const retry = (f, intent, overrides = {}) => f.publish({ retryRefusedMutationId: intent.body.mutation_id, ...overrides });

test("r6 preserves exact r5 pending request bytes/provenance for uncertain replay and explicit known-refusal recovery", async () => {
  const r5 = { candidate_id: "discussionbridge-v4-core-20261015-r5", wire_version: "v4", schema_sha256: "7dee282601e4195459f38b2f2451a5f0f03af39a5f60affc65c49b34664e3f7a", runtime_sha256: "f10478b83f9c5f6a1ede95bb3e70cfe1dad30684c8f4d869bcbf86b4ddbe8dbc" };
  const uncertain = fixture(); uncertain.lose = true; await assert.rejects(uncertain.publish());
  await uncertain.store.update(async (state) => { state.posts[key].cms_source.intent.artifact_binding = structuredClone(r5); });
  const pending = (await uncertain.store.read()).posts[key].cms_source.intent, originalBytes = JSON.stringify(pending.body);
  await uncertain.publish(); assert.equal(JSON.stringify(uncertain.bodies.at(-1)), originalBytes);
  assert.deepEqual((await uncertain.store.read()).posts[key].cms_source.accepted_artifacts, r5);
  const refused = fixture(); await refuse(refused);
  await refused.store.update(async (state) => { const current = state.posts[key].cms_source.intent; current.artifact_binding = structuredClone(r5); current.rejection_outcome.artifact_binding = structuredClone(r5); });
  const old = (await refused.store.read()).posts[key].cms_source.intent; refused.preservationResponse = undefined; await retry(refused, old);
  assert.deepEqual((await refused.store.read()).posts[key].cms_source.rejected_history[0], old);
  assert.equal((await refused.store.read()).posts[key].cms_source.rejected_history[0].artifact_binding.candidate_id, r5.candidate_id);
});

test("known To02 refusal suppresses unchanged automatic replay and retains the exact request/evidence", async () => {
  const f = fixture(), refused = await refuse(f), calls = f.bodies.length;
  f.preservationResponse = undefined;
  await assert.rejects(f.publish(), /invalid_field/u);
  assert.equal(f.bodies.length, calls);
  const row = (await f.store.read()).posts[key];
  assert.deepEqual(row.cms_source.intent, refused); assert.equal(row.outcome, "attention");
  assert.equal(row.cms_source.rejected_history, undefined); assert.equal(row.cms_source.retry_history, undefined);
  assert.deepEqual(refused.rejection_outcome.envelope, errorBody());
});

test("explicit unchanged-source creation Retry changes only request ID and retains immutable refusal/linkage after acceptance", async () => {
  const f = fixture(), native = structuredClone(f.native), refused = await refuse(f);
  f.preservationResponse = undefined; await retry(f, refused);
  const next = f.bodies.at(-1), row = (await f.store.read()).posts[key];
  assert.notEqual(next.mutation_id, refused.body.mutation_id);
  assert.deepEqual({ ...next, mutation_id: refused.body.mutation_id }, refused.body);
  assert.equal(next.bridge_record.expected_source_revision, null);
  assert.deepEqual(f.native, native); assert.equal(row.resource_id, resource); assert.equal(row.topic_id, topic);
  assert.deepEqual(row.cms_source.rejected_history, [refused]); assert.equal(row.cms_source.intent, undefined);
  assert.equal(row.cms_source.retry_history.length, 1);
  const link = row.cms_source.retry_history[0];
  assert.equal(link.refused_mutation_id, refused.body.mutation_id); assert.equal(link.mutation_id, next.mutation_id);
  assert.equal(link.source_revision, refused.body.bridge_record.source_revision);
  assert.equal(link.operator_action.action, "retry_source");
  assert.equal(link.operator_action.control, "existing_protected_operator_route");
  assert.equal(Object.hasOwn(link.operator_action, "actor"), false);
});

test("bound Retry keeps actual accepted predecessor/native IDs/source revision/article/dates and accepted history", async () => {
  const f = fixture(), refused = await refuse(f, { accepted: true });
  const before = (await f.store.read()).posts[key];
  f.preservationResponse = undefined; await retry(f, refused);
  const row = (await f.store.read()).posts[key], next = f.bodies.at(-1);
  assert.equal(next.bridge_record.expected_source_revision, before.cms_source.accepted_revision);
  assert.deepEqual(next.bridge_record, refused.body.bridge_record);
  assert.equal(row.resource_id, before.resource_id); assert.equal(row.topic_id, before.topic_id);
  assert.deepEqual(row.cms_source.accepted_history.at(-1).input, before.cms_source.accepted_input);
  assert.deepEqual(row.cms_source.rejected_history, [refused]);
});

test("another definitive refusal stops the new intent; duplicate automatic and stale operator actions cannot replace it", async () => {
  const f = fixture(), first = await refuse(f);
  await assert.rejects(retry(f, first), /invalid_field/u);
  const row = (await f.store.read()).posts[key], second = structuredClone(row.cms_source.intent), count = f.bodies.length;
  assert.notEqual(second.body.mutation_id, first.body.mutation_id);
  assert.deepEqual(row.cms_source.rejected_history, [first]); assert.equal(row.cms_source.retry_history.length, 1);
  await assert.rejects(f.publish(), /invalid_field/u); await assert.rejects(retry(f, first));
  assert.equal(f.bodies.length, count);
  assert.deepEqual((await f.store.read()).posts[key].cms_source.intent, second);
});

test("duplicate concurrent explicit actions consume one exact refused intent only once", async () => {
  const f = fixture(), refused = await refuse(f); f.preservationResponse = undefined;
  const before = f.bodies.length, outcomes = await Promise.allSettled([retry(f, refused), retry(f, refused)]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((item) => item.status === "rejected").length, 1);
  assert.equal(f.bodies.length, before + 1);
  assert.equal((await f.store.read()).posts[key].cms_source.retry_history.length, 1);
});

test("a stale action after acceptance preserves the complete newer state and performs no request", async () => {
  const f = fixture(), refused = await refuse(f); f.preservationResponse = undefined; await retry(f, refused);
  const before = await f.store.read(), count = f.bodies.length;
  await assert.rejects(retry(f, refused));
  assert.equal(f.bodies.length, count); assert.deepEqual(await f.store.read(), before);
});

test("historical witnessed refusal without full Error remains recoverable with missing fields unchanged", async () => {
  const f = fixture(), original = await refuse(f);
  await f.store.update(async (state) => {
    // Synthetic historical fixture: its actual witness keeps only these fields.
    // Product code never derives/imports this from a generic failure string.
    state.posts[key].cms_source.intent.rejection_outcome = { route_id: "V4-02", status: 422,
      code: "invalid_field", mutation_id: original.body.mutation_id };
  });
  const refused = structuredClone((await f.store.read()).posts[key].cms_source.intent);
  f.preservationResponse = undefined; await retry(f, refused);
  const archived = (await f.store.read()).posts[key].cms_source.rejected_history[0];
  assert.deepEqual(archived, refused); assert.equal(Object.hasOwn(archived.rejection_outcome, "envelope"), false);
  assert.equal(Object.hasOwn(archived.rejection_outcome, "correlation_id"), false);
});

test("current source/ownership/scope/predecessor/withdrawal/move drift cannot create a replacement intent", async () => {
  const cases = [
    async (f) => { f.authority.directions = ["from_discourse"]; },
    async (f) => { f.remote.source_revision = "other-current-revision"; },
    async (f) => { f.remote.external_id = "someone-else"; },
    async (f) => { f.remote.state = "withdrawn"; },
    async (f) => { f.native.title = "Changed after operator page"; },
    async (f) => { f.native.status = "draft"; },
    async (f) => { f.native.tags = []; },
    async (f) => { await f.store.update(async (s) => { s.posts[key].cms_source.withdrawal = { state: "prepared" }; }); },
    async (f) => { await f.store.update(async (s) => { s.posts[key].cms_source.source_url_move = { state: "pending_without_optional_intent" }; }); },
    async (f) => { await f.store.update(async (s) => { s.posts[key].cms_source.intent.native_source_scope.ghost_origin = "https://other.example"; }); },
  ];
  for (const alter of cases) {
    const f = fixture(), refused = await refuse(f, { accepted: true }); f.preservationResponse = undefined;
    await alter(f); const before = await f.store.read(), count = f.bodies.length;
    await assert.rejects(retry(f, refused));
    assert.equal(f.bodies.length, count); assert.deepEqual(await f.store.read(), before);
  }
});

test("an unbound refusal cannot adopt a receiver record that appeared before explicit Retry", async () => {
  const f = fixture(), refused = await refuse(f); f.preservationResponse = undefined;
  f.remote = { resource_id: resource, direction: "to_discourse", state: "active", topic_id: topic,
    topic_url: `${config.serverUrl}/t/source/${topic}`, external_id: key, canonical_url: f.native.url,
    source_revision: "some-other-binding", source_created_at: null, source_updated_at: null,
    synchronized_at: "2026-10-14T01:00:00.000Z", mapping_id: null };
  const before = await f.store.read(), count = f.bodies.length;
  await assert.rejects(retry(f, refused));
  assert.equal(f.bodies.length, count); assert.deepEqual(await f.store.read(), before);
});

test("retained payload must still match independently recaptured complete source before a new request ID", async () => {
  const f = fixture(), original = await refuse(f);
  await f.store.update(async (state) => {
    const intent = state.posts[key].cms_source.intent;
    intent.body.bridge_record.title = "Inconsistent retained body";
    intent.rejection_outcome.request_sha256 = sha(JSON.stringify(intent.body));
  });
  const before = await f.store.read(), count = f.bodies.length; f.preservationResponse = undefined;
  await assert.rejects(retry(f, original), /retained payload/u);
  assert.equal(f.bodies.length, count); assert.deepEqual(await f.store.read(), before);
});

test("unwitnessed uncertainty cannot become fresh Retry and continues its identical original request", async () => {
  const f = fixture(); f.lose = true; await assert.rejects(f.publish());
  const intent = structuredClone((await f.store.read()).posts[key].cms_source.intent), before = await f.store.read();
  assert.equal(intent.rejection_outcome, undefined);
  await assert.rejects(retry(f, intent)); assert.deepEqual(await f.store.read(), before);
  await f.publish(); assert.deepEqual(f.bodies[1], intent.body); assert.equal(f.receipts.size, 1);
  assert.equal((await f.store.read()).posts[key].cms_source.retry_history, undefined);
});

test("uncertain replacement retains the same new UUID/request and durable refusal linkage through normal recovery", async () => {
  const f = fixture(), refused = await refuse(f); f.preservationResponse = undefined; f.lose = true;
  await assert.rejects(retry(f, refused));
  const pending = structuredClone((await f.store.read()).posts[key].cms_source.intent), count = f.bodies.length;
  assert.notEqual(pending.body.mutation_id, refused.body.mutation_id); assert.equal(pending.rejection_outcome, undefined);
  await assert.rejects(retry(f, refused)); assert.equal(f.bodies.length, count);
  await f.publish(); assert.deepEqual(f.bodies.at(-1), pending.body); assert.equal(f.receipts.size, 1);
  const saved = (await f.store.read()).posts[key].cms_source;
  assert.deepEqual(saved.rejected_history, [refused]); assert.equal(saved.retry_history[0].mutation_id, pending.body.mutation_id);
});

test("a crash after atomic replacement retains one prepared linked intent that a restarted reader recovers exactly", async () => {
  const f = fixture(), refused = await refuse(f, { accepted: true }); f.preservationResponse = undefined;
  const normalLock = f.store.withNativeLock.bind(f.store);
  f.store.withNativeLock = (callback) => normalLock((assertWriter) => callback(async () => {
    await assertWriter(); const active = (await f.store.read()).posts[key].cms_source.intent;
    if (active?.retry_of_mutation_id && active.request_state === "prepared") throw new Error("Synthetic interruption after atomic replacement");
  }));
  const count = f.bodies.length; await assert.rejects(retry(f, refused)); assert.equal(f.bodies.length, count);
  const durable = (await f.store.read()).posts[key].cms_source;
  assert.deepEqual(durable.rejected_history, [refused]); assert.equal(durable.retry_history.length, 1);
  assert.equal(durable.intent.request_state, "prepared");
  f.store.withNativeLock = normalLock;
  const restarted = fixture(f.store); restarted.native = structuredClone(f.native); restarted.remote = structuredClone(f.remote);
  await restarted.publish(); assert.equal(restarted.bodies.length, 1); assert.deepEqual(restarted.bodies[0], durable.intent.body);
  assert.equal((await f.store.read()).posts[key].cms_source.retry_history[0].mutation_id, durable.intent.body.mutation_id);
});

test("genuine title/authorship/date editions use normal publication with refusal history and no manual global gate", async () => {
  const changes = [
    (native) => { native.title = "Genuine new title"; },
    (native) => { native.authors[0].name = "Genuine current author name"; },
    (native) => { native.updated_at = "2026-10-15T00:00:00Z"; },
  ];
  for (const change of changes) {
    const f = fixture(), refused = await refuse(f, { accepted: true }); f.preservationResponse = undefined; change(f.native);
    await f.publish(); const row = (await f.store.read()).posts[key], body = f.bodies.at(-1);
    assert.notEqual(body.bridge_record.source_revision, refused.body.bridge_record.source_revision);
    assert.deepEqual(row.cms_source.rejected_history, [refused]); assert.equal(row.cms_source.retry_history, undefined);
    assert.equal(row.resource_id, resource); assert.equal(row.topic_id, topic);
  }
});

test("retention budget failure preserves the old refusal without dispatch or partial action linkage", async () => {
  const f = fixture(), refused = await refuse(f); f.preservationResponse = undefined;
  await f.store.update(async (state) => {
    state.retention_padding = "x".repeat(MAX_STATE_BYTES - Buffer.byteLength(serializedState(state)) - 80);
    serializedState(state);
  });
  const before = await f.store.read(), count = f.bodies.length;
  await assert.rejects(retry(f, refused), /protected state budget/u);
  assert.equal(f.bodies.length, count); assert.deepEqual(await f.store.read(), before);
});
