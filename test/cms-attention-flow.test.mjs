import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { fixture, sha, resourceId, mappingId, workId } from "./fixtures/cms-native-fixture.mjs";
import { ghostCmsNative } from "../src/cms-native-publication.mjs";
import { synchronizeCms } from "../src/cms-coordinator.mjs";
import { validateCms, validateCmsRoute } from "../lib/cms-runtime.mjs";

const inspectedId = "44444444-4444-4444-8444-444444444444", successorId = "55555555-5555-4555-8555-555555555555", cycleId = "66666666-6666-4666-8666-666666666666", recoveryId = "77777777-7777-4777-8777-777777777777";
const observedAt = Date.parse("2026-10-25T00:00:00.000Z"), interop = [];
const copy = (value) => structuredClone(value);

async function flow({ kind = "baseline", lostReport = false, lostSync = false, type = "post" } = {}) {
  const f = fixture(type, "full", { lostUpdate: kind === "candidate" });
  const publicFetch = async (url) => { const response = new Response(f.object()?.status === "published" ? `<article>${f.object().html}</article>` : "", { status: f.object()?.status === "published" ? 200 : 404, headers: { "Content-Type": "text/html" } }); Object.defineProperty(response, "url", { value: url }); return response; };
  const native = ghostCmsNative(f.ghost, { publicFetch, now: () => observedAt });
  let accepted = null, verification = null;
  if (kind !== "never") {
    if (kind === "candidate") await assert.rejects(native.synchronize(f.context), /lost update/);
    else { accepted = (await native.synchronize(f.context)).nativeResult; verification = await native.verify({ ...f.context, result: { nativeResult: accepted, expectedHtml: f.object().html } }); }
  }
  const acceptedSourceRevision = accepted?.kind === "publish_revision" ? f.context.source.source_revision : null;
  if (kind === "dated_candidate") {
    f.context.source.source_revision = "revision-with-native-date-projection";
    f.context.source.source_updated_at = "2026-10-24T00:00:00.462Z";
    f.context.work.source_revision = f.context.source.source_revision;
    const html = "<p>Applied edition with original fractional source date</p>";
    f.context.content = { bytes: Buffer.from(html), html }; f.context.source.content_sha256 = sha(html); f.context.source.content_bytes = Buffer.byteLength(html);
    const update = f.ghost.update;
    const storedUpdate = (id, payload, type) => update(id, Object.hasOwn(payload, "published_at") ? { ...payload, published_at: new Date(Math.floor(Date.parse(payload.published_at) / 1000) * 1000).toISOString() } : payload, type);
    f.ghost.update = async (...args) => { await storedUpdate(...args); throw new Error("Synthetic lost fractional-date update response after native effect"); };
    await assert.rejects(native.synchronize(f.context), (error) => error.cmsMutationUncertain === true && /lost fractional-date/.test(error.message));
    f.ghost.update = storedUpdate;
    // Saved pre-fix state uses the original millisecond expectation, as in
    // GN4's captured applied intent. All other intent/native facts came from
    // the actual writer above; no ready result or new receipt is fabricated.
    f.context.store.state.publications[resourceId].cms.intent.published_at = f.context.source.source_updated_at;
  }
  if (["withdrawn", "withdrawn_candidate"].includes(kind)) {
    const withdrawalWork = { ...f.context.work, action: "withdraw", source_revision: null };
    accepted = (await native.synchronize({ ...f.context, work: withdrawalWork })).nativeResult;
    verification = await native.verify({ ...f.context, work: withdrawalWork, result: { nativeResult: accepted, expectedHtml: f.object().html } });
    assert.equal(verification.kind, "absent");
    f.context.store.state.publications[resourceId].cms.last_verified = { native_result: copy(accepted), verification: copy(verification) };
    f.context.source.source_revision = "revision-after-withdrawal";
    f.context.source.source_updated_at = "2026-10-24T00:00:00.000Z";
    f.context.work.source_revision = f.context.source.source_revision;
  }
  if (kind === "withdrawn_candidate") {
    const html = "<p>Republished after the verified withdrawal</p>";
    f.context.content = { bytes: Buffer.from(html), html }; f.context.source.content_sha256 = sha(html); f.context.source.content_bytes = Buffer.byteLength(html);
    const receipt = copy(f.context.store.state.publications[resourceId].cms.ownership_receipt), update = f.ghost.update;
    f.ghost.update = async (...args) => { await update(...args); throw new Error("Synthetic lost republish response after native update effect"); };
    await assert.rejects(native.synchronize(f.context), (error) => error.cmsMutationUncertain === true && /lost republish response/.test(error.message));
    f.ghost.update = update;
    // Only the real native writer created the desired intent. Its new receipt
    // was never saved because the API response was lost after its effect.
    assert.deepEqual(f.context.store.state.publications[resourceId].cms.ownership_receipt, receipt);
  }
  const policy = { policy_revision: "policy-1", enabled: true, selection: "all_public", category_ids: [], include_topic_ids: [], exclude_topic_ids: [], include_unlisted: false, publication_kind: "dynamic", presentation_mode: "full", author_ids: [], taxonomy_ids: [] };
  const connection = { connection_id: f.context.config.connectionId, profile: "ghost", destination_origin: f.context.config.ghostOrigin, scope_revision: "scope-1", forum_name: "Forum & Name", directions: ["from_discourse"], policy, publication_lane: "default", native_capabilities: { native_revision: "capabilities-1", supported_presentations: ["simple", "full", "interactive"], publication_kind: "dynamic", complete_content_supported: true } };
  const mapping = { ...f.context.mapping, connection_id: connection.connection_id, mapping_revision: "mapping-1", destination_native_id: accepted?.native_id ?? null, retired_url_count: 0, mapping_state: "attention", desired_source_revision: f.context.source.source_revision, synchronized_source_revision: accepted?.kind === "publish_revision" ? acceptedSourceRevision : null, publicly_verified_source_revision: accepted?.kind === "publish_revision" ? acceptedSourceRevision : null, destination_native_revision: accepted?.native_revision ?? null, source_created_at: f.context.source.source_created_at, source_updated_at: f.context.source.source_updated_at, synchronized_at: accepted ? new Date(observedAt).toISOString() : null, publicly_verified_at: accepted ? new Date(observedAt).toISOString() : null };
  const failed = { work_id: workId, mapping_id: mappingId, source_id: f.context.source.source_id, source_revision: f.context.source.source_revision, policy_revision: policy.policy_revision, action: "publish_revision", state: "attention", attempt_cycle: workId, attempt: 3, lease_generation: 2, retry_at: null, last_failure_code: "public_verification_failed" };
  const inspection = { sequence: 1, inspection_id: inspectedId, context_sha256: sha("exact-selected-context"), work: copy(failed), mapping: copy(mapping), source: copy(f.context.source), native_result: copy(accepted), verified_native_result: copy(accepted), verification: copy(verification), prepared_transaction: null, created_at: new Date(observedAt).toISOString() };
  validateCms("AttentionInspection", inspection);
  const item = f.context.store.state.publications[resourceId]; item.cms.work_id = workId; item.state = "attention"; item.topic_id = f.context.source.topic_id; item.topic_url = f.context.source.topic_url;
  const calls = [], reports = []; let reportLost = lostReport, syncLost = lostSync, recovery, current, inspections = 0;
  const lease = () => ({ work: copy(current), lease_token: Buffer.alloc(32, 7).toString("base64url"), lease_generation: 3, server_time: new Date(observedAt).toISOString(), expires_at: new Date(observedAt + 300_000).toISOString() });
  const client = {
    connection: async () => copy(connection), policy: async () => copy(policy),
    sources: async ({ stream }) => ({ stream, items: [], next_cursor: null, checkpoint_cursor: "same-source-no-event" }),
    attentionCapability: async () => ({ protocol_revision: "attention-recovery-1", candidate_id: "discussionbridge-v4-core-20261025-r6", inspection_profiles: ["ghost-dynamic-1"] }),
    attentionInspections: async ({ after }) => ({ items: after === 0 ? [copy(inspection)] : [], next_after: after === 0 ? 1 : after, has_more: false }),
    attentionRecoveries: async ({ after }) => ({ items: recovery && after === 0 ? [copy(recovery)] : [], next_after: recovery ? 1 : after, has_more: false }),
    work: async (id) => ({ work: copy(id === workId ? failed : current), mapping: copy(mapping), lease_expires_at: id === workId || !current || current.state === "attention" ? null : lease().expires_at }),
    prepareMutation(routeId, body, path = {}) { validateCmsRoute(routeId, { body, path }); return { routeId, body: copy(body), path: copy(path) }; },
    async execute({ routeId, body, path }) {
      calls.push({ routeId, body: copy(body), path: copy(path) });
      if (routeId === "V4-34") {
        reports.push(copy(body)); const value = body.observation;
        const ready = value.issue === "none" && value.pending_mutation !== "uncertain" && (value.native_state === "never_applied" && value.object_exists === false || value.native_state === "baseline" && value.current_sha256 === value.baseline_sha256 || value.native_state === "candidate_applied" && value.current_sha256 === value.candidate_sha256);
        if (reportLost) { reportLost = false; throw Object.assign(new Error("Synthetic lost report response"), { requestOutcomeUncertain: true }); }
        return { inspection_id: inspectedId, context_sha256: inspection.context_sha256, status: ready ? "ready" : "not_ready", issue: value.issue, observed_at: value.observed_at };
      }
      if (routeId === "V4-36") { assert.equal(path.recovery_id, recoveryId); assert.equal(body.work_id, successorId); current.state = "leased"; current.attempt = 1; current.lease_generation = 3; return lease(); }
      if (routeId === "V4-13") return undefined;
      if (routeId === "V4-15") return lease();
      if (routeId === "V4-16") {
        current.state = body.stage; if (body.stage === "synchronized") mapping.destination_native_id = body.native_result.native_id;
        if (body.stage === "synchronized" && syncLost) { syncLost = false; throw Object.assign(new Error("Synthetic lost synchronized response"), { requestOutcomeUncertain: true }); }
        return { work: copy(current), mapping: copy(mapping), lease_expires_at: lease().expires_at };
      }
      if (routeId === "V4-17") { current.state = "attention"; return { work: copy(current), mapping: copy(mapping), lease_expires_at: null }; }
      throw new Error(`Unexpected route ${routeId}`);
    },
    completeSource: async (source, { beforeChunk }) => { assert.deepEqual(source, f.context.source); await beforeChunk(); return copy(f.context.content); },
  };
  const collect = native.inspectAttention; native.inspectAttention = async (...args) => { inspections++; return collect.apply(native, args); };
  const admit = () => {
    assert.equal(reports.at(-1)?.observation.issue, "none"); failed.state = "superseded"; mapping.mapping_revision = "mapping-recovery"; mapping.mapping_state = "pending";
    current = { ...copy(failed), work_id: successorId, state: "pending", attempt_cycle: cycleId, attempt: 0, lease_generation: 0, last_failure_code: null };
    recovery = { sequence: 1, recovery_id: recoveryId, inspection_id: inspectedId, context_sha256: inspection.context_sha256, predecessor_work_id: workId, predecessor_attempt_cycle: workId, work: copy(current), mapping: copy(mapping), source: copy(f.context.source), mode: "retry", native_baseline: copy(reports.at(-1).observation.native_result), verification: copy(reports.at(-1).observation.verification), created_at: new Date(observedAt).toISOString() };
    validateCms("AttentionRecovery", recovery); return copy(recovery);
  };
  const run = (maximumWork = 0) => synchronizeCms(f.context.config, f.context.store, client, native, { maximumWork, now: () => observedAt });
  return { ...f, policy, connection, mapping, failed, inspection, native, client, calls, reports, admit, run, inspectionCount: () => inspections, current: () => current };
}

