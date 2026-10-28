import { randomUUID } from "node:crypto";
import { CmsClient } from "../lib/cms-client.mjs";
import { synchronizeCms } from "./cms-coordinator.mjs";
import { ghostCmsNative } from "./cms-native-publication.mjs";

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
    skipped: Number.isSafeInteger(summary?.skipped) ? summary.skipped : 0,
    ...(Number.isSafeInteger(summary?.withdrawn) ? { withdrawn: summary.withdrawn, public_withdrawal_verified: false } : {}),
    failed: Number.isSafeInteger(summary?.failed) ? summary.failed : 0,
    errors: Array.isArray(summary?.errors) ? summary.errors.slice(0, 50).map((error) => ({
      resource_id: typeof error?.resource_id === "string" ? error.resource_id : null,
      reason: safeReason(error?.reason, secrets),
    })) : [],
  };
}

export async function runPublicationSynchronization(config, store, bridge, ghost, { now = () => new Date(), leaseMs = RUN_LEASE_MS, cmsClient, publicFetch } = {}) {
  const operationId = randomUUID();
  const startedAt = now().toISOString();
  let claimed = false;
  await store.update(async (state) => {
    const prior = state.publication_sync;
    const priorStarted = Date.parse(prior?.started_at ?? "");
    const priorLease = prior?.lease_until ?? priorStarted + RUN_LEASE_MS;
    if (prior?.state === "running" && Number.isFinite(priorLease) && priorLease > Date.now()) return;
    state.publication_sync = { state: "running", operation_id: operationId, started_at: startedAt, lease_until: Date.now() + leaseMs };
    claimed = true;
  });
  if (!claimed) throw new Error("Publication synchronization is already running");
  let renewal = Promise.resolve(), leaseError;
  const heartbeat = setInterval(() => { renewal = renewal.then(async () => { await store.update(async (state) => { if (state.publication_sync?.operation_id !== operationId) throw new Error("Publication synchronization ownership changed"); if (state.publication_sync.state === "running") state.publication_sync.lease_until = Date.now() + leaseMs; }); }).catch((error) => { leaseError ??= error; }); }, Math.max(1, Math.floor(leaseMs / 3)));
  heartbeat.unref?.();
  const assertOperation = async () => { if (leaseError) throw leaseError; const current = (await store.read()).publication_sync; if (current?.operation_id !== operationId || current.lease_until <= Date.now()) throw new Error("Publication synchronization ownership changed"); };
  try {
    const run = async (assertNative = async () => {}) => {
      const assertWriter = async () => { await assertNative(); await assertOperation(); };
      if (typeof store.withNativeLock !== "function") throw new Error("Ghost CMS publication transport/native lock is unavailable");
      const client = cmsClient ?? new CmsClient({ serviceOrigin: config.serverUrl, connectionId: config.connectionId, connectionSecret: config.connectionSecret });
      return synchronizeCms(config, store, client, ghostCmsNative(ghost, { publicFetch }), { assertOperation: assertWriter });
    };
    const summary = safeSummary(await (typeof store.withNativeLock === "function" ? store.withNativeLock(run) : run()), config);
    await renewal; await assertOperation();
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
      state.publication_sync = { state: "attention", operation_id: operationId, started_at: startedAt, completed_at: completedAt, summary: { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 1, errors: [{ resource_id: null, reason: safeReason(error?.message, [config.connectionSecret, config.webhookSecret, config.ghostAdminApiKey, config.operatorPassword]) }] } };
    });
    throw error;
  } finally { clearInterval(heartbeat); await renewal; }
}

export { safeReason, safeSummary };
