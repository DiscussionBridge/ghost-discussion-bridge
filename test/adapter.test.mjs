import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { BridgeClient, ghostRecord } from "../src/bridge-client.mjs";
import { StateStore } from "../src/state-store.mjs";
import { buildServer, exactGhostSource, validGhostSignature } from "../src/service.mjs";

async function config() {
  const root = await mkdtemp(join(tmpdir(), "ghost-discussionbridge-"));
  await writeFile(join(root, "secret"), "s".repeat(32));
  await writeFile(join(root, "webhook"), "w".repeat(32));
  return loadConfig({ DISCUSSIONBRIDGE_SERVER_URL: "https://forum.example", DISCUSSIONBRIDGE_CONNECTION_ID: "dbc_0123456789abcdef01234567", DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE: join(root, "secret"), DISCUSSIONBRIDGE_GHOST_ORIGIN: "https://ghost.example", DISCUSSIONBRIDGE_GHOST_WEBHOOK_SECRET_FILE: join(root, "webhook"), DISCUSSIONBRIDGE_STATE_FILE: join(root, "state.json"), DISCUSSIONBRIDGE_LANE: "ghost-alpha" });
}

test("maps an authoritative published Ghost post and its authors", async () => {
  const cfg = await config();
  const record = ghostRecord({ post: { current: { id: "abc123", title: "Ghost article", html: "<p>Useful Ghost content.</p>", url: "https://ghost.example/ghost-article/", status: "published", tags: [{ name: "#discussionbridge", slug: "hash-discussionbridge" }], authors: [{ id: "author-1", name: "Primary Writer", url: "https://ghost.example/author/primary/" }, { id: "author-2", name: "Editor" }], primary_author: { id: "author-1" } } } }, cfg, "correlation");
  assert.equal(record.content_html, "<p>Useful Ghost content.</p>");
  assert.equal(record.external_id, "ghost-post:abc123");
  assert.equal(record.lane, "ghost-alpha");
  assert.equal(record.adapter_id, "ghost-discussion-bridge");
  assert.equal(record.adapter_version, "0.1.0-alpha.17");
  assert.deepEqual(record.source_authors, [
    { id: "ghost-author:author-1", name: "Primary Writer", profile_url: "https://ghost.example/author/primary/" },
    { id: "ghost-author:author-2", name: "Editor" },
  ]);
  assert.equal(record.primary_source_author_id, "ghost-author:author-1");
  assert.throws(() => ghostRecord({ post: { current: { id: "x", title: "X", html: "<p>X</p>", url: "https://evil.example/x/", status: "published", tags: [{ name: "#discussionbridge" }] } } }, cfg, "c"), /outside/);
  assert.throws(() => ghostRecord({ post: { current: { id: "x", title: "X", html: "<p>X</p>", url: "https://ghost.example/x/", status: "published", tags: [] } } }, cfg, "c"), /opted in/);
  assert.throws(() => ghostRecord({ post: { current: { id: "x", title: "X", html: "  ", url: "https://ghost.example/x/", status: "published", tags: [{ name: "#discussionbridge" }] } } }, cfg, "c"), /published content/);
  assert.throws(() => ghostRecord({ post: { current: { id: "x", title: "X", html: "x".repeat((48 * 1024) + 1), url: "https://ghost.example/x/", status: "published", tags: [{ name: "#discussionbridge" }] } } }, cfg, "c"), /published content/);
});

