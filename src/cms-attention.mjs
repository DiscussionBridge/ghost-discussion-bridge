import { createHash, randomUUID } from "node:crypto";
import { validateCms } from "../lib/cms-runtime.mjs";

const copy = (value) => structuredClone(value);
const tree = (value) => value && typeof value === "object" ? Array.isArray(value) ? value.map(tree) : Object.fromEntries(Object.keys(value).sort().map((key) => [key, tree(value[key])])) : value;
const equal = (a, b) => JSON.stringify(tree(a)) === JSON.stringify(tree(b));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const requireMatch = (condition, message) => { if (!condition) throw new Error(message); };
const unchangedWork = (a, b) => equal(a, b);
const observation = (issue, now) => ({ profile: "ghost-dynamic-1", observed_at: new Date(now()).toISOString(), native_state: "unknown", object_exists: null, native_id: null, native_revision: null, ownership: null, native_result: null, verification: null, source_revision: null, managed_content_sha256: null, native_command: "none", pending_mutation: "none", prepared_transaction_id: null, journal_sha256: null, baseline_sha256: null, candidate_sha256: null, current_sha256: null, restoration_operation_id: null, issue });

async function sameInspectionContext(client, inspection, connection, policy, assertOperation) {
  await assertOperation();
  const currentConnection = await client.connection(), currentPolicy = await client.policy(), current = await client.work(inspection.work.work_id);
  validateCms("Connection", currentConnection); validateCms("Policy", currentPolicy); validateCms("WorkQueryResponse", current);
  return currentConnection.connection_id === connection.connection_id && currentConnection.scope_revision === connection.scope_revision && currentConnection.destination_origin === connection.destination_origin && equal(currentConnection.policy, currentPolicy) && currentPolicy.enabled && equal(currentPolicy, policy) && unchangedWork(current.work, inspection.work) && current.work.state === "attention" && equal(current.mapping, inspection.mapping);
}

function validatePage(type, page, after) {
  validateCms(type, page);
  let sequence = after;
  for (const entry of page.items) { requireMatch(entry.sequence > sequence, "Ghost attention sequence did not increase"); sequence = entry.sequence; }
  requireMatch(page.next_after === sequence && (!page.has_more || page.items.length > 0), "Ghost attention continuation changed identity");
}

