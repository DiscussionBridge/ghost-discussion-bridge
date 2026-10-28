import { createHash } from "node:crypto";
const MAX_SOURCE_AUTHORS = 20;
function boundedString(value, maximum, label) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum) throw new Error('Invalid ' + label);
  return value;
}

export function sourceAuthorship(current, ghostOrigin) {
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

function captureGhostArticle(current, config) {
  if (!current || typeof current !== "object") throw new Error("Invalid Ghost webhook");
  const id = boundedString(current.id, 244, "Ghost post ID");
  // Content format is not source eligibility. Missing/unrepresentable native
  // article data is a Bridge preparation limitation, not invalid source text.
  if (typeof current.html !== "string" || Buffer.from(current.html, "utf8").toString("utf8") !== current.html) throw new Error("Ghost Bridge cannot capture the native article representation exactly; preparation attention is required");
  const url = new URL(boundedString(current.url, 2048, "canonical URL"));
  if (url.origin !== config.ghostOrigin || !url.pathname.startsWith("/")) throw new Error("Canonical URL is outside Ghost origin");
  if (current.lexical !== undefined && current.lexical !== null && (typeof current.lexical !== "string" || Buffer.from(current.lexical).toString("utf8") !== current.lexical)) throw new Error("Ghost Bridge cannot capture native Lexical/card context exactly; source remains intact");
  const context = Object.freeze({ visibility: current.visibility ?? null, codeinjection_head: current.codeinjection_head ?? null, codeinjection_foot: current.codeinjection_foot ?? null });
  return Object.freeze({ native_id: id, article_url: url.href, html: current.html, lexical: current.lexical ?? null, context });
}

export function publishedGhostSource(current, config) {
  const capture = captureGhostArticle(current, config), id = capture.native_id, url = new URL(capture.article_url);
  const title = boundedString(current.title, 1024, "title");
  const fullContentHtml = capture.html;
  if (current.status !== "published") throw new Error("Ghost post is not published");
  const tags = Array.isArray(current.tags) ? current.tags : [];
  const optedIn = tags.some((tag) => tag && typeof tag === "object" && (tag.name === "#discussionbridge" || tag.slug === "hash-discussionbridge"));
  if (!optedIn) throw new Error("Ghost post is not opted in");
  if (tags.some((tag) => tag?.name === "#discussionbridge-source" || tag?.slug === "hash-discussionbridge-source")) throw new Error("A received source-owned publication cannot be republished as a Ghost original");
  const authorship = sourceAuthorship(current, config.ghostOrigin);
  return { id, title, fullContentHtml, url, authorship, capture };
}

// Native source observation is distinct from the separately prepared complete
// publication digest. Canonical URL/updated time are observed separately so a
// proposed URL-only operation cannot disguise an article/identity change.
export function nativeSourceBaseline(current, source) {
  return { native_id: current.id, native_type: current.type, title: source.title,
    native_content_sha256: createHash("sha256").update(source.fullContentHtml).digest("hex"), native_content_bytes: Buffer.byteLength(source.fullContentHtml),
    authorship: structuredClone(source.authorship), source_created_at: current.created_at ?? null };
}

