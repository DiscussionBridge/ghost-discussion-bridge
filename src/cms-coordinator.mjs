import { createHash, randomUUID } from "node:crypto";
import { cmsSchema, validateCms, validateCmsResponse } from "../lib/cms-runtime.mjs";
import { ghostMoveDestination } from "./cms-move-request.mjs";
import { performGhostPresentationMove } from "./cms-presentation-move.mjs";
import { synchronizeCmsAttention, selectCmsRecovery, reinspectCmsRecovery } from "./cms-attention.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const copy = (value) => structuredClone(value);
const tree = (value) => value && typeof value === "object" ? Array.isArray(value) ? value.map(tree) : Object.fromEntries(Object.keys(value).sort().map((key) => [key, tree(value[key])])) : value;
const equal = (a, b) => JSON.stringify(tree(a)) === JSON.stringify(tree(b));
const requireMatch = (condition, message) => { if (!condition) throw new Error(message); };

export function newCmsReservation(sourceId, config) {
  const key = hash(sourceId);
  return { external_id: `ghost-source:${key}`, canonical_url: `${config.ghostOrigin}/discussionbridge-${key}/` };
}

// Journal uses the existing protected state file. It is an operational replay
// journal, not another publication map. No lease token enters a native receipt.
export async function cmsMutation(store, client, key, routeId, makeBody, path = {}) {
  let operation;
  await store.update(async (state) => {
    state.cms_journal ??= {};
    operation = state.cms_journal[key];
    if (!operation) {
      const body = makeBody();
      client.prepareMutation(routeId, body, path);
      operation = state.cms_journal[key] = { routeId, path: copy(path), body: copy(body), completed: false };
    }
    requireMatch(operation.routeId === routeId && equal(operation.path, path), "Ghost CMS mutation journal requires reconciliation");
  });
  if (operation.completed) {
    client.prepareMutation(operation.routeId, operation.body, operation.path);
    const route = cmsSchema.routes.find((item) => item.id === operation.routeId);
    validateCmsResponse(operation.routeId, operation.result, operation.result === undefined ? 204 : route.success_http[0]);
    return copy(operation.result);
  }
  const result = await client.execute(client.prepareMutation(operation.routeId, operation.body, operation.path));
  await store.update(async (state) => {
    const current = state.cms_journal[key];
    requireMatch(equal(current.body, operation.body) && current.routeId === routeId, "Ghost CMS mutation ownership changed");
    current.completed = true;
    if (result !== undefined) current.result = copy(result);
  });
  return result;
}

function authorizedConnection(connection, policy, config) {
  validateCms("Connection", connection); validateCms("Policy", policy);
  requireMatch(connection.connection_id === config.connectionId && connection.profile === "ghost" && connection.destination_origin === config.ghostOrigin && connection.directions.includes("from_discourse"), "Ghost CMS connection does not authorize this native destination");
  requireMatch(!config.lane || config.lane === connection.publication_lane, "Ghost CMS publication lane differs from configured lane");
  requireMatch(equal(connection.policy, policy), "Ghost CMS policy changed while reading configuration");
  requireMatch(policy.publication_kind === "dynamic" && connection.native_capabilities.publication_kind === "dynamic" && connection.native_capabilities.complete_content_supported && connection.native_capabilities.supported_presentations.includes(policy.presentation_mode), "Ghost CMS selected native configuration is unavailable");
}

const issueWork = (work) => ({ work_id: work.work_id, mapping_id: work.mapping_id, source_id: work.source_id, action: work.action, source_revision: work.source_revision, policy_revision: work.policy_revision, attempt_cycle: work.attempt_cycle });