for (const kind of ["baseline", "candidate", "never"]) test(`actual ${kind} observation reaches a typed ready report without creating an automatic cycle`, async () => {
  const f = await flow({ kind }), nativeBefore = f.counts(), old = copy(f.context.store.state.publications[resourceId].cms);
  await f.run();
  const facts = f.reports.at(-1).observation; validateCms("AttentionObservation", facts);
  assert.equal(f.context.store.state.cms_attention.inspections[inspectedId].result.status, "ready"); assert.equal(f.current(), undefined);
  assert.equal(f.counts().creates, nativeBefore.creates); assert.equal(f.counts().updates, nativeBefore.updates); assert.deepEqual(f.context.store.state.publications[resourceId].cms, old);
  interop.push({ id: `ghost-${kind}`, profile: "ghost", publication_kind: "dynamic", inspection: copy(f.inspection), observation: copy(facts), expected_status: "ready" });
});

test("verified withdrawn baseline retains the prior receipt revision and republishes the same object through an explicit fresh cycle", async () => {
  const f = await flow({ kind: "withdrawn" }), old = copy(f.context.store.state.publications[resourceId].cms), nativeBefore = f.counts();
  assert.equal(old.ownership_receipt.source_revision, "revision-1"); assert.equal(old.last_verified.native_result.kind, "withdraw");
  assert.equal(f.inspection.mapping.synchronized_source_revision, null); assert.equal(f.inspection.mapping.publicly_verified_source_revision, null);
  await f.run(); const facts = f.reports.at(-1).observation;
  assert.equal(facts.native_state, "baseline"); assert.equal(facts.native_result.kind, "withdraw"); assert.equal(facts.verification.kind, "absent");
  assert.equal(facts.ownership.source_revision, "revision-1"); assert.equal(facts.source_revision, "revision-1"); assert.notEqual(facts.source_revision, f.inspection.work.source_revision);
  assert.equal(f.context.store.state.cms_attention.inspections[inspectedId].result.status, "ready"); assert.equal(f.current(), undefined);
  assert.equal(f.counts().creates, nativeBefore.creates); assert.equal(f.counts().updates, nativeBefore.updates);
  interop.push({ id: "ghost-verified-withdrawn-baseline", profile: "ghost", publication_kind: "dynamic", inspection: copy(f.inspection), observation: copy(facts), expected_status: "ready" });
  f.admit(); const result = await f.run(1), item = f.context.store.state.publications[resourceId];
  assert.equal(result.failed, 0); assert.equal(result.updated, 1); assert.equal(f.current().state, "verified");
  assert.equal(item.ghost_post_id, old.ownership_receipt.native_id); assert.equal(item.cms.last_lease_generation, 3); assert.equal(item.cms.work_id, successorId);
  assert.deepEqual(item.cms.recovery_history[0].prior, old); assert.equal(item.cms.ownership_receipt.source_revision, "revision-after-withdrawal");
  assert.equal(f.counts().creates, 1); assert.equal(f.counts().updates, nativeBefore.updates + 1); assert.equal(f.object().status, "published");
});

