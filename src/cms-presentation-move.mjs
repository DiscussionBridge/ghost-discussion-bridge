import { randomUUID } from "node:crypto";
import { validateCms } from "../lib/cms-runtime.mjs";
import { cmsMutation } from "./cms-coordinator.mjs";

const check = (condition, detail) => { if (!condition) throw new Error(detail); };
const ownership = (receipt, fingerprint) => ({ resource_id: receipt.resource_id, external_id: receipt.external_id, native_id: receipt.native_id, canonical_url: receipt.canonical_url, source_revision: receipt.source_revision, ownership_receipt_sha256: fingerprint });

// Called only before SyncAck for receiver-leased publish_revision work. Local
// operator intent never creates a work action, lease or native object.
export async function performGhostPresentationMove(context, native) {
  const { config, store, client, mapping, work, authority, source, assertAuthority } = context;
  let request = (await store.read()).publications[mapping.resource_id].cms.url_move_request;
  check(request && !["aborted", "committed"].includes(request.state) && work.action === "publish_revision" && mapping.destination_native_id, "Ghost move requires pending intent and an existing native-bound publish work");
  const base = { ...mapping, canonical_url: request.old_url, mapping_revision: request.expected_mapping_revision };
  const key = `${request.request_id}:${authority.lease_generation}`;
  const finalized = (await store.read()).cms_journal?.[`url-finalize:${key}`];
  check(mapping.canonical_url === request.old_url && mapping.mapping_revision === request.expected_mapping_revision || finalized && mapping.canonical_url === request.new_url, "Ghost URL move expected mapping revision/binding changed");
  check(!request.native_intent || request.native_intent.source_revision === work.source_revision, "Ghost in-flight URL move desired revision changed");
  check(!["applied", "unknown"].includes(request.native_outcome) || request.old_native?.receipt.last_lease_generation === authority.lease_generation, "Ghost applied/unknown URL move under replacement lease requires attention with both reservations");
  if (!request.old_native) {
    const old = await native.inspectMove({ ...context, mapping: base });
    await store.update(async (state) => { state.publications[mapping.resource_id].cms.url_move_request.old_native = old; });
    request = (await store.read()).publications[mapping.resource_id].cms.url_move_request;
  }
  const prepared = await cmsMutation(store, client, `url-prepare:${key}`, "V4-21", () => ({ mutation_id: randomUUID(), authority, expected_mapping_revision: request.expected_mapping_revision, old_url: request.old_url, new_url: request.new_url, ownership: ownership(request.old_native.receipt, request.old_native.receipt_sha256) }), { mapping_id: mapping.mapping_id });
  validateCms("UrlMove", prepared);
  check(prepared.mapping_id === mapping.mapping_id && prepared.expected_mapping_revision === request.expected_mapping_revision && prepared.old_url === request.old_url && prepared.new_url === request.new_url && ["prepared", "committed"].includes(prepared.state), "Ghost receiver prepared a different URL move");
  check(!request.move || request.move.move_id === prepared.move_id && request.move.proof_nonce === prepared.proof_nonce, "Ghost current authority changed issued move identity/nonce");
  await store.update(async (state) => { const current = state.publications[mapping.resource_id].cms.url_move_request; current.move = prepared; current.state = "prepared"; });
  let result;
  try {
    await assertAuthority();
    result = await native.move({ ...context, mapping: base }, prepared);
    const verification = await native.verify({ ...context, mapping: { ...mapping, canonical_url: request.new_url }, result });
    validateCms("PublishedVerification", verification);
    await store.update(async (state) => { state.publications[mapping.resource_id].cms.url_move_request.move_verification = verification; });
  } catch (error) {
    if (!error.requestOutcomeUncertain && !error.cmsMutationUncertain && await native.proveNoMove({ ...context, mapping: base })) {
      const aborted = await cmsMutation(store, client, `url-abort:${key}`, "V4-23", () => ({ mutation_id: randomUUID(), authority, move_id: prepared.move_id, native_change_applied: false, ownership: ownership(request.old_native.receipt, request.old_native.receipt_sha256) }), { mapping_id: mapping.mapping_id, move_id: prepared.move_id });
      check(aborted.state === "aborted" && aborted.move_id === prepared.move_id && aborted.old_url === request.old_url && aborted.new_url === request.new_url, "Ghost receiver abort did not release the exact unapplied move");
      await store.update(async (state) => { state.publications[mapping.resource_id].cms.url_move_request.state = "aborted"; });
      context.changed(false);
    } else await store.update(async (state) => { state.publications[mapping.resource_id].cms.url_move_request.state = "attention"; });
    throw error;
  }
  request = (await store.read()).publications[mapping.resource_id].cms.url_move_request;
  await assertAuthority();
  const final = await cmsMutation(store, client, `url-finalize:${key}`, "V4-22", () => ({ mutation_id: randomUUID(), authority, move_id: prepared.move_id, proof_nonce: prepared.proof_nonce, ownership: ownership(request.native_receipt, request.native_receipt_sha256), verification: request.move_verification }), { mapping_id: mapping.mapping_id, move_id: prepared.move_id });
  validateCms("Mapping", final);
  check(final.mapping_id === mapping.mapping_id && final.resource_id === mapping.resource_id && final.external_id === mapping.external_id && final.source_id === mapping.source_id && final.connection_id === config.connectionId && final.destination_native_id === result.nativeResult.native_id && final.canonical_url === request.new_url && final.mapping_revision !== request.expected_mapping_revision && final.desired_source_revision === work.source_revision && final.presentation_mode === mapping.presentation_mode, "Ghost finalized mapping changed identity/current desired publication");
  await assertAuthority();
  await store.update(async (state) => {
    const item = state.publications[mapping.resource_id], current = item.cms.url_move_request;
    check(item.cms.work_id === work.work_id && item.cms.last_lease_generation === authority.lease_generation && current.request_id === request.request_id, "Ghost finalized native move was fenced");
    item.canonical_url = final.canonical_url;
    Object.assign(item.cms, { mapping_revision: final.mapping_revision, ownership_receipt: current.native_receipt, ownership_receipt_sha256: current.native_receipt_sha256, native_revision: current.native_revision, native_fragment_sha256: current.native_fragment_sha256, native_title: current.native_title, representation: result.nativeResult.representation });
    item.native_content_bytes = current.native_content_bytes; item.revision = source.source_revision; item.source_created_at = source.source_created_at; item.source_updated_at = source.source_updated_at; item.source_status = "active";
    item.cms.url_history ??= [];
    if (!item.cms.url_history.some((entry) => entry.move_id === prepared.move_id)) item.cms.url_history.push({ url: request.old_url, move_id: prepared.move_id, observed_committed_at: new Date().toISOString() });
    current.state = "committed";
  });
  return { result, mapping: final };
}
