import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CmsClient } from "../lib/cms-client.mjs";
import { validateCmsRoute } from "../lib/cms-runtime.mjs";
import { ghostCatalogPages, ghostCatalogSnapshot, refreshGhostCatalog } from "../src/cms-catalog-producer.mjs";
import { GhostAdminClient } from "../src/ghost-admin-client.mjs";
import { StateStore } from "../src/state-store.mjs";

async function fixture(options, callback) {
  const directory = await mkdtemp(join(tmpdir(), "ghost-native-catalog-"));
  const config = { serverUrl: "https://forum.example", ghostOrigin: "https://ghost.example", connectionId: `dbc_${"a".repeat(24)}`, connectionSecret: "SYNTHETIC-CONNECTION-SECRET", ghostAdminApiKey: `${"b".repeat(24)}:${"c".repeat(64)}`, stateFile: join(directory, "state.json") };
  const policy = { policy_revision: "policy-1", enabled: false, selection: "all_public", category_ids: [], include_topic_ids: [], exclude_topic_ids: [], include_unlisted: false, publication_kind: "dynamic", presentation_mode: "full", author_ids: [], taxonomy_ids: [] };
  const connection = { connection_id: config.connectionId, profile: "ghost", destination_origin: config.ghostOrigin, scope_revision: "scope-1", forum_name: "Forum", directions: ["from_discourse"], policy, publication_lane: "default", native_capabilities: { native_revision: "native-1", supported_presentations: ["full"], publication_kind: "dynamic", complete_content_supported: true } };
  const rows = Array.from({ length: options.total ?? 201 }, (_, index) => ({ id: (index + 1).toString(16).padStart(24, "0"), name: `Native "雪" ${index}`, status: index ? "active" : "suspended", slug: `native-${index}` }));
  let lost = options.lost, upload, uploadCount = 0, nativeReads = 0, active = { revision: "previous-catalog", native_revision: "previous-native", items: [{ id: "f".repeat(24), label: "Prior active", available: true }] };
  const calls = [], replay = new Map(), cursors = new Map();
  const page = (kind, snapshot, offset = 0) => { const next = offset + 100 < snapshot.items.length ? `snapshot-${snapshot.revision}-${offset + 100}` : null; if (next) cursors.set(next, { snapshot, offset: offset + 100 }); return { kind, catalog_revision: snapshot.revision, native_revision: snapshot.native_revision, total_items: snapshot.items.length, items: snapshot.items.slice(offset, offset + 100), next_cursor: next }; };
  const reply = (res, value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : null, url = new URL(req.url, "http://localhost"); calls.push({ method: req.method, path: url.pathname, query: url.search, raw, body });
    try {
      if (url.pathname.startsWith("/ghost/api/admin/")) {
        assert.match(req.headers.authorization, /^Ghost /u); assert.equal(req.method, "GET"); assert.equal(req.headers["x-discussionbridge-secret"], undefined);
        const number = Number(url.searchParams.get("page")), start = (number - 1) * 100, key = url.pathname.includes("users") ? "users" : "tags"; nativeReads++;
        if (options.invalidUtf8) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(Buffer.concat([Buffer.from(`{"${key}":[{"id":"${"a".repeat(24)}","name":"`), Buffer.from([0xc0, 0x80]), Buffer.from('"}]}')])); return; }
        if (options.changedPage && number === 2) { options.changedPage = false; rows[0].name = "Changed during census"; }
        reply(res, { [key]: rows.slice(start, start + 100).map((item) => key === "users" ? { id: item.id, name: item.name, status: item.status } : { id: item.id, name: item.name, slug: item.slug }), meta: { pagination: { page: number, total: rows.length, next: start + 100 < rows.length ? number + 1 : null } } }); return;
      }
      assert.equal(req.headers["x-discussionbridge-secret"], config.connectionSecret); assert.equal(req.headers.authorization, undefined);
      if (url.pathname.endsWith("/connection.json")) { reply(res, connection); return; }
      if (url.pathname.endsWith("/catalog.json")) { const bound = cursors.get(url.searchParams.get("cursor")); assert.ok(bound); reply(res, page(url.searchParams.get("kind"), bound.snapshot, bound.offset)); return; }
      const key = `${url.pathname}:${body.mutation_id}`;
      if (replay.has(key)) { const saved = replay.get(key); assert.equal(raw, saved.raw); reply(res, saved.data, saved.status); return; }
      let route, data, status = 200, path = {};
      if (url.pathname.endsWith("/uploads.json")) {
        route = "V4-24"; uploadCount++;
        upload = { upload_id: `${String(uploadCount).padStart(8, "0")}-1111-4111-8111-111111111111`, kind: body.kind, native_revision: body.native_revision, total_items: body.total_items, received_items: 0, next_page: 0, expires_at: new Date(Date.now() + 86400000).toISOString() }; data = upload; status = 201; upload.items = [];
      } else if (url.pathname.endsWith("/pages.json")) {
        route = "V4-25"; path = { upload_id: upload.upload_id }; assert.equal(body.page, upload.next_page); assert.ok(Buffer.byteLength(raw) <= 65536 && body.items.length <= 100);
        if (options.expiredUpload) { options.expiredUpload = false; reply(res, { outcome: "rejected", code: "catalog_upload_expired", retryable: false, retry_after_seconds: null, correlation_id: null, core_fallback: false }, 410); return; }
        upload.items.push(...body.items); upload.received_items += body.items.length; upload.next_page++; data = upload;
      } else if (url.pathname.endsWith("/finalize.json")) {
        route = "V4-26"; path = { upload_id: upload.upload_id };
        if (options.rejectFinalize) { reply(res, { outcome: "rejected", code: "catalog_page_conflict", retryable: false, retry_after_seconds: null, correlation_id: null, core_fallback: false }, 409); return; }
        assert.equal(body.expected_total_items, upload.items.length);
        active = { revision: `catalog-${uploadCount}`, native_revision: upload.native_revision, items: structuredClone(upload.items) }; data = page(upload.kind, active);
      } else assert.fail("Unassigned catalog route/native write attempted");
      validateCmsRoute(route, { body, path });
      if (route !== "V4-26") { data = { ...data }; delete data.items; }
      replay.set(key, { raw, data: structuredClone(data), status });
      if (lost === route) { lost = null; res.destroy(); return; }
      reply(res, data, status);
    } catch (error) { res.destroy(error); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const driver = async (address, input) => { const original = new URL(address), response = await fetch(`http://127.0.0.1:${server.address().port}${original.pathname}${original.search}`, input); Object.defineProperty(response, "url", { value: address }); return response; };
  const store = new StateStore(config.stateFile), client = new CmsClient({ serviceOrigin: config.serverUrl, connectionId: config.connectionId, connectionSecret: config.connectionSecret }, { fetchImplementation: driver }), ghost = new GhostAdminClient(config, driver);
  await store.write({ version: 1, posts: {}, presentations: {}, publications: { preserved: { state: "complete", canonical_url: "https://ghost.example/preserved/" } } });
  try { await callback({ config, connection, store, client, ghost, rows, calls, options, active: () => active, nativeReads: () => nativeReads, refresh: (kind = "authors") => refreshGhostCatalog(config, store, ghost, kind, { cmsClient: client }) }); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
}

test("actual native catalog producer performs complete stable census, sequential typed upload and snapshot read without policy/work/native writes", async () => {
  await fixture({}, async (f) => {
    const original = (await f.store.read()).publications;
    const result = await f.refresh(); assert.equal(result.total_items, 201); assert.equal(f.nativeReads(), 6);
    assert.equal(f.active().items.length, 201); assert.equal(f.active().items[0].available, true); assert.equal(f.active().items[0].label, 'Native "雪" 0');
    assert.deepEqual((await f.store.read()).publications, original); assert.equal((await f.store.read()).cms_feed, undefined);
    assert.deepEqual(f.calls.filter((call) => call.path.endsWith("/pages.json")).map((call) => [call.body.page, call.body.items.length]), [[0, 100], [1, 100], [2, 1]]);
    assert.equal(f.calls.filter((call) => call.path.endsWith("/catalog.json")).length, 2);
    assert.ok(f.calls.every((call) => !/work|sources|policy|mappings/u.test(call.path)));
    assert.match(result.native_revision, /^ghost-catalog-sha256:[a-f0-9]{64}$/u);
  });
});

for (const route of ["V4-24", "V4-25", "V4-26"]) test(`lost ${route} response retains exact snapshot, mutation/body replay and prior completion evidence`, async () => {
  await fixture({ lost: route }, async (f) => {
    await assert.rejects(f.refresh(), (error) => error.requestOutcomeUncertain);
    const reads = f.nativeReads(); f.rows[0].name = "New native name after uncertain upload";
    const before = f.calls.filter((call) => call.body?.mutation_id).at(-1);
    const result = await f.refresh(); assert.equal(result.total_items, 201); assert.equal(f.nativeReads(), reads);
    const repeated = f.calls.filter((call) => call.body?.mutation_id === before.body.mutation_id); assert.equal(repeated.length, 2); assert.equal(repeated[0].raw, repeated[1].raw);
    assert.equal(f.active().items[0].label, 'Native "雪" 0'); assert.equal((await f.store.read()).cms_catalog_refresh.authors.state, "complete");
  });
});

test("changed same-total census and invalid native labels/IDs stop before upload; empty catalogs have no pages", async () => {
  await fixture({ changedPage: true }, async (f) => { await assert.rejects(f.refresh(), /changed during complete census/u); assert.equal(f.calls.some((call) => call.method === "POST"), false); assert.equal(f.active().revision, "previous-catalog"); });
  await fixture({ total: 1 }, async (f) => { f.rows[0].name = "é".repeat(101); await assert.rejects(f.refresh()); assert.equal(f.calls.some((call) => call.method === "POST"), false); });
  await fixture({ total: 1 }, async (f) => { f.rows[0].id = "invalid-native-id"; await assert.rejects(f.refresh()); assert.equal(f.calls.some((call) => call.method === "POST"), false); });
  await fixture({ total: 2 }, async (f) => { f.rows[1].id = f.rows[0].id; await assert.rejects(f.refresh()); assert.equal(f.calls.some((call) => call.method === "POST"), false); });
  await fixture({ invalidUtf8: true }, async (f) => { await assert.rejects(f.refresh(), /Invalid Ghost response JSON/u); assert.equal(f.calls.some((call) => call.method === "POST"), false); });
  for (const kind of ["authors", "taxonomy"]) await fixture({ total: 0 }, async (f) => { const result = await f.refresh(kind); assert.equal(result.total_items, 0); assert.equal(f.calls.some((call) => call.path.endsWith("/pages.json")), false); assert.equal(f.active().items.length, 0); });
});

test("actual native tags retain their exact IDs/labels and current policy/publication assignments", async () => {
  await fixture({ total: 3 }, async (f) => {
    const before = structuredClone(f.connection.policy), publications = (await f.store.read()).publications;
    const result = await f.refresh("taxonomy"); assert.equal(result.kind, "taxonomy"); assert.equal(result.total_items, 3); assert.equal(f.nativeReads(), 2);
    assert.deepEqual(f.active().items.map((item) => [item.id, item.label]), f.rows.map((item) => [item.id, item.name])); assert.deepEqual(f.connection.policy, before); assert.deepEqual((await f.store.read()).publications, publications);
  });
});

test("definitive expired upload does not restart automatically; the next explicit refresh obtains a fresh census and mutation IDs", async () => {
  await fixture({ total: 1, expiredUpload: true }, async (f) => {
    await assert.rejects(f.refresh(), (error) => error.code === "catalog_upload_expired");
    const old = (await f.store.read()).cms_catalog_refresh.authors; assert.equal(old.restart_expired_upload, true); assert.equal(f.calls.filter((call) => call.path.endsWith("/uploads.json")).length, 1); assert.equal(f.active().revision, "previous-catalog");
    f.rows[0].name = "Native name for new explicit refresh";
    const result = await f.refresh(); assert.equal(result.catalog_revision, "catalog-2"); assert.equal(f.nativeReads(), 4); assert.notEqual((await f.store.read()).cms_catalog_refresh.authors.job_id, old.job_id); assert.equal(f.active().items[0].label, f.rows[0].name);
  });
});

test("pending upload cannot cross scope change or an unauthorized native connection", async () => {
  await fixture({ total: 1, lost: "V4-24" }, async (f) => {
    await assert.rejects(f.refresh(), (error) => error.requestOutcomeUncertain); const posts = f.calls.filter((call) => call.method === "POST").length, reads = f.nativeReads();
    f.connection.scope_revision = "different-scope"; await assert.rejects(f.refresh(), /explicit scope reconciliation/u); assert.equal(f.calls.filter((call) => call.method === "POST").length, posts); assert.equal(f.nativeReads(), reads);
  });
  await fixture({ total: 1 }, async (f) => { f.connection.destination_origin = "https://different.example"; await assert.rejects(f.refresh(), /does not match configured native scope/u); assert.equal(f.nativeReads(), 0); assert.equal(f.calls.some((call) => call.method === "POST"), false); });
});

test("rejected finalize preserves previous active snapshot and last completed local receipt", async () => {
  await fixture({ total: 1 }, async (f) => {
    const prior = await f.refresh(), active = structuredClone(f.active()); f.rows[0].name = "Changed native name"; f.options.rejectFinalize = true;
    await assert.rejects(f.refresh(), (error) => error.code === "catalog_page_conflict");
    assert.deepEqual(f.active(), active); const job = (await f.store.read()).cms_catalog_refresh.authors;
    assert.equal(job.state, "attention"); assert.deepEqual(job.last_completed, prior); assert.equal(job.restart_expired_upload, false);
  });
});

test("producer page packing accounts for encoded JSON at byte boundary as well as 100 entries without clipping", () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({ id: `entry-${i}` + '"'.repeat(247), label: '"'.repeat(200), available: true }));
  const pages = ghostCatalogPages(entries); assert.ok(pages.length > 1); assert.deepEqual(pages.flat(), entries);
  for (let page = 0; page < pages.length; page++) assert.ok(pages[page].length <= 100 && Buffer.byteLength(JSON.stringify({ mutation_id: "00000000-0000-4000-8000-000000000000", page, items: pages[page] })) <= 65536);
  const exact = Array.from({ length: 100 }, (_, i) => ({ id: `entry-${i}`, label: "a".repeat(200), available: true }));
  let remaining = 65536 - Buffer.byteLength(JSON.stringify({ mutation_id: "00000000-0000-4000-8000-000000000000", page: 0, items: exact }));
  for (const item of exact) { const count = Math.min(255 - Buffer.byteLength(item.id), Math.floor(remaining / 2)); item.id += '"'.repeat(count); remaining -= count * 2; if (remaining === 1 && Buffer.byteLength(item.id) < 255) { item.id += "a"; remaining--; } }
  assert.equal(remaining, 0); assert.equal(ghostCatalogPages(exact).length, 1);
  exact.at(-1).id += "x"; assert.equal(ghostCatalogPages(exact).length, 2);
});

test("native census fingerprint is order-independent while exact names and status changes are observed without guessed eligibility", async () => {
  const items = [{ id: "a".repeat(24), name: "Suspended staff", status: "suspended" }, { id: "b".repeat(24), name: "Native author", status: "active" }];
  let reads = 0; const snapshot = await ghostCatalogSnapshot({ catalog: async () => ++reads === 1 ? items : [...items].reverse() }, "authors");
  assert.ok(snapshot.entries.every((item) => item.available)); assert.equal(snapshot.entries[0].label, "Suspended staff");
  await assert.rejects(ghostCatalogSnapshot({ catalog: async () => ++reads === 3 ? items : [{ ...items[0], status: "changed" }, items[1]] }, "authors"), /changed during complete census/u);
});
