import { publishCmsSource } from "./cms-source-publication.mjs";
import { withdrawCmsSource } from "./cms-source-withdrawal.mjs";
import { sourceRetryAvailable } from "./source-refusal.mjs";
export { nativeTopicUrl } from "./topic-identity.mjs";

// One posts intent/receipt and the SAME native lock shared with From writers.
export async function publishSource(record, config, store, client, options = {}) {
  if (!options.lockHeld && typeof store.withNativeLock === "function") return store.withNativeLock((assertWriter) => publishSource(record, config, store, client, { ...options, lockHeld: true, assertWriter }));
  if (!options.lockHeld) throw new Error("Ghost current native source writer lock is unavailable");
  const prior = (await store.read()).posts[`ghost-post:${record.native_id}`];
  const retry = options.retryRefusedMutationId !== undefined;
  if (retry && record.withdrawal) throw new Error("Ghost source retry cannot perform a source withdrawal");
  if (retry && (!sourceRetryAvailable(`ghost-post:${record.native_id}`, prior, config) || prior.cms_source.intent.body.mutation_id !== options.retryRefusedMutationId)) throw new Error("Ghost source retry no longer matches the current known refused intent; reconciliation is required");
  if (record.withdrawal || prior?.cms_source?.withdrawal) return withdrawCmsSource({ ...record, withdrawal: record.withdrawal ?? {} }, config, store, client, options);
  if (typeof options.observeSourceLifecycle === "function") {
    let observation;
    try { observation = await options.observeSourceLifecycle(record.native_id, prior); }
    catch (error) {
      await store.update(async (state) => {
        const pending = state.posts[`ghost-post:${record.native_id}`];
        if (pending && pending.operation_id === prior?.operation_id) { pending.outcome = "attention"; pending.failure_reason = "Ghost current native lifecycle facts are unavailable; binding and pending requests are preserved"; }
      });
      throw error;
    }
    if (observation.reason) {
      if (retry) throw new Error("Ghost source retry requires the current published opted-in native source; retained requests are unchanged");
      return withdrawCmsSource({ ...record, withdrawal: observation }, config, store, client, { ...options, closedNativeObservation: observation });
    }
    let first = true;
    const loadCurrentSource = options.loadCurrentSource;
    options = { ...options, loadCurrentSource: () => { if (first) { first = false; return observation.current; } return loadCurrentSource(); } };
  }
  return publishCmsSource(record, config, store, client, options);
}
