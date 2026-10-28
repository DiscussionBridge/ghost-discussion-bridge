// PURE ONLY: memory stores and stub transports; no HTTP or state worker imports.
import { fixture, config, id, key, resource, topic, sha } from "./fixtures/cms-source-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";






import { sourceArtifactIdentity } from "../lib/cms-vendor.mjs";


import { prepareGhostSourceHtml } from "../src/source-preparation.mjs";
import { GhostAdminClient } from "../src/ghost-admin-client.mjs";
import { observeGhostSourceLifecycle } from "../src/cms-source-withdrawal.mjs";
import { MAX_STATE_BYTES, serializedState } from "../src/state-file.mjs";

// Author native seam ONLY while final codec delivery is pending. This supplies
// the internal already-validated response evidence; it does not assert that r3
// can decode the new wire code. Actual decoder cases run with the final pair.
function preservationRefusalSeam(f, { provenance = true } = {}) {
  const resolveSource = f.client.resolveSource.bind(f.client), known = new WeakMap(), priorEvidence = f.client.rejectedResponse.bind(f.client);
  f.refusePreservation = true; f.refusedBodies = [];
  f.client.resolveSource = async (body) => {
    if (!f.refusePreservation) return resolveSource(body);
    f.refusedBodies.push(structuredClone(body));
    const error = Object.assign(new Error("CMS request failed: content_preservation_unavailable"), { code: "content_preservation_unavailable", status: 422, retryable: false, requestOutcomeUncertain: !provenance });
    if (provenance) known.set(error, Object.freeze({ route_id: "V4-02", status: 422, service_origin: config.serverUrl, request_sha256: sha(JSON.stringify(body)), mutation_id: body.mutation_id, path: {}, envelope: { outcome: "rejected", code: "content_preservation_unavailable", retryable: false, retry_after_seconds: null, correlation_id: null, core_fallback: false }, artifact_binding: { ...sourceArtifactIdentity } }));
    throw error;
  };
  f.client.rejectedResponse = (error) => known.get(error) ?? priorEvidence(error);
}

test("genuinely changed complete preparation continues against accepted CAS while exact rejected evidence and native dates survive", async () => {
  const f = fixture(); await f.publish(); const accepted = (await f.store.read()).posts[key].cms_source.accepted_revision;
  f.native.html = "<p>Rejected article</p>"; const original = structuredClone(f.native); preservationRefusalSeam(f); await assert.rejects(f.publish());
  const rejected = structuredClone((await f.store.read()).posts[key].cms_source.intent); f.refusePreservation = false;
  await f.publish({ prepareSourceHtml: async (html) => `<section>${html}</section>` });
  const next = f.bodies.at(-1), saved = (await f.store.read()).posts[key].cms_source;
  assert.equal(next.bridge_record.expected_source_revision, accepted); assert.notEqual(next.mutation_id, rejected.body.mutation_id); assert.notEqual(next.bridge_record.source_revision, rejected.body.bridge_record.source_revision);
  assert.equal(next.bridge_record.source_content_sha256, sha(`<section>${original.html}</section>`)); assert.deepEqual(f.native, original);
  assert.deepEqual(saved.rejected_history, [rejected]); assert.equal(saved.accepted_history.length, 1); assert.equal(saved.accepted_history[0].source_revision, accepted); assert.equal(saved.intent, undefined);
});

test("truthful changed title continues the ordinary current edition with unchanged article bytes and dates", async () => {
  const f = fixture(); await f.publish(); const accepted = (await f.store.read()).posts[key].cms_source.accepted_revision;
  f.native.html = "<p>Rejected current article</p>";
  f.preservationResponse = { outcome: "rejected", code: "content_preservation_unavailable", retryable: false, retry_after_seconds: null, correlation_id: null, core_fallback: false };
  await assert.rejects(f.publish()); const rejected = structuredClone((await f.store.read()).posts[key].cms_source.intent);
  f.preservationResponse = undefined; f.native.title = "Genuinely changed native title"; await f.publish();
  const next = f.bodies.at(-1).bridge_record; assert.equal(next.title, f.native.title); assert.equal(next.source_content_sha256, rejected.body.bridge_record.source_content_sha256); assert.equal(next.source_content_bytes, rejected.body.bridge_record.source_content_bytes);
  assert.equal(next.source_updated_at, rejected.body.bridge_record.source_updated_at); assert.equal(next.expected_source_revision, accepted); assert.notEqual(next.source_revision, rejected.body.bridge_record.source_revision);
  assert.deepEqual((await f.store.read()).posts[key].cms_source.rejected_history, [rejected]);
});

