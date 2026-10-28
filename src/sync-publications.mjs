import { CoreClient } from "./core-client.mjs";
import { loadConfig } from "./config.mjs";
import { GhostAdminClient } from "./ghost-admin-client.mjs";
import { runPublicationSynchronization } from "./publication-operations.mjs";
import { assertStateStoreRuntimePrerequisites, StateStore } from "./state-store.mjs";

const config = loadConfig();
await assertStateStoreRuntimePrerequisites();
const summary = await runPublicationSynchronization(config, new StateStore(config.stateFile), new CoreClient(config), new GhostAdminClient(config));
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (summary.failed) process.exitCode = 1;
