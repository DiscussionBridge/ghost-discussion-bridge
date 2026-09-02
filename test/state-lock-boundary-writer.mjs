import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const [stateStoreUrl, statePath, markerPath] = process.argv.slice(2);
const { StateStore } = await import(stateStoreUrl);
await new StateStore(statePath).update(async (state) => {
  const children = (await readFile(`/proc/${process.pid}/task/${process.pid}/children`, "utf8"))
    .trim().split(/\s+/u).filter(Boolean);
  if (children.length !== 1) throw new Error(`Expected one transaction helper, found ${children.length}`);
  process.kill(Number(children[0]), "SIGKILL");
  await delay(500);
  state.posts[markerPath] = { forbidden: true };
});
