import assert from "node:assert/strict";
import test from "node:test";
import { fixture, nativeId, resourceId, workId } from "./fixtures/cms-native-fixture.mjs";
import { ghostCmsNative } from "../src/cms-native-publication.mjs";

function readOnly(f) {
  const before = structuredClone(f.context.store.state), counts = f.counts();
  f.context.store.update = async () => assert.fail("native Check must not write the publication/journal");
  return () => { assert.deepEqual(f.context.store.state, before); assert.equal(f.counts().creates, counts.creates); assert.equal(f.counts().updates, counts.updates); };
}
const checkContext = (f) => ({ ...f.context, assertOperation: async () => {}, now: () => 1_793_000_000_000 });
const checker = (f) => ghostCmsNative(f.ghost, { publicFetch: async (url) => {
  const response = new Response(f.object()?.status === "published" ? `<article>${f.object().html}</article>` : "", { status: f.object()?.status === "published" ? 200 : 404, headers: { "Content-Type": "text/html" } });
  Object.defineProperty(response, "url", { value: url }); return response;
} });

test("native attention Check proves a never-applied first publication without creating an object", async () => {
  const f = fixture(), untouched = readOnly(f), native = checker(f);
  const result = await native.inspectAttention(checkContext(f));
  assert.equal(result.native_state, "never_applied"); assert.equal(result.object_exists, false); assert.equal(result.native_id, null); assert.equal(result.pending_mutation, "none"); untouched();
});

test("native Check matches the exact owned baseline and preserves every old receipt and native byte", async () => {
  const f = fixture(), native = checker(f); await native.synchronize(f.context);
  const untouched = readOnly(f), result = await native.inspectAttention(checkContext(f));
  assert.equal(result.native_state, "baseline"); assert.equal(result.native_id, nativeId); assert.equal(result.native_revision, f.object().updated_at);
  assert.equal(result.ownership.ownership_receipt_sha256, f.context.store.state.publications[resourceId].cms.ownership_receipt_sha256);
  assert.equal(result.issue, "none"); untouched();
});

test("known applied same-object candidate is read back without renewing, writing a receipt or repeating the update", async () => {
  const f = fixture("post", "full", { lostUpdate: true }), native = checker(f);
  await assert.rejects(native.synchronize(f.context), /lost update/);
  const untouched = readOnly(f), result = await native.inspectAttention(checkContext(f));
  assert.equal(result.native_state, "candidate_applied"); assert.equal(result.native_id, nativeId); assert.equal(result.source_revision, f.context.work.source_revision);
  assert.equal(result.ownership.source_revision, null); assert.equal(result.pending_mutation, "settled"); untouched();
});

test("exact r5 native revision/content/title/receipt remains a baseline without inventing a historical metadata snapshot", async () => {
  const f = fixture(), native = checker(f); await native.synchronize(f.context);
  delete f.context.store.state.publications[resourceId].cms.native_metadata;
  const untouched = readOnly(f), result = await native.inspectAttention(checkContext(f));
  assert.equal(result.native_state, "baseline"); assert.equal(f.context.store.state.publications[resourceId].cms.native_metadata, undefined); untouched();
});

test("unknown create and an unknown receiver mutation never become ready from an empty lookup or a status read", async () => {
  const f = fixture(); f.context.store.state.publications[resourceId].create_outcome_uncertain = true;
  const untouched = readOnly(f), first = await checker(f).inspectAttention(checkContext(f));
  assert.equal(first.native_state, "unknown"); assert.equal(first.issue, "uncertain_mutation"); assert.equal(first.object_exists, false); untouched();
  const g = fixture(), native = checker(g); await native.synchronize(g.context);
  g.context.store.state.cms_journal = { pending: { completed: false, routeId: "V4-16", path: { work_id: workId }, body: { authority: { work_id: workId } } } };
  const unchanged = readOnly(g), second = await native.inspectAttention(checkContext(g));
  assert.equal(second.pending_mutation, "uncertain"); assert.equal(second.native_state, "unknown"); unchanged();
});

test("foreign native revision/body or lost previously-owned identity blocks Check without repair", async () => {
  for (const alter of [
    (f) => { f.object().html = f.object().html.replace("Original source", "Foreign edit"); },
    (f) => { f.object().updated_at = "2026-10-25T00:00:00.000Z"; },
    (f) => { f.ghost.findByResource = async () => []; f.ghost.get = async () => undefined; },
  ]) {
    const f = fixture(), native = checker(f); await native.synchronize(f.context); alter(f);
    const unchanged = readOnly(f), result = await native.inspectAttention(checkContext(f));
    assert.equal(result.native_state, "conflict"); assert.equal(result.issue, "native_conflict"); unchanged();
  }
});

test("missing selected metadata and open URL movement stay explicit and cause no automated retry", async () => {
  const f = fixture("post", "full", { selected: true, unavailable: true }), untouched = readOnly(f);
  const result = await checker(f).inspectAttention(checkContext(f));
  assert.equal(result.issue, "metadata_unavailable"); assert.notEqual(result.native_state, "never_applied"); untouched();
  const g = fixture(); g.context.store.state.publications[resourceId].cms.url_move_request = { state: "attention" };
  const unchanged = readOnly(g), moved = await checker(g).inspectAttention(checkContext(g));
  assert.equal(moved.issue, "url_move_open"); assert.equal(moved.native_state, "unknown"); unchanged();
});