test("known applied republish after verified withdrawal reconciles actual API effect without inventing a new receipt or repeating the update", async () => {
  const f = await flow({ kind: "withdrawn_candidate" }), old = copy(f.context.store.state.publications[resourceId].cms), nativeBefore = f.counts();
  assert.equal(f.object().status, "published"); assert.equal(f.context.store.state.publications[resourceId].source_status, "withdrawn");
  assert.equal(old.ownership_receipt.source_revision, "revision-1"); assert.equal(old.last_verified.native_result.kind, "withdraw"); assert.equal(old.last_verified.verification.kind, "absent");
  assert.equal(old.intent.source_revision, "revision-after-withdrawal"); assert.equal(old.intent.native_id, old.ownership_receipt.native_id);
  assert.notEqual(old.native_revision, f.object().updated_at); assert.equal(f.inspection.mapping.synchronized_source_revision, null); assert.equal(f.inspection.mapping.publicly_verified_source_revision, null);
  await f.run(); const facts = f.reports.at(-1).observation;
  assert.equal(facts.native_state, "candidate_applied"); assert.equal(facts.pending_mutation, "settled"); assert.equal(facts.native_result.kind, "publish_revision"); assert.equal(facts.verification.kind, "published");
  assert.equal(facts.ownership.source_revision, "revision-1"); assert.equal(facts.source_revision, "revision-after-withdrawal"); assert.equal(facts.verification.source_revision, "revision-after-withdrawal");
  assert.equal(facts.current_sha256, facts.candidate_sha256); assert.equal(facts.native_revision, f.object().updated_at);
  assert.deepEqual(f.context.store.state.publications[resourceId].cms, old); assert.equal(f.counts().creates, nativeBefore.creates); assert.equal(f.counts().updates, nativeBefore.updates);
  interop.push({ id: "ghost-known-candidate-after-verified-withdrawal", profile: "ghost", publication_kind: "dynamic", inspection: copy(f.inspection), observation: copy(facts), expected_status: "ready" });
  f.admit(); const result = await f.run(1), item = f.context.store.state.publications[resourceId];
  assert.equal(result.failed, 0); assert.equal(result.unchanged, 1); assert.equal(f.current().state, "verified"); assert.equal(item.cms.last_lease_generation, 3);
  assert.equal(item.ghost_post_id, old.ownership_receipt.native_id); assert.equal(item.cms.ownership_receipt.source_revision, "revision-after-withdrawal"); assert.deepEqual(item.cms.recovery_history[0].prior, old);
  assert.equal(f.counts().creates, nativeBefore.creates); assert.equal(f.counts().updates, nativeBefore.updates); assert.match(f.object().html, /Republished after the verified withdrawal/);
});

