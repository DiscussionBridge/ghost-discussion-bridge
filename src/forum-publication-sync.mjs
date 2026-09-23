import { createHash } from "node:crypto";
import sanitizeHtml from "sanitize-html";
import { PRODUCT_VERSION } from "./version.mjs";
import { buildPlatformCatalog } from "./platform-catalog.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GHOST_ID = /^[a-f0-9]{24}$/iu;
const REVISION = /^[a-f0-9]{64}$/u;
const MAX_CURSOR_BYTES = 8_192;

function bounded(value, maximum, label) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value.trim();
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameSourceSummary(summary, detail) {
  const keys = [
    "topic_id", "topic_url", "title", "source_revision", "content_bytes", "source_created_at", "source_updated_at",
    "category", "tags", "author", "publication", "publication_revision", "destination",
  ];
  return keys.every((key) => same(summary?.[key] ?? null, detail?.[key] ?? null));
}

function safeUrl(value, origin, label) {
  const parsed = new URL(bounded(value, 2048, label));
  if (parsed.origin !== origin || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`Invalid ${label}`);
  }
  return parsed.href;
}

function tagName(value) {
  return typeof value?.name === "string" ? value.name : "";
}

function hasTag(post, name) {
  return Array.isArray(post?.tags) && post.tags.some((tag) => tagName(tag) === name || tag?.slug === name.replace(/^#/, "hash-"));
}

function contentType(destination) {
  if (destination?.destination_container_id === "post") return "post";
  if (destination?.destination_container_id === "page") return "page";
  throw new Error("Unsupported Ghost destination container");
}

function mappedTags(destination) {
  const values = [];
  for (const item of Array.isArray(destination?.destination_terms) ? destination.destination_terms : []) {
    if (item?.destination_taxonomy_id !== "tag" || typeof item.destination_term_id !== "string") {
      throw new Error("Invalid Ghost destination term");
    }
    const match = /^tag:([a-f0-9]{24})$/iu.exec(item.destination_term_id);
    if (!match) throw new Error("Invalid Ghost destination tag");
    values.push({ id: match[1].toLowerCase() });
  }
  return values;
}

function slugFor(destination, title, topicId) {
  if (destination?.slug_policy === "topic_id") return `forum-topic-${topicId}`;
  if (destination?.slug_policy === "source_title") {
    const slug = title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 180);
    return slug || `forum-topic-${topicId}`;
  }
  return undefined;
}

function sanitizeSource(value) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 49_152) throw new Error("Invalid source content");
  const html = sanitizeHtml(value, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
    allowedAttributes: {
      a: ["href", "title", "rel"], img: ["src", "alt", "title", "width", "height"],
      code: ["class"], pre: ["class"], span: ["class"], div: ["class"],
    },
    allowedSchemes: ["https"],
    allowProtocolRelative: false,
  });
  if (!html.trim()) throw new Error("Source content is empty after sanitization");
  return html;
}

function escape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function publicationPlan(item, detail, config) {
  if (!item || !detail || !sameSourceSummary(item, detail)) throw new Error("Source topic changed during synchronization");
  const topicId = item.topic_id;
  if (!Number.isSafeInteger(topicId) || topicId <= 0) throw new Error("Invalid source topic identity");
  const sourceRevision = bounded(item.source_revision, 255, "source revision");
  const publicationRevision = bounded(item.publication_revision, 64, "publication revision");
  if (!REVISION.test(publicationRevision)) throw new Error("Invalid publication revision");
  const destination = item.destination;
  if (!destination || destination.state !== "ready" || !REVISION.test(destination.mapping_revision ?? "")) {
    throw new Error("Source topic destination is not ready");
  }
  const title = bounded(item.title, 255, "source title");
  const topicUrl = safeUrl(item.topic_url, config.serverUrl, "source topic URL");
  const author = bounded(item.author?.name, 200, "source author");
  const createdAt = bounded(item.source_created_at, 64, "source creation time");
  const updatedAt = bounded(item.source_updated_at, 64, "source update time");
  for (const [label, value] of [["creation", createdAt], ["update", updatedAt]]) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new Error(`Invalid source ${label} time`);
    }
  }
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error("Source update precedes creation");
  const html = sanitizeSource(detail.content_html);
  const type = contentType(destination);
  const topicTag = `#discussionbridge-topic-${topicId}`;
  const revisionTag = `#discussionbridge-revision-${publicationRevision}`;
  const provenance = `<hr><aside class="discussionbridge-publication" data-discussionbridge-topic="${topicId}" data-discussionbridge-revision="${publicationRevision}"><p><strong>Published from <a href="${escape(topicUrl)}">The Bridge</a></strong></p><p>Source author: ${escape(author)} · DiscussionBridge for Ghost ${PRODUCT_VERSION}</p></aside><div data-discussionbridge-comments="interactive"></div><script src="/discussionbridge/assets/loader.js?v=${PRODUCT_VERSION}" defer></script>`;
  return {
    topicId, sourceRevision, publicationRevision, destination, mappingRevision: destination.mapping_revision,
    title, topicUrl, html: `${html}${provenance}`, type, topicTag, revisionTag,
    slug: slugFor(destination, title, topicId), mappedTags: mappedTags(destination),
    publication: item.publication && typeof item.publication === "object" ? item.publication : {},
    createdAt, updatedAt,
  };
}

