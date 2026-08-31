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
  constructor(config, fetchImplementation = fetch) {
    this.config = config;
    this.fetch = fetchImplementation;
  }

  async resolve(record) {
    return this.request("POST", "/discussion-bridge/v1/bridge-records/resolve.json", { bridge_record: record });
  }

  async record(resourceId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(resourceId)) {
      throw new Error("Invalid resource ID");
    }
    return this.request("GET", `/discussion-bridge/v1/bridge-records/${encodeURIComponent(resourceId)}.json`);
  }

  async request(method, path, payload) {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    if (body && Buffer.byteLength(body) > MAX_BYTES) throw new Error("Request too large");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let response;
    try {
      response = await this.fetch(`${this.config.serverUrl}${path}`, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          "X-DiscussionBridge-Connection": this.config.connectionId,
          "X-DiscussionBridge-Secret": this.config.connectionSecret,
        },
        body,
      });
    } catch {
      throw new Error("DiscussionBridge transport failed");
    } finally {
      clearTimeout(timer);
    }
    if (response.url && new URL(response.url).origin !== this.config.serverUrl) throw new Error("Unexpected response origin");
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) throw new Error("Invalid response content type");
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error("Response too large");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) throw new Error("Response too large");
    let data;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("Invalid response JSON"); }
    if (!response.ok) {
      const reason = typeof data?.reason === "string" ? data.reason : "request_failed";
      const error = new Error("DiscussionBridge rejected the request");
      error.reason = reason;
      error.status = response.status;
      throw error;
    }
    return data;
  }
}

export function ghostRecord(payload, config, correlationId) {
  const current = payload?.post?.current;
  if (!current || typeof current !== "object") throw new Error("Invalid Ghost webhook");
  const id = boundedString(current.id, 255, "Ghost post ID");
  const title = boundedString(current.title, 1024, "title");
  const contentHtml = boundedString(current.html, MAX_CONTENT_HTML_BYTES, "published content");
  const url = new URL(boundedString(current.url, 2048, "canonical URL"));
  if (url.origin !== config.ghostOrigin || !url.pathname.startsWith("/")) throw new Error("Canonical URL is outside Ghost origin");
  if (current.status !== "published") throw new Error("Ghost post is not published");
  const tags = Array.isArray(current.tags) ? current.tags : [];
  const optedIn = tags.some((tag) => tag && typeof tag === "object" && (tag.name === "#discussionbridge" || tag.slug === "hash-discussionbridge"));
  if (!optedIn) throw new Error("Ghost post is not opted in");
  const authorship = sourceAuthorship(current, config.ghostOrigin);
  return {
    direction: "to_discourse",
    external_id: `ghost-post:${id}`,
    canonical_url: url.href,
    title,
    content_html: contentHtml,
    published: true,
    visibility: "unlisted",
    adapter_id: "ghost-discussion-bridge",
    adapter_version: "0.1.0-alpha.12",
    correlation_id: correlationId,
    ...authorship,
    ...(config.lane ? { lane: config.lane } : {}),
  };
}
