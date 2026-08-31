import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import sanitizeHtml from "sanitize-html";
import { BridgeClient, ghostRecord } from "./bridge-client.mjs";

const MAX_WEBHOOK_BYTES = 131_072;
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
        const topicUrl = exactTopicUrl(record.topic_url, config.serverUrl);
        const cooked = sanitizeHtml(record.content_html, { allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]), allowedAttributes: { a: ["href", "title", "rel"], img: ["src", "alt", "title", "width", "height"], code: ["class"], pre: ["class"] }, allowedSchemes: ["https"], allowProtocolRelative: false });
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" });
        return response.end(`<section class="discussionbridge-presentation">${cooked}<p class="discussionbridge-presentation__source-link"><a href="${topicUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" rel="noopener noreferrer">Open this discussion on The Bridge</a></p></section>`);
      }
      if (request.method === "GET" && url.pathname === "/comments") {
        const sourceUrl = exactGhostSource(url.searchParams.get("source"), config.ghostOrigin);
        const state = await store.read();
        const matches = Object.values(state.posts).filter((post) => post?.canonical_url === sourceUrl);
        if (matches.length !== 1) return json(response, 404, { error: "not_found" });
        const post = matches[0];
        if (!UUID.test(post.resource_id ?? "") || !Number.isSafeInteger(post.topic_id) || post.topic_id <= 0) throw new Error("Invalid stored discussion identity");
        const topicUrl = exactTopicUrl(post.topic_url, config.serverUrl);
        return json(response, 200, { topic_id: post.topic_id, topic_url: topicUrl, forum_origin: config.serverUrl });
      }
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { status: "ok" });
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      return json(response, 502, { error: "adapter_failure", reason: typeof error.reason === "string" ? error.reason : "request_failed" });
    }
  });
}

export { exactGhostSource, validGhostSignature };