test("fails closed on ambiguous Ghost authorship", async () => {
  const cfg = await config();
  const base = { id: "abc123", title: "Ghost article", html: "<p>Useful Ghost content.</p>", url: "https://ghost.example/ghost-article/", status: "published", tags: [{ name: "#discussionbridge" }] };
  assert.throws(() => ghostRecord({ post: { current: { ...base, authors: [] } } }, cfg, "c"), /Ghost authors/);
  assert.throws(() => ghostRecord({ post: { current: { ...base, authors: [{ id: "one", name: "One" }, { id: "one", name: "Duplicate" }] } } }, cfg, "c"), /Duplicate/);
  assert.throws(() => ghostRecord({ post: { current: { ...base, authors: [{ id: "one", name: "One" }], primary_author: { id: "two" } } } }, cfg, "c"), /not present/);
  assert.throws(() => ghostRecord({ post: { current: { ...base, authors: [{ id: "one", name: "One", url: "https://outside.example/author/one/" }] } } }, cfg, "c"), /outside/);
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
    const body = JSON.stringify({ post: { current: { id: "abc", title: "Article", html: "<p>Webhook article content.</p>", url: "https://ghost.example/article/", status: "published", tags: [{ name: "#discussionbridge" }] } } });
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", "w".repeat(32)).update(`${body}${timestamp}`).digest("hex");
    const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/ghost`, { method: "POST", headers: { "Content-Type": "application/json", "X-Ghost-Signature": `sha256=${signature}, t=${timestamp}` }, body });
    assert.equal(response.status, 200);
    const state = JSON.stringify(await store.read());
    assert.match(state, /ghost-post:abc/);
    assert.doesNotMatch(state, new RegExp("s{32}|w{32}"));
  } finally { server.close(); }
});

test("Ghost signature is exact and time bounded", () => {
  const body = '{"event":"post.published"}';
  const secret = "w".repeat(32);
  const now = 1_780_000_000_000;
  const signature = createHmac("sha256", secret).update(`${body}${now}`).digest("hex");
  assert.equal(validGhostSignature(`sha256=${signature}, t=${now}`, body, secret, now), true);
  assert.equal(validGhostSignature(`sha256=${signature}, t=${now}`, `${body} `, secret, now), false);
  assert.equal(validGhostSignature(`sha256=${signature}, t=${now}`, body, secret, now + 300_001), false);
});

test("presentation is allowlisted and sanitized", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  await store.write({ version: 1, posts: {}, presentations: { "11111111-1111-4111-8111-111111111111": { registered_at: "now" } } });
  const client = { record: async () => ({ bridge_record: { direction: "from_discourse", state: "healthy", resource_id: "11111111-1111-4111-8111-111111111111", content_html: '<p onclick="bad()">Safe</p><span class="math evil">E = mc^2</span><div class="math">x^2</div><div class="lightbox-wrapper"><a href="https://forum.example/image.svg"><img src="https://forum.example/image.svg" alt="Diagram"><div class="meta"><span>Diagram</span><span>960×320 1.71 KB</span></div></a></div><script>bad()</script>', topic_id: 1, topic_url: "https://forum.example/t/safe/1" } }) };
  const server = buildServer(cfg, store, client);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/presentation/22222222-2222-4222-8222-222222222222`)).status, 404);
    const response = await fetch(`http://127.0.0.1:${address.port}/presentation/11111111-1111-4111-8111-111111111111`);
    const html = await response.text();
    assert.match(html, /Safe/);
    assert.doesNotMatch(html, /onclick|script/);
    assert.match(html, /<span class="math">E = mc\^2<\/span>/);
    assert.match(html, /<div class="math">x\^2<\/div>/);
    assert.doesNotMatch(html, /class="[^"]*evil/);
    assert.match(html, /<img src="https:\/\/forum\.example\/image\.svg" alt="Diagram" \/>/);
    assert.doesNotMatch(html, /960×320 1\.71 KB/);
    assert.match(html, /<h2>Discussion<\/h2>/);
    assert.match(html, />Open discussion<\/a>/);
    assert.match(html, /data-discussionbridge-presentation-comments/);
    assert.match(html, /data-topic-id="1"/);
    assert.match(html, /data-topic-url="https:\/\/forum\.example\/t\/safe\/1"/);
  } finally { server.close(); }
});

test("comments lookup exposes only an exact stored Ghost mapping", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  await store.write({ version: 1, posts: { "ghost-post:abc": { resource_id: "11111111-1111-4111-8111-111111111111", topic_id: 42, topic_url: "https://forum.example/t/ghost/42", canonical_url: "https://ghost.example/article/" } }, presentations: {} });
  const server = buildServer(cfg, store, {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/comments?source=${encodeURIComponent("https://ghost.example/article/")}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { topic_id: 42, topic_url: "https://forum.example/t/ghost/42", forum_origin: "https://forum.example" });
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/comments?source=${encodeURIComponent("https://ghost.example/missing/")}`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/comments?source=${encodeURIComponent("https://evil.example/article/")}`)).status, 502);
  } finally { server.close(); }
});

test("Ghost comment source is exact-origin and canonical", () => {
  assert.equal(exactGhostSource("https://ghost.example/article/", "https://ghost.example"), "https://ghost.example/article/");
  assert.throws(() => exactGhostSource("https://evil.example/article/", "https://ghost.example"));
  assert.throws(() => exactGhostSource("https://ghost.example/article/?draft=1", "https://ghost.example"));
  assert.throws(() => exactGhostSource("https://ghost.example/article/#comments", "https://ghost.example"));
});

test("reader loader offers only standard and fullInteractive mapped comments", async () => {
  const loader = await readFile(new URL("../src/browser-loader.mjs", import.meta.url), "utf8");
  assert.match(loader, /\["full", "fullInteractive"\]/);
  assert.match(loader, /fullApp: true/);
  assert.match(loader, /embedHeight: "800px"/);
  assert.match(loader, /dynamicHeight: false/);
  assert.match(loader, /embedMinHeight: "360"/);
  assert.match(loader, /aria-label", "On this page"/);
  assert.match(loader, /installContents\(target\)/);
  assert.match(loader, /installContents\(article\)/);
  assert.match(loader, /topicId: record\.topic_id/);
  assert.match(loader, /heading\.textContent = "Discussion"/);
  assert.match(loader, /link\.textContent = "Open discussion"/);
  assert.match(loader, /link\.href = record\.topic_url/);
  assert.match(loader, /mermaid\.run/);
  assert.match(loader, /katex\.render/);
  assert.match(loader, /querySelectorAll\("\.math"\)/);
  assert.match(loader, /displayMode: element\.tagName === "DIV"/);
  assert.match(loader, /data-discussionbridge-presentation-comments/);
  assert.match(loader, /installInteractiveDiscussion\(discussion/);
  assert.match(loader, /false, true\)/);
  assert.match(loader, /className: "discussion-bridge-source-presentation"/);
  assert.match(loader, /installInteractiveDiscussion\(target, record\)/);
  assert.match(loader, /\/discussionbridge\/assets\/loader\.css/);
  assert.doesNotMatch(loader, /connectionSecret|X-DiscussionBridge-Secret/);
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
