import { fixture, sha, nativeId, authorId, tagId, resourceId, mappingId, workId } from "./fixtures/cms-native-fixture.mjs";
import assert from "node:assert/strict";

import { createServer } from "node:http";
import test from "node:test";
import { ghostCmsNative, ghostOwnedFragment, nativeOwnershipHash } from "../src/cms-native-publication.mjs";

import { publishedGhostSource } from "../src/ghost-source.mjs";
import { performGhostPresentationMove } from "../src/cms-presentation-move.mjs";

test("observed unsupported playback/embed content does not silently become a successful full native publication", async () => {
  for (const html of ['<video src="https://media.example/video.mp4"></video>', '<audio src="https://media.example/audio.mp3"></audio>', '<iframe src="https://provider.example/player"></iframe>']) {
    const f = fixture(), native = ghostCmsNative(f.ghost);
    f.context.content = { bytes: Buffer.from(html), html }; f.context.source.content_sha256 = sha(html); f.context.source.content_bytes = Buffer.byteLength(html);
    await assert.rejects(native.synchronize(f.context), /cannot preserve/u); assert.equal(f.counts().creates, 0); assert.equal(f.counts().updates, 0);
    assert.equal(f.context.content.html, html); assert.equal(f.context.store.state.publications[resourceId].cms.ownership_receipt, null);
  }
});

test("actual source functions removed by this renderer stop before native writes with specific local loss diagnostics", async () => {
  for (const [html, facility] of [
    ['<script>calculate()</script>', "source script execution"],
    ['<img src="/image.png" onload="show()">', "source onload handler"],
    ['<form action="/submit"><input name="answer"><button>Send</button></form>', "native form submission structure"],
    ['<details><summary>Open</summary>Native disclosure</details>', "native disclosure expand/collapse"],
    ['<script type="application/ld+json">{"name":"Metadata"}</script>', "embedded script content/data"],
  ]) {
    const f = fixture(), original = Buffer.from(html); f.context.content = { bytes: original, html };
    f.context.source.content_sha256 = sha(original); f.context.source.content_bytes = original.length;
    await assert.rejects(ghostCmsNative(f.ghost).synchronize(f.context), (error) => error.localNativeLimitation === true && error.unsupportedNativeFunctions.includes(facility) && (facility !== "embedded script content/data" || !error.message.includes("script execution")));
    assert.equal(f.counts().creates, 0); assert.equal(f.counts().updates, 0);
    assert.equal(f.context.content.html, html); assert.deepEqual(f.context.content.bytes, original);
    assert.equal(f.context.store.state.publications[resourceId].cms.ownership_receipt, null);
  }
});

test("escaped displayed scripts remain text and empty script/handler placeholders do not assert an invented function loss", async () => {
  const f = fixture(), html = '<pre><code>&lt;script&gt;calculate()&lt;/script&gt; &lt;details&gt;Code&lt;/details&gt;</code></pre><script> </script><p onclick="">Static</p>';
  f.context.content = { bytes: Buffer.from(html), html }; f.context.source.content_sha256 = sha(html); f.context.source.content_bytes = Buffer.byteLength(html);
  await ghostCmsNative(f.ghost).synchronize(f.context);
  assert.match(f.object().html, /<pre><code>&lt;script&gt;calculate\(\)&lt;\/script&gt; &lt;details&gt;Code&lt;\/details&gt;<\/code><\/pre>/u);
  assert.equal(f.context.content.html, html); assert.equal(f.counts().creates, 1);
});

test("later function loss retains the prior owned native object and receipt", async () => {
  const f = fixture(), native = ghostCmsNative(f.ghost); await native.synchronize(f.context);
  const previous = structuredClone(f.object()), receipt = structuredClone(f.context.store.state.publications[resourceId].cms.ownership_receipt), count = f.counts().updates;
  const html = '<p onclick="calculate()">Interactive source</p>';
  f.context.content = { bytes: Buffer.from(html), html }; f.context.source.content_sha256 = sha(html); f.context.source.content_bytes = Buffer.byteLength(html); f.context.source.source_revision = "interactive-edition"; f.context.work.source_revision = "interactive-edition";
  await assert.rejects(native.synchronize(f.context), /source onclick handler/u);
  assert.equal(f.counts().updates, count); assert.deepEqual(f.object(), previous); assert.deepEqual(f.context.store.state.publications[resourceId].cms.ownership_receipt, receipt);
});