// Runs inside the ordinary configured synchronization opportunity and native
// writer lock. New state is diagnostic/continuation only; this never retries.
export async function synchronizeCmsAttention({ config, store, client, native, connection, policy, assertOperation, mutate, now = () => Date.now() }) {
  if (typeof client.attentionCapability !== "function") return false;
  let capability;
  try {
    await assertOperation(); capability = await client.attentionCapability(); validateCms("AttentionRecoveryCapability", capability);
  } catch {
    return false;
  }
  const supported = capability.protocol_revision === "attention-recovery-1" && capability.candidate_id === "discussionbridge-v4-core-20261025-r6" && capability.inspection_profiles.includes("ghost-dynamic-1") && typeof native.inspectAttention === "function";
  await store.update(async (state) => { state.cms_attention ??= {}; Object.assign(state.cms_attention, { supported }); state.cms_attention.inspections ??= {}; state.cms_attention.recoveries ??= {}; state.cms_attention.inspection_after ??= 0; state.cms_attention.recovery_after ??= 0; });
  if (!supported) return false;
  const before = (await store.read()).cms_attention, page = await client.attentionInspections({ after: before.inspection_after });
  validatePage("AttentionInspectionPage", page, before.inspection_after);
  await store.update(async (state) => {
    const current = state.cms_attention; requireMatch(current.inspection_after === before.inspection_after, "Ghost attention inspection staging was replaced");
    for (const entry of page.items) {
      requireMatch(entry.mapping.connection_id === config.connectionId && entry.work.mapping_id === entry.mapping.mapping_id && entry.work.source_id === entry.mapping.source_id && entry.work.state === "attention", "Ghost attention inspection changed native binding");
      const prior = current.inspections[entry.inspection_id]; requireMatch(!prior || equal(prior.inspection, entry), "Ghost attention inspection identity changed");
      current.inspections[entry.inspection_id] ??= { inspection: copy(entry), completed: false };
    }
    current.inspection_after = page.next_after;
  });
  const pending = Object.values((await store.read()).cms_attention.inspections).filter((entry) => !entry.completed).slice(0, 25);
  for (const entry of pending) {
    const instruction = entry.inspection, key = `attention-report:${instruction.inspection_id}:${instruction.context_sha256}`;
    const saved = (await store.read()).cms_journal?.[key];
    let facts;
    if (!saved) {
      facts = await sameInspectionContext(client, instruction, connection, policy, assertOperation) ? await native.inspectAttention({ config, store, client, connection, policy, mapping: instruction.mapping, work: instruction.work, source: instruction.source, assertOperation, now }) : observation("context_changed", now);
      if (!await sameInspectionContext(client, instruction, connection, policy, assertOperation)) facts = observation("context_changed", now);
      validateCms("AttentionObservation", facts);
    }
    const result = await mutate(store, client, key, "V4-34", () => ({ mutation_id: randomUUID(), context_sha256: instruction.context_sha256, observation: facts }), { inspection_id: instruction.inspection_id });
    validateCms("AttentionInspectionResult", result);
    requireMatch(result.inspection_id === instruction.inspection_id && result.context_sha256 === instruction.context_sha256, "Ghost attention report response changed identity");
    await store.update(async (state) => {
      const current = state.cms_attention.inspections[instruction.inspection_id]; requireMatch(equal(current.inspection, instruction), "Ghost attention report was replaced");
      current.completed = true; current.result = copy(result); current.observation = copy(state.cms_journal[key].body.observation);
    });
  }
  const prior = (await store.read()).cms_attention, recoveries = await client.attentionRecoveries({ after: prior.recovery_after });
  validatePage("AttentionRecoveryPage", recoveries, prior.recovery_after);
  await store.update(async (state) => {
    const current = state.cms_attention; requireMatch(current.recovery_after === prior.recovery_after, "Ghost recovery continuation changed");
    for (const entry of recoveries.items) {
      requireMatch(entry.mapping.connection_id === config.connectionId && entry.work.mapping_id === entry.mapping.mapping_id && entry.work.source_id === entry.mapping.source_id && entry.work.work_id !== entry.predecessor_work_id && entry.mode === "retry", "Ghost recovery changed native binding or mode");
      const saved = current.recoveries[entry.recovery_id]; requireMatch(!saved || equal(saved.recovery, entry), "Ghost recovery identity changed");
      current.recoveries[entry.recovery_id] ??= { recovery: copy(entry), state: "queued" };
      if (entry.source) {
        const sourceKey = hash(JSON.stringify([entry.source.source_id, entry.source.source_revision])), original = state.cms_feed.sources[sourceKey];
        requireMatch(!original || equal(original, entry.source), "Ghost recovery changed immutable source metadata"); state.cms_feed.sources[sourceKey] ??= copy(entry.source);
      }
    }
    current.recovery_after = recoveries.next_after;
  });
  return true;
}

// Exact successor only; the caller uses V4-36, never widens normal Claim.
export function selectCmsRecovery(state, excluded = new Set()) {
  if (!state.cms_attention?.supported) return null;
  return Object.values(state.cms_attention.recoveries).find((entry) => entry.state === "queued" && !excluded.has(entry.recovery.recovery_id)) ?? null;
}

