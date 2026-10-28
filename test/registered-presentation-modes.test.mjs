import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildServer } from "../src/service.mjs";
import { browserDeployment } from "../src/browser-deployment.mjs";
import { normalizeCommentsMode, isInteractiveCommentsMode } from "../src/comments-mode.mjs";
import { isTopicIdentity } from "../src/topic-identity.mjs";
import { serveBrowserAsset } from "../src/browser-assets.mjs";

const resourceId = "11111111-1111-4111-8111-111111111111";
const config = { ghostOrigin: "https://ghost.example", serverUrl: "https://forum.example", adapterOrigin: "https://adapter.example", standaloneForumName: "Forum" };
const loader = (await readFile(new URL("../src/browser-loader.mjs", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gmu, "");

async function registeredHtml(mode, topicId = "123", state = "active") {
  const calls = [];
  const publicClient = {
    publicPoweredByDiscourse: async () => false,
    publicTopic: async (id) => {
      calls.push(id);
      const posts = Array.from({ length: 56 }, (_, index) => ({ id: index + 1, post_number: index + 1, username: "reader", cooked: `<p>Reply ${index}</p><script>bad()</script>`, created_at: "2026-10-24T00:00:00.000Z" }));
      return { slug: "source", post_stream: { stream: posts.map((post) => post.id), posts } };
    },
  };
  const record = { resource_id: resourceId, direction: "from_discourse", state, presentation_mode: mode, forum_name: "Forum", topic_id: topicId, topic_url: `${config.serverUrl}/t/source/${topicId}`, content_html: "<p>Native article</p>" };
  const server = buildServer(config, { read: async () => ({ presentations: { [resourceId]: {} } }) }, publicClient, { readPresentation: async () => record });
  // Exercise the actual request handler without opening a listening socket.
  const result = await new Promise((resolve) => {
    const headers = {};
    const response = { setHeader(name, value) { headers[name] = value; }, writeHead(status, values) { this.status = status; Object.assign(headers, values); }, end(html) { resolve({ status: this.status, headers, html, calls }); } };
    server.emit("request", { method: "GET", url: `/presentation/${resourceId}`, headers: {} }, response);
  });
  return result;
}

class Element {
  constructor(tag = "div", attributes = {}) { this.tagName = tag.toUpperCase(); this.attributes = attributes; this.dataset = {}; this.children = []; this._html = ""; this._text = ""; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  matches(selector) { return selector === ".discussionbridge-credit" && this.className === "discussionbridge-credit"; }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  before() {}
  after() {}
  get innerHTML() { return this._html; }
  set innerHTML(html) {
    this._html = html;
    const opening = /<div\b([^>]*\bdata-discussionbridge-presentation-comments\b[^>]*)>/u.exec(html);
    if (opening) {
      const attributes = {};
      for (const match of opening[1].matchAll(/([\w-]+)="([^"]*)"/gu)) attributes[match[1]] = match[2];
      this.discussion = new Element("div", attributes);
    }
  }
  get textContent() { return this._text; }
  set textContent(text) { this._text = text; this._html = ""; this.discussion = undefined; }
  querySelector(selector) { return selector === "[data-discussionbridge-presentation-comments]" ? this.discussion ?? null : null; }
  querySelectorAll() { return []; }
}

async function consumeRegisteredHtml(result, ordinary) {
  const target = new Element("div", ordinary ? { "data-discussionbridge-comments": ordinary.mode } : { "data-discussionbridge-resource": resourceId });
  const head = new Element("head");
  const window = { location: { href: `${config.ghostOrigin}/native/` } };
  const requests = [];
  const document = {
    currentScript: { src: `${config.adapterOrigin}/discussionbridge/assets/loader.js` },
    head,
    querySelector: () => null,
    querySelectorAll: (selector) => selector === (ordinary ? "[data-discussionbridge-comments]" : "[data-discussionbridge-resource]") ? [target] : [],
    createElement: (tag) => new Element(tag),
    createTreeWalker: () => ({ nextNode: () => false }),
  };
  const context = { document, window, URL, NodeFilter: { SHOW_TEXT: 4 }, normalizeCommentsMode, isInteractiveCommentsMode, isTopicIdentity, browserDeployment, mermaid: { initialize() {} }, katex: {}, fetch: async (address, options) => {
    requests.push({ address, options });
    assert.equal(address, ordinary ? `${config.adapterOrigin}/discussionbridge/comments?source=${encodeURIComponent(`${config.ghostOrigin}/native/`)}` : `${config.adapterOrigin}/discussionbridge/presentation/${resourceId}`);
    return { ok: result.status === 200, text: async () => result.html, json: async () => ordinary.record };
  } };
  vm.runInNewContext(loader, context, { timeout: 2000, filename: "actual-browser-loader.mjs" });
  await new Promise(setImmediate);
  return { target, head, window, requests };
}

for (const mode of ["simple", "full", "interactive"]) {
  test(`registered ${mode} response and consumed browser dispatch preserve selected mode`, async () => {
    const result = await registeredHtml(mode);
    assert.equal(result.status, 200);
    assert.match(result.html, new RegExp(`data-presentation-mode="${mode}"`, "u"));
    const browser = await consumeRegisteredHtml(result);
    assert.notEqual(browser.target.textContent, "Discussion is temporarily unavailable.");
    assert.equal(browser.requests[0].options.credentials, "omit");
    assert.equal(browser.requests[0].options.redirect, "error");
    const scripts = browser.head.children.filter((element) => element.src?.endsWith("/javascripts/embed.js"));
    if (mode === "simple") {
      assert.deepEqual(result.calls, ["123"]);
      assert.match(result.html, /Reply 1<\/p>/u);
      assert.match(result.html, /Reply 50<\/p>/u);
      assert.doesNotMatch(result.html, /Reply 0<\/p>|Reply 51<\/p>|<script>|bad\(\)/u);
      assert.equal((result.html.match(/discussionbridge-simple__reply/g) ?? []).length, 50);
      assert.equal(scripts.length, 0);
      assert.equal(browser.window.DiscourseEmbed, undefined);
    } else {
      assert.equal(result.calls.length, 0);
      assert.equal(scripts.length, 1);
      assert.equal(browser.window.DiscourseEmbed.topicId, "123");
      assert.equal(browser.window.DiscourseEmbed.fullApp, mode === "interactive" ? true : undefined);
      assert.equal(browser.window.DiscourseEmbed.className, mode === "interactive" ? "discussion-bridge-source-presentation" : undefined);
    }
    assert.doesNotMatch(result.html, /X-DiscussionBridge|connectionSecret|connection_secret/u);
  });
}

for (const topicId of ["9007199254740992", "9007199254740993", "9223372036854775807"]) {
  for (const mode of ["full", "interactive"]) {
    test(`registered ${mode} browser retains exact topic ${topicId}`, async () => {
      const result = await registeredHtml(mode, topicId);
      const browser = await consumeRegisteredHtml(result);
      assert.equal(browser.target.textContent, "");
      assert.equal(browser.window.DiscourseEmbed?.topicId, topicId);
    });
  }
}

test("registered unknown/missing modes and withdrawn sources fail visibly instead of selecting another mode", async () => {
  for (const mode of [undefined, "fullInteractive", "typo"]) {
    const result = await registeredHtml(mode);
    assert.equal(result.status, 502);
    const browser = await consumeRegisteredHtml(result);
    assert.equal(browser.target.textContent, "Discussion is temporarily unavailable.");
    assert.equal(browser.window.DiscourseEmbed, undefined);
  }
  assert.equal((await registeredHtml("simple", "123", "withdrawn")).status, 410);
});

for (const mode of ["full", "interactive"]) {
  test(`ordinary ${mode} comment slot retains Core mode and exact topic identity`, async () => {
    const topicId = "9223372036854775807";
    const browser = await consumeRegisteredHtml({ status: 200 }, { mode, record: { topic_id: topicId, topic_url: `${config.serverUrl}/t/source/${topicId}`, forum_origin: config.serverUrl } });
    assert.equal(browser.target.textContent, "");
    assert.equal(browser.window.DiscourseEmbed.topicId, topicId);
    assert.equal(browser.window.DiscourseEmbed.fullApp, mode === "interactive" ? true : undefined);
    assert.equal(browser.window.DiscourseEmbed.className, undefined);
    assert.equal(browser.head.children.filter((element) => element.src?.endsWith("/javascripts/embed.js")).length, 1);
  });
}

for (const topicId of ["9007199254740992", "9007199254740993", "9223372036854775807"]) {
  test(`registered Simple public reads retain exact topic ${topicId}`, async () => {
    const result = await registeredHtml("simple", topicId);
    const browser = await consumeRegisteredHtml(result);
    assert.equal(result.status, 200);
    assert.deepEqual(result.calls, [topicId]);
    assert.match(result.html, new RegExp(`/t/source/${topicId}`, "u"));
    assert.equal(browser.window.DiscourseEmbed, undefined);
  });
}

test("browser rejects stale or unknown selected-mode metadata instead of opening Interactive", async () => {
  for (const mode of [undefined, "fullInteractive", "typo"]) {
    const attribute = mode === undefined ? "" : `data-presentation-mode="${mode}"`;
    const browser = await consumeRegisteredHtml({ status: 200, html: `<div data-discussionbridge-presentation-comments ${attribute} data-topic-id="123" data-topic-url="${config.serverUrl}/t/source/123" data-forum-origin="${config.serverUrl}"></div>` });
    assert.equal(browser.target.textContent, "Discussion is temporarily unavailable.");
    assert.equal(browser.window.DiscourseEmbed, undefined);
  }
});

test("served loader bytes are the rebuilt current mode-dispatch artifact", async () => {
  const expected = await readFile(new URL("../public/discussionbridge-loader.js", import.meta.url));
  let actual;
  const response = { writeHead(status) { assert.equal(status, 200); }, end(bytes) { actual = bytes; } };
  assert.equal(serveBrowserAsset({ method: "GET", headers: {} }, response, new URL("https://adapter.example/assets/loader.js")), true);
  assert.deepEqual(actual, expected);
  assert.match(actual.toString("utf8"), /data-presentation-mode/u);
});