for (const type of ["post", "page"]) test(`applied pre-fix ${type} date intent becomes a known candidate and explicit successor without another native write`, async () => {
  const f = await flow({ kind: "dated_candidate", type }), old = copy(f.context.store.state.publications[resourceId].cms), source = copy(f.context.source), content = { html: f.context.content.html, bytes: Buffer.from(f.context.content.bytes) }, actual = copy(f.object()), counts = f.counts();
  assert.equal(old.intent.published_at, "2026-10-24T00:00:00.462Z"); assert.equal(actual.published_at, "2026-10-24T00:00:00.000Z");
  assert.equal(old.ownership_receipt.source_revision, "revision-1"); assert.notEqual(old.native_revision, actual.updated_at);
  assert.equal(f.inspection.mapping.synchronized_source_revision, "revision-1");
  await f.run(); const facts = f.reports.at(-1).observation;
  assert.equal(facts.native_state, "candidate_applied"); assert.equal(facts.issue, "none"); assert.equal(facts.verification.kind, "published");
  assert.deepEqual(f.context.store.state.publications[resourceId].cms, old); assert.deepEqual(f.counts(), counts);
  f.context.store.state = JSON.parse(JSON.stringify(f.context.store.state)); f.admit();
  const result = await f.run(1), item = f.context.store.state.publications[resourceId];
  assert.equal(result.failed, 0); assert.equal(result.unchanged, 1); assert.equal(f.current().state, "verified");
  assert.equal(item.ghost_post_id, actual.id); assert.equal(item.cms.last_lease_generation, 3);
  assert.deepEqual(item.cms.recovery_history[0].prior, old); assert.equal(item.cms.recovery_history[0].prior.intent.published_at, "2026-10-24T00:00:00.462Z");
  assert.deepEqual(item.cms.recovery_history[0].prior.ownership_receipt, old.ownership_receipt);
  assert.equal(item.cms.ownership_receipt.source_revision, source.source_revision); assert.equal(item.source_updated_at, source.source_updated_at);
  assert.deepEqual(f.context.source, source); assert.deepEqual(f.context.content, content); assert.deepEqual(f.object(), actual); assert.deepEqual(f.counts(), counts);
  assert.ok(actual.html.includes(`datetime="${source.source_updated_at}"`));
  await f.run(1); assert.equal(item.cms.recovery_history.length, 1); assert.deepEqual(f.counts(), counts);
});

