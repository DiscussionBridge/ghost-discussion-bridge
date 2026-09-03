import { PRODUCT_VERSION } from "./version.mjs";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function bounded(value, maximum, label) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum) throw new Error(`Invalid ${label}`);
  return value.trim();
}

function safeUrl(value, origin, label) {
  const parsed = new URL(bounded(value, 2048, label));
  if (parsed.origin !== origin || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`Invalid ${label}`);
  return parsed;
}

function escape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function nativePublication(record, config) {
  if (!record || typeof record !== "object") throw new Error("Invalid publication record");
  const bindings = Array.isArray(record.bindings) ? record.bindings.filter((item) => item?.role === "presentation" && item?.state === "active") : [];
  if (!bindings.some((item) => item.native_materialization === true)) return null;
  if (bindings.length !== 1 || bindings[0].native_materialization !== true) throw new Error("Ambiguous native publication authority");
  if (!record || record.direction !== "from_discourse" || record.state !== "healthy" || !UUID.test(record.resource_id ?? "")) throw new Error("Invalid publication record");
  if (!Number.isSafeInteger(record.topic_id) || record.topic_id <= 0 || typeof record.content_html !== "string" || !record.content_html.trim() || Buffer.byteLength(record.content_html) > 128 * 1024) throw new Error("Invalid publication content");
  const destination = safeUrl(bindings[0].canonical_url, config.ghostOrigin, "publication destination");
  const segments = destination.pathname.split("/").filter(Boolean);
  if (segments.length !== 1 || destination.pathname !== `/${segments[0]}/` || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(segments[0])) throw new Error("Invalid publication slug");
  const source = record.source;
  if (!source || source.platform !== "discourse" || source.origin !== config.serverUrl || source.topic_id !== record.topic_id || source.post_number !== 1 || !Number.isSafeInteger(source.post_id) || source.post_id <= 0 || !Number.isSafeInteger(source.post_version) || source.post_version <= 0 || source.revision !== `post:${source.post_id}:version:${source.post_version}`) throw new Error("Invalid publication source");
  const topicUrl = safeUrl(source.topic_url, config.serverUrl, "source topic URL").href;
  const authorName = bounded(source.author?.name, 200, "source author");
  safeUrl(source.author?.profile_url, config.serverUrl, "source author URL");
  const title = bounded(record.title, 1024, "publication title");
  const provenance = `<hr><aside class="discussionbridge-publication" data-discussionbridge-resource="${escape(record.resource_id)}" data-discussionbridge-revision="${escape(source.revision)}"><p><strong>Published from <a href="${escape(topicUrl)}">The Bridge</a></strong></p><p>Source author: ${escape(authorName)} · Revision ${escape(source.revision)} · Ghost 6.59.0 · DiscussionBridge for Ghost ${PRODUCT_VERSION}</p></aside><div data-discussionbridge-comments="fullInteractive"></div><script src="/discussionbridge/assets/loader.js?v=${PRODUCT_VERSION}" defer></script>`;
  const revisionDigest = createHash("sha256").update(source.revision).digest("hex");
  return { resourceId: record.resource_id, resourceTag: `#discussionbridge-resource-${record.resource_id.toLowerCase()}`, resourceTagSlug: `hash-discussionbridge-resource-${record.resource_id.toLowerCase()}`, revision: source.revision, revisionTag: `#discussionbridge-revision-${revisionDigest}`, revisionTagSlug: `hash-discussionbridge-revision-${revisionDigest}`, topicId: record.topic_id, topicUrl, destination: destination.href, slug: segments[0], title, html: `${record.content_html}${provenance}` };
}

function exactGhostPost(post, publication) {
  if (!post || !/^[a-f0-9]{24}$/iu.test(post.id ?? "") || post.slug !== publication.slug || post.url !== publication.destination) throw new Error("Ghost publication identity drift");
  return post;
}

function carriesRevision(post, publication) {
  const tags = Array.isArray(post?.tags) ? post.tags : [];
  return tags.some((tag) => tag?.name === publication.revisionTag || tag?.slug === publication.revisionTagSlug);
}

async function markedPost(ghost, publication) {
  const matches = await ghost.findByResource(publication.resourceId);
  if (!Array.isArray(matches) || matches.length > 1) throw new Error("Ambiguous Ghost publication resource marker");
  if (matches.length === 0) return null;
  const post = exactGhostPost(matches[0], publication);
  const tags = Array.isArray(post.tags) ? post.tags : [];
  if (!tags.some((tag) => tag?.name === publication.resourceTag || tag?.slug === publication.resourceTagSlug)) throw new Error("Ghost publication resource marker drift");
  return post;
}

