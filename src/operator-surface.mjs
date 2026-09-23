import { createHmac, timingSafeEqual } from "node:crypto";
import { PRODUCT_VERSION } from "./version.mjs";

function escape(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function equal(left, right) {
  const first = Buffer.from(String(left));
  const second = Buffer.from(String(right));
  return first.length === second.length && timingSafeEqual(first, second);
}

export function operatorAuthorized(header, password) {
  if (typeof password !== "string" || !password || typeof header !== "string" || header.length > 2048 || !header.startsWith("Basic ")) return false;
  let decoded;
  try { decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); } catch { return false; }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return equal(decoded.slice(0, separator), "discussionbridge") && equal(decoded.slice(separator + 1), password);
}

export function operatorCsrfToken(password) {
  return createHmac("sha256", password).update("discussionbridge-ghost-operator-synchronize-v1").digest("hex");
}

export function operatorCsrfValid(token, password) {
  return typeof token === "string" && /^[a-f0-9]{64}$/u.test(token) && equal(token, operatorCsrfToken(password));
}

function safeLink(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function metric(label, value) {
  return `<div class="metric"><strong>${escape(value)}</strong><span>${escape(label)}</span></div>`;
}

function linked(value, origin, label = value) {
  const href = safeLink(value, origin);
  return href ? `<a href="${escape(href)}" rel="noopener noreferrer">${escape(label)}</a>` : escape(label || "—");
}

function operatorState(direction, state) {
  const labels = direction === "To Discourse"
    ? { created: "Discourse topic created", resolved: "Existing Discourse topic found" }
    : { complete: "Ghost post created", created: "Ghost post created", resolved: "Existing Ghost post resolved", healthy: "Current", held: "Unpublished" };
  return labels[state] ?? state;
}

function row(direction, id, item, config) {
  const source = direction === "To Discourse" ? item.canonical_url : item.topic_url;
  const destination = direction === "To Discourse" ? item.topic_url : item.canonical_url;
  const sourceOrigin = direction === "To Discourse" ? config.ghostOrigin : config.serverUrl;
  const destinationOrigin = direction === "To Discourse" ? config.serverUrl : config.ghostOrigin;
  const state = direction === "To Discourse" ? (item.outcome ?? "mapped") : (item.state ?? "unknown");
  const stateLabel = operatorState(direction, state);
  const activity = item.synchronized_at ?? item.updated_at ?? "—";
  return `<tr><td>${escape(direction)}</td><td><code>${escape(id)}</code></td><td>${linked(source, sourceOrigin)}</td><td>${linked(destination, destinationOrigin)}</td><td><span class="state state--${["complete", "created", "resolved", "healthy"].includes(state) ? "healthy" : "attention"}">${escape(stateLabel)}</span></td><td>${escape(activity)}</td></tr>`;
}

export function renderOperatorPage(config, state, notice = "") {
  const posts = Object.entries(state.posts ?? {});
  const publications = Object.entries(state.publications ?? {});
  const sync = state.publication_sync;
  const summary = sync?.summary ?? { created: 0, updated: 0, unchanged: 0, held: 0, unpublished: 0, failed: 0, errors: [] };
  const forumPublications = Object.values(state.forum_publications ?? {});
  const publicationAttention = publications.filter(([, publication]) => publication?.state === "attention" || publication?.state === "pending").length +
    forumPublications.filter((publication) => publication?.state === "attention" || publication?.state === "pending" || publication?.state === "held").length;
  const operationAttention = Array.isArray(summary.errors) && summary.errors.some((error) => !error?.resource_id) ? 1 : 0;
  const attention = publicationAttention + operationAttention;
  const rows = [
    ...posts.map(([id, item]) => row("To Discourse", id, item, config)),
    ...publications.map(([id, item]) => row("From Discourse", id, item, config)),
    ...forumPublications.map((item) => row("From Discourse", item.resource_id ?? `topic:${item.topic_id}`, item, config)),
  ].join("") || '<tr><td colspan="6">No mapped publications yet.</td></tr>';
  const failures = Array.isArray(summary.errors) && summary.errors.length
    ? `<section class="panel attention"><h2>Needs attention</h2><ul>${summary.errors.map((error) => `<li>${error.resource_id ? `<code>${escape(error.resource_id)}</code>: ` : error.topic_id ? `<code>topic:${escape(error.topic_id)}</code>: ` : ""}${escape(error.reason)}</li>`).join("")}</ul></section>` : "";
  const syncState = sync?.state ?? "not run";
  const csrf = operatorCsrfToken(config.operatorPassword);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DiscussionBridge for Ghost</title><style>
  :root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;background:#f5f7fb;color:#172033}.wrap{max-width:1200px;margin:auto;padding:32px 20px}h1{margin-bottom:4px}.lede{color:#526079;margin-top:0}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:24px 0}.metric,.panel{background:white;border:1px solid #dce2ec;border-radius:10px;padding:18px;box-shadow:0 2px 8px #1720330d}.metric strong{display:block;font-size:1.75rem}.metric span{color:#526079}.panel{margin:18px 0}.notice{border-left:4px solid #238636}.attention{border-left:4px solid #cf222e}.actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}button{background:#3157d5;color:white;border:0;border-radius:7px;padding:10px 16px;font:inherit;font-weight:700;cursor:pointer}table{width:100%;border-collapse:collapse;font-size:.92rem}th,td{text-align:left;padding:10px;border-bottom:1px solid #e5e9f0;vertical-align:top}code{overflow-wrap:anywhere}.table-wrap{overflow-x:auto}.state{font-weight:700}.state--healthy{color:#167444}.state--attention{color:#a40e26}a{color:#3157d5}@media(prefers-color-scheme:dark){body{background:#10141d;color:#e8edf7}.metric,.panel{background:#181f2c;border-color:#30394a}.lede,.metric span{color:#aeb9cc}th,td{border-color:#30394a}a{color:#8dacff}}
  </style></head><body><main class="wrap"><h1>DiscussionBridge for Ghost</h1><p class="lede">${escape(config.ghostOrigin)} · ${escape(PRODUCT_VERSION)}</p>${notice ? `<section class="panel notice">${escape(notice)}</section>` : ""}<div class="metrics">${metric("Ghost → Discourse mappings", posts.length)}${metric("Discourse → Ghost publications", publications.length + forumPublications.length)}${metric("Records needing attention", attention)}${metric("Last synchronization", syncState)}</div><section class="panel"><div class="actions"><div><h2>Forum publication synchronization</h2><p>${sync?.completed_at ? `Last completed ${escape(sync.completed_at)}.` : "No synchronization has been recorded."}</p></div><form method="post" action="/discussionbridge/operator/synchronize"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Synchronize eligible forum topics</button></form></div><p>Created ${escape(summary.created ?? 0)} · Updated ${escape(summary.updated ?? 0)} · Already current ${escape(summary.unchanged ?? 0)} · Held ${escape(summary.held ?? 0)} · Unpublished ${escape(summary.unpublished ?? 0)} · Failed ${escape(summary.failed ?? 0)}</p></section>${failures}<section class="panel"><h2>Mapped content</h2><div class="table-wrap"><table><thead><tr><th>Direction</th><th>Identity</th><th>Source</th><th>Destination</th><th>State</th><th>Last activity</th></tr></thead><tbody>${rows}</tbody></table></div></section></main></body></html>`;
}
