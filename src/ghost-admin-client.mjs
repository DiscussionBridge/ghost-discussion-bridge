import { createHmac } from "node:crypto";
import { boundedResponse } from "./bounded-response.mjs";

const MAX_BYTES = 256 * 1024;
const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function resourceType(value) {
  if (!["post", "page"].includes(value)) throw new Error("Invalid Ghost publication type");
  return `${value}s`;
}

function nativeObjects(data, nativeType, single = false) {
  const key = resourceType(nativeType), other = nativeType === "post" ? "pages" : "posts";
  const objects = data?.[key];
  if (!Array.isArray(objects) || Object.hasOwn(data, other) || (single && objects.length !== 1)) throw new Error("Invalid Ghost publication response envelope");
  for (const object of objects) {
    if (!object || typeof object !== "object" || Array.isArray(object) || (object.type !== undefined && object.type !== nativeType)) throw new Error("Ghost publication type disagreement");
  }
  // Resource envelope/path is authoritative even when Ghost omits `type`.
  return objects.map((object) => ({ ...object, type: nativeType }));
}

function token(apiKey, now = Math.floor(Date.now() / 1000)) {
  const match = /^([a-f0-9]{24}):([a-f0-9]{64})$/iu.exec(apiKey);
  if (!match) throw new Error("Invalid Ghost Admin API key");
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT", kid: match[1] });
  const payload = encode({ iat: now, exp: now + 300, aud: "/admin/" });
  const signature = createHmac("sha256", Buffer.from(match[2], "hex")).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export class GhostAdminClient {
  constructor(config, fetchImplementation = fetch, { timeoutMs = 10_000 } = {}) {
    this.origin = config.ghostAdminOrigin ?? config.ghostOrigin;
    this.apiKey = config.ghostAdminApiKey;
    this.fetch = fetchImplementation;
    this.timeoutMs = timeoutMs;
    this.publicationType = config.publicationType ?? "post";
    resourceType(this.publicationType);
  }

  async create(post, nativeType = this.publicationType) {
    const key = resourceType(nativeType);
    return nativeObjects(await this.request("POST", `/ghost/api/admin/${key}/?source=html`, { [key]: [post] }), nativeType, true)[0];
  }

  async get(id, maximumBytes = MAX_BYTES, nativeType = this.publicationType) {
    if (!/^[a-f0-9]{24}$/iu.test(id)) throw new Error("Invalid Ghost post ID");
    const key = resourceType(nativeType);
    return nativeObjects(await this.request("GET", `/ghost/api/admin/${key}/${id}/?formats=html`, undefined, maximumBytes), nativeType, true)[0];
  }

  async findByResource(resourceId, maximumBytes = MAX_BYTES, nativeType = this.publicationType) {
    if (!RESOURCE_ID.test(resourceId)) throw new Error("Invalid DiscussionBridge resource ID");
    const tag = `hash-discussionbridge-resource-${resourceId.toLowerCase()}`;
    resourceType(nativeType);
    const objects = [];
    // A resource marker is unique across posts AND pages. An absent local
    // receipt does not permit recreating an existing object in the other type.
    for (const selectedType of [nativeType, nativeType === "post" ? "page" : "post"]) {
      const key = resourceType(selectedType);
      const path = `/ghost/api/admin/${key}/?filter=${encodeURIComponent(`tag:${tag}`)}&limit=3&formats=html&include=tags`;
      const matches = nativeObjects(await this.request("GET", path, undefined, maximumBytes), selectedType);
      if (matches.length > 3) throw new Error("Invalid Ghost publication resource lookup");
      objects.push(...matches);
    }
    return objects;
  }

  async update(id, post, nativeType = this.publicationType) {
    if (!/^[a-f0-9]{24}$/iu.test(id)) throw new Error("Invalid Ghost post ID");
    const key = resourceType(nativeType);
    return nativeObjects(await this.request("PUT", `/ghost/api/admin/${key}/${id}/?source=html`, { [key]: [post] }), nativeType, true)[0];
  }

  async request(method, path, payload, maximumBytes = MAX_BYTES) {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    // Native writes contain the complete selected article. A transport response
    // budget follows that known request size; no adapter publication-size cap.
    if (body) maximumBytes = Math.max(maximumBytes, Buffer.byteLength(body) * 4 + 16384);
    const { response, bytes } = await boundedResponse(this.fetch, `${this.origin}${path}`, {
        method,
        redirect: "error",
        headers: { Accept: "application/json", Authorization: `Ghost ${token(this.apiKey)}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body,
      }, {
        origin: this.origin, mediaType: "application/json", maximumBytes, timeoutMs: this.timeoutMs,
        transportError: "Ghost Admin transport failed", originError: "Unexpected Ghost response origin",
        mediaError: "Invalid Ghost response content type", limitError: "Ghost response too large",
      });
    let data;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("Invalid Ghost response JSON"); }
    if (!response.ok) {
      const error = new Error(response.status === 429 ? "Ghost Admin rate limit; retry after the server's cooldown" : "Ghost Admin rejected the request");
      error.status = response.status;
      if (response.status === 429) {
        error.code = "ghost_admin_rate_limited";
        const cooldown = response.headers.get("retry-after");
        if (/^[0-9]{1,8}$/u.test(cooldown ?? "")) error.retryAfterSeconds = Number(cooldown);
      }
      throw error;
    }
    return data;
  }
}

export { token as ghostAdminToken };
