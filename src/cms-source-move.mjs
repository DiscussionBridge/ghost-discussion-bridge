import { randomUUID } from "node:crypto";
import { validateCms, projectGeneratedReadMoreMove } from "../lib/cms-runtime.mjs";
import { publishedGhostSource, nativeSourceBaseline } from "./ghost-source.mjs";
import { nativeTopicUrl } from "./topic-identity.mjs";
import { currentSourceInput } from "./cms-source-publication.mjs";
import { executeGhostSourceMove } from "./source-native-move.mjs";
import { captureSourceNative } from "./source-native-proof.mjs";
import { sourceArtifactIdentity } from "../lib/cms-vendor.mjs";

const check = (condition, reason) => { if (!condition) throw new Error(reason); };
const tree = (value) => value && typeof value === "object" ? Array.isArray(value) ? value.map(tree) : Object.fromEntries(Object.keys(value).sort().map((key) => [key, tree(value[key])])) : value;
const exact = (a, b) => JSON.stringify(tree(a)) === JSON.stringify(tree(b));

// ONE existing protected source-move surface and native writer. A configured
// installed article/permalink integration is required before native movement.
export async function prepareGhostSourceMove(request, config, store, client, ghost, options = {}) {
  check(request && typeof request === "object" && Object.keys(request).length === 3 && Object.keys(request).every((key) => ["native_id", "expected_source_revision", "new_url"].includes(key)) && /^[a-f0-9]{24}$/u.test(request.native_id ?? ""), "Ghost source move request identity is invalid");
  validateCms("Revision", request.expected_source_revision); validateCms("Url", request.new_url);
  check(new URL(request.new_url).origin === config.ghostOrigin && typeof store.withNativeLock === "function", "Ghost source move requires its same-origin native writer");
  const key = `ghost-post:${request.native_id}`;
  return store.withNativeLock(async (assertWriter) => {
    await assertWriter();
    let local = (await store.read()).posts[key];
    check(local?.source_protocol === "v4" && local.resource_id && local.cms_source?.accepted_revision && local.cms_source.accepted_native_baseline && !local.cms_source.withdrawal && !local.cms_source.intent, "Ghost source move has no exact current accepted native binding");
    const completed = local.cms_source.source_move_history?.findLast((move) => move.state === "finalized" && move.intent.body.expected_source_revision === request.expected_source_revision && move.intent.body.new_url === request.new_url);
    check(local.cms_source.accepted_revision === request.expected_source_revision || completed?.finalize_response.source_revision === local.cms_source.accepted_revision, "Ghost source move accepted revision differs");
    check(request.new_url !== local.canonical_url || completed, "Ghost source move proposed URL is already current");
    const budget = Math.max(config.webhookMaximumBytes ?? 0, local.cms_source.accepted_native_baseline.native_content_bytes * 6 + 1024 * 1024);
    const current = await ghost.getSource(request.native_id, budget), source = publishedGhostSource(current, config);
    check(current.type === "post" && current.id === request.native_id && exact(nativeSourceBaseline(current, source), local.cms_source.accepted_native_baseline), "Ghost source move article/identity differs from its accepted native baseline");
    check([local.canonical_url, request.new_url].includes(source.url.href), "Ghost source move actual native canonical URL differs");
    const connection = await client.connection(); validateCms("Connection", connection);
    check(connection.connection_id === config.connectionId && connection.profile === "ghost" && connection.destination_origin === config.ghostOrigin && connection.directions.includes("to_discourse") && connection.policy.enabled && (!config.lane || connection.publication_lane === config.lane), "Ghost source move current receiver scope/policy is unavailable");
    const record = await client.sourceRecord(local.resource_id); validateCms("Record", record);
    const active = local.cms_source.source_url_move, recoveredRevision = active?.finalize_intent?.body.new_source_revision;
    check(record.resource_id === local.resource_id && record.external_id === key && record.direction === "to_discourse" && record.state === "active" && record.topic_id === String(local.topic_id) && (record.source_revision === local.cms_source.accepted_revision && record.canonical_url === local.canonical_url || recoveredRevision && record.source_revision === recoveredRevision && record.canonical_url === request.new_url), "Ghost source move current receiver binding differs");
    nativeTopicUrl(record.topic_url, config.serverUrl, record.topic_id);
    if (completed) {
      check(record.source_revision === completed.finalize_response.source_revision && exact(captureSourceNative(current, config), completed.after), "Ghost completed source move no longer matches its actual native edition");
      await readGhostSourceUrlHistory(key, store, client, assertWriter);
      return structuredClone(completed);
    }
    const state = await store.read();
    check(!Object.entries(state.posts).some(([otherKey, item]) => otherKey !== key && (item.canonical_url === request.new_url || item.cms_source?.source_url_move?.intent?.body.new_url === request.new_url || item.cms_source?.url_history?.items?.some((entry) => entry.url === request.new_url))) && !Object.values(state.publications).some((item) => item.canonical_url === request.new_url || item.cms?.url_history?.some((entry) => entry.url === request.new_url)), "Ghost source move URL collides with another current native identity");
    let job = local.cms_source.source_url_move;
    if (!job) {
      const body = { mutation_id: randomUUID(), expected_source_revision: request.expected_source_revision, old_url: local.canonical_url, new_url: request.new_url, external_id: key };
      client.prepareMutation("V4-28", body, { resource_id: local.resource_id });
      // Capacity projection is value-local only and never becomes a fabricated
      // edition or native proof. The exact proposed prefix remains unchanged.
      const input = currentSourceInput(local.cms_source)?.bridge_record;
      check(input && input.source_revision === request.expected_source_revision, "Ghost source move accepted publication input is unavailable");
      const capacityRevision = `ghost-source:${randomUUID()}`;
      const projection = input.representation.kind === "generated_excerpt" ? projectGeneratedReadMoreMove(input, request.new_url, capacityRevision, input.source_updated_at) : { ...structuredClone(input), canonical_url: request.new_url, expected_source_revision: input.source_revision, source_revision: capacityRevision };
      validateCms("ToResolve", { mutation_id: body.mutation_id, bridge_record: projection });
      check(Buffer.byteLength(JSON.stringify({ mutation_id: body.mutation_id, bridge_record: projection })) <= 65536, "Ghost source move projected envelope cannot fit without changing source content");
      job = { state: "pending", resource_id: local.resource_id, native_id: request.native_id, intent: { body, request_state: "prepared" }, native_observation: { canonical_url: source.url.href, updated_at: current.updated_at ?? null, baseline: nativeSourceBaseline(current, source) }, capacity: { content_html_bytes: Buffer.byteLength(projection.content_html), article_content_bytes: projection.representation.article_content_bytes ?? null }, prior_input: structuredClone(currentSourceInput(local.cms_source)), artifact_binding: { ...sourceArtifactIdentity }, requested_at: new Date().toISOString() };
      await store.update(async (next) => { const item = next.posts[key]; check(item.cms_source.accepted_revision === request.expected_source_revision && !item.cms_source.source_url_move, "Ghost source move writer binding changed"); item.cms_source.source_url_move = job; });
    } else check(job.intent?.body.new_url === request.new_url && job.intent.body.expected_source_revision === request.expected_source_revision && job.resource_id === local.resource_id, "Ghost source move pending exact request differs");
    if (!job.prepare_response) {
      await assertWriter();
      await store.update(async (next) => { next.posts[key].cms_source.source_url_move.intent.request_state = "uncertain"; });
      const prepared = await client.prepareSourceUrlMove(job.resource_id, job.intent.body); validateCms("SourceUrlMove", prepared);
      check(prepared.resource_id === job.resource_id && prepared.expected_source_revision === job.intent.body.expected_source_revision && prepared.old_url === job.intent.body.old_url && prepared.new_url === job.intent.body.new_url && prepared.state === "prepared", "Ghost source move prepare receipt binding differs");
      await assertWriter();
      await store.update(async (next) => { const saved = next.posts[key].cms_source.source_url_move; check(saved.intent.body.mutation_id === job.intent.body.mutation_id, "Ghost source move mutation ownership changed"); saved.prepare_response = structuredClone(prepared); saved.state = "prepared"; });
    }
    await readGhostSourceUrlHistory(key, store, client, assertWriter);
    local = (await store.read()).posts[key];
    if (!config.sourceNativeIntegration && !config.sourceNativeIntegrationFile) {
      await store.update(async (next) => { const saved = next.posts[key].cms_source.source_url_move; saved.state = "native_verification_attention"; saved.failure_reason = "Ghost source native integration: installed native version/theme/permalink/full-article descriptor is unavailable; both reservations remain held"; });
      return structuredClone((await store.read()).posts[key].cms_source.source_url_move);
    }
    const result = await executeGhostSourceMove(config, store, client, ghost, key, assertWriter, options);
    await readGhostSourceUrlHistory(key, store, client, assertWriter);
    return result;
  });
}

