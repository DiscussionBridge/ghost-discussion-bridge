import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { CmsClient } from "../lib/cms-client.mjs";
import { cmsSchema } from "../lib/cms-runtime.mjs";
import { synchronizeCms } from "../src/cms-coordinator.mjs";
import { StateStore } from "../src/state-store.mjs";

// Real typed client, coordinator, codec and file-backed StateStore. Only HTTP
// responses are synthetic. Native work is forbidden and its budget is zero.
const config = {
  serverUrl: "https://forum.example", ghostOrigin: "https://ghost.example",
  connectionId: `dbc_${"a".repeat(24)}`, publicationType: "post",
};
const policy = {
  policy_revision: "policy-1", enabled: true, selection: "all_public",
  category_ids: [], include_topic_ids: [], exclude_topic_ids: [], include_unlisted: false,
  publication_kind: "dynamic", presentation_mode: "full", author_ids: [], taxonomy_ids: [],
};
const connection = {
  connection_id: config.connectionId, profile: "ghost", destination_origin: config.ghostOrigin,
  scope_revision: "scope-1", forum_name: "Feed fixture", directions: ["from_discourse"],
  policy, publication_lane: "default", native_capabilities: {
    native_revision: "capabilities-1", supported_presentations: ["simple", "full", "interactive"],
    publication_kind: "dynamic", complete_content_supported: true,
  },
};
const binding = {
  connection_id: config.connectionId, forum_origin: config.serverUrl,
  destination_origin: config.ghostOrigin, scope_revision: connection.scope_revision,
  policy_revision: policy.policy_revision,
};
const uuid = (id) => `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
const revoke = (id, sequence) => ({
  event_type: "revocation", event_id: uuid(id), event_sequence: String(sequence),
  source_id: `topic:${id}`, last_source_revision: "revision-1", reason: "source_ineligible",
});
const publish = (id, sequence) => ({
  event_type: "publication", event_id: uuid(id), event_sequence: String(sequence),
  source: {
    source_id: `topic:${id}`, source_revision: "revision-1", topic_id: String(id),
    topic_url: `${config.serverUrl}/t/source/${id}`, title: `Source ${id}`,
    content_sha256: "a".repeat(64), content_bytes: 20,
    source_created_at: null, source_updated_at: null, source_authors: [],
  },
});
const page = (items, checkpoint = "through-page", next = null, stream = "changes") => ({
  stream, items, next_cursor: next, checkpoint_cursor: checkpoint,
});

async function fixture(t, { initial = false, last = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "discussionbridge-ghost-feed-ordering-"));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("discussionbridge-ghost-feed-ordering-"));
    await rm(root, { recursive: true, force: true });
  });
  const file = join(root, "state.json");
  const store = new StateStore(file);
  await store.write({
    version: 1, posts: {}, presentations: {}, publications: {},
    cms_feed: {
      binding, initial_complete: !initial, next_cursor: null,
      checkpoint_cursor: initial ? null : "checkpoint-start", events: {}, sources: {},
      last_sequence: last, last_initial_source: null,
    },
  });
  const pages = [], queries = [], mappings = new Map();
  const client = new CmsClient({
    serviceOrigin: config.serverUrl, connectionId: config.connectionId,
    connectionSecret: "SYNTHETIC-FEED-TEST-SECRET",
  }, {
    fetchImplementation: async (address, options) => {
      const url = new URL(address);
      const route = cmsSchema.routes.find((item) => item.path === url.pathname);
      assert.ok(route, `Unexpected route ${url.pathname}`);
      assert.equal(options.method, route.method);
      let payload;
      if (route.id === "V4-01") payload = connection;
      else if (route.id === "V4-08") payload = policy;
      else if (route.id === "V4-06") {
        const expected = pages.shift();
        assert.ok(expected, "Unexpected extra feed poll");
        const query = Object.fromEntries(url.searchParams);
        queries.push(query);
        assert.deepEqual(query, expected.query);
        payload = expected.response;
      } else if (route.id === "V4-09") {
        const request = JSON.parse(options.body);
        if (!mappings.has(request.source_id)) mappings.set(request.source_id, mappings.size + 1000);
        const id = mappings.get(request.source_id);
        payload = {
          mapping_id: uuid(id), resource_id: uuid(id + 1000), connection_id: config.connectionId,
          source_id: request.source_id, external_id: request.external_id, mapping_revision: "mapping-1",
          destination_native_id: null, canonical_url: request.canonical_url, retired_url_count: 0,
          mapping_state: "pending", presentation_mode: policy.presentation_mode,
          desired_source_revision: request.source_revision, synchronized_source_revision: null,
          publicly_verified_source_revision: null, destination_native_revision: null,
          source_created_at: null, source_updated_at: null, synchronized_at: null, publicly_verified_at: null,
        };
      } else assert.fail(`Unexpected non-feed operation ${route.id}`);
      const response = new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
      Object.defineProperty(response, "url", { value: address });
      return response;
    },
  });
  const native = new Proxy({}, { get(_target, key) { assert.fail(`Native operation forbidden: ${String(key)}`); } });
  return {
    file, store, queries,
    enqueue(query, response) { pages.push({ query, response }); },
    async run({ reload = false, maximumPages = 1 } = {}) {
      const result = await synchronizeCms(config, reload ? new StateStore(file) : store, client, native, { maximumPages, maximumWork: 0 });
      assert.equal(pages.length, 0, "All expected feed pages must be consumed");
      return result;
    },
  };
}

test("Ghost increasing changes persist the sequence and both cursors across a fresh StateStore", async (t) => {
  const f = await fixture(t);
  f.enqueue({ stream: "changes", cursor: "checkpoint-start" }, page([revoke(1, "10"), revoke(2, "11")], "through-11", "page-two"));
  await f.run();
  let state = await new StateStore(f.file).read();
  assert.equal(state.cms_feed.last_sequence, "11");
  assert.equal(state.cms_feed.next_cursor, "page-two");
  assert.equal(state.cms_feed.checkpoint_cursor, "through-11");
  f.enqueue({ stream: "changes", cursor: "page-two" }, page([revoke(3, "12")], "through-12"));
  await f.run({ reload: true });
  state = await new StateStore(f.file).read();
  assert.equal(state.cms_feed.last_sequence, "12");
  assert.equal(state.cms_feed.next_cursor, null);
  assert.equal(state.cms_feed.checkpoint_cursor, "through-12");
  assert.equal(Object.keys(state.cms_feed.events).length, 3);
});

for (const [name, sequences] of [
  ["equal", ["11", "11"]], ["descending", ["12", "11"]],
  ["descending above 2^53", ["9007199254740993", "9007199254740992"]],
  ["descending at signed-64 ceiling", ["9223372036854775807", "9223372036854775806"]],
]) {
  test(`Ghost rejects ${name} unseen changes without committing any page entry or checkpoint`, async (t) => {
    const f = await fixture(t, { last: "10" });
    const before = await readFile(f.file, "utf8");
    f.enqueue({ stream: "changes", cursor: "checkpoint-start" }, page(sequences.map((seq, index) => revoke(index + 1, seq)), "must-not-commit"));
    await assert.rejects(f.run(), /change sequence did not advance/);
    assert.equal(await readFile(f.file, "utf8"), before);
    f.enqueue({ stream: "changes", cursor: "checkpoint-start" }, page([revoke(1, "11"), revoke(2, "12")], "through-12"));
    await f.run({ reload: true });
    const state = await new StateStore(f.file).read();
    assert.equal(state.cms_feed.last_sequence, "12");
    assert.equal(Object.keys(state.cms_feed.events).length, 2);
  });
}

for (const sequence of ["10", "9"]) {
  test(`Ghost rejects unseen sequence ${sequence} on the next page after durable sequence 10`, async (t) => {
    const f = await fixture(t);
    f.enqueue({ stream: "changes", cursor: "checkpoint-start" }, page([revoke(1, "10")], "through-10", "page-two"));
    await f.run();
    const before = await readFile(f.file, "utf8");
    f.enqueue({ stream: "changes", cursor: "page-two" }, page([revoke(2, sequence)], "must-not-commit"));
    await assert.rejects(f.run({ reload: true }), /change sequence did not advance/);
    assert.equal(await readFile(f.file, "utf8"), before);
    f.enqueue({ stream: "changes", cursor: "page-two" }, page([revoke(2, "11")], "through-11"));
    await f.run({ reload: true });
    assert.equal((await f.store.read()).cms_feed.last_sequence, "11");
  });
}

for (const sequences of [
  ["9007199254740992", "9007199254740993"],
  ["9223372036854775806", "9223372036854775807"],
]) {
  test(`Ghost compares adjacent decimal strings ${sequences.join(" -> ")} exactly`, async (t) => {
    const f = await fixture(t);
    f.enqueue({ stream: "changes", cursor: "checkpoint-start" }, page([revoke(1, sequences[0])], "through-first"));
    await f.run();
    f.enqueue({ stream: "changes", cursor: "through-first" }, page([revoke(2, sequences[1])], "through-second"));
    await f.run({ reload: true });
    const state = await f.store.read();
    assert.equal(state.cms_feed.last_sequence, sequences[1]);
    assert.equal(state.cms_feed.events[uuid(1)].event.event_sequence, sequences[0]);
  });
}

test("Ghost exact known replay is harmless even after a new event; it does not lower the sequence floor", async (t) => {
  const f = await fixture(t), old = revoke(1, "10");
  f.enqueue({ stream: "changes", cursor: "checkpoint-start" }, page([old], "through-10"));
  await f.run();
  // Preserve Ghost's existing identity-based replay exception. This deliberately
  // does not impose Astro's stricter raw-page-order rule on this consumer.
  f.enqueue({ stream: "changes", cursor: "through-10" }, page([revoke(2, "12"), structuredClone(old), structuredClone(old)], "through-12"));
  await f.run({ reload: true });
  const state = await f.store.read();
  assert.equal(state.cms_feed.last_sequence, "12");
  assert.equal(Object.keys(state.cms_feed.events).length, 2);
  assert.deepEqual(state.cms_feed.events[uuid(1)].event, old);
});

test("Ghost changed replay after a valid new event rejects the entire page and permits clean restart", async (t) => {
  const f = await fixture(t), old = revoke(1, "10");
  f.enqueue({ stream: "changes", cursor: "checkpoint-start" }, page([old], "through-10"));
  await f.run();
  const before = await readFile(f.file, "utf8");
  f.enqueue({ stream: "changes", cursor: "through-10" }, page([revoke(2, "11"), { ...old, last_source_revision: "changed-revision" }], "must-not-commit"));
  await assert.rejects(f.run({ reload: true }), /replayed event identity changed/);
  assert.equal(await readFile(f.file, "utf8"), before);
  f.enqueue({ stream: "changes", cursor: "through-10" }, page([revoke(2, "11")], "through-11"));
  await f.run({ reload: true });
  assert.equal((await f.store.read()).cms_feed.last_sequence, "11");
});

test("Ghost rejects event-ID reuse with a different increasing sequence", async (t) => {
  const f = await fixture(t), first = revoke(1, "10");
  const before = await readFile(f.file, "utf8");
  f.enqueue({ stream: "changes", cursor: "checkpoint-start" }, page([first, { ...first, event_sequence: "11" }], "must-not-commit"));
  await assert.rejects(f.run(), /replayed event identity changed/);
  assert.equal(await readFile(f.file, "utf8"), before);
});

test("Ghost accepts source-ordered initial pages with decreasing event sequences, then resumes changes", async (t) => {
  const f = await fixture(t, { initial: true });
  f.enqueue({ stream: "initial" }, page([publish(1, "20")], null, "initial-two", "initial"));
  await f.run();
  f.enqueue({ stream: "initial", cursor: "initial-two" }, page([publish(2, "10")], "snapshot-horizon-20", null, "initial"));
  await f.run({ reload: true });
  let state = await f.store.read();
  assert.equal(state.cms_feed.initial_complete, true);
  assert.equal(state.cms_feed.last_sequence, null);
  assert.equal(state.cms_feed.checkpoint_cursor, "snapshot-horizon-20");
  assert.equal(Object.keys(state.cms_feed.events).length, 2);
  f.enqueue({ stream: "changes", cursor: "snapshot-horizon-20" }, page([revoke(3, "21")], "through-21"));
  await f.run({ reload: true });
  state = await f.store.read();
  assert.equal(state.cms_feed.last_sequence, "21");
});

test("Ghost empty initial completion and empty changes preserve opaque horizon checkpoints across reload", async (t) => {
  const f = await fixture(t, { initial: true });
  f.enqueue({ stream: "initial" }, page([], "empty-snapshot-horizon", null, "initial"));
  await f.run();
  f.enqueue({ stream: "changes", cursor: "empty-snapshot-horizon" }, page([], "new-empty-horizon"));
  await f.run({ reload: true });
  const state = await f.store.read();
  assert.equal(state.cms_feed.initial_complete, true);
  assert.equal(state.cms_feed.checkpoint_cursor, "new-empty-horizon");
  assert.equal(state.cms_feed.last_sequence, null);
  assert.deepEqual(state.cms_feed.events, {});
});
