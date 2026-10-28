import test from "node:test";
import assert from "node:assert/strict";
import { sourcePublicArticle, sourceChallenge, sourceHead, sourceNativeIntegration, sourceMoveSlug, sourceOwnershipReceipt, sourceSha } from "../src/source-native-proof.mjs";

const integration = { native_version: "synthetic-native-1", theme_id: "synthetic-theme", permalink: "/{slug}/", article: { tag: "section", class: "fixture-article" }, title: { tag: "h1", class: "fixture-title" }, prefix: "\n", suffix: "\n" };
const challenge = sourceChallenge({ native_id: "a".repeat(24), resource_id: "resource", external_id: "external", move_id: "move", proof_nonce: "issued", source_revision: "new", url: "https://ghost.example/new/" });
const content = '<!--complete comment--><p data-x="1">é &amp; image <img src="https://ghost.example/a.png" alt="a"></p><pre><code>&lt;script&gt;displayed&lt;/script&gt;</code></pre><script type="application/json">{"native":"data"}</script><script>nativeFunction()</script><style>.native{color:red}</style>';
const page = (body = content, head = challenge.block) => `<!doctype html><html><head>${head}</head><body><h1 class="fixture-title">Native &amp; title</h1><section class="fixture-article">\n${body}\n</section></body></html>`;

test("To source profile compares complete independently expected article including comments/data/function/code, not nonce alone", () => {
  const proof = sourcePublicArticle(page(), content, "Native & title", integration, challenge);
  assert.equal(proof.sha256.length, 64); assert.ok(proof.bytes > content.length);
  for (const body of [content.replace("complete comment", "lost comment"), content.replace("nativeFunction()", ""), content.replace('"native":"data"', '"native":"changed"'), content.replace("displayed", "changed"), content.slice(0, -20), "<p>Teaser only</p>"]) assert.throws(() => sourcePublicArticle(page(body), content, "Native & title", integration, challenge));
});

test("profile rejects duplicate/inactive article, duplicate attrs/title, absent or forged public challenge and login page", () => {
  for (const html of [page().replace('<section class=', '<section hidden class='), page().replace('</body>', '<section class="fixture-article"></section></body>'), page().replace('data-x="1"', 'data-x="1" data-x="2"'), page().replace('class="fixture-title"', 'class="fixture-title" class="other"'), page(content, ""), page(content, challenge.block.replace(challenge.content, "wrong")), page(content, challenge.block + challenge.block), page().replace("Native &amp; title", "Login"), "<html><body>Login</body></html>"]) assert.throws(() => sourcePublicArticle(html, content, "Native & title", integration, challenge));
});

test("profile canonicalizes entity/attribute representation only, retaining full text whitespace and all content", () => {
  const one = '<p a="x" b="&amp;"> A </p>', two = "<p b='&#38;' a='x'> A </p>";
  assert.equal(sourcePublicArticle(page(one), one, "Native & title", integration, challenge).sha256, sourcePublicArticle(page(two), one, "Native & title", integration, challenge).sha256);
  assert.throws(() => sourcePublicArticle(page(one.replace(" A ", "A")), one, "Native & title", integration, challenge));
});

test("owned inert challenge preserves unrelated native injection and replaces only retained same-object ancestry", () => {
  const head = '<meta name="unrelated" content="unchanged">', next = sourceChallenge({ ...challenge.payload, proof_nonce: "next" });
  assert.equal(sourceHead(null, challenge), challenge.block);
  assert.equal(sourceHead(head + challenge.block, next, challenge.block), head + next.block);
  assert.throws(() => sourceHead(head + challenge.block, next));
  assert.throws(() => sourceHead(challenge.block + challenge.block, next, challenge.block));
});

test("native integration has no theme default and exact literal permalink/slug support", () => {
  assert.throws(() => sourceNativeIntegration({}));
  const actual = sourceNativeIntegration({ sourceNativeIntegration: integration });
  assert.equal(sourceMoveSlug(actual, "https://ghost.example", { slug: "old", url: "https://ghost.example/old/" }, "https://ghost.example/new/"), "new");
  for (const url of ["https://ghost.example/new/?query=1", "https://ghost.example/folder/new/", "https://other.example/new/"]) assert.throws(() => sourceMoveSlug(actual, "https://ghost.example", { slug: "old", url: "https://ghost.example/old/" }, url));
});

test("private ownership canonical bytes preserve values/array order and do not depend on object insertion order", () => {
  const a = sourceOwnershipReceipt({ phase: "before", authors: [{ id: "1", name: "A" }], nested: { z: 1, a: null } });
  const b = sourceOwnershipReceipt({ nested: { a: null, z: 1 }, authors: [{ name: "A", id: "1" }], phase: "before" });
  assert.equal(a.sha256, b.sha256); assert.equal(a.bytes, b.bytes); assert.notEqual(a.sha256, sourceSha(content));
});