test("known rejected first creation can use an actual new complete article without fabricated baseline or adoption", async () => {
  const f = fixture(); preservationRefusalSeam(f); await assert.rejects(f.publish());
  const rejected = structuredClone((await f.store.read()).posts[key].cms_source.intent); f.refusePreservation = false; f.native.html = "<p>Actually changed current source</p>";
  await f.publish(); assert.equal(f.bodies.length, 1); assert.equal(f.bodies[0].bridge_record.expected_source_revision, null); assert.equal(f.receipts.size, 1);
  assert.deepEqual((await f.store.read()).posts[key].cms_source.rejected_history, [rejected]); assert.equal(f.requests.some((path) => path === `/discussion-bridge/v4/bridge-records/${resource}.json`), false);
});

test("unverified error flags do not manufacture a definitive refusal or change exact uncertain replay", async () => {
  const f = fixture(); preservationRefusalSeam(f, { provenance: false }); await assert.rejects(f.publish());
  const intent = structuredClone((await f.store.read()).posts[key].cms_source.intent); assert.equal(intent.rejection_outcome, undefined);
  f.refusePreservation = false; await f.publish(); assert.deepEqual(f.bodies[0], intent.body);
});

test("a changed article cannot supersede refusal under lost current To authority or mismatched predecessor", async () => {
  for (const condition of ["authority", "predecessor"]) {
    const f = fixture(); await f.publish(); f.native.html = "<p>Rejected article</p>"; preservationRefusalSeam(f); await assert.rejects(f.publish());
    const rejected = structuredClone((await f.store.read()).posts[key].cms_source.intent); f.refusePreservation = false; f.native.html = "<p>New current article</p>";
    if (condition === "authority") f.authority.directions = ["from_discourse"]; else f.remote.source_revision = "some-other-current-revision";
    await assert.rejects(f.publish()); assert.equal(f.bodies.length, 1); assert.deepEqual((await f.store.read()).posts[key].cms_source.intent, rejected); assert.equal((await f.store.read()).posts[key].cms_source.rejected_history, undefined);
  }
});

test("V4 source uses actual editions, truthful whole bytes, null source time and all authors with stable identities", async () => {
  const f = fixture(), result = await f.publish(), first = f.bodies[0].bridge_record;
  assert.equal(result.topic_id, topic); assert.equal(f.reads, 2); assert.equal(first.expected_source_revision, null);
  assert.equal(first.source_content_sha256, sha(f.native.html)); assert.equal(first.source_content_bytes, Buffer.byteLength(f.native.html));
  assert.deepEqual(first.source_authors.map(({ name }) => name), ["First", "Second"]); assert.equal(first.source_created_at, "2026-01-01T00:00:00.000Z");
  await f.publish(); assert.equal(f.bodies.length, 1);
  f.native.html = "<p>Genuine edited fixture</p>"; f.native.updated_at = null; await f.publish();
  const second = f.bodies[1].bridge_record; assert.equal(second.expected_source_revision, first.source_revision); assert.notEqual(second.source_revision, first.source_revision); assert.equal(second.source_updated_at, null);
  const row = (await f.store.read()).posts[key]; assert.equal(row.topic_id, topic); assert.equal(row.resource_id, resource); assert.deepEqual(row.cms_source.accepted_history[0].input.bridge_record, first); assert.deepEqual(row.cms_source.accepted_artifacts, sourceArtifactIdentity);
});

test("accepted response loss replays exact original mutation/tree and predecessor", async () => {
  const f = fixture(); f.lose = true; await assert.rejects(f.publish());
  const intent = (await f.store.read()).posts[key].cms_source.intent; await f.publish();
  assert.deepEqual(f.bodies[1], intent.body); assert.equal(f.receipts.size, 1); assert.equal((await f.store.read()).posts[key].cms_source.intent, undefined);
});

