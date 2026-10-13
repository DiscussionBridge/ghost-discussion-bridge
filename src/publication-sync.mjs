import { PRODUCT_VERSION } from "./version.mjs";
import sanitizeHtml from "sanitize-html";
import { browserLoaderUrl } from "./browser-assets.mjs";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Parser } from "htmlparser2";
import { sourceTime } from "./source-time.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
// Fail closed for inert/raw-text, foreign-namespace and non-article parsing
// contexts. This is owned-markup proof, not real browser/CSP qualification.
const NON_PRESENTATION_CONTEXTS = new Set(["template", "noscript", "svg", "math", "iframe", "noembed", "noframes", "xmp", "plaintext", "textarea", "title", "style", "script", "select", "option", "optgroup", "frameset"]);
// Options/optgroups allow omitted ends; SVG/MathML allow self-closing tags.
// Other unsupported contexts need an explicit end, not parser repair through
// an outside ancestor or end-of-input. This is not a full HTML tree builder.
const IMPLIED_CONTEXT_CLOSES = new Set(["option", "optgroup", "svg", "math"]);

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

function failureReason(error, config) {
  let reason = typeof error?.message === "string" ? error.message : "Publication synchronization failed";
  for (const secret of [config.connectionSecret, config.webhookSecret, config.ghostAdminApiKey, config.operatorPassword]) {
    if (typeof secret === "string" && secret) reason = reason.replaceAll(secret, "[redacted]");
  }
  return reason.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 240) || "Publication synchronization failed";
}

function publicationType(config) {
  const nativeType = config.publicationType ?? "post";
  if (!["post", "page"].includes(nativeType)) throw new Error("Invalid Ghost publication type");
  return nativeType;
}

function mappedType(prior) {
  // Alpha.24's established mappings and uncertain intents can only be posts.
  // Missing type never authorizes adoption into a different native resource.
  const nativeType = prior?.ghost_native_type ?? "post";
  if (!["post", "page"].includes(nativeType)) throw new Error("Invalid Ghost mapped publication type");
  return nativeType;
}