export async function syncPublications(config, store, bridge, ghost, { pendingLeaseMs = 15_000 } = {}) {
  const summary = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, errors: [] };
  const candidates = [];
  let page = 1;
  let snapshot; let expectedPages; let expectedTotal;
  const seenResources = new Set();
  for (;;) {
    const response = await bridge.records(page, snapshot);
    if (!Array.isArray(response?.bridge_records) || !Number.isSafeInteger(response?.pagination?.pages) || response.pagination.pages < 1 || response.pagination.pages > 10_000 || response.pagination.page !== page || !Number.isSafeInteger(response.pagination.total) || response.pagination.total < 0 || typeof response.pagination.snapshot !== "string" || !response.pagination.snapshot || response.pagination.snapshot.length > 8_192) throw new Error("Invalid publication feed");
    if (page === 1) {
      snapshot = response.pagination.snapshot; expectedPages = response.pagination.pages; expectedTotal = response.pagination.total;
    } else if (response.pagination.snapshot !== snapshot || response.pagination.pages !== expectedPages || response.pagination.total !== expectedTotal) {
      throw new Error("Publication feed changed during synchronization");
    }
    for (const record of response.bridge_records) {
      const id = typeof record?.resource_id === "string" ? record.resource_id.toLowerCase() : "";
      if (!UUID.test(id) || seenResources.has(id)) throw new Error("Publication feed contains a duplicate or invalid resource identity");
      seenResources.add(id);
    }
    candidates.push(...response.bridge_records);
    if (page >= response.pagination.pages) break;
    page += 1;
  }
  if (seenResources.size !== expectedTotal) throw new Error("Publication feed did not produce its complete unique census");
  for (const record of candidates) {
      let publication;
      try { publication = nativePublication(record, config); } catch (error) { summary.failed += 1; summary.errors.push({ resource_id: UUID.test(record?.resource_id ?? "") ? record.resource_id : null, reason: error.message }); continue; }
      if (!publication) { summary.skipped += 1; continue; }
      const operationId = randomUUID();
      let claim;
      for (;;) {
        await store.update(async (state) => {
          const prior = state.publications[publication.resourceId];
          if (prior?.state !== "pending" && prior?.revision === publication.revision && prior?.canonical_url === publication.destination && prior?.adapter_version === PRODUCT_VERSION) { claim = { kind: "unchanged" }; return; }
          const now = Date.now();
          if (prior?.state === "pending" && Number.isFinite(prior.pending_until) && prior.pending_until > now && prior.operation_id !== operationId) { claim = { kind: "wait", milliseconds: prior.pending_until - now }; return; }
          claim = { kind: prior?.state === "pending" ? "recover" : (prior?.ghost_post_id ? "update" : "create"), prior };
          state.publications[publication.resourceId] = { ...prior, state: "pending", operation_id: operationId, pending_until: now + pendingLeaseMs, canonical_url: publication.destination, revision: publication.revision, adapter_version: PRODUCT_VERSION, topic_id: publication.topicId, topic_url: publication.topicUrl, resource_tag: publication.resourceTag };
        });
        if (claim.kind !== "wait") break;
        await delay(Math.min(claim.milliseconds + 5, pendingLeaseMs + 5));
      }
      if (claim.kind === "unchanged") { summary.unchanged += 1; continue; }
      try {
        let result = await markedPost(ghost, publication);
        if (!result && claim.prior?.ghost_post_id) result = exactGhostPost(await ghost.get(claim.prior.ghost_post_id), publication);
        if (!result && claim.kind === "recover") throw new Error("Ghost publication create outcome requires reconciliation");
        const payload = { title: publication.title, slug: publication.slug, html: publication.html, status: "published", tags: [{ name: "#discussionbridge-source" }, { name: publication.resourceTag }, { name: publication.revisionTag }] };
        const existing = Boolean(result);
        if (result && !carriesRevision(result, publication)) {
          if (typeof result.updated_at !== "string") throw new Error("Ghost publication identity drift");
          let updateError;
          try { await ghost.update(result.id, { ...payload, updated_at: result.updated_at }); }
          catch (error) { updateError = error; }
          result = await markedPost(ghost, publication);
          if (!result || !carriesRevision(result, publication)) {
            if (updateError) throw updateError;
            throw new Error("Ghost publication revision marker was not persisted");
          }
        } else if (!result) {
          let createError;
          try { await ghost.create(payload); }
          catch (error) { createError = error; }
          result = await markedPost(ghost, publication);
          if (!result || !carriesRevision(result, publication)) {
            if (createError) throw createError;
            throw new Error("Ghost publication marker was not persisted");
          }
        }
        result = exactGhostPost(result, publication);
        await store.update(async (state) => {
          const pending = state.publications[publication.resourceId];
          if (pending?.state !== "pending" || pending.operation_id !== operationId || pending.revision !== publication.revision || pending.canonical_url !== publication.destination) throw new Error("Ghost publication intent ownership changed");
          state.publications[publication.resourceId] = { ghost_post_id: result.id, canonical_url: publication.destination, revision: publication.revision, adapter_version: PRODUCT_VERSION, topic_id: publication.topicId, topic_url: publication.topicUrl, resource_tag: publication.resourceTag, state: "complete", synchronized_at: new Date().toISOString() };
        });
        summary[existing || claim.prior?.ghost_post_id ? "updated" : "created"] += 1;
      } catch (error) { summary.failed += 1; summary.errors.push({ resource_id: publication.resourceId, reason: error.message }); }
  }
  return summary;
}
