import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { BridgeClient, ghostRecord } from "../src/bridge-client.mjs";
import { StateStore } from "../src/state-store.mjs";
import { buildServer } from "../src/service.mjs";

async function config() {
  const root = await mkdtemp(join(tmpdir(), "ghost-discussionbridge-"));
  await writeFile(join(root, "secret"), "s".repeat(32));
  await writeFile(join(root, "webhook"), "w".repeat(32));
  return loadConfig({ DISCUSSIONBRIDGE_SERVER_URL: "https://forum.example", DISCUSSIONBRIDGE_CONNECTION_ID: "dbc_0123456789abcdef01234567", DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE: join(root, "secret"), DISCUSSIONBRIDGE_GHOST_ORIGIN: "https://ghost.example", DISCUSSIONBRIDGE_GHOST_WEBHOOK_TOKEN_FILE: join(root, "webhook"), DISCUSSIONBRIDGE_STATE_FILE: join(root, "state.json"), DISCUSSIONBRIDGE_LANE: "ghost-alpha" });
}

test("maps an authoritative published Ghost post", async () => {
  const cfg = await config();
  const record = ghostRecord({ post: { current: { id: "abc123", title: "Ghost article", url: "https://ghost.example/ghost-article/", status: "published" } } }, cfg, "correlation");
  assert.equal(record.external_id, "ghost-post:abc123");
  assert.equal(record.lane, "ghost-alpha");
  assert.throws(() => ghostRecord({ post: { current: { id: "x", title: "X", url: "https://evil.example/x/", status: "published" } } }, cfg, "c"), /outside/);
});

test("uses bounded credentialed requests without following redirects", async () => {
  const cfg = await config();
  let seen;
  const client = new BridgeClient(cfg, async (url, options) => { seen = { url, options }; return new Response(JSON.stringify({ outcome: "resolved" }), { status: 200, headers: { "Content-Type": "application/json" } }); });
  await client.resolve({ direction: "to_discourse" });
  assert.equal(seen.options.redirect, "error");
  assert.equal(seen.options.headers["X-DiscussionBridge-Secret"], "s".repeat(32));
});

test("webhook resolves once and persists no secret", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  const client = { resolve: async () => ({ outcome: "created", resource_id: "11111111-1111-4111-8111-111111111111", topic_id: 42, topic_url: "https://forum.example/t/x/42", core_fallback: false }) };
  const server = buildServer(cfg, store, client);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/ghost/${"w".repeat(32)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ post: { current: { id: "abc", title: "Article", url: "https://ghost.example/article/", status: "published" } } }) });
    assert.equal(response.status, 200);
    const state = JSON.stringify(await store.read());
    assert.match(state, /ghost-post:abc/);
    assert.doesNotMatch(state, new RegExp("s{32}|w{32}"));
  } finally { server.close(); }
});

test("presentation is allowlisted and sanitized", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  await store.write({ version: 1, posts: {}, presentations: { "11111111-1111-4111-8111-111111111111": { registered_at: "now" } } });
  const client = { record: async () => ({ direction: "from_discourse", resource_id: "11111111-1111-4111-8111-111111111111", cooked_html: '<p onclick="bad()">Safe</p><script>bad()</script>', topic_url: "https://forum.example/t/safe/1" }) };
  const server = buildServer(cfg, store, client);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/presentation/22222222-2222-4222-8222-222222222222`)).status, 404);
    const response = await fetch(`http://127.0.0.1:${address.port}/presentation/11111111-1111-4111-8111-111111111111`);
    const html = await response.text();
    assert.match(html, /Safe/);
    assert.doesNotMatch(html, /onclick|script/);
  } finally { server.close(); }
});

test("serialized state updates retain concurrent identities", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  await Promise.all(Array.from({ length: 12 }, (_, index) => store.update(async (state) => {
    await new Promise((resolve) => setTimeout(resolve, index % 3));
    state.posts[`ghost-post:${index}`] = { resource_id: String(index) };
  })));
  assert.equal(Object.keys((await store.read()).posts).length, 12);
});
