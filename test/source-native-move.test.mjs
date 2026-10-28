import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { CmsClient } from "../lib/cms-client.mjs";
import { createGeneratedExcerpt, generatedReadMore } from "../lib/cms-runtime.mjs";
import { sourceArtifactIdentity } from "../lib/cms-vendor.mjs";
import { GhostAdminClient } from "../src/ghost-admin-client.mjs";
import { prepareGhostSourceMove } from "../src/cms-source-move.mjs";
import { publishSource } from "../src/source-write.mjs";
import { nativeEdition } from "../src/cms-source-publication.mjs";
import { nativeSourceBaseline, publishedGhostSource } from "../src/ghost-source.mjs";
import { StateStore } from "../src/state-store.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const id = "a".repeat(24), key = `ghost-post:${id}`, resource = "11111111-1111-4111-8111-111111111111", moveId = "22222222-2222-4222-8222-222222222222", topic = "9223372036854775807", revision = "original-accepted-edition";
const origin = "https://ghost.example", forum = "https://forum.example", newUrl = `${origin}/new/`;
const config = { ghostOrigin: origin, serverUrl: forum, connectionId: "dbc_0123456789abcdef01234567", connectionSecret: "s".repeat(48), ghostAdminApiKey: `${id}:${"a".repeat(64)}`, publicationType: "page", sourceNativeIntegration: { native_version: "synthetic-native-1", theme_id: "synthetic-theme", permalink: "/{slug}/", article: { tag: "section", class: "fixture-article" }, title: { tag: "h1", class: "fixture-title" }, prefix: "\n", suffix: "\n" } };
const copy = (value) => structuredClone(value);

