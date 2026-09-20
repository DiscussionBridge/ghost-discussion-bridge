import { createHmac } from "node:crypto";

const MAX_BYTES = 256 * 1024;
const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function collection(contentType) {
  if (contentType === "post") return "posts";
  if (contentType === "page") return "pages";
  throw new Error("Invalid Ghost content type");
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
  constructor(config, fetchImplementation = fetch) {
    this.origin = config.ghostOrigin;
    this.apiKey = config.ghostAdminApiKey;
    this.fetch = fetchImplementation;
  }

  async create(post, contentType = "post") {
    const key = collection(contentType);
    return (await this.request("POST", `/ghost/api/admin/${key}/?source=html`, { [key]: [post] }))[key]?.[0];
  }

  async get(id, contentType = "post") {
    if (!/^[a-f0-9]{24}$/iu.test(id)) throw new Error("Invalid Ghost post ID");
    const key = collection(contentType);
    return (await this.request("GET", `/ghost/api/admin/${key}/${id}/?formats=html&include=tags`))[key]?.[0];
  }

  async findByResource(resourceId, contentType = "post") {
    if (!RESOURCE_ID.test(resourceId)) throw new Error("Invalid DiscussionBridge resource ID");
    const tag = `hash-discussionbridge-resource-${resourceId.toLowerCase()}`;
    const key = collection(contentType);
    const path = `/ghost/api/admin/${key}/?filter=${encodeURIComponent(`tag:${tag}`)}&limit=3&formats=html&include=tags`;
    const posts = (await this.request("GET", path))[key];
    if (!Array.isArray(posts)) throw new Error("Invalid Ghost publication resource lookup");
    return posts;
  }

  async findByTopic(topicId, contentType = "post") {
    if (!Number.isSafeInteger(topicId) || topicId <= 0) throw new Error("Invalid Discourse topic ID");
    const key = collection(contentType);
    const tag = `hash-discussionbridge-topic-${topicId}`;
    const path = `/ghost/api/admin/${key}/?filter=${encodeURIComponent(`tag:${tag}`)}&limit=3&formats=html&include=tags`;
    const items = (await this.request("GET", path))[key];
    if (!Array.isArray(items)) throw new Error("Invalid Ghost publication topic lookup");
    return items;
  }

  async listTags() {
    const tags = (await this.request("GET", "/ghost/api/admin/tags/?limit=all&order=id%20asc")).tags;
    if (!Array.isArray(tags)) throw new Error("Invalid Ghost tag inventory");
    return tags;
  }

  async update(id, post, contentType = "post") {
    if (!/^[a-f0-9]{24}$/iu.test(id)) throw new Error("Invalid Ghost post ID");
    const key = collection(contentType);
    return (await this.request("PUT", `/ghost/api/admin/${key}/${id}/?source=html`, { [key]: [post] }))[key]?.[0];
  }

  async request(method, path, payload) {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    if (body && Buffer.byteLength(body) > MAX_BYTES) throw new Error("Ghost request too large");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let response;
    try {
      response = await this.fetch(`${this.origin}${path}`, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: { Accept: "application/json", Authorization: `Ghost ${token(this.apiKey)}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body,
      });
    } catch {
      throw new Error("Ghost Admin transport failed");
    } finally { clearTimeout(timer); }
    if (response.url && new URL(response.url).origin !== this.origin) throw new Error("Unexpected Ghost response origin");
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) throw new Error("Invalid Ghost response content type");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) throw new Error("Ghost response too large");
    let data;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("Invalid Ghost response JSON"); }
    if (!response.ok) {
      const error = new Error("Ghost Admin rejected the request");
      error.status = response.status;
      throw error;
    }
    return data;
  }
}

export { token as ghostAdminToken };
