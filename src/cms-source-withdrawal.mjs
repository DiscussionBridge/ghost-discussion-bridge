import { randomUUID } from "node:crypto";
import { validateCms } from "../lib/cms-runtime.mjs";
import { nativeTopicUrl } from "./topic-identity.mjs";
import { MAX_STATE_BYTES } from "./state-file.mjs";

const check = (condition, reason) => { if (!condition) throw new Error(reason); };

// Facts come from the existing protected native Admin integration. No native
// write, HTML admission rule, public-absence proof or forum privacy claim.
export async function observeGhostSourceLifecycle(config, ghost, nativeId, prior) {
  check(/^[a-f0-9]{24}$/u.test(nativeId ?? ""), "Ghost source lifecycle native identity is invalid");
  let current;
  try { current = await ghost.getSource(nativeId, MAX_STATE_BYTES); }
  catch (error) {
    if (error.status !== 404) throw error;
    const scope = prior?.cms_source?.native_source_scope;
    check(prior?.cms_source?.accepted_revision && scope?.native_id === nativeId && scope.native_type === "post" && scope.ghost_origin === config.ghostOrigin && scope.admin_origin === (config.ghostAdminOrigin ?? config.ghostOrigin), "Ghost missing source lacks its previously accepted native reader scope; deletion requires reconciliation");
    try {
      const page = await ghost.get(nativeId, config.webhookMaximumBytes, "page");
      check(page?.id === nativeId && page.type === "page", "Ghost changed source type has ambiguous native identity");
      return { reason: "source_ineligible", facts: { native_id: nativeId, native_type: "page", observation: "existing_native_type_changed" } };
    } catch (pageError) {
      if (pageError.status !== 404) throw pageError;
      return { reason: "source_deleted", facts: { native_id: nativeId, native_type: "post", observation: "accepted_native_admin_post_and_page_absent", native_reader_scope: { ...scope } } };
    }
  }
  check(current?.id === nativeId && current.type === "post", "Ghost current lifecycle native source identity differs");
  if (["draft", "scheduled"].includes(current.status)) return { reason: "source_unpublished", facts: { native_id: nativeId, native_type: "post", status: current.status, observation: "current_native_admin_status" } };
  check(current.status === "published", "Ghost native lifecycle status is unavailable or unsupported");
  check(Array.isArray(current.tags) && current.tags.every((tag) => tag && typeof tag === "object" && (typeof tag.name === "string" || typeof tag.slug === "string")), "Ghost current native source opt-in metadata is unavailable");
  const optedIn = current.tags.some((tag) => tag.name === "#discussionbridge" || tag.slug === "hash-discussionbridge");
  const imported = current.tags.some((tag) => tag.name === "#discussionbridge-source" || tag.slug === "hash-discussionbridge-source");
  if (!optedIn || imported) return { reason: "source_ineligible", facts: { native_id: nativeId, native_type: "post", opted_in: optedIn, imported_source: imported, observation: "current_native_admin_tags" } };
  return { current };
}

function sameBinding(record, prior, key, config) {
  validateCms("Record", record);
  check(record.resource_id === prior.resource_id && record.direction === "to_discourse" && record.external_id === key && record.topic_id === String(prior.topic_id) && record.canonical_url === prior.canonical_url && record.source_revision === prior.cms_source.accepted_revision, "Ghost withdrawal receiver binding/revision differs; reconciliation is required");
  check(new URL(record.canonical_url).origin === config.ghostOrigin, "Ghost withdrawal source origin differs");
  nativeTopicUrl(record.topic_url, config.serverUrl, record.topic_id);
}

