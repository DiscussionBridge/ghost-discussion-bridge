const GHOST_ID = /^[a-f0-9]{24}$/iu;
const MAX_TERMS = 5_000;
const MAX_CATALOG_BYTES = 240 * 1024;
export const MAX_FORUM_PUBLICATION_HTML_BYTES = 256 * 1024;

function label(value) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 255 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Invalid Ghost tag label");
  }
  return value.trim();
}

export async function buildPlatformCatalog(ghost) {
  const observed = await ghost.listTags();
  if (observed.length > MAX_TERMS) throw new Error("Ghost tag inventory is too large");
  const terms = observed.flatMap((tag) => {
    if (!tag || !GHOST_ID.test(tag.id ?? "")) throw new Error("Invalid Ghost tag identity");
    const name = label(tag.name);
    if (name.toLowerCase().startsWith("#discussionbridge-")) return [];
    return [{ id: `tag:${tag.id.toLowerCase()}`, label: name, kind: "term" }];
  });
  if (new Set(terms.map(({ id }) => id)).size !== terms.length) throw new Error("Duplicate Ghost tag identity");

  const catalog = {
    schema_version: 1,
    platform: "ghost",
    containers: [
      { id: "post", label: "Post", kind: "content_type", path: "/", taxonomy_ids: ["tag"] },
      { id: "page", label: "Page", kind: "content_type", path: "/", taxonomy_ids: ["tag"] },
    ],
    taxonomies: [{ id: "tag", label: "Tags", kind: "taxonomy", terms }],
    authors: [{ id: "ghost:service", label: "Ghost integration owner", kind: "author" }],
    service_author_id: "ghost:service",
    presentation_modes: ["simple", "full", "fullInteractive", "native"],
    capabilities: { updates: true, unpublish: true, drafts: true },
    limits: { content_bytes: MAX_FORUM_PUBLICATION_HTML_BYTES, title_bytes: 255, slug_bytes: 191 },
    inventory: {
      authors_complete: true,
      terms_complete: true,
      authors_observed: 1,
      terms_observed: terms.length,
    },
  };
  if (Buffer.byteLength(JSON.stringify(catalog)) > MAX_CATALOG_BYTES) throw new Error("Ghost platform catalog is too large");
  return catalog;
}
