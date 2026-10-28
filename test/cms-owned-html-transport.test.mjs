import test from "node:test";
import assert from "node:assert/strict";
import { GhostAdminClient } from "../src/ghost-admin-client.mjs";
import { ghostCmsNative, ghostOwnedFragment } from "../src/cms-native-publication.mjs";
import { fixture, nativeId, resourceId, sha } from "./fixtures/cms-native-fixture.mjs";

// These are transport/native-method doubles, not a real Ghost qualification.
// Card/root/visibility shape and wrapper output follow the installed Ghost
// 6.70 observation and @tryghost/kg-default-nodes 2.2.4 sources.
const origin = "https://ghost.example";
const config = { ghostOrigin: origin, ghostAdminApiKey: `${"b".repeat(24)}:${"c".repeat(64)}` };
const visibility = { web: { nonMember: true, memberSegment: "status:free,status:-free" }, email: { memberSegment: "status:free,status:-free" } };
const card = (html, extra = {}) => ({ type: "html", version: 1, html, visibility: structuredClone(visibility), ...extra });
const document = (...children) => ({ root: { children, direction: null, format: "", indent: 0, type: "root", version: 1 } });
const section = (revision, text = "Prepared 雪 &amp; text") => `<section data-discussionbridge-owned="ghost-owned-fragment-v1" data-discussionbridge-resource="${resourceId}" data-discussionbridge-native-id="${nativeId}" data-discussionbridge-source-revision="${revision}"><p>${text}</p><aside>Attribution</aside><!--operator comment--><div data-discussionbridge-comments="full"></div><script data-discussionbridge-loader="test" src="https://adapter.example/loader.js" defer></script></section>`;
const render = (value) => value.root.children.map((node) => node.type === "html" ? `\n<!--kg-card-begin: html-->\n${node.html}\n<!--kg-card-end: html-->\n` : `<p>${node.children.map((child) => child.text).join("")}</p>`).join("");
const response = (address, value, status = 200) => {
  const result = new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  Object.defineProperty(result, "url", { value: address }); return result;
};

function nativeTransport(type = "post", { loseCreate = false, loseUpdate = false, stripCard = false } = {}) {
  let object, version = 0, creates = 0, updates = 0;
  const calls = [];
  const transport = async (address, options) => {
    const url = new URL(address), key = url.pathname.split("/")[4], id = url.pathname.split("/")[5];
    calls.push({ address, method: options.method, body: options.body === undefined ? undefined : JSON.parse(options.body) });
    assert.match(options.headers.Authorization, /^Ghost /u); assert.equal(options.redirect, "error");
    if (options.method === "GET") {
      if (!id) { assert.equal(url.searchParams.get("formats"), "html,lexical"); assert.equal(url.searchParams.get("include"), "authors,tags"); }
      else assert.equal(url.searchParams.get("formats"), "html,lexical");
      return response(address, { [key]: object && key === `${type}s` ? [structuredClone(object)] : [] });
    }
    const payload = JSON.parse(options.body)[key][0];
    if (options.method === "POST") {
      creates++; assert.equal(url.search, ""); assert.equal(Object.hasOwn(payload, "html"), false);
      assert.equal(typeof payload.lexical, "string"); assert.equal(payload.status, "draft");
      object = { ...payload, id: nativeId, type, authors: [{ id: "9".repeat(24) }] };
    } else {
      updates++; assert.equal(id, nativeId); assert.equal(payload.updated_at, object.updated_at);
      if (Object.hasOwn(payload, "lexical")) { assert.equal(url.search, ""); assert.equal(Object.hasOwn(payload, "html"), false); }
      Object.assign(object, payload);
    }
    object.html = stripCard ? "<p>Native conversion lost its owned structure</p>" : render(JSON.parse(object.lexical));
    object.updated_at = new Date(++version * 1000).toISOString(); object.url = `${origin}/${object.slug}/`;
    if (options.method === "POST" && loseCreate) { loseCreate = false; throw new Error("Synthetic response lost after native draft effect"); }
    if (options.method === "PUT" && loseUpdate) { loseUpdate = false; throw new Error("Synthetic response lost after native update effect"); }
    return response(address, { [key]: [structuredClone(object)] });
  };
  return { client: new GhostAdminClient({ ...config, publicationType: type }, transport), calls, object: () => object, counts: () => ({ creates, updates }) };
}

