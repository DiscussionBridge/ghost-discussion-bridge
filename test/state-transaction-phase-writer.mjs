const [stateStoreUrl, statePath, controlPath, phase] = process.argv.slice(2);
const { StateStore } = await import(stateStoreUrl);
await new StateStore(statePath, {
  transactionControlPath: controlPath,
  transactionControlPhase: phase,
}).update(async (state) => {
  state.posts[`forbidden-${phase}`] = { forbidden: true };
});
