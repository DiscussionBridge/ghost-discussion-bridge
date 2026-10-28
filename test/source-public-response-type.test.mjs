import assert from "node:assert/strict";
import test from "node:test";
import { observeSourcePublic, sourceNativeIntegration } from "../src/source-native-proof.mjs";

const address = "https://ghost.example/native/", config = { ghostOrigin: "https://ghost.example", sourceNativeIntegration: { native_version: "synthetic", theme_id: "synthetic-theme", permalink: "/{slug}/", article: { tag: "section", class: "article" }, title: { tag: "h1", class: "title" }, prefix: "", suffix: "" } };
const integration = sourceNativeIntegration(config), snapshot = { title: "Native title", html: '<p>Native é article.</p><pre><code>&lt;template&gt;displayed&lt;/template&gt;</code></pre>' };
const page = `<!doctype html><html><head></head><body><h1 class="title">${snapshot.title}</h1><section class="article">${snapshot.html}</section></body></html>`;
async function observe(type) {
  const before = structuredClone(snapshot); let calls = 0;
  try { return await observeSourcePublic(config, integration, snapshot, address, null, { publicFetch: async (url, init) => {
    calls++; assert.equal(url, address); assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error");
    assert.equal(Object.keys(init.headers).some(name => /authorization|cookie/iu.test(name)), false);
    const response = new Response(page, { headers: { "content-type": type } }); Object.defineProperty(response, "url", { value: address }); return response;
  } }); } finally { assert.equal(calls, 1); assert.deepEqual(snapshot, before); }
}
const acceptedTypes = ["text/html", "TEXT/HTML", "text/html ; charset = UTF-8", 'text/html;charset="UTF-8"', 'text/html; note="a;b"', 'text/html; note="charset=iso-8859-1";charset=UTF-8', "text/html;charset=UTF-8; profile=ordinary", 'text/html; note="escaped\\\"quote"; charset=UTF-8'];
const rejectedTypes = ["text/html-notreally; charset=UTF-8", "application/xhtml+xml", "text/plain", "text/html; charset=iso-8859-1", "text/html; charset=windows-1252", "text/html; charset=UTF-16", 'text/html; charset=""', "text/html; charset", "text/html; charset=UTF-8; charset=iso-8859-1", "text/html; charset=UTF-8; charset=UTF-8", "text/html, text/plain", "text/html; charset=UTF-8, text/html", 'text/html; charset="UTF-8'];
for (const type of acceptedTypes) test(`source observer accepts unambiguous native HTML metadata ${type}`, async () => { await observe(type); });
for (const type of rejectedTypes) test(`source observer rejects conflicting/ambiguous HTML metadata ${type}`, async () => { await assert.rejects(observe(type), /HTML|UTF|charset|media|content.type/iu); });
