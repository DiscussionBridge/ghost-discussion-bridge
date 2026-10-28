import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import sanitizeHtml from "sanitize-html";
import { CoreClient } from "./core-client.mjs";
import { operatorAuthorized, operatorCsrfValid, renderOperatorPage } from "./operator-surface.mjs";
import { serveBrowserAsset } from "./browser-assets.mjs";
import { isTopicIdentity, nativeTopicUrl } from "./topic-identity.mjs";
import { assertNativeContentRepresentable, assertNativeConversionPreserved } from "./native-content-preservation.mjs";
import { anchorCopiedArticleReferences } from "./article-references.mjs";
import { ghostSourceNotification } from "./ghost-source-notification.mjs";
import { normalizeCommentsMode } from "./comments-mode.mjs";

const MAX_WEBHOOK_BYTES = 131_072;
const INITIAL_SIMPLE_REPLIES = 5;
const MAX_SIMPLE_REPLIES = 50;
const BRANDING_CACHE_MS = 10 * 60 * 1000;
const brandingCache = new Map();
const discourseWordmark = readFileSync(new URL("../assets/discourse-wordmark.svg", import.meta.url), "utf8");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OPERATOR_HEADERS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const OPERATOR_NOTICE_COOKIE = "discussionbridge_operator_notice";

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

