import { loadConfig } from "./config.mjs";
import { StateStore } from "./state-store.mjs";

const resourceId = process.argv[2] ?? "";
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(resourceId)) throw new Error("A valid resource UUID is required");
const config = loadConfig();
const store = new StateStore(config.stateFile);
await store.update(async (state) => {
  state.presentations[resourceId] = { registered_at: new Date().toISOString() };
});
process.stdout.write(`${resourceId}\n`);
