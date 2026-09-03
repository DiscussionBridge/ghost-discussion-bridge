import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import sanitizeHtml from "sanitize-html";
import { BridgeClient, ghostRecord } from "./bridge-client.mjs";

const MAX_WEBHOOK_BYTES = 131_072;
const INITIAL_SIMPLE_REPLIES = 5;
const MAX_SIMPLE_REPLIES = 50;
const BRANDING_CACHE_MS = 10 * 60 * 1000;
const brandingCache = new Map();
const discourseWordmark = readFileSync(new URL("../assets/discourse-wordmark.svg", import.meta.url), "utf8");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function validGhostSignature(header, rawBody, secret, now = Date.now()) {
  if (typeof header !== "string") return false;
  const match = /^sha256=([a-f0-9]{64}), t=([0-9]{13})$/u.exec(header);
  if (!match) return false;
  const timestamp = Number(match[2]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 300_000) return false;
  const actual = Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", secret).update(`${rawBody}${match[2]}`).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function body(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_WEBHOOK_BYTES) throw new Error("Webhook too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function exactTopicUrl(value, serverOrigin) {
  if (typeof value !== "string") throw new Error("Invalid topic URL");
  const parsed = new URL(value);
  if (parsed.origin !== serverOrigin || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Invalid topic URL");
  return parsed.href;
}

function exactGhostSource(value, ghostOrigin) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 2048) throw new Error("Invalid Ghost source URL");
  const parsed = new URL(value);
  if (parsed.origin !== ghostOrigin || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Invalid Ghost source URL");
  return parsed.href;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function sanitizeReply(html) {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
    allowedAttributes: {
      a: ["href", "title", "rel"], img: ["src", "alt", "title", "width", "height"],
      code: ["class"], pre: ["class"], span: ["class"], div: ["class"],
    },
    allowedSchemes: ["https"],
    allowProtocolRelative: false,
  });
}