test("unsupported later media retains the prior owned publication and receipt without native rewrite", async () => {
  const f = fixture(), native = ghostCmsNative(f.ghost); await native.synchronize(f.context);
  const prior = structuredClone(f.object()), receipt = structuredClone(f.context.store.state.publications[resourceId].cms.ownership_receipt), count = f.counts().updates;
  const html = '<p>Video is meaningful</p><video src="https://media.example/video.mp4"></video>';
  f.context.content = { bytes: Buffer.from(html), html }; f.context.source.content_sha256 = sha(html); f.context.source.content_bytes = Buffer.byteLength(html); f.context.source.source_revision = "video-edition"; f.context.work.source_revision = "video-edition";
  await assert.rejects(native.synchronize(f.context), /cannot preserve/u); assert.equal(f.counts().updates, count); assert.deepEqual(f.object(), prior); assert.deepEqual(f.context.store.state.publications[resourceId].cms.ownership_receipt, receipt);
});

test("native copy anchors retained refs to captured Source.topic_url after original integrity and keeps wire/native hashes distinct", async () => {
  const f = fixture();
  const html = '<p>Source <a href="../next?q=1&amp;x=2">Link</a><a href="#part">Part</a></p><img src="/uploads/image.png" alt="Native">';
  f.context.source.topic_url = "https://forum.example/t/edition-captured/42";
  f.context.content = { bytes: Buffer.from(html), html }; f.context.source.content_sha256 = sha(html); f.context.source.content_bytes = Buffer.byteLength(html);
  const sourceBefore = structuredClone(f.context.source), originalBytes = Buffer.from(f.context.content.bytes);
  await publicServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end(`<article>${f.object().html}</article>`); }, async (publicFetch) => {
    const native = ghostCmsNative(f.ghost, { publicFetch }), result = await native.synchronize(f.context);
    assert.match(f.object().html, /href="https:\/\/forum\.example\/t\/next\?q=1&amp;x=2"/u);
    assert.match(f.object().html, /href="https:\/\/forum\.example\/t\/edition-captured\/42#part"/u);
    assert.match(f.object().html, /src="https:\/\/forum\.example\/uploads\/image\.png"/u);
    const verified = await native.verify({ ...f.context, result });
    assert.equal(verified.source_content_sha256, sourceBefore.content_sha256);
    assert.equal(verified.native_publication_sha256, ghostOwnedFragment(f.object().html).hash);
    assert.notEqual(verified.native_publication_sha256, verified.source_content_sha256);
  });
  assert.deepEqual(f.context.source, sourceBefore); assert.equal(f.context.content.html, html); assert.deepEqual(f.context.content.bytes, originalBytes);
});

test("plain and image-only complete cooked inputs remain native content while corrupt original input stops before preparation writes", async () => {
  for (const html of ["Unformatted source 雪", '<img src="/uploads/image.png" alt="Only image">']) {
    const f = fixture(); f.context.content = { bytes: Buffer.from(html), html }; f.context.source.content_sha256 = sha(html); f.context.source.content_bytes = Buffer.byteLength(html);
    await ghostCmsNative(f.ghost).synchronize(f.context); assert.equal(f.counts().creates, 1);
    assert.match(f.object().html, html.startsWith("<img") ? /src="https:\/\/forum\.example\/uploads\/image\.png"/u : /Unformatted source 雪/u);
  }
  const bad = fixture(); bad.context.content = { bytes: Buffer.from('<a href="../relative">Other bytes</a>'), html: '<a href="../relative">Other bytes</a>' };
  await assert.rejects(ghostCmsNative(bad.ghost).synchronize(bad.context), /complete immutable source differs/u);
  assert.equal(bad.counts().creates, 0); assert.equal(bad.counts().updates, 0);
});