export async function reinspectCmsRecovery({ config, store, client, native, connection, policy, recovery, mapping, work, authority, assertOperation, now = () => Date.now() }) {
  requireMatch(work.work_id === recovery.work.work_id && work.attempt_cycle === recovery.work.attempt_cycle && work.mapping_id === recovery.mapping.mapping_id && work.source_id === recovery.work.source_id && work.source_revision === recovery.work.source_revision && work.policy_revision === recovery.work.policy_revision && work.action === recovery.work.action && mapping.mapping_id === recovery.mapping.mapping_id && mapping.resource_id === recovery.mapping.resource_id && mapping.canonical_url === recovery.mapping.canonical_url && mapping.external_id === recovery.mapping.external_id, "Ghost recovery lease changed the selected successor");
  const state = await store.read(), local = state.publications[mapping.resource_id], inspected = state.cms_attention.inspections[recovery.inspection_id];
  requireMatch(inspected?.completed && inspected.result.status === "ready" && inspected.inspection.context_sha256 === recovery.context_sha256 && inspected.inspection.work.work_id === recovery.predecessor_work_id && inspected.inspection.work.attempt_cycle === recovery.predecessor_attempt_cycle && [recovery.predecessor_work_id, work.work_id].includes(local?.cms?.work_id), "Ghost recovery has no exact retained native inspection/predecessor");
  const handed = local.cms.recovery_handoff;
  if (handed?.recovery_id === recovery.recovery_id && handed.work_id === work.work_id && handed.context_sha256 === recovery.context_sha256 && handed.lease_generation === authority.lease_generation && local.cms.work_id === work.work_id && local.cms.last_lease_generation === authority.lease_generation) {
    // The initial new-lease readback already succeeded before any write.
    // Continuation now uses this successor's exact ordinary mutation/native
    // journal; comparing it to the old baseline would reject its own write.
    await assertOperation(); return;
  }
  await store.update(async (current) => {
    const item = current.publications[mapping.resource_id];
    requireMatch(equal(item, local) && (item.cms.work_id === work.work_id ? authority.lease_generation === item.cms.last_lease_generation : authority.lease_generation > item.cms.last_lease_generation), "Ghost recovery native handoff lost its fence");
    if (item.cms.work_id !== work.work_id) {
      const prior = copy(item.cms); delete prior.recovery_history;
      item.cms.recovery_history ??= []; item.cms.recovery_history.push({ recovery_id: recovery.recovery_id, predecessor_work_id: recovery.predecessor_work_id, context_sha256: recovery.context_sha256, publication_state: item.state, prior, observation: copy(inspected.observation) });
      delete item.cms.local_native_limitation; delete item.cms.resume_claim_key;
    }
    item.cms.recovery_id = recovery.recovery_id;
    item.cms.work_id = work.work_id; item.cms.last_lease_generation = authority.lease_generation; item.cms.mapping_revision = mapping.mapping_revision; item.state = "pending";
    // Old ownership/intent/last_verified/native result remain for fresh-lease
    // native reconciliation; no old ACK or token becomes successor success.
  });
  await assertOperation();
  const facts = await native.inspectAttention({ config, store, client, connection, policy, mapping, work: inspected.inspection.work, source: recovery.source, assertOperation, now });
  validateCms("AttentionObservation", facts);
  requireMatch(["baseline", "never_applied", "candidate_applied"].includes(facts.native_state) && facts.issue === "none" && !["uncertain", "active"].includes(facts.native_command) && facts.pending_mutation !== "uncertain", "Ghost recovery native state changed after Check");
  requireMatch(recovery.native_baseline ? equal(facts.native_result, recovery.native_baseline) : facts.native_state === "never_applied" && facts.native_result === null, "Ghost recovery native baseline changed after Check");
  await store.update(async (current) => {
    const item = current.publications[mapping.resource_id]; requireMatch(item.cms.work_id === work.work_id && item.cms.last_lease_generation === authority.lease_generation, "Ghost recovery initial readback lost its fence");
    item.cms.recovery_handoff = { recovery_id: recovery.recovery_id, work_id: work.work_id, context_sha256: recovery.context_sha256, lease_generation: authority.lease_generation };
  });
}
