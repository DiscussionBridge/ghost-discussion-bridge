// PURE ONLY: in-memory native methods, no HTTP, service, process or state worker.
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, sha, nativeId, resourceId } from "./fixtures/cms-native-fixture.mjs";
import { ghostCmsNative } from "../src/cms-native-publication.mjs";
import { sourceActivityDate } from "../src/source-activity-date.mjs";

test("unedited actual source time projects creation on the first owned copy without writing native creation/update clocks", async () => {
  const f = fixture(); f.context.source.source_updated_at = f.context.source.source_created_at;
  const calls = [], update = f.ghost.update.bind(f.ghost), create = f.ghost.create.bind(f.ghost);
  f.ghost.create = async (payload, type) => { calls.push(structuredClone(payload)); return create(payload, type); };
  f.ghost.update = async (id, payload, type) => { calls.push(structuredClone(payload)); return update(id, payload, type); };
  await ghostCmsNative(f.ghost).synchronize(f.context);
  assert.equal(f.object().published_at, f.context.source.source_created_at);
  assert.ok(calls.every((payload) => !Object.hasOwn(payload, "created_at")));
  assert.equal(calls[1].updated_at, "1970-01-01T00:00:01.000Z");
  assert.notEqual(f.object().updated_at, f.context.source.source_updated_at);
});

test("already-edited FIRST Ghost copy uses actual Discourse edit and displays/retains both source dates", async () => {
  for (const type of ["post", "page"]) {
    const f = fixture(type), source = structuredClone(f.context.source);
    const result = await ghostCmsNative(f.ghost).synchronize(f.context);
    assert.equal(result.outcome, "created"); assert.equal(f.object().published_at, source.source_updated_at);
    assert.match(f.object().html, new RegExp(`Source created: <time datetime="${source.source_created_at}"`, "u"));
    assert.match(f.object().html, new RegExp(`Source updated: <time datetime="${source.source_updated_at}"`, "u"));
    const state = await f.context.store.read(); assert.equal(state.publications[resourceId].source_created_at, source.source_created_at); assert.equal(state.publications[resourceId].source_updated_at, source.source_updated_at);
    assert.deepEqual(f.context.source, source); assert.equal(result.nativeResult.native_id, nativeId);
  }
});

test("same edition/replay makes no native update and later wiki edition resurfaces using only its actual source edit", async () => {
  const f = fixture(), native = ghostCmsNative(f.ghost); await native.synchronize(f.context);
  const priorDate = f.object().published_at, first = structuredClone(f.object()), count = f.counts().updates;
  assert.equal((await native.synchronize(f.context)).outcome, "unchanged"); assert.equal(f.counts().updates, count); assert.deepEqual(f.object(), first);
  f.context.source.source_revision = "wiki-2"; f.context.work.source_revision = "wiki-2";
  f.context.source.source_updated_at = "2026-10-15T04:00:00.000Z";
  f.context.content = { html: "<p>Actual wiki edit</p>", bytes: Buffer.from("<p>Actual wiki edit</p>") };
  f.context.source.content_sha256 = sha(f.context.content.bytes); f.context.source.content_bytes = f.context.content.bytes.length;
  await native.synchronize(f.context);
  assert.equal(f.object().published_at, f.context.source.source_updated_at); assert.notEqual(f.object().published_at, priorDate);
  assert.equal(f.object().id, first.id); assert.equal(f.object().url, first.url); assert.equal(f.counts().creates, 1);
  const updatedCount = f.counts().updates; await native.synchronize(f.context); assert.equal(f.counts().updates, updatedCount);
});

test("independently known actual edit projects without requiring non-null creation", async () => {
  const f = fixture(); f.context.source.source_created_at = null; await ghostCmsNative(f.ghost).synchronize(f.context);
  assert.equal(f.object().published_at, f.context.source.source_updated_at); assert.doesNotMatch(f.object().html, /Source created:/u); assert.match(f.object().html, /Source updated:/u);
  assert.equal((await f.context.store.read()).publications[resourceId].source_created_at, null);
});

