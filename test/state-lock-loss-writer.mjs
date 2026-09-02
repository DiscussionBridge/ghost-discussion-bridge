import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const [stateStoreUrl, statePath, markerPath] = process.argv.slice(2);
const { StateStore } = await import(stateStoreUrl);
const store = new StateStore(statePath);

await store.update(async (state) => {
  const children = (await readFile(`/proc/${process.pid}/task/${process.pid}/children`, "utf8"))
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (children.length !== 1) throw new Error(`Expected one lock helper, found ${children.length}`);
  await writeFile(markerPath, `${JSON.stringify({ writerPid: process.pid, helperPid: Number(children[0]) })}\n`);
  await delay(2_000);
  state.posts["written-after-lock-loss"] = { forbidden: true };
});