export async function readGhostSourceUrlHistory(key, store, client, assertWriter = async () => {}) {
  const local = (await store.read()).posts[key];
  check(local?.source_protocol === "v4" && local.resource_id && local.cms_source?.accepted_revision, "Ghost source URL history has no owned current binding");
  let history = local.cms_source.url_history ?? { items: [], next_cursor: null, complete: false, seen_cursors: [] };
  if (history.complete) return structuredClone(history);
  for (let count = 0; count < 10; count++) {
    await assertWriter();
    const cursor = history.next_cursor, page = await client.sourceUrlHistory(local.resource_id, cursor ? { cursor } : {}); validateCms("UrlHistoryPage", page);
    check(!page.next_cursor || page.next_cursor !== cursor && !history.seen_cursors.includes(page.next_cursor), "Ghost source URL history cursor repeats");
    const items = [...history.items];
    for (const entry of page.items) { const previous = items.find((item) => item.url === entry.url); check(!previous || exact(previous, entry), "Ghost source URL ancestry changed"); if (!previous) items.push(structuredClone(entry)); }
    history = { items, next_cursor: page.next_cursor, complete: page.next_cursor === null, seen_cursors: [...history.seen_cursors, ...(page.next_cursor ? [page.next_cursor] : [])] };
    await store.update(async (next) => { check(next.posts[key]?.resource_id === local.resource_id, "Ghost source URL history ownership changed"); next.posts[key].cms_source.url_history = history; });
    if (history.complete) break;
  }
  return structuredClone(history);
}