test("explicit same-source recovery uses exact successor/new cycle and higher fence, retaining old history and native identity", async () => {
  const f = await flow(), old = copy(f.context.store.state.publications[resourceId].cms); await f.run();
  f.context.store.state = JSON.parse(JSON.stringify(f.context.store.state)); f.admit();
  const summary = await f.run(2), item = f.context.store.state.publications[resourceId];
  assert.equal(summary.failed, 0); assert.equal(summary.unchanged, 1); assert.equal(item.cms.work_id, successorId); assert.equal(item.cms.last_lease_generation, 3); assert.equal(item.ghost_post_id, old.ownership_receipt.native_id);
  assert.deepEqual(item.cms.recovery_history[0].prior, old); assert.equal(f.current().attempt_cycle, cycleId); assert.equal(f.current().state, "verified");
  assert.equal(f.calls.filter((call) => call.routeId === "V4-36").length, 1); assert.equal(f.calls.some((call) => call.routeId === "V4-09"), false);
  assert.equal(f.counts().creates, 1); assert.equal(f.counts().updates, 1); assert.equal(f.inspectionCount(), 2); assert.equal(f.context.store.state.cms_feed.checkpoint_cursor, "same-source-no-event");
  await f.run(1); assert.equal(f.calls.filter((call) => call.routeId === "V4-36").length, 1); assert.equal(item.cms.recovery_history.length, 1);
});

