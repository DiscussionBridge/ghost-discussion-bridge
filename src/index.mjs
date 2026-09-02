import { loadConfig } from "./config.mjs";
import { assertStateStoreRuntimePrerequisites, StateStore } from "./state-store.mjs";
import { buildServer } from "./service.mjs";

const config = loadConfig();
await assertStateStoreRuntimePrerequisites();
buildServer(config, new StateStore(config.stateFile)).listen(config.port, "127.0.0.1", () => {
  process.stdout.write(`Ghost DiscussionBridge listening on 127.0.0.1:${config.port}\n`);
});
