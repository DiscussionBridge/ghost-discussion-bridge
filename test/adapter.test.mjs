import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { BridgeClient, ghostRecord } from "../src/bridge-client.mjs";
import { ghostAdminToken } from "../src/ghost-admin-client.mjs";
import { mergeCodeInjection } from "../src/install-rich-content.mjs";
import { nativePublication, syncPublications } from "../src/publication-sync.mjs";
import { StateStore } from "../src/state-store.mjs";
import { buildServer, exactGhostSource, renderSimpleDiscussion, validGhostSignature } from "../src/service.mjs";
import { PRODUCT_VERSION } from "../src/version.mjs";

const execFileAsync = promisify(execFile);

test("package, shrinkwrap, and runtime versions are identical", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const shrinkwrap = JSON.parse(await readFile(new URL("../npm-shrinkwrap.json", import.meta.url), "utf8"));
  assert.equal(pkg.version, PRODUCT_VERSION);
  assert.equal(shrinkwrap.version, PRODUCT_VERSION);
  assert.equal(shrinkwrap.packages[""].version, PRODUCT_VERSION);
});

test("rich-content code injection is additive and idempotent", () => {
  const script = mergeCodeInjection(null);
  assert.match(script, /data-discussionbridge-comments-bootstrap/);
  assert.match(script, /tag-hash-discussionbridge-source/);
  assert.match(script, /if \(!connectedPost && !sourcePost\) return/);
  assert.match(script, /let host = document\.querySelector\("\[data-discussionbridge-comments-host\]"\)/);
  assert.match(script, /host = document\.createElement\("section"\)/);
  assert.doesNotMatch(script, /querySelector\("\.gh-comments"\)/);
  assert.match(script, /discussionbridge-comments-host/);
  assert.match(script, /0\.1\.0-alpha\.33/);
  assert.equal(mergeCodeInjection("<meta name=demo>"), `<meta name=demo>\n${script}`);
  assert.equal(mergeCodeInjection(script), script);
  const upgraded = mergeCodeInjection(script.replace("0.1.0-alpha.33", "0.1.0-alpha.23"));
  assert.match(upgraded, /0\.1\.0-alpha\.33/);
  assert.doesNotMatch(upgraded, /0\.1\.0-alpha\.23/);
  assert.equal((upgraded.match(/data-discussionbridge-comments-bootstrap/g) ?? []).length, 1);
  assert.throws(() => mergeCodeInjection({}), /Invalid Ghost code injection setting/);
});