for (const type of ["post", "page"]) for (const mode of ["simple", "full", "interactive"]) test(`CMS ${type} ${mode} learns real draft ID, publishes same object, propagates wiki and preserves identity`, async () => {
  const f = fixture(type, mode), native = ghostCmsNative(f.ghost);
  const first = await native.synchronize(f.context);
  assert.equal(first.outcome, "created"); assert.equal(first.nativeResult.native_id, nativeId);
  assert.equal(f.counts().creates, 1); assert.equal(f.counts().updates, 1); assert.equal(f.counts().catalogReads, 0);
  const receipt = f.context.store.state.publications[resourceId].cms.ownership_receipt;
  assert.equal(nativeOwnershipHash(receipt), first.nativeResult.ownership_receipt_sha256);
  assert.match(f.object().html, new RegExp(`data-discussionbridge-comments="${mode}"`, "u"));
  assert.match(f.object().html, /Forum &amp; Name/u); assert.equal(f.object().published_at, f.context.source.source_updated_at);
  assert.throws(() => publishedGhostSource({ ...f.object(), tags: [...f.object().tags, { name: "#discussionbridge" }] }, f.context.config), /cannot be republished/u);
  f.context.source.source_revision = "wiki-2"; f.context.work.source_revision = "wiki-2";
  f.context.content = { bytes: Buffer.from("<p>Wiki content</p>"), html: "<p>Wiki content</p>" };
  f.context.source.content_sha256 = sha(f.context.content.bytes); f.context.source.content_bytes = f.context.content.bytes.length;
  f.context.source.source_updated_at = "2026-10-14T01:00:00.000Z";
  f.context.authority.lease_generation = 3; f.context.store.state.publications[resourceId].cms.last_lease_generation = 3;
  const edited = await native.synchronize(f.context);
  assert.equal(edited.nativeResult.native_id, nativeId); assert.equal(edited.nativeResult.external_id, first.nativeResult.external_id); assert.equal(edited.nativeResult.canonical_url, first.nativeResult.canonical_url);
  assert.equal(f.counts().creates, 1); assert.match(f.object().html, /Wiki content/u);
  assert.equal(f.context.store.state.publications[resourceId].source_updated_at, f.context.source.source_updated_at);
  assert.equal((await native.synchronize(f.context)).outcome, "unchanged"); assert.equal(f.counts().updates, 2);
});

test("lost draft-create and lost update responses recover lookup-only/native readback without another create or update", async () => {
  for (const failure of ["lostCreate", "lostUpdate"]) {
    const f = fixture("post", "full", { [failure]: true }), native = ghostCmsNative(f.ghost);
    await assert.rejects(native.synchronize(f.context), (error) => error.cmsMutationUncertain === true);
    assert.equal(f.counts().creates, 1);
    const resumed = await native.synchronize(f.context);
    assert.equal(resumed.nativeResult.native_id, nativeId); assert.equal(f.counts().creates, 1); assert.equal(f.counts().updates, 1);
  }
});

test("an empty lookup after unknown native create never authorizes another create", async () => {
  const f = fixture("post", "full", { lostCreate: true }), native = ghostCmsNative(f.ghost);
  await assert.rejects(native.synchronize(f.context), /lost create response/);
  f.ghost.findByResource = async () => [];
  await assert.rejects(native.synchronize(f.context), /lookup-only/);
  assert.equal(f.counts().creates, 1); assert.equal(f.context.store.state.publications[resourceId].create_outcome_uncertain, true);
});

test("native author/taxonomy selections use available exact central and actual IDs; missing selections stop before create", async () => {
  const selected = fixture("post", "full", { selected: true });
  await ghostCmsNative(selected.ghost).synchronize(selected.context);
  assert.deepEqual(selected.object().authors.map((author) => author.id), [authorId]);
  assert.deepEqual(selected.object().tags.filter((tag) => !tag.name.startsWith("#discussionbridge-")).map((tag) => tag.id), [tagId]);
  const missing = fixture("post", "full", { selected: true, unavailable: true });
  await assert.rejects(ghostCmsNative(missing.ghost).synchronize(missing.context), /unavailable/);
  assert.equal(missing.counts().creates, 0);
  const absent = fixture("post", "full", { selected: true }); absent.ghost.catalog = async () => [];
  await assert.rejects(ghostCmsNative(absent.ghost).synchronize(absent.context), /no longer exists/);
  assert.equal(absent.counts().creates, 0);
});

test("empty native selections preserve defaults and unrelated tags including a DiscussionBridge-prefixed operator tag", async () => {
  const f = fixture(), create = f.ghost.create;
  f.ghost.create = async (...args) => {
    await create(...args);
    f.object().tags.push({ id: tagId, name: "Operator tag", slug: "operator-tag" }, { id: "3".repeat(24), name: "#discussionbridge-operator-label", slug: "hash-discussionbridge-operator-label" });
    return structuredClone(f.object());
  };
  await ghostCmsNative(f.ghost).synchronize(f.context);
  assert.deepEqual(f.object().authors.map((author) => author.id), ["9".repeat(24)]);
  assert.ok(f.object().tags.some((tag) => tag.name === "Operator tag"));
  assert.ok(f.object().tags.some((tag) => tag.name === "#discussionbridge-operator-label"));
  assert.equal(f.counts().catalogReads, 0);
});