async function reconcileLocalLimitations(config, store, client, native, binding, policy, assertOperation, now) {
  const blocked = new Set();
  for (const item of Object.values((await store.read()).publications)) {
    const issue = item.cms?.local_native_limitation;
    if (!issue) continue;
    blocked.add(item.cms.mapping_id);
    await assertOperation();
    const status = await client.work(issue.work_id);
    validateCms("WorkQueryResponse", status);
    requireMatch(status.work.work_id === issue.work_id && status.work.mapping_id === item.cms.mapping_id && status.mapping.mapping_id === item.cms.mapping_id && status.mapping.connection_id === config.connectionId, "Ghost local limitation status changed ownership");
    const context = issue.context ?? issueWork(status.work);
    let resolved = ["cancelled", "superseded", "verified"].includes(status.work.state) || !equal(context, issueWork(status.work));
    if (!resolved && native.preflight && status.work.action === "publish_revision") {
      const source = (await store.read()).cms_feed.sources[hash(JSON.stringify([status.work.source_id, status.work.source_revision]))];
      if (source) {
        const probe = async () => {
          await assertOperation();
          const currentConnection = await client.connection(), currentPolicy = await client.policy();
          authorizedConnection(currentConnection, currentPolicy, config);
          requireMatch(currentPolicy.enabled && currentPolicy.policy_revision === policy.policy_revision && currentConnection.scope_revision === binding.scope_revision, "Ghost local limitation scope/policy changed");
          const current = await client.work(issue.work_id);
          validateCms("WorkQueryResponse", current);
          requireMatch(equal(issueWork(current.work), context) && current.mapping.mapping_id === item.cms.mapping_id && current.mapping.connection_id === config.connectionId, "Ghost local limitation work changed during probe");
        };
        try {
          // Immutable content reads do not renew or mutate this known Work.
          const content = await client.completeSource(source, { beforeChunk: probe });
          await native.preflight({ config, connection: await client.connection(), policy, mapping: status.mapping, work: status.work, source, content });
          await probe(); resolved = true;
        } catch (error) { if (!error.localNativeLimitation) throw error; }
      }
    }
    if (!resolved) continue;
    await store.update(async (state) => {
      const current = state.publications[status.mapping.resource_id];
      requireMatch(equal(current?.cms?.local_native_limitation, issue), "Ghost local limitation changed during reconciliation");
      current.cms.local_limitation_history ??= [];
      current.cms.local_limitation_history.push({ ...copy(issue), reconciled_work: copy(status.work) });
      const claim = state.cms_journal[issue.claim_key];
      if (equal(context, issueWork(status.work)) && ["leased", "synchronized"].includes(status.work.state) && claim?.result?.lease_generation === status.work.lease_generation && claim.observed_at + Date.parse(claim.result.expires_at) - Date.parse(claim.result.server_time) > now()) current.cms.resume_claim_key = issue.claim_key;
      delete current.cms.local_native_limitation;
    });
    blocked.delete(item.cms.mapping_id);
  }
  return blocked;
}