test("changed native edition after unknown result needs actual accepted metadata; no stale replay or second creation", async () => {
  for (const accepted of [true, false]) {
    const f = fixture(); f.lose = true; await assert.rejects(f.publish());
    if (!accepted) { f.remote = null; f.receipts.clear(); }
    f.native.html = "<p>Later genuine edition</p>";
    if (accepted) { await f.publish(); assert.equal(f.bodies.length, 2); assert.equal(f.bodies[1].bridge_record.expected_source_revision, f.bodies[0].bridge_record.source_revision); }
    else { await assert.rejects(f.publish(), /uncertain/u); assert.equal(f.bodies.length, 1); }
  }
});

test("undefined HTML preparation and wrong To scope stop before source mutation", async () => {
  const f = fixture(); await assert.rejects(f.publish({ prepareSourceHtml: undefined }), /safety\/nonblank/u); assert.equal(f.bodies.length, 0); assert.equal((await f.store.read()).posts[key].outcome, "attention");
  for (const condition of ["origin", "direction"]) {
    const other = fixture(); if (condition === "origin") other.authority.destination_origin = "https://other.example"; if (condition === "direction") other.authority.directions = ["from_discourse"];
    await assert.rejects(other.publish(), /authority/u); assert.equal(other.bodies.length, 0);
  }
});

test("From selection being disabled neither grants nor denies current To authority or HTML qualification", async () => {
  const f = fixture(); f.authority.policy.enabled = false;
  await f.publish(); assert.equal(f.bodies.length, 1);
  const unqualified = fixture(); unqualified.authority.policy.enabled = false;
  await assert.rejects(unqualified.publish({ prepareSourceHtml: undefined }), /safety\/nonblank/u); assert.equal(unqualified.bodies.length, 0);
});

test("actual current native gates, second edition read, precision and canonical drift never become source success", async () => {
  for (const condition of ["draft", "imported", "precision", "changed-read"]) {
    const f = fixture(); if (condition === "draft") f.native.status = "draft"; if (condition === "imported") f.native.tags.push({ name: "#discussionbridge-source" }); if (condition === "precision") f.native.updated_at = "2026-10-14T00:00:00.000000001Z";
    const overrides = condition === "changed-read" ? { loadCurrentSource: async () => { const result = structuredClone(f.native); if (++f.reads > 1) result.html = "<p>Concurrent edit</p>"; return result; } } : {};
    await assert.rejects(f.publish(overrides)); assert.equal(f.bodies.length, 0);
  }
  const f = fixture(); await f.publish(); f.native.url = `${config.ghostOrigin}/changed/`; await assert.rejects(f.publish(), /source URL/u); assert.equal(f.bodies.length, 1);
});

test("both generated delivery thresholds preserve full source truth and exact owned prefix/suffix", async () => {
  for (const html of [`<p>${"雪".repeat(20000)}</p>`, `<p>${"\\\"".repeat(22000)}</p>`]) {
    const f = fixture(); f.native.html = html; await f.publish(); const request = f.bodies[0], record = request.bridge_record;
    assert.equal(record.representation.kind, "generated_excerpt"); assert.equal(record.source_content_bytes, Buffer.byteLength(html)); assert.equal(record.source_content_sha256, sha(html));
    assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 65536); assert.ok(Buffer.byteLength(record.content_html) <= 49152);
    const prefix = Buffer.from(record.content_html).subarray(0, record.representation.article_content_bytes).toString("utf8");
    assert.equal(sha(prefix), record.representation.article_content_sha256); assert.equal(record.content_html.slice(prefix.length), f.client.codec.generatedReadMore(f.native.url));
  }
});