for (const type of ["post", "page"]) test(`owned ${type} draft uses one native HTML card and retains the complete prepared markup`, async () => {
  const native = nativeTransport(type), html = section("one");
  const payload = { title: "Prepared title", slug: "owned", html, status: "draft", visibility: "public", tags: [{ name: "#source" }] };
  const before = structuredClone(payload), result = await native.client.createOwnedHtml(payload, type);
  assert.deepEqual(payload, before); assert.equal(result.type, type); assert.equal(result.id, nativeId);
  const sent = native.calls[0].body[`${type}s`][0], lexical = JSON.parse(sent.lexical);
  assert.deepEqual(lexical, document(card(html))); assert.equal(sent.title, payload.title); assert.deepEqual(sent.tags, payload.tags);
  assert.equal(ghostOwnedFragment(result.html).html, html);
  const actual = await native.client.get(nativeId, undefined, type);
  assert.equal(actual.html, result.html); assert.equal(actual.lexical, result.lexical);
  const found = await native.client.findByResource(resourceId, undefined, type);
  assert.equal(found.length, 1); assert.equal(found[0].html, result.html); assert.equal(found[0].lexical, result.lexical);
});

test("repeated owned updates preserve unrelated native nodes, card properties and arbitrary comments without nesting render wrappers", async () => {
  const paragraph = { children: [{ detail: 0, format: 0, mode: "normal", style: "", text: "Unrelated native paragraph", type: "extended-text", version: 1 }], direction: null, format: "", indent: 0, type: "paragraph", version: 1 };
  const unrelated = card("<!--keep unrelated begin--><p>Another card</p><!--kg-card-begin: custom-->", { custom_identity: "unrelated-card" });
  const prefix = "<!--keep owned prefix--><p>Card-local before</p>", suffix = "<p>Card-local after</p><!--kg-card-end: custom--><!--keep owned suffix-->";
  let current = { id: nativeId, type: "post", updated_at: "2026-10-26T00:00:00.000Z", lexical: JSON.stringify(document(paragraph, card(prefix + section("one") + suffix, { custom_identity: "owned-card" }), unrelated)) };
  current.html = render(JSON.parse(current.lexical));
  const original = structuredClone(current), calls = [];
  const client = new GhostAdminClient(config, async (address, options) => {
    assert.equal(address, `${origin}/ghost/api/admin/posts/${nativeId}/`);
    const payload = JSON.parse(options.body).posts[0]; calls.push(payload);
    current = { ...current, ...payload, updated_at: `2026-10-26T00:00:0${calls.length}.000Z` }; current.html = render(JSON.parse(current.lexical));
    return response(address, { posts: [structuredClone(current)] });
  });
  for (const revision of ["two", "three"]) {
    const snapshot = current, previous = structuredClone(current), target = section(revision);
    await client.updateOwnedHtml(nativeId, { html: target, title: "Same title", authors: [{ id: "d".repeat(24) }], tags: [{ name: "Operator" }], published_at: "2026-10-26T00:00:00.000Z", updated_at: current.updated_at }, "post", current);
    const actual = JSON.parse(current.lexical), old = JSON.parse(previous.lexical);
    assert.deepEqual(actual.root.children[0], paragraph); assert.deepEqual(actual.root.children[2], unrelated);
    assert.equal(actual.root.children[1].custom_identity, "owned-card"); assert.deepEqual(actual.root.children[1].visibility, old.root.children[1].visibility);
    assert.equal(actual.root.children[1].html, prefix + target + suffix);
    assert.equal((current.html.match(/<!--kg-card-begin: html-->/gu) ?? []).length, 2);
    assert.equal((current.html.match(/<!--kg-card-end: html-->/gu) ?? []).length, 2);
    assert.deepEqual(snapshot, previous); assert.equal(ghostOwnedFragment(current.html).html, target);
  }
  assert.equal(original.html, render(JSON.parse(original.lexical))); assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].authors, [{ id: "d".repeat(24) }]); assert.deepEqual(calls[1].tags, [{ name: "Operator" }]);
  assert.equal(calls[1].published_at, "2026-10-26T00:00:00.000Z"); assert.equal(Object.hasOwn(calls[1], "html"), false);
});

test("missing, ambiguous, inactive or disagreeing native card/CAS facts stop before any native write", async () => {
  const html = section("one"), baseline = { id: nativeId, type: "post", updated_at: "2026-10-26T00:00:00.000Z", html: render(document(card(html))), lexical: JSON.stringify(document(card(html))) };
  const cases = [
    { lexical: undefined }, { lexical: "{" }, { lexical: JSON.stringify({ root: { type: "root", version: 2, children: [] } }) },
    { lexical: JSON.stringify(document({ type: "paragraph", version: 1, children: [] })) },
    { lexical: JSON.stringify(document(card(html), card(html))) },
    { lexical: JSON.stringify(document(card(section("foreign")))) },
    { lexical: JSON.stringify(document(card(`<div hidden>${html}</div>`))) },
    { html: baseline.html + html }, { id: "e".repeat(24) }, { type: "page" }, { updated_at: "different" },
  ];
  let writes = 0;
  const client = new GhostAdminClient(config, async () => { writes++; throw new Error("Native transport must not be called"); });
  for (const patch of cases) await assert.rejects(client.updateOwnedHtml(nativeId, { html: section("two"), updated_at: baseline.updated_at }, "post", { ...baseline, ...patch }));
  await assert.rejects(client.createOwnedHtml({ html: `<!--outside-->${html}` }));
  await assert.rejects(client.createOwnedHtml({ html, lexical: "{}" }));
  assert.equal(writes, 0);
});