function exactNative(post, plan, config) {
  if (!post || !GHOST_ID.test(post.id ?? "")) throw new Error("Ghost publication identity drift");
  if (!hasTag(post, plan.topicTag)) throw new Error("Ghost publication topic marker drift");
  const slug = bounded(post.slug, 191, "Ghost publication slug");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) throw new Error("Ghost publication slug drift");
  const canonicalUrl = new URL(`${slug}/`, `${config.ghostOrigin}/`).href;
  if (post.status === "published" && post.url !== canonicalUrl) {
    throw new Error("Ghost publication route differs from the registered platform route");
  }
  return { ...post, url: canonicalUrl };
}

function resourceTag(resourceId) {
  if (!UUID.test(resourceId)) throw new Error("Invalid publication resource identity");
  return `#discussionbridge-resource-${resourceId.toLowerCase()}`;
}

function postPayload(plan, status, resourceId, updatedAt) {
  const tags = [
    { name: "#discussionbridge-source" }, { name: plan.topicTag }, { name: plan.revisionTag },
    ...(resourceId ? [{ name: resourceTag(resourceId) }] : []), ...plan.mappedTags,
  ];
  return {
    title: plan.title,
    html: plan.html,
    status,
    tags,
    ...(plan.slug ? { slug: plan.slug } : {}),
    published_at: plan.createdAt,
    ...(updatedAt ? { updated_at: updatedAt } : {}),
  };
}

function validateResolve(response, plan, post) {
  const resourceId = response?.resource_id;
  if (!UUID.test(resourceId ?? "") || !["created", "resolved"].includes(response?.outcome) ||
      response?.external_id !== `ghost:${plan.type}:${post.id}` || response?.canonical_url !== post.url ||
      response?.pending_publication_revision !== plan.publicationRevision || response?.pending_mapping_revision !== plan.mappingRevision) {
    throw new Error("Invalid source-topic resolve response");
  }
  if (plan.publication.resource_id && plan.publication.resource_id !== resourceId) throw new Error("Publication resource identity changed");
  return resourceId;
}

function validateAcknowledgement(response, plan, resourceId, outcome) {
  const expectedState = ["held", "unpublished"].includes(outcome) ? "held" : "healthy";
  if (response?.resource_id !== resourceId || response?.destination_state !== expectedState ||
      response?.acknowledged_publication_revision !== plan.publicationRevision) {
    throw new Error("Invalid publication acknowledgement response");
  }
}

async function findNative(ghost, plan, config) {
  const matches = await ghost.findByTopic(plan.topicId, plan.type);
  if (!Array.isArray(matches) || matches.length > 1) throw new Error("Ambiguous Ghost publication topic marker");
  return matches.length ? exactNative(matches[0], plan, config) : null;
}

