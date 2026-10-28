import assert from "node:assert/strict";
import test from "node:test";
import { sourceActivityDate, activityDateMatches } from "../src/source-activity-date.mjs";
import { ghostCmsNative } from "../src/cms-native-publication.mjs";
import { fixture, nativeId, resourceId } from "./fixtures/cms-native-fixture.mjs";

test("native date projection floors full source precision to whole UTC seconds, including dates before the epoch", () => {
  for (const [input, expected] of [
    ["2026-10-26T17:56:59.000Z", "2026-10-26T17:56:59.000Z"],
    ["2026-10-26T17:56:59.462Z", "2026-10-26T17:56:59.000Z"],
    ["2026-10-26T17:56:59.999999999Z", "2026-10-26T17:56:59.000Z"],
    ["2026-10-26T19:56:59.462000001+02:00", "2026-10-26T17:56:59.000Z"],
    ["1969-12-31T23:59:59.999999999Z", "1969-12-31T23:59:59.000Z"],
    ["1969-12-31T23:59:58.462Z", "1969-12-31T23:59:58.000Z"],
  ]) {
    const source = { source_created_at: null, source_updated_at: input }, before = structuredClone(source);
    assert.equal(sourceActivityDate(source), expected, input); assert.deepEqual(source, before);
  }
});

test("native date comparison projects only the expectation and rejects actual fractions, wrong seconds and invalid calendars", () => {
  const original = "2026-10-26T17:56:59.462Z";
  assert.equal(activityDateMatches("2026-10-26T17:56:59.000Z", original), true);
  assert.equal(activityDateMatches("1969-12-31T23:59:59.000Z", "1969-12-31T23:59:59.999999999Z"), true);
  for (const actual of ["2026-10-26T17:56:59.462Z", "2026-10-26T17:56:59.000000001Z", "2026-10-26T17:56:58.000Z", "2026-10-26T17:57:00.000Z", "2026-02-30T17:56:59.000Z", "invalid", null]) assert.equal(activityDateMatches(actual, original), false, String(actual));
  assert.equal(activityDateMatches("2026-10-26T17:56:59.000Z", "invalid"), false);
});

test("projection preserves full-precision chronology and unknown-activity guards", () => {
  for (const source of [
    { source_created_at: "2026-10-26T17:56:59.462000002Z", source_updated_at: "2026-10-26T17:56:59.462000001Z" },
    { source_created_at: "2026-10-26T17:56:59.000Z", source_updated_at: null },
    { source_created_at: null, source_updated_at: "2026-02-30T17:56:59.000Z" },
  ]) {
    const before = structuredClone(source);
    assert.throws(() => sourceActivityDate(source), (error) => error.localNativeLimitation === true);
    assert.deepEqual(source, before);
  }
});

// Model the observed native DATETIME_PRECISION=0 storage at the native API
// boundary, rather than letting the in-memory seam retain impossible fractions.
function wholeSecondNative(f, { substitute = null } = {}) {
  const update = f.ghost.update, requests = [];
  f.ghost.update = async (id, payload, type) => {
    requests.push(structuredClone(payload));
    const native = Object.hasOwn(payload, "published_at") ? { ...payload, published_at: substitute ?? new Date(Math.floor(Date.parse(payload.published_at) / 1000) * 1000).toISOString() } : payload;
    return update(id, native, type);
  };
  return requests;
}

for (const type of ["post", "page"]) for (const input of ["2026-10-26T17:56:59.000Z", "2026-10-26T17:56:59.462Z", "2026-10-26T17:56:59.462000001Z"]) test(`${type} native whole-second storage accepts ${input} without altering source truth or repeating writes`, async () => {
  const f = fixture(type); f.context.source.source_updated_at = input;
  const source = structuredClone(f.context.source), bytes = Buffer.from(f.context.content.bytes), originalHtml = f.context.content.html, requests = wholeSecondNative(f), native = ghostCmsNative(f.ghost);
  const first = await native.synchronize(f.context), saved = structuredClone(f.context.store.state.publications[resourceId]), object = structuredClone(f.object());
  assert.equal(first.nativeResult.native_id, nativeId); assert.equal(object.published_at, "2026-10-26T17:56:59.000Z");
  assert.equal(requests[0].published_at, object.published_at);
  assert.ok(object.html.includes(`datetime="${input}"`)); assert.ok(object.html.includes(`datetime="${source.source_created_at}"`));
  assert.equal(saved.source_updated_at, input); assert.equal(saved.source_created_at, source.source_created_at);
  assert.equal(saved.cms.representation.source_content_sha256, source.content_sha256);
  assert.deepEqual(f.context.source, source); assert.deepEqual(f.context.content.bytes, bytes); assert.equal(f.context.content.html, originalHtml);
  assert.equal((await native.synchronize(f.context)).outcome, "unchanged"); assert.deepEqual(f.counts(), { creates: 1, updates: 1, catalogReads: 0 });
  assert.deepEqual(f.object(), object); assert.deepEqual(f.context.store.state.publications[resourceId].cms.ownership_receipt, saved.cms.ownership_receipt);
});

for (const type of ["post", "page"]) test(`${type} native wrong second or fractional readback is rejected with its original intent retained`, async () => {
  for (const actual of ["2026-10-26T17:56:58.000Z", "2026-10-26T17:57:00.000Z", "2026-10-26T17:56:59.462Z", "2026-10-26T17:56:59.000000001Z"]) {
    const f = fixture(type); f.context.source.source_updated_at = "2026-10-26T17:56:59.462Z";
    const original = structuredClone(f.context.source); wholeSecondNative(f, { substitute: actual });
    await assert.rejects(ghostCmsNative(f.ghost).synchronize(f.context), /not persisted exactly/u);
    const item = f.context.store.state.publications[resourceId];
    assert.equal(item.cms.intent.published_at, "2026-10-26T17:56:59.000Z"); assert.equal(item.cms.ownership_receipt.source_revision, null);
    assert.equal(f.object().published_at, actual); assert.equal(f.counts().creates, 1); assert.equal(f.counts().updates, 1); assert.deepEqual(f.context.source, original);
  }
});
