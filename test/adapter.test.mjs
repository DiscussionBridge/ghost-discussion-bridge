import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { BridgeClient, ghostRecord } from "../src/bridge-client.mjs";
import { isInteractiveCommentsMode, normalizeCommentsMode } from "../src/comments-mode.mjs";
import { ghostAdminToken } from "../src/ghost-admin-client.mjs";
import { publicationPlan, syncForumPublications } from "../src/forum-publication-sync.mjs";
import { installRichContent, mergeCodeInjection } from "../src/install-rich-content.mjs";
import { buildPlatformCatalog } from "../src/platform-catalog.mjs";
import { runPublicationSynchronization } from "../src/publication-operations.mjs";
import { nativePublication, syncPublications } from "../src/publication-sync.mjs";
import { assertStateStoreRuntimePrerequisites, StateStore } from "../src/state-store.mjs";
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
  assert.match(script, /0\.2\.0-alpha\.27/);
  assert.equal(mergeCodeInjection("<meta name=demo>"), `<meta name=demo>\n${script}`);
  assert.equal(mergeCodeInjection(script), script);
  const upgraded = mergeCodeInjection(script.replace("0.2.0-alpha.27", "0.1.0-alpha.99"));
  assert.match(upgraded, /0\.2\.0-alpha\.27/);
  assert.doesNotMatch(upgraded, /0\.1\.0-alpha\.99/);
  assert.equal((upgraded.match(/data-discussionbridge-comments-bootstrap/g) ?? []).length, 1);
  assert.throws(() => mergeCodeInjection({}), /Invalid Ghost code injection setting/);
});

test("rich-content installation reports Ghost's manual Site Footer boundary", async () => {
  const client = { request: async (method) => {
    if (method === "GET") return { settings: [{ key: "codeinjection_foot", value: "<meta name=existing>" }] };
    const error = new Error("Ghost Admin rejected the request");
    error.status = 403;
    throw error;
  } };
  const result = await installRichContent(client);
  assert.equal(result.updated, false);
  assert.equal(result.manual_required, true);
  assert.match(result.location, /Code injection → Site Footer/u);
  assert.match(result.code, /data-discussionbridge-comments-bootstrap/u);
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
  await writeFile(join(root, "operator-password"), "o".repeat(32));
  return loadConfig({ DISCUSSIONBRIDGE_SERVER_URL: "https://forum.example", DISCUSSIONBRIDGE_CONNECTION_ID: "dbc_0123456789abcdef01234567", DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE: join(root, "secret"), DISCUSSIONBRIDGE_GHOST_ORIGIN: "https://ghost.example", DISCUSSIONBRIDGE_GHOST_WEBHOOK_SECRET_FILE: join(root, "webhook"), DISCUSSIONBRIDGE_GHOST_ADMIN_API_KEY_FILE: join(root, "admin-key"), DISCUSSIONBRIDGE_STATE_FILE: join(root, "state.json"), DISCUSSIONBRIDGE_LANE: "ghost-alpha", DISCUSSIONBRIDGE_OPERATOR_PASSWORD_FILE: join(root, "operator-password") });
}

test("connection secret and lane match the receiver admission grammar", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-discussionbridge-config-"));
  const secretFile = join(root, "secret");
  const webhookFile = join(root, "webhook");
  const adminKeyFile = join(root, "admin-key");
  await writeFile(webhookFile, "w".repeat(32));
  await writeFile(adminKeyFile, `${"a".repeat(24)}:${"b".repeat(64)}`);
  const environment = {
    DISCUSSIONBRIDGE_SERVER_URL: "https://forum.example",
    DISCUSSIONBRIDGE_CONNECTION_ID: "dbc_0123456789abcdef01234567",
    DISCUSSIONBRIDGE_CONNECTION_SECRET_FILE: secretFile,
    DISCUSSIONBRIDGE_GHOST_ORIGIN: "https://ghost.example",
    DISCUSSIONBRIDGE_GHOST_WEBHOOK_SECRET_FILE: webhookFile,
    DISCUSSIONBRIDGE_GHOST_ADMIN_API_KEY_FILE: adminKeyFile,
    DISCUSSIONBRIDGE_STATE_FILE: join(root, "state.json"),
    DISCUSSIONBRIDGE_LANE: "ghost-alpha",
  };
  await writeFile(secretFile, "s".repeat(31));
  assert.throws(() => loadConfig(environment), /connection secret/);
  await writeFile(secretFile, "é".repeat(129));
  assert.throws(() => loadConfig(environment), /connection secret/);
  await writeFile(secretFile, "s".repeat(32));
  assert.throws(() => loadConfig({ ...environment, DISCUSSIONBRIDGE_LANE: "Bad Lane" }), /lane/);
  assert.equal(loadConfig(environment).lane, "ghost-alpha");
});

