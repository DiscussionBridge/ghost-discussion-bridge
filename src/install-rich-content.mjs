import { loadConfig } from "./config.mjs";
import { GhostAdminClient } from "./ghost-admin-client.mjs";
import { PRODUCT_VERSION } from "./version.mjs";
import { pathToFileURL } from "node:url";

const COMMENTS_BOOTSTRAP_PATTERN = /<script data-discussionbridge-comments-bootstrap>[\s\S]*?<\/script>/u;
const COMMENTS_BOOTSTRAP = `<script data-discussionbridge-comments-bootstrap>
(() => {
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
  loader.src = "/discussionbridge/assets/loader.js?v=${PRODUCT_VERSION}";
  loader.defer = true;
  scriptParent.appendChild(loader);
})();
</script>`;

export function mergeCodeInjection(value) {
  if (value !== null && value !== undefined && typeof value !== "string") throw new Error("Invalid Ghost code injection setting");
  const current = (value ?? "").trim();
  return COMMENTS_BOOTSTRAP_PATTERN.test(current)
    ? current.replace(COMMENTS_BOOTSTRAP_PATTERN, COMMENTS_BOOTSTRAP)
    : [current, COMMENTS_BOOTSTRAP].filter(Boolean).join("\n");
}

export async function installRichContent(client) {
  const payload = await client.request("GET", "/ghost/api/admin/settings/");
  const settings = Array.isArray(payload?.settings) ? payload.settings : [];
  const setting = settings.find((item) => item?.key === "codeinjection_foot");
  const next = mergeCodeInjection(setting?.value);
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
      code: COMMENTS_BOOTSTRAP,
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = new GhostAdminClient(loadConfig());
  const result = await installRichContent(client);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.manual_required) process.exitCode = 2;
}