export async function withdrawCmsSource(record, config, store, client, { assertWriter = async () => {}, closedNativeObservation } = {}) {
  const nativeId = record.native_id, key = `ghost-post:${nativeId}`, operationId = randomUUID();
  let claimed = false;
  try {
    check(/^[a-f0-9]{24}$/u.test(nativeId ?? ""), "Ghost withdrawal native source identity is invalid");
    await assertWriter();
    const prior = (await store.read()).posts[key], cms = prior?.cms_source;
    check(prior?.source_protocol === "v4" && prior.resource_id && prior.topic_id && cms?.accepted_revision, "Ghost withdrawal requires an accepted owned binding; unbound sources cannot be attached by withdrawal");
    check(!cms.source_url_move?.intent, "Ghost source mutation is unresolved; withdrawal requires reconciliation");
    let job = cms.withdrawal;
    // Only an actual closed-native observation can stop delivery of the known
    // accepted A while an uncertain B stays captured and UNREPLAYED. A scoped
    // current Record(A) below plus receiver CAS decides whether A can close;
    // Record(B) is never treated as an exact receipt for pending resolve(B).
    const closingPending = Boolean(cms.intent);
    if (closingPending) {
      const retained = job?.closed_pending_publish;
      check(retained ? retained.expected_source_revision === cms.accepted_revision && JSON.stringify(retained.intent) === JSON.stringify(cms.intent) : closedNativeObservation && ["source_deleted", "source_unpublished", "source_ineligible"].includes(closedNativeObservation.reason) && JSON.stringify(closedNativeObservation) === JSON.stringify(record.withdrawal), "Ghost source mutation is unresolved; withdrawal requires reconciliation");
    }
    if (!job) {
      const reason = record.withdrawal?.reason, facts = record.withdrawal?.facts;
      validateCms("RevocationReason", reason);
      const genuine = facts?.native_id === nativeId && (
        reason === "policy_excluded" && facts.observation === "protected_native_operator_stop_delivery" && facts.actor === "discussionbridge" ||
        reason === "source_unpublished" && facts.observation === "current_native_admin_status" && facts.native_type === "post" && ["draft", "scheduled"].includes(facts.status) ||
        reason === "source_ineligible" && (facts.observation === "current_native_admin_tags" && facts.native_type === "post" && (facts.opted_in === false || facts.imported_source === true) || facts.observation === "existing_native_type_changed" && facts.native_type === "page") ||
        reason === "source_deleted" && facts.observation === "accepted_native_admin_post_and_page_absent" && facts.native_reader_scope?.native_id === nativeId && facts.native_reader_scope.ghost_origin === config.ghostOrigin && facts.native_reader_scope.admin_origin === (config.ghostAdminOrigin ?? config.ghostOrigin)
      );
      check(genuine, "Ghost withdrawal requires genuine current native facts or protected single-source operator intent");
      const body = { mutation_id: randomUUID(), expected_source_revision: cms.accepted_revision, reason };
      client.prepareMutation("V4-05", body, { resource_id: prior.resource_id });
      job = { state: "pending", request_state: "prepared", body, resource_id: prior.resource_id, native_facts: structuredClone(facts), requested_at: new Date().toISOString() };
      if (closingPending) job.closed_pending_publish = { state: "native_closed_reconciliation", expected_source_revision: cms.accepted_revision, intent: structuredClone(cms.intent), native_source_scope: structuredClone(cms.native_source_scope ?? null) };
      await store.update(async (state) => {
        check(state.posts[key]?.cms_source?.accepted_revision === cms.accepted_revision && !state.posts[key].cms_source.withdrawal && JSON.stringify(state.posts[key].cms_source.intent) === JSON.stringify(cms.intent), "Ghost withdrawal source writer binding changed");
        state.posts[key] = { ...state.posts[key], operation_id: operationId, outcome: "withdrawal_pending", cms_source: { ...state.posts[key].cms_source, withdrawal: job } };
      });
    } else await store.update(async (state) => { check(state.posts[key]?.cms_source?.withdrawal?.body.mutation_id === job.body.mutation_id, "Ghost withdrawal intent ownership changed"); state.posts[key].operation_id = operationId; });
    claimed = true;
    check(job.resource_id === prior.resource_id && job.body.expected_source_revision === cms.accepted_revision, "Ghost retained withdrawal differs from accepted binding");
    // Current scoped To authority is required even for accepted mutation replay.
    // Policy.enabled controls From selection, not To binding withdrawal.
    const connection = await client.connection(); validateCms("Connection", connection);
    check(connection.connection_id === config.connectionId && connection.profile === "ghost" && new URL(connection.destination_origin).origin === config.ghostOrigin && connection.directions.includes("to_discourse") && (!config.lane || connection.publication_lane === config.lane), "Ghost withdrawal current receiver authority is unavailable");
    const current = await client.sourceRecord(prior.resource_id); sameBinding(current, prior, key, config);
    if (job.closed_pending_publish) await store.update(async (state) => {
      const pending = state.posts[key];
      check(pending?.operation_id === operationId && JSON.stringify(pending.cms_source.intent) === JSON.stringify(job.closed_pending_publish.intent), "Ghost closed-native pending capture changed");
      pending.cms_source.withdrawal.closed_pending_publish.state = "accepted_binding_observed";
      pending.cms_source.withdrawal.closed_pending_publish.current_record = structuredClone(current);
    });
    let receipt, recovered = false, mutationResponse;
    if (current.state === "withdrawn") { receipt = current; recovered = job.request_state === "uncertain" && !job.receipt; }
    else {
      check(!job.receipt, "Ghost historical withdrawal receipt differs from current binding state; reconciliation is required");
      check(current.state === "active", "Ghost withdrawal current source binding is unavailable");
      await assertWriter();
      await store.update(async (state) => { check(state.posts[key]?.operation_id === operationId, "Ghost withdrawal writer ownership changed"); state.posts[key].cms_source.withdrawal.request_state = "uncertain"; });
      receipt = await client.withdrawSource(job.resource_id, job.body); sameBinding(receipt, prior, key, config);
      check(receipt.state === "withdrawn", "Ghost withdrawal was not accepted as withdrawn");
      mutationResponse = structuredClone(receipt);
    }
    await assertWriter();
    await store.update(async (state) => {
      const pending = state.posts[key];
      check(pending?.operation_id === operationId && pending.cms_source?.withdrawal?.body.mutation_id === job.body.mutation_id, "Ghost withdrawal writer ownership changed");
      pending.outcome = "withdrawn"; pending.topic_url = receipt.topic_url; pending.failure_reason = undefined;
      pending.cms_source.withdrawal = { ...pending.cms_source.withdrawal, state: "withdrawn", original_response: job.original_response ?? mutationResponse ?? null, receipt: structuredClone(receipt), receipt_origin: recovered ? "current_record_recovery" : current.state === "withdrawn" ? job.receipt_origin ?? "current_record_observation" : "exact_mutation_response" };
    });
    return receipt;
  } catch (error) {
    await store.update(async (state) => {
      const pending = state.posts[key];
      if (!pending || claimed && pending.operation_id !== operationId) return;
      pending.outcome = "attention"; pending.failure_reason = error.message.startsWith("Ghost ") ? error.message : "Ghost binding withdrawal failed; exact intent and discussion identity are retained";
      if (pending.cms_source?.withdrawal) pending.cms_source.withdrawal.state = "attention";
    });
    throw error;
  }
}