export function nativePublication(record, config) {
  if (!record || typeof record !== "object") throw new Error("Invalid publication record");
  const bindings = Array.isArray(record.bindings) ? record.bindings.filter((item) => item?.role === "presentation" && item?.state === "active") : [];
  if (!bindings.some((item) => item.native_materialization === true)) return null;
  if (bindings.length !== 1 || bindings[0].native_materialization !== true) throw new Error("Ambiguous native publication authority");
  if (!record || record.direction !== "from_discourse" || record.state !== "healthy" || !UUID.test(record.resource_id ?? "")) throw new Error("Invalid publication record");
  if (!Number.isSafeInteger(record.topic_id) || record.topic_id <= 0) throw new Error("Invalid publication topic");
  const destination = safeUrl(bindings[0].canonical_url, config.ghostOrigin, "publication destination");
  const segments = destination.pathname.split("/").filter(Boolean);
  if (segments.length !== 1 || destination.pathname !== `/${segments[0]}/` || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(segments[0])) throw new Error("Invalid publication slug");
  const source = record.source;
  const edition = source?.edition;
  if (edition !== undefined && (typeof edition !== "string" || !/^[a-f0-9]{64}$/u.test(edition))) throw new Error("Invalid coherent source edition");
  const identity = { nativeType: publicationType(config), resourceId: record.resource_id, resourceTag: `#discussionbridge-resource-${record.resource_id.toLowerCase()}`, resourceTagSlug: `hash-discussionbridge-resource-${record.resource_id.toLowerCase()}`, destination: destination.href, slug: segments[0], topicId: record.topic_id };
  if (source?.status === "withdrawn") { if (!edition) throw new Error("Invalid withdrawal edition"); return { ...identity, withdrawn: true, revision: edition, ...(record.topic_url ? { topicUrl: safeUrl(record.topic_url, config.serverUrl, "withdrawn topic URL").href } : {}) }; }
  if (source?.status !== undefined && source.status !== "active") throw new Error("Invalid source publication status");
  const needsContent = source?.content && record.content_html === null;
  if (!needsContent && (typeof record.content_html !== "string" || !record.content_html.trim())) throw new Error("Invalid publication content");
  if (!source || source.platform !== "discourse" || source.origin !== config.serverUrl || source.topic_id !== record.topic_id || source.post_number !== 1 || !Number.isSafeInteger(source.post_id) || source.post_id <= 0 || !Number.isSafeInteger(source.post_version) || source.post_version <= 0 || source.revision !== `post:${source.post_id}:version:${source.post_version}`) throw new Error("Invalid publication source");
  const topicAddress = safeUrl(record.topic_url ?? source.topic_url, config.serverUrl, "source topic URL");
  if (!new RegExp(`^/t/(?:[^/]+/)?${record.topic_id}/?$`, "u").test(topicAddress.pathname)) throw new Error("Source topic URL does not identify the native topic");
  const topicUrl = topicAddress.href;
  const authorName = bounded(source.author?.name, 200, "source author");
  safeUrl(source.author?.profile_url, config.serverUrl, "source author URL");
  const title = bounded(record.title, 1024, "publication title");
  const date = (value) => { if (value === undefined || value === null) return undefined; if (sourceTime(value) === null) throw new Error("Invalid native source date"); return value; };
  const createdAt = date(source.created_at), updatedAt = date(source.updated_at);
  if (createdAt && updatedAt && sourceTime(updatedAt) < sourceTime(createdAt)) throw new Error("Source update precedes creation");
  const forumName = bounded(source.forum_name ?? config.forumName ?? config.serverUrl, 200, "source forum name");
  const mode = config.existingPresentationMode ?? bindings[0].presentation_mode ?? config.publicationPresentationMode ?? "interactive";
  if (!["simple", "full", "interactive"].includes(mode)) throw new Error("Invalid selected native presentation mode");
  const revision = edition ?? source.revision;
  const loaderUrl = browserLoaderUrl(config);
  const provenance = `<hr><aside class="discussionbridge-publication" data-discussionbridge-publication-resource="${escape(record.resource_id)}" data-discussionbridge-revision="${escape(revision)}"><p><strong>Published from <a href="${escape(topicUrl)}">${escape(forumName)}</a></strong></p><p>Source author: ${escape(authorName)} · Revision ${escape(source.revision)} · Ghost · DiscussionBridge for Ghost ${PRODUCT_VERSION}</p>${createdAt ? `<p>Source created: <time datetime="${escape(createdAt)}">${escape(createdAt)}</time></p>` : ""}${updatedAt ? `<p>Source updated: <time datetime="${escape(updatedAt)}">${escape(updatedAt)}</time></p>` : ""}</aside><div data-discussionbridge-comments="${mode}"></div><script data-discussionbridge-loader="${PRODUCT_VERSION}" src="${escape(loaderUrl)}" defer></script>`;
  const revisionDigest = createHash("sha256").update(revision).digest("hex");
  const portableBody = needsContent ? "" : sanitizeHtml(record.content_html, { allowedTags: sanitizeHtml.defaults.allowedTags.concat(["h1", "img"]), allowedAttributes: { a: ["href", "title", "rel"], img: ["src", "alt", "title", "width", "height"], code: ["class"], pre: ["class"], span: ["class"], div: ["class"] }, allowedClasses: { span: ["math"], div: ["math"] }, allowedSchemes: ["https"], allowProtocolRelative: false });
  const html = `<!--discussionbridge-native:${record.resource_id}:start-->${portableBody}${provenance}<!--discussionbridge-native:${record.resource_id}:end-->`;
  const presentationRevision = createHash("sha256").update(JSON.stringify({ title, html })).digest("hex");
  return {
    nativeType: identity.nativeType,
    resourceId: record.resource_id,
    resourceTag: `#discussionbridge-resource-${record.resource_id.toLowerCase()}`,
    resourceTagSlug: `hash-discussionbridge-resource-${record.resource_id.toLowerCase()}`,
    revision, legacyRevision: source.revision, edition, needsContent, createdAt, updatedAt, mode, portableBody,
    revisionTag: `#discussionbridge-revision-${revisionDigest}`,
    revisionTagSlug: `hash-discussionbridge-revision-${revisionDigest}`,
    presentationRevision,
    presentationTag: `#discussionbridge-presentation-${presentationRevision}`,
    presentationTagSlug: `hash-discussionbridge-presentation-${presentationRevision}`,
    loaderUrl, topicId: record.topic_id, topicUrl, destination: destination.href, slug: segments[0], title, html,
  };
}

