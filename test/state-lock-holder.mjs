import { writeFile } from "node:fs/promises";

const [stateStoreUrl, statePath, markerPath] = process.argv.slice(2);
const { StateStore } = await import(stateStoreUrl);
const lease = await new StateStore(statePath).acquireKernelLock();
await writeFile(markerPath, "ready\n");
await new Promise(() => undefined);
await lease.release();
