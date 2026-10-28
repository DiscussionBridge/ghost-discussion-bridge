import assert from "node:assert/strict";
import test from "node:test";
import { GhostAdminClient } from "../src/ghost-admin-client.mjs";
import { ghostCmsNative } from "../src/cms-native-publication.mjs";
import { fixture, nativeId, resourceId } from "./fixtures/cms-native-fixture.mjs";

// Focused transport/collector evidence, not real Ghost qualification. The
// collection/direct relation behavior follows the captured GN3 native API:
// include=tags omits authors; a direct read includes the actual relation.
function relationTransport(f, type) {
  const calls = [];
  const fetch = async (address, options) => {
    assert.equal(options.method, "GET", "Check must not write native state");
    const url = new URL(address), parts = url.pathname.split("/"), key = parts[4], id = parts[5];
    assert.ok(["posts", "pages"].includes(key));
    assert.equal(url.searchParams.get("formats"), "html,lexical");
    const included = new Set((url.searchParams.get("include") ?? "").split(","));
    const actual = key === `${type}s` ? structuredClone(f.object()) : null;
    if (id) assert.equal(id, nativeId);
    else {
      assert.match(url.searchParams.get("filter"), /^tag:hash-discussionbridge-resource-/u);
      assert.equal(url.searchParams.get("limit"), "3");
      if (actual && !included.has("authors")) delete actual.authors;
      if (actual && !included.has("tags")) delete actual.tags;
    }
    calls.push({ address, collection: !id, included: [...included], has_authors: actual ? Object.hasOwn(actual, "authors") : null });
    const response = new Response(JSON.stringify({ [key]: actual ? [actual] : [] }), { headers: { "Content-Type": "application/json" } });
    Object.defineProperty(response, "url", { value: address }); return response;
  };
  return { calls, client: new GhostAdminClient({ ...f.context.config, ghostAdminApiKey: `${"b".repeat(24)}:${"c".repeat(64)}` }, fetch) };
}

async function published(type) {
  const f = fixture(type);
  await ghostCmsNative(f.ghost).synchronize(f.context);
  assert.deepEqual(f.context.store.state.publications[resourceId].cms.native_metadata.authors, f.object().authors.map(({ id }) => id));
  return f;
}

function observer(f, client) {
  let publicReads = 0;
  const native = ghostCmsNative(client, { publicFetch: async (address, options) => {
    publicReads++; assert.equal(options.credentials, "omit");
    const response = new Response(`<article>${f.object().html}</article>`, { headers: { "Content-Type": "text/html" } });
    Object.defineProperty(response, "url", { value: address }); return response;
  } });
  return { native, publicReads: () => publicReads };
}

for (const type of ["post", "page"]) {
  test(`${type} resource transport requests actual authors and tags on both native resource routes`, async () => {
    const f = await published(type), transport = relationTransport(f, type);
    // Negative control: this faithfully represents the observed old query. It
    // must not manufacture authors from the retained receipt or a direct read.
    const omitted = await transport.client.request("GET", `/ghost/api/admin/${type}s/?filter=tag:hash-discussionbridge-resource-${resourceId}&limit=3&formats=html,lexical&include=tags`);
    assert.equal(Object.hasOwn(omitted[`${type}s`][0], "authors"), false);
    const direct = await transport.client.get(nativeId, undefined, type);
    assert.deepEqual(direct.authors, f.object().authors);
    const offset = transport.calls.length;
    const found = await transport.client.findByResource(resourceId, undefined, type);
    assert.equal(found.length, 1); assert.equal(found[0].id, nativeId);
    assert.deepEqual(found[0].authors, direct.authors); assert.deepEqual(found[0].tags, direct.tags);
    assert.equal(found[0].html, direct.html); assert.equal(found[0].updated_at, direct.updated_at);
    const collections = transport.calls.slice(offset);
    assert.equal(collections.length, 2);
    assert.deepEqual(new Set(collections.map(({ address }) => new URL(address).pathname)), new Set(["/ghost/api/admin/posts/", "/ghost/api/admin/pages/"]));
    assert.ok(collections.every(({ included }) => included.includes("authors") && included.includes("tags")));
  });

  test(`${type} unchanged real author relation permits the exact known baseline without changing retained state`, async () => {
    const f = await published(type), transport = relationTransport(f, type), checker = observer(f, transport.client);
    const retained = structuredClone(f.context.store.state), actual = structuredClone(f.object()), counts = f.counts();
    f.context.store.update = async () => assert.fail("Check must preserve the retained journal and receipt");
    const result = await checker.native.inspectAttention({ ...f.context, assertOperation: async () => {} });
    assert.equal(result.native_state, "baseline"); assert.equal(result.issue, "none"); assert.equal(result.native_id, nativeId);
    assert.equal(result.native_revision, actual.updated_at); assert.equal(result.current_sha256, result.baseline_sha256);
    assert.equal(result.verification.kind, "published"); assert.equal(checker.publicReads(), 1);
    assert.ok(transport.calls.some(({ collection }) => !collection), "Public proof must still be followed by a fresh direct native read");
    assert.deepEqual(f.context.store.state, retained); assert.deepEqual(f.object(), actual); assert.deepEqual(f.counts(), counts);
  });

  test(`${type} genuinely different author relation remains a native conflict even when other baseline fields agree`, async () => {
    const f = await published(type), before = structuredClone(f.object()), retained = structuredClone(f.context.store.state);
    // Isolate relation equality: changing only the actual returned author IDs
    // cannot be hidden by an otherwise equal native revision/body/title.
    f.object().authors = [{ id: "e".repeat(24) }];
    const changed = structuredClone(f.object()), transport = relationTransport(f, type), checker = observer(f, transport.client);
    assert.equal(changed.id, before.id); assert.equal(changed.updated_at, before.updated_at); assert.equal(changed.html, before.html);
    assert.notDeepEqual(changed.authors.map(({ id }) => id), retained.publications[resourceId].cms.native_metadata.authors);
    f.context.store.update = async () => assert.fail("Conflict inspection must not rewrite evidence");
    const result = await checker.native.inspectAttention({ ...f.context, assertOperation: async () => {} });
    assert.equal(result.native_state, "conflict"); assert.equal(result.issue, "native_conflict");
    assert.equal(result.current_sha256, result.baseline_sha256); assert.equal(result.native_revision, before.updated_at);
    assert.equal(result.native_result, null); assert.equal(result.verification, null); assert.equal(checker.publicReads(), 0);
    assert.deepEqual(f.context.store.state, retained); assert.deepEqual(f.object(), changed);
  });
}
