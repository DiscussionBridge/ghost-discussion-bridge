import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const [stateStoreUrl, statePath, markerPath] = process.argv.slice(2);
const { StateStore } = await import(stateStoreUrl);
const lease = await new StateStore(statePath).acquireKernelLock();
process.kill(lease.pid, "SIGKILL");
await delay(500);
await writeFile(markerPath, "forbidden\n");
