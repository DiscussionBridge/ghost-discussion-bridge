import { PRODUCT_VERSION } from "./version.mjs";
import { boundedResponse } from "./bounded-response.mjs";
import { hydratePublication, PUBLICATION_CONTRACT, SourceChanged } from "./publication-content.mjs";
import { outboundBody, sourcePublication } from "./source-publication.mjs";

const MAX_BYTES = 65_536;
const MAX_CONTENT_HTML_BYTES = 48 * 1024;
const MAX_SOURCE_AUTHORS = 20;

function boundedString(value, maximum, label) {
  if (typeof value !== "string" || value.trim() === "" || Buffer.byteLength(value) > maximum) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function sourceAuthorship(current, ghostOrigin) {
  const rawAuthors = current.authors;
  if (rawAuthors === undefined || rawAuthors === null) return {};
  if (!Array.isArray(rawAuthors) || rawAuthors.length < 1 || rawAuthors.length > MAX_SOURCE_AUTHORS) {
    throw new Error("Invalid Ghost authors");
  }

  const sourceAuthors = rawAuthors.map((author) => {
    if (!author || typeof author !== "object") throw new Error("Invalid Ghost author");
    const ghostId = boundedString(author.id, 240, "Ghost author ID");
    const id = `ghost-author:${ghostId}`;
    const name = boundedString(author.name, 200, "Ghost author name");
    let profileUrl;
    if (author.url !== undefined && author.url !== null && author.url !== "") {
      const parsed = new URL(boundedString(author.url, 2048, "Ghost author URL"));
      if (parsed.origin !== ghostOrigin || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error("Ghost author URL is outside Ghost origin");
      }
      profileUrl = parsed.href;
    }
    return { id, name, ...(profileUrl ? { profile_url: profileUrl } : {}) };
  });

  if (new Set(sourceAuthors.map(({ id }) => id)).size !== sourceAuthors.length) {
    throw new Error("Duplicate Ghost author identity");
  }

  const primaryGhostId = current.primary_author?.id ?? rawAuthors[0]?.id;
  const primarySourceAuthorId = `ghost-author:${boundedString(primaryGhostId, 240, "primary Ghost author ID")}`;
  if (!sourceAuthors.some(({ id }) => id === primarySourceAuthorId)) {
    throw new Error("Primary Ghost author is not present in authors");
  }

  return {
    source_authors: sourceAuthors,
    primary_source_author_id: primarySourceAuthorId,
  };
}

export class BridgeClient {
  constructor(config, fetchImplementation = fetch, { timeoutMs = 10_000 } = {}) {
    this.config = config;
    this.fetch = fetchImplementation;
    this.timeoutMs = timeoutMs;
  }

  async resolve(record) {
    return this.request("POST", "/discussion-bridge/v1/bridge-records/resolve.json", { bridge_record: record });
  }

  async record(resourceId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(resourceId)) {
      throw new Error("Invalid resource ID");
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await this.request("GET", `/discussion-bridge/v1/bridge-records/${encodeURIComponent(resourceId)}.json?publication_contract=${PUBLICATION_CONTRACT}`, undefined, true, 2 * 1024 * 1024);
      if (response.bridge_record?.resource_id !== resourceId) throw new Error("Ghost detail resource identity changed");
      try { if (response.bridge_record.source?.content) response.bridge_record.content_html = await this.hydrate(response.bridge_record); return response; }
      catch (error) { if (!(error instanceof SourceChanged) || attempt === 2) throw error; }
    }
  }

  async hydrate(record) {
    return hydratePublication(record, async (path) => {
      try { return { status: 200, ok: true, payload: await this.request("GET", path, undefined, true, 65536) }; }
      catch (error) { if (error.status === 409) return { status: 409, ok: false }; throw error; }
    });
  }

  async records(page = 1, snapshot) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) throw new Error("Invalid records page");
    if (snapshot !== undefined && (typeof snapshot !== "string" || !snapshot || snapshot.length > 8_192)) throw new Error("Invalid records snapshot");
    const query = new URLSearchParams({ page: String(page), publication_contract: PUBLICATION_CONTRACT });
    if (snapshot) query.set("snapshot", snapshot);
    return this.request("GET", `/discussion-bridge/v1/bridge-records.json?${query}`, undefined, true, 2 * 1024 * 1024);
  }

  async publicTopic(topicId) {
    if (!Number.isSafeInteger(topicId) || topicId <= 0) throw new Error("Invalid topic ID");
    return this.request("GET", `/t/${topicId}.json`, undefined, false);
  }

  async publicTopicPosts(topicId, postIds) {
    if (!Number.isSafeInteger(topicId) || topicId <= 0 || !Array.isArray(postIds) || postIds.length < 1 || postIds.length > 20) {
      throw new Error("Invalid topic post request");
    }
    if (postIds.some((postId) => !Number.isSafeInteger(postId) || postId <= 0)) throw new Error("Invalid topic post request");
    const query = new URLSearchParams();
    for (const postId of new Set(postIds)) query.append("post_ids[]", String(postId));
    return this.request("GET", `/t/${topicId}/posts.json?${query}`, undefined, false);
  }

  async publicPoweredByDiscourse() {
    const { response, bytes } = await boundedResponse(this.fetch, `${this.config.serverUrl}/`, {
        credentials: "omit",
        headers: {
          Accept: "text/html",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        },
        redirect: "error",
      }, {
        origin: this.config.serverUrl, mediaType: "text/html", maximumBytes: 512 * 1024, timeoutMs: this.timeoutMs,
        transportError: "Discourse branding transport failed", originError: "Unexpected response origin",
        mediaError: "Invalid Discourse branding response", limitError: "Response too large",
      });
    if (!response.ok) throw new Error("Invalid Discourse branding response");
    const text = new TextDecoder().decode(bytes);
    const match = /<script[^>]+id=["']data-preloaded["'][^>]*>([\s\S]*?)<\/script>/iu.exec(text);
    if (!match) throw new Error("Discourse branding setting is unavailable");
    let outer, settings;
    try { outer = JSON.parse(match[1]); settings = JSON.parse(outer.siteSettings); } catch { throw new Error("Discourse branding setting is invalid"); }
    if (typeof settings?.enable_powered_by_discourse !== "boolean") throw new Error("Discourse branding setting is invalid");
    return settings.enable_powered_by_discourse;
  }

  async request(method, path, payload, authenticate = true, maximumBytes = MAX_BYTES) {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    if (body && Buffer.byteLength(body) > MAX_BYTES) throw new Error("Request too large");
    const { response, bytes } = await boundedResponse(this.fetch, `${this.config.serverUrl}${path}`, {
        method,
        redirect: "error",
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(authenticate ? {
            "X-DiscussionBridge-Connection": this.config.connectionId,
            "X-DiscussionBridge-Secret": this.config.connectionSecret,
          } : {}),
        },
        body,
      }, {
        origin: this.config.serverUrl, mediaType: "application/json", maximumBytes, timeoutMs: this.timeoutMs,
        transportError: "DiscussionBridge transport failed", originError: "Unexpected response origin",
        mediaError: "Invalid response content type", limitError: "Response too large",
      });
    let data;
    try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("Invalid response JSON"); }
    if (!response.ok) {
      const error = new Error("DiscussionBridge rejected the request");
      // Upstream text is not a safe public diagnostic or logging payload.
      error.reason = "request_failed";
      error.status = response.status;
      throw error;
    }
    return data;
  }
}