test("unknown actual activity remains a local projection limitation without rewriting a valid Source or prior owned native receipt", async () => {
  const f = fixture(), native = ghostCmsNative(f.ghost); await native.synchronize(f.context);
  const owned = structuredClone(f.object()), receipt = structuredClone((await f.context.store.read()).publications[resourceId].cms.ownership_receipt), count = f.counts().updates;
  f.context.source.source_updated_at = null;
  const source = structuredClone(f.context.source);
  await assert.rejects(native.synchronize(f.context), (error) => error.localNativeLimitation === true && /unknown.*no creation\/native-save fallback/iu.test(error.message) && /source metadata remains valid/iu.test(error.message));
  assert.equal(f.counts().updates, count); assert.deepEqual(f.object(), owned); assert.deepEqual(f.context.source, source);
  assert.deepEqual((await f.context.store.read()).publications[resourceId].cms.ownership_receipt, receipt);
  assert.throws(() => sourceActivityDate({ source_created_at: null, source_updated_at: null }), /source metadata remains valid/iu);
});

test("first publication requires actual stable permalink evidence and rejects configured date-token movement before any native write", async () => {
  for (const route of [undefined, "/{year}/{month}/{slug}/"]) {
    const f = fixture(); if (route === undefined) delete f.context.config.sourceNativeIntegration; else f.context.config.sourceNativeIntegration.permalink = route;
    await assert.rejects(ghostCmsNative(f.ghost).synchronize(f.context), (error) => error.localNativeLimitation === true && /permalink|date-token/iu.test(error.message));
    assert.equal(f.counts().creates, 0); assert.equal(f.counts().updates, 0);
  }
  const dated = fixture(); dated.context.mapping.canonical_url = "https://ghost.example/2026/10/article/";
  await assert.rejects(ghostCmsNative(dated.ghost).synchronize(dated.context), /stable root-slug/iu); assert.equal(dated.counts().creates, 0);
});

test("actual existing stable root-slug native URL supports an update without unrelated To proof selectors", async () => {
  const f = fixture(), native = ghostCmsNative(f.ghost); await native.synchronize(f.context);
  delete f.context.config.sourceNativeIntegration;
  f.context.source.source_updated_at = "2026-10-15T02:00:00.000Z"; f.context.source.source_revision = "next"; f.context.work.source_revision = "next";
  await native.synchronize(f.context); assert.equal(f.object().published_at, f.context.source.source_updated_at); assert.equal(f.counts().creates, 1);
});

test("native readback must persist the selected actual source date rather than falsely acknowledging a rounded/substituted date", async () => {
  const f = fixture(), update = f.ghost.update.bind(f.ghost);
  f.ghost.update = (id, payload, type) => update(id, { ...payload, published_at: "2020-01-01T00:00:00.000Z" }, type);
  await assert.rejects(ghostCmsNative(f.ghost).synchronize(f.context), /not persisted exactly/iu);
  const state = await f.context.store.read(); assert.ok(state.publications[resourceId].cms.intent); assert.equal(state.publications[resourceId].cms.ownership_receipt.source_revision, null);
  await assert.rejects(ghostCmsNative(f.ghost).synchronize(f.context), /draft content changed/iu); assert.equal(f.counts().updates, 1);
  assert.equal(sourceActivityDate({ source_created_at: null, source_updated_at: "2026-10-15T00:00:00.000001Z" }), "2026-10-15T00:00:00.000Z");
});

test("canonical-only owned native move retains actual source activity instead of creating fresh Latest activity", async () => {
  const f = fixture(), native = ghostCmsNative(f.ghost); await native.synchronize(f.context);
  f.context.mapping.destination_native_id = nativeId;
  const oldNative = await native.inspectMove(f.context), before = structuredClone(f.context.source), date = f.object().published_at;
  const move = { move_id: "44444444-4444-4444-8444-444444444444", proof_nonce: Buffer.alloc(32, 5).toString("base64url"), old_url: f.context.mapping.canonical_url, new_url: "https://ghost.example/moved/" };
  await f.context.store.update(async (state) => { state.publications[resourceId].cms.url_move_request = { old_url: move.old_url, new_url: move.new_url, old_native: oldNative }; });
  const result = await native.move(f.context, move);
  assert.equal(result.nativeResult.native_id, nativeId); assert.equal(result.nativeResult.canonical_url, move.new_url);
  assert.equal(f.object().published_at, date); assert.deepEqual(f.context.source, before); assert.equal(f.counts().creates, 1);
});