function exactGhostPost(post, publication) {
  if (!post || !/^[a-f0-9]{24}$/iu.test(post.id ?? "") || post.slug !== publication.slug || post.url !== publication.destination) throw new Error("Ghost publication identity drift");
  if (post.type !== undefined && post.type !== publication.nativeType) throw new Error("Ghost native publication type changed; reconciliation is required");
  const tags = normalizedTags(post.tags ?? []);
  let resource = false;
  for (const tag of tags) {
    const name = tag.name?.trim().toLowerCase(), slug = tag.slug?.toLowerCase();
    if (name === publication.resourceTag || slug === publication.resourceTagSlug) resource = true;
    if ((name?.startsWith("#discussionbridge-resource-") && name !== publication.resourceTag) || (slug?.startsWith("hash-discussionbridge-resource-") && slug !== publication.resourceTagSlug)) throw new Error("Ghost native publication has conflicting resource ownership");
  }
  if (!resource) throw new Error("Ghost publication resource marker drift");
  return post;
}

function normalizedTags(tags) {
  if (!Array.isArray(tags)) throw new Error("Invalid Ghost native tags");
  const normalized = [], byId = new Map(), byName = new Map(), bySlug = new Map();
  for (const tag of tags) {
    if (!tag || typeof tag !== "object" || Array.isArray(tag) || typeof tag.name !== "string" || !tag.name.trim() || /[\u0000-\u001f\u007f]/u.test(tag.name)) throw new Error("Invalid Ghost native tag");
    if (tag.id !== undefined && (typeof tag.id !== "string" || !/^[a-f0-9]{24}$/iu.test(tag.id))) throw new Error("Invalid Ghost native tag ID");
    if (tag.slug !== undefined && (typeof tag.slug !== "string" || !tag.slug.trim() || /[\u0000-\u001f\u007f]/u.test(tag.slug))) throw new Error("Invalid Ghost native tag slug");
    const id = tag.id?.toLowerCase(), name = tag.name.trim().normalize("NFC").toLowerCase(), slug = tag.slug?.trim().normalize("NFC").toLowerCase();
    const prior = (id && byId.get(id)) || byName.get(name) || (slug && bySlug.get(slug));
    if (prior) {
      if ((id && prior.id && id !== prior.id.toLowerCase()) || prior.name.trim().normalize("NFC").toLowerCase() !== name || (slug && prior.slug && slug !== prior.slug.trim().normalize("NFC").toLowerCase())) throw new Error("Ghost native tag identity is ambiguous");
      continue;
    }
    // Retain operator display names and metadata byte-for-byte; normalization
    // is only for comparison/deduplication, not a taxonomy rename.
    normalized.push(tag);
    if (id) byId.set(id, tag);
    byName.set(name, tag);
    if (slug) bySlug.set(slug, tag);
  }
  return normalized;
}

function managedBlock(html, resourceId) {
  if (typeof html !== "string") throw new Error("Ghost native body is unavailable");
  const start = `<!--discussionbridge-native:${resourceId}:start-->`, end = `<!--discussionbridge-native:${resourceId}:end-->`;
  const markers = [];
  activeMarkup(html, { comment(text, parser) { if (text === start.slice(4, -3) || text === end.slice(4, -3)) markers.push({ text, start: parser.startIndex, end: parser.endIndex + 1 }); } });
  if (!markers.length) return null;
  if (markers.length !== 2 || markers[0].text !== start.slice(4, -3) || markers[1].text !== end.slice(4, -3)) throw new Error("Ghost native source boundary is ambiguous");
  return { start: markers[0].start, end: markers[1].end, html: html.slice(markers[0].start, markers[1].end) };
}