test("generic HTML, metadata-only withdrawal and native source permalink operations keep their original wire behavior", async () => {
  const calls = [], client = new GhostAdminClient(config, async (address, options) => {
    calls.push({ address, method: options.method, body: JSON.parse(options.body) }); return response(address, { posts: [{ id: nativeId }] });
  });
  const html = { title: "Unrelated generic post", html: "<p>Generic</p>", status: "draft" };
  const withdrawal = { status: "draft", updated_at: "2026-10-26T00:00:00.000Z" };
  const permalink = { slug: "native-source", codeinjection_head: '<meta name="retained" content="yes">', updated_at: withdrawal.updated_at };
  await client.create(html); await client.update(nativeId, withdrawal); await client.updateSourcePermalink(nativeId, permalink);
  assert.equal(calls[0].address, `${origin}/ghost/api/admin/posts/?source=html`); assert.deepEqual(calls[0].body, { posts: [html] });
  assert.equal(calls[1].address, `${origin}/ghost/api/admin/posts/${nativeId}/?source=html`); assert.deepEqual(calls[1].body, { posts: [withdrawal] });
  assert.equal(calls[2].address, `${origin}/ghost/api/admin/posts/${nativeId}/`); assert.deepEqual(calls[2].body, { posts: [permalink] });
  for (const call of calls.slice(1)) { assert.equal(Object.hasOwn(call.body.posts[0], "html"), false); assert.equal(Object.hasOwn(call.body.posts[0], "lexical"), false); }
});

for (const loss of ["none", "loseCreate", "loseUpdate"]) test(`native writer uses the real client card boundary and resumes ${loss} without duplicate native writes`, async () => {
  const f = fixture(), transport = nativeTransport("post", loss === "none" ? {} : { [loss]: true });
  const native = ghostCmsNative(transport.client);
  if (loss !== "none") {
    await assert.rejects(native.synchronize(f.context), (error) => error.cmsMutationUncertain === true);
    assert.equal(transport.counts().creates, 1);
  }
  const result = await native.synchronize(f.context);
  assert.equal(result.nativeResult.native_id, nativeId); assert.deepEqual(transport.counts(), { creates: 1, updates: 1 });
  assert.equal(ghostOwnedFragment(transport.object().html).attributes["data-discussionbridge-native-id"], nativeId);
  assert.equal(transport.object().published_at, f.context.source.source_updated_at);
  const verified = await ghostCmsNative(transport.client, { publicFetch: async (address) => {
    const result = new Response(`<html><body>${transport.object().html}</body></html>`, { headers: { "Content-Type": "text/html" } }); Object.defineProperty(result, "url", { value: address }); return result;
  } }).verify({ ...f.context, result });
  assert.equal(verified.native_publication_sha256, ghostOwnedFragment(transport.object().html).hash);
  assert.equal(verified.source_content_sha256, sha(f.context.content.bytes));
  const beforeLexical = transport.object().lexical, beforeHtml = transport.object().html;
  f.context.work.action = "withdraw"; f.context.work.source_revision = null;
  const withdrawn = await native.synchronize(f.context);
  assert.equal(withdrawn.nativeResult.native_id, nativeId); assert.equal(transport.object().lexical, beforeLexical); assert.equal(transport.object().html, beforeHtml);
  const payload = transport.calls.at(-2).body.posts[0]; assert.equal(payload.status, "draft"); assert.equal(Object.hasOwn(payload, "lexical"), false);
});

test("a native response that still loses the owned fragment is rejected and its failed draft/receipt is retained", async () => {
  const f = fixture(), transport = nativeTransport("post", { stripCard: true }), native = ghostCmsNative(transport.client);
  await assert.rejects(native.synchronize(f.context), /does not have one owned publication fragment/u);
  const item = f.context.store.state.publications[resourceId];
  assert.equal(item.ghost_post_id, nativeId); assert.equal(item.cms.ownership_receipt.native_id, nativeId);
  assert.equal(item.cms.intent, undefined); assert.equal(item.cms.native_fragment_sha256, undefined); assert.equal(transport.object().status, "draft");
  await assert.rejects(native.synchronize(f.context), /does not have one owned publication fragment/u);
  assert.deepEqual(transport.counts(), { creates: 1, updates: 0 });
});
