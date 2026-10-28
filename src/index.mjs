import { loadConfig } from "./config.mjs";
import { CoreClient } from "./core-client.mjs";
import { GhostAdminClient } from "./ghost-admin-client.mjs";
import { runPublicationSynchronization } from "./publication-operations.mjs";
import { assertStateStoreRuntimePrerequisites, StateStore } from "./state-store.mjs";
import { buildServer } from "./service.mjs";
import { startPublicationScheduler } from "./publication-scheduler.mjs";
import { queueGhostPresentationMove } from "./cms-move-request.mjs";
import { refreshGhostCatalog } from "./cms-catalog-producer.mjs";
import { CmsClient } from "../lib/cms-client.mjs";
import { publishSource } from "./source-write.mjs";
import { observeGhostSourceLifecycle } from "./cms-source-withdrawal.mjs";
import { readGhostPresentation } from "./presentation-reader.mjs";
import { prepareGhostSourceMove } from "./cms-source-move.mjs";
import { prepareGhostSourceHtml } from "./source-preparation.mjs";
import { MAX_STATE_BYTES } from "./state-file.mjs";

const config = loadConfig();
await assertStateStoreRuntimePrerequisites();
const store = new StateStore(config.stateFile);
const core = new CoreClient(config), ghost = new GhostAdminClient(config);
const client = new CmsClient({ serviceOrigin: config.serverUrl, connectionId: config.connectionId, connectionSecret: config.connectionSecret });
const synchronize = () => runPublicationSynchronization(config, store, core, ghost, { cmsClient: client });
// Whole native capture is bounded by the existing protected state resource
// budget, independent of webhook delivery size. No source-size validity rule.
const loadCurrentNativeSource = async (nativeId) => {
  return ghost.getSource(nativeId, MAX_STATE_BYTES);
};
const sourceOptions = (nativeId) => ({ observeSourceLifecycle: (id, prior) => observeGhostSourceLifecycle(config, ghost, id, prior), loadCurrentSource: () => loadCurrentNativeSource(nativeId), prepareSourceHtml: prepareGhostSourceHtml });
const publishNativeSource = (nativeId) => publishSource({ native_id: nativeId }, config, store, client, sourceOptions(nativeId));
const retrySource = ({ native_id: nativeId, refused_mutation_id: refusedMutationId }) => publishSource({ native_id: nativeId }, config, store, client, { ...sourceOptions(nativeId), retryRefusedMutationId: refusedMutationId });
const stopSourceDelivery = (nativeId) => publishSource({ native_id: nativeId, withdrawal: { reason: "policy_excluded", facts: { native_id: nativeId, actor: "discussionbridge", observation: "protected_native_operator_stop_delivery" } } }, config, store, client);
const server = buildServer(config, store, core, {
  synchronize, publishNativeSource, retrySource, stopSourceDelivery,
  readPresentation: (resourceId) => readGhostPresentation(config, store, client, resourceId),
  queuePresentationMove: (request) => queueGhostPresentationMove(config, store, request),
  prepareSourceMove: (request) => prepareGhostSourceMove(request, config, store, client, ghost),
  refreshCatalog: (kind) => refreshGhostCatalog(config, store, ghost, kind),
}).listen(config.port, "127.0.0.1", () => process.stdout.write("Ghost DiscussionBridge listening on 127.0.0.1:" + config.port + "\n"));
const scheduler = startPublicationScheduler({ intervalSeconds: config.sourceSyncIntervalSeconds, synchronize, onError: () => process.stderr.write("Scheduled source synchronization failed; inspect protected operator status.\n") });
let stopping;
const stop = () => { stopping ??= Promise.all([scheduler.stop(), new Promise((resolve) => { server.close(resolve); server.closeIdleConnections(); })]).catch(() => { process.exitCode = 1; }); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