test("maps an authoritative published Ghost post and its authors", async () => {
  const cfg = await config();
  const record = ghostRecord({ post: { current: { id: "abc123", title: "Ghost article", html: "<p>Useful Ghost content.</p>", url: "https://ghost.example/ghost-article/", status: "published", tags: [{ name: "#discussionbridge", slug: "hash-discussionbridge" }], authors: [{ id: "author-1", name: "Primary Writer", url: "https://ghost.example/author/primary/" }, { id: "author-2", name: "Editor" }], primary_author: { id: "author-1" } } } }, cfg, "correlation");
  assert.equal(record.content_html, "<p>Useful Ghost content.</p>");
  assert.equal(record.external_id, "ghost-post:abc123");
  assert.equal(record.lane, "ghost-alpha");
  assert.equal(record.adapter_id, "ghost-discussion-bridge");
  assert.equal(record.adapter_version, "0.2.0-alpha.27");
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

test("a Ghost URL move cannot replace the stored Bridge Record or topic", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  let calls = 0;
  const client = { resolve: async () => {
    calls++;
    return { outcome: calls === 1 ? "created" : "resolved", resource_id: calls === 2
      ? "22222222-2222-4222-8222-222222222222" : "11111111-1111-4111-8111-111111111111",
      topic_id: calls === 2 ? 43 : 42, topic_url: `https://forum.example/t/x/${calls === 2 ? 43 : 42}`,
      core_fallback: false };
  } };
  const server = buildServer(cfg, store, client);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const send = async (url) => {
      const body = JSON.stringify({ post: { current: { id: "abc", title: "Article", html: "<p>Ghost content.</p>",
        url, status: "published", tags: [{ name: "#discussionbridge" }] } } });
      const timestamp = String(Date.now());
      const signature = createHmac("sha256", "w".repeat(32)).update(`${body}${timestamp}`).digest("hex");
      return fetch(`http://127.0.0.1:${server.address().port}/webhooks/ghost`, { method: "POST",
        headers: { "Content-Type": "application/json", "X-Ghost-Signature": `sha256=${signature}, t=${timestamp}` }, body });
    };
    assert.equal((await send("https://ghost.example/article/")).status, 200);
    assert.equal((await send("https://ghost.example/article-moved/")).status, 502);
    const post = (await store.read()).posts["ghost-post:abc"];
    assert.equal(post.resource_id, "11111111-1111-4111-8111-111111111111");
    assert.equal(post.topic_id, 42);
    assert.equal(post.canonical_url, "https://ghost.example/article/");
    assert.equal((await send("https://ghost.example/article-moved/")).status, 200);
    const moved = (await store.read()).posts["ghost-post:abc"];
    assert.equal(moved.resource_id, post.resource_id);
    assert.equal(moved.topic_id, post.topic_id);
    assert.equal(moved.canonical_url, "https://ghost.example/article-moved/");
  } finally { server.close(); }
});