test("demo navigation adds Read more and the complete community footer", async () => {
  const navigation = await readFile(new URL("../demo/ghost-demo-navigation.js", import.meta.url), "utf8");
  assert.match(navigation, /page-template/);
  assert.match(navigation, /heading\.textContent\?\.trim\(\) === "Read more"/);
  assert.match(navigation, /data-discussionbridge-read-more/);
  assert.match(navigation, /inner\.style\.display = "block"/);
  assert.match(navigation, /page-ghost-demos/);
  assert.match(navigation, /discussionbridge-demo-index/);
  assert.match(navigation, /\.gh-footer/);
  assert.match(navigation, /data-discussionbridge-social-links/);
  assert.match(navigation, /https:\/\/forum\.discussionbridge\.dev\//);
  assert.match(navigation, /https:\/\/github\.com\/DiscussionBridge/);
  assert.match(navigation, /https:\/\/bsky\.app\/profile\/discussionbridge\.bsky\.social/);
  assert.match(navigation, /https:\/\/discord\.gg\/Y7SRQAxKq/);
  assert.match(navigation, /https:\/\/mastodon\.social\/@DiscussionBridge/);
  assert.match(navigation, /https:\/\/www\.reddit\.com\/r\/DiscussionBridge\//);
  assert.match(navigation, /https:\/\/www\.youtube\.com\/@DiscussionBridge/);
  assert.match(navigation, /\["X", "https:\/\/x\.com\/DiscussBridge"/);
  assert.match(navigation, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "svg"\)/);
  assert.match(navigation, /\/from-the-bridge\//);
  assert.match(navigation, /\/ghost-simple-comments\//);
  assert.match(navigation, /\/ghost-full-comments\//);
  assert.match(navigation, /\/the-bridge-publishes-everywhere\//);
  const page = await readFile(new URL("../demo/ghost-demos-page.html", import.meta.url), "utf8");
  assert.equal((page.match(/discussionbridge-demo-index__card/g) ?? []).length, 5);
  assert.doesNotMatch(page, /Connected publishing|ghost-publishing-connected-to-discourse/u);
  assert.match(page, /Publishing through The Bridge/);
  assert.match(page, /The Bridge — Discourse as Publisher/);
});

async function config() {
  const root = await mkdtemp(join(tmpdir(), "ghost-discussionbridge-"));
  await writeFile(join(root, "secret"), "s".repeat(32));
  await writeFile(join(root, "webhook"), "w".repeat(32));
  await writeFile(join(root, "admin-key"), `${"a".repeat(24)}:${"b".repeat(64)}`);
  return loadConfig({ DISCUSSIONBRIDGE_SERVER_URL: "https://forum.example", DISCUSSIONBRIDGE_CONNECTION_ID: "dbc_0123456789abcdef01234567", DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE: join(root, "secret"), DISCUSSIONBRIDGE_GHOST_ORIGIN: "https://ghost.example", DISCUSSIONBRIDGE_GHOST_WEBHOOK_SECRET_FILE: join(root, "webhook"), DISCUSSIONBRIDGE_GHOST_ADMIN_API_KEY_FILE: join(root, "admin-key"), DISCUSSIONBRIDGE_STATE_FILE: join(root, "state.json"), DISCUSSIONBRIDGE_LANE: "ghost-alpha" });
}

test("maps an authoritative published Ghost post and its authors", async () => {
  const cfg = await config();
  const record = ghostRecord({ post: { current: { id: "abc123", title: "Ghost article", html: "<p>Useful Ghost content.</p>", url: "https://ghost.example/ghost-article/", status: "published", tags: [{ name: "#discussionbridge", slug: "hash-discussionbridge" }], authors: [{ id: "author-1", name: "Primary Writer", url: "https://ghost.example/author/primary/" }, { id: "author-2", name: "Editor" }], primary_author: { id: "author-1" } } } }, cfg, "correlation");
  assert.equal(record.content_html, "<p>Useful Ghost content.</p>");
  assert.equal(record.external_id, "ghost-post:abc123");
  assert.equal(record.lane, "ghost-alpha");
  assert.equal(record.adapter_id, "ghost-discussion-bridge");
  assert.equal(record.adapter_version, "0.1.0-alpha.33");
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

test("reads the exact public Discourse branding setting from the browser bootstrap", async () => {
  const cfg = await config();
  let seen;
  const settings = JSON.stringify({ enable_powered_by_discourse: true });
  const preload = JSON.stringify({ siteSettings: settings });
  const client = new BridgeClient(cfg, async (url, options) => {
    seen = { url, options };
    return new Response(`<script type="application/json" id="data-preloaded">${preload}</script>`, { status: 200, headers: { "Content-Type": "text/html" } });
  });
  assert.equal(await client.publicPoweredByDiscourse(), true);
  assert.equal(seen.url, "https://forum.example/");
  assert.match(seen.options.headers["User-Agent"], /^Mozilla\/5\.0/);
  assert.equal(Object.hasOwn(seen.options.headers, "X-DiscussionBridge-Secret"), false);
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
  await store.write({ version: 1, posts: { "ghost-post:abc": { resource_id: "11111111-1111-4111-8111-111111111111", topic_id: 42, topic_url: "https://forum.example/t/ghost/42", canonical_url: "https://ghost.example/article/" } }, presentations: {}, publications: { "22222222-2222-4222-8222-222222222222": { topic_id: 53, topic_url: "https://forum.example/t/native/53", canonical_url: "https://ghost.example/native/" } } });
  const server = buildServer(cfg, store, {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/comments?source=${encodeURIComponent("https://ghost.example/article/")}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { topic_id: 42, topic_url: "https://forum.example/t/ghost/42", forum_origin: "https://forum.example" });
    const native = await fetch(`http://127.0.0.1:${address.port}/comments?source=${encodeURIComponent("https://ghost.example/native/")}`);
    assert.equal(native.status, 200);
    assert.deepEqual(await native.json(), { topic_id: 53, topic_url: "https://forum.example/t/native/53", forum_origin: "https://forum.example" });
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

test("reader loader offers simple, standard, and fullInteractive mapped comments", async () => {
  const loader = await readFile(new URL("../src/browser-loader.mjs", import.meta.url), "utf8");
  assert.match(loader, /\["simple", "full", "fullInteractive"\]/);
  assert.match(loader, /\/discussionbridge\/simple\?source=/);
  assert.match(loader, /fullApp: true/);
  assert.match(loader, /embedHeight: "800px"/);
  assert.match(loader, /dynamicHeight: false/);
  assert.match(loader, /embedMinHeight: "360"/);
  assert.match(loader, /aria-label", "On this page"/);
  assert.match(loader, /const nativeArticle = document\.querySelector\("\.gh-content"\)/);
  assert.match(loader, /tag-hash-discussionbridge-source/);
  assert.match(loader, /installContents\(target\)/);
  assert.match(loader, /installContents\(nativeArticle\)/);
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
  assert.match(loader, /installBridgeCredit\(target\)/);
  assert.match(loader, /discussionbridge-comments-host \.discussionbridge-powered-by/);
  assert.match(loader, /\.gh-content \.discussionbridge-credit/);
  assert.match(loader, /\.gh-content \.discussionbridge-credit__brand:visited/);
  assert.match(loader, /discussionbridge-comments-host \.discussionbridge-credit__brand:visited/);
  assert.match(loader, /discussionbridgeCommentsMounted/);
  assert.match(loader, /discussionbridgePresentationMounted/);
  assert.match(loader, /\/discussionbridge\/assets\/loader\.css/);
  assert.match(loader, /font-size:14px/);
  assert.doesNotMatch(loader, /connectionSecret|X-DiscussionBridge-Secret/);
});

test("simple comments fetch bounded missing batches and disclose replies after five", async () => {
  const posts = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    post_number: index + 1,
    username: `user${index + 1}`,
    name: `Demo ${index + 1}`,
    cooked: index === 7 ? '<p>Safe final reply</p><script>bad()</script>' : `<p>Reply ${index + 1}</p>`,
    created_at: "2026-08-31T12:00:00.000Z",
    avatar_template: `/user_avatar/forum.example/user${index + 1}/{size}/1.png`,
  }));
  const batches = [];
  const client = {
    publicTopic: async () => ({ slug: "ghost-demo", post_stream: { stream: posts.map(({ id }) => id), posts: posts.slice(0, 3) } }),
    publicPoweredByDiscourse: async () => true,
    publicTopicPosts: async (_topicId, ids) => {
      batches.push(ids);
      return { post_stream: { posts: posts.filter(({ id }) => ids.includes(id)) } };
    },
  };
  const html = await renderSimpleDiscussion(client, 42, "https://forum.example");
  assert.deepEqual(batches, [[4, 5, 6, 7, 8]]);
  assert.match(html, /<h2>Comments<\/h2>/);
  assert.match(html, /Show 2 more comments/);
  assert.match(html, /Safe final reply/);
  assert.match(html, /Powered by Discourse/);
  assert.match(html, /discussionbridge-powered-by__wordmark/);
  assert.match(html, /<span class="discussionbridge-credit__prefix">Connected by<\/span>/);
  assert.match(html, /class="discussionbridge-credit__brand" href="https:\/\/discussionbridge\.dev\/"/);
  assert.doesNotMatch(html, /<script>|bad\(\)/);
  assert.doesNotMatch(html, /Reply 1/);
});

test("separate StateStore instances retain concurrent identities", async () => {
  const cfg = await config();
  const stores = Array.from({ length: 12 }, () => new StateStore(cfg.stateFile));
  await Promise.all(stores.map((store, index) => store.update(async (state) => {
    await new Promise((resolve) => setTimeout(resolve, index % 3));
    state.posts[`ghost-post:${index}`] = { resource_id: String(index) };
  })));
  assert.equal(Object.keys((await stores[0].read()).posts).length, 12);
});

test("separate Ghost processes retain webhook, publication, and presentation identities", async () => {
  const cfg = await config();
  const writer = fileURLToPath(new URL("./state-writer.mjs", import.meta.url));
  const stateStore = new URL("../src/state-store.mjs", import.meta.url);
  await Promise.all([
    execFileAsync(process.execPath, [writer, stateStore.href, cfg.stateFile, "posts", "ghost-post:overlap", "40"]),
    execFileAsync(process.execPath, [writer, stateStore.href, cfg.stateFile, "publications", "publication-overlap", "20"]),
    execFileAsync(process.execPath, [writer, stateStore.href, cfg.stateFile, "presentations", "presentation-overlap", "0"]),
  ]);
  const state = await new StateStore(cfg.stateFile).read();
  assert.equal(state.posts["ghost-post:overlap"].writer, "posts");
  assert.equal(state.publications["publication-overlap"].writer, "publications");
  assert.equal(state.presentations["presentation-overlap"].writer, "presentations");
});

test("portable fallback holder cannot unlink a replacement lock during release", { skip: process.platform === "linux" }, async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile, { lockTimeoutMs: 1_000 });
  const lease = await store.acquirePortableLock();
  await unlink(`${cfg.stateFile}.lock`);
  const replacement = { token: "replacement", pid: process.pid };
  await writeFile(`${cfg.stateFile}.lock`, `${JSON.stringify(replacement)}\n`);
  await lease.release();
  assert.equal(JSON.parse(await readFile(`${cfg.stateFile}.lock`, "utf8")).token, "replacement");
  await unlink(`${cfg.stateFile}.lock`);
});

test("kernel advisory locking ignores malformed lock-file contents", { skip: process.platform !== "linux" }, async () => {
  const cfg = await config();
  await writeFile(`${cfg.stateFile}.lock`, "not-json");
  const store = new StateStore(cfg.stateFile);
  await store.update(async (state) => { state.posts.recovered = { retained: true }; });
  assert.equal((await store.read()).posts.recovered.retained, true);
});

test("kernel advisory lock times out without entering a live critical section", { skip: process.platform !== "linux" }, async () => {
  const cfg = await config();
  const holder = new StateStore(cfg.stateFile);
  const lease = await holder.acquireKernelLock();
  const contender = new StateStore(cfg.stateFile, { lockTimeoutMs: 100 });
  await assert.rejects(contender.update(async (state) => { state.posts.forbidden = true; }), /Timed out waiting/);
  await lease.release();
  assert.equal((await holder.read()).posts.forbidden, undefined);
});

test("kernel releases a crashed holder before two waiting contenders enter", { skip: process.platform !== "linux" }, async () => {
  const cfg = await config();
  const holderScript = fileURLToPath(new URL("./state-lock-holder.mjs", import.meta.url));
  const stateStore = new URL("../src/state-store.mjs", import.meta.url);
  const marker = `${cfg.stateFile}.holder-ready`;
  const holder = execFile(process.execPath, [holderScript, stateStore.href, cfg.stateFile, marker]);
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await readFile(marker); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  assert.equal(await readFile(marker, "utf8"), "ready\n");
  const writer = fileURLToPath(new URL("./state-writer.mjs", import.meta.url));
  const first = execFileAsync(process.execPath, [writer, stateStore.href, cfg.stateFile, "posts", "after-crash-one", "20"]);
  const second = execFileAsync(process.execPath, [writer, stateStore.href, cfg.stateFile, "presentations", "after-crash-two", "0"]);
  holder.kill("SIGKILL");
  await Promise.all([first, second]);
  const state = await new StateStore(cfg.stateFile).read();
  assert.equal(state.posts["after-crash-one"].writer, "posts");
  assert.equal(state.presentations["after-crash-two"].writer, "presentations");
});

function publicationRecord(overrides = {}) {
  return {
    resource_id: "11111111-1111-4111-8111-111111111111",
    direction: "from_discourse",
    state: "healthy",
    title: "The Bridge publishes everywhere",
    topic_id: 53,
    topic_url: "https://forum.example/t/the-bridge-publishes-everywhere/53",
    content_html: "<h2>One source</h2><p>Native Ghost content.</p>",
    source: { platform: "discourse", origin: "https://forum.example", topic_id: 53, topic_url: "https://forum.example/t/the-bridge-publishes-everywhere/53", post_id: 149, post_number: 1, post_version: 1, revision: "post:149:version:1", updated_at: "2026-09-01T12:00:00.000000Z", author: { username: "discussionbridge", name: "DiscussionBridge", profile_url: "https://forum.example/u/discussionbridge" } },
    bindings: [{ role: "presentation", state: "active", external_id: "bridge-publisher:ghost", canonical_url: "https://ghost.example/the-bridge-publishes-everywhere/", native_materialization: true }],
    ...overrides,
  };
}

test("native publication requires explicit authority and exact identities", async () => {
  const cfg = await config();
  const publication = nativePublication(publicationRecord(), cfg);
  assert.equal(publication.slug, "the-bridge-publishes-everywhere");
  assert.equal(publication.revision, "post:149:version:1");
  assert.match(publication.html, /data-discussionbridge-comments="fullInteractive"/);
  assert.match(publication.html, /\/discussionbridge\/assets\/loader\.js/);
  assert.match(publication.html, /Ghost 6\.59\.0/);
  assert.equal(nativePublication(publicationRecord({ bindings: [{ ...publicationRecord().bindings[0], native_materialization: false }] }), cfg), null);
  assert.throws(() => nativePublication(publicationRecord({ source: { ...publicationRecord().source, origin: "https://other.example" } }), cfg), /source/);
  assert.throws(() => nativePublication(publicationRecord({ bindings: [{ ...publicationRecord().bindings[0], canonical_url: "https://ghost.example/too/deep/" }] }), cfg), /slug/);
  assert.match(ghostAdminToken(`${"a".repeat(24)}:${"b".repeat(64)}`, 1000), /^[^.]+\.[^.]+\.[^.]+$/u);
});

test("publication sync creates once, skips presentation records and exact retry is unchanged", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  const records = [publicationRecord(), publicationRecord({ resource_id: "22222222-2222-4222-8222-222222222222", bindings: [{ ...publicationRecord().bindings[0], native_materialization: false }] })];
  const bridge = { records: async () => ({ bridge_records: records, pagination: { page: 1, pages: 1 } }) };
  const created = [];
  const ghost = { create: async (post) => { created.push(post); return { id: "a".repeat(24), slug: post.slug, url: `https://ghost.example/${post.slug}/` }; } };
  assert.deepEqual(await syncPublications(cfg, store, bridge, ghost), { created: 1, updated: 0, unchanged: 0, skipped: 1, failed: 0, errors: [] });
  assert.deepEqual(await syncPublications(cfg, store, bridge, ghost), { created: 0, updated: 0, unchanged: 1, skipped: 1, failed: 0, errors: [] });
  assert.equal(created.length, 1);
  const state = await store.read();
  assert.equal(state.publications[publicationRecord().resource_id].revision, "post:149:version:1");
  assert.equal(state.publications[publicationRecord().resource_id].adapter_version, "0.1.0-alpha.33");
  assert.doesNotMatch(JSON.stringify(state), /bbbbbbbb/);
});
