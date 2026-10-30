import { createHash } from "node:crypto";
import { Parser } from "./html-sanitizer.mjs";
import { ghostOwnedFragment } from "./native-owned-fragment.mjs";
import { assertNativeContentRepresentable, assertNativeConversionPreserved } from "./native-content-preservation.mjs";
export { ghostOwnedFragment } from "./native-owned-fragment.mjs";
import sanitizeHtml from "./html-sanitizer.mjs";
import { cmsSchema, validateCms } from "../lib/cms-runtime.mjs";
import { boundedResponse } from "./bounded-response.mjs";
import { browserLoaderUrl } from "./browser-assets.mjs";
import { PRODUCT_VERSION } from "./version.mjs";
import { ghostMoveDestination } from "./cms-move-request.mjs";
import { anchorCopiedArticleReferences } from "./article-references.mjs";
import { sourceActivityDate, activityDateMatches, assertSourceActivityRoute } from "./source-activity-date.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const check = (condition, detail) => { if (!condition) throw new Error(detail); };
const blocked = new Set(["template", "noscript", "textarea", "title", "xmp", "plaintext", "iframe", "svg", "math"]);

export function nativeOwnershipHash(receipt) {
  validateCms("NativeOwnershipReceipt", receipt);
  const buffers = [];
  for (const name of Object.keys(cmsSchema.types.NativeOwnershipReceipt.fields)) {
    const value = receipt[name], size = Buffer.alloc(4);
    if (value === null) { size.writeUInt32BE(0xffffffff); buffers.push(size); }
    else { const bytes = Buffer.from(String(value)); size.writeUInt32BE(bytes.length); buffers.push(size, bytes); }
  }
  return sha(Buffer.concat(buffers));
}

function expectedIdentity(mapping, work, nativeId, mode) {
  return { "data-discussionbridge-owned": "ghost-owned-fragment-v1", "data-discussionbridge-resource": mapping.resource_id, "data-discussionbridge-native-id": nativeId, "data-discussionbridge-source-revision": work.source_revision, "data-discussionbridge-mode": mode };
}

function nativeArticleHtml(html, topicUrl) {
  assertNativeContentRepresentable(html);
  // Anchor while every original target still exists. The unchanged HTTPS
  // sanitizer remains responsible for conversion, whose actual losses stop.
  const anchored = anchorCopiedArticleReferences(html, topicUrl);
  const converted = sanitizeHtml(anchored, { allowedTags: sanitizeHtml.defaults.allowedTags.concat(["h1", "img"]), allowedAttributes: { a: ["href", "title", "rel"], img: ["src", "alt", "title", "width", "height"], code: ["class"], pre: ["class"], span: ["class"], div: ["class"], ol: ["start", "reversed", "type"], li: ["value"], th: ["colspan", "rowspan", "headers", "scope", "abbr"], td: ["colspan", "rowspan", "headers"] }, allowedClasses: { span: ["math"], div: ["math"] }, allowedSchemes: ["https"], allowProtocolRelative: false });
  assertNativeConversionPreserved(anchored, converted);
  return converted;
}

function publicationHtml(config, connection, mapping, work, source, content, nativeId, mode, moveReceipt = null) {
  check(sha(content.bytes) === source.content_sha256 && content.bytes.length === source.content_bytes && Buffer.from(content.html).equals(content.bytes), "Ghost CMS complete immutable source differs before native preparation");
  const topic = new URL(source.topic_url);
  check(topic.origin === config.serverUrl && !topic.username && !topic.password && !topic.search && !topic.hash && new RegExp(`^/t/(?:[^/]+/)?${source.topic_id}/?$`, "u").test(topic.pathname), "Ghost CMS source link does not identify the source topic");
  const body = nativeArticleHtml(content.html, source.topic_url);
  const moveAttributes = moveReceipt?.move_id && moveReceipt.proof_nonce ? { "data-discussionbridge-move-id": moveReceipt.move_id, "data-discussionbridge-proof-nonce": moveReceipt.proof_nonce } : {};
  const attrs = Object.entries({ ...moveAttributes, ...expectedIdentity(mapping, work, nativeId, mode) }).map(([name, value]) => `${name}="${escape(value)}"`).join(" ");
  return `<section ${attrs}>${body}<hr><aside class="discussionbridge-publication"><p>Published from <a data-discussionbridge-source-link href="${escape(source.topic_url)}">${escape(connection.forum_name)}</a></p><p>Source authors: ${source.source_authors.map((author) => escape(author.name)).join(", ")}</p><p>Revision ${escape(source.source_revision)} · Ghost · DiscussionBridge for Ghost ${PRODUCT_VERSION}</p>${source.source_created_at ? `<p>Source created: <time datetime="${escape(source.source_created_at)}">${escape(source.source_created_at)}</time></p>` : ""}${source.source_updated_at ? `<p>Source updated: <time datetime="${escape(source.source_updated_at)}">${escape(source.source_updated_at)}</time></p>` : ""}</aside><div data-discussionbridge-comments="${mode}"></div><script data-discussionbridge-loader="${PRODUCT_VERSION}" src="${escape(browserLoaderUrl(config))}" defer></script></section>`;
}