function activeMarkup(html, handlers) {
  const contexts = []; let blockedDepth = 0, balanced = true;
  const parser = new Parser({
    onopentag(tagName, attributes) { if (blockedDepth === 0) handlers.tag?.(tagName, attributes); const blocked = NON_PRESENTATION_CONTEXTS.has(tagName); contexts.push({ tagName, blocked }); if (blocked) blockedDepth++; },
    onclosetag(tagName, implied) { const context = contexts.pop(); if (context?.tagName !== tagName || (context?.blocked && implied && !IMPLIED_CONTEXT_CLOSES.has(tagName))) balanced = false; if (context?.blocked) blockedDepth--; },
    oncomment(text) { if (blockedDepth === 0) handlers.comment?.(text, parser); },
  }, { decodeEntities: true });
  parser.end(html);
  if (!balanced || contexts.length) throw new Error("Ghost native source context requires reconciliation");
}

function selectedMode(post) {
  const modes = [];
  activeMarkup(post.html ?? "", { tag(_tag, attributes) { if (attributes["data-discussionbridge-comments"] !== undefined) modes.push(attributes["data-discussionbridge-comments"]); } });
  if (modes.length > 1 || modes.some((mode) => !["simple", "full", "interactive"].includes(mode))) throw new Error("Ghost native presentation selection is ambiguous");
  return modes[0];
}

