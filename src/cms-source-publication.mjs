import { createHash, randomUUID } from "node:crypto";
import { publishedGhostSource, nativeSourceBaseline } from "./ghost-source.mjs";
import { outboundArticle } from "./source-excerpt.mjs";
import { sourceArtifactIdentity } from "../lib/cms-vendor.mjs";
import { sourceTime } from "./source-time.mjs";
import { nativeTopicUrl } from "./topic-identity.mjs";
import { validateCms } from "../lib/cms-runtime.mjs";
import { PRODUCT_VERSION } from "./version.mjs";
import { anchorCopiedArticleReferences } from "./article-references.mjs";
import { captureSourceNative, sourceExact } from "./source-native-proof.mjs";
import { serializedState } from "./state-file.mjs";
import { matchesInvalidFieldRejection, sourceRejectionCode } from "./source-refusal.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const check = (condition, reason) => { if (!condition) throw new Error(reason); };
const preservationCode = "content_preservation_unavailable";

export function instant(value) {
  if (value === undefined || value === null) return null;
  const actual = sourceTime(value);
  check(actual !== null && actual % 1_000_000n === 0n, "Ghost source date cannot be represented exactly by the current CMS Instant");
  const normalized = new Date(Number(actual / 1_000_000n)).toISOString();
  validateCms("Instant", normalized);
  return normalized;
}

export function nativeEdition(current, source) {
  return hash(JSON.stringify([current.id, current.type, current.status, source.title, source.fullContentHtml, source.url.href, { source_authors: source.authorship.source_authors?.map(({ id, name }) => ({ id, name })), primary_source_author_id: source.authorship.primary_source_author_id }, current.created_at ?? null, current.updated_at ?? null]));
}

export const currentSourceInput = (source) => source.current_source_input ?? source.accepted_input;
export const currentSourceReceipt = (source) => source.current_source_receipt ?? source.accepted_receipt;
export const currentSourceArtifacts = (source) => source.current_source_artifacts ?? source.accepted_artifacts;

// Preparation is an internal dependency, never a browser/config attestation.
// No active To HTML policy is inferred from From/reply sanitizer presets.
async function representation(current, source, prepareSourceHtml) {
  if (typeof prepareSourceHtml !== "function") throw Object.assign(new Error("Ghost Bridge complete source HTML safety/nonblank preparation rule is unavailable; source remains valid and configuration attention is required"), { code: "native_source_html_unqualified" });
  let portable;
  try { portable = await prepareSourceHtml(source.capture.html, source.capture); }
  catch (cause) { throw new Error(`Ghost Bridge cannot prepare the complete native article: ${cause?.localSourcePreparationLimitation || cause?.message?.startsWith("Ghost Bridge cannot preserve prepared article references") ? cause.message : "the preparation dependency is unavailable"}; source remains intact`, { cause }); }
  check(typeof portable === "string" && Buffer.from(portable, "utf8").toString("utf8") === portable, "Ghost Bridge prepared article representation is unavailable or malformed UTF8; preparation attention is required");
  const full = anchorCopiedArticleReferences(portable, source.capture.article_url);
  const created = instant(current.created_at), updated = instant(current.updated_at);
  check(created === null || updated === null || sourceTime(updated) >= sourceTime(created), "Ghost source update precedes source creation");
  const authors = source.authorship.source_authors?.map(({ id, name }) => ({ id, name }));
  return { full, bytes: Buffer.byteLength(full), digest: hash(full), created, updated, authors,
    capture: { ...structuredClone(source.capture), prepared_html: full, native_content_bytes: Buffer.byteLength(source.capture.html), native_content_sha256: hash(source.capture.html), prepared_content_bytes: Buffer.byteLength(full), prepared_content_sha256: hash(full) } };
}