test("native ownership/body/revision drift and lost native lock stop writes", async () => {
  const f = fixture(), native = ghostCmsNative(f.ghost); await native.synchronize(f.context);
  f.object().html = f.object().html.replace("Original source", "Local changed body");
  await assert.rejects(native.synchronize(f.context), /body changed locally/); assert.equal(f.counts().updates, 1);
  const fenced = fixture(); fenced.fence(); await assert.rejects(ghostCmsNative(fenced.ghost).synchronize(fenced.context), /lock lost/); assert.equal(fenced.counts().creates, 0);
});

for (const type of ["post", "page"]) for (const mode of ["simple", "full", "interactive"]) test(`same ${type} ${mode} URL movement binds issued nonce and retains ancestry through unchanged acknowledgement recovery`, async () => {
  const f = fixture(type, mode), native = ghostCmsNative(f.ghost); await native.synchronize(f.context);
  f.context.mapping.destination_native_id = nativeId; f.context.mapping.mapping_revision = "mapping-1";
  const old = await native.inspectMove(f.context), item = f.context.store.state.publications[resourceId];
  const move = { move_id: "66666666-6666-4666-8666-666666666666", proof_nonce: Buffer.alloc(32, 5).toString("base64url"), old_url: f.context.mapping.canonical_url, new_url: "https://ghost.example/moved-source/" };
  item.cms.url_move_request = { old_native: old, old_url: move.old_url, new_url: move.new_url };
  const result = await native.move(f.context, move); assert.equal(result.nativeResult.native_id, nativeId); assert.equal(f.counts().creates, 1); assert.equal(f.counts().updates, 2);
  assert.equal(f.object().url, move.new_url); assert.equal(ghostOwnedFragment(f.object().html).attributes["data-discussionbridge-proof-nonce"], move.proof_nonce);
  const pending = f.context.store.state.publications[resourceId].cms.url_move_request;
  assert.equal(nativeOwnershipHash(pending.native_receipt), result.nativeResult.ownership_receipt_sha256);
  assert.equal(pending.native_receipt.canonical_url, move.new_url); assert.equal(pending.native_receipt.move_id, move.move_id);
  Object.assign(f.context.store.state.publications[resourceId].cms, { ownership_receipt: pending.native_receipt, ownership_receipt_sha256: pending.native_receipt_sha256, native_revision: pending.native_revision, native_fragment_sha256: pending.native_fragment_sha256, native_title: pending.native_title });
  f.context.mapping.canonical_url = move.new_url;
  const recovered = await native.synchronize(f.context); assert.equal(recovered.outcome, "unchanged"); assert.equal(f.counts().updates, 2); assert.equal(recovered.nativeResult.ownership_receipt_sha256, result.nativeResult.ownership_receipt_sha256);
});

test("applied or unknown native movement under a replacement lease keeps both bindings in attention without a new prepare", async () => {
  for (const outcome of ["applied", "unknown"]) {
    const f = fixture(), native = ghostCmsNative(f.ghost); await native.synchronize(f.context);
    f.context.mapping.destination_native_id = nativeId; f.context.mapping.mapping_revision = "mapping-1";
    const old = await native.inspectMove(f.context), item = f.context.store.state.publications[resourceId];
    item.cms.url_move_request = { request_id: "66666666-6666-4666-8666-666666666666", state: "attention", expected_mapping_revision: "mapping-1", old_url: f.context.mapping.canonical_url, new_url: "https://ghost.example/moved-source/", old_native: old, native_outcome: outcome };
    f.context.authority.lease_generation = 3; item.cms.last_lease_generation = 3;
    f.context.client.prepareMutation = () => { assert.fail("Replacement lease must not fabricate old receipt/reprepare"); };
    await assert.rejects(performGhostPresentationMove(f.context, native), /replacement lease requires attention/u);
    assert.equal(f.counts().updates, 1); assert.equal(item.cms.url_move_request.old_native.receipt.last_lease_generation, 2);
  }
});

test("a proposed native slug owned by another post or page stops before native movement", async () => {
  const f = fixture(), native = ghostCmsNative(f.ghost); await native.synchronize(f.context);
  f.context.mapping.destination_native_id = nativeId;
  const old = await native.inspectMove(f.context), move = { move_id: "66666666-6666-4666-8666-666666666666", proof_nonce: Buffer.alloc(32, 5).toString("base64url"), old_url: f.context.mapping.canonical_url, new_url: "https://ghost.example/moved-source/" };
  f.context.store.state.publications[resourceId].cms.url_move_request = { old_native: old, old_url: move.old_url, new_url: move.new_url };
  f.ghost.findBySlug = async () => [{ id: "b".repeat(24), type: "page", slug: "moved-source" }];
  await assert.rejects(native.move(f.context, move), /collides with another post\/page/u);
  assert.equal(f.counts().updates, 1); assert.equal(await native.proveNoMove(f.context), true);
});

