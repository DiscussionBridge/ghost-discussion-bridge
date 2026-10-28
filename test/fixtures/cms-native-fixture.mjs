// Pure in-memory native API seam; never starts a native runtime or socket.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { newCmsReservation } from "../../src/cms-coordinator.mjs";
import { ghostOwnedFragment } from "../../src/native-owned-fragment.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const nativeId = "a".repeat(24), authorId = "1".repeat(24), tagId = "2".repeat(24);
const resourceId = "11111111-1111-4111-8111-111111111111", mappingId = "22222222-2222-4222-8222-222222222222", workId = "33333333-3333-4333-8333-333333333333";
function fixture(type = "post", mode = "full", { selected = false, unavailable = false, lostCreate = false, lostUpdate = false } = {}) {
  const config = { serverUrl: "https://forum.example", ghostOrigin: "https://ghost.example", adapterOrigin: "https://adapter.example", connectionId: `dbc_${"a".repeat(24)}`, publicationType: type, sourceNativeIntegration: { permalink: "/{slug}/" } };
  const source = { source_id: "source-42", source_revision: "revision-1", topic_id: "42", topic_url: "https://forum.example/t/source/42", title: "Source title", content_sha256: sha("<p>Original source</p>"), content_bytes: Buffer.byteLength("<p>Original source</p>"), source_created_at: "2026-01-01T00:00:00.000Z", source_updated_at: "2026-10-14T00:00:00.000Z", source_authors: [{ id: "source-writer", name: "Source writer" }] };
  const mapping = { mapping_id: mappingId, resource_id: resourceId, source_id: source.source_id, ...newCmsReservation(source.source_id, config), presentation_mode: mode };
  const policy = { author_ids: selected ? [authorId] : [], taxonomy_ids: selected ? [tagId] : [], presentation_mode: mode };
  const work = { work_id: workId, source_id: source.source_id, source_revision: source.source_revision, action: "publish_revision" };
  const store = { state: { version: 1, posts: {}, presentations: {}, publications: { [resourceId]: { canonical_url: mapping.canonical_url, ghost_native_type: type, cms: { mapping_id: mappingId, source_id: source.source_id, external_id: mapping.external_id, work_id: workId, last_lease_generation: 2, ownership_receipt: null } } } }, async read() { return structuredClone(this.state); }, async update(callback) { const next = structuredClone(this.state); await callback(next); this.state = next; } };
  let object, creates = 0, updates = 0, version = 0, catalogReads = 0, loseCreate = lostCreate, loseUpdate = lostUpdate, fenced = false;
  const ghost = {
    // Native-method test seam only; real card serialization is exercised
    // separately through GhostAdminClient and by the native runtime fixture.
    async createOwnedHtml(...args) { return ghost.create(...args); },
    async updateOwnedHtml(id, payload, expectedType, current) {
      assert.equal(current.id, id); assert.equal(current.updated_at, payload.updated_at);
      const prior = ghostOwnedFragment(current.html);
      return ghost.update(id, { ...payload, html: current.html.slice(0, prior.start) + payload.html + current.html.slice(prior.end) }, expectedType);
    },
    async findBySlug(slug) { return object?.slug === slug ? [structuredClone(object)] : []; },
    async findByResource(_id, _budget, expectedType) { assert.equal(expectedType, type); return object ? [structuredClone(object)] : []; },
    async create(payload, expectedType) {
      assert.equal(expectedType, type); creates++;
      assert.equal(store.state.publications[resourceId].create_outcome_uncertain, true);
      assert.equal(payload.status, "draft");
      object = { ...structuredClone(payload), type, id: nativeId, url: mapping.canonical_url, authors: [{ id: "9".repeat(24) }], updated_at: new Date(++version * 1000).toISOString() };
      if (loseCreate) { loseCreate = false; throw new Error("Synthetic lost create response"); }
      return structuredClone(object);
    },
    async get(id, _budget, expectedType) { assert.equal(id, nativeId); assert.equal(expectedType, type); return structuredClone(object); },
    async update(id, payload, expectedType) {
      assert.equal(id, nativeId); assert.equal(expectedType, type);
      assert.equal(store.state.publications[resourceId].cms.intent?.native_id ?? store.state.publications[resourceId].cms.url_move_request?.native_intent?.native_id, nativeId);
      assert.equal(payload.updated_at, object.updated_at);
      updates++; Object.assign(object, structuredClone(payload), { updated_at: new Date(++version * 1000).toISOString(), url: `${config.ghostOrigin}/${payload.slug}/` });
      if (loseUpdate) { loseUpdate = false; throw new Error("Synthetic lost update response"); }
      return structuredClone(object);
    },
    async catalog(kind) { catalogReads++; return kind === "authors" ? [{ id: authorId, name: "Native writer" }] : [{ id: tagId, name: "Native tag", slug: "native-tag" }]; },
  };
  const client = { async catalog({ kind }) { catalogReads++; return { kind, catalog_revision: "catalog-1", native_revision: "native-catalog-1", total_items: 1, items: [{ id: kind === "authors" ? authorId : tagId, label: "Central label", available: !unavailable }], next_cursor: null }; } };
  const context = { config, store, client, connection: { forum_name: "Forum & Name" }, policy, mapping, work, authority: { lease_generation: 2 }, source, content: { bytes: Buffer.from("<p>Original source</p>"), html: "<p>Original source</p>" }, async assertAuthority() { assert.equal(fenced, false, "Synthetic native lock lost"); assert.equal(store.state.publications[resourceId].cms.last_lease_generation, context.authority.lease_generation); }, changed() {} };
  return { context, ghost, object: () => object, counts: () => ({ creates, updates, catalogReads }), fence: () => { fenced = true; } };
}


export { fixture, sha, nativeId, authorId, tagId, resourceId, mappingId, workId };