test("operator status is protected, credential-free, and synchronizes with a bounded anti-CSRF token", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  await store.write({
    version: 1,
    posts: { "ghost-post:abc": { resource_id: "11111111-1111-4111-8111-111111111111", topic_id: 42, topic_url: "https://forum.example/t/ghost/42", canonical_url: "https://ghost.example/article/", outcome: "resolved", updated_at: "2026-09-15T00:00:00.000Z" } },
    presentations: {},
    publications: { "22222222-2222-4222-8222-222222222222": { ghost_post_id: "a".repeat(24), canonical_url: "https://ghost.example/native/", revision: "post:2:version:1", topic_id: 43, topic_url: "https://forum.example/t/native/43", state: "complete", synchronized_at: "2026-09-15T00:01:00.000Z" } },
  });
  let synchronizations = 0;
  const server = buildServer(cfg, store, {}, { synchronize: async () => { synchronizations += 1; return { created: 0, updated: 0, unchanged: 1, held: 1, unpublished: 0, failed: 0, errors: [] }; } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const authorization = `Basic ${Buffer.from(`discussionbridge:${"o".repeat(32)}`).toString("base64")}`;
    assert.equal((await fetch(`${origin}/operator/`)).status, 401);
    assert.equal((await fetch(`${origin}/operator/`, { headers: { Authorization: "Basic bad" } })).status, 401);
    const page = await fetch(`${origin}/operator/`, { headers: { Authorization: authorization } });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    const html = await page.text();
    assert.match(html, /Ghost → Discourse mappings/u);
    assert.match(html, /Discourse → Ghost publications/u);
    assert.match(html, /ghost-post:abc/u);
    assert.match(html, /Existing Discourse topic found/u);
    assert.match(html, /Ghost post created/u);
    assert.match(html, /Synchronize eligible forum topics/u);
    assert.doesNotMatch(html, new RegExp(`${"s".repeat(32)}|${"w".repeat(32)}|${"a".repeat(24)}:${"b".repeat(64)}|${"o".repeat(32)}`));
    const csrf = /name="csrf" value="([a-f0-9]{64})"/u.exec(html)?.[1];
    assert.ok(csrf);
    const headers = { Authorization: authorization, "Content-Type": "application/x-www-form-urlencoded" };
    assert.equal((await fetch(`${origin}/operator/synchronize`, { method: "POST", headers: { ...headers, Origin: "https://browser-supplied.example" }, body: "csrf=invalid" })).status, 403);
    const synchronized = await fetch(`${origin}/operator/synchronize`, { method: "POST", headers: { ...headers, Origin: "https://browser-supplied.example" }, body: `csrf=${csrf}`, redirect: "manual" });
    assert.equal(synchronized.status, 303);
    assert.equal(synchronized.headers.get("location"), "/discussionbridge/operator/");
    const noticeCookie = synchronized.headers.get("set-cookie")?.split(";", 1)[0];
    assert.match(noticeCookie ?? "", /^discussionbridge_operator_notice=/u);
    const resultPage = await fetch(`${origin}/operator/`, { headers: { Authorization: authorization, Cookie: noticeCookie } });
    assert.equal(resultPage.status, 200);
    assert.match(resultPage.headers.get("set-cookie") ?? "", /Max-Age=0/u);
    assert.match(await resultPage.text(), /0 created, 0 updated, 1 already current, 1 held, 0 unpublished, 0 failed/u);
    const refreshedPage = await fetch(`${origin}/operator/`, { headers: { Authorization: authorization } });
    assert.doesNotMatch(await refreshedPage.text(), /Synchronization complete:/u);
    assert.equal(synchronizations, 1);

    const failedServer = buildServer(cfg, store, {}, { synchronize: async () => { throw new Error("bounded failure"); } });
    await new Promise((resolve) => failedServer.listen(0, "127.0.0.1", resolve));
    try {
      const failure = await fetch(`http://127.0.0.1:${failedServer.address().port}/operator/synchronize`, { method: "POST", headers, body: `csrf=${csrf}`, redirect: "manual" });
      assert.equal(failure.status, 303);
      const failureCookie = failure.headers.get("set-cookie")?.split(";", 1)[0];
      const failurePage = await fetch(`http://127.0.0.1:${failedServer.address().port}/operator/`, { headers: { Authorization: authorization, Cookie: failureCookie } });
      assert.match(await failurePage.text(), /Synchronization failed.*protected failure details/su);
    } finally { failedServer.close(); }
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

test("comments mode uses Interactive publicly while accepting the historical token", () => {
  assert.equal(normalizeCommentsMode("interactive"), "interactive");
  assert.equal(normalizeCommentsMode("fullInteractive"), "interactive");
  assert.equal(isInteractiveCommentsMode("interactive"), true);
  assert.equal(isInteractiveCommentsMode("fullInteractive"), true);
  assert.equal(normalizeCommentsMode("bridge"), null);
});

test("reader loader offers simple, full, and Interactive mapped comments", async () => {
  const loader = await readFile(new URL("../src/browser-loader.mjs", import.meta.url), "utf8");
  assert.match(loader, /normalizeCommentsMode/);
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

test("simple comments render the exact fiftieth reply", async () => {
  const posts = Array.from({ length: 51 }, (_, index) => ({
    id: index + 1,
    post_number: index + 1,
    username: `user${index + 1}`,
    name: `Demo ${index + 1}`,
    cooked: `<p>Reply ${index + 1}</p>`,
    created_at: "2026-09-02T12:00:00.000Z",
    avatar_template: `/user_avatar/forum.example/user${index + 1}/{size}/1.png`,
  }));
  const client = {
    publicTopic: async () => ({ slug: "ghost-demo", post_stream: { stream: posts.map(({ id }) => id), posts: posts.slice(0, 1) } }),
    publicPoweredByDiscourse: async () => true,
    publicTopicPosts: async (_topicId, ids) => ({ post_stream: { posts: posts.filter(({ id }) => ids.includes(id)) } }),
  };
  const html = await renderSimpleDiscussion(client, 42, "https://forum.example");
  assert.match(html, /Reply 51/);
  assert.doesNotMatch(html, /Showing the first 50 comments/);
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

test("Linux state-store prerequisites are present before adapter work begins", { skip: process.platform !== "linux" }, async () => {
  await assertStateStoreRuntimePrerequisites();
});

test("kernel advisory lock times out without entering a live critical section", { skip: process.platform !== "linux" }, async () => {
  const cfg = await config();
  const holderScript = fileURLToPath(new URL("./state-lock-holder.mjs", import.meta.url));
  const stateStore = new URL("../src/state-store.mjs", import.meta.url);
  const marker = `${cfg.stateFile}.timeout-holder-ready`;
  const holder = execFile(process.execPath, [holderScript, stateStore.href, cfg.stateFile, marker]);
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await readFile(marker); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  const contender = new StateStore(cfg.stateFile, { lockTimeoutMs: 100 });
  await assert.rejects(contender.update(async (state) => { state.posts.forbidden = true; }), /Timed out waiting/);
  holder.kill("SIGKILL");
  assert.equal((await new StateStore(cfg.stateFile).read()).posts.forbidden, undefined);
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

test("kernel helper loss rejects a paused writer without post-loss persistence", { skip: process.platform !== "linux" }, async () => {
  const cfg = await config();
  const writerScript = fileURLToPath(new URL("./state-lock-loss-writer.mjs", import.meta.url));
  const stateStore = new URL("../src/state-store.mjs", import.meta.url);
  const marker = `${cfg.stateFile}.loss-writer-ready`;
  const writer = execFile(process.execPath, [writerScript, stateStore.href, cfg.stateFile, marker]);
  const exited = new Promise((resolve, reject) => {
    writer.once("error", reject);
    writer.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let identity;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      identity = JSON.parse(await readFile(marker, "utf8"));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.ok(identity?.helperPid, "paused writer did not expose its lock-helper identity");
  process.kill(identity.helperPid, "SIGKILL");
  assert.notEqual((await exited).code, 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await new StateStore(cfg.stateFile).read()).posts["written-after-lock-loss"], undefined);
});

test("kernel helper exit during the callback cannot publish parent state", { skip: process.platform !== "linux" }, async () => {
  const cfg = await config();
  const boundaryScript = fileURLToPath(new URL("./state-lock-boundary-writer.mjs", import.meta.url));
  const stateStore = new URL("../src/state-store.mjs", import.meta.url);
  const marker = `${cfg.stateFile}.boundary-write`;
  const writer = execFile(process.execPath, [boundaryScript, stateStore.href, cfg.stateFile, marker]);
  const exited = await new Promise((resolve, reject) => {
    writer.once("error", reject);
    writer.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.notEqual(exited.code, 0);
  assert.equal((await new StateStore(cfg.stateFile).read()).posts[marker], undefined);
});

for (const phase of ["before-read", "after-read", "after-write", "after-sync", "after-rename", "after-directory-sync", "before-exit"]) {
  test(`kernel transaction helper death at ${phase} preserves the commit boundary`, { skip: process.platform !== "linux" }, async () => {
    const cfg = await config();
    const phaseScript = fileURLToPath(new URL("./state-transaction-phase-writer.mjs", import.meta.url));
    const stateStore = new URL("../src/state-store.mjs", import.meta.url);
    const control = `${cfg.stateFile}.${phase}`;
    const ready = `${control}.${phase}.ready`;
    const writer = execFile(process.execPath, [phaseScript, stateStore.href, cfg.stateFile, control, phase]);
    const exited = new Promise((resolve, reject) => {
      writer.once("error", reject);
      writer.once("exit", (code, signal) => resolve({ code, signal }));
    });
    let helperPid;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const candidatePid = Number.parseInt((await readFile(ready, "utf8")).trim(), 10);
        if (Number.isSafeInteger(candidatePid) && candidatePid > 0) {
          helperPid = candidatePid;
          break;
        }
      } catch {
        // The helper creates and writes this marker asynchronously.
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(helperPid, `transaction helper did not reach ${phase}`);
    process.kill(helperPid, "SIGKILL");
    assert.notEqual((await exited).code, 0);
    await assert.rejects(stat(`${cfg.stateFile}.${helperPid}.tmp`), /ENOENT/);

    await new StateStore(cfg.stateFile).update(async (state) => {
      state.posts[`winner-${phase}`] = { retained: true };
    });
    const state = await new StateStore(cfg.stateFile).read();
    const committedBeforeLoss = phase === "after-rename" || phase === "after-directory-sync" || phase === "before-exit";
    assert.equal(Boolean(state.posts[`forbidden-${phase}`]), committedBeforeLoss);
    assert.equal(state.posts[`winner-${phase}`].retained, true);
  });
}

function forumSourceTopic(overrides = {}) {
  const destination = {
    state: "ready", reasons: [], catalog_revision: "b".repeat(64), mapping_revision: "c".repeat(64),
    destination_container_id: "post",
    destination_terms: [{ source_tag_id: 7, destination_taxonomy_id: "tag", destination_term_id: `tag:${"d".repeat(24)}` }],
    presentation_mode: "native", authorship_policy: "service_author", destination_author_id: "ghost:service",
    slug_policy: "topic_id", limits: { content_bytes: 49_152, title_bytes: 1_000, slug_bytes: 191 },
  };
  return {
    topic_id: 53,
    topic_url: "https://forum.example/t/forum-scale-canary/53",
    title: "Forum scale canary",
    source_revision: "post:149:version:1",
    content_bytes: 39,
    source_updated_at: "2026-09-20T16:00:00.000000Z",
    category: { id: 6, slug: "forum-scale-canary", name: "Forum Scale Canary" },
    tags: [{ id: 7, slug: "policy", name: "policy" }],
    author: { username: "discussionbridge", name: "DiscussionBridge", profile_url: "https://forum.example/u/discussionbridge" },
    publication: null,
    publication_revision: "a".repeat(64),
    destination,
    ...overrides,
  };
}

function forumSyncHarness() {
  const summary = forumSourceTopic();
  const detail = { ...summary, content_html: "<h2>One forum</h2><p>Seven sites.</p>" };
  const remote = [];
  const resourceId = "33333333-3333-4333-8333-333333333333";
  const bridge = {
    platformCatalogStatus: async () => ({ catalog_revision: null }),
    updatePlatformCatalog: async () => ({ destination_mapping_state: "current" }),
    sourceTopics: async () => ({ source_topics: [summary], pagination: { complete: true, next_cursor: null } }),
    sourceTopic: async () => ({ eligible: true, source_topic: detail }),
    resolveSourceTopic: async (_topicId, publication) => ({
      outcome: "created", resource_id: resourceId, topic_id: summary.topic_id,
      external_id: publication.external_id, canonical_url: publication.canonical_url,
      pending_publication_revision: summary.publication_revision,
      pending_mapping_revision: summary.destination.mapping_revision,
    }),
    acknowledgePublication: async (_resourceId, acknowledgement) => ({
      resource_id: resourceId,
      destination_state: ["held", "unpublished"].includes(acknowledgement.outcome) ? "held" : "healthy",
      acknowledged_publication_revision: summary.publication_revision,
    }),
    sourceRevocations: async () => ({ publication_revocations: [], pagination: { complete: true, next_cursor: null } }),
  };
  const ghost = {
    listTags: async () => [{ id: "d".repeat(24), name: "Policy" }],
    findByTopic: async () => remote,
    create: async (post) => {
      const created = { ...post, id: "e".repeat(24), url: `https://ghost.example/${post.slug}/`, updated_at: "2026-09-20T16:01:00.000Z" };
      remote.push(created);
      return created;
    },
    update: async (_id, post) => {
      remote[0] = { ...remote[0], ...post, updated_at: "2026-09-20T16:02:00.000Z" };
      return remote[0];
    },
    get: async () => remote[0],
  };
  return { bridge, detail, ghost, remote, resourceId, summary };
}

test("Ghost catalog reports native posts, pages, tags, and its service author", async () => {
  const catalog = await buildPlatformCatalog({ listTags: async () => [{ id: "d".repeat(24), name: "Policy" }] });
  assert.equal(catalog.platform, "ghost");
  assert.deepEqual(catalog.containers.map(({ id }) => id), ["post", "page"]);
  assert.equal(catalog.taxonomies[0].terms[0].id, `tag:${"d".repeat(24)}`);
  assert.equal(catalog.service_author_id, "ghost:service");
  assert.equal(catalog.limits.title_bytes, 255);
  assert.equal(catalog.inventory.terms_complete, true);
});

test("forum publication synchronization creates once, acknowledges, and exact retry is unchanged", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  const { bridge, detail, ghost, remote, resourceId, summary } = forumSyncHarness();
  assert.deepEqual(await syncForumPublications(cfg, store, bridge, ghost), {
    created: 1, updated: 0, unchanged: 0, held: 0, unpublished: 0, failed: 0, errors: [],
  });
  summary.publication = {
    resource_id: resourceId, destination_state: "healthy",
    acknowledged_publication_revision: summary.publication_revision,
    canonical_url: remote[0].url,
  };
  detail.publication = summary.publication;
  assert.deepEqual(await syncForumPublications(cfg, store, bridge, ghost), {
    created: 0, updated: 0, unchanged: 1, held: 0, unpublished: 0, failed: 0, errors: [],
  });
  assert.equal(remote.length, 1);
  assert.equal(remote[0].status, "published");
  assert.equal(hasOwn(await store.read(), "forum_publications"), true);
  assert.equal((await store.read()).forum_publications["53"].resource_id, resourceId);
});

test("forum publication synchronization adopts a uniquely marked draft after a lost create response", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  const { bridge, ghost, remote } = forumSyncHarness();
  const create = ghost.create;
  ghost.create = async (...args) => {
    await create(...args);
    throw new Error("Synthetic lost Ghost create response");
  };
  assert.deepEqual(await syncForumPublications(cfg, store, bridge, ghost), {
    created: 1, updated: 0, unchanged: 0, held: 0, unpublished: 0, failed: 0, errors: [],
  });
  assert.equal(remote.length, 1);
  assert.equal(remote[0].status, "published");
});

test("forum publication synchronization retries acknowledgement without duplicating native content", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  const { bridge, ghost, remote } = forumSyncHarness();
  const acknowledge = bridge.acknowledgePublication;
  let first = true;
  bridge.acknowledgePublication = async (...args) => {
    if (first) {
      first = false;
      throw new Error("Synthetic acknowledgement interruption");
    }
    return acknowledge(...args);
  };
  const interrupted = await syncForumPublications(cfg, store, bridge, ghost);
  assert.equal(interrupted.failed, 1);
  assert.equal(remote.length, 1);
  assert.deepEqual(await syncForumPublications(cfg, store, bridge, ghost), {
    created: 0, updated: 1, unchanged: 0, held: 0, unpublished: 0, failed: 0, errors: [],
  });
  assert.equal(remote.length, 1);
});

test("forum publication synchronization drafts and acknowledges an established unmapped topic", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  const { bridge, detail, ghost, remote, resourceId, summary } = forumSyncHarness();
  await syncForumPublications(cfg, store, bridge, ghost);
  summary.publication = { resource_id: resourceId, destination_state: "healthy", canonical_url: remote[0].url };
  detail.publication = summary.publication;
  summary.destination = { ...summary.destination, state: "attention", reasons: ["destination_category_unmapped"] };
  detail.destination = summary.destination;
  assert.deepEqual(await syncForumPublications(cfg, store, bridge, ghost), {
    created: 0, updated: 0, unchanged: 0, held: 1, unpublished: 0, failed: 0, errors: [],
  });
  assert.equal(remote[0].status, "draft");
  assert.equal((await store.read()).forum_publications["53"].state, "held");
});

test("forum publication revocation drafts the same Ghost item and acknowledges the hold", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  const { bridge, ghost, remote, resourceId, summary } = forumSyncHarness();
  await syncForumPublications(cfg, store, bridge, ghost);
  bridge.sourceTopics = async () => ({ source_topics: [], pagination: { complete: true, next_cursor: null } });
  bridge.sourceRevocations = async () => ({
    publication_revocations: [{ resource_id: resourceId, topic_id: 53, publication_revision: summary.publication_revision }],
    pagination: { complete: true, next_cursor: null },
  });
  assert.deepEqual(await syncForumPublications(cfg, store, bridge, ghost), {
    created: 0, updated: 0, unchanged: 0, held: 0, unpublished: 1, failed: 0, errors: [],
  });
  assert.equal(remote[0].status, "draft");
  assert.equal((await store.read()).forum_publications["53"].state, "held");
});

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

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
  assert.match(publication.revisionTag, /^#discussionbridge-revision-[0-9a-f]{64}$/u);
  assert.match(publication.html, /data-discussionbridge-comments="interactive"/);
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
  const bridge = { records: async () => ({ bridge_records: records, pagination: { page: 1, pages: 1, total: 2, snapshot: "snapshot-one" } }) };
  const created = [];
  const remote = [];
  const ghost = {
    findByResource: async () => remote,
    create: async (post) => {
      created.push(post);
      const result = { ...post, id: "a".repeat(24), url: `https://ghost.example/${post.slug}/`, updated_at: "2026-09-02T00:00:00.000Z" };
      remote.push(result);
      return result;
    },
  };
  assert.deepEqual(await syncPublications(cfg, store, bridge, ghost), { created: 1, updated: 0, unchanged: 0, skipped: 1, failed: 0, errors: [] });
  assert.deepEqual(await syncPublications(cfg, store, bridge, ghost), { created: 0, updated: 0, unchanged: 1, skipped: 1, failed: 0, errors: [] });
  assert.equal(created.length, 1);
  const state = await store.read();
  assert.equal(state.publications[publicationRecord().resource_id].revision, "post:149:version:1");
  assert.equal(state.publications[publicationRecord().resource_id].adapter_version, "0.2.0-alpha.27");
  assert.doesNotMatch(JSON.stringify(state), /bbbbbbbb/);
});

test("publication URL change fails closed without creating or moving a Ghost post", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  const original = publicationRecord();
  const originalPublication = nativePublication(original, cfg);
  const moved = publicationRecord({
    bindings: [{ ...original.bindings[0], canonical_url: "https://ghost.example/moved-publication/" }],
  });
  const remote = [{
    id: "a".repeat(24), slug: originalPublication.slug, url: originalPublication.destination,
    tags: [{ name: originalPublication.resourceTag }, { name: originalPublication.revisionTag }],
    updated_at: "2026-09-02T00:00:00.000Z",
  }];
  await store.update(async (state) => {
    state.publications[original.resource_id] = {
      ghost_post_id: remote[0].id, canonical_url: originalPublication.destination,
      revision: originalPublication.revision, adapter_version: PRODUCT_VERSION, state: "complete",
    };
  });
  const bridge = { records: async () => ({ bridge_records: [moved], pagination: { page: 1, pages: 1, total: 1, snapshot: "snapshot-one" } }) };
  let creates = 0; let updates = 0; let lookups = 0;
  const ghost = {
    findByResource: async () => { lookups += 1; return remote; },
    create: async () => { creates += 1; },
    update: async () => { updates += 1; },
  };
  const result = await syncPublications(cfg, store, bridge, ghost);
  assert.equal(result.failed, 1);
  assert.match(result.errors[0].reason, /URL change requires an explicit migration and redirect/u);
  assert.equal(creates, 0);
  assert.equal(updates, 0);
  assert.equal(lookups, 0);
  assert.equal(remote[0].url, originalPublication.destination);
  const state = await store.read();
  assert.equal(state.publications[original.resource_id].canonical_url, originalPublication.destination);
  assert.equal(state.publications[original.resource_id].state, "complete");
});

test("verified URL migration adopts the same already-moved Ghost post", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  const original = publicationRecord();
  const before = nativePublication(original, cfg);
  const destination = "https://ghost.example/moved-publication/";
  const moved = publicationRecord({
    bindings: [{
      ...original.bindings[0], canonical_url: destination,
      url_migration: { old_url: before.destination, new_url: destination, redirect_status: 301, verified_at: "2026-09-16T12:00:00.000000Z" },
    }],
  });
  const after = nativePublication(moved, cfg);
  const ghostId = "a".repeat(24);
  await store.update(async (state) => {
    state.publications[original.resource_id] = {
      ghost_post_id: ghostId, canonical_url: before.destination,
      revision: before.revision, adapter_version: PRODUCT_VERSION, state: "complete",
    };
  });
  const remote = [{
    id: ghostId, slug: after.slug, url: destination,
    tags: [{ name: after.resourceTag }, { name: after.revisionTag }],
    updated_at: "2026-09-16T12:00:00.000Z",
  }];
  const bridge = { records: async () => ({ bridge_records: [moved], pagination: { page: 1, pages: 1, total: 1, snapshot: "snapshot-one" } }) };
  const ghost = {
    findByResource: async () => remote,
    create: async () => { throw new Error("must not create"); },
    update: async () => { throw new Error("must not update"); },
  };
  assert.deepEqual(await syncPublications(cfg, store, bridge, ghost), { created: 0, updated: 1, unchanged: 0, skipped: 0, failed: 0, errors: [] });
  assert.deepEqual(await syncPublications(cfg, store, bridge, ghost), { created: 0, updated: 0, unchanged: 1, skipped: 0, failed: 0, errors: [] });
  const state = await store.read();
  assert.equal(state.publications[original.resource_id].ghost_post_id, ghostId);
  assert.equal(state.publications[original.resource_id].canonical_url, destination);
});

test("publication operation persists operator-visible totals and redacts protected values", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  const bridge = {
    platformCatalogStatus: async () => ({ catalog_revision: null }),
    updatePlatformCatalog: async () => ({ destination_mapping_state: "current" }),
    sourceTopics: async () => ({ source_topics: [], pagination: { complete: true, next_cursor: null } }),
    sourceRevocations: async () => ({ publication_revocations: [], pagination: { complete: true, next_cursor: null } }),
  };
  const ghost = { listTags: async () => [] };
  assert.deepEqual(await runPublicationSynchronization(cfg, store, bridge, ghost), { created: 0, updated: 0, unchanged: 0, held: 0, unpublished: 0, failed: 0, errors: [] });
  let state = await store.read();
  assert.equal(state.publication_sync.state, "complete");
  assert.equal(state.publication_sync.summary.failed, 0);

  const failing = { platformCatalogStatus: async () => { throw new Error(`Failure ${cfg.connectionSecret}`); } };
  await assert.rejects(() => runPublicationSynchronization(cfg, store, failing, ghost), /Failure/u);
  state = await store.read();
  assert.equal(state.publication_sync.state, "attention");
  assert.equal(state.publication_sync.summary.failed, 1);
  assert.equal(state.publication_sync.summary.errors[0].reason, "Failure [redacted]");
  assert.doesNotMatch(JSON.stringify(state), new RegExp(cfg.connectionSecret));
});

test("publication sync rejects snapshot drift and duplicate resource identities", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  let page = 0;
  const drifting = { records: async () => {
    page += 1;
    return { bridge_records: [publicationRecord()], pagination: { page, pages: 2, total: 2, snapshot: page === 1 ? "one" : "two" } };
  } };
  await assert.rejects(() => syncPublications(cfg, store, drifting, {}), /changed during synchronization/);
  page = 0;
  const repeated = { records: async () => {
    page += 1;
    return { bridge_records: [publicationRecord()], pagination: { page, pages: 2, total: 2, snapshot: "one" } };
  } };
  await assert.rejects(() => syncPublications(cfg, store, repeated, {}), /duplicate or invalid resource identity/);
});

test("lost Ghost create response adopts the exact resource marker without a second create", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  const bridge = { records: async () => ({ bridge_records: [publicationRecord()], pagination: { page: 1, pages: 1, total: 1, snapshot: "snapshot-one" } }) };
  const remote = [];
  let creates = 0;
  const ghost = {
    findByResource: async () => remote,
    create: async (post) => {
      creates += 1;
      remote.push({ ...post, id: "b".repeat(24), url: `https://ghost.example/${post.slug}/`, updated_at: "2026-09-02T00:00:00.000Z" });
      throw new Error("response lost");
    },
  };
  assert.equal((await syncPublications(cfg, store, bridge, ghost)).created, 1);
  assert.equal(creates, 1);
  assert.equal((await syncPublications(cfg, store, bridge, ghost)).unchanged, 1);
  assert.equal(creates, 1);
  assert.equal((await store.read()).publications[publicationRecord().resource_id].ghost_post_id, "b".repeat(24));
});

test("expired pending intent is recovered by marker lookup after restart", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  const publication = nativePublication(publicationRecord(), cfg);
  await store.update(async (state) => {
    state.publications[publication.resourceId] = { state: "pending", operation_id: "dead-process", pending_until: 0, canonical_url: publication.destination, revision: publication.revision, adapter_version: PRODUCT_VERSION };
  });
  const bridge = { records: async () => ({ bridge_records: [publicationRecord()], pagination: { page: 1, pages: 1, total: 1, snapshot: "snapshot-one" } }) };
  let creates = 0;
  const ghost = {
    findByResource: async () => [{ id: "c".repeat(24), slug: publication.slug, url: publication.destination, html: publication.html, tags: [{ name: publication.resourceTag }, { name: publication.revisionTag }], updated_at: "2026-09-02T00:00:00.000Z" }],
    create: async () => { creates += 1; throw new Error("must not create"); },
  };
  assert.equal((await syncPublications(cfg, store, bridge, ghost)).updated, 1);
  assert.equal(creates, 0);
  assert.equal((await store.read()).publications[publication.resourceId].ghost_post_id, "c".repeat(24));
});