export async function synchronizeCms(config, store, client, native, {
  assertOperation = async () => {}, maximumPages = 100, maximumWork = 100, now = () => Date.now(),
} = {}) {
  const summary = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, errors: [] };
  const connection = await client.connection(), policy = await client.policy();
  authorizedConnection(connection, policy, config);
  if (!policy.enabled) { summary.skipped++; return summary; }
  const binding = { connection_id: config.connectionId, forum_origin: config.serverUrl, destination_origin: config.ghostOrigin, scope_revision: connection.scope_revision, policy_revision: policy.policy_revision };
  await store.update(async (state) => {
    state.cms_feed ??= { binding, initial_complete: false, next_cursor: null, checkpoint_cursor: null, events: {}, sources: {}, last_sequence: null, last_initial_source: null };
    requireMatch(equal(state.cms_feed.binding, binding), "Ghost CMS source checkpoint requires explicit scope/policy reconciliation");
  });
  const attentionSupported = await synchronizeCmsAttention({ config, store, client, native, connection, policy, assertOperation, mutate: cmsMutation, now });

  // Complete page staging and the cursor advance share one atomic transaction.
  // Bound each sweep, retaining the exact continuation for the next invocation.
  for (let page = 0; page < maximumPages; page++) {
    await assertOperation();
    const feed = (await store.read()).cms_feed;
    const stream = feed.initial_complete ? "changes" : "initial";
    const cursor = feed.next_cursor ?? (feed.initial_complete ? feed.checkpoint_cursor : undefined);
    const response = await client.sources({ stream, ...(cursor ? { cursor } : {}) });
    validateCms("SourceFeed", response);
    requireMatch(response.stream === stream && response.next_cursor !== cursor, "Ghost CMS source continuation did not advance");
    await store.update(async (state) => {
      const current = state.cms_feed;
      requireMatch(equal(current, feed), "Ghost CMS feed staging ownership changed");
      for (const event of response.items) {
        const previous = current.events[event.event_id];
        if (previous) { requireMatch(equal(previous.event, event), "Ghost CMS replayed event identity changed"); continue; }
        if (stream === "initial") {
          requireMatch(event.event_type === "publication" && (!current.last_initial_source || Buffer.compare(Buffer.from(current.last_initial_source), Buffer.from(event.source.source_id)) < 0), "Ghost CMS initial source order/identity changed");
          current.last_initial_source = event.source.source_id;
        } else {
          requireMatch(current.last_sequence === null || BigInt(event.event_sequence) > BigInt(current.last_sequence), "Ghost CMS change sequence did not advance");
          current.last_sequence = event.event_sequence;
        }
        current.events[event.event_id] = { event: copy(event), prepared: event.event_type !== "publication" };
        if (event.event_type === "publication") current.sources[hash(JSON.stringify([event.source.source_id, event.source.source_revision]))] = copy(event.source);
      }
      current.next_cursor = response.next_cursor;
      if (response.checkpoint_cursor !== null) current.checkpoint_cursor = response.checkpoint_cursor;
      if (stream === "initial" && response.next_cursor === null) current.initial_complete = true;
    });
    if (response.next_cursor === null) break;
  }

  const feed = (await store.read()).cms_feed;
  for (const [eventId, staged] of Object.entries(feed.events)) {
    if (staged.prepared) continue;
    await assertOperation();
    const source = staged.event.source;
    let reservation;
    await store.update(async (state) => {
      const event = state.cms_feed.events[eventId];
      const matches = Object.values(state.publications).filter((item) => item.cms?.source_id === source.source_id);
      requireMatch(matches.length <= 1, "Ghost CMS source has duplicate native mappings");
      const prior = matches[0];
      const topicId = source.topic_id;
      requireMatch(!Object.values(state.publications).some((item) => !item.cms && item.topic_id === topicId), "Ghost CMS native publication has no owned current mapping receipt");
      reservation = event.reservation ?? (prior ? { external_id: prior.cms.external_id, canonical_url: prior.canonical_url } : newCmsReservation(source.source_id, config));
      const url = new URL(reservation.canonical_url);
      if (prior?.cms?.url_move_request?.state === "committed") ghostMoveDestination(reservation.canonical_url, config.ghostOrigin);
      else requireMatch(url.origin === config.ghostOrigin && !url.username && !url.password && !url.search && !url.hash && /^\/discussionbridge-[a-f0-9]{64}\/$/u.test(url.pathname), "Ghost CMS native reservation is invalid");
      requireMatch(!Object.values(state.publications).some((item) => item.canonical_url === reservation.canonical_url && item.cms?.source_id !== source.source_id) && !Object.values(state.posts).some((item) => item.canonical_url === reservation.canonical_url), "Ghost CMS native URL collides with existing material");
      event.reservation = copy(reservation);
    });
    const mapping = await cmsMutation(store, client, `prepare:${eventId}`, "V4-09", () => ({ mutation_id: randomUUID(), source_id: source.source_id, source_revision: source.source_revision, policy_revision: policy.policy_revision, ...reservation }));
    validateCms("Mapping", mapping);
    requireMatch(mapping.connection_id === config.connectionId && mapping.source_id === source.source_id && mapping.external_id === reservation.external_id && mapping.canonical_url === reservation.canonical_url && mapping.presentation_mode === policy.presentation_mode, "Ghost CMS mapping preparation returned different ownership");
    await store.update(async (state) => {
      const prior = state.publications[mapping.resource_id];
      requireMatch(!prior || prior.cms?.mapping_id === mapping.mapping_id, "Ghost CMS mapping cannot replace an existing native receipt");
      requireMatch(prior || mapping.destination_native_id === null, "Ghost CMS native mapping has no durable owned receipt");
      state.publications[mapping.resource_id] = prior ?? { canonical_url: mapping.canonical_url, resource_tag: `#discussionbridge-resource-${mapping.resource_id}`, topic_id: source.topic_id, topic_url: source.topic_url, state: "pending", ghost_native_type: config.publicationType ?? "post", cms: { mapping_id: mapping.mapping_id, mapping_revision: mapping.mapping_revision, source_id: source.source_id, external_id: mapping.external_id, last_lease_generation: 0, ownership_receipt: null } };
      state.cms_feed.events[eventId].prepared = true;
    });
  }

  const blocked = await reconcileLocalLimitations(config, store, client, native, binding, policy, assertOperation, now);
  const emptyMappings = new Set(), emptyRecoveries = new Set();
  for (let count = 0; count < maximumWork; count++) {
    await assertOperation();
    let claimKey, targetMapping, targetRecovery, noCandidate = false;
    await store.update(async (state) => {
      if (!state.cms_feed.pending_claim) {
        const recovery = attentionSupported ? selectCmsRecovery(state, emptyRecoveries) : null;
        const resumable = Object.values(state.publications).find((item) => item.cms?.resume_claim_key && !blocked.has(item.cms.mapping_id));
        if (recovery) { recovery.claim_key ??= `recovery-claim:${recovery.recovery.recovery_id}:${randomUUID()}`; state.cms_feed.pending_claim = recovery.claim_key; }
        else if (resumable) { state.cms_feed.pending_claim = resumable.cms.resume_claim_key; delete resumable.cms.resume_claim_key; }
        else {
          if (blocked.size) {
            targetMapping = Object.values(state.publications).find((item) => item.cms?.mapping_id && !blocked.has(item.cms.mapping_id) && !emptyMappings.has(item.cms.mapping_id))?.cms.mapping_id;
            if (!targetMapping) { noCandidate = true; return; }
          }
          state.cms_feed.pending_claim = `claim:${randomUUID()}`;
        }
      }
      claimKey = state.cms_feed.pending_claim;
      targetRecovery = Object.values(state.cms_attention?.recoveries ?? {}).find((entry) => entry.claim_key === claimKey)?.recovery;
      if (targetRecovery) targetMapping = targetRecovery.mapping.mapping_id;
      targetMapping = state.cms_journal[claimKey]?.body.mapping_id ?? targetMapping;
    });
    if (noCandidate) { summary.skipped += blocked.size; break; }
    const lease = targetRecovery ? await cmsMutation(store, client, claimKey, "V4-36", () => ({ mutation_id: randomUUID(), work_id: targetRecovery.work.work_id }), { recovery_id: targetRecovery.recovery_id }) : await cmsMutation(store, client, claimKey, "V4-13", () => ({ mutation_id: randomUUID(), ...(targetMapping ? { mapping_id: targetMapping } : {}) }));
    if (!lease) {
      await store.update(async (state) => { delete state.cms_feed.pending_claim; if (targetRecovery) delete state.cms_attention.recoveries[targetRecovery.recovery_id].claim_key; });
      if (targetRecovery) { emptyRecoveries.add(targetRecovery.recovery_id); continue; }
      if (targetMapping) { emptyMappings.add(targetMapping); continue; }
      break;
    }
    validateCms("Lease", lease);
    const work = lease.work;
    requireMatch(!targetRecovery || work.work_id === targetRecovery.work.work_id, "Ghost recovery claim returned a different Work");
    if (targetRecovery) await store.update(async (state) => { state.cms_attention.recoveries[targetRecovery.recovery_id].state = "claimed"; });
    requireMatch(!targetMapping || work.mapping_id === targetMapping, "Ghost targeted claim returned different mapping authority");
    const initialStatus = await client.work(work.work_id);
    validateCms("WorkQueryResponse", initialStatus);
    let observedClaim;
    await store.update(async (state) => { const entry = state.cms_journal[claimKey]; entry.observed_at ??= now(); observedClaim = entry.observed_at; });
    const claimDeadline = observedClaim + Date.parse(lease.expires_at) - Date.parse(lease.server_time);
    if (initialStatus.work.state === "verified") {
      const saved = (await store.read()).cms_journal[`verify:${claimKey}`];
      const local = (await store.read()).publications[initialStatus.mapping.resource_id];
      requireMatch(saved?.body?.stage === "verified" && saved.body.authority.work_id === work.work_id && saved.body.authority.lease_generation === lease.lease_generation && local?.cms?.work_id === work.work_id && local.cms.last_lease_generation === lease.lease_generation && local.ghost_post_id === initialStatus.mapping.destination_native_id && local.cms.synchronized_result?.native_id === local.ghost_post_id, "Ghost CMS terminal result needs native receipt reconciliation");
      const replay = await cmsMutation(store, client, `verify:${claimKey}`, "V4-16", () => { throw new Error("Missing Ghost CMS verification replay"); }, { work_id: work.work_id });
      requireMatch(replay.work.work_id === work.work_id && replay.work.state === "verified" && replay.mapping.destination_native_id === local.ghost_post_id, "Ghost CMS verification replay changed native identity");
      await store.update(async (state) => {
        const item = state.publications[initialStatus.mapping.resource_id];
        requireMatch(item.cms.last_lease_generation === lease.lease_generation, "Ghost CMS terminal native receipt was fenced");
        item.cms.last_verified = { native_result: copy(item.cms.synchronized_result), verification: copy(saved.body.verification) };
        item.publicly_verified_at = saved.body.verification.checked_at;
        item.state = initialStatus.mapping.desired_source_revision === work.source_revision ? "complete" : "pending";
        delete state.cms_feed.pending_claim;
      });
      summary.unchanged++;
      continue;
    }
    if (!["leased", "synchronized"].includes(initialStatus.work.state) || now() >= claimDeadline) {
      await store.update(async (state) => {
        const item = state.publications[initialStatus.mapping.resource_id];
        if (item?.cms?.work_id === work.work_id) item.state = "attention";
        delete state.cms_feed.pending_claim;
      });
      // A fresh poll consumes only receiver-eligible work. Native uncertainty
      // remains in the same receipt and must reconcile under the next fence.
      summary.skipped++;
      continue;
    }
    const authority = { work_id: work.work_id, lease_token: lease.lease_token, lease_generation: lease.lease_generation, source_revision: work.source_revision, policy_revision: work.policy_revision };
    validateCms("LeaseAuthority", authority);
    let expiresAt = 0, renewalCount = 0;
    const guard = async (forceRenew = false) => {
      await assertOperation();
      const currentConnection = await client.connection(), currentPolicy = await client.policy();
      authorizedConnection(currentConnection, currentPolicy, config);
      requireMatch(currentPolicy.enabled && currentPolicy.policy_revision === work.policy_revision && currentConnection.scope_revision === binding.scope_revision, "Ghost CMS work policy/scope is no longer current");
      if (forceRenew || now() + 30_000 >= expiresAt) {
        const refreshed = await cmsMutation(store, client, `renew:${claimKey}:${renewalCount++}`, "V4-15", () => ({ mutation_id: randomUUID(), authority }), { work_id: work.work_id });
        requireMatch(refreshed.work.work_id === work.work_id && refreshed.work.mapping_id === work.mapping_id && refreshed.work.action === work.action && refreshed.work.source_revision === work.source_revision && refreshed.lease_token === authority.lease_token && refreshed.lease_generation === authority.lease_generation, "Ghost CMS renewal changed work authority");
        // Exact replay may return an old lease. Retain its first local observation.
        let observed;
        const journalKey = `renew:${claimKey}:${renewalCount - 1}`;
        await store.update(async (state) => { const entry = state.cms_journal[journalKey]; entry.observed_at ??= now(); observed = entry.observed_at; });
        const ttl = Date.parse(refreshed.expires_at) - Date.parse(refreshed.server_time);
        requireMatch(ttl > 0 && ttl <= 300_000, "Ghost CMS lease duration is invalid");
        expiresAt = observed + ttl;
      }
      requireMatch(now() < expiresAt, "Ghost CMS native work lease expired");
      const current = await client.work(work.work_id);
      requireMatch(current.work.work_id === work.work_id && current.work.mapping_id === work.mapping_id && current.work.source_id === work.source_id && current.work.source_revision === work.source_revision && current.work.policy_revision === work.policy_revision && current.work.lease_generation === authority.lease_generation && ["leased", "synchronized"].includes(current.work.state), "Ghost CMS work was superseded or lost authority");
      requireMatch(current.mapping.mapping_id === work.mapping_id && current.mapping.source_id === work.source_id && current.mapping.connection_id === config.connectionId && current.mapping.presentation_mode === currentPolicy.presentation_mode, "Ghost CMS current mapping identity/configuration changed");
      return current.mapping;
    };
    let mapping, nativeChanged = false;
    try {
      mapping = await guard(true);
      const record = (await store.read()).publications[mapping.resource_id];
      const pendingMove = record?.cms?.url_move_request;
      const finalizeRecovery = initialStatus.work.state === "leased" && pendingMove && pendingMove.state !== "committed" && pendingMove.native_outcome === "applied" && pendingMove.new_url === mapping.canonical_url && Object.keys((await store.read()).cms_journal ?? {}).some((key) => key.startsWith(`url-finalize:${pendingMove.request_id}:`));
      requireMatch(record?.cms?.mapping_id === mapping.mapping_id && record.cms.source_id === work.source_id && (record.canonical_url === mapping.canonical_url || finalizeRecovery) && record.cms.external_id === mapping.external_id, "Ghost CMS native work has no exact local mapping intent");
      requireMatch(lease.lease_generation >= record.cms.last_lease_generation, "Ghost CMS native generation is stale");
      if (targetRecovery) {
        await reinspectCmsRecovery({ config, store, client, native, connection, policy, recovery: targetRecovery, mapping, work, authority, assertOperation, now });
        blocked.delete(work.mapping_id);
      }
      await store.update(async (state) => {
        const item = state.publications[mapping.resource_id];
        requireMatch(item.cms.last_lease_generation <= authority.lease_generation, "Ghost CMS native generation was fenced");
        item.cms.last_lease_generation = authority.lease_generation;
        item.cms.work_id = work.work_id;
        item.cms.mapping_revision = mapping.mapping_revision;
        item.state = "pending";
      });
      const source = work.action === "publish_revision" ? (await store.read()).cms_feed.sources[hash(JSON.stringify([work.source_id, work.source_revision]))] : null;
      requireMatch(work.action === "withdraw" || source, "Ghost CMS exact claimed source metadata is unavailable");
      if (source) requireMatch(source.source_id === record.cms.source_id && source.topic_id === String(record.topic_id), "Ghost CMS source changed the stable native discussion identity");
      const content = source ? await client.completeSource(source, { beforeChunk: guard }) : null;
      const assertAuthority = async () => {
        await guard();
        const item = (await store.read()).publications[mapping.resource_id];
        requireMatch(item?.cms?.work_id === work.work_id && item.cms.last_lease_generation === authority.lease_generation, "Ghost CMS native writer was fenced");
      };
      let result;
      const context = { config, store, client, connection, policy, mapping, work, authority, source, content, assertAuthority, changed: (value = true) => { nativeChanged = value; } };
      if (initialStatus.work.state === "leased" && work.action === "publish_revision" && mapping.destination_native_id && pendingMove && !["committed", "aborted"].includes(pendingMove.state)) {
        nativeChanged = ["applied", "unknown"].includes(pendingMove.native_outcome);
        const moved = await performGhostPresentationMove(context, native); result = moved.result; mapping = moved.mapping;
      } else result = await native.synchronize(context);
      validateCms("SyncResult", result.nativeResult);
      requireMatch(result.nativeResult.kind === work.action && result.nativeResult.external_id === mapping.external_id && result.nativeResult.canonical_url === mapping.canonical_url && (mapping.destination_native_id === null || mapping.destination_native_id === result.nativeResult.native_id), "Ghost CMS native result does not match work action/identity");
      await assertAuthority();
      await store.update(async (state) => {
        const item = state.publications[mapping.resource_id];
        requireMatch(item.cms.work_id === work.work_id && item.cms.last_lease_generation === authority.lease_generation, "Ghost CMS native result writer was fenced");
        item.ghost_post_id = result.nativeResult.native_id;
        item.cms.synchronized_result = copy(result.nativeResult);
        item.synchronized_at = new Date(now()).toISOString();
      });
      const synchronized = await cmsMutation(store, client, `sync:${claimKey}`, "V4-16", () => ({ mutation_id: randomUUID(), stage: "synchronized", authority, native_result: result.nativeResult }), { work_id: work.work_id });
      requireMatch(synchronized.work.state === "synchronized" && synchronized.mapping.destination_native_id === result.nativeResult.native_id, "Ghost CMS synchronized acknowledgement changed identity/state");
      await store.update(async (state) => { state.publications[mapping.resource_id].cms.mapping_revision = synchronized.mapping.mapping_revision; });
      await assertAuthority();
      const verification = await native.verify({ config, mapping, work, source, result, assertAuthority });
      validateCms("Verification", verification);
      requireMatch(verification.kind === (work.action === "withdraw" ? "absent" : "published"), "Ghost CMS public verification does not match work action");
      await assertAuthority();
      const verified = await cmsMutation(store, client, `verify:${claimKey}`, "V4-16", () => ({ mutation_id: randomUUID(), stage: "verified", authority, verification }), { work_id: work.work_id });
      requireMatch(verified.work.state === "verified" && verified.mapping.destination_native_id === result.nativeResult.native_id, "Ghost CMS verified acknowledgement changed identity/state");
      await store.update(async (state) => {
        const item = state.publications[mapping.resource_id];
        requireMatch(item.cms.work_id === work.work_id && item.cms.last_lease_generation === authority.lease_generation, "Ghost CMS receipt writer was fenced");
        item.state = "complete";
        item.cms.mapping_revision = verified.mapping.mapping_revision;
        item.publicly_verified_at = verification.checked_at;
        item.cms.last_verified = { native_result: copy(result.nativeResult), verification: copy(verification) };
        delete state.cms_feed.pending_claim;
      });
      summary[result.outcome ?? "updated"]++;
    } catch (error) {
      summary.failed++;
      summary.errors.push({ resource_id: mapping?.resource_id ?? null, reason: error.localNativeLimitation ? error.message : "CMS native publication requires retry or explicit reconciliation" });
      if (mapping) await store.update(async (state) => { const item = state.publications[mapping.resource_id]; if (item?.cms?.work_id === work.work_id && item.cms.last_lease_generation === authority.lease_generation) item.state = "attention"; });
      if (error.localNativeLimitation) {
        if (mapping) await store.update(async (state) => {
          const item = state.publications[mapping.resource_id];
          if (item?.cms?.work_id === work.work_id && item.cms.last_lease_generation === authority.lease_generation) {
            item.cms.local_native_limitation = { work_id: work.work_id, context: issueWork(work), claim_key: claimKey, presentation_mode: policy.presentation_mode, source_revision: work.source_revision, elements: copy(error.unsupportedNativeElements ?? []), functions: copy(error.unsupportedNativeFunctions ?? []), receiver_failure_reported: false };
            delete state.cms_feed.pending_claim;
          }
        });
        // The existing Failure enum has no established general media-loss
        // meaning. Keep truthful local diagnostics/current claim evidence;
        // do not relabel this as ownership conflict or receiver attention.
        blocked.add(work.mapping_id);
        continue;
      }
      // Uncertain POST results retain the exact saved request for next replay.
      if (error.requestOutcomeUncertain || error.cmsMutationUncertain) break;
      try {
        await guard();
        const code = error.cmsCode ?? (error.status === 429 ? "rate_limited" : error.code === "transport_timeout" ? "transport_timeout" : "native_ownership_conflict");
        await cmsMutation(store, client, `fail:${claimKey}`, "V4-17", () => ({ mutation_id: randomUUID(), authority, code, native_change_applied: nativeChanged, safe_detail: null, retry_after_seconds: Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds <= 3600 ? error.retryAfterSeconds : null }), { work_id: work.work_id });
        await store.update(async (state) => { delete state.cms_feed.pending_claim; });
      } catch { break; }
    }
  }
  return summary;
}