test("authorized changed complete prepared snapshot uses predecessor CAS without inventing native edits or dates", async () => {
  const f = fixture(), nativeBefore = structuredClone(f.native); await f.publish(); const first = f.bodies[0].bridge_record;
  const prepareSourceHtml = async (html) => `<section>${html}</section>`;
  await f.publish({ prepareSourceHtml }); const second = f.bodies[1].bridge_record;
  assert.equal(second.expected_source_revision, first.source_revision); assert.notEqual(second.source_revision, first.source_revision);
  assert.equal(second.source_content_sha256, sha(`<section>${f.native.html}</section>`));
  assert.equal(second.source_created_at, first.source_created_at); assert.equal(second.source_updated_at, first.source_updated_at); assert.deepEqual(f.native, nativeBefore);
  await f.publish({ prepareSourceHtml }); assert.equal(f.bodies.length, 2, "identical complete snapshot does not mint an arbitrary edition");
  assert.equal((await f.store.read()).posts[key].cms_source.accepted_history[0].source_capture.article_url, nativeBefore.url);
  f.native.html = "<p>Changed actual source</p>"; f.reject = true; await assert.rejects(f.publish(), /reconciliation/u); assert.ok((await f.store.read()).posts[key].cms_source.intent); assert.equal(f.receipts.size, 2);
});

test("concurrent native notifications retain one source writer and one accepted creation", async () => {
  const f = fixture(); await Promise.all([f.publish(), f.publish()]); assert.equal(f.bodies.length, 1); assert.equal(f.receipts.size, 1);
});

test("plain text and image-only native articles are captured together with their URL without changing native original", async () => {
  for (const html of ["Unformatted source 雪", '<figure class="kg-card kg-image-card"><img src="../media/photo.jpg?a=1&amp;b=2" alt="Native image"></figure>']) {
    const f = fixture(); f.native.html = html; const original = structuredClone(f.native); let captured;
    await f.publish({ prepareSourceHtml: async (article, capture) => { assert.equal(article, html); assert.equal(Object.isFrozen(capture), true); captured = capture; return article; } });
    assert.deepEqual(captured, { native_id: id, article_url: original.url, html, lexical: null, context: { visibility: null, codeinjection_head: null, codeinjection_foot: null } });
    assert.deepEqual(f.native, original);
    const prepared = html.startsWith("<figure") ? html.replace('../media/photo.jpg?a=1&amp;b=2', 'https://ghost.example/media/photo.jpg?a=1&amp;b=2') : html;
    assert.equal(f.bodies[0].bridge_record.content_html, prepared);
    assert.equal(f.bodies[0].bridge_record.source_content_sha256, sha(prepared));
    const stored = (await f.store.read()).posts[key].cms_source.accepted_source_capture;
    assert.equal(stored.article_url, original.url); assert.equal(stored.native_content_sha256, sha(html)); assert.equal(stored.native_content_bytes, Buffer.byteLength(html));
  }
});

test("copied scalar relative targets use captured article URL while unrelated markup and absolute spelling stay exact", async () => {
  const f = fixture(); f.native.url = "https://ghost.example/articles/original/";
  f.native.html = `<div class='native'><a HREF = '../next?q=1&amp;b=2#part'>Read</a>雪<img src=/media/photo.png alt='x'><a href="#inside">Inside</a><a href="https://other.example/exact?x=1&amp;y=2">Other</a></div>`;
  await f.publish();
  assert.equal(f.bodies[0].bridge_record.content_html, `<div class='native'><a HREF = "https://ghost.example/articles/next?q=1&amp;b=2#part">Read</a>雪<img src="https://ghost.example/media/photo.png" alt='x'><a href="https://ghost.example/articles/original/#inside">Inside</a><a href="https://other.example/exact?x=1&amp;y=2">Other</a></div>`);
});

test("whole meaning-preserving prepared article and anchored references determine truth before excerpt selection", async () => {
  const f = fixture(); f.native.html = `<div>${"雪".repeat(20000)}<img src="../image.png" alt="Source"></div>`;
  const original = f.native.html, portable = `<section>${original}</section>`, complete = portable.replace('../image.png', 'https://ghost.example/image.png');
  await f.publish({ prepareSourceHtml: async (html, capture) => { assert.equal(html, original); assert.equal(capture.article_url, f.native.url); return portable; } });
  const record = f.bodies[0].bridge_record; assert.equal(record.representation.kind, "generated_excerpt");
  assert.equal(record.source_content_sha256, sha(complete)); assert.equal(record.source_content_bytes, Buffer.byteLength(complete));
  assert.notEqual(record.source_content_sha256, sha(original)); assert.equal(f.native.html, original);
  assert.equal(record.content_html.slice(Buffer.from(record.content_html).subarray(0, record.representation.article_content_bytes).toString("utf8").length), f.client.codec.generatedReadMore(f.native.url));
});