test("expired create intent without a marker fails closed instead of creating again", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  const publication = nativePublication(publicationRecord(), cfg);
  await store.update(async (state) => {
    state.publications[publication.resourceId] = { state: "pending", operation_id: "lost-process", pending_until: 0, canonical_url: publication.destination, revision: publication.revision, adapter_version: PRODUCT_VERSION };
  });
  const bridge = { records: async () => ({ bridge_records: [publicationRecord()], pagination: { page: 1, pages: 1, total: 1, snapshot: "snapshot-one" } }) };
  let creates = 0;
  const ghost = {
    findByResource: async () => [],
    create: async () => { creates += 1; },
  };
  const result = await syncPublications(cfg, store, bridge, ghost);
  assert.equal(result.failed, 1);
  assert.equal(creates, 0);
  assert.match(result.errors[0].reason, /requires reconciliation/u);
  assert.equal((await store.read()).publications[publication.resourceId].state, "attention");
});

test("multiple Ghost resource markers fail closed before create", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  const publication = nativePublication(publicationRecord(), cfg);
  const bridge = { records: async () => ({ bridge_records: [publicationRecord()], pagination: { page: 1, pages: 1, total: 1, snapshot: "snapshot-one" } }) };
  let creates = 0;
  const ghost = {
    findByResource: async () => [
      { id: "d".repeat(24), slug: publication.slug, url: publication.destination, html: publication.html, tags: [{ name: publication.resourceTag }] },
      { id: "e".repeat(24), slug: publication.slug, url: publication.destination, html: publication.html, tags: [{ name: publication.resourceTag }] },
    ],
    create: async () => { creates += 1; },
  };
  const result = await syncPublications(cfg, store, bridge, ghost);
  assert.equal(result.failed, 1);
  assert.equal(creates, 0);
  assert.match(result.errors[0].reason, /Ambiguous/);
});

