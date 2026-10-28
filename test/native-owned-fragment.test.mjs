import test from "node:test";
import assert from "node:assert/strict";
import { ghostOwnedFragment } from "../src/native-owned-fragment.mjs";

const attributes = { "data-discussionbridge-owned": "ghost-owned-fragment-v1", "data-discussionbridge-resource": "11111111-1111-4111-8111-111111111111", "data-discussionbridge-native-id": "0123456789abcdef01234567", "data-discussionbridge-source-revision": "opaque-revision", "data-discussionbridge-mode": "full" };
const opening = `<section ${Object.entries(attributes).map(([key, value]) => `${key}="${value}"`).join(" ")}>`;

test("native owned output hash reflects actual body, while canonical parser representation survives entity/attribute serialization", () => {
  const original = ghostOwnedFragment(`${opening}<p title="A &amp; B" class="native">A &amp; B</p></section>`, attributes);
  const serialized = ghostOwnedFragment(`${opening}<p class="native" title="A &#38; B">A &#38; B</p><!-- native comment --></section>`, attributes);
  assert.equal(original.hash, serialized.hash);
  assert.notEqual(original.hash, ghostOwnedFragment(`${opening}<p title="A &amp; B" class="native">Changed body</p></section>`, attributes).hash);
  assert.throws(() => ghostOwnedFragment(`${opening}<p>Body</p></section>`, { ...attributes, "data-discussionbridge-source-revision": "other-revision" }));
});

test("marker-only duplicate/inactive ownership cannot become actual native fragment proof", () => {
  const body = `${opening}<p>Body</p></section>`;
  for (const html of [`<div hidden>${body}</div>`, `<template>${body}</template>`, `<div style="display: none">${body}</div>`, body + body, `<div data-discussionbridge-owned="ghost-owned-fragment-v1"><p>Body</p></div>`]) assert.throws(() => ghostOwnedFragment(html, attributes));
});