for (const kind of ["candidate", "never"]) test(`explicit ${kind} recovery keeps the authorized identity and performs no duplicate create/update`, async () => {
  const f = await flow({ kind }); await f.run(); f.admit();
  const result = await f.run(1), item = f.context.store.state.publications[resourceId];
  assert.equal(result.failed, 0); assert.equal(item.cms.work_id, successorId); assert.equal(item.cms.last_lease_generation, 3); assert.equal(f.current().state, "verified");
  assert.equal(f.counts().creates, 1); assert.equal(f.counts().updates, 1); assert.equal(item.cms.recovery_history[0].prior.work_id, workId);
});

test("lost observation response replays the exact saved report instead of recollecting or admitting Work", async () => {
  const f = await flow({ lostReport: true }); await assert.rejects(f.run(), /lost report/); const saved = copy(f.reports[0]);
  await f.run(); assert.equal(f.reports.length, 2); assert.deepEqual(f.reports[1], saved); assert.equal(f.inspectionCount(), 1); assert.equal(f.current(), undefined);
});

test("restart after uncertain successor ACK resumes that exact journal without rechecking its old baseline or claiming another cycle", async () => {
  const f = await flow({ lostSync: true }); await f.run(); f.admit();
  assert.equal((await f.run(1)).failed, 1); const sent = copy(f.calls.find((call) => call.routeId === "V4-16"));
  f.context.store.state = JSON.parse(JSON.stringify(f.context.store.state));
  const result = await f.run(1); assert.equal(result.failed, 0); assert.equal(f.current().state, "verified");
  const replay = f.calls.filter((call) => call.routeId === "V4-16" && call.body.stage === "synchronized");
  assert.equal(replay.length, 2); assert.deepEqual(replay[1], sent); assert.equal(f.calls.filter((call) => call.routeId === "V4-36").length, 1); assert.equal(f.inspectionCount(), 2);
  assert.equal(f.context.store.state.publications[resourceId].cms.recovery_history.length, 1); assert.equal(f.counts().creates, 1); assert.equal(f.counts().updates, 1);
});

test("native edit between Check and new claim prevents publication and retains both old and successor failure evidence", async () => {
  const f = await flow(); await f.run(); f.admit(); f.object().html = f.object().html.replace("Original source", "Native editor changed it"); f.object().updated_at = "2026-10-25T00:00:01.000Z";
  const before = f.counts(), summary = await f.run(1), item = f.context.store.state.publications[resourceId];
  assert.equal(summary.failed, 1); assert.equal(f.counts().creates, before.creates); assert.equal(f.counts().updates, before.updates); assert.equal(f.current().state, "attention");
  assert.equal(item.cms.work_id, successorId); assert.equal(item.cms.recovery_history[0].prior.work_id, workId); assert.match(f.object().html, /Native editor/);
});

test("receiver context drift during Check is reported stale without replacing the native failure context", async () => {
  const f = await flow(), collect = f.native.inspectAttention, before = copy(f.context.store.state.publications[resourceId].cms);
  f.native.inspectAttention = async (...args) => { const value = await collect(...args); f.mapping.mapping_revision = "changed-during-check"; return value; };
  await f.run(); assert.equal(f.reports.at(-1).observation.issue, "context_changed"); assert.equal(f.current(), undefined);
  assert.deepEqual(f.context.store.state.publications[resourceId].cms, before);
});

for (const kind of ["foreign", "uncertain"]) test(`actual ${kind} native facts stay typed not-ready`, async () => {
  const f = await flow();
  if (kind === "foreign") f.object().html = f.object().html.replace("Original source", "Foreign edit");
  else f.context.store.state.cms_journal = { unknown: { completed: false, routeId: "V4-16", path: { work_id: workId }, body: { authority: { work_id: workId } } } };
  await f.run(); const facts = f.reports.at(-1).observation;
  assert.equal(f.context.store.state.cms_attention.inspections[inspectedId].result.status, "not_ready"); assert.equal(f.current(), undefined);
  interop.push({ id: `ghost-${kind}`, profile: "ghost", publication_kind: "dynamic", inspection: copy(f.inspection), observation: copy(facts), expected_status: "not_ready" });
});

after(() => {
  if (process.env.GHOST_CORE_INTEROP === "1") {
    mkdirSync(new URL("../.tmp/", import.meta.url), { recursive: true });
    writeFileSync(new URL("../.tmp/GHOST_CORE_INTEROP.json", import.meta.url), JSON.stringify(interop, null, 2) + "\n");
  }
});