async function holdUnmappedTopic(config, store, bridge, ghost, item) {
  const publication = item?.publication;
  if (!publication?.resource_id) return { outcome: "held" };
  const resourceId = publication.resource_id;
  if (!UUID.test(resourceId) || !Number.isSafeInteger(item.topic_id) || item.topic_id <= 0 ||
      !REVISION.test(item.publication_revision ?? "") || !REVISION.test(item.destination?.mapping_revision ?? "")) {
    throw new Error("Invalid held publication identity");
  }
  const state = await store.read();
  const local = state.forum_publications?.[String(item.topic_id)];
  if (!local || local.resource_id !== resourceId || !GHOST_ID.test(local.ghost_id ?? "") ||
      !["post", "page"].includes(local.content_type)) {
    throw new Error("Ghost publication for held destination is unavailable");
  }
  let post = await ghost.get(local.ghost_id, local.content_type);
  if (!post || post.url !== local.canonical_url || !hasTag(post, resourceTag(resourceId))) {
    throw new Error("Ghost held-publication identity drift");
  }
  if (post.status !== "draft") {
    if (typeof post.updated_at !== "string") throw new Error("Ghost held-publication update identity is unavailable");
    await ghost.update(post.id, { status: "draft", updated_at: post.updated_at }, local.content_type);
    post = await ghost.get(local.ghost_id, local.content_type);
    if (post?.status !== "draft") throw new Error("Ghost publication was not held");
  }
  const acknowledgement = await bridge.acknowledgePublication(resourceId, {
    source_revision: bounded(item.source_revision, 255, "source revision"),
    publication_revision: item.publication_revision,
    mapping_revision: item.destination.mapping_revision,
    destination: item.destination,
    native_destination: { external_id: `ghost:${local.content_type}:${local.ghost_id}`, canonical_url: local.canonical_url },
    outcome: "held",
  });
  validateAcknowledgement(acknowledgement, { publicationRevision: item.publication_revision }, resourceId, "held");
  await store.update(async (current) => {
    current.forum_publications[String(item.topic_id)] = {
      ...current.forum_publications[String(item.topic_id)], state: "held", synchronized_at: new Date().toISOString(),
    };
  });
  return { outcome: "held" };
}

async function materializeTopic(config, store, bridge, ghost, item) {
  if (item?.destination?.state !== "ready") return holdUnmappedTopic(config, store, bridge, ghost, item);
  const response = await bridge.sourceTopic(item.topic_id);
  if (response?.eligible !== true || !response.source_topic) throw new Error("Source topic is no longer eligible");
  const plan = publicationPlan(item, response.source_topic, config);
  let native = await findNative(ghost, plan, config);
  const wasExisting = Boolean(native);
  if (!native) {
    if (plan.publication.resource_id) throw new Error("Receiver publication exists without a Ghost topic marker");
    let createError;
    try { await ghost.create(postPayload(plan, "draft"), plan.type); } catch (error) { createError = error; }
    native = await findNative(ghost, plan, config);
    if (!native) throw createError ?? new Error("Ghost draft marker was not persisted");
  }
  if (plan.publication.canonical_url && plan.publication.canonical_url !== native.url) {
    throw new Error("Ghost publication URL change requires an explicit migration and redirect");
  }

  const resolved = await bridge.resolveSourceTopic(plan.topicId, {
    source_revision: plan.sourceRevision,
    publication_revision: plan.publicationRevision,
    mapping_revision: plan.mappingRevision,
    destination: plan.destination,
    external_id: `ghost:${plan.type}:${native.id}`,
    canonical_url: native.url,
    ...(config.lane ? { lane: config.lane } : {}),
    native_materialization: true,
  });
  const resourceId = validateResolve(resolved, plan, native);
  const receiverHealthy = plan.publication.destination_state === "healthy" &&
    plan.publication.acknowledged_publication_revision === plan.publicationRevision;
  const nativeCurrent = native.status === "published" && hasTag(native, plan.revisionTag) && hasTag(native, resourceTag(resourceId));
  let outcome = wasExisting ? "updated" : "created";
  if (!nativeCurrent) {
    if (typeof native.updated_at !== "string") throw new Error("Ghost publication update identity is unavailable");
    let updateError;
    try { await ghost.update(native.id, postPayload(plan, "published", resourceId, native.updated_at), plan.type); } catch (error) { updateError = error; }
    native = await findNative(ghost, plan, config);
    if (!native || native.status !== "published" || !hasTag(native, plan.revisionTag) || !hasTag(native, resourceTag(resourceId))) {
      throw updateError ?? new Error("Ghost publication state was not persisted");
    }
  } else if (receiverHealthy) {
    outcome = "unchanged";
  }

  const acknowledgement = await bridge.acknowledgePublication(resourceId, {
    source_revision: plan.sourceRevision,
    publication_revision: plan.publicationRevision,
    mapping_revision: plan.mappingRevision,
    destination: plan.destination,
    native_destination: { external_id: `ghost:${plan.type}:${native.id}`, canonical_url: native.url },
    outcome,
  });
  validateAcknowledgement(acknowledgement, plan, resourceId, outcome);
  await store.update(async (state) => {
    state.forum_publications ??= {};
    state.forum_publications[String(plan.topicId)] = {
      resource_id: resourceId, ghost_id: native.id, content_type: plan.type,
      canonical_url: native.url, topic_id: plan.topicId, topic_url: plan.topicUrl,
      source_revision: plan.sourceRevision, publication_revision: plan.publicationRevision,
      mapping_revision: plan.mappingRevision, adapter_version: PRODUCT_VERSION,
      state: "healthy", synchronized_at: new Date().toISOString(),
    };
  });
  return { outcome, resourceId };
}