test("preparation changes cannot rewrite a pending edition, its captured URL, accepted history or exact replay bytes", async () => {
  const f = fixture(); f.native.html = '<p>Native</p><a href="../next">Link</a>'; f.lose = true;
  await assert.rejects(f.publish()); const before = structuredClone((await f.store.read()).posts[key].cms_source);
  await assert.rejects(f.publish({ prepareSourceHtml: async (html) => `<section>${html}</section>` }), /unchanged pending native edition/u);
  const after = (await f.store.read()).posts[key].cms_source; assert.deepEqual(after, before); assert.equal(f.bodies.length, 1);
  await f.publish(); assert.deepEqual(f.bodies[1], before.intent.body);
  const accepted = structuredClone((await f.store.read()).posts[key].cms_source);
  f.native.url = "https://ghost.example/moved/"; await assert.rejects(f.publish(), /source URL/u);
  assert.deepEqual((await f.store.read()).posts[key].cms_source, accepted); assert.equal(f.bodies.length, 2);
});

test("missing internal preparer and actual preparation inability remain Bridge attention rather than invalid-format source claims", async () => {
  for (const html of ["", " \n", "plain", '<img src="../image.png">']) {
    const f = fixture(); f.native.html = html;
    await assert.rejects(f.publish({ prepareSourceHtml: undefined }), (error) => error.code === "native_source_html_unqualified" && /source remains valid/u.test(error.message));
    assert.equal(f.bodies.length, 0); assert.equal(f.native.html, html);
  }
  const unavailable = fixture(); delete unavailable.native.html;
  await assert.rejects(unavailable.publish(), /Ghost Bridge cannot capture/u); assert.equal(unavailable.bodies.length, 0);
  const failed = fixture(); await assert.rejects(failed.publish({ prepareSourceHtml: async () => { throw new Error("Unrepresentable native card"); } }), /Ghost Bridge cannot prepare/u); assert.equal(failed.bodies.length, 0);
  for (const html of ['<a href="../one" href="../two">Native</a>']) {
    const f = fixture(); f.native.html = html; await assert.rejects(f.publish(), /Ghost Bridge cannot preserve/u); assert.equal(f.bodies.length, 0); assert.equal(f.native.html, html);
  }
  const complex = fixture(); complex.native.html = '<img srcset="../a.png 1x, ../b.png 2x">';
  await assert.rejects(complex.publish({ prepareSourceHtml: undefined }), (error) => error.code === "native_source_html_unqualified"); assert.equal(complex.bodies.length, 0);
});

test("composed complete native preparation retains original HTML/Lexical/context and full truth before generated excerpt", async () => {
  const f = fixture();
  f.native.html = `<figure class="kg-image-card"><img srcset="../a.png 1x, ../b.png 2x" alt="Source image"></figure><p>${"雪".repeat(18000)}</p>`;
  f.native.lexical = JSON.stringify({ root: { type: "root", children: [{ type: "paragraph", children: [{ text: "雪".repeat(18000) }] }] } });
  f.native.visibility = "public"; f.native.codeinjection_head = "<!--native context retained-->";
  const native = structuredClone(f.native), full = prepareGhostSourceHtml(f.native.html, { html: f.native.html, article_url: f.native.url, lexical: f.native.lexical });
  await f.publish();
  const sent = f.bodies[0].bridge_record, capture = (await f.store.read()).posts[key].cms_source.accepted_source_capture;
  assert.equal(sent.representation.kind, "generated_excerpt");
  assert.equal(sent.source_content_sha256, sha(full)); assert.equal(sent.source_content_bytes, Buffer.byteLength(full));
  assert.equal(capture.html, native.html); assert.equal(capture.lexical, native.lexical); assert.equal(capture.article_url, native.url);
  assert.equal(capture.context.codeinjection_head, native.codeinjection_head); assert.equal(capture.context.visibility, "public");
  assert.equal(capture.prepared_html, full); assert.equal(capture.prepared_content_sha256, sha(full)); assert.equal(capture.prepared_content_bytes, Buffer.byteLength(full));
  assert.deepEqual(f.native, native); assert.equal(f.reads, 2);
});

