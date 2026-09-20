import { BridgeClient } from "./bridge-client.mjs";
import { loadConfig } from "./config.mjs";
import { GhostAdminClient } from "./ghost-admin-client.mjs";
import { runPublicationQueue } from "./publication-operations.mjs";
import { assertStateStoreRuntimePrerequisites, StateStore } from "./state-store.mjs";

const config = loadConfig();
await assertStateStoreRuntimePrerequisites();
const summary = await runPublicationQueue(
  config,
  new StateStore(config.stateFile),
  new BridgeClient(config),
  new GhostAdminClient(config),
);
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (summary.failed) process.exitCode = 1;