async function fixture({ generated = false, durable = false } = {}) {
  const native = { id, uuid: resource, type: "post", slug: "old", title: "Native article", html: `<p>${generated ? "Safe fixture ".repeat(6000) : 'Complete é article <img src="https://ghost.example/media.png" alt="image">'}</p><!--tail remains-->`, lexical: '{"root":{"type":"root","children":[]}}', url: `${origin}/old/`, status: "published", visibility: "public", tags: [{ id: "t", name: "#discussionbridge", slug: "hash-discussionbridge" }], authors: [{ id: "writer", name: "Writer" }, { id: "other", name: "Other" }], primary_author: { id: "writer" }, created_at: "2026-01-01T00:00:00.000Z", published_at: "2026-01-02T00:00:00.000Z", updated_at: "2026-10-14T01:00:00.000Z", codeinjection_head: '<meta name="unrelated" content="retained">', codeinjection_foot: "<!--unrelated footer-->" };
  const connection = { connection_id: config.connectionId, profile: "ghost", destination_origin: origin, scope_revision: "scope", forum_name: "Forum", directions: ["to_discourse"], policy: { policy_revision: "policy", enabled: true, selection: "all_public", category_ids: [], include_topic_ids: [], exclude_topic_ids: [], include_unlisted: false, publication_kind: "dynamic", presentation_mode: "full", author_ids: [], taxonomy_ids: [] }, publication_lane: "default", native_capabilities: { native_revision: "native", supported_presentations: ["full"], publication_kind: "dynamic", complete_content_supported: true } };
  let input = { direction: "to_discourse", external_id: key, canonical_url: native.url, title: native.title, content_html: native.html, published: true, source_revision: revision, expected_source_revision: null, source_created_at: native.created_at, source_updated_at: native.updated_at, source_content_sha256: sha(native.html), source_content_bytes: Buffer.byteLength(native.html), representation: { kind: "full" }, source_authors: [{ id: "ghost-author:writer", name: "Writer" }, { id: "ghost-author:other", name: "Other" }], primary_source_author_id: "ghost-author:writer" };
  if (generated) input = createGeneratedExcerpt(input, native.html, "<p>Selected exact prefix</p>");
  const originalReceipt = { outcome: "created", reason: "record_created", resource_id: resource, topic_id: topic, topic_url: `${forum}/t/native/${topic}`, direction: "to_discourse", source_revision: revision, synchronized_at: native.updated_at, core_fallback: false };
  let state = { version: 1, posts: { [key]: { source_protocol: "v4", canonical_url: native.url, resource_id: resource, topic_id: topic, cms_source: { accepted_revision: revision, accepted_native_baseline: nativeSourceBaseline(native, publishedGhostSource(native, config)), accepted_input: { mutation_id: resource, bridge_record: input }, accepted_receipt: originalReceipt, accepted_history: [], accepted_raw_edition: nativeEdition(native, publishedGhostSource(native, config)) } } }, publications: {}, presentations: {} };
  const directory = durable ? await mkdtemp(join(tmpdir(), "ghost-v4-source-move-")) : null, statePath = directory ? join(directory, "state.json") : null;
  const memory = { read: async () => copy(state), update: async (callback) => { const next = copy(state); await callback(next); state = next; }, withNativeLock: async (callback) => callback(async () => {}) };
  const store = durable ? new StateStore(statePath) : memory;
  if (durable) await store.update(async (next) => Object.assign(next, state));
  const f = { native, connection, store, originalInput: copy(input), originalReceipt: copy(originalReceipt), directory, statePath, record: { resource_id: resource, direction: "to_discourse", state: "active", topic_id: topic, topic_url: originalReceipt.topic_url, external_id: key, canonical_url: native.url, source_revision: revision, source_created_at: native.created_at, source_updated_at: native.updated_at, synchronized_at: native.updated_at, mapping_id: null }, mutations: [], nativeWrites: [], publicRequests: [], receipts: new Map(), failures: [], history: [] };
  const server = createServer(async (request, response) => {
    try {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const url = new URL(request.url, "http://loopback"), body = raw ? JSON.parse(raw) : null;
      const send = (payload, status = 200, media = "application/json") => { response.writeHead(status, { "Content-Type": media }); response.end(typeof payload === "string" ? payload : JSON.stringify(payload)); };
      if (url.pathname.startsWith("/ghost/api/admin/")) {
        assert.match(request.headers.authorization ?? "", /^Ghost /u);
        if (request.method === "GET") {
          if (/\/(posts|pages)\/$/u.test(url.pathname)) return send(url.pathname.includes("/pages/") ? { pages: [] } : { posts: f.collision ? [{ id: "b".repeat(24), slug: "new" }] : f.native.slug === "new" ? [f.native] : [] });
          assert.equal(url.searchParams.get("formats"), "html,lexical"); assert.equal(url.searchParams.get("include"), "authors,tags");
          return send({ posts: [f.native] });
        }
        assert.equal(request.method, "PUT"); assert.equal(url.pathname, `/ghost/api/admin/posts/${id}/`); assert.equal(url.search, "");
        assert.deepEqual(Object.keys(body.posts[0]).sort(), ["codeinjection_head", "slug", "updated_at"]);
        const saved = (await f.store.read()).posts[key].cms_source.source_url_move;
        assert.equal(saved.native_intent.dispatched, true); assert.deepEqual(saved.native_intent.payload, body.posts[0]);
        f.nativeWrites.push(copy(body.posts[0]));
        if (f.concurrentCAS) { f.native.updated_at = "2026-10-15T00:00:02.000Z"; return send({ errors: [{ message: "concurrent native edition" }] }, 409); }
        if (f.rejectNative) return send({ errors: [{ message: "native CAS rejected" }] }, 409);
        assert.equal(body.posts[0].updated_at, f.native.updated_at);
        if (f.unknownUnapplied) { response.destroy(); return; }
        Object.assign(f.native, { slug: body.posts[0].slug, url: `${origin}/${body.posts[0].slug}/`, codeinjection_head: body.posts[0].codeinjection_head, updated_at: "2026-10-15T00:00:00.000Z" });
        if (f.mutateNative) f.native.html += "<p>Unexpected native edit</p>";
        if (f.loseNative) { f.loseNative = false; response.destroy(); return; }
        return send({ posts: [f.native] });
      }
      if (url.pathname.startsWith("/discussion-bridge/v4/")) {
        if (request.method === "GET") return send(url.pathname.endsWith("/connection.json") ? f.connection : url.pathname.endsWith("/url-history.json") ? { items: f.history, next_cursor: null } : f.record);
        const saved = (await f.store.read()).posts[key].cms_source, stage = url.pathname.endsWith("/finalize.json") ? "finalize" : url.pathname.endsWith("/abort.json") ? "abort" : url.pathname.endsWith("/resolve.json") ? "resolve" : "prepare";
        f.mutations.push({ stage, body: copy(body) });
        if (f.receipts.has(body.mutation_id)) return send(f.receipts.get(body.mutation_id));
        let payload;
        if (stage === "prepare") {
          assert.deepEqual(saved.source_url_move.intent.body, body); assert.equal(saved.source_url_move.intent.request_state, "uncertain");
          payload = { move_id: moveId, resource_id: resource, expected_source_revision: body.expected_source_revision, old_url: body.old_url, new_url: body.new_url, proof_nonce: Buffer.alloc(32, 7).toString("base64url"), state: "prepared", prepared_at: "2026-10-15T00:00:00.000Z" };
        } else if (stage === "abort") {
          assert.deepEqual(saved.source_url_move.abort_intent.body, body); assert.equal(body.native_change_applied, false); assert.equal(f.native.url, `${origin}/old/`);
          payload = { ...saved.source_url_move.prepare_response, state: "aborted" };
        } else if (stage === "finalize") {
          assert.deepEqual(saved.source_url_move.finalize_intent.body, body); assert.equal(saved.source_url_move.finalize_intent.request_state, "uncertain");
          assert.equal(body.verification.native_ownership_receipt_sha256, saved.source_url_move.ownership_receipt.sha256); assert.notEqual(body.verification.native_publication_sha256, input.source_content_sha256);
          if (f.rejectFinalize) return send({ outcome: "rejected", code: "content_preservation_unavailable", retryable: false, retry_after_seconds: null, correlation_id: null, core_fallback: false }, 422);
          f.record = { ...f.record, canonical_url: newUrl, source_revision: body.new_source_revision, source_updated_at: body.source_updated_at, synchronized_at: "2026-10-15T00:00:01.000Z" };
          f.history.push({ url: `${origin}/old/`, retired_at: "2026-10-15T00:00:01.000Z", move_id: moveId }); payload = f.record;
        } else {
          assert.equal(body.bridge_record.expected_source_revision, f.record.source_revision);
          payload = { ...f.originalReceipt, outcome: "updated", reason: "source_revision_updated", source_revision: body.bridge_record.source_revision };
          f.record = { ...f.record, source_revision: body.bridge_record.source_revision };
        }
        f.receipts.set(body.mutation_id, copy(payload));
        if (f.loseStage === stage) { f.loseStage = null; response.destroy(); return; }
        return send(payload, stage === "prepare" ? 201 : 200);
      }
      assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined); f.publicRequests.push(url.pathname);
      if (f.redirectPublic) { response.writeHead(302, { Location: "/login/" }); response.end(); return; }
      const bodyHtml = f.badPublic || f.badNewPublic && f.native.slug === "new" ? "<p>Teaser without full body</p>" : f.native.html;
      const head = f.wrongPublicNonce && f.native.slug === "new" ? (f.native.codeinjection_head ?? "").replace('name="discussionbridge-source-move"', 'name="unrelated-challenge"') : f.native.codeinjection_head ?? "";
      return send(`<!doctype html><html><head>${head}</head><body><h1 class="fixture-title">${f.native.title}</h1><section class="fixture-article">\n${bodyHtml}\n</section></body></html>`, 200, "text/html");
    } catch (error) { f.failures.push(error); response.writeHead(500, { "Content-Type": "application/json" }); response.end("{}"); }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const localOrigin = `http://127.0.0.1:${server.address().port}`;
  const transport = async (address, options) => {
    assert.ok([origin, forum].includes(new URL(address).origin));
    const result = await fetch(`${localOrigin}${new URL(address).pathname}${new URL(address).search}`, options);
    Object.defineProperty(result, "url", { value: address }); return result;
  };
  f.client = new CmsClient({ serviceOrigin: forum, connectionId: config.connectionId, connectionSecret: config.connectionSecret }, { fetchImplementation: transport });
  f.ghost = new GhostAdminClient(config, transport);
  f.request = { native_id: id, expected_source_revision: revision, new_url: newUrl };
  f.run = () => prepareGhostSourceMove(f.request, config, f.store, f.client, f.ghost, { publicFetch: transport, now: () => Date.parse("2026-10-15T00:00:00.000Z") });
  f.restart = () => { if (durable) f.store = new StateStore(statePath); };
  f.close = async () => { const closed = new Promise((done) => server.close(done)); server.closeAllConnections(); await closed; if (directory) { if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}ghost-v4-source-move-`)) throw new Error("Unexpected move test path"); await rm(directory, { recursive: true, force: true }); } assert.deepEqual(f.failures, []); };
  return f;
}

test("actual native Admin/public/typed full and generated move keeps original identity/article and02 receipts, then unchanged webhook returns29", async () => {
  for (const generated of [false, true]) {
    const f = await fixture({ generated });
    try {
      const before = copy(f.native), result = await f.run(), saved = (await f.store.read()).posts[key], cs = saved.cms_source;
      assert.equal(result.state, "finalized"); assert.equal(f.nativeWrites.length, 1); assert.equal(saved.canonical_url, newUrl); assert.equal(saved.source_revision, f.record.source_revision); assert.equal(f.native.html, before.html); assert.equal(f.native.lexical, before.lexical); assert.deepEqual(f.native.authors, before.authors);
      assert.deepEqual(cs.accepted_input.bridge_record, f.originalInput); assert.deepEqual(cs.accepted_receipt, f.originalReceipt); assert.equal(cs.source_url_move, undefined); assert.equal(cs.current_source_receipt.source_revision, f.record.source_revision);
      const input = cs.current_source_input.bridge_record;
      assert.equal(input.source_content_sha256, f.originalInput.source_content_sha256); assert.equal(input.source_content_bytes, f.originalInput.source_content_bytes);
      if (generated) { assert.equal(input.representation.article_content_sha256, f.originalInput.representation.article_content_sha256); assert.equal(input.representation.article_content_bytes, f.originalInput.representation.article_content_bytes); assert.ok(input.content_html.startsWith("<p>Selected exact prefix</p>")); assert.ok(input.content_html.includes(newUrl)); }
      else assert.equal(input.content_html, f.originalInput.content_html);
      const noRecipe = await publishSource({ native_id: id }, config, f.store, f.client, { loadCurrentSource: () => f.ghost.getSource(id, 1024 * 1024) });
      assert.equal(noRecipe.source_revision, f.record.source_revision); assert.equal(f.mutations.filter((item) => item.stage === "resolve").length, 0);
      await f.run(); assert.equal(f.nativeWrites.length, 1); assert.equal(f.mutations.filter((item) => item.stage === "finalize").length, 1);
      const movedRevision = f.record.source_revision; f.native.title = "Truthful later native edit";
      await publishSource({ native_id: id }, config, f.store, f.client, { loadCurrentSource: () => f.ghost.getSource(id, 1024 * 1024), prepareSourceHtml: async (html) => html });
      const next = (await f.store.read()).posts[key].cms_source; assert.equal(f.mutations.at(-1).body.bridge_record.expected_source_revision, movedRevision); assert.equal(next.accepted_history.at(-1).receipt.source_revision, movedRevision); assert.deepEqual(next.accepted_history.at(-1).artifact_binding, sourceArtifactIdentity); assert.equal(next.current_source_receipt, undefined);
    } finally { await f.close(); }
  }
});

test("longer moved generated suffix cannot truncate the accepted prefix or cross the cap before reservation/native write", async () => {
  const f = await fixture({ generated: true });
  try {
    const budget = 49152 - Buffer.byteLength(generatedReadMore(`${origin}/old/`)), article = `<p>${"Safe fixture ".repeat(5000).slice(0, budget - 7)}</p>`;
    const input = createGeneratedExcerpt({ ...f.originalInput, representation: { kind: "full" }, content_html: f.native.html }, f.native.html, article);
    assert.equal(Buffer.byteLength(input.content_html), 49152);
    await f.store.update(async (state) => { state.posts[key].cms_source.accepted_input.bridge_record = input; });
    f.request.new_url = `${origin}/${"long-new-slug".repeat(10)}/`;
    await assert.rejects(f.run()); assert.equal(f.nativeWrites.length, 0); assert.equal(f.mutations.length, 0); assert.deepEqual((await f.store.read()).posts[key].cms_source.accepted_input.bridge_record, input);
  } finally { await f.close(); }
});

test("durable restart recovers lost native response and accepted29 response without repeating native PUT", async () => {
  for (const stage of ["native", "finalize", "prepare"]) {
    const f = await fixture({ durable: true });
    try { if (stage === "native") f.loseNative = true; else f.loseStage = stage;
      await assert.rejects(f.run()); const before = await f.store.read(); f.restart(); const result = await f.run(); assert.equal(result.state, "finalized"); assert.equal(f.nativeWrites.length, 1);
      const after = await f.store.read(); assert.equal(after.posts[key].cms_source.source_url_move, undefined); assert.equal(after.posts[key].source_revision, f.record.source_revision);
      if (stage === "finalize") assert.deepEqual(f.mutations.filter((item) => item.stage === "finalize")[1].body, before.posts[key].cms_source.source_url_move.finalize_intent.body);
      if (stage === "prepare") assert.deepEqual(f.mutations.filter((item) => item.stage === "prepare")[1].body, before.posts[key].cms_source.source_url_move.intent.body);
    } finally { await f.close(); }
  }
});

test("unknown unapplied native result is lookup-only and cannot abort, repeat or release either reservation", async () => {
  const f = await fixture();
  try { f.unknownUnapplied = true; await assert.rejects(f.run()); await assert.rejects(f.run()); const job = (await f.store.read()).posts[key].cms_source.source_url_move; assert.equal(job.state, "attention_applied_or_unknown"); assert.equal(f.nativeWrites.length, 1); assert.equal(f.mutations.some((item) => ["finalize", "abort"].includes(item.stage)), false); assert.equal(f.native.url, `${origin}/old/`); }
  finally { await f.close(); }
});

test("definitive native CAS rejection aborts only with exact still-old complete ownership/public proof", async () => {
  const f = await fixture();
  try { f.rejectNative = true; const result = await f.run(); assert.equal(result.state, "aborted"); assert.equal(f.nativeWrites.length, 1); assert.equal(f.mutations.filter((item) => item.stage === "abort").length, 1); const saved = (await f.store.read()).posts[key]; assert.equal(saved.source_revision, undefined); assert.equal(saved.cms_source.accepted_revision, revision); assert.equal(saved.cms_source.source_url_move, undefined); assert.equal(saved.cms_source.source_move_history[0].abort_ownership_receipt.fields.observed_url, `${origin}/old/`); }
  finally { await f.close(); }
});

test("lost accepted abort response replays exact30 after durable restart without another native mutation", async () => {
  const f = await fixture({ durable: true });
  try { f.rejectNative = true; f.loseStage = "abort"; await assert.rejects(f.run()); const saved = (await f.store.read()).posts[key].cms_source.source_url_move.abort_intent; f.restart(); const result = await f.run(); assert.equal(result.state, "aborted"); assert.equal(f.nativeWrites.length, 1); assert.deepEqual(f.mutations.filter((item) => item.stage === "abort").map((item) => item.body), [saved.body, saved.body]); }
  finally { await f.close(); }
});

test("native collision/full-body loss/redirect/unpreservable actual target/source drift prevents false29 success", async () => {
  for (const kind of ["collision", "public", "new_public", "nonce", "redirect", "native", "cas", "relative", "scope", "stale"]) {
    const f = await fixture();
    try {
      if (kind === "collision") f.collision = true;
      if (kind === "public") f.badPublic = true;
      if (kind === "new_public") f.badNewPublic = true;
      if (kind === "nonce") f.wrongPublicNonce = true;
      if (kind === "redirect") f.redirectPublic = true;
      if (kind === "native") f.mutateNative = true;
      if (kind === "cas") f.concurrentCAS = true;
      if (kind === "relative") { f.native.html = '<p><a href="local-target">Copied meaning</a></p>'; await f.store.update(async (state) => { state.posts[key].cms_source.accepted_native_baseline = nativeSourceBaseline(f.native, publishedGhostSource(f.native, config)); }); }
      if (kind === "scope") f.connection.directions = ["from_discourse"];
      if (kind === "stale") f.record.source_revision = "newer-authority";
      await assert.rejects(f.run()); assert.equal(f.mutations.some((item) => item.stage === "finalize"), false);
      assert.equal(f.nativeWrites.length, ["native", "new_public", "nonce", "cas"].includes(kind) ? 1 : 0);
      assert.equal(f.mutations.some((item) => item.stage === "abort"), false);
    } finally { await f.close(); }
  }
});

test("actual typed permanent29 preservation rejection is retained across restart with no automatic resend", async () => {
  const f = await fixture({ durable: true });
  try { f.rejectFinalize = true; await assert.rejects(f.run()); const saved = (await f.store.read()).posts[key].cms_source.source_url_move; assert.equal(saved.finalize_rejection.envelope.code, "content_preservation_unavailable"); assert.equal(saved.state, "known_rejected"); f.restart(); f.rejectFinalize = false; await assert.rejects(f.run()); assert.equal(f.nativeWrites.length, 1); assert.equal(f.mutations.filter((item) => item.stage === "finalize").length, 1); assert.deepEqual((await f.store.read()).posts[key].cms_source.source_url_move.finalize_intent, saved.finalize_intent); }
  finally { await f.close(); }
});