async function nativeSelections(client, ghost, policy) {
  const result = {};
  for (const [kind, ids] of [["authors", policy.author_ids], ["taxonomy", policy.taxonomy_ids]]) {
    if (!ids.length) continue;
    const entries = new Map(); let cursor, revision, nativeRevision, total;
    for (;;) {
      const page = await client.catalog({ kind, ...(cursor ? { cursor } : {}) });
      validateCms("CatalogResponse", page);
      check(page.kind === kind && (revision === undefined || page.catalog_revision === revision && page.native_revision === nativeRevision && page.total_items === total), "Ghost central native catalog snapshot changed");
      revision = page.catalog_revision; nativeRevision = page.native_revision; total = page.total_items;
      for (const entry of page.items) { check(!entries.has(entry.id), "Ghost central catalog has duplicate identities"); entries.set(entry.id, entry); }
      if (page.next_cursor === null) break;
      check(page.next_cursor !== cursor && page.items.length && entries.size < total, "Ghost central catalog pagination did not advance"); cursor = page.next_cursor;
    }
    check(entries.size === total && ids.every((id) => entries.get(id)?.available === true), "Ghost selected central native metadata is unavailable");
    const actual = new Map((await ghost.catalog(kind)).map((item) => [item.id, item]));
    check(ids.every((id) => actual.has(id)), "Ghost selected native metadata no longer exists");
    result[kind] = ids.map((id) => kind === "authors" ? { id } : { id, name: actual.get(id).name, slug: actual.get(id).slug });
  }
  return result;
}

function ownedPost(post, item, mapping, type) {
  check(post && /^[a-f0-9]{24}$/u.test(post.id ?? "") && (post.type === undefined || post.type === type) && post.slug === new URL(mapping.canonical_url).pathname.split("/")[1] && Array.isArray(post.tags), "Ghost CMS native identity/type changed");
  if (item.ghost_post_id) check(post.id === item.ghost_post_id, "Ghost CMS native ID changed");
  check(post.tags.some((tag) => tag.name === `#discussionbridge-resource-${mapping.resource_id}` || tag.slug === `hash-discussionbridge-resource-${mapping.resource_id}`), "Ghost CMS native ownership marker is missing");
  check(!post.tags.some((tag) => (tag.name?.startsWith("#discussionbridge-resource-") && tag.name !== `#discussionbridge-resource-${mapping.resource_id}`) || (tag.slug?.startsWith("hash-discussionbridge-resource-") && tag.slug !== `hash-discussionbridge-resource-${mapping.resource_id}`)), "Ghost CMS native resource has conflicting ownership");
  if (post.status === "published") check(post.url === mapping.canonical_url, "Ghost CMS published native URL differs");
  return post;
}

function managedTag(tag, resource) {
  const names = ["source", "simple", "full", "interactive", `resource-${resource}`];
  return names.some((name) => tag.name === `#discussionbridge-${name}` || tag.slug === `hash-discussionbridge-${name}`);
}