async function applyRevocation(store, bridge, ghost, item) {
  const resourceId = item?.resource_id;
  const topicId = item?.topic_id;
  const publicationRevision = item?.publication_revision;
  if (!UUID.test(resourceId ?? "") || !Number.isSafeInteger(topicId) || topicId <= 0 || !REVISION.test(publicationRevision ?? "")) {
    throw new Error("Invalid publication revocation");
  }
  const state = await store.read();
  const local = state.forum_publications?.[String(topicId)];
  if (!local || local.resource_id !== resourceId || !GHOST_ID.test(local.ghost_id ?? "") || !["post", "page"].includes(local.content_type)) {
    throw new Error("Ghost publication for revocation is unavailable");
  }
  let post = await ghost.get(local.ghost_id, local.content_type);
  if (!post || post.url !== local.canonical_url || !hasTag(post, resourceTag(resourceId))) throw new Error("Ghost revocation identity drift");
  if (post.status !== "draft") {
    if (typeof post.updated_at !== "string") throw new Error("Ghost revocation update identity is unavailable");
    await ghost.update(post.id, { status: "draft", updated_at: post.updated_at }, local.content_type);
    post = await ghost.get(local.ghost_id, local.content_type);
    if (post?.status !== "draft") throw new Error("Ghost publication was not unpublished");
  }
  const acknowledgement = await bridge.acknowledgePublication(resourceId, {
    publication_revision: publicationRevision,
    native_destination: { external_id: `ghost:${local.content_type}:${local.ghost_id}`, canonical_url: local.canonical_url },
    outcome: "unpublished",
  });
  const plan = { publicationRevision };
  validateAcknowledgement(acknowledgement, plan, resourceId, "unpublished");
  await store.update(async (current) => {
    current.forum_publications[String(topicId)] = { ...current.forum_publications[String(topicId)], state: "held", synchronized_at: new Date().toISOString() };
  });
  return { outcome: "unpublished" };
}

async function updateCatalog(bridge, ghost) {
  const current = await bridge.platformCatalogStatus();
  const catalog = await buildPlatformCatalog(ghost);
  const updated = await bridge.updatePlatformCatalog(catalog, current?.catalog_revision || undefined);
  if (updated?.destination_mapping_state !== "current") throw new Error("Ghost destination mapping requires operator configuration");
  return updated;
}

function nextCursor(payload) {
  const pagination = payload?.pagination;
  if (!pagination || typeof pagination !== "object" || typeof pagination.complete !== "boolean") throw new Error("Invalid source feed pagination");
  const cursor = pagination.next_cursor;
  if (pagination.complete) {
    if (cursor !== null && cursor !== undefined) throw new Error("Completed source feed returned a cursor");
    return null;
  }
  if (typeof cursor !== "string" || !cursor || Buffer.byteLength(cursor) > MAX_CURSOR_BYTES) throw new Error("Invalid source feed cursor");
  return cursor;
}

