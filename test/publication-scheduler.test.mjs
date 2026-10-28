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

test("long V4 sweeps renew the same operation lease and cannot be reclaimed by concurrent manual invocation", async () => {
  const state = { version: 1, posts: {}, presentations: {}, publications: {} }, store = { read: async () => structuredClone(state), update: async (callback) => callback(state), withNativeLock: async (callback) => callback(async () => {}) };
  let release; const wait = new Promise((resolve) => { release = resolve; });
  const config = { serverUrl: "https://forum.example", ghostOrigin: "https://ghost.example", connectionId: "dbc_0123456789abcdef01234567" };
  const policy = { policy_revision: "policy", enabled: false, selection: "all_public", category_ids: [], include_topic_ids: [], exclude_topic_ids: [], include_unlisted: false, publication_kind: "dynamic", presentation_mode: "full", author_ids: [], taxonomy_ids: [] };
  const connection = { connection_id: config.connectionId, profile: "ghost", destination_origin: config.ghostOrigin, scope_revision: "scope", forum_name: "Forum", directions: ["from_discourse"], policy, publication_lane: "default", native_capabilities: { native_revision: "native", supported_presentations: ["full"], publication_kind: "dynamic", complete_content_supported: true } };
  const cmsClient = { connection: async () => { await wait; return structuredClone(connection); }, policy: async () => structuredClone(policy) };
  const sweep = runPublicationSynchronization(config, store, {}, {}, { leaseMs: 90, cmsClient }); await new Promise((resolve) => setTimeout(resolve, 140));
  const original = state.publication_sync.operation_id, started = state.publication_sync.started_at;
  await assert.rejects(runPublicationSynchronization(config, store, {}, {}, { leaseMs: 90, cmsClient }), /already running/u);
  assert.equal(state.publication_sync.operation_id, original); assert.equal(state.publication_sync.started_at, started); assert.ok(state.publication_sync.lease_until > Date.now());
  release(); assert.equal((await sweep).failed, 0); assert.equal(state.publication_sync.state, "complete"); assert.equal(state.publication_sync.operation_id, original);
});
