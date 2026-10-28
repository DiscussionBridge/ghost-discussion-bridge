import { createHash, randomUUID } from "node:crypto";
import { CmsClient } from "../lib/cms-client.mjs";
import { validateCms } from "../lib/cms-runtime.mjs";
import { cmsMutation } from "./cms-coordinator.mjs";

const check = (condition, message) => { if (!condition) throw new Error(message); };
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Compute the final compact request bytes, including escaping and envelope.
// A prepared accepted page is never regenerated with different entry contents.
export function ghostCatalogPages(entries) {
  const pages = []; let items = [];
  const size = (list, page) => Buffer.byteLength(JSON.stringify({ mutation_id: "00000000-0000-4000-8000-000000000000", page, items: list }));
  for (const entry of entries) {
    validateCms("CatalogEntry", entry);
    if (items.length === 100 || size([...items, entry], pages.length) > 65_536) {
      check(items.length > 0, "Ghost native catalog entry exceeds its wire representation");
      pages.push(items); items = [];
    }
    check(size([...items, entry], pages.length) <= 65_536, "Ghost native catalog entry exceeds its wire representation");
    items.push(structuredClone(entry));
  }
  if (items.length) pages.push(items);
  return pages;
}

function nativeRows(kind, items) {
  const seen = new Set();
  return items.map((item) => {
    check(/^[a-f0-9]{24}$/u.test(item?.id ?? "") && typeof item.name === "string" && !seen.has(item.id), "Ghost native catalog identity/label is unavailable");
    check(kind === "authors" ? item.status === undefined || typeof item.status === "string" : item.slug === undefined || typeof item.slug === "string", "Ghost native catalog fields are invalid");
    seen.add(item.id);
    return kind === "authors" ? { id: item.id, name: item.name, ...(item.status === undefined ? {} : { status: item.status }) } : { id: item.id, name: item.name, ...(item.slug === undefined ? {} : { slug: item.slug }) };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export async function ghostCatalogSnapshot(ghost, kind, beforeRead = async () => {}) {
  validateCms("CatalogKind", kind);
  await beforeRead(); const first = nativeRows(kind, await ghost.catalog(kind));
  await beforeRead(); const second = nativeRows(kind, await ghost.catalog(kind));
  check(fingerprint(first) === fingerprint(second), "Ghost native catalog changed during complete census");
  // Presence is descriptive availability. Staff login status is not silently
  // reinterpreted as authorship eligibility; native write/readback still checks
  // selected IDs. Absent objects disappear from the next complete snapshot.
  const entries = second.map((item) => ({ id: item.id, label: item.name, available: true }));
  for (const entry of entries) validateCms("CatalogEntry", entry);
  return { entries, native_revision: `ghost-catalog-sha256:${fingerprint({ kind, entries })}` };
}

export async function refreshGhostCatalog(config, store, ghost, kind, { cmsClient } = {}) {
  validateCms("CatalogKind", kind);
  check(typeof store.withNativeLock === "function", "Ghost catalog refresh requires the current V4 native integration");
  const client = cmsClient ?? new CmsClient({ serviceOrigin: config.serverUrl, connectionId: config.connectionId, connectionSecret: config.connectionSecret });
  return store.withNativeLock(async (assertNative) => {
    const connection = await client.connection(); validateCms("Connection", connection);
    check(connection.connection_id === config.connectionId && connection.profile === "ghost" && connection.destination_origin === config.ghostOrigin && connection.directions.includes("from_discourse") && (!config.lane || config.lane === connection.publication_lane), "Ghost catalog connection does not match configured native scope");
    const binding = { connection_id: config.connectionId, forum_origin: config.serverUrl, native_origin: config.ghostOrigin, scope_revision: connection.scope_revision, publication_lane: connection.publication_lane };
    const guard = async () => {
      await assertNative(); const current = await client.connection(); validateCms("Connection", current);
      check(current.connection_id === binding.connection_id && current.profile === "ghost" && current.destination_origin === binding.native_origin && current.scope_revision === binding.scope_revision && current.publication_lane === binding.publication_lane && current.directions.includes("from_discourse"), "Ghost catalog scope changed during refresh");
    };
    let job = (await store.read()).cms_catalog_refresh?.[kind];
    if (!job || job.state === "complete" || job.restart_expired_upload) {
      const snapshot = await ghostCatalogSnapshot(ghost, kind, guard), pages = ghostCatalogPages(snapshot.entries);
      const next = { job_id: randomUUID(), binding, kind, native_revision: snapshot.native_revision, total_items: snapshot.entries.length, pages, state: "pending", started_at: new Date().toISOString(), ...(job?.last_completed ? { last_completed: job.last_completed } : {}) };
      await guard();
      await store.update(async (state) => { state.cms_catalog_refresh ??= {}; state.cms_catalog_refresh[kind] = next; });
      job = next;
    }
    check(fingerprint(job.binding) === fingerprint(binding) && job.kind === kind, "Ghost pending catalog upload requires explicit scope reconciliation");
    try {
      await guard();
      const prefix = `catalog:${job.job_id}`;
      const upload = await cmsMutation(store, client, `${prefix}:begin`, "V4-24", () => ({ mutation_id: randomUUID(), kind, native_revision: job.native_revision, total_items: job.total_items }));
      validateCms("CatalogUpload", upload);
      check(upload.kind === kind && upload.native_revision === job.native_revision && upload.total_items === job.total_items && upload.received_items === 0 && upload.next_page === 0, "Ghost catalog begin changed declared snapshot");
      let received = 0;
      for (let page = 0; page < job.pages.length; page++) {
        await guard();
        const accepted = await cmsMutation(store, client, `${prefix}:page:${page}`, "V4-25", () => ({ mutation_id: randomUUID(), page, items: job.pages[page] }), { upload_id: upload.upload_id });
        received += job.pages[page].length;
        validateCms("CatalogUpload", accepted);
        check(accepted.upload_id === upload.upload_id && accepted.kind === kind && accepted.native_revision === job.native_revision && accepted.total_items === job.total_items && accepted.received_items === received && accepted.next_page === page + 1, "Ghost catalog accepted a different page/snapshot");
      }
      check(received === job.total_items, "Ghost native catalog snapshot is incomplete");
      await guard();
      const result = await cmsMutation(store, client, `${prefix}:finalize`, "V4-26", () => ({ mutation_id: randomUUID(), upload_id: upload.upload_id, expected_total_items: job.total_items }), { upload_id: upload.upload_id });
      validateCms("CatalogResponse", result);
      const expected = new Map(job.pages.flat().map((item) => [item.id, item])), seen = new Set(), cursors = new Set();
      let response = result;
      for (;;) {
        validateCms("CatalogResponse", response);
        check(response.kind === kind && response.catalog_revision === result.catalog_revision && response.native_revision === job.native_revision && response.total_items === job.total_items, "Ghost catalog read changed the activated snapshot");
        for (const item of response.items) {
          const entry = expected.get(item.id);
          check(entry && !seen.has(item.id) && entry.label === item.label && entry.available === item.available, "Ghost catalog activation differs from exact native entries"); seen.add(item.id);
        }
        if (response.next_cursor === null) { check(seen.size === job.total_items, "Ghost activated catalog snapshot is incomplete"); break; }
        check(response.items.length > 0 && seen.size < job.total_items && !cursors.has(response.next_cursor), "Ghost catalog continuation did not advance");
        cursors.add(response.next_cursor); await guard();
        response = await client.catalog({ kind, cursor: response.next_cursor });
      }
      await guard();
      const completed = { kind, native_revision: job.native_revision, catalog_revision: result.catalog_revision, total_items: job.total_items, completed_at: new Date().toISOString() };
      await store.update(async (state) => {
        const current = state.cms_catalog_refresh[kind]; check(current.job_id === job.job_id, "Ghost catalog upload ownership changed");
        current.state = "complete"; current.last_completed = completed;
      });
      return completed;
    } catch (error) {
      await store.update(async (state) => {
        const current = state.cms_catalog_refresh[kind];
        // The client conservatively marks POST failures uncertain. A fully
        // validated frozen410/expired rejection is a known rejected upload,
        // distinct from transport/invalid-response uncertainty.
        if (current?.job_id === job.job_id) { current.state = "attention"; current.restart_expired_upload = error.code === "catalog_upload_expired" && error.status === 410 && error.retryable === false; }
      });
      throw error;
    }
  });
}