async function renderSimpleDiscussion(client, topicId, forumOrigin) {
  const [topic, poweredBy] = await Promise.all([client.publicTopic(topicId), poweredByDiscourse(client, forumOrigin).catch(() => false)]);
  const postStream = topic?.post_stream;
  if (!postStream || !Array.isArray(postStream.posts) || !Array.isArray(postStream.stream)) throw new Error("Invalid topic response");
  const targetIds = postStream.stream.slice(1, MAX_SIMPLE_REPLIES + 1);
  if (targetIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("Invalid topic response");
  const postsById = new Map(postStream.posts.filter((post) => Number.isSafeInteger(post?.id) && post.id > 0).map((post) => [post.id, post]));
  const missing = targetIds.filter((id) => !postsById.has(id));
  for (let index = 0; index < missing.length; index += 20) {
    const additional = await client.publicTopicPosts(topicId, missing.slice(index, index + 20));
    if (!Array.isArray(additional?.post_stream?.posts)) throw new Error("Invalid topic response");
    for (const post of additional.post_stream.posts) {
      if (!Number.isSafeInteger(post?.id) || post.id <= 0) throw new Error("Invalid topic response");
      postsById.set(post.id, post);
    }
  }
  const slug = typeof topic.slug === "string" && /^[a-z0-9-]+$/u.test(topic.slug) ? topic.slug : "topic";
  const topicUrl = `${forumOrigin}/t/${slug}/${topicId}`;
  const replies = targetIds.map((id) => {
    const post = postsById.get(id);
    if (!post || !Number.isSafeInteger(post.post_number) || post.post_number < 2 || typeof post.username !== "string" || !post.username.trim() || post.username.length > 100 || typeof post.cooked !== "string" || typeof post.created_at !== "string") throw new Error("Invalid topic response");
    const created = new Date(post.created_at);
    if (!Number.isFinite(created.valueOf())) throw new Error("Invalid topic response");
    const body = sanitizeReply(post.cooked);
    if (!body) return "";
    const name = typeof post.name === "string" && post.name.trim() ? post.name.trim() : post.username.trim();
    const template = typeof post.avatar_template === "string" && post.avatar_template.startsWith("/") && !post.avatar_template.startsWith("//") && post.avatar_template.length <= 500
      ? post.avatar_template.replace("{size}", "48") : null;
    const avatar = template
      ? `<span class="discussionbridge-simple__avatar" aria-hidden="true"><img src="${escapeHtml(forumOrigin + template)}" alt="" width="48" height="48" loading="lazy"></span>`
      : `<span class="discussionbridge-simple__avatar discussionbridge-simple__avatar--fallback" aria-hidden="true">${escapeHtml(post.username.trim().slice(0, 1).toUpperCase())}</span>`;
    return `<article class="discussionbridge-simple__reply">${avatar}<div class="discussionbridge-simple__content"><header class="discussionbridge-simple__meta"><strong>${escapeHtml(name)}</strong><a href="${escapeHtml(`${topicUrl}/${post.post_number}`)}" rel="nofollow noopener noreferrer"><time datetime="${escapeHtml(created.toISOString())}">${escapeHtml(created.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }))}</time></a></header><div class="discussionbridge-simple__body">${body}</div></div></article>`;
  }).filter(Boolean);
  let content = replies.length ? replies.slice(0, INITIAL_SIMPLE_REPLIES).join("") : '<p class="discussionbridge-simple__empty">No comments yet.</p>';
  const remaining = replies.slice(INITIAL_SIMPLE_REPLIES);
  if (remaining.length) content += `<details class="discussionbridge-simple__more"><summary><span class="discussionbridge-simple__more-closed">Show ${remaining.length} more ${remaining.length === 1 ? "comment" : "comments"}</span><span class="discussionbridge-simple__more-open">Show fewer comments</span></summary>${remaining.join("")}</details>`;
  if (postStream.stream.length - 1 > MAX_SIMPLE_REPLIES) content += `<p class="discussionbridge-simple__limit">Showing the first ${MAX_SIMPLE_REPLIES} comments. <a href="${escapeHtml(topicUrl)}" rel="nofollow noopener noreferrer">View the complete discussion on The Bridge</a>.</p>`;
  const attribution = poweredBy
    ? `<a class="discussionbridge-powered-by" href="https://www.discourse.org/powered-by" aria-label="Powered by Discourse" rel="nofollow noopener noreferrer"><span>Powered by</span><span class="discussionbridge-powered-by__wordmark">${discourseWordmark}</span></a>`
    : "";
  const bridgeCredit = '<footer class="discussionbridge-credit" aria-label="DiscussionBridge credit"><span class="discussionbridge-credit__prefix">Connected by</span> <a class="discussionbridge-credit__brand" href="https://discussionbridge.dev/" rel="nofollow">DiscussionBridge</a></footer>';
  return `<section class="discussionbridge-simple"><div class="discussionbridge-comments-header"><h2>Comments</h2><a href="${escapeHtml(topicUrl)}" rel="nofollow noopener noreferrer">Open discussion</a></div>${content}${attribution}${bridgeCredit}</section>`;
}

async function poweredByDiscourse(client, forumOrigin) {
  const now = Date.now();
  const cached = brandingCache.get(forumOrigin);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = client.publicPoweredByDiscourse();
  brandingCache.set(forumOrigin, { expiresAt: now + BRANDING_CACHE_MS, value });
  try { return await value; } catch (error) { brandingCache.delete(forumOrigin); throw error; }
}

export function buildServer(config, store, client = new BridgeClient(config)) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/webhooks/ghost") {
        if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(response, 415, { error: "content_type" });
        const rawBody = await body(request);
        if (!validGhostSignature(request.headers["x-ghost-signature"], rawBody, config.webhookSecret)) return json(response, 404, { error: "not_found" });
        const payload = JSON.parse(rawBody);
        const record = ghostRecord(payload, config, `ghost-${randomUUID()}`);
        const result = await client.resolve(record);
        if (!UUID.test(result.resource_id ?? "") || !Number.isSafeInteger(result.topic_id) || result.topic_id <= 0 || !["created", "resolved"].includes(result.outcome) || result.core_fallback !== false) {
          throw new Error("Invalid DiscussionBridge success response");
        }
        const topicUrl = exactTopicUrl(result.topic_url, config.serverUrl);
        await store.update(async (state) => {
          state.posts[record.external_id] = { resource_id: result.resource_id, topic_id: result.topic_id, topic_url: topicUrl, outcome: result.outcome, canonical_url: record.canonical_url, updated_at: new Date().toISOString() };
        });
        return json(response, 200, { accepted: true, resource_id: result.resource_id, topic_id: result.topic_id, outcome: result.outcome });
      }
      if (request.method === "GET" && url.pathname.startsWith("/presentation/")) {
        const resourceId = decodeURIComponent(url.pathname.slice("/presentation/".length));
        if (!UUID.test(resourceId)) return json(response, 404, { error: "not_found" });
        const state = await store.read();
        if (!state.presentations[resourceId]) return json(response, 404, { error: "not_found" });
        const responseRecord = await client.record(resourceId);
        const record = responseRecord?.bridge_record;
        if (!record || record.direction !== "from_discourse" || record.state !== "healthy" || record.resource_id !== resourceId || typeof record.content_html !== "string") throw new Error("Invalid presentation record");
        if (!Number.isSafeInteger(record.topic_id) || record.topic_id <= 0) throw new Error("Invalid presentation topic identity");
        const topicUrl = exactTopicUrl(record.topic_url, config.serverUrl);
        const cooked = sanitizeHtml(record.content_html, {
          allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
          allowedAttributes: {
            a: ["href", "title", "rel"],
            img: ["src", "alt", "title", "width", "height"],
            code: ["class"],
            pre: ["class"],
            span: ["class"],
            div: ["class", "data-discussionbridge-lightbox-meta"],
          },
          allowedClasses: { span: ["math"], div: ["math"] },
          allowedSchemes: ["https"],
          allowProtocolRelative: false,
          transformTags: {
            div: (tagName, attributes) => {
              const { "data-discussionbridge-lightbox-meta": ignored, ...safeAttributes } = attributes;
              if ((attributes.class ?? "").split(/\s+/u).includes("meta")) safeAttributes["data-discussionbridge-lightbox-meta"] = "true";
              return { tagName, attribs: safeAttributes };
            },
          },
          exclusiveFilter: (frame) => frame.attribs["data-discussionbridge-lightbox-meta"] === "true",
        });
        const safeTopicUrl = topicUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
        const safeForumOrigin = config.serverUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" });
        return response.end(`<section class="discussionbridge-presentation">${cooked}<div class="discussionbridge-comments-header"><h2>Discussion</h2><a href="${safeTopicUrl}" rel="nofollow noopener noreferrer">Open discussion</a></div><div data-discussionbridge-presentation-comments data-topic-id="${record.topic_id}" data-topic-url="${safeTopicUrl}" data-forum-origin="${safeForumOrigin}"></div></section>`);
      }
      if (request.method === "GET" && url.pathname === "/comments") {
        const sourceUrl = exactGhostSource(url.searchParams.get("source"), config.ghostOrigin);
        const state = await store.read();
        const publications = Object.entries(state.publications ?? {}).map(([resourceId, publication]) => ({ ...publication, resource_id: resourceId }));
        const matches = [...Object.values(state.posts), ...publications].filter((post) => post?.canonical_url === sourceUrl);
        if (matches.length !== 1) return json(response, 404, { error: "not_found" });
        const post = matches[0];
        if (!UUID.test(post.resource_id ?? "") || !Number.isSafeInteger(post.topic_id) || post.topic_id <= 0) throw new Error("Invalid stored discussion identity");
        const topicUrl = exactTopicUrl(post.topic_url, config.serverUrl);
        return json(response, 200, { topic_id: post.topic_id, topic_url: topicUrl, forum_origin: config.serverUrl });
      }
      if (request.method === "GET" && url.pathname === "/simple") {
        const sourceUrl = exactGhostSource(url.searchParams.get("source"), config.ghostOrigin);
        const state = await store.read();
        const matches = Object.values(state.posts).filter((post) => post?.canonical_url === sourceUrl);
        if (matches.length !== 1) return json(response, 404, { error: "not_found" });
        const post = matches[0];
        if (!Number.isSafeInteger(post.topic_id) || post.topic_id <= 0) throw new Error("Invalid stored discussion identity");
        exactTopicUrl(post.topic_url, config.serverUrl);
        const html = await renderSimpleDiscussion(client, post.topic_id, config.serverUrl);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" });
        return response.end(html);
      }
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { status: "ok" });
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      return json(response, 502, { error: "adapter_failure", reason: typeof error.reason === "string" ? error.reason : "request_failed" });
    }
  });
}

export { exactGhostSource, renderSimpleDiscussion, validGhostSignature };
