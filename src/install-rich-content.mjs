import { loadConfig } from "./config.mjs";
import { GhostAdminClient } from "./ghost-admin-client.mjs";
import { pathToFileURL } from "node:url";

const SCRIPT = '<script src="/discussionbridge/assets/loader.js?v=0.1.0-alpha.21.2" defer></script>';

export function mergeCodeInjection(value) {
  if (value !== null && value !== undefined && typeof value !== "string") throw new Error("Invalid Ghost code injection setting");
  const current = (value ?? "").trim();
  return current.includes(SCRIPT) ? current : [current, SCRIPT].filter(Boolean).join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = new GhostAdminClient(loadConfig());
  const payload = await client.request("GET", "/ghost/api/admin/settings/");
  const settings = Array.isArray(payload?.settings) ? payload.settings : [];
  const setting = settings.find((item) => item?.key === "codeinjection_foot");
  const next = mergeCodeInjection(setting?.value);
  if (next === (setting?.value ?? "").trim()) {
    process.stdout.write('{"updated":false}\n');
  } else {
    await client.request("PUT", "/ghost/api/admin/settings/", { settings: [{ key: "codeinjection_foot", value: next }] });
    process.stdout.write('{"updated":true}\n');
  }
}
