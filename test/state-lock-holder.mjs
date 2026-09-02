import { writeFile } from "node:fs/promises";

const [stateStoreUrl, statePath, markerPath] = process.argv.slice(2);
const { StateStore } = await import(stateStoreUrl);
await new StateStore(statePath).update(async () => {
  await writeFile(markerPath, "ready\n");
  await new Promise(() => undefined);
});
