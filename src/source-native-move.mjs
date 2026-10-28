import { randomUUID } from "node:crypto";
import { projectGeneratedReadMoreMove, validateCms } from "../lib/cms-runtime.mjs";
import { nativeEdition, instant, currentSourceInput, currentSourceReceipt, currentSourceArtifacts } from "./cms-source-publication.mjs";
import { publishedGhostSource } from "./ghost-source.mjs";
import { anchorCopiedArticleReferences } from "./article-references.mjs";
import { SOURCE_NATIVE_PROFILE, sourceNativeIntegration, sourceMoveSlug, captureSourceNative, sameOriginalSource, sourceChallenge, sourceHead, observeSourcePublic, sourceOwnershipReceipt, sourceSha, sourceExact, sortedTree } from "./source-native-proof.mjs";

const check = (value, detail) => { if (!value) throw new Error(`Ghost source move ${detail}`); };
const copy = (value) => structuredClone(value);
const projection = (input, address, revision, updated) => input.representation.kind === "generated_excerpt" ? projectGeneratedReadMoreMove(input, address, revision, updated) : { ...copy(input), canonical_url: address, expected_source_revision: input.source_revision, source_revision: revision, source_updated_at: updated };

// Called ONLY by the existing source-move entrypoint under the shared native
// lock, after exact current scope/binding checks and durable V4-28 receipt.
export async function executeGhostSourceMove(config, store, client, ghost, key, assertWriter, { publicFetch = fetch, now = () => Date.now() } = {}) {
  let local = (await store.read()).posts[key], job = local.cms_source.source_url_move;
  const update = async (callback) => {
    await assertWriter();
    await store.update(async (state) => {
      const item = state.posts[key];
      check(item?.cms_source?.source_url_move?.intent.body.mutation_id === job.intent.body.mutation_id, "journal ownership changed");
      await callback(item.cms_source.source_url_move, item, state);
    });
    local = (await store.read()).posts[key]; job = local.cms_source.source_url_move;
  };
  const budget = Math.max(config.webhookMaximumBytes ?? 0, (local.cms_source.accepted_native_baseline?.native_content_bytes ?? 0) * 6 + 1024 * 1024);
  const read = async () => { await assertWriter(); const post = await ghost.getSource(job.native_id, budget); await assertWriter(); return { post, snapshot: captureSourceNative(post, config) }; };
  const authority = async () => {
    await assertWriter(); const connection = await client.connection(); validateCms("Connection", connection);
    check(connection.connection_id === config.connectionId && connection.profile === "ghost" && connection.destination_origin === config.ghostOrigin && connection.directions.includes("to_discourse") && connection.policy.enabled && (!config.lane || connection.publication_lane === config.lane), "current scope/policy differs");
    const record = await client.sourceRecord(job.resource_id); validateCms("Record", record);
    const expected = job.finalize_intent?.body.new_source_revision;
    check(record.resource_id === job.resource_id && record.external_id === key && record.direction === "to_discourse" && record.state === "active" && record.topic_id === String(local.topic_id) && (record.source_revision === job.intent.body.expected_source_revision && record.canonical_url === job.intent.body.old_url || expected && record.source_revision === expected && record.canonical_url === job.intent.body.new_url), "current receiver ancestry differs");
    await assertWriter(); return record;
  };
  const receipt = (phase, snapshot, observation, integration) => sourceOwnershipReceipt({
    phase, profile: SOURCE_NATIVE_PROFILE, public_origin: config.ghostOrigin, admin_origin: config.ghostAdminOrigin ?? config.ghostOrigin,
    native_id: snapshot.native_id, native_type: snapshot.native_type, native_uuid: snapshot.uuid,
    connection_id: config.connectionId, resource_id: job.resource_id, external_id: key, topic_id: String(local.topic_id),
    old_source_revision: job.intent.body.expected_source_revision, new_source_revision: job.new_source_revision,
    observed_source_revision: phase === "before" ? job.intent.body.expected_source_revision : job.new_source_revision,
    move_id: job.prepare_response.move_id, proof_nonce: job.prepare_response.proof_nonce,
    old_url: job.intent.body.old_url, new_url: job.intent.body.new_url, observed_url: snapshot.url, native_revision: snapshot.updated_at,
    native_html_sha256: sourceSha(snapshot.html), native_html_bytes: Buffer.byteLength(snapshot.html), native_lexical_sha256: sourceSha(snapshot.lexical), native_lexical_bytes: Buffer.byteLength(snapshot.lexical),
    title: snapshot.title, authorship: snapshot.authorship, created_at: snapshot.created_at, published_at: snapshot.published_at,
    source_content_sha256: job.prior_input.bridge_record.source_content_sha256, source_content_bytes: job.prior_input.bridge_record.source_content_bytes,
    original_head_sha256: sourceSha(job.before?.codeinjection_head ?? snapshot.codeinjection_head ?? ""), original_foot_sha256: sourceSha(snapshot.codeinjection_foot ?? ""),
    native_publication_sha256: observation.sha256, integration_sha256: sourceSha(JSON.stringify(sortedTree(integration))),
  });
  const observe = (snapshot, address, challenge, integration) => observeSourcePublic(config, integration, snapshot, address, challenge, { publicFetch, assertWriter, now });
  const abortUnapplied = async (integration) => {
    const { snapshot } = await read();
    check(sourceExact(snapshot, job.before), "cannot prove exact unchanged old native object for abort");
    const observed = await observe(snapshot, job.intent.body.old_url, null, integration), ownership = receipt("before", snapshot, observed, integration);
    await authority();
    if (!job.abort_intent) await update((saved) => {
      saved.abort_intent = { body: { mutation_id: randomUUID(), move_id: saved.prepare_response.move_id, expected_source_revision: saved.intent.body.expected_source_revision, native_change_applied: false, old_url: saved.intent.body.old_url, native_ownership_receipt_sha256: ownership.sha256 }, request_state: "prepared" };
      saved.abort_ownership_receipt = ownership;
    });
    await update((saved) => { saved.abort_intent.request_state = "uncertain"; saved.state = "abort_uncertain"; });
    const result = await client.abortSourceUrlMove(job.resource_id, job.prepare_response.move_id, job.abort_intent.body); validateCms("SourceUrlMove", result);
    check(result.state === "aborted" && result.move_id === job.prepare_response.move_id && result.resource_id === job.resource_id && result.expected_source_revision === job.intent.body.expected_source_revision && result.proof_nonce === job.prepare_response.proof_nonce && result.old_url === job.intent.body.old_url && result.new_url === job.intent.body.new_url, "abort receipt differs");
    const completed = { ...copy(job), state: "aborted", abort_response: copy(result) };
    await update((_saved, item) => { item.cms_source.source_move_history = [...(item.cms_source.source_move_history ?? []), completed]; delete item.cms_source.source_url_move; });
    return completed;
  };
  try {
    const integration = sourceNativeIntegration(config);
    check(!job.finalize_rejection, "content_preservation_unavailable: exact rejected finalize is retained without automatic retry");
    await authority();
    if (job.abort_intent) return await abortUnapplied(integration);
    if (!job.native_intent) {
      const { post, snapshot } = await read();
      check(snapshot.url === job.intent.body.old_url, "already-moved native source has no saved old-object write ancestry");
      instant(snapshot.updated_at);
      const slug = sourceMoveSlug(integration, config.ghostOrigin, post, job.intent.body.new_url);
      check(anchorCopiedArticleReferences(snapshot.html, job.intent.body.old_url) === anchorCopiedArticleReferences(snapshot.html, job.intent.body.new_url), "native relative href/src targets would change with this permalink; same-body movement cannot preserve their original targets");
      check(typeof ghost.findBySlug === "function" && typeof ghost.updateSourcePermalink === "function", "supported same-post native permalink integration is unavailable");
      const collisions = await ghost.findBySlug(slug, budget, "post");
      check(!collisions.some((object) => object.id !== job.native_id || object.type !== "post"), "new native permalink collides with another post/page");
      const oldObservation = await observe(snapshot, snapshot.url, null, integration);
      const newRevision = `ghost-source:${randomUUID()}`, challenge = sourceChallenge({ native_id: job.native_id, resource_id: job.resource_id, external_id: key, move_id: job.prepare_response.move_id, proof_nonce: job.prepare_response.proof_nonce, source_revision: newRevision, url: job.intent.body.new_url });
      const head = sourceHead(snapshot.codeinjection_head, challenge, local.cms_source.current_source_move?.challenge.block ?? null);
      const projected = projection(job.prior_input.bridge_record, job.intent.body.new_url, newRevision, instant(snapshot.updated_at));
      validateCms("ToResolve", { mutation_id: job.intent.body.mutation_id, bridge_record: projected });
      check(Buffer.byteLength(JSON.stringify({ mutation_id: job.intent.body.mutation_id, bridge_record: projected })) <= 65536, "new URL cannot fit without changing accepted article");
      await update((saved) => {
        saved.integration = copy(integration); saved.before = snapshot; saved.before_public_observation = oldObservation;
        saved.new_source_revision = newRevision; saved.challenge = challenge;
        saved.native_intent = { payload: { slug, codeinjection_head: head, updated_at: snapshot.updated_at }, dispatched: false };
        saved.state = "native_planned";
      });
    }
    check(sourceExact(integration, job.integration), "configured native integration changed while move is pending");
    let actual = await read();
    if (!job.native_intent.dispatched) {
      check(sourceExact(actual.snapshot, job.before), "native source changed before permalink write");
      const occupied = await ghost.findBySlug(job.native_intent.payload.slug, budget, "post");
      check(!occupied.some((object) => object.id !== job.native_id || object.type !== "post"), "new native permalink became occupied");
      await authority();
      await update((saved) => { saved.native_intent.dispatched = true; saved.state = "native_uncertain"; });
      try {
        const result = await ghost.updateSourcePermalink(job.native_id, job.native_intent.payload, budget);
        check(result.id === job.native_id && result.type === "post", "native update returned a different identity");
        await update((saved) => { saved.native_response_received = true; });
      } catch (error) {
        if ([400, 401, 403, 409, 422].includes(error.status)) {
          await update((saved) => { saved.native_rejected_status = error.status; });
          return await abortUnapplied(integration);
        }
        throw error;
      }
      actual = await read();
    }
    // A timed-out native write is LOOKUP ONLY. Old state cannot establish that
    // an unknown request is no longer in flight, so neither repeat nor abort.
    check(actual.snapshot.url === job.intent.body.new_url && actual.snapshot.slug === job.native_intent.payload.slug, "applied native URL is unproven; reservations remain held");
    sameOriginalSource(job.before, actual.snapshot, job.native_intent.payload.codeinjection_head);
    instant(actual.snapshot.updated_at);
    if (job.after) check(sourceExact(actual.snapshot, job.after), "native edition changed after original move readback");
    else await update((saved) => { saved.after = actual.snapshot; saved.state = "native_applied"; });
    await authority();
    const observed = await observe(job.before, job.intent.body.new_url, job.challenge, integration);
    const again = await read(); check(sourceExact(again.snapshot, job.after), "native edition changed around public proof");
    const ownership = receipt("after", job.after, observed, integration);
    if (!job.finalize_intent) {
      const verification = { url: job.intent.body.new_url, external_id: key, source_revision: job.new_source_revision, source_content_sha256: job.prior_input.bridge_record.source_content_sha256, native_ownership_receipt_sha256: ownership.sha256, native_publication_sha256: observed.sha256, verification_profile: SOURCE_NATIVE_PROFILE, checked_at: observed.checked_at };
      const body = { mutation_id: randomUUID(), move_id: job.prepare_response.move_id, proof_nonce: job.prepare_response.proof_nonce, expected_source_revision: job.intent.body.expected_source_revision, verification, new_source_revision: job.new_source_revision, source_updated_at: instant(job.after.updated_at) };
      client.prepareMutation("V4-29", body, { resource_id: job.resource_id, move_id: job.prepare_response.move_id });
      await update((saved) => { saved.ownership_receipt = ownership; saved.public_observation = observed; saved.finalize_intent = { body, request_state: "prepared" }; saved.state = "proof_observed"; });
    } else check(job.finalize_intent.body.verification.native_publication_sha256 === observed.sha256 && job.finalize_intent.body.verification.native_ownership_receipt_sha256 === ownership.sha256, "retained finalize proof differs from actual current object");
    await authority();
    await update((saved) => { saved.finalize_intent.request_state = "uncertain"; saved.state = "finalize_uncertain"; });
    let result;
    try { result = await client.finalizeSourceUrlMove(job.resource_id, job.prepare_response.move_id, job.finalize_intent.body); }
    catch (error) {
      const rejected = client.rejectedResponse?.(error);
      if (rejected?.route_id === "V4-29" && rejected.status === 422 && rejected.envelope.code === "content_preservation_unavailable" && rejected.request_sha256 === sourceSha(JSON.stringify(job.finalize_intent.body))) await update((saved) => { saved.finalize_rejection = copy(rejected); saved.state = "known_rejected"; });
      throw error;
    }
    validateCms("Record", result);
    check(result.resource_id === job.resource_id && result.external_id === key && result.topic_id === String(local.topic_id) && result.direction === "to_discourse" && result.state === "active" && result.canonical_url === job.intent.body.new_url && result.source_revision === job.new_source_revision, "finalize receipt differs from exact source ancestry");
    const input = projection(job.prior_input.bridge_record, job.intent.body.new_url, job.new_source_revision, instant(job.after.updated_at));
    const rawEdition = nativeEdition(again.post, publishedGhostSource(again.post, config));
    const complete = { ...copy(job), state: "finalized", finalize_response: copy(result) };
    await update((_saved, item) => {
      const cs = item.cms_source;
      cs.accepted_history = [...(cs.accepted_history ?? []), { source_revision: cs.accepted_revision, input: copy(currentSourceInput(cs)), receipt: copy(currentSourceReceipt(cs)), source_capture: copy(cs.accepted_source_capture ?? null), native_baseline: copy(cs.accepted_native_baseline), artifact_binding: copy(currentSourceArtifacts(cs) ?? null) }];
      cs.source_move_history = [...(cs.source_move_history ?? []), complete];
      cs.current_source_input = { bridge_record: input, source_url_move: { move_id: job.prepare_response.move_id, mutation_id: job.finalize_intent.body.mutation_id } };
      cs.current_source_receipt = copy(result); cs.accepted_revision = result.source_revision;
      cs.current_source_artifacts = copy(job.artifact_binding);
      cs.accepted_raw_edition = rawEdition; cs.accepted_edition = sourceSha(JSON.stringify([rawEdition, input.source_content_sha256]));
      cs.current_source_move = { source_revision: result.source_revision, native_after: copy(job.after), raw_edition: rawEdition, challenge: copy(job.challenge), record: copy(result) };
      cs.url_history = { items: cs.url_history?.items ?? [], next_cursor: null, complete: false, seen_cursors: [] };
      delete cs.source_url_move;
      item.canonical_url = result.canonical_url; item.source_revision = result.source_revision; item.synchronized_at = result.synchronized_at; item.outcome = "resolved"; delete item.failure_reason;
    });
    return complete;
  } catch (error) {
    if (job) await update((saved) => { saved.state = saved.finalize_rejection ? "known_rejected" : saved.native_intent?.dispatched ? "attention_applied_or_unknown" : "native_verification_attention"; saved.failure_reason = error.message?.startsWith("Ghost ") ? error.message.slice(0, 300) : "Ghost source move requires exact native/public reconciliation; reservations remain held"; });
    throw error;
  }
}