test("lost Ghost update response adopts the exact new revision marker", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  const original = publicationRecord();
  const originalPublication = nativePublication(original, cfg);
  const remote = [{
    id: "f".repeat(24), slug: originalPublication.slug, url: originalPublication.destination,
    html: originalPublication.html, tags: [{ name: originalPublication.resourceTag }, { name: originalPublication.revisionTag }],
    updated_at: "2026-09-02T00:00:00.000Z",
  }];
  const bridgeFor = (record) => ({ records: async () => ({ bridge_records: [record], pagination: { page: 1, pages: 1, total: 1, snapshot: "snapshot-one" } }) });
  const ghost = {
    findByResource: async () => remote,
    create: async () => { throw new Error("must not create"); },
    update: async (_id, post) => {
      remote[0] = { ...remote[0], ...post, updated_at: "2026-09-02T00:01:00.000Z" };
      throw new Error("update response lost");
    },
  };
  assert.equal((await syncPublications(cfg, store, bridgeFor(original), ghost)).updated, 1);
  const changed = publicationRecord({
    source: { ...original.source, post_version: 2, revision: "post:149:version:2" },
  });
  const result = await syncPublications(cfg, store, bridgeFor(changed), ghost);
  assert.equal(result.updated, 1);
  assert.equal(result.failed, 0);
  assert.match(remote[0].html, /data-discussionbridge-revision="post:149:version:2"/u);
  assert.equal((await store.read()).publications[original.resource_id].revision, "post:149:version:2");
});