export function ghostRecord(payload, config, correlationId) {
  const current = payload?.post?.current;
  if (!current || typeof current !== "object") throw new Error("Invalid Ghost webhook");
  const id = boundedString(current.id, 244, "Ghost post ID");
  const title = boundedString(current.title, 1024, "title");
  const fullContentHtml = boundedString(current.html, Number.MAX_SAFE_INTEGER, "published content");
  const url = new URL(boundedString(current.url, 2048, "canonical URL"));
  if (url.origin !== config.ghostOrigin || !url.pathname.startsWith("/")) throw new Error("Canonical URL is outside Ghost origin");
  if (current.status !== "published") throw new Error("Ghost post is not published");
  const tags = Array.isArray(current.tags) ? current.tags : [];
  const optedIn = tags.some((tag) => tag && typeof tag === "object" && (tag.name === "#discussionbridge" || tag.slug === "hash-discussionbridge"));
  if (!optedIn) throw new Error("Ghost post is not opted in");
  if (tags.some((tag) => tag?.name === "#discussionbridge-source" || tag?.slug === "hash-discussionbridge-source")) throw new Error("A received source-owned publication cannot be republished as a Ghost original");
  const authorship = sourceAuthorship(current, config.ghostOrigin);
  const publication = sourcePublication({ key: id, title, full_content_html: fullContentHtml, source_authors: authorship.source_authors, primary_source_author_id: authorship.primary_source_author_id }, current.created_at, current.updated_at);
  if (!publication && Buffer.byteLength(fullContentHtml) > MAX_CONTENT_HTML_BYTES) throw new Error("Ghost source dates are needed before delivering a complete-content excerpt");
  const record = {
    direction: "to_discourse",
    external_id: `ghost-post:${id}`,
    canonical_url: url.href,
    title,
    content_html: outboundBody(fullContentHtml, url.href),
    published: true,
    visibility: "unlisted",
    adapter_id: "ghost-discussion-bridge",
    adapter_version: PRODUCT_VERSION,
    correlation_id: correlationId,
    ...authorship,
    ...(publication ? { source_publication: publication } : {}),
    ...(config.lane ? { lane: config.lane } : {}),
  };
  let budget = MAX_CONTENT_HTML_BYTES;
  while (Buffer.byteLength(JSON.stringify({ bridge_record: { ...record, ...(publication ? { source_publication: { ...publication, previous_revision: "a".repeat(64) } } : {}) } })) > MAX_BYTES) {
    if (!publication) throw new Error("Ghost source dates are needed before delivering an envelope-sized excerpt");
    budget = Math.floor(budget * 0.85); record.content_html = outboundBody(fullContentHtml, url.href, budget, true); publication.excerpted = true;
  }
  return record;
}
