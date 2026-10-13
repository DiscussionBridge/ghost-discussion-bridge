import { randomUUID } from "node:crypto";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export function nativeTopicUrl(value, origin, topicId) {
  const url = new URL(value);
  if (url.origin !== origin || url.username || url.password || url.search || url.hash || !Number.isSafeInteger(topicId) || topicId < 1 || !new RegExp(`^/t/(?:[^/]+/)?${topicId}/?$`, "u").test(url.pathname)) throw new Error("Invalid native topic URL/identity");
  return url.href;
}

// The existing posts entry is both intent and receipt. No second publisher,
// queue, native identity or body cache is introduced.
export async function publishSource(record, config, store, client) {
  const operationId = randomUUID(); let prior;
  await store.update(async (state) => {
    prior = state.posts[record.external_id];
    if (prior?.canonical_url && prior.canonical_url !== record.canonical_url) throw new Error("Ghost canonical source URL changed; reconciliation is required");
    if (prior?.pending_until > Date.now()) throw new Error("Ghost source publication is already pending; retry after the lease");
    if (record.source_publication) {
      record.source_publication.previous_revision = prior?.requested_revision === record.source_publication.revision ? prior.requested_previous_revision ?? null : prior?.source_revision ?? null;
      record.correlation_id = prior?.requested_revision === record.source_publication.revision ? prior.correlation_id ?? record.correlation_id : record.correlation_id;
    }
    state.posts[record.external_id] = { ...prior, canonical_url: record.canonical_url, operation_id: operationId, pending_until: Date.now() + (client.timeoutMs ?? 10000) + 5000, outcome: "pending", correlation_id: record.correlation_id, ...(record.source_publication ? { requested_revision: record.source_publication.revision, requested_previous_revision: record.source_publication.previous_revision } : {}) };
  });
  try {
    const result = await client.resolve(record);
    if (result.direction !== undefined && result.direction !== "to_discourse") throw new Error("Invalid returned Ghost publication direction");
    if (!uuid.test(result.resource_id ?? "") || !Number.isSafeInteger(result.topic_id) || result.topic_id < 1 || !["created", "resolved"].includes(result.outcome) || result.core_fallback !== false) throw new Error("Invalid DiscussionBridge success response");
    if ((prior?.resource_id && prior.resource_id !== result.resource_id) || (prior?.topic_id && prior.topic_id !== result.topic_id)) throw new Error("Ghost native resource/topic changed; reconciliation is required");
    const topicUrl = nativeTopicUrl(result.topic_url, config.serverUrl, result.topic_id);
    if (record.source_publication && (result.source_revision !== record.source_publication.revision || !["created", "adopted", "updated", "unchanged"].includes(result.source_publication_outcome))) throw new Error("Invalid accepted Ghost source revision receipt");
    await store.update(async (state) => {
      const pending = state.posts[record.external_id];
      if (pending?.operation_id !== operationId) throw new Error("Ghost source intent ownership changed");
      state.posts[record.external_id] = { ...pending, resource_id: result.resource_id, topic_id: result.topic_id, topic_url: topicUrl, outcome: result.outcome, pending_until: 0, source_revision: result.source_revision ?? prior?.source_revision, updated_at: new Date().toISOString() };
    });
    return result;
  } catch (error) {
    await store.update(async (state) => { const pending = state.posts[record.external_id]; if (pending?.operation_id === operationId) { pending.pending_until = 0; pending.outcome = error.status === 409 || /reconciliation|identity/u.test(error.message) ? "reconciliation_required" : "attention"; pending.failure_reason = "Source publication failed; preserved intent requires retry or reconciliation"; } });
    throw error;
  }
}
