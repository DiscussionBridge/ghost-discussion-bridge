import { createHmac, timingSafeEqual } from "node:crypto";
import { PRODUCT_VERSION } from "./version.mjs";
import { sourceRetryAvailable } from "./source-refusal.mjs";

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
  return createHmac("sha256", password).update("discussionbridge-ghost-operator-v4").digest("hex");
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

function row(direction, id, item, config) {
  const source = direction === "To Discourse" ? item.canonical_url : item.topic_url;
  const destination = direction === "To Discourse" ? item.topic_url : item.canonical_url;
  const sourceOrigin = direction === "To Discourse" ? config.ghostOrigin : config.serverUrl;
  const destinationOrigin = direction === "To Discourse" ? config.serverUrl : config.ghostOrigin;
  const state = direction === "To Discourse" ? (item.outcome ?? "mapped") : (item.state ?? "unknown");
  const activity = item.synchronized_at ?? item.updated_at ?? "—";
  return `<tr><td>${escape(direction)}</td><td><code>${escape(id)}</code></td><td>${linked(source, sourceOrigin)}</td><td>${linked(destination, destinationOrigin)}</td><td><span class="state state--${state === "complete" || state === "created" || state === "resolved" ? "healthy" : "attention"}">${escape(state)}</span></td><td>${escape(activity)}</td></tr>`;
}

function sourceAttention(state, config, csrf) {
  const rows = Object.entries(state.posts ?? {}).filter(([, item]) => item.outcome === "attention" || item.outcome === "reconciliation_required");
  return rows.length ? `<section class="panel attention"><h2>Source delivery needs attention</h2><ul>${rows.map(([id, item]) => `<li><code>${escape(id)}</code>: ${escape(item.failure_reason ?? "Source reconciliation is required.")}${sourceRetryAvailable(id, item, config) ? `<p>Correct the cause before retrying this refused request.</p><form method="post" action="/discussionbridge/operator/retry-source"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="native_id" value="${escape(id.slice(11))}"><input type="hidden" name="refused_mutation_id" value="${escape(item.cms_source.intent.body.mutation_id)}"><button type="submit">Retry this source</button></form>` : ""}</li>`).join("")}</ul></section>` : "";
}

function sourceStopActions(state, csrf) {
  const sources = Object.entries(state.posts ?? {}).filter(([key, item]) => /^ghost-post:[a-f0-9]{24}$/u.test(key) && item.cms_source?.accepted_revision);
  if (!sources.length) return "";
  return `<section class="panel"><h2>Stop source delivery</h2><p>Withdraw one accepted source binding. Its forum discussion, native publication and privacy remain separate responsibilities. A pending request is retried with its recorded reason and revision.</p><ul>${sources.map(([key, item]) => `<li><code>${escape(key)}</code>: ${escape(item.cms_source.withdrawal?.state ?? "delivering")}<form method="post" action="/discussionbridge/operator/stop-source"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="native_id" value="${key.slice(11)}"><button type="submit">Stop delivery for this source</button></form></li>`).join("")}</ul></section>`;
}

function sourceMoveActions(state, csrf) {
  const sources = Object.entries(state.posts ?? {}).filter(([key, item]) => /^ghost-post:[a-f0-9]{24}$/u.test(key) && item.cms_source?.accepted_revision && !item.cms_source.withdrawal);
  if (!sources.length) return "";
  return `<section class="panel"><h2>Source URL reservation</h2><p>Keep the article and its discussion identity while preparing a source URL correction. Supported native source verification is still required before the receiver URL can change.</p><ul>${sources.map(([key, item]) => `<li><code>${escape(key)}</code>: ${escape(item.cms_source.source_url_move?.state ?? "none")} · Revision <code>${escape(item.cms_source.accepted_revision)}</code>${item.cms_source.source_url_move?.failure_reason ? ` · ${escape(item.cms_source.source_url_move.failure_reason)}` : ""}</li>`).join("")}</ul><form method="post" action="/discussionbridge/operator/source-url-move"><input type="hidden" name="csrf" value="${csrf}"><p><label>Ghost post ID <input name="native_id" pattern="[a-f0-9]{24}" required></label></p><p><label>Expected source revision <input name="expected_source_revision" required></label></p><p><label>New canonical source URL <input name="new_url" type="url" required></label></p><button type="submit">Prepare source URL reservation</button></form></section>`;
}

