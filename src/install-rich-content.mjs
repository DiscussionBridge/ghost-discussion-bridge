import { loadConfig } from "./config.mjs";
import { GhostAdminClient } from "./ghost-admin-client.mjs";
import { PRODUCT_VERSION } from "./version.mjs";
import { browserLoaderUrl } from "./browser-assets.mjs";
import { pathToFileURL } from "node:url";

const COMMENTS_BOOTSTRAP_PATTERN = /<script data-discussionbridge-comments-bootstrap>[\s\S]*?<\/script>/u;
export function commentsBootstrap(config) {
  const ghostOrigin = new URL(config.ghostOrigin);
  if (ghostOrigin.protocol !== "https:" || ghostOrigin.username || ghostOrigin.password || ghostOrigin.search || ghostOrigin.hash || ghostOrigin.pathname !== "/") throw new Error("Invalid Ghost origin");
  return `<script data-discussionbridge-comments-bootstrap>
(() => {
  if (window.location.origin !== ${JSON.stringify(ghostOrigin.origin)}) return;
  const loaderUrl = ${JSON.stringify(browserLoaderUrl(config))};
  const start = () => {
  if (window.__discussionBridgeGhostLoader === loaderUrl || window.__discussionBridgeGhostLoading === loaderUrl) return;
  const connectedPost = document.body.classList.contains("tag-hash-discussionbridge");
  const sourcePost = document.body.classList.contains("tag-hash-discussionbridge-source");
  if (!connectedPost && !sourcePost) return;
  let scriptParent = document.body;
  if (connectedPost) {
    let host = document.querySelector("[data-discussionbridge-comments-host]");
    if (!host) {
      const article = document.querySelector(".gh-article");
      if (!article) return;
      host = document.createElement("section");
      host.className = "discussionbridge-comments-host gh-canvas";
      host.setAttribute("data-discussionbridge-comments-host", "");
      article.appendChild(host);
    }
    host.replaceChildren();
    const mode = document.body.classList.contains("tag-hash-discussionbridge-simple")
      ? "simple"
      : document.body.classList.contains("tag-hash-discussionbridge-full")
        ? "full"
        : "interactive";
    const target = document.createElement("div");
    target.setAttribute("data-discussionbridge-comments", mode);
    host.appendChild(target);
    scriptParent = host;
  }
  const loader = document.createElement("script");
  loader.src = loaderUrl;
  loader.setAttribute("data-discussionbridge-loader", "${PRODUCT_VERSION}");
  loader.defer = true;
  window.__discussionBridgeGhostLoading = loaderUrl;
  const release = () => { if (window.__discussionBridgeGhostLoading === loaderUrl) delete window.__discussionBridgeGhostLoading; };
  loader.addEventListener("error", release, { once: true });
  loader.addEventListener("load", release, { once: true });
  scriptParent.appendChild(loader);
  };
  // Let already-authored deferred scripts run first. An arbitrary/stale marker
  // is not evidence that the current loader executed successfully.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
</script>`;
}

export function mergeCodeInjection(value, config) {
  if (value !== null && value !== undefined && typeof value !== "string") throw new Error("Invalid Ghost code injection setting");
  const current = (value ?? "").trim();
  const bootstrap = commentsBootstrap(config);
  return COMMENTS_BOOTSTRAP_PATTERN.test(current)
    ? current.replace(COMMENTS_BOOTSTRAP_PATTERN, () => bootstrap)
    : [current, bootstrap].filter(Boolean).join("\n");
}

export async function installRichContent(client, config) {
  const payload = await client.request("GET", "/ghost/api/admin/settings/");
  const settings = Array.isArray(payload?.settings) ? payload.settings : [];
  const setting = settings.find((item) => item?.key === "codeinjection_foot");
  const next = mergeCodeInjection(setting?.value, config);
  if (next === (setting?.value ?? "").trim()) return { updated: false, manual_required: false };
  try {
    await client.request("PUT", "/ghost/api/admin/settings/", { settings: [{ key: "codeinjection_foot", value: next }] });
    return { updated: true, manual_required: false };
  } catch (error) {
    if (error?.status !== 403) throw error;
    return {
      updated: false,
      manual_required: true,
      location: "Ghost Admin → Settings → Advanced → Code injection → Site Footer",
      code: commentsBootstrap(config),
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const client = new GhostAdminClient(config);
  const result = await installRichContent(client, config);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.manual_required) process.exitCode = 2;
}
