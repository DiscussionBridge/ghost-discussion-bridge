import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { buildServer } from "../src/service.mjs";
import { operatorCsrfToken } from "../src/operator-surface.mjs";

const nativeId = "0123456789abcdef01234567", resourceId = "11111111-1111-4111-8111-111111111111", topicId = "9223372036854775807";
const config = { ghostOrigin: "https://ghost.example", serverUrl: "https://forum.example", adapterOrigin: "https://adapter.example", operatorOrigin: "https://adapter.example", operatorPassword: "p".repeat(32), webhookSecret: "s".repeat(32) };
const topicUrl = `${config.serverUrl}/t/native/${topicId}`;
async function withServer(state, client, operations, run) {
  const server = buildServer(config, { read: async () => structuredClone(state) }, client, operations);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { const closed = new Promise((resolve) => server.close(resolve)); server.closeAllConnections(); await closed; }
}
const state = () => ({ version: 1, posts: {}, publications: {}, presentations: {} });

test("current native comments mapping preserves exact CoreId and asset bytes are freshly built", async () => {
  const current = state(); current.posts[`ghost-post:${nativeId}`] = { canonical_url: `${config.ghostOrigin}/source/`, resource_id: resourceId, topic_id: topicId, topic_url: topicUrl };
  await withServer(current, {}, {}, async (address) => {
    const result = await fetch(`${address}/comments?source=${encodeURIComponent(`${config.ghostOrigin}/source/`)}`, { headers: { Origin: config.ghostOrigin } });
    assert.equal(result.status, 200); assert.deepEqual(await result.json(), { topic_id: topicId, topic_url: topicUrl, forum_origin: config.serverUrl });
    assert.equal((await fetch(`${address}/comments?source=${encodeURIComponent(`${config.ghostOrigin}/source/`)}`, { headers: { Origin: "https://other.example" } })).status, 403);
    const asset = await fetch(`${address}/assets/loader.js`); assert.equal(asset.status, 200); assert.match(asset.headers.get("etag"), /^"[a-f0-9]{64}"$/u); assert.match(await asset.text(), /discourse/u);
  });
});

test("registered native presentation remains available with exact CoreId via current reader callback", async () => {
  const current = state(); current.presentations[resourceId] = { registered_at: "2026-10-14T00:00:00.000Z" };
  let status = "active", calls = 0, content = "<p>Native publication</p><pre><code>&lt;script&gt;example()&lt;/script&gt;</code></pre>";
  await withServer(current, {}, { readPresentation: async (id) => { assert.equal(id, resourceId); calls++; return { resource_id: id, direction: "from_discourse", state: status, presentation_mode: "full", topic_id: topicId, topic_url: topicUrl, content_html: content }; } }, async (address) => {
    const result = await fetch(`${address}/presentation/${resourceId}`); assert.equal(result.status, 200);
    const html = await result.text(); assert.match(html, /Native publication/u); assert.match(html, new RegExp(`data-topic-id="${topicId}"`, "u")); assert.match(html, /&lt;script&gt;example\(\)&lt;\/script&gt;/u);
    content = "<p>Native publication</p><script>calculate()</script>";
    assert.equal((await fetch(`${address}/presentation/${resourceId}`)).status, 502);
    status = "withdrawn"; assert.equal((await fetch(`${address}/presentation/${resourceId}`)).status, 410); assert.equal(calls, 3);
  });
});

test("signed native webhook passes only actual native identity to the current source engine", async () => {
  const current = state(), ids = [];
  await withServer(current, {}, { publishNativeSource: async (id) => { ids.push(id); return { resource_id: resourceId, topic_id: topicId, state: "withdrawn" }; } }, async (address) => {
    const send = async (post, valid = true) => {
      const raw = JSON.stringify({ post: { current: post } }), now = String(Date.now());
      const digest = createHmac("sha256", config.webhookSecret).update(`${raw}${now}`).digest("hex");
      return fetch(`${address}/webhooks/ghost`, { method: "POST", body: raw, headers: { "Content-Type": "application/json", "X-Ghost-Signature": `sha256=${valid ? digest : "0".repeat(64)}, t=${now}` } });
    };
    assert.equal((await send({ id: nativeId, type: "post", status: "published" }, false)).status, 404);
    const result = await send({ id: nativeId, type: "post", status: "draft", html: "stale notification body" });
    assert.equal(result.status, 200); assert.equal((await result.json()).outcome, "withdrawn"); assert.deepEqual(ids, [nativeId]);
    assert.equal((await send({ id: nativeId, tags: [{ name: "#discussionbridge-source" }] })).status, 502); assert.equal(ids.length, 1);
  });
});

test("single protected stop action remains while removed protocol/profile/init routes have no fallback", async () => {
  const current = state(); current.posts[`ghost-post:${nativeId}`] = { cms_source: { accepted_revision: "accepted" } };
  let calls = 0;
  await withServer(current, {}, { stopSourceDelivery: async (id) => { assert.equal(id, nativeId); calls++; } }, async (address) => {
    const auth = `Basic ${Buffer.from(`discussionbridge:${config.operatorPassword}`).toString("base64")}`;
    const form = () => new URLSearchParams({ csrf: operatorCsrfToken(config.operatorPassword), native_id: nativeId });
    const submit = (body, headers = {}) => fetch(`${address}/operator/stop-source`, { method: "POST", redirect: "manual", body, headers: { Authorization: auth, Origin: config.operatorOrigin, "Content-Type": "application/x-www-form-urlencoded", ...headers } });
    assert.equal((await submit(form(), { Authorization: "" })).status, 401);
    const extra = form(); extra.append("reason", "source_deleted"); assert.equal((await submit(extra)).status, 400); assert.equal(calls, 0);
    assert.equal((await submit(form())).status, 303); assert.equal(calls, 1);
    const page = await fetch(`${address}/operator/`, { headers: { Authorization: auth } }); const html = await page.text();
    assert.match(html, /Stop source delivery/u); assert.doesNotMatch(html, /initialize-source|source-profile/u);
    for (const route of ["/operator/initialize-source", "/operator/source-profile", "/discussion-bridge/v1/connection.json", "/discussion-bridge/v2/connection.json"]) assert.equal((await fetch(`${address}${route}`, { headers: { Authorization: auth } })).status, 404);
  });
});
