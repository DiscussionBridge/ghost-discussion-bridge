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
  const provenance = `<hr><aside class="discussionbridge-publication"><p><strong>Published from <a href="${escape(topicUrl)}">The Bridge</a></strong></p><p>Source author: ${escape(authorName)} · Revision ${escape(source.revision)} · Ghost 6.59.0 · DiscussionBridge for Ghost 0.1.0-alpha.21</p></aside><div data-discussionbridge-comments="fullInteractive"></div><script src="/discussionbridge/assets/loader.js" defer></script>`;
  return { resourceId: record.resource_id, revision: source.revision, topicId: record.topic_id, topicUrl, destination: destination.href, slug: segments[0], title, html: `${record.content_html}${provenance}` };
}

export async function syncPublications(config, store, bridge, ghost) {
  const summary = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, errors: [] };
  const candidates = [];
  let page = 1;
  for (;;) {
    const response = await bridge.records(page);
    if (!Array.isArray(response?.bridge_records) || !Number.isSafeInteger(response?.pagination?.pages) || response.pagination.pages < 1 || response.pagination.pages > 10_000 || response.pagination.page !== page) throw new Error("Invalid publication feed");
    candidates.push(...response.bridge_records);
    if (page >= response.pagination.pages) break;
    page += 1;
  }
  await store.update(async (state) => {
    for (const record of candidates) {
      let publication;
      try { publication = nativePublication(record, config); } catch (error) { summary.failed += 1; summary.errors.push({ resource_id: UUID.test(record?.resource_id ?? "") ? record.resource_id : null, reason: error.message }); continue; }
      if (!publication) { summary.skipped += 1; continue; }
      const prior = state.publications[publication.resourceId];
      if (prior?.revision === publication.revision && prior?.canonical_url === publication.destination && prior?.adapter_version === "0.1.0-alpha.21") { summary.unchanged += 1; continue; }
      try {
        let result;
        if (prior) {
          const current = await ghost.get(prior.ghost_post_id);
          if (!current || current.slug !== publication.slug || current.url !== publication.destination || typeof current.updated_at !== "string") throw new Error("Ghost publication identity drift");
          result = await ghost.update(prior.ghost_post_id, { title: publication.title, slug: publication.slug, html: publication.html, status: "published", updated_at: current.updated_at, tags: [{ name: "#discussionbridge-source" }] });
        } else {
          result = await ghost.create({ title: publication.title, slug: publication.slug, html: publication.html, status: "published", tags: [{ name: "#discussionbridge-source" }] });
        }
        if (!result || !/^[a-f0-9]{24}$/iu.test(result.id ?? "") || result.slug !== publication.slug || result.url !== publication.destination) throw new Error("Invalid Ghost publication result");
        state.publications[publication.resourceId] = { ghost_post_id: result.id, canonical_url: publication.destination, revision: publication.revision, adapter_version: "0.1.0-alpha.21", topic_id: publication.topicId, topic_url: publication.topicUrl, synchronized_at: new Date().toISOString() };
        summary[prior ? "updated" : "created"] += 1;
      } catch (error) { summary.failed += 1; summary.errors.push({ resource_id: publication.resourceId, reason: error.message }); }
    }
  });
  return summary;
}