test("resource lookup without the exact marker fails closed", async () => {
  const cfg = await config();
  const store = new StateStore(cfg.stateFile);
  const publication = nativePublication(publicationRecord(), cfg);
  const bridge = { records: async () => ({ bridge_records: [publicationRecord()], pagination: { page: 1, pages: 1, total: 1, snapshot: "snapshot-one" } }) };
  const ghost = {
    findByResource: async () => [{ id: "1".repeat(24), slug: publication.slug, url: publication.destination, html: publication.html, tags: [{ name: "#unrelated" }] }],
    create: async () => { throw new Error("must not create"); },
  };
  const result = await syncPublications(cfg, store, bridge, ghost);
  assert.equal(result.failed, 1);
  assert.match(result.errors[0].reason, /marker drift/u);
});

test("concurrent publication sync creates one Ghost post", async () => {
  const cfg = await config();
  const bridge = { records: async () => ({ bridge_records: [publicationRecord()], pagination: { page: 1, pages: 1, total: 1, snapshot: "snapshot-one" } }) };
  const remote = [];
  let creates = 0;
  const ghost = {
    findByResource: async () => remote,
    create: async (post) => {
      creates += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      const result = { ...post, id: "2".repeat(24), url: `https://ghost.example/${post.slug}/`, updated_at: "2026-09-02T00:00:00.000Z" };
      remote.push(result);
      return result;
    },
  };
  const [first, second] = await Promise.all([
    syncPublications(cfg, new StateStore(cfg.stateFile), bridge, ghost, { pendingLeaseMs: 2_000 }),
    syncPublications(cfg, new StateStore(cfg.stateFile), bridge, ghost, { pendingLeaseMs: 2_000 }),
  ]);
  assert.equal(creates, 1);
  assert.equal(first.created + second.created, 1);
  assert.equal(first.unchanged + second.unchanged, 1);
  assert.equal(first.failed + second.failed, 0);
});