function requestBody(source, prepared, config, revision, predecessor, codec, mutationId = randomUUID()) {
  const body = {
    mutation_id: mutationId,
    bridge_record: {
      direction: "to_discourse", external_id: `ghost-post:${source.id}`, canonical_url: source.url.href,
      title: source.title, content_html: prepared.full,
      published: true, visibility: "unlisted", adapter_id: "ghost-discussion-bridge", adapter_version: PRODUCT_VERSION,
      source_revision: revision, expected_source_revision: predecessor,
      source_created_at: prepared.created, source_updated_at: prepared.updated,
      source_content_sha256: prepared.digest, source_content_bytes: prepared.bytes,
      representation: { kind: "full" },
      ...(prepared.authors ? { source_authors: prepared.authors, primary_source_author_id: source.authorship.primary_source_author_id } : {}),
      ...(config.lane ? { lane: config.lane } : {}),
    },
  };
  const fullSize = codec.measureToFullEnvelope(body.bridge_record, prepared.full);
  if (prepared.bytes > 49152 || fullSize > 65536) {
    let budget = 49152 - Buffer.byteLength(codec.generatedReadMore(source.url.href));
    for (;;) {
      const article = outboundArticle(prepared.full, budget);
      try {
        body.bridge_record = codec.createGeneratedExcerpt(body.bridge_record, prepared.full, article);
        if (Buffer.byteLength(JSON.stringify(body)) > 65536) { budget = Math.floor(budget * 0.85); continue; }
        break;
      } catch (error) {
        if (error.code !== "body_too_large") throw error;
        budget = Math.floor(budget * 0.85);
      }
    }
  }
  codec.validateCms("ToResolve", body);
  check(Buffer.byteLength(JSON.stringify(body)) <= 65536, "Ghost actual full source delivery envelope exceeds the transport bound");
  return body;
}

async function remoteSource(client, externalId, resourceId) {
  if (resourceId) {
    const record = await client.sourceRecord(resourceId);
    validateCms("Record", record);
    check(record.resource_id === resourceId && record.direction === "to_discourse" && record.external_id === externalId, "Ghost receiver source identity differs; reconciliation is required");
    return record;
  }
  let cursor, found;
  const seen = new Set(), identities = new Set();
  do {
    const page = await client.sourceRecords(cursor ? { cursor } : {});
    validateCms("RecordPage", page);
    for (const record of page.items) {
      check(!identities.has(record.resource_id), "Ghost receiver source inventory repeats an identity"); identities.add(record.resource_id);
      if (record.direction === "to_discourse" && record.external_id === externalId) { check(!found, "Ghost receiver source identity is ambiguous"); found = record; }
    }
    cursor = page.next_cursor;
    if (cursor) { check(!seen.has(cursor), "Ghost receiver source cursor repeats"); seen.add(cursor); }
  } while (cursor);
  return found;
}

function exactBinding(remote, prior, source) {
  check(remote?.state === "active" && remote.canonical_url === source.url.href, "Ghost receiver baseline is unavailable/withdrawn or its source URL differs; reconciliation is required");
  if (prior?.resource_id) check(prior.resource_id === remote.resource_id && String(prior.topic_id) === remote.topic_id, "Ghost receiver resource/topic differs; reconciliation is required");
}

async function saveReceipt(store, key, operationId, intent, result, config, prior, recovered = false) {
  check(result.source_revision === intent.body.bridge_record.source_revision, "Ghost accepted CMS source revision differs");
  if (prior?.resource_id) check(result.resource_id === prior.resource_id && String(prior.topic_id) === result.topic_id, "Ghost native resource/topic changed; reconciliation is required");
  const topicUrl = nativeTopicUrl(result.topic_url, config.serverUrl, result.topic_id);
  await store.update(async (state) => {
    const pending = state.posts[key];
    check(pending?.operation_id === operationId && pending.cms_source?.intent?.body.mutation_id === intent.body.mutation_id, "Ghost source intent ownership changed");
    state.posts[key] = { ...pending, source_protocol: "v4", resource_id: result.resource_id, topic_id: result.topic_id, topic_url: topicUrl,
      source_revision: result.source_revision, synchronized_at: result.synchronized_at, outcome: recovered ? "resolved" : result.outcome,
      pending_until: 0, failure_reason: undefined,
      cms_source: { ...pending.cms_source,
        native_source_scope: intent.native_source_scope,
        accepted_native_baseline: intent.native_baseline,
        accepted_history: [...(pending.cms_source.accepted_history ?? []), ...(pending.cms_source.accepted_revision && pending.cms_source.accepted_revision !== result.source_revision ? [{ source_revision: pending.cms_source.accepted_revision, artifact_binding: currentSourceArtifacts(pending.cms_source) ?? null, native_baseline: pending.cms_source.accepted_native_baseline ?? null, source_capture: pending.cms_source.accepted_source_capture ?? null, input: currentSourceInput(pending.cms_source) ?? null, receipt: currentSourceReceipt(pending.cms_source) }] : [])],
        accepted_source_capture: intent.source_capture,
        accepted_revision: result.source_revision, accepted_edition: intent.edition, accepted_raw_edition: intent.raw_edition, accepted_artifacts: intent.artifact_binding,
        accepted_input: structuredClone(intent.body), accepted_receipt: structuredClone(result), current_source_input: undefined, current_source_receipt: undefined, current_source_artifacts: undefined, recovered_from_metadata: recovered, intent: undefined } };
  });
}