test("first large HTML plus Lexical read uses the complete bounded native observer/reader before source dispatch", async () => {
  const f = fixture(), reads = [];
  f.native.html = `<p>${"x".repeat(90000)}</p>`;
  f.native.lexical = JSON.stringify({ root: { type: "root", children: [{ text: "x".repeat(90000) }] } });
  const raw = JSON.stringify({ posts: [f.native] }); assert.ok(Buffer.byteLength(raw) > 131072);
  const ghost = new GhostAdminClient({ ...config, ghostAdminApiKey: `${"a".repeat(24)}:${"b".repeat(64)}` }, async (address, options) => {
    reads.push({ address, method: options.method });
    return new Response(raw, { headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(raw)) } });
  });
  await f.publish({ observeSourceLifecycle: (nativeId, prior) => observeGhostSourceLifecycle({ ...config, webhookMaximumBytes: 131072 }, ghost, nativeId, prior), loadCurrentSource: () => ghost.getSource(id, MAX_STATE_BYTES) });
  assert.equal(reads.length, 2); assert.ok(reads.every((read) => read.method === "GET" && read.address.includes("formats=html,lexical")));
  const capture = (await f.store.read()).posts[key].cms_source.accepted_source_capture;
  assert.equal(capture.html, f.native.html); assert.equal(capture.lexical, f.native.lexical); assert.equal(f.bodies.length, 1);
  assert.equal(f.bodies[0].bridge_record.source_content_sha256, sha(f.native.html));
});

test("complete retained-state budget refuses before HTTP while original, accepted receipt/history and other evidence remain exact", async () => {
  const f = fixture(); await f.publish();
  await f.store.update(async (state) => { state.saved_unrelated_evidence = "z".repeat(MAX_STATE_BYTES - 1024 * 1024); });
  assert.ok(Buffer.byteLength(serializedState(await f.store.read())) < MAX_STATE_BYTES);
  const accepted = structuredClone((await f.store.read()).posts[key].cms_source);
  f.native.html = `<p>${"n".repeat(400000)}</p>`;
  f.native.lexical = JSON.stringify({ root: { type: "root", children: [{ text: "n".repeat(400000) }] } });
  const native = structuredClone(f.native);
  await assert.rejects(f.publish(), /cannot retain.*protected state budget/iu);
  const state = await f.store.read(); assert.equal(f.bodies.length, 1); assert.deepEqual(f.native, native);
  assert.deepEqual(state.posts[key].cms_source, accepted); assert.equal(state.saved_unrelated_evidence.length, MAX_STATE_BYTES - 1024 * 1024);
  assert.match(state.posts[key].failure_reason, /no source request was dispatched/iu);
});

test("specific preparation limitation retains original private capture with no wire mutation or false source rejection", async () => {
  const f = fixture(); f.native.html = '<script type="application/ld+json">{"name":"Native meaning"}</script>';
  f.native.lexical = JSON.stringify({ root: { type: "root", children: [{ type: "html", html: f.native.html }] } });
  const native = structuredClone(f.native); await assert.rejects(f.publish(), /embedded script content\/data/iu);
  const saved = (await f.store.read()).posts[key]; assert.equal(f.bodies.length, 0); assert.equal(saved.cms_source.intent, undefined);
  assert.equal(saved.cms_source.last_preparation_issue.capture.html, native.html); assert.equal(saved.cms_source.last_preparation_issue.capture.lexical, native.lexical);
  assert.match(saved.failure_reason, /embedded script content\/data/iu); assert.deepEqual(f.native, native);
});

test("native Lexical/context change before dispatch retains exact pending capture and makes no request", async () => {
  const f = fixture(); f.native.lexical = JSON.stringify({ root: { children: [{ text: "Original" }] } }); let reads = 0;
  await assert.rejects(f.publish({ loadCurrentSource: async () => { const native = structuredClone(f.native); if (++reads === 2) native.lexical = JSON.stringify({ root: { children: [{ text: "New hidden contextual data" }] } }); return native; } }), /captured HTML\/Lexical\/context changed/iu);
  const saved = (await f.store.read()).posts[key]; assert.equal(saved.cms_source.intent.source_capture.lexical, f.native.lexical);
  assert.equal(saved.cms_source.intent.request_state, "prepared"); assert.equal(f.bodies.length, 0);
});
