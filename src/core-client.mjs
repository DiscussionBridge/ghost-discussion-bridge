import { boundedResponse } from "./bounded-response.mjs";
import { isTopicIdentity } from "./topic-identity.mjs";

// These are native public Discourse endpoints, independent of Bridge protocol.
export class CoreClient {
  constructor(config, fetchImplementation = fetch, { timeoutMs = 10_000 } = {}) {
    this.config = config;
    this.fetch = fetchImplementation;
    this.timeoutMs = timeoutMs;
  }

  async publicTopic(topicId) {
    if (!isTopicIdentity(topicId)) throw new Error("Invalid topic ID");
    return this.request(`/t/${topicId}.json`);
  }

  async publicTopicPosts(topicId, postIds) {
    if (!isTopicIdentity(topicId) || !Array.isArray(postIds) || postIds.length < 1 || postIds.length > 20 || postIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("Invalid topic post request");
    const query = new URLSearchParams();
    for (const postId of new Set(postIds)) query.append("post_ids[]", String(postId));
    return this.request(`/t/${topicId}/posts.json?${query}`);
  }

  async publicSiteSettings({ strictUtf8 = false } = {}) {
    const { response, bytes } = await boundedResponse(this.fetch, `${this.config.serverUrl}/`, {
      credentials: "omit", redirect: "error",
      headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" },
    }, {
      origin: this.config.serverUrl, mediaType: "text/html", maximumBytes: 512 * 1024, timeoutMs: this.timeoutMs,
      transportError: "Discourse branding transport failed", originError: "Unexpected response origin", mediaError: "Invalid Discourse branding response", limitError: "Response too large",
    });
    if (!response.ok) throw new Error("Invalid Discourse branding response");
    let text;
    try { text = new TextDecoder("utf-8", { fatal: strictUtf8 }).decode(bytes); }
    catch { throw new Error("Invalid Discourse site settings encoding"); }
    const match = /<script[^>]+id=["']data-preloaded["'][^>]*>([\s\S]*?)<\/script>/iu.exec(text);
    if (!match) throw new Error("Discourse branding setting is unavailable");
    try { return JSON.parse(JSON.parse(match[1]).siteSettings); }
    catch { throw new Error("Discourse branding setting is invalid"); }
  }

  async publicPoweredByDiscourse() {
    const settings = await this.publicSiteSettings();
    if (typeof settings?.enable_powered_by_discourse !== "boolean") throw new Error("Discourse branding setting is invalid");
    return settings.enable_powered_by_discourse;
  }

  async publicForumTitle() {
    const title = (await this.publicSiteSettings({ strictUtf8: true }))?.title;
    if (typeof title !== "string" || !title.trim() || Buffer.byteLength(title) > 200 || /\p{Cc}/u.test(title) || Buffer.from(title, "utf8").toString("utf8") !== title) throw new Error("Discourse native forum title is unavailable or invalid; correct the source forum title");
    return title;
  }

  async request(path) {
    const { response, bytes } = await boundedResponse(this.fetch, `${this.config.serverUrl}${path}`, {
      credentials: "omit", method: "GET", redirect: "error", headers: { Accept: "application/json" },
    }, {
      origin: this.config.serverUrl, mediaType: "application/json", maximumBytes: 65_536, timeoutMs: this.timeoutMs,
      transportError: "Discourse public transport failed", originError: "Unexpected response origin", mediaError: "Invalid response content type", limitError: "Response too large",
    });
    let data;
    try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error("Invalid response JSON"); }
    if (!response.ok) {
      const error = new Error("Discourse rejected the public request");
      error.reason = "request_failed"; error.status = response.status;
      throw error;
    }
    return data;
  }
}
