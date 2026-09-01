import { createHmac } from "node:crypto";

const MAX_BYTES = 256 * 1024;

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

  async create(post) {
    return (await this.request("POST", "/ghost/api/admin/posts/?source=html", { posts: [post] })).posts?.[0];
  }

  async get(id) {
    if (!/^[a-f0-9]{24}$/iu.test(id)) throw new Error("Invalid Ghost post ID");
    return (await this.request("GET", `/ghost/api/admin/posts/${id}/?formats=html`)).posts?.[0];
  }

  async update(id, post) {
    if (!/^[a-f0-9]{24}$/iu.test(id)) throw new Error("Invalid Ghost post ID");
    return (await this.request("PUT", `/ghost/api/admin/posts/${id}/?source=html`, { posts: [post] })).posts?.[0];
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
    if (!response.ok) throw new Error("Ghost Admin rejected the request");
    return data;
  }
}

export { token as ghostAdminToken };
