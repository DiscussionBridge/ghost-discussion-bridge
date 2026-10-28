import test from "node:test";
import assert from "node:assert/strict";
import { CoreClient } from "../src/core-client.mjs";
import { GhostAdminClient } from "../src/ghost-admin-client.mjs";
import { publishedGhostSource } from "../src/ghost-source.mjs";

const forum = "https://forum.example", ghost = "https://ghost.example";
const nativeId = "0123456789abcdef01234567";
const response = (address, value, contentType = "application/json") => {
  const result = new Response(typeof value === "string" ? value : JSON.stringify(value), { headers: { "Content-Type": contentType } });
  Object.defineProperty(result, "url", { value: address });
  return result;
};

test("native public Core endpoints preserve exact topic identity and omit Bridge/native credentials", async () => {
  const calls = [], identity = "9223372036854775807";
  const client = new CoreClient({ serverUrl: forum, connectionSecret: "never-public" }, async (address, options) => {
    calls.push({ address, options }); return response(address, { post_stream: { posts: [], stream: [] } });
  });
  await client.publicTopic(identity); await client.publicTopicPosts(identity, [1, 2, 1]);
  assert.equal(calls[0].address, `${forum}/t/${identity}.json`);
  assert.equal(calls[1].address, `${forum}/t/${identity}/posts.json?post_ids%5B%5D=1&post_ids%5B%5D=2`);
  for (const { options } of calls) {
    assert.equal(options.method, "GET"); assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, { Accept: "application/json" });
  }
  await assert.rejects(client.publicTopic("9223372036854775808"));
  await assert.rejects(client.publicTopicPosts(identity, [Number.MAX_SAFE_INTEGER + 1]));
});

test("native public settings retain branding and validate actual title without hostname fallback", async () => {
  let title = " Forum title ";
  const client = new CoreClient({ serverUrl: forum }, async (address, options) => {
    assert.equal(address, `${forum}/`); assert.equal(options.credentials, "omit");
    return response(address, `<script id="data-preloaded">${JSON.stringify({ siteSettings: JSON.stringify({ title, enable_powered_by_discourse: false }) })}</script>`, "text/html");
  });
  assert.equal(await client.publicPoweredByDiscourse(), false);
  assert.equal(await client.publicForumTitle(), title);
  for (const invalid of [" ", "a\u0085b", "a".repeat(201), "\ud800"]) { title = invalid; await assert.rejects(client.publicForumTitle()); }
});

test("native Admin current source reads remain posts with authors/tags despite destination page selection", async () => {
  const client = new GhostAdminClient({ ghostOrigin: ghost, ghostAdminApiKey: `${nativeId}:${"a".repeat(64)}`, publicationType: "page" }, async (address, options) => {
    assert.equal(address, `${ghost}/ghost/api/admin/posts/${nativeId}/?formats=html,lexical&include=authors,tags`);
    assert.match(options.headers.Authorization, /^Ghost /u);
    assert.equal(options.redirect, "error");
    return response(address, { posts: [{ id: nativeId, status: "published", html: "<p>Current native source</p>", authors: [], tags: [] }] });
  });
  const current = await client.getSource(nativeId);
  assert.equal(current.type, "post"); assert.equal(current.id, nativeId);
});

test("native source gate retains every provenance author and rejects received-source feedback", () => {
  const authors = [{ id: "first", name: "First" }, { id: "second", name: "Second", url: `${ghost}/author/second/` }];
  const current = { id: nativeId, type: "post", title: "Native", html: "<p>Source</p>", url: `${ghost}/native/`, status: "published", tags: [{ name: "#discussionbridge" }], authors, primary_author: authors[1] };
  const source = publishedGhostSource(current, { ghostOrigin: ghost });
  assert.equal(source.fullContentHtml, current.html);
  assert.deepEqual(source.authorship.source_authors.map(({ id, name }) => ({ id, name })), [{ id: "ghost-author:first", name: "First" }, { id: "ghost-author:second", name: "Second" }]);
  assert.equal(source.authorship.primary_source_author_id, "ghost-author:second");
  assert.throws(() => publishedGhostSource({ ...current, tags: [...current.tags, { name: "#discussionbridge-source" }] }, { ghostOrigin: ghost }));
  assert.throws(() => publishedGhostSource({ ...current, status: "draft" }, { ghostOrigin: ghost }));
});
