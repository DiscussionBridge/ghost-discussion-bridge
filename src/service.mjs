import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import sanitizeHtml from "sanitize-html";
import { BridgeClient, ghostRecord } from "./bridge-client.mjs";

const MAX_WEBHOOK_BYTES = 131_072;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function tokenMatches(actual, expected) {
  const a = createHash("sha256").update(actual).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
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

export function buildServer(config, store, client = new BridgeClient(config)) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "POST" && url.pathname.startsWith("/webhooks/ghost/")) {
        const token = decodeURIComponent(url.pathname.slice("/webhooks/ghost/".length));
        if (!tokenMatches(token, config.webhookToken)) return json(response, 404, { error: "not_found" });
        if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(response, 415, { error: "content_type" });
        const payload = JSON.parse(await body(request));
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
        const record = await client.record(resourceId);
        if (record.direction !== "from_discourse" || record.resource_id !== resourceId || typeof record.cooked_html !== "string") throw new Error("Invalid presentation record");
        const topicUrl = exactTopicUrl(record.topic_url, config.serverUrl);
        const cooked = sanitizeHtml(record.cooked_html, { allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]), allowedAttributes: { a: ["href", "title", "rel"], img: ["src", "alt", "title", "width", "height"], code: ["class"], pre: ["class"] }, allowedSchemes: ["https"], allowProtocolRelative: false });
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" });
        return response.end(`<section class="discussionbridge-presentation">${cooked}<p><a href="${topicUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" rel="noopener noreferrer">Continue the discussion</a></p></section>`);
      }
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { status: "ok" });
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      return json(response, 502, { error: "adapter_failure", reason: typeof error.reason === "string" ? error.reason : "request_failed" });
    }
  });
}