async function body(request, maximum = MAX_WEBHOOK_BYTES) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximum) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function signedOperatorNotice(notice, password) {
  const payload = Buffer.from(notice, "utf8").toString("base64url");
  const signature = createHmac("sha256", password).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function operatorNotice(cookieHeader, password) {
  if (typeof cookieHeader !== "string" || cookieHeader.length > 4096) return "";
  const encoded = cookieHeader.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${OPERATOR_NOTICE_COOKIE}=`))?.slice(OPERATOR_NOTICE_COOKIE.length + 1);
  if (!encoded || encoded.length > 1024) return "";
  const separator = encoded.lastIndexOf(".");
  if (separator < 1) return "";
  const payload = encoded.slice(0, separator);
  const actual = Buffer.from(encoded.slice(separator + 1));
  const expected = Buffer.from(createHmac("sha256", password).update(payload).digest("base64url"));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return "";
  try {
    const notice = Buffer.from(payload, "base64url").toString("utf8");
    return Buffer.byteLength(notice) <= 512 ? notice : "";
  } catch { return ""; }
}

function redirectWithOperatorNotice(response, notice, password) {
  response.writeHead(303, {
    "Cache-Control": "no-store",
    Location: "/discussionbridge/operator/",
    "Set-Cookie": `${OPERATOR_NOTICE_COOKIE}=${signedOperatorNotice(notice, password)}; Path=/discussionbridge/operator/; Max-Age=60; HttpOnly; Secure; SameSite=Strict`,
  });
  response.end();
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

async function renderSimpleDiscussion(client, topicId, forumOrigin, standaloneForumName) {
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
  if (postStream.stream.length - 1 > MAX_SIMPLE_REPLIES) {
    if (standaloneForumName === undefined && typeof client.publicForumTitle !== "function") throw new Error("Native forum display name is unavailable");
    const name = standaloneForumName === undefined ? await client.publicForumTitle() : standaloneForumName;
    if (typeof name !== "string" || !name.trim() || Buffer.byteLength(name) > 200 || /\p{Cc}/u.test(name) || Buffer.from(name, "utf8").toString("utf8") !== name) throw new Error("Invalid standalone forum display name");
    content += `<p class="discussionbridge-simple__limit">Showing the first ${MAX_SIMPLE_REPLIES} comments. <a href="${escapeHtml(topicUrl)}" rel="nofollow noopener noreferrer">View the complete discussion on ${escapeHtml(name.trim())}</a>.</p>`;
  }
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

export function buildServer(config, store, client = new CoreClient(config), operations = {}) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const publicRead = ["/comments", "/simple"].includes(url.pathname) || url.pathname.startsWith("/presentation/") || url.pathname.startsWith("/assets/");
      if (publicRead) {
        // These routes were already public. CORS is a browser boundary, not
        // authority to access private forum content or administrative routes.
        response.setHeader("Vary", "Origin");
        const origin = request.headers.origin;
        const allowedMethods = url.pathname.startsWith("/assets/") ? ["GET", "HEAD"] : ["GET"];
        if (origin !== undefined && origin !== config.ghostOrigin) return json(response, 403, { error: "origin_denied" });
        if (origin === config.ghostOrigin) response.setHeader("Access-Control-Allow-Origin", config.ghostOrigin);
        if (request.method === "OPTIONS") {
          if (origin !== config.ghostOrigin || !allowedMethods.includes(request.headers["access-control-request-method"]) || request.headers["access-control-request-headers"]) return json(response, 403, { error: "preflight_denied" });
          response.writeHead(204, { "Access-Control-Allow-Methods": allowedMethods.join(", "), "Access-Control-Max-Age": "600", "Cache-Control": "no-store" });
          return response.end();
        }
        if (!allowedMethods.includes(request.method)) return json(response, 405, { error: "method_not_allowed" });
      }
      if (["GET", "HEAD"].includes(request.method) && url.pathname.startsWith("/assets/")) {
        if (serveBrowserAsset(request, response, url)) return;
        return json(response, 404, { error: "not_found" });
      }
      if (url.pathname === "/operator" || url.pathname === "/operator/" || url.pathname === "/operator/synchronize" || url.pathname === "/operator/url-move" || url.pathname === "/operator/catalog-refresh" || url.pathname === "/operator/stop-source" || url.pathname === "/operator/source-url-move" || url.pathname === "/operator/retry-source") {
        if (!config.operatorPassword || !operatorAuthorized(request.headers.authorization, config.operatorPassword)) {
          response.writeHead(401, { "WWW-Authenticate": 'Basic realm="DiscussionBridge operator", charset="UTF-8"', "Cache-Control": "no-store" });
          return response.end("Authentication required");
        }
        if ((url.pathname === "/operator" || url.pathname === "/operator/") && request.method === "GET") {
          const notice = operatorNotice(request.headers.cookie, config.operatorPassword);
          response.writeHead(200, { ...OPERATOR_HEADERS, ...(notice ? { "Set-Cookie": `${OPERATOR_NOTICE_COOKIE}=; Path=/discussionbridge/operator/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` } : {}) });
          return response.end(renderOperatorPage(config, await store.read(), notice));
        }
        if (url.pathname === "/operator/synchronize" && request.method === "POST") {
          if (request.headers.origin !== config.operatorOrigin) return json(response, 403, { error: "origin_denied" });
          if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return json(response, 415, { error: "content_type" });
          const form = new URLSearchParams(await body(request, 1024));
          if (!operatorCsrfValid(form.get("csrf"), config.operatorPassword)) return json(response, 403, { error: "csrf_denied" });
          if (typeof operations.synchronize !== "function") throw new Error("Publication synchronization is unavailable");
          let summary; let notice;
          try {
            summary = await operations.synchronize();
            notice = `Synchronization complete: ${summary.created} created, ${summary.updated} updated, ${summary.unchanged} already current, ${summary.failed} failed.${summary.withdrawn ? ` ${summary.withdrawn} drafted locally; public withdrawal verification remains pending.` : ""}`;
          } catch {
            notice = "Synchronization failed. Review the protected failure details below, correct the cause, and retry.";
          }
          return redirectWithOperatorNotice(response, notice, config.operatorPassword);
        }
        if (url.pathname === "/operator/catalog-refresh" && request.method === "POST") {
          if (request.headers.origin !== config.operatorOrigin) return json(response, 403, { error: "origin_denied" });
          if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "")) return json(response, 415, { error: "content_type" });
          const form = new URLSearchParams(await body(request, 1024));
          if ([...form.keys()].some((name) => !["csrf", "kind"].includes(name)) || form.getAll("csrf").length !== 1 || form.getAll("kind").length !== 1 || !["authors", "taxonomy"].includes(form.get("kind"))) return json(response, 400, { error: "invalid_catalog_request" });
          if (!operatorCsrfValid(form.get("csrf"), config.operatorPassword)) return json(response, 403, { error: "csrf_denied" });
          if (typeof operations.refreshCatalog !== "function") return json(response, 409, { error: "catalog_unavailable" });
          let notice;
          try { const result = await operations.refreshCatalog(form.get("kind")); notice = `Native ${result.kind === "authors" ? "authors" : "tags"} catalog refreshed: ${result.total_items} entries.`; }
          catch { notice = "Native catalog refresh failed. Inspect the protected refresh state and correct or reconcile the cause."; }
          return redirectWithOperatorNotice(response, notice, config.operatorPassword);
        }
        if (url.pathname === "/operator/url-move" && request.method === "POST") {
          if (request.headers.origin !== config.operatorOrigin) return json(response, 403, { error: "origin_denied" });
          if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return json(response, 415, { error: "content_type" });
          const form = new URLSearchParams(await body(request, 8192));
          const names = ["csrf", "mapping_id", "expected_mapping_revision", "new_url"];
          if ([...form.keys()].some((name) => !names.includes(name)) || names.some((name) => form.getAll(name).length !== 1)) return json(response, 400, { error: "invalid_move_request" });
          if (!operatorCsrfValid(form.get("csrf"), config.operatorPassword)) return json(response, 403, { error: "csrf_denied" });
          if (typeof operations.queuePresentationMove !== "function") return json(response, 409, { error: "move_unavailable" });
          let notice;
          try { await operations.queuePresentationMove({ mapping_id: form.get("mapping_id"), expected_mapping_revision: form.get("expected_mapping_revision"), new_url: form.get("new_url") }); notice = "URL move request saved. Movement waits for an eligible source publication update."; }
          catch { notice = "URL move request was not queued. Check the exact current mapping, revision, proposed native URL and protected reconciliation state."; }
          return redirectWithOperatorNotice(response, notice, config.operatorPassword);
        }
        if (url.pathname === "/operator/source-url-move" && request.method === "POST") {
          if (request.headers.origin !== config.operatorOrigin) return json(response, 403, { error: "origin_denied" });
          if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "")) return json(response, 415, { error: "content_type" });
          const form = new URLSearchParams(await body(request, 8192)), fields = ["csrf", "native_id", "expected_source_revision", "new_url"];
          if ([...form.keys()].some((name) => !fields.includes(name)) || fields.some((name) => form.getAll(name).length !== 1) || !/^[a-f0-9]{24}$/u.test(form.get("native_id") ?? "")) return json(response, 400, { error: "invalid_source_move_request" });
          if (!operatorCsrfValid(form.get("csrf"), config.operatorPassword)) return json(response, 403, { error: "csrf_denied" });
          if (typeof operations.prepareSourceMove !== "function") return json(response, 409, { error: "source_move_unavailable" });
          let notice;
          try { await operations.prepareSourceMove({ native_id: form.get("native_id"), expected_source_revision: form.get("expected_source_revision"), new_url: form.get("new_url") }); notice = "Source URL request is recorded. Check current source status and retained native/receiver evidence."; }
          catch { notice = "Source URL request needs attention. Check its actual current source, revision, native URL and retained request."; }
          return redirectWithOperatorNotice(response, notice, config.operatorPassword);
        }
        if (url.pathname === "/operator/retry-source" && request.method === "POST") {
          if (request.headers.origin !== config.operatorOrigin) return json(response, 403, { error: "origin_denied" });
          if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "")) return json(response, 415, { error: "content_type" });
          const form = new URLSearchParams(await body(request, 1024)), fields = ["csrf", "native_id", "refused_mutation_id"];
          if ([...form.keys()].some((name) => !fields.includes(name)) || fields.some((name) => form.getAll(name).length !== 1) || !/^[a-f0-9]{24}$/u.test(form.get("native_id") ?? "") || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(form.get("refused_mutation_id") ?? "") || form.get("refused_mutation_id") === "00000000-0000-0000-0000-000000000000") return json(response, 400, { error: "invalid_source_retry_request" });
          if (!operatorCsrfValid(form.get("csrf"), config.operatorPassword)) return json(response, 403, { error: "csrf_denied" });
          if (typeof operations.retrySource !== "function") return json(response, 409, { error: "source_retry_unavailable" });
          let notice;
          try { await operations.retrySource({ native_id: form.get("native_id"), refused_mutation_id: form.get("refused_mutation_id") }); notice = "Source retry completed. Check its current delivery status and retained request history."; }
          catch { notice = "Source retry needs attention. Its exact request and retained history remain available for reconciliation."; }
          return redirectWithOperatorNotice(response, notice, config.operatorPassword);
        }
        if (url.pathname === "/operator/stop-source" && request.method === "POST") {
          if (request.headers.origin !== config.operatorOrigin) return json(response, 403, { error: "origin_denied" });
          if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "")) return json(response, 415, { error: "content_type" });
          const form = new URLSearchParams(await body(request, 1024));
          if ([...form.keys()].some((name) => !["csrf", "native_id"].includes(name)) || form.getAll("csrf").length !== 1 || form.getAll("native_id").length !== 1 || !/^[a-f0-9]{24}$/u.test(form.get("native_id") ?? "")) return json(response, 400, { error: "invalid_source_stop_request" });
          if (!operatorCsrfValid(form.get("csrf"), config.operatorPassword)) return json(response, 403, { error: "csrf_denied" });
          if (typeof operations.stopSourceDelivery !== "function") return json(response, 409, { error: "source_stop_unavailable" });
          let notice;
          try { await operations.stopSourceDelivery(form.get("native_id")); notice = "Source binding is withdrawn. Its discussion is retained; publication and privacy remain native responsibilities."; }
          catch { notice = "Source stop-delivery request needs attention. Its exact binding and request remain available for reconciliation."; }
          return redirectWithOperatorNotice(response, notice, config.operatorPassword);
        }
        return json(response, 405, { error: "method_not_allowed" });
      }
      if (request.method === "POST" && url.pathname === "/webhooks/ghost") {
        if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(response, 415, { error: "content_type" });
        const rawBody = await body(request, config.webhookMaximumBytes ?? MAX_WEBHOOK_BYTES);
        if (!validGhostSignature(request.headers["x-ghost-signature"], rawBody, config.webhookSecret)) return json(response, 404, { error: "not_found" });
        const payload = JSON.parse(rawBody);
        const notification = ghostSourceNotification(payload, await store.read(), config);
        if (typeof operations.publishNativeSource !== "function") throw new Error("Ghost current native source publisher is unavailable");
        const result = await operations.publishNativeSource(notification.nativeId);
        return json(response, 200, { accepted: true, resource_id: result.resource_id, topic_id: result.topic_id, outcome: result.state === "withdrawn" ? "withdrawn" : result.outcome ?? "resolved" });
      }
      if (request.method === "GET" && url.pathname.startsWith("/presentation/")) {
        const resourceId = decodeURIComponent(url.pathname.slice("/presentation/".length));
        if (!UUID.test(resourceId)) return json(response, 404, { error: "not_found" });
        const state = await store.read();
        if (!state.presentations[resourceId]) return json(response, 404, { error: "not_found" });
        if (typeof operations.readPresentation !== "function") throw new Error("Ghost current presentation reader is unavailable");
        const record = await operations.readPresentation(resourceId);
        if (record?.resource_id === resourceId && record.state === "withdrawn") return json(response, 410, { error: "source_withdrawn" });
        if (!record || record.direction !== "from_discourse" || record.state !== "active" || record.resource_id !== resourceId || typeof record.content_html !== "string") throw new Error("Invalid presentation record");
        const mode = normalizeCommentsMode(record.presentation_mode);
        if (!mode) throw new Error("Invalid presentation mode");
        if (!isTopicIdentity(record.topic_id)) throw new Error("Invalid presentation topic identity");
        const topicUrl = nativeTopicUrl(record.topic_url, config.serverUrl, record.topic_id);
        assertNativeContentRepresentable(record.content_html);
        // The registered reader checked this URL against the immutable Source;
        // destination document URLs must never supply copied-reference bases.
        const prepared = anchorCopiedArticleReferences(record.content_html, topicUrl);
        const cooked = sanitizeHtml(prepared, {
          allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
          allowedAttributes: {
            a: ["href", "title", "rel"],
            img: ["src", "alt", "title", "width", "height"],
            code: ["class"],
            pre: ["class"],
            span: ["class"],
            div: ["class", "data-discussionbridge-lightbox-meta"],
            ol: ["start", "reversed", "type"],
            li: ["value"],
            th: ["colspan", "rowspan", "headers", "scope", "abbr"],
            td: ["colspan", "rowspan", "headers"],
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
        assertNativeConversionPreserved(prepared, cooked);
        const safeTopicUrl = topicUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
        const safeForumOrigin = config.serverUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
        const discussion = mode === "simple" ? await renderSimpleDiscussion(client, record.topic_id, config.serverUrl, record.forum_name ?? config.standaloneForumName) : "";
        const heading = mode === "simple" ? "" : `<div class="discussionbridge-comments-header"><h2>Discussion</h2><a href="${safeTopicUrl}" rel="nofollow noopener noreferrer">Open discussion</a></div>`;
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return response.end(`<section class="discussionbridge-presentation">${cooked}${heading}<div data-discussionbridge-presentation-comments data-presentation-mode="${mode}" data-topic-id="${record.topic_id}" data-topic-url="${safeTopicUrl}" data-forum-origin="${safeForumOrigin}">${discussion}</div></section>`);
      }
      if (request.method === "GET" && url.pathname === "/comments") {
        const sourceUrl = exactGhostSource(url.searchParams.get("source"), config.ghostOrigin);
        const state = await store.read();
        const publications = Object.entries(state.publications ?? {}).map(([resourceId, publication]) => ({ ...publication, resource_id: resourceId }));
        const matches = [...Object.values(state.posts), ...publications].filter((post) => post?.canonical_url === sourceUrl && post.source_status !== "withdrawn");
        if (matches.length !== 1) return json(response, 404, { error: "not_found" });
        const post = matches[0];
        if (!UUID.test(post.resource_id ?? "") || !isTopicIdentity(post.topic_id)) throw new Error("Invalid stored discussion identity");
        const topicUrl = nativeTopicUrl(post.topic_url, config.serverUrl, post.topic_id);
        return json(response, 200, { topic_id: post.topic_id, topic_url: topicUrl, forum_origin: config.serverUrl });
      }
      if (request.method === "GET" && url.pathname === "/simple") {
        const sourceUrl = exactGhostSource(url.searchParams.get("source"), config.ghostOrigin);
        const state = await store.read();
        const publications = Object.values(state.publications ?? {});
        const matches = [...Object.values(state.posts), ...publications].filter((post) => post?.canonical_url === sourceUrl && post.source_status !== "withdrawn");
        if (matches.length !== 1) return json(response, 404, { error: "not_found" });
        const post = matches[0];
        if (!isTopicIdentity(post.topic_id)) throw new Error("Invalid stored discussion identity");
        nativeTopicUrl(post.topic_url, config.serverUrl, post.topic_id);
        const html = await renderSimpleDiscussion(client, post.topic_id, config.serverUrl, config.standaloneForumName);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" });
        return response.end(html);
      }
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { status: "ok" });
      return json(response, 404, { error: "not_found" });
    } catch {
      return json(response, 502, { error: "adapter_failure", reason: "request_failed" });
    }
  });
}

export { exactGhostSource, renderSimpleDiscussion, validGhostSignature };
