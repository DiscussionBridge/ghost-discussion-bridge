import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state-store.mjs";
import { serializedState, validState } from "../src/state-file.mjs";

const state = () => ({ version: 1, posts: {}, presentations: {}, publications: {} });

test("one durable authority preserves pending CAS, identities and receipt history across a restarted reader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ghost-v4-state-"));
  try {
    const path = join(directory, "state.json"), store = new StateStore(path);
    const current = state();
    current.posts["ghost-post:0123456789abcdef01234567"] = {
      resource_id: "11111111-1111-4111-8111-111111111111", topic_id: "9223372036854775807",
      cms_source: { accepted_revision: "opaque-accepted", accepted_history: [{ source_revision: "prior", receipt: { immutable: true } }], intent: { body: { mutation_id: "22222222-2222-4222-8222-222222222222", bridge_record: { source_revision: "opaque-pending", expected_source_revision: "opaque-accepted" } }, request_state: "uncertain" } },
    };
    current.publications["11111111-1111-4111-8111-111111111111"] = { ghost_native_type: "post", ghost_post_id: "abcdef0123456789abcdef01", canonical_url: "https://ghost.example/owned/", cms: { last_lease_generation: 7, ownership_receipt: { native_id: "abcdef0123456789abcdef01", proof_nonce: "retained-proof" }, url_history: [{ url: "https://ghost.example/prior/", move_id: "retained-move" }] } };
    await store.withNativeLock(async (assertWriter) => { await assertWriter(); await store.write(current); });
    const recovered = await new StateStore(path).read();
    assert.deepEqual(recovered, current);
    await new StateStore(path).update(async (next) => { next.posts["ghost-post:0123456789abcdef01234567"].outcome = "attention"; });
    const after = await new StateStore(path).read();
    assert.deepEqual(after.posts["ghost-post:0123456789abcdef01234567"].cms_source, current.posts["ghost-post:0123456789abcdef01234567"].cms_source);
    assert.deepEqual(after.publications, current.publications);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("new baseline state requires the two authority maps and refuses competing publication state", () => {
  assert.deepEqual(validState(state()), state());
  const missing = state(); delete missing.publications; assert.throws(() => serializedState(missing));
  const competing = state(); competing.forum_publications = {}; assert.throws(() => validState(competing));
  const malformed = state(); malformed.publications.one = { ghost_native_type: "other" }; assert.throws(() => validState(malformed));
});