const taxonomyApplied = (post, ids, resource) => JSON.stringify(post.tags.filter((tag) => !managedTag(tag, resource) || ids.includes(tag.id)).map((tag) => tag.id).sort()) === JSON.stringify([...ids].sort());
const nativeMetadata = (post) => ({ status: post.status, visibility: post.visibility ?? null, published_at: post.published_at ?? null, authors: (post.authors ?? []).map((entry) => entry.id), tags: (post.tags ?? []).map((entry) => ({ id: entry.id ?? null, name: entry.name ?? null, slug: entry.slug ?? null })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });

export function ghostCmsNative(ghost, { publicFetch = fetch, now = () => Date.now() } = {}) {
  const nativeWrite = async (operation) => {
    try { return await operation(); }
    catch (error) { if (error.status === undefined) error.cmsMutationUncertain = true; throw error; }
  };
  return {
    // Only called under the same native writer exclusion as synchronize().
    // This collector never calls apply/reconcile/renew or updates old evidence.
    async inspectAttention({ config, store, client, policy, mapping, work, source, assertOperation = async () => {}, now: observedNow = now }) {
      const state = await store.read(), item = state.publications[mapping.resource_id];
      const observation = { profile: "ghost-dynamic-1", observed_at: new Date(observedNow()).toISOString(), native_state: "unknown", object_exists: null, native_id: null, native_revision: null, ownership: null, native_result: null, verification: null, source_revision: null, managed_content_sha256: null, native_command: "none", pending_mutation: "none", prepared_transaction_id: null, journal_sha256: item?.cms ? sha(JSON.stringify(item.cms)) : null, baseline_sha256: null, candidate_sha256: null, current_sha256: null, restoration_operation_id: null, issue: "none" };
      const stop = (nativeState, issue) => ({ ...observation, native_state: nativeState, issue });
      await assertOperation();
      if (!item?.cms || item.cms.mapping_id !== mapping.mapping_id || item.cms.source_id !== work.source_id || item.cms.external_id !== mapping.external_id || item.canonical_url !== mapping.canonical_url || item.ghost_native_type !== (config.publicationType ?? "post")) return stop("conflict", "native_conflict");
      if (item.cms.url_move_request && !["committed", "aborted"].includes(item.cms.url_move_request.state)) return stop("unknown", "url_move_open");
      const pending = Object.values(state.cms_journal ?? {}).some((operation) => !operation.completed && (operation.path?.work_id === work.work_id || operation.body?.authority?.work_id === work.work_id));
      if (pending) { observation.pending_mutation = "uncertain"; return stop("unknown", "uncertain_mutation"); }
      try { await nativeSelections(client, ghost, policy); }
      catch { return stop("unavailable", "metadata_unavailable"); }
      const type = config.publicationType ?? "post", budget = Math.max(256 * 1024, (source?.content_bytes ?? item.native_content_bytes ?? 0) * 4 + 1024 * 1024);
      let matches, post;
      try {
        matches = await ghost.findByResource(mapping.resource_id, budget, type);
        if (!Array.isArray(matches) || matches.length > 1) return stop("conflict", "native_conflict");
        post = matches[0] ?? (item.ghost_post_id ? await ghost.get(item.ghost_post_id, budget, type) : null);
      } catch { return stop("unavailable", "collector_unavailable"); }
      observation.object_exists = Boolean(post);
      if (!post) {
        if (item.create_outcome_uncertain || item.cms.intent) { observation.pending_mutation = "uncertain"; return stop("unknown", "uncertain_mutation"); }
        if (item.ghost_post_id || item.cms.ownership_receipt || mapping.destination_native_id) return stop("conflict", "native_conflict");
        try {
          const collisions = await ghost.findBySlug(new URL(mapping.canonical_url).pathname.split("/")[1], budget, type);
          if (!Array.isArray(collisions) || collisions.length) return stop("conflict", "native_conflict");
          // Actual cross-post/page ownership and URL inventories, not a
          // fabricated candidate/old publication hash for an absent object.
          observation.current_sha256 = sha(JSON.stringify({ resource_id: mapping.resource_id, canonical_url: mapping.canonical_url, native_type: type, resource_matches: matches, slug_matches: collisions }));
        }
        catch { return stop("unavailable", "collector_unavailable"); }
        await assertOperation();
        return stop("never_applied", "none");
      }
      try { ownedPost(post, item, mapping, type); }
      catch { return stop("conflict", "native_conflict"); }
      observation.native_id = post.id; observation.native_revision = post.updated_at;
      observation.current_sha256 = sha(JSON.stringify({ html: post.html, title: post.title, native_revision: post.updated_at, native_id: post.id, url: post.url, metadata: nativeMetadata(post) }));
      // Unknown creation is not converted into a durable receipt by Check.
      if (!item.ghost_post_id || item.create_outcome_uncertain) { observation.pending_mutation = "uncertain"; return stop("unknown", "uncertain_mutation"); }
      const receipt = item.cms.ownership_receipt;
      try {
        check(receipt && nativeOwnershipHash(receipt) === item.cms.ownership_receipt_sha256 && receipt.native_id === post.id && receipt.mapping_id === mapping.mapping_id && receipt.resource_id === mapping.resource_id && receipt.source_id === work.source_id && receipt.external_id === mapping.external_id && receipt.canonical_url === mapping.canonical_url && receipt.connection_id === config.connectionId && receipt.forum_origin === config.serverUrl && receipt.last_lease_generation <= item.cms.last_lease_generation && (!mapping.destination_native_id || mapping.destination_native_id === post.id), "Ghost attention native receipt differs");
      } catch { return stop("conflict", "native_conflict"); }
      observation.ownership = { resource_id: receipt.resource_id, external_id: receipt.external_id, native_id: receipt.native_id, canonical_url: receipt.canonical_url, source_revision: receipt.source_revision, ownership_receipt_sha256: item.cms.ownership_receipt_sha256 };
      let fragment;
      try { fragment = ghostOwnedFragment(post.html); }
      catch { return stop("conflict", "native_conflict"); }
      observation.managed_content_sha256 = fragment.hash;
      const intent = item.cms.intent;
      // These three digests deliberately share the owned-fragment profile
      // domain. Full journal/native revisions separately fence metadata/CAS.
      observation.baseline_sha256 = item.cms.native_fragment_sha256 ?? item.cms.draft_fragment_sha256 ?? null;
      observation.candidate_sha256 = intent?.action === "withdraw" ? observation.baseline_sha256 : intent?.native_fragment_sha256 ?? null;
      const nativeSnapshot = observation.current_sha256;
      observation.current_sha256 = fragment.hash;
      const selectedMatch = (!policy.author_ids.length || JSON.stringify(post.authors?.map((entry) => entry.id)) === JSON.stringify(policy.author_ids)) && (!policy.taxonomy_ids.length || taxonomyApplied(post, policy.taxonomy_ids, mapping.resource_id));
      const candidate = intent?.native_id === post.id && intent.action === work.action && (
        work.action === "publish_revision" && source && intent.source_revision === work.source_revision && intent.native_fragment_sha256 === fragment.hash && intent.title === post.title && post.status === "published" && post.visibility === "public" && activityDateMatches(post.published_at, intent.published_at) && selectedMatch ||
        work.action === "withdraw" && post.status === "draft" && item.cms.native_fragment_sha256 === fragment.hash
      );
      const baselineHash = item.cms.native_fragment_sha256 ?? item.cms.draft_fragment_sha256;
      // r5 receipts already bind Ghost's actual updated_at revision/CAS plus
      // exact managed content/title. A new optional diagnostic snapshot must
      // not retrospectively invalidate that unchanged native revision proof.
      const metadataMatched = item.cms.native_metadata ? JSON.stringify(nativeMetadata(post)) === JSON.stringify(item.cms.native_metadata) : (item.source_status === "withdrawn" ? post.status === "draft" : receipt.source_revision === null ? post.status === "draft" : post.status === "published" && post.visibility === "public") && (!item.source_updated_at && !item.source_created_at || activityDateMatches(post.published_at, item.source_updated_at ?? item.source_created_at));
      const baseline = fragment.hash === baselineHash && post.updated_at === item.cms.native_revision && (!item.cms.native_title || post.title === item.cms.native_title) && metadataMatched;
      if (!candidate && !baseline) return stop("conflict", "native_conflict");
      if (intent && !candidate && post.updated_at !== intent.expected_native_revision) { observation.pending_mutation = "uncertain"; return stop("unknown", "uncertain_mutation"); }
      observation.pending_mutation = intent ? "settled" : "none";
      observation.source_revision = candidate && work.action === "publish_revision" ? work.source_revision : receipt.source_revision;
      const resultKind = post.status === "draft" ? "withdraw" : "publish_revision";
      const representation = candidate && source ? { kind: "full", source_content_sha256: source.content_sha256 } : item.cms.representation ?? item.cms.last_verified?.native_result?.representation;
      if (resultKind === "publish_revision" && !representation) return stop("unknown", "baseline_missing");
      observation.native_result = { kind: resultKind, native_id: post.id, external_id: mapping.external_id, canonical_url: mapping.canonical_url, native_revision: post.updated_at, ownership_receipt_sha256: item.cms.ownership_receipt_sha256, ...(resultKind === "publish_revision" ? { representation } : {}) };
      try {
        const mode = fragment.attributes["data-discussionbridge-mode"];
        check(["simple", "full", "interactive"].includes(mode), "Ghost attention retained presentation differs");
        observation.verification = await this.verify({ config, mapping: { ...mapping, presentation_mode: mode }, work: { ...work, action: resultKind, source_revision: observation.source_revision }, source: resultKind === "publish_revision" ? { content_sha256: representation.source_content_sha256 } : null, result: { nativeResult: observation.native_result, expectedHtml: post.html }, assertAuthority: assertOperation });
      } catch { return stop("unavailable", "public_proof_unavailable"); }
      try {
        const after = ownedPost(await ghost.get(post.id, budget, type), item, mapping, type);
        const digest = sha(JSON.stringify({ html: after.html, title: after.title, native_revision: after.updated_at, native_id: after.id, url: after.url, metadata: nativeMetadata(after) }));
        if (digest !== nativeSnapshot) return stop("conflict", "native_conflict");
      } catch { return stop("unavailable", "collector_unavailable"); }
      await assertOperation();
      return stop(candidate ? "candidate_applied" : "baseline", "none");
    },
    // A read-only probe of this actual renderer, used for a known local loss
    // before renewing its old lease. It grants no publication authority.
    async preflight({ config, mapping, content, source }) {
      nativeArticleHtml(content.html, source.topic_url); sourceActivityDate(source);
      const post = mapping.destination_native_id ? await ghost.get(mapping.destination_native_id, Math.max(256 * 1024, source.content_bytes * 4 + 1024 * 1024), config.publicationType ?? "post") : null;
      assertSourceActivityRoute(config, mapping, post);
    },
    async inspectMove({ config, store, mapping, work, authority, assertAuthority }) {
      const item = (await store.read()).publications[mapping.resource_id], receipt = item.cms.ownership_receipt;
      check(item.ghost_post_id && receipt && nativeOwnershipHash(receipt) === item.cms.ownership_receipt_sha256 && receipt.native_id === item.ghost_post_id && receipt.canonical_url === mapping.canonical_url && receipt.mapping_id === mapping.mapping_id && receipt.resource_id === mapping.resource_id && receipt.source_id === work.source_id && receipt.external_id === mapping.external_id && receipt.connection_id === config.connectionId && receipt.forum_origin === config.serverUrl && receipt.last_lease_generation <= authority.lease_generation, "Ghost move requires exact durable old native ownership");
      await assertAuthority();
      const type = config.publicationType ?? "post", budget = Math.max(256 * 1024, (item.native_content_bytes ?? 0) * 4 + 1024 * 1024);
      const matches = await ghost.findByResource(mapping.resource_id, budget, type);
      check(matches.length === 1, "Ghost move old native ownership lookup is ambiguous");
      const post = ownedPost(matches[0], item, mapping, type), fragment = ghostOwnedFragment(post.html, { "data-discussionbridge-owned": "ghost-owned-fragment-v1", "data-discussionbridge-resource": mapping.resource_id, "data-discussionbridge-native-id": item.ghost_post_id, "data-discussionbridge-source-revision": receipt.source_revision });
      check(post.status === "published" && post.visibility === "public" && post.updated_at === item.cms.native_revision && fragment.hash === item.cms.native_fragment_sha256 && post.title === item.cms.native_title, "Ghost move old native revision/content differs");
      const currentReceipt = { ...receipt, last_lease_generation: authority.lease_generation }, fingerprint = nativeOwnershipHash(currentReceipt);
      await assertAuthority();
      await store.update(async (state) => {
        const owned = state.publications[mapping.resource_id];
        check(owned.cms.work_id === work.work_id && owned.cms.last_lease_generation === authority.lease_generation && owned.cms.ownership_receipt_sha256 === item.cms.ownership_receipt_sha256, "Ghost move old receipt was fenced");
        owned.cms.ownership_receipt = currentReceipt; owned.cms.ownership_receipt_sha256 = fingerprint;
      });
      return { receipt: currentReceipt, receipt_sha256: fingerprint, native_revision: post.updated_at, native_fragment_sha256: fragment.hash, native_title: post.title };
    },

    async proveNoMove(context) {
      const request = (await context.store.read()).publications[context.mapping.resource_id].cms.url_move_request;
      if (request.native_outcome === "applied" || request.native_outcome === "unknown") return false;
      try {
        const actual = await this.inspectMove(context), old = request.old_native;
        return Boolean(old && actual.receipt_sha256 === old.receipt_sha256 && actual.native_revision === old.native_revision && actual.native_fragment_sha256 === old.native_fragment_sha256 && actual.native_title === old.native_title);
      } catch { return false; }
    },

    async move(context, move) {
      const { config, store, client, connection, policy, mapping, work, authority, source, content, assertAuthority, changed } = context;
      check(work.action === "publish_revision" && sha(content.bytes) === source.content_sha256 && content.bytes.length === source.content_bytes && Buffer.from(content.html).equals(content.bytes), "Ghost move complete desired source differs");
      const item = (await store.read()).publications[mapping.resource_id], request = item.cms.url_move_request, old = request.old_native, type = config.publicationType ?? "post";
      const publicationDate = sourceActivityDate(source);
      check(old && item.ghost_post_id === old.receipt.native_id && mapping.destination_native_id === item.ghost_post_id && move.old_url === request.old_url && move.new_url === request.new_url, "Ghost move native identity/reservation differs");
      const slug = ghostMoveDestination(move.new_url, config.ghostOrigin), target = { ...mapping, canonical_url: move.new_url };
      const base = publicationHtml(config, connection, target, work, source, content, item.ghost_post_id, policy.presentation_mode);
      const expected = base.replace("<section ", `<section data-discussionbridge-move-id="${escape(move.move_id)}" data-discussionbridge-proof-nonce="${escape(move.proof_nonce)}" `);
      const identity = { ...expectedIdentity(target, work, item.ghost_post_id, policy.presentation_mode), "data-discussionbridge-move-id": move.move_id, "data-discussionbridge-proof-nonce": move.proof_nonce };
      const expectedFragment = ghostOwnedFragment(expected, identity), selected = await nativeSelections(client, ghost, policy);
      if (request.native_intent) check(request.native_intent.source_revision === source.source_revision && request.native_intent.native_fragment_sha256 === expectedFragment.hash && request.native_intent.native_id === item.ghost_post_id, "Ghost move pending desired revision requires reconciliation");
      const budget = Math.max(256 * 1024, source.content_bytes * 4 + 1024 * 1024);
      await assertAuthority(); const collisions = await ghost.findBySlug(slug, budget, type);
      check(collisions.length === 0 || collisions.length === 1 && collisions[0].id === item.ghost_post_id && collisions[0].type === type, "Ghost proposed native URL slug collides with another post/page");
      await assertAuthority(); const matches = await ghost.findByResource(mapping.resource_id, budget, type);
      check(matches.length === 1, "Ghost move native lookup is ambiguous");
      let post = matches[0];
      check(post.id === item.ghost_post_id, "Ghost move native ID changed");
      let applied = post.url === move.new_url;
      assertSourceActivityRoute(config, applied ? target : mapping, post);
      if (applied) {
        ownedPost(post, item, target, type);
        check(request.native_intent && post.status === "published" && post.visibility === "public" && post.title === source.title && ghostOwnedFragment(post.html, identity).hash === expectedFragment.hash, "Ghost moved native content/nonce differs");
      } else {
        ownedPost(post, item, mapping, type);
        check(request.native_outcome !== "unknown", "Ghost unknown native movement is lookup-only");
        check(post.status === "published" && post.visibility === "public" && post.updated_at === old.native_revision && post.title === old.native_title && ghostOwnedFragment(post.html).hash === old.native_fragment_sha256, "Ghost move old native revision/content changed");
        const preserved = policy.taxonomy_ids.length ? selected.taxonomy : post.tags.filter((tag) => !managedTag(tag, mapping.resource_id));
        await store.update(async (state) => {
          const current = state.publications[mapping.resource_id];
          check(current.cms.work_id === work.work_id && current.cms.last_lease_generation === authority.lease_generation, "Ghost native move was fenced");
          current.cms.url_move_request.native_intent = { native_id: post.id, source_revision: source.source_revision, native_fragment_sha256: expectedFragment.hash, expected_native_revision: old.native_revision, generation: authority.lease_generation };
        });
        await assertAuthority();
        await store.update(async (state) => { state.publications[mapping.resource_id].cms.url_move_request.native_outcome = "unknown"; });
        changed();
        try {
          await nativeWrite(() => ghost.updateOwnedHtml(post.id, { title: source.title, slug, html: expected, status: "published", visibility: "public", tags: [...preserved, { name: "#discussionbridge-source" }, { name: `#discussionbridge-resource-${mapping.resource_id}` }, { name: `#discussionbridge-${policy.presentation_mode}` }], ...(selected.authors ? { authors: selected.authors } : {}), published_at: publicationDate, updated_at: old.native_revision }, type, post));
        } catch (error) {
          if (error.status >= 400 && error.status < 500 && error.status !== 408) await store.update(async (state) => { state.publications[mapping.resource_id].cms.url_move_request.native_outcome = "not_applied"; });
          throw error;
        }
        await assertAuthority(); post = ownedPost(await ghost.get(post.id, budget, type), item, target, type); applied = true;
      }
      const persisted = ghostOwnedFragment(post.html, identity);
      check(applied && post.status === "published" && post.visibility === "public" && post.title === source.title && persisted.hash === expectedFragment.hash && activityDateMatches(post.published_at, publicationDate), "Ghost moved desired publication was not persisted exactly");
      if (selected.authors) check(JSON.stringify(post.authors?.map((author) => author.id)) === JSON.stringify(policy.author_ids), "Ghost move selected authors differ");
      if (selected.taxonomy) check(taxonomyApplied(post, policy.taxonomy_ids, mapping.resource_id), "Ghost move selected taxonomy differs");
      const receipt = { ...old.receipt, canonical_url: move.new_url, source_revision: source.source_revision, last_lease_generation: authority.lease_generation, move_id: move.move_id, proof_nonce: move.proof_nonce }, fingerprint = nativeOwnershipHash(receipt);
      await assertAuthority();
      await store.update(async (state) => {
        const current = state.publications[mapping.resource_id];
        check(current.cms.work_id === work.work_id && current.cms.last_lease_generation === authority.lease_generation, "Ghost native move receipt was fenced");
        Object.assign(current.cms.url_move_request, { native_outcome: "applied", native_receipt: receipt, native_receipt_sha256: fingerprint, native_revision: post.updated_at, native_fragment_sha256: persisted.hash, native_title: post.title, native_content_bytes: Buffer.byteLength(post.html) });
      });
      return { outcome: "updated", expectedHtml: post.html, moveIdentity: identity, nativeResult: { kind: "publish_revision", native_id: post.id, external_id: mapping.external_id, canonical_url: move.new_url, native_revision: post.updated_at, ownership_receipt_sha256: fingerprint, representation: { kind: "full", source_content_sha256: source.content_sha256 } } };
    },

    async synchronize(context) {
      const { config, store, client, connection, policy, mapping, work, authority, source, content, assertAuthority, changed } = context;
      const type = config.publicationType ?? "post", resource = mapping.resource_id;
      let item = (await store.read()).publications[resource];
      check(item.ghost_native_type === type, "Ghost CMS selected native type changed; reconciliation required");
      if (item.cms.ownership_receipt) {
        const receipt = item.cms.ownership_receipt;
        check(nativeOwnershipHash(receipt) === item.cms.ownership_receipt_sha256 && receipt.mapping_id === mapping.mapping_id && receipt.resource_id === resource && receipt.source_id === work.source_id && receipt.external_id === mapping.external_id && receipt.canonical_url === mapping.canonical_url && receipt.native_id === item.ghost_post_id && receipt.forum_origin === config.serverUrl && receipt.connection_id === config.connectionId && receipt.last_lease_generation <= authority.lease_generation, "Ghost CMS durable native receipt changed");
      } else check(!item.ghost_post_id, "Ghost CMS native object lacks a durable ownership receipt");
      const budget = Math.max(256 * 1024, (source?.content_bytes ?? item.native_content_bytes ?? 0) * 4 + 1024 * 1024);
      await assertAuthority();
      const matches = await ghost.findByResource(resource, budget, type);
      check(Array.isArray(matches) && matches.length <= 1, "Ghost CMS native resource lookup is ambiguous");
      let post = matches.length ? ownedPost(matches[0], item, mapping, type) : null;
      if (!post && item.ghost_post_id) { await assertAuthority(); post = ownedPost(await ghost.get(item.ghost_post_id, budget, type), item, mapping, type); }
      if (item.create_outcome_uncertain) check(post, "Ghost CMS uncertain create is lookup-only until owned object is found");
      if (post && !item.ghost_post_id) check(item.create_outcome_uncertain && post.status === "draft" && ghostOwnedFragment(post.html).hash === item.cms.draft_fragment_sha256, "Ghost CMS unreceipted native object cannot be adopted");
      const hadNative = Boolean(post);

      const saveReceipt = async (current, revision) => {
        const receipt = { schema_version: "db-native-ownership-1", forum_origin: config.serverUrl, connection_id: config.connectionId, mapping_id: mapping.mapping_id, resource_id: resource, source_id: work.source_id, external_id: mapping.external_id, native_id: current.id, canonical_url: mapping.canonical_url, source_revision: revision, last_lease_generation: authority.lease_generation, move_id: item.cms.ownership_receipt?.move_id ?? null, proof_nonce: item.cms.ownership_receipt?.proof_nonce ?? null };
        const fingerprint = nativeOwnershipHash(receipt);
        await assertAuthority();
        await store.update(async (state) => {
          const owned = state.publications[resource];
          check(owned.cms.work_id === work.work_id && owned.cms.last_lease_generation === authority.lease_generation, "Ghost CMS native receipt writer was fenced");
          owned.ghost_post_id = current.id; owned.create_outcome_uncertain = false;
          owned.cms.ownership_receipt = receipt; owned.cms.ownership_receipt_sha256 = fingerprint;
          owned.cms.native_revision = current.updated_at; owned.native_content_bytes = Buffer.byteLength(current.html ?? "");
          owned.cms.native_metadata = nativeMetadata(current);
        });
        return fingerprint;
      };

      if (work.action === "withdraw") {
        check(post && item.cms.ownership_receipt, "Ghost CMS withdrawal has no exact owned native object");
        check(post.updated_at === item.cms.native_revision || item.cms.intent?.action === "withdraw" && post.status === "draft", "Ghost CMS native withdrawal version changed locally");
        await store.update(async (state) => { state.publications[resource].cms.intent = { action: "withdraw", native_id: post.id, expected_native_revision: post.updated_at, generation: authority.lease_generation }; });
        if (post.status !== "draft") { await assertAuthority(); changed(); await nativeWrite(() => ghost.update(post.id, { status: "draft", updated_at: post.updated_at }, type)); await assertAuthority(); post = ownedPost(await ghost.get(post.id, budget, type), item, mapping, type); }
        check(post.status === "draft", "Ghost CMS native withdrawal was not persisted");
        const fingerprint = await saveReceipt(post, item.cms.ownership_receipt.source_revision);
        await store.update(async (state) => { const owned = state.publications[resource]; owned.source_status = "withdrawn"; delete owned.cms.intent; });
        return { outcome: "updated", nativeResult: { kind: "withdraw", native_id: post.id, external_id: mapping.external_id, canonical_url: mapping.canonical_url, native_revision: post.updated_at, ownership_receipt_sha256: fingerprint }, expectedHtml: post.html };
      }

      check(sha(content.bytes) === source.content_sha256 && content.bytes.length === source.content_bytes && Buffer.from(content.html).equals(content.bytes), "Ghost CMS complete immutable source differs");
      nativeArticleHtml(content.html, source.topic_url);
      const publicationDate = sourceActivityDate(source);
      assertSourceActivityRoute(config, mapping, post);
      const selected = await nativeSelections(client, ghost, policy);
      if (!post) {
        const draft = publicationHtml(config, connection, mapping, work, source, content, "pending", policy.presentation_mode);
        await store.update(async (state) => { const owned = state.publications[resource]; check(!owned.ghost_post_id && !owned.create_outcome_uncertain, "Ghost CMS cannot repeat native create"); owned.create_outcome_uncertain = true; owned.cms.draft_fragment_sha256 = ghostOwnedFragment(draft).hash; });
        await assertAuthority(); changed();
        post = ownedPost(await nativeWrite(() => ghost.createOwnedHtml({ title: source.title, slug: new URL(mapping.canonical_url).pathname.split("/")[1], html: draft, status: "draft", visibility: "public", tags: [{ name: "#discussionbridge-source" }, { name: `#discussionbridge-resource-${resource}` }] }, type)), item, mapping, type);
        check(post.status === "draft", "Ghost CMS initial native identity was not an owned draft");
        await saveReceipt(post, null);
        item = (await store.read()).publications[resource];
        await assertAuthority(); post = ownedPost(await ghost.get(post.id, budget, type), item, mapping, type);
      } else if (!item.ghost_post_id) {
        await saveReceipt(post, null); item = (await store.read()).publications[resource];
      }

      const expected = publicationHtml(config, connection, mapping, work, source, content, post.id, policy.presentation_mode, item.cms.ownership_receipt);
      const expectedFragment = ghostOwnedFragment(expected, expectedIdentity(mapping, work, post.id, policy.presentation_mode));
      if (item.cms.native_fragment_sha256) {
        const prior = ghostOwnedFragment(post.html);
         const reconciled = item.cms.intent?.action === "publish_revision" && prior.hash === item.cms.intent.native_fragment_sha256 && post.title === item.cms.intent.title && activityDateMatches(post.published_at, item.cms.intent.published_at ?? publicationDate);
        check(prior.hash === item.cms.native_fragment_sha256 || reconciled, "Ghost CMS native managed body changed locally");
        check(post.updated_at === item.cms.native_revision || reconciled, "Ghost CMS native version requires reconciliation");
        check(post.title === item.cms.native_title || reconciled, "Ghost CMS native managed title changed locally");
      } else {
        const completedIntent = item.cms.intent?.action === "publish_revision" && item.cms.intent.native_id === post.id && item.cms.intent.source_revision === source.source_revision && item.cms.intent.native_fragment_sha256 === ghostOwnedFragment(post.html).hash && post.title === item.cms.intent.title && post.status === "published" && activityDateMatches(post.published_at, item.cms.intent.published_at ?? publicationDate);
        check(completedIntent || post.status === "draft" && ghostOwnedFragment(post.html).hash === item.cms.draft_fragment_sha256, "Ghost CMS initial native draft content changed");
      }
      const preserved = policy.taxonomy_ids.length ? selected.taxonomy : (post.tags ?? []).filter((tag) => !managedTag(tag, resource));
      const payload = { title: source.title, slug: post.slug, html: expected, status: "published", visibility: "public", tags: [...preserved, { name: "#discussionbridge-source" }, { name: `#discussionbridge-resource-${resource}` }, { name: `#discussionbridge-${policy.presentation_mode}` }], ...(selected.authors ? { authors: selected.authors } : {}), published_at: publicationDate };
      const authorsMatch = !selected.authors || JSON.stringify(post.authors?.map((author) => author.id)) === JSON.stringify(policy.author_ids);
      const taxonomyMatch = !selected.taxonomy || taxonomyApplied(post, policy.taxonomy_ids, resource);
      const alreadyCurrent = post.status === "published" && post.visibility === "public" && post.title === source.title && ghostOwnedFragment(post.html).hash === expectedFragment.hash && authorsMatch && taxonomyMatch && activityDateMatches(post.published_at, publicationDate);
      await store.update(async (state) => { state.publications[resource].cms.intent = { action: "publish_revision", native_id: post.id, source_revision: source.source_revision, expected_native_revision: post.updated_at, native_fragment_sha256: expectedFragment.hash, title: source.title, published_at: publicationDate, generation: authority.lease_generation }; });
      if (!alreadyCurrent) { await assertAuthority(); changed(); await nativeWrite(() => ghost.updateOwnedHtml(post.id, { ...payload, updated_at: post.updated_at }, type, post)); }
      await assertAuthority(); post = ownedPost(await ghost.get(post.id, budget, type), item, mapping, type);
      const persisted = ghostOwnedFragment(post.html, expectedIdentity(mapping, work, post.id, policy.presentation_mode));
      check(post.status === "published" && post.visibility === "public" && post.title === source.title && persisted.hash === expectedFragment.hash && activityDateMatches(post.published_at, publicationDate), "Ghost CMS native source/presentation was not persisted exactly");
      if (selected.authors) check(JSON.stringify(post.authors?.map((author) => author.id)) === JSON.stringify(policy.author_ids), "Ghost CMS selected authors were not applied exactly");
      if (selected.taxonomy) check(taxonomyApplied(post, policy.taxonomy_ids, resource), "Ghost CMS selected taxonomy was not applied exactly");
      const fingerprint = await saveReceipt(post, source.source_revision);
      await store.update(async (state) => { const owned = state.publications[resource]; owned.cms.native_fragment_sha256 = persisted.hash; owned.cms.native_title = post.title; owned.source_created_at = source.source_created_at; owned.source_updated_at = source.source_updated_at; owned.source_status = "active"; owned.revision = source.source_revision; owned.cms.representation = { kind: "full", source_content_sha256: source.content_sha256 }; delete owned.cms.intent; });
      return { outcome: alreadyCurrent ? "unchanged" : hadNative ? "updated" : "created", expectedHtml: post.html, synchronizedAt: new Date(now()).toISOString(), nativeResult: { kind: "publish_revision", native_id: post.id, external_id: mapping.external_id, canonical_url: mapping.canonical_url, native_revision: post.updated_at, ownership_receipt_sha256: fingerprint, representation: { kind: "full", source_content_sha256: source.content_sha256 } } };
    },

    async verify({ config, mapping, work, source, result, assertAuthority }) {
      try {
        await assertAuthority();
        const address = mapping.canonical_url;
        check(new URL(address).origin === config.ghostOrigin && address === result.nativeResult.canonical_url, "Ghost public native URL is outside configured ownership");
        const { response, bytes } = await boundedResponse(publicFetch, address, { method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", headers: { Accept: "text/html", "Accept-Encoding": "identity" } }, { origin: config.ghostOrigin, mediaType: "", maximumBytes: Math.max(1024 * 1024, Buffer.byteLength(result.expectedHtml ?? "") * 4 + 1024 * 1024), transportError: "Ghost native public verification is unavailable", originError: "Ghost native public origin differs", mediaError: "Ghost native public media differs", limitError: "Ghost native public response exceeds its transport budget" });
        check(!response.redirected && (!response.url || response.url === address), "Ghost native public verification redirected");
        await assertAuthority();
        const checkedAt = new Date(now()).toISOString();
        if (work.action === "withdraw") {
          check([404, 410].includes(response.status), "Ghost public withdrawal absence is not proven");
          return { kind: "absent", url: address, native_id: result.nativeResult.native_id, checked_at: checkedAt, http_status: response.status };
        }
        check(response.status === 200 && /^text\/html(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? ""), "Ghost public native publication is not readable HTML");
        const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const identity = result.moveIdentity ?? expectedIdentity(mapping, work, result.nativeResult.native_id, mapping.presentation_mode);
        const expected = ghostOwnedFragment(result.expectedHtml, identity), actual = ghostOwnedFragment(html, identity);
        check(actual.bytes.equals(expected.bytes), "Ghost public native fragment differs from expected rendered output");
        return { kind: "published", url: address, native_id: result.nativeResult.native_id, source_revision: work.source_revision, source_content_sha256: source.content_sha256, native_publication_sha256: actual.hash, verification_profile: "ghost-owned-fragment-v1", checked_at: checkedAt, representation: result.nativeResult.representation };
      } catch (error) { error.cmsCode = "public_verification_failed"; throw error; }
    },
  };
}
