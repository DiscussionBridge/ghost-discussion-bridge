export function validateSyncInterval(value) {
  if (!Number.isSafeInteger(value) || (value !== 0 && (value < 60 || value > 86400))) throw new Error("Source synchronization interval must be 0 (disabled), or 60–86400 seconds");
  return value;
}

export function startPublicationScheduler({ intervalSeconds = 0, synchronize, onError = () => {}, timers = globalThis }) {
  validateSyncInterval(intervalSeconds);
  let stopped = false, inFlight;
  const tick = () => {
    if (stopped || inFlight) return;
    inFlight = Promise.resolve().then(synchronize).catch((error) => { try { onError(error); } catch {} }).finally(() => { inFlight = undefined; });
  };
  const timer = intervalSeconds ? timers.setInterval(tick, intervalSeconds * 1000) : undefined;
  timer?.unref?.();
  return { enabled: intervalSeconds !== 0, async stop() { stopped = true; if (timer !== undefined) timers.clearInterval(timer); await inFlight; } };
}
