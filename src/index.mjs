import { loadConfig } from "./config.mjs";
import { BridgeClient } from "./bridge-client.mjs";
import { GhostAdminClient } from "./ghost-admin-client.mjs";
import { runPublicationSynchronization } from "./publication-operations.mjs";
import { assertStateStoreRuntimePrerequisites, StateStore } from "./state-store.mjs";
import { buildServer } from "./service.mjs";

const config = loadConfig();
await assertStateStoreRuntimePrerequisites();
const store = new StateStore(config.stateFile);
const bridge = new BridgeClient(config);
const ghost = new GhostAdminClient(config);
buildServer(config, store, bridge, { synchronize: () => runPublicationSynchronization(config, store, bridge, ghost) }).listen(config.port, "127.0.0.1", () => {
  process.stdout.write(`Ghost DiscussionBridge listening on 127.0.0.1:${config.port}\n`);
});