const managedHash = (html) => createHash("sha256").update(html.replace(/\bdata-discussionbridge-comments=(["'])(?:simple|full|interactive)\1/gu, 'data-discussionbridge-comments="selection"')).digest("hex");

function retainedHtml(post, prior, publication) {
  if (!post) return publication.html;
  if (prior?.managed?.title !== undefined && post.title !== prior.managed.title) throw new Error("Ghost source-managed title was changed locally");
  if (prior?.managed?.published_at !== undefined && post.published_at !== prior.managed.published_at) throw new Error("Ghost source-managed date was changed locally");
  const block = managedBlock(post.html, publication.resourceId);
  if (block) {
    if (prior?.managed?.body_sha256 && managedHash(block.html) !== prior.managed.body_sha256) throw new Error("Ghost source-managed body was changed locally");
    if (!prior?.managed?.body_sha256) {
      const first = block.html.indexOf("-->") + 3, boundary = block.html.indexOf('<hr><aside class="discussionbridge-publication"');
      const oldHash = createHash("sha256").update(JSON.stringify({ title: post.title, html: post.html })).digest("hex");
      if (!(boundary >= first && block.html.slice(first, boundary) === publication.portableBody) && prior?.presentation_revision !== oldHash) throw new Error("Ghost native managed body requires reconciliation before adoption");
    }
    return post.html.slice(0, block.start) + publication.html + post.html.slice(block.end);
  }
  // Legacy source updates require exact saved-byte evidence or equality with
  // the unchanged authoritative body. Unknown customized bodies need attention.
  const priorHash = createHash("sha256").update(JSON.stringify({ title: post.title ?? publication.title, html: post.html })).digest("hex");
  const boundary = post.html.indexOf('<hr><aside class="discussionbridge-publication"');
  if (prior?.presentation_revision === priorHash || (boundary >= 0 && post.html.slice(0, boundary) === publication.portableBody)) return publication.html;
  throw new Error("Ghost legacy managed body requires reconciliation before an update");
}

function carriesRevision(post, publication) {
  const tags = Array.isArray(post?.tags) ? post.tags : [];
  return tags.some((tag) => tag?.name === publication.revisionTag || tag?.slug === publication.revisionTagSlug);
}

function carriesPresentation(post, publication) {
  const tags = Array.isArray(post?.tags) ? post.tags : [];
  if (!tags.some((tag) => tag?.name === publication.presentationTag || tag?.slug === publication.presentationTagSlug) || typeof post.html !== "string") return false;
  // Parser hooks also report elements in inert subtrees: matching attributes
  // alone cannot prove execution. Track context and reject unsupported implicit
  // exits, while retaining ordinary implied/void closes. Sanitized output is
  // discarded and never admits a script.
  let loaders = 0, provenance = 0, blockedDepth = 0, balanced = true;
  const contexts = [];
  sanitizeHtml(post.html, { allowedTags: [], allowedAttributes: {},
    onOpenTag(tagName, attribs) {
      if (blockedDepth === 0) {
        if (tagName === "script") {
          const type = (attribs.type ?? "").trim().toLowerCase();
          if ((!type || ["text/javascript", "application/javascript"].includes(type)) && !Object.hasOwn(attribs, "nomodule") && attribs.src === publication.loaderUrl && attribs["data-discussionbridge-loader"] === PRODUCT_VERSION) loaders += 1;
        } else if (tagName === "aside" && (attribs.class ?? "").split(/\s+/u).includes("discussionbridge-publication") && attribs["data-discussionbridge-publication-resource"] === publication.resourceId && attribs["data-discussionbridge-revision"] === publication.revision) provenance += 1;
      }
      const blocked = NON_PRESENTATION_CONTEXTS.has(tagName);
      contexts.push({ tagName, blocked });
      if (blocked) blockedDepth += 1;
    },
    onCloseTag(tagName, isImplied) {
      const context = contexts.pop();
      if (context?.tagName !== tagName) balanced = false;
      // The forgiving parser can pop a template on </div> even though that
      // end tag does not exit HTML template scope. Never certify that repair.
      if (context?.blocked && isImplied && !IMPLIED_CONTEXT_CLOSES.has(tagName)) balanced = false;
      if (context?.blocked) blockedDepth -= 1;
    },
  });
  return balanced && contexts.length === 0 && loaders === 1 && provenance === 1;
}

function assertIntent(pending, operationId, publication) {
  if (pending?.state !== "pending" || pending.operation_id !== operationId || pending.revision !== publication.revision || pending.presentation_revision !== publication.presentationRevision || pending.canonical_url !== publication.destination || mappedType(pending) !== publication.nativeType) throw new Error("Ghost publication intent ownership changed");
}

async function reserveNativeWrite(store, operationId, publication, pendingLeaseMs, postId) {
  await store.update(async (state) => {
    const pending = state.publications[publication.resourceId];
    assertIntent(pending, operationId, publication);
    if (postId) {
      pending.ghost_post_id = postId;
      pending.create_outcome_uncertain = false;
    } else {
      if (pending.create_outcome_uncertain !== false || pending.ghost_post_id) throw new Error("Ghost publication create outcome requires reconciliation");
      // Commit uncertainty before the external create. A lost response, crash
      // or expired owner cannot turn the next attempt into a second create.
      pending.create_outcome_uncertain = true;
    }
    pending.pending_until = Date.now() + pendingLeaseMs;
  });
}

async function markedPost(ghost, publication) {
  const matches = await ghost.findByResource(publication.resourceId, publication.responseBudget, publication.nativeType);
  if (!Array.isArray(matches) || matches.length > 1) throw new Error("Ambiguous Ghost publication resource marker");
  if (matches.length === 0) return null;
  const post = exactGhostPost(matches[0], publication);
  const tags = Array.isArray(post.tags) ? post.tags : [];
  if (!tags.some((tag) => tag?.name === publication.resourceTag || tag?.slug === publication.resourceTagSlug)) throw new Error("Ghost publication resource marker drift");
  return post;
}

export async function syncPublications(config, store, bridge, ghost, { pendingLeaseMs = 60_000, assertOperation = async () => {} } = {}) {
  const summary = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, errors: [] };
  const pageDigests = [];
  let page = 1;
  let snapshot; let expectedPages; let expectedTotal;
  const seenResources = new Set();
  const seenDestinations = new Map();
  const digest = (records) => createHash("sha256").update(JSON.stringify(records)).digest("hex");
  for (;;) {
    await assertOperation();
    const response = await bridge.records(page, snapshot);
    if (!Array.isArray(response?.bridge_records) || response.bridge_records.length > 100 || !Number.isSafeInteger(response?.pagination?.pages) || response.pagination.pages < 1 || response.pagination.pages > 10_000 || response.pagination.page !== page || !Number.isSafeInteger(response.pagination.total) || response.pagination.total < 0 || response.pagination.total > response.pagination.pages * 100 || typeof response.pagination.snapshot !== "string" || !response.pagination.snapshot || response.pagination.snapshot.length > 8_192) throw new Error("Invalid publication feed");
    if (page === 1) {
      snapshot = response.pagination.snapshot; expectedPages = response.pagination.pages; expectedTotal = response.pagination.total;
    } else if (response.pagination.snapshot !== snapshot || response.pagination.pages !== expectedPages || response.pagination.total !== expectedTotal) {
      throw new Error("Publication feed changed during synchronization");
    }
    for (const record of response.bridge_records) {
      const id = typeof record?.resource_id === "string" ? record.resource_id.toLowerCase() : "";
      if (!UUID.test(id) || seenResources.has(id)) throw new Error("Publication feed contains a duplicate or invalid resource identity");
      seenResources.add(id);
      if (seenResources.size > expectedTotal) throw new Error("Publication feed exceeded its declared census");
      const destinations = Array.isArray(record.bindings) ? record.bindings.filter((binding) => binding?.role === "presentation" && binding?.state === "active" && binding.native_materialization === true) : [];
      for (const binding of destinations) {
        if (typeof binding.canonical_url !== "string") continue;
        let destination;
        try { destination = safeUrl(binding.canonical_url, config.ghostOrigin, "publication destination").href; } catch { continue; }
        if (seenDestinations.has(destination) && seenDestinations.get(destination) !== id) throw new Error("Publication feed contains a native destination collision");
        seenDestinations.set(destination, id);
      }
    }
    pageDigests.push(digest(response.bridge_records));
    if (page >= response.pagination.pages) break;
    page += 1;
  }
  if (seenResources.size !== expectedTotal) throw new Error("Publication feed did not produce its complete unique census");
  // Census the entire immutable feed before native mutation, retaining only
  // bounded identity/digest metadata. Bodies are processed one 100-row page at
  // a time and each replay is verified against its original snapshot bytes.
  async function* candidates() {
    for (let replayPage = 1; replayPage <= expectedPages; replayPage++) {
      await assertOperation();
      const response = await bridge.records(replayPage, snapshot);
      if (response?.pagination?.page !== replayPage || response.pagination.pages !== expectedPages || response.pagination.total !== expectedTotal || response.pagination.snapshot !== snapshot || !Array.isArray(response.bridge_records) || response.bridge_records.length > 100 || digest(response.bridge_records) !== pageDigests[replayPage - 1]) throw new Error("Publication feed changed during synchronization");
      yield* response.bridge_records;
    }
  }
  for await (let record of candidates()) {
      await assertOperation();
      let publication;
      try {
        publication = nativePublication(record, config);
        if (publication?.needsContent) {
          const prior = (await store.read()).publications[publication.resourceId];
          if (prior && mappedType(prior) !== publication.nativeType) throw new Error("Ghost native publication type changed; reconciliation is required");
          if (prior?.state === "complete" && prior.source_status !== "withdrawn" && prior.revision === publication.revision && prior.source_content_sha256 === record.source.content.sha256 && prior.source_content_bytes === record.source.content.bytes && prior.canonical_url === publication.destination && prior.topic_id === publication.topicId && prior.adapter_version === PRODUCT_VERSION && prior.managed?.body_sha256) {
            publication.responseBudget = Math.max(256 * 1024, (prior.native_content_bytes ?? 0) * 4 + 16384);
            const native = await markedPost(ghost, publication), block = managedBlock(native?.html, publication.resourceId);
            if (native?.id !== prior.ghost_post_id || !block || managedHash(block.html) !== prior.managed.body_sha256 || native.title !== prior.managed.title) throw new Error("Ghost native publication changed locally; reconciliation is required");
            if (prior.managed.published_at !== undefined && native.published_at !== prior.managed.published_at) throw new Error("Ghost native source date changed locally; reconciliation is required");
            selectedMode(native); summary.unchanged += 1; continue;
          }
          const original = publication;
          if (typeof bridge.record !== "function") throw new Error("Ghost full-content source retrieval is unavailable");
          record = (await bridge.record(publication.resourceId)).bridge_record;
          publication = nativePublication(record, config);
          if (!publication || publication.resourceId !== original.resourceId || publication.topicId !== original.topicId || publication.destination !== original.destination || publication.nativeType !== original.nativeType) throw new Error("Ghost source binding/identity changed; reconciliation is required");
          if (publication.needsContent) throw new Error("Ghost source transfer did not hydrate a complete body");
        }
      } catch (error) { summary.failed += 1; summary.errors.push({ resource_id: UUID.test(record?.resource_id ?? "") ? record.resource_id : null, reason: failureReason(error, config) }); continue; }
      if (!publication) { summary.skipped += 1; continue; }
      const operationId = randomUUID();
      let claim;
      for (;;) {
        await store.update(async (state) => {
          const prior = state.publications[publication.resourceId];
          if (prior && (prior.canonical_url !== publication.destination || (prior.topic_id && prior.topic_id !== publication.topicId) || mappedType(prior) !== publication.nativeType)) { claim = { kind: "invalid", prior }; return; }
          const now = Date.now();
          if (prior?.state === "pending" && Number.isFinite(prior.pending_until) && prior.pending_until > now && prior.operation_id !== operationId) { claim = { kind: "wait", milliseconds: prior.pending_until - now }; return; }
          // Missing historical certainty on a destination-less intent is not
          // permission to create. Explicit false means no create was reserved;
          // true survives attention/reload and all source/presentation changes.
          const uncertain = prior?.create_outcome_uncertain === true || Boolean(prior && !prior.ghost_post_id && prior.create_outcome_uncertain !== false);
          claim = { kind: uncertain ? "recover" : (prior?.ghost_post_id ? "update" : "create"), prior };
          state.publications[publication.resourceId] = { ...prior, ghost_native_type: publication.nativeType, state: "pending", create_outcome_uncertain: uncertain, operation_id: operationId, pending_until: now + pendingLeaseMs, canonical_url: publication.destination, revision: publication.revision, presentation_revision: publication.presentationRevision, adapter_version: PRODUCT_VERSION, topic_id: publication.topicId, topic_url: publication.topicUrl ?? prior?.topic_url, resource_tag: publication.resourceTag };
        });
        if (claim.kind !== "wait") break;
        await delay(Math.min(claim.milliseconds + 5, pendingLeaseMs + 5));
      }
      try {
        if (claim.kind === "invalid") throw new Error("Ghost native mapping changed; reconciliation is required");
        publication.responseBudget = Math.max(256 * 1024, (Buffer.byteLength(publication.html ?? "") + (claim.prior?.native_content_bytes ?? 0)) * 4 + 16384);
        let result = await markedPost(ghost, publication);
        if (!result && claim.prior?.ghost_post_id) result = exactGhostPost(await ghost.get(claim.prior.ghost_post_id, publication.responseBudget, publication.nativeType), publication);
        if (result && claim.prior?.ghost_post_id && result.id !== claim.prior.ghost_post_id) throw new Error("Ghost native post identity changed");
        if (!result && claim.kind === "recover") throw new Error("Ghost publication create outcome requires reconciliation");
        if (result) await reserveNativeWrite(store, operationId, publication, pendingLeaseMs, result.id);
        if (publication.withdrawn) {
          if (!result || result.id !== claim.prior?.ghost_post_id || claim.prior?.topic_id !== publication.topicId) throw new Error("Ghost withdrawal lacks exact owned native publication evidence");
          if (result.status !== "draft") { await assertOperation(); await ghost.update(result.id, { status: "draft", updated_at: result.updated_at }, publication.nativeType); }
          const withdrawn = exactGhostPost(await ghost.get(result.id, publication.responseBudget, publication.nativeType), publication);
          if (withdrawn.status !== "draft") throw new Error("Ghost native withdrawal status was not persisted");
          await store.update(async (state) => { const pending = state.publications[publication.resourceId]; assertIntent(pending, operationId, publication); state.publications[publication.resourceId] = { ...pending, state: "complete", source_status: "withdrawn", prior_native_status: claim.prior?.prior_native_status ?? result.status, public_withdrawal_verified: false, synchronized_at: new Date().toISOString() }; });
          summary.withdrawn = (summary.withdrawn ?? 0) + 1; continue;
        }
        const nativeMode = result ? selectedMode(result) : undefined;
        if (nativeMode) { const budget = publication.responseBudget; publication = nativePublication(record, { ...config, existingPresentationMode: nativeMode }); publication.responseBudget = budget; await store.update(async (state) => { const pending = state.publications[publication.resourceId]; if (pending.operation_id !== operationId) throw new Error("Ghost intent ownership changed"); pending.presentation_revision = publication.presentationRevision; }); }
        const tags = [...normalizedTags(result?.tags ?? []).filter((tag) => !/^#discussionbridge-(?:revision|presentation)-/iu.test(tag.name.trim()) && !/^hash-discussionbridge-(?:revision|presentation)-/iu.test(tag.slug ?? "")), { name: "#discussionbridge-source" }, { name: publication.resourceTag }, { name: publication.revisionTag }, { name: publication.presentationTag }];
        const payload = { title: publication.title, slug: publication.slug, html: retainedHtml(result, claim.prior, publication), status: claim.prior?.source_status === "withdrawn" ? claim.prior.prior_native_status ?? "published" : result?.status ?? "published", ...(publication.createdAt ? { published_at: publication.createdAt } : {}), tags: normalizedTags(tags) };
        const existing = Boolean(result);
        let wrote = false;
        if (result && (!carriesRevision(result, publication) || !carriesPresentation(result, publication))) {
          if (typeof result.updated_at !== "string") throw new Error("Ghost publication identity drift");
          await reserveNativeWrite(store, operationId, publication, pendingLeaseMs, result.id);
          let updateError;
          try { await assertOperation(); wrote = true; await ghost.update(result.id, { ...payload, updated_at: result.updated_at }, publication.nativeType); }
          catch (error) { updateError = error; }
          result = await markedPost(ghost, publication);
          if (!result || !carriesRevision(result, publication) || !carriesPresentation(result, publication)) {
            if (updateError) throw updateError;
            throw new Error("Ghost publication revision and presentation were not persisted");
          }
        } else if (!result) {
          await reserveNativeWrite(store, operationId, publication, pendingLeaseMs);
          let createError;
          try { await assertOperation(); await ghost.create(payload, publication.nativeType); }
          catch (error) { createError = error; }
          result = await markedPost(ghost, publication);
          if (!result || !carriesRevision(result, publication) || !carriesPresentation(result, publication)) {
            if (createError) throw createError;
            throw new Error("Ghost publication marker and presentation were not persisted");
          }
        }
        result = exactGhostPost(result, publication);
        if (result.title !== publication.title) throw new Error("Ghost source title was not persisted");
        const persistedBlock = managedBlock(result.html, publication.resourceId);
        if (!persistedBlock) throw new Error("Ghost native source ownership boundary was not persisted");
        if (publication.createdAt && Date.parse(result.published_at) !== Date.parse(publication.createdAt)) throw new Error("Ghost source creation date was not persisted");
        await store.update(async (state) => {
          const pending = state.publications[publication.resourceId];
          assertIntent(pending, operationId, publication);
          state.publications[publication.resourceId] = { ghost_native_type: publication.nativeType, ghost_post_id: result.id, canonical_url: publication.destination, revision: publication.revision, legacy_revision: publication.legacyRevision, presentation_revision: publication.presentationRevision, adapter_version: PRODUCT_VERSION, topic_id: publication.topicId, topic_url: publication.topicUrl, resource_tag: publication.resourceTag, state: "complete", source_status: "active", native_content_bytes: Buffer.byteLength(result.html), source_content_sha256: record.source?.content?.sha256 ?? createHash("sha256").update(record.content_html).digest("hex"), source_content_bytes: record.source?.content?.bytes ?? Buffer.byteLength(record.content_html), source_created_at: publication.createdAt, source_updated_at: publication.updatedAt, managed: { title: result.title ?? publication.title, ...(publication.createdAt ? { published_at: result.published_at } : {}), body_sha256: managedHash(persistedBlock.html), presentation_mode: publication.mode }, synchronized_at: new Date().toISOString() };
        });
        summary[existing || claim.prior?.ghost_post_id ? (wrote ? "updated" : "unchanged") : "created"] += 1;
      } catch (error) {
        const reason = failureReason(error, config);
        await store.update(async (state) => {
          const current = state.publications[publication.resourceId];
          if (current?.operation_id === operationId) state.publications[publication.resourceId] = { ...current, state: "attention", failure_reason: reason, failed_at: new Date().toISOString() };
        });
        summary.failed += 1;
        summary.errors.push({ resource_id: publication.resourceId, reason });
      }
  }
  return summary;
}
