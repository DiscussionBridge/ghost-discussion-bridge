import { createHmac } from "node:crypto";
import { boundedResponse } from "./bounded-response.mjs";
import { ghostOwnedFragment } from "./native-owned-fragment.mjs";

const MAX_BYTES = 256 * 1024;
const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function ownedHtmlPayload(post, current) {
  if (!post || typeof post.html !== "string" || Object.hasOwn(post, "lexical")) throw new Error("Ghost CMS owned HTML input is unavailable or ambiguous");
  const replacement = ghostOwnedFragment(post.html);
  if (replacement.start !== 0 || replacement.end !== post.html.length) throw new Error("Ghost CMS owned HTML must contain only its publication section");
  let document;
  if (current === undefined) {
    // Native Ghost HtmlNode v1, with the ordinary unrestricted visibility.
    // HTML cards retain the prepared publication without HTML-to-Lexical loss.
    document = { root: { children: [{ type: "html", version: 1, html: post.html, visibility: { web: { nonMember: true, memberSegment: "status:free,status:-free" }, email: { memberSegment: "status:free,status:-free" } } }], direction: null, format: "", indent: 0, type: "root", version: 1 } };
  } else {
    if (typeof current.lexical !== "string" || typeof current.updated_at !== "string" || post.updated_at !== current.updated_at) throw new Error("Ghost CMS current native Lexical/CAS snapshot is unavailable");
    try { document = JSON.parse(current.lexical); } catch { throw new Error("Ghost CMS current native Lexical is invalid"); }
    if (document?.root?.type !== "root" || document.root.version !== 1 || !Array.isArray(document.root.children)) throw new Error("Ghost CMS current native Lexical root is unsupported");
    const rendered = ghostOwnedFragment(current.html), matches = [];
    for (const node of document.root.children) {
      if (node?.type !== "html" || typeof node.html !== "string" || !/\bdata-discussionbridge-owned\s*=/iu.test(node.html)) continue;
      const fragment = ghostOwnedFragment(node.html);
      if (node.version !== 1 || fragment.hash !== rendered.hash) throw new Error("Ghost CMS native owned card differs from its rendered publication");
      matches.push({ node, fragment });
    }
    if (matches.length !== 1) throw new Error("Ghost CMS native Lexical does not have one exact owned HTML card");
    const { node, fragment } = matches[0];
    // Preserve every other native node and card property, as well as any
    // unrelated HTML/comments within this card. Never rewrap rendered HTML:
    // Ghost adds its own kg-card boundary comments on each render.
    node.html = node.html.slice(0, fragment.start) + post.html + node.html.slice(fragment.end);
  }
  const { html: _html, ...metadata } = post;
  return { ...metadata, lexical: JSON.stringify(document) };
}

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

  async createOwnedHtml(post, nativeType = this.publicationType) {
    const key = resourceType(nativeType), payload = ownedHtmlPayload(post);
    return nativeObjects(await this.request("POST", `/ghost/api/admin/${key}/`, { [key]: [payload] }), nativeType, true)[0];
  }

  async get(id, maximumBytes = MAX_BYTES, nativeType = this.publicationType) {
    if (!/^[a-f0-9]{24}$/iu.test(id)) throw new Error("Invalid Ghost post ID");
    const key = resourceType(nativeType);
    return nativeObjects(await this.request("GET", `/ghost/api/admin/${key}/${id}/?formats=html,lexical`, undefined, maximumBytes), nativeType, true)[0];
  }

  async getSource(id, maximumBytes = MAX_BYTES) {
    if (!/^[a-f0-9]{24}$/u.test(id)) throw new Error("Invalid Ghost source post ID");
    return nativeObjects(await this.request("GET", `/ghost/api/admin/posts/${id}/?formats=html,lexical&include=authors,tags`, undefined, maximumBytes, true), "post", true)[0];
  }

  async updateSourcePermalink(id, { slug, codeinjection_head, updated_at }, maximumBytes = MAX_BYTES) {
    if (!/^[a-f0-9]{24}$/u.test(id) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) || slug.length > 191 || typeof codeinjection_head !== "string" || typeof updated_at !== "string") throw new Error("Ghost source native permalink/CAS input is unavailable");
    // No source=html conversion, body/author replacement or From type default.
    return nativeObjects(await this.request("PUT", `/ghost/api/admin/posts/${id}/`, { posts: [{ slug, codeinjection_head, updated_at }] }, maximumBytes, true), "post", true)[0];
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
      const path = `/ghost/api/admin/${key}/?filter=${encodeURIComponent(`tag:${tag}`)}&limit=3&formats=html,lexical&include=authors,tags`;
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

  async updateOwnedHtml(id, post, nativeType = this.publicationType, current) {
    if (!/^[a-f0-9]{24}$/iu.test(id) || current?.id !== id || current.type !== nativeType) throw new Error("Ghost CMS current native identity differs");
    const key = resourceType(nativeType), payload = ownedHtmlPayload(post, current);
    return nativeObjects(await this.request("PUT", `/ghost/api/admin/${key}/${id}/`, { [key]: [payload] }), nativeType, true)[0];
  }

  async findBySlug(slug, maximumBytes = MAX_BYTES, nativeType = this.publicationType) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) || slug.length > 191) throw new Error("Invalid Ghost move slug");
    resourceType(nativeType);
    const objects = [];
    for (const selectedType of [nativeType, nativeType === "post" ? "page" : "post"]) {
      const key = resourceType(selectedType);
      const found = nativeObjects(await this.request("GET", `/ghost/api/admin/${key}/?filter=${encodeURIComponent(`slug:${slug}`)}&limit=2&formats=html&include=tags`, undefined, maximumBytes), selectedType);
      if (found.length > 2 || found.some((item) => item.slug !== slug)) throw new Error("Ghost native move slug lookup differs");
      objects.push(...found);
    }
    return objects;
  }

  async catalog(kind) {
    if (!["authors", "taxonomy"].includes(kind)) throw new Error("Invalid Ghost native catalog kind");
    const key = kind === "authors" ? "users" : "tags", items = [], seen = new Set();
    let page = 1, total;
    for (;;) {
      const data = await this.request("GET", `/ghost/api/admin/${key}/?limit=100&page=${page}&fields=${encodeURIComponent(kind === "authors" ? "id,name,status" : "id,name,slug")}`, undefined, MAX_BYTES, true);
      const pagination = data?.meta?.pagination;
      if (!Array.isArray(data?.[key]) || data[key].length > 100 || pagination?.page !== page || !Number.isSafeInteger(pagination.total) || pagination.total < 0 || (pagination.next !== null && pagination.next !== page + 1) || (total !== undefined && total !== pagination.total)) throw new Error("Ghost native catalog snapshot changed or is unavailable");
      total = pagination.total;
      for (const item of data[key]) {
        if (!/^[a-f0-9]{24}$/u.test(item?.id ?? "") || typeof item.name !== "string" || seen.has(item.id)) throw new Error("Ghost native catalog identity is ambiguous");
        seen.add(item.id); items.push(item);
      }
      if (pagination.next === null) break;
      if (!data[key].length || items.length >= total) throw new Error("Ghost native catalog pagination did not advance");
      page = pagination.next;
    }
    if (items.length !== total) throw new Error("Ghost native catalog snapshot is incomplete");
    return items;
  }

  async request(method, path, payload, maximumBytes = MAX_BYTES, strictUtf8 = false) {
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
    try { data = JSON.parse(new TextDecoder("utf-8", { fatal: strictUtf8 }).decode(bytes)); } catch { throw new Error("Invalid Ghost response JSON"); }
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
