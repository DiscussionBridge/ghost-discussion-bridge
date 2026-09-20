import { randomUUID } from "node:crypto";
import { syncForumPublications } from "./forum-publication-sync.mjs";

const RUN_LEASE_MS = 2 * 60 * 1000;

function safeReason(value, secrets = []) {
  const reason = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim() : "Synchronization failed";
  let redacted = reason || "Synchronization failed";
  for (const secret of secrets) if (typeof secret === "string" && secret) redacted = redacted.replaceAll(secret, "[redacted]");
  return redacted.slice(0, 240);
}

function safeSummary(summary, config = {}) {
  const secrets = [config.connectionSecret, config.webhookSecret, config.ghostAdminApiKey, config.operatorPassword];
  return {
    created: Number.isSafeInteger(summary?.created) ? summary.created : 0,
    updated: Number.isSafeInteger(summary?.updated) ? summary.updated : 0,
    unchanged: Number.isSafeInteger(summary?.unchanged) ? summary.unchanged : 0,
    held: Number.isSafeInteger(summary?.held) ? summary.held : 0,
    unpublished: Number.isSafeInteger(summary?.unpublished) ? summary.unpublished : 0,
    failed: Number.isSafeInteger(summary?.failed) ? summary.failed : 0,
    errors: Array.isArray(summary?.errors) ? summary.errors.slice(0, 50).map((error) => ({
      resource_id: typeof error?.resource_id === "string" ? error.resource_id : null,
      topic_id: Number.isSafeInteger(error?.topic_id) ? error.topic_id : null,
      reason: safeReason(error?.reason, secrets),
    })) : [],
  };
}

export async function runPublicationSynchronization(config, store, bridge, ghost, { now = () => new Date() } = {}) {
  const operationId = randomUUID();
  const startedAt = now().toISOString();
  let claimed = false;
  await store.update(async (state) => {
    const prior = state.publication_sync;
    const priorStarted = Date.parse(prior?.started_at ?? "");
    if (prior?.state === "running" && Number.isFinite(priorStarted) && Date.now() - priorStarted < RUN_LEASE_MS) return;
    state.publication_sync = { state: "running", operation_id: operationId, started_at: startedAt };
    claimed = true;
  });
  if (!claimed) throw new Error("Publication synchronization is already running");

  try {
    const summary = safeSummary(await syncForumPublications(config, store, bridge, ghost), config);
    const completedAt = now().toISOString();
    await store.update(async (state) => {
      if (state.publication_sync?.operation_id !== operationId) throw new Error("Publication synchronization ownership changed");
      state.publication_sync = { state: summary.failed ? "attention" : "complete", operation_id: operationId, started_at: startedAt, completed_at: completedAt, summary };
    });
    return summary;
  } catch (error) {
    const completedAt = now().toISOString();
    await store.update(async (state) => {
      if (state.publication_sync?.operation_id !== operationId) return;
      state.publication_sync = { state: "attention", operation_id: operationId, started_at: startedAt, completed_at: completedAt, summary: { created: 0, updated: 0, unchanged: 0, held: 0, unpublished: 0, failed: 1, errors: [{ resource_id: null, reason: safeReason(error?.message, [config.connectionSecret, config.webhookSecret, config.ghostAdminApiKey, config.operatorPassword]) }] } };
    });
    throw error;
  }
}

export { safeReason, safeSummary };
