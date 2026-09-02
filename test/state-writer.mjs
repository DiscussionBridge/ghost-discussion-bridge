import { setTimeout as delay } from "node:timers/promises";

const [stateStoreUrl, statePath, bucket, key, wait] = process.argv.slice(2);
if (!stateStoreUrl || !statePath || !["posts", "presentations", "publications"].includes(bucket) || !key) {
  throw new Error("Invalid state writer arguments");
}

const { StateStore } = await import(stateStoreUrl);
const store = new StateStore(statePath);
await store.update(async (state) => {
  await delay(Number.parseInt(wait, 10) || 0);
  state[bucket][key] = { writer: bucket };
});