export async function syncForumPublications(config, store, bridge, ghost) {
  await updateCatalog(bridge, ghost);
  const summary = { created: 0, updated: 0, unchanged: 0, held: 0, unpublished: 0, failed: 0, errors: [] };
  const seenTopics = new Set();
  let cursor;
  do {
    const payload = await bridge.sourceTopics(cursor);
    if (!Array.isArray(payload?.source_topics)) throw new Error("Invalid source topic feed");
    for (const item of payload.source_topics) {
      const topicId = item?.topic_id;
      if (!Number.isSafeInteger(topicId) || topicId <= 0 || seenTopics.has(topicId)) throw new Error("Duplicate or invalid source topic identity");
      seenTopics.add(topicId);
      try {
        const result = await materializeTopic(config, store, bridge, ghost, item);
        summary[result.outcome] += 1;
      } catch (error) {
        summary.failed += 1;
        summary.errors.push({ topic_id: topicId, reason: String(error?.message ?? "Publication failed").slice(0, 240) });
      }
    }
    cursor = nextCursor(payload);
  } while (cursor);

  const seenResources = new Set();
  do {
    const payload = await bridge.sourceRevocations(cursor);
    if (!Array.isArray(payload?.publication_revocations)) throw new Error("Invalid publication revocation feed");
    for (const item of payload.publication_revocations) {
      const resourceId = item?.resource_id;
      if (!UUID.test(resourceId ?? "") || seenResources.has(resourceId)) throw new Error("Duplicate or invalid revocation identity");
      seenResources.add(resourceId);
      try {
        const result = await applyRevocation(store, bridge, ghost, item);
        summary[result.outcome] += 1;
      } catch (error) {
        summary.failed += 1;
        summary.errors.push({ resource_id: resourceId, reason: String(error?.message ?? "Revocation failed").slice(0, 240) });
      }
    }
    cursor = nextCursor(payload);
  } while (cursor);
  return summary;
}

export async function syncQueuedForumPublications(config, store, bridge, ghost, maximum = 20) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 20) throw new Error("Invalid publication work limit");
  const catalog = await bridge.platformCatalogStatus();
  if (catalog?.destination_mapping_state !== "current") throw new Error("Ghost destination mapping requires operator configuration");
  const summary = { created: 0, updated: 0, unchanged: 0, held: 0, unpublished: 0, failed: 0, errors: [] };

  for (let index = 0; index < maximum; index++) {
    const claimed = await bridge.claimPublicationWork(300);
    const work = claimed?.publication_work;
    if (work === null) break;
    try {
      let result;
      if (work.action === "publish") {
        const detail = await bridge.sourceTopic(work.topic_id);
        const item = detail?.eligible === true ? detail.source_topic : null;
        if (!item || item.source_revision !== work.source_revision || item.publication_revision !== work.publication_revision) {
          throw new Error("Claimed Ghost source revision changed");
        }
        result = await materializeTopic(config, store, bridge, ghost, item);
      } else {
        if (!UUID.test(work.resource_id ?? "")) throw new Error("Invalid Ghost publication withdrawal claim");
        const detail = await bridge.sourceRevocation(work.resource_id);
        const item = detail?.revoked === true ? detail.publication_revocation : null;
        if (!item || item.topic_id !== work.topic_id || item.publication_revision !== work.publication_revision) {
          throw new Error("Claimed Ghost publication withdrawal changed");
        }
        result = await applyRevocation(store, bridge, ghost, item);
      }
      summary[result.outcome] += 1;
    } catch (error) {
      const detail = String(error?.message ?? error).replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 1000);
      const rawCode = typeof error?.reason === "string" ? error.reason : "ghost_delivery_failed";
      const errorCode = rawCode.toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 64) || "ghost_delivery_failed";
      try { await bridge.failPublicationWork(errorCode, detail); }
      catch (reportError) { summary.errors.push({ topic_id: work?.topic_id, reason: String(reportError?.message ?? reportError).slice(0, 240) }); }
      summary.failed += 1;
      summary.errors.push({ topic_id: work?.topic_id, reason: detail.slice(0, 240) });
    } finally {
      bridge.clearPublicationLease();
    }
  }
  return summary;
}

export { publicationPlan };
