import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { adapterPublicBase } from "./deployment.mjs";

// Only packaged files are exposed. Snapshot once per process so an upgrade
// cannot change the bytes underneath the URLs advertised by a running service.
const MEMBERS = [
  ["loader.js", "discussionbridge-loader.js", "application/javascript; charset=utf-8"],
  ["loader.css", "discussionbridge-loader.css", "text/css; charset=utf-8"],
  ["rich-content.js", "discussionbridge-rich-content.js", "application/javascript; charset=utf-8"],
];
let catalog;

function browserAssets() {
  if (catalog) return catalog;
  const digest = createHash("sha256");
  const entries = new Map();
  for (const [name, filename, contentType] of MEMBERS) {
    const bytes = readFileSync(new URL(`../public/${filename}`, import.meta.url));
    const hash = createHash("sha256").update(bytes).digest("hex");
    digest.update(`${name}:${hash}\n`);
    entries.set(`/assets/${name}`, { bytes, contentType, etag: `"${hash}"` });
  }
  catalog = { version: digest.digest("hex"), entries };
  return catalog;
}

export function browserLoaderUrl(config) {
  return `${adapterPublicBase(config.adapterOrigin)}assets/loader.js?v=${browserAssets().version}`;
}

export function serveBrowserAsset(request, response, url) {
  const assets = browserAssets();
  const asset = assets.entries.get(url.pathname);
  if (!asset || (url.searchParams.has("v") && url.searchParams.get("v") !== assets.version)) return false;
  const headers = {
    "Content-Type": asset.contentType,
    "Cache-Control": url.searchParams.get("v") === assets.version ? "public, max-age=31536000, immutable" : "no-cache",
    "ETag": asset.etag,
    "X-Content-Type-Options": "nosniff",
  };
  if (request.headers["if-none-match"] === asset.etag) {
    response.writeHead(304, headers);
    response.end();
  } else {
    response.writeHead(200, { ...headers, "Content-Length": asset.bytes.length });
    response.end(request.method === "HEAD" ? undefined : asset.bytes);
  }
  return true;
}
