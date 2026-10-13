import assert from "node:assert/strict";
import test from "node:test";
import { startPublicationScheduler, validateSyncInterval } from "../src/publication-scheduler.mjs";
import { runPublicationSynchronization } from "../src/publication-operations.mjs";

test("automatic source synchronization is disabled unless an operator selects a bounded cadence", async () => {
  let intervals = 0, calls = 0;
  const scheduler = startPublicationScheduler({ synchronize: () => { calls++; }, timers: { setInterval() { intervals++; }, clearInterval() {} } });
  assert.equal(scheduler.enabled, false); assert.equal(intervals + calls, 0); await scheduler.stop();
  for (const value of [0, 60, 300, 86400]) assert.equal(validateSyncInterval(value), value);
  for (const value of [-1, 1, 59, 86401, 1.5, NaN]) assert.throws(() => validateSyncInterval(value), /interval/u);
});

test("selected scheduling never overlaps a sweep, stops cleanly and retains failed-sweep retry", async () => {
  let callback, cleared = false, calls = 0, errors = 0, release;
  const wait = new Promise((resolve) => { release = resolve; });
  const timers = { setInterval(fn, milliseconds) { assert.equal(milliseconds, 60000); callback = fn; return 1; }, clearInterval(timer) { assert.equal(timer, 1); cleared = true; } };
  const scheduler = startPublicationScheduler({ intervalSeconds: 60, synchronize: async () => { calls++; await wait; }, timers });
  callback(); callback(); await Promise.resolve(); assert.equal(calls, 1);
  let stopped = false; const stop = scheduler.stop().then(() => { stopped = true; }); await Promise.resolve(); assert.equal(cleared, true); assert.equal(stopped, false);
  release(); await stop; callback(); await Promise.resolve(); assert.equal(calls, 1);
  const retry = startPublicationScheduler({ intervalSeconds: 60, synchronize: () => { throw new Error("Synthetic failure"); }, onError: () => { errors++; }, timers });
  callback(); await new Promise((resolve) => setImmediate(resolve)); callback(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(errors, 2); await retry.stop();
});

test("long sweeps renew the same operation lease and cannot be reclaimed by a concurrent manual invocation", async () => {
  const state = { version: 1, posts: {}, presentations: {}, publications: {} }, store = { read: async () => structuredClone(state), update: async (callback) => callback(state) };
  let release; const wait = new Promise((resolve) => { release = resolve; });
  const bridge = { records: async () => { await wait; return { bridge_records: [], pagination: { page: 1, pages: 1, total: 0, snapshot: "one" } }; } };
  const sweep = runPublicationSynchronization({}, store, bridge, {}, { leaseMs: 90 }); await new Promise((resolve) => setTimeout(resolve, 140));
  const original = state.publication_sync.operation_id, started = state.publication_sync.started_at;
  await assert.rejects(runPublicationSynchronization({}, store, bridge, {}, { leaseMs: 90 }), /already running/u);
  assert.equal(state.publication_sync.operation_id, original); assert.equal(state.publication_sync.started_at, started); assert.ok(state.publication_sync.lease_until > Date.now());
  release(); assert.equal((await sweep).failed, 0); assert.equal(state.publication_sync.state, "complete"); assert.equal(state.publication_sync.operation_id, original);
});