async function publicServer(handler, callback) {
  const server = createServer(handler); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const transport = async (address, options) => {
    assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
    assert.deepEqual(Object.keys(options.headers).sort(), ["Accept", "Accept-Encoding"]);
    const url = new URL(address);
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url.pathname}`, options);
    Object.defineProperty(response, "url", { value: address });
    return response;
  };
  try { await callback(transport); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test("actual loopback public verification hashes observed native fragment, distinct from source, with actual checked time", async () => {
  const f = fixture(); let native;
  await publicServer((request, response) => { assert.equal(request.url, new URL(f.context.mapping.canonical_url).pathname); assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined); response.writeHead(200, { "Content-Type": "text/html" }); response.end(`<html><body><article>${f.object().html}</article></body></html>`); }, async (publicFetch) => {
    native = ghostCmsNative(f.ghost, { publicFetch }); const result = await native.synchronize(f.context);
    const before = Date.now();
    const verified = await native.verify({ ...f.context, result });
    assert.equal(verified.native_id, nativeId); assert.equal(verified.verification_profile, "ghost-owned-fragment-v1");
    assert.equal(verified.native_publication_sha256, ghostOwnedFragment(f.object().html).hash);
    assert.notEqual(verified.native_publication_sha256, verified.source_content_sha256);
    assert.ok(Date.parse(verified.checked_at) >= before);
  });
});

test("complete native publication and public verification exceed metadata bounds without clipping", async () => {
  const f = fixture();
  const html = `<p>${"Exact large source ".repeat(100000)}</p>`;
  f.context.content = { bytes: Buffer.from(html), html };
  f.context.source.content_bytes = Buffer.byteLength(html); f.context.source.content_sha256 = sha(html);
  await publicServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end(`<article>${f.object().html}</article>`); }, async (publicFetch) => {
    const native = ghostCmsNative(f.ghost, { publicFetch }), result = await native.synchronize(f.context);
    assert.ok(Buffer.byteLength(f.object().html) > 262144);
    const verified = await native.verify({ ...f.context, result });
    assert.equal(verified.source_content_sha256, sha(html));
    assert.equal(verified.native_publication_sha256, ghostOwnedFragment(f.object().html).hash);
  });
});

test("public wrong/duplicated/inactive fragments, copied source marker, login, redirect, and failed withdrawal never verify", async () => {
  const f = fixture(), result = await ghostCmsNative(f.ghost).synchronize(f.context);
  for (const html of ["<p>Login required</p>", `<p data-source-sha="${f.context.source.content_sha256}">Other page</p>`, f.object().html.replace("Original source", "Wrong body"), f.object().html + f.object().html, `<template>${f.object().html}</template>`, `<div hidden>${f.object().html}</div>`, `<template><div></div></div>${f.object().html}</template>`]) {
    const native = ghostCmsNative(f.ghost, { publicFetch: async () => new Response(html, { headers: { "Content-Type": "text/html" } }) });
    await assert.rejects(native.verify({ ...f.context, result }), (error) => error.cmsCode === "public_verification_failed");
  }
  await publicServer((_request, response) => { response.writeHead(302, { Location: "/login/" }); response.end(); }, async (publicFetch) => { await assert.rejects(ghostCmsNative(f.ghost, { publicFetch }).verify({ ...f.context, result }), (error) => error.cmsCode === "public_verification_failed"); });
  f.context.work.action = "withdraw"; f.context.work.source_revision = null;
  const withdrawn = await ghostCmsNative(f.ghost).synchronize(f.context); assert.equal(f.object().status, "draft");
  assert.equal(withdrawn.nativeResult.kind, "withdraw"); assert.equal(withdrawn.nativeResult.native_id, nativeId);
  for (const status of [200, 401, 403, 500]) {
    await assert.rejects(ghostCmsNative(f.ghost, { publicFetch: async () => new Response("", { status }) }).verify({ ...f.context, result: withdrawn }), /absence is not proven/);
  }
  const absent = await ghostCmsNative(f.ghost, { publicFetch: async () => new Response("", { status: 404 }) }).verify({ ...f.context, result: withdrawn });
  assert.equal(absent.kind, "absent"); assert.equal(absent.native_id, nativeId); assert.equal(absent.http_status, 404);
});
