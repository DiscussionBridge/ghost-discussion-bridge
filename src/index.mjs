import { loadConfig } from "./config.mjs";
import { BridgeClient } from "./bridge-client.mjs";
import { GhostAdminClient } from "./ghost-admin-client.mjs";
import { runPublicationSynchronization } from "./publication-operations.mjs";
import { assertStateStoreRuntimePrerequisites, StateStore } from "./state-store.mjs";
import { buildServer } from "./service.mjs";
import { startPublicationScheduler } from "./publication-scheduler.mjs";

const config = loadConfig();
await assertStateStoreRuntimePrerequisites();
const store = new StateStore(config.stateFile);
const bridge = new BridgeClient(config);
const ghost = new GhostAdminClient(config);
const synchronize = () => runPublicationSynchronization(config, store, bridge, ghost);
const server = buildServer(config, store, bridge, { synchronize }).listen(config.port, "127.0.0.1", () => {
  process.stdout.write(`Ghost DiscussionBridge listening on 127.0.0.1:${config.port}\n`);
});
const scheduler = startPublicationScheduler({ intervalSeconds: config.sourceSyncIntervalSeconds, synchronize, onError: () => process.stderr.write("Scheduled source synchronization failed; inspect protected operator status.\n") });
let stopping;
const stop = () => {
  stopping ??= Promise.all([scheduler.stop(), new Promise((resolve) => { server.close(resolve); server.closeIdleConnections(); })]).catch(() => { process.exitCode = 1; });
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