export function renderOperatorPage(config, state, notice = "") {
  const posts = Object.entries(state.posts ?? {});
  const publications = Object.entries(state.publications ?? {});
  const sync = state.publication_sync;
  const summary = sync?.summary ?? { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, errors: [] };
  const attentionRecords = new Set(publications.filter(([, publication]) => publication?.state === "attention" || publication?.state === "pending").map(([id]) => `resource:${id}`));
  for (const [id, item] of posts) if (item?.outcome === "attention" || item?.outcome === "reconciliation_required") {
    // Only the explicit Bridge record identity joins the two direction views;
    // unrelated native keys and repeated error messages do not identify records.
    attentionRecords.add(typeof item.resource_id === "string" && item.resource_id ? `resource:${item.resource_id}` : `source:${id}`);
  }
  const operationAttention = Array.isArray(summary.errors) && summary.errors.some((error) => !error?.resource_id) ? 1 : 0;
  const attention = attentionRecords.size + operationAttention;
  const rows = [
    ...posts.map(([id, item]) => row("To Discourse", id, item, config)),
    ...publications.map(([id, item]) => row("From Discourse", id, item, config)),
  ].join("") || '<tr><td colspan="6">No mapped publications yet.</td></tr>';
  const failures = Array.isArray(summary.errors) && summary.errors.length
    ? `<section class="panel attention"><h2>Needs attention</h2><ul>${summary.errors.map((error) => `<li>${error.resource_id ? `<code>${escape(error.resource_id)}</code>: ` : ""}${escape(error.reason)}</li>`).join("")}</ul></section>` : "";
  const syncState = sync?.state ?? "not run";
  const csrf = operatorCsrfToken(config.operatorPassword);
  const moveRows = publications.filter(([, item]) => item.cms?.mapping_id && item.ghost_post_id).map(([id, item]) => `<li><code>${escape(id)}</code>: ${escape(item.cms.url_move_request?.state ?? "none")} ${item.cms.url_move_request ? `→ ${escape(item.cms.url_move_request.new_url)}` : ""} · Mapping <code>${escape(item.cms.mapping_id)}</code> · Revision <code>${escape(item.cms.mapping_revision ?? "unknown")}</code></li>`).join("");
  const moves = moveRows ? `<section class="panel"><h2>Presentation URL move</h2><p>Requests wait for authorized receiver publication work. A queued request does not create work or move native content.</p><ul>${moveRows}</ul><form method="post" action="/discussionbridge/operator/url-move"><input type="hidden" name="csrf" value="${csrf}"><p><label>Mapping ID <input name="mapping_id" required></label></p><p><label>Expected mapping revision <input name="expected_mapping_revision" required></label></p><p><label>New canonical Ghost URL <input name="new_url" type="url" required></label></p><button type="submit">Queue presentation URL move</button></form></section>` : "";
  const catalogs = `<section class="panel"><h2>Native authors and tags</h2><p>Refresh the choices available from this Ghost site. Publication settings and current assignments stay unchanged.</p><ul>${["authors", "taxonomy"].map((kind) => { const job = state.cms_catalog_refresh?.[kind]; return `<li>${kind === "authors" ? "Authors" : "Tags"}: ${escape(job?.state ?? "not refreshed")}${job?.last_completed ? ` · ${escape(job.last_completed.total_items)} entries · ${escape(job.last_completed.completed_at)}` : ""}</li>`; }).join("")}</ul><form method="post" action="/discussionbridge/operator/catalog-refresh"><input type="hidden" name="csrf" value="${csrf}"><button name="kind" value="authors" type="submit">Refresh authors</button> <button name="kind" value="taxonomy" type="submit">Refresh tags</button></form></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DiscussionBridge for Ghost</title><style>
  :root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;background:#f5f7fb;color:#172033}.wrap{max-width:1200px;margin:auto;padding:32px 20px}h1{margin-bottom:4px}.lede{color:#526079;margin-top:0}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:24px 0}.metric,.panel{background:white;border:1px solid #dce2ec;border-radius:10px;padding:18px;box-shadow:0 2px 8px #1720330d}.metric strong{display:block;font-size:1.75rem}.metric span{color:#526079}.panel{margin:18px 0}.notice{border-left:4px solid #238636}.attention{border-left:4px solid #cf222e}.actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}button{background:#3157d5;color:white;border:0;border-radius:7px;padding:10px 16px;font:inherit;font-weight:700;cursor:pointer}table{width:100%;border-collapse:collapse;font-size:.92rem}th,td{text-align:left;padding:10px;border-bottom:1px solid #e5e9f0;vertical-align:top}code{overflow-wrap:anywhere}.table-wrap{overflow-x:auto}.state{font-weight:700}.state--healthy{color:#167444}.state--attention{color:#a40e26}a{color:#3157d5}@media(prefers-color-scheme:dark){body{background:#10141d;color:#e8edf7}.metric,.panel{background:#181f2c;border-color:#30394a}.lede,.metric span{color:#aeb9cc}th,td{border-color:#30394a}a{color:#8dacff}}
  </style></head><body><main class="wrap"><h1>DiscussionBridge for Ghost</h1><p class="lede">${escape(config.ghostOrigin)} · ${escape(PRODUCT_VERSION)}</p>${notice ? `<section class="panel notice">${escape(notice)}</section>` : ""}<div class="metrics">${metric("Ghost → Discourse mappings", posts.length)}${metric("Discourse → Ghost publications", publications.length)}${metric("Records needing attention", attention)}${metric("Last synchronization", syncState)}</div><section class="panel"><div class="actions"><div><h2>Publication synchronization</h2><p>${sync?.completed_at ? `Last completed ${escape(sync.completed_at)}.` : "No synchronization has been recorded."}</p></div><form method="post" action="/discussionbridge/operator/synchronize"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Synchronize publications</button></form></div><p>Created ${escape(summary.created ?? 0)} · Updated ${escape(summary.updated ?? 0)} · Already current ${escape(summary.unchanged ?? 0)} · Skipped ${escape(summary.skipped ?? 0)} · Failed ${escape(summary.failed ?? 0)}</p></section>${failures}${moves}${catalogs}${sourceAttention(state, config, csrf)}${sourceStopActions(state, csrf)}${sourceMoveActions(state, csrf)}<section class="panel"><h2>Mapped content</h2><div class="table-wrap"><table><thead><tr><th>Direction</th><th>Identity</th><th>Source</th><th>Destination</th><th>State</th><th>Last activity</th></tr></thead><tbody>${rows}</tbody></table></div></section></main></body></html>`;
}