export async function publishCmsSource(record, config, store, client, { loadCurrentSource, prepareSourceHtml, assertWriter = async () => {}, retryRefusedMutationId } = {}) {
  const nativeId = record.native_id;
  check(/^[a-f0-9]{24}$/u.test(nativeId ?? "") && typeof loadCurrentSource === "function", "Ghost current native source identity/reader is unavailable");
  const key = `ghost-post:${nativeId}`, operationId = randomUUID();
  let prior, intent, capturedSource, claimed = false;
  const retry = retryRefusedMutationId !== undefined;
  try {
    if (retry) validateCms("UUID", retryRefusedMutationId);
    await assertWriter();
    const current = await loadCurrentSource();
    check(current?.id === nativeId && current.type === "post", "Ghost current native source identity/type differs");
    const source = publishedGhostSource(current, config), rawEdition = nativeEdition(current, source);
    const verifyCurrentSource = async () => {
      const verifiedCurrent = await loadCurrentSource();
      const verifiedSource = publishedGhostSource(verifiedCurrent, config);
      check(verifiedCurrent?.id === nativeId && verifiedCurrent.type === "post" && nativeEdition(verifiedCurrent, verifiedSource) === rawEdition && sourceExact(verifiedSource.capture, source.capture), "Ghost native source or captured HTML/Lexical/context changed before dispatch; preserved intent requires reconciliation");
    };
    capturedSource = source.capture;
    prior = (await store.read()).posts[key];
    check(!prior?.cms_source?.withdrawal, "Ghost source binding withdrawal is pending/retained; automatic resolve/reactivation is forbidden");
    check(!prior?.cms_source?.source_url_move?.intent, "Ghost source URL mutation is unresolved; exact intent requires reconciliation");
    const savedIntent = prior?.cms_source?.intent;
    if (savedIntent?.rejection_outcome) {
      check(sourceRejectionCode(savedIntent.rejection_outcome, savedIntent, config), "Ghost saved source rejection differs from its exact intent; reconciliation is required");
    }
    if (retry) {
      check(!prior?.cms_source?.source_url_move, "Ghost source retry cannot release an unresolved source URL move");
      check(savedIntent?.body?.mutation_id === retryRefusedMutationId && matchesInvalidFieldRejection(savedIntent.rejection_outcome, savedIntent, config), "Ghost source retry no longer matches the current known refused intent; reconciliation is required");
    }
    const codec = client.codec;
    check(codec?.wireVersion === "v4", "Ghost sole current V4 source codec is unavailable");
    const connection = await client.connection(); validateCms("Connection", connection);
    check(connection.connection_id === config.connectionId && connection.profile === "ghost" && connection.destination_origin === config.ghostOrigin && connection.directions.includes("to_discourse") && (!config.lane || connection.publication_lane === config.lane), "Ghost current source connection authority is unavailable");
    const moved = prior?.cms_source?.current_source_move;
    if (!savedIntent && moved && prior.cms_source.accepted_revision === moved.source_revision && rawEdition === moved.raw_edition && sourceExact(captureSourceNative(current, config), moved.native_after)) {
      const actual = await remoteSource(client, key, prior.resource_id); exactBinding(actual, prior, source);
      check(actual.source_revision === moved.source_revision, "Ghost moved current source revision differs from receiver; reconciliation is required");
      return currentSourceReceipt(prior.cms_source);
    }
    const prepared = await representation(current, source, prepareSourceHtml);
    const edition = hash(JSON.stringify([rawEdition, prepared.digest]));
    check(!prior?.canonical_url || prior.canonical_url === source.url.href, "Ghost canonical source URL changed; source movement is not active");
    let remote = await remoteSource(client, key, prior?.resource_id);
    if (remote) exactBinding(remote, prior, source);
    intent = prior?.cms_source?.intent;
    let rejectedIntent, retryIntent;
    if (intent?.rejection_outcome) {
      const code = sourceRejectionCode(intent.rejection_outcome, intent, config);
      if (retry) {
        const scope = intent.native_source_scope;
        check(intent.edition === edition && intent.raw_edition === rawEdition && sourceExact(intent.source_capture, prepared.capture) && sourceExact(intent.native_baseline, nativeSourceBaseline(current, source)), "Ghost source retry requires its exact unchanged current prepared source; ordinary changed editions use normal publication");
        check(scope?.native_id === nativeId && scope.native_type === "post" && scope.ghost_origin === config.ghostOrigin && scope.admin_origin === (config.ghostAdminOrigin ?? config.ghostOrigin), "Ghost source retry native ownership/scope differs; reconciliation is required");
        check(intent.body.bridge_record.external_id === key && intent.body.bridge_record.canonical_url === source.url.href && (intent.body.bridge_record.lane ?? null) === (config.lane ?? null), "Ghost source retry request no longer matches current native identity/URL/lane");
        client.prepareMutation("V4-02", intent.body);
        retryIntent = structuredClone(intent);
      } else check(intent.edition !== edition, `Ghost ${code}: identical complete current snapshot retains its exact rejected request without automatic retransmission`);
      // Use the existing full ordinary edition, including truthful title,
      // authorship and actual source dates, as well as complete prepared bytes.
      // Candidate/UUID freshness does not affect this edition comparison.
      rejectedIntent = structuredClone(intent);
      intent = undefined;
    }
    if (intent) { check(intent.artifact_binding?.wire_version === "v4", "Ghost pending source intent has an unknown wire identity; reconciliation is required"); client.prepareMutation("V4-02", intent.body); }
    if (intent && intent.edition !== edition) {
      check(intent.raw_edition !== rawEdition, "Ghost Bridge preparation changed for an unchanged pending native edition; immutable request and capture require reconciliation");
      check(remote?.source_revision === intent.body.bridge_record.source_revision, "Ghost uncertain prior edition cannot be replayed after native change; reconciliation is required");
      await store.update(async (state) => { check(state.posts[key]?.cms_source?.intent?.body.mutation_id === intent.body.mutation_id, "Ghost source intent ownership changed"); state.posts[key].operation_id = operationId; });
      claimed = true;
      await saveReceipt(store, key, operationId, intent, remote, config, prior, true);
      prior = (await store.read()).posts[key]; intent = undefined;
    }
    if (!intent) {
      const accepted = prior?.cms_source?.accepted_revision ?? null;
      if (accepted) check(remote?.source_revision === accepted, "Ghost accepted V4 predecessor differs from receiver; reconciliation is required");
      else check(!remote && !prior?.resource_id, "Ghost current source binding has no accepted local receipt; reconciliation is required");
      if (retry) {
        check(retryIntent && retryIntent.body.bridge_record.expected_source_revision === accepted, "Ghost source retry predecessor differs from its exact refused request; reconciliation is required");
        // Validate current complete source/representation/configuration against
        // the refused request without creating either a request or source ID.
        const expected = requestBody(source, prepared, config, retryIntent.body.bridge_record.source_revision, accepted, codec, retryIntent.body.mutation_id);
        check(sourceExact(expected, retryIntent.body), "Ghost source retry's retained payload differs from current prepared evidence; reconciliation is required");
      }
      if (!retry && accepted && prior.cms_source.accepted_edition === edition) {
        return currentSourceReceipt(prior.cms_source);
      }
      // A genuinely changed complete prepared snapshot can be a new edition
      // without inventing native editor/date changes. Candidate labels alone
      // do not affect edition, and an exact accepted edition returned above.
      if (retry) {
        await assertWriter();
        await verifyCurrentSource();
        const body = structuredClone(retryIntent.body);
        body.mutation_id = randomUUID();
        intent = { ...retryIntent, body, artifact_binding: { ...sourceArtifactIdentity }, request_state: "prepared",
          retry_of_mutation_id: retryRefusedMutationId, operator_action: { action: "retry_source", refused_mutation_id: retryRefusedMutationId, recorded_at: new Date().toISOString(), control: "existing_protected_operator_route" } };
        delete intent.rejection_outcome;
      } else {
        const body = requestBody(source, prepared, config, `ghost-source:${randomUUID()}`, accepted, codec);
        intent = { body, edition, raw_edition: rawEdition, native_baseline: nativeSourceBaseline(current, source), source_capture: prepared.capture, native_source_scope: { native_id: nativeId, native_type: "post", ghost_origin: config.ghostOrigin, admin_origin: config.ghostAdminOrigin ?? config.ghostOrigin }, artifact_binding: { ...sourceArtifactIdentity }, native_authorship: structuredClone(source.authorship), request_state: "prepared" };
      }
      client.prepareMutation("V4-02", intent.body);
      await store.update(async (state) => {
        const existing = state.posts[key]?.cms_source?.intent;
        check(rejectedIntent ? JSON.stringify(existing) === JSON.stringify(rejectedIntent) : existing === undefined, "Ghost source publication is already pending or its rejected evidence changed");
        state.posts[key] = { ...prior, canonical_url: source.url.href, operation_id: operationId, outcome: "pending", pending_until: 0,
          cms_source: { ...prior?.cms_source, ...(rejectedIntent ? { rejected_history: [...(prior.cms_source.rejected_history ?? []), rejectedIntent] } : {}),
            ...(retry ? { retry_history: [...(prior.cms_source.retry_history ?? []), { refused_mutation_id: retryRefusedMutationId, mutation_id: intent.body.mutation_id, source_revision: intent.body.bridge_record.source_revision, operator_action: structuredClone(intent.operator_action), artifact_binding: structuredClone(intent.artifact_binding) }] } : {}), intent } };
        try { serializedState(state); }
        catch (cause) { throw new Error("Ghost Bridge cannot retain the complete original HTML/Lexical, prepared article and immutable state within the existing protected state budget; no source request was dispatched", { cause }); }
      });
      claimed = true;
    } else {
      check(intent.body.bridge_record.canonical_url === source.url.href, "Ghost saved source URL intent differs");
      await store.update(async (state) => { check(state.posts[key]?.cms_source?.intent?.body.mutation_id === intent.body.mutation_id, "Ghost source intent ownership changed"); state.posts[key].operation_id = operationId; });
      claimed = true;
    }
    await assertWriter();
    if (!retry) await verifyCurrentSource();
    await store.update(async (state) => { check(state.posts[key]?.operation_id === operationId, "Ghost source writer ownership changed"); state.posts[key].cms_source.intent.request_state = "uncertain"; });
    await assertWriter();
    const result = await client.resolveSource(intent.body);
    validateCms("ResolveResult", result);
    check(["created", "resolved", "updated"].includes(result.outcome) && result.core_fallback === false, "Ghost receiver source requires reconciliation");
    await assertWriter();
    await saveReceipt(store, key, operationId, intent, result, config, remote ? { ...prior, resource_id: remote.resource_id, topic_id: remote.topic_id } : prior);
    return result;
  } catch (error) {
    // A stale/denied operator action must not downgrade a later accepted row or
    // replace its newer intent merely to record the obsolete form's failure.
    if (retry && !claimed) throw error;
    const rejection = typeof client.rejectedResponse === "function" ? client.rejectedResponse(error) : undefined;
    const definitive = claimed && intent && sourceRejectionCode(rejection, intent, config);
    await store.update(async (state) => {
      const pending = state.posts[key];
      if (claimed && pending?.operation_id !== operationId) return;
      if (definitive) {
        check(pending.cms_source?.intent?.body.mutation_id === intent.body.mutation_id, "Ghost rejected source intent ownership changed");
        const existing = pending.cms_source.intent.rejection_outcome;
        check(!existing || JSON.stringify(existing) === JSON.stringify(rejection), "Ghost exact source rejection outcome changed");
        if (!existing) pending.cms_source.intent.rejection_outcome = structuredClone(rejection);
      }
      const retainedRejection = pending?.cms_source?.intent?.rejection_outcome;
      const retained = retainedRejection && sourceRejectionCode(retainedRejection, pending.cms_source.intent, config);
      const refusalCode = definitive || retained;
      state.posts[key] = { ...pending, outcome: "attention", pending_until: 0, failure_reason: refusalCode ? refusalCode === preservationCode ? `Ghost ${preservationCode}: article preservation is unavailable; exact rejected request and accepted publication are retained` : "Ghost invalid_field: the receiver refused this source request; correct the cause before explicit Retry. Exact request and accepted history are retained" : error.message.startsWith("Ghost ") ? error.message : "Ghost source publication requires reconciliation; exact intent is preserved" };
      if (capturedSource && (error.cause?.localSourcePreparationLimitation || error.cause?.message?.startsWith("Ghost Bridge cannot preserve prepared article references"))) {
        const previousCms = state.posts[key].cms_source;
        state.posts[key].cms_source = { ...previousCms, last_preparation_issue: { capture: structuredClone(capturedSource), detail: error.message } };
        try { serializedState(state); }
        catch {
          state.posts[key].cms_source = previousCms;
          state.posts[key].failure_reason = "Ghost Bridge cannot retain the complete native preparation diagnostic/capture within the existing protected state budget; native original and pending/accepted evidence remain unchanged, no source request was dispatched";
        }
      }
    });
    throw error;
  }
}
