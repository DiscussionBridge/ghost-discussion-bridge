import assert from "node:assert/strict";
import test from "node:test";
import { CmsClient } from "../lib/cms-client.mjs";
import { cmsVendor } from "../lib/cms-vendor.mjs";

const config = { serviceOrigin: "https://forum.example", connectionId: `dbc_${"a".repeat(24)}`, connectionSecret: "SYNTHETIC-RECOVERY-ONLY" };
const id = "11111111-1111-4111-8111-111111111111";
const capability = { protocol_revision: "attention-recovery-1", candidate_id: "discussionbridge-v4-core-20261025-r6", inspection_profiles: ["ghost-dynamic-1"] };

test("r6 capability/page/exact-targeted-claim use only their closed authenticated routes", async () => {
  const seen = [], client = new CmsClient(config, { fetchImplementation: async (address, options) => {
    seen.push({ address, method: options.method, body: options.body, headers: options.headers });
    const body = address.endsWith("attention-recovery.json") ? capability : { items: [], next_after: 2, has_more: false };
    const response = new Response(options.method === "POST" ? null : JSON.stringify(body), { status: options.method === "POST" ? 204 : 200, headers: { "Content-Type": "application/json" } }); Object.defineProperty(response, "url", { value: address }); return response;
  } });
  const received = await client.attentionCapability(); assert.equal(Object.getPrototypeOf(received), null); assert.deepEqual({ ...received }, capability); await client.attentionInspections({ after: 2 }); await client.attentionRecoveries({ after: 2 });
  assert.equal(await client.claimRecovery(id, { mutation_id: id, work_id: id }), undefined);
  assert.deepEqual(seen.map((entry) => [entry.method, new URL(entry.address).pathname, new URL(entry.address).search]), [
    ["GET", "/discussion-bridge/v4/attention-recovery.json", ""], ["GET", "/discussion-bridge/v4/attention-inspections.json", "?after=2"], ["GET", "/discussion-bridge/v4/work/recoveries.json", "?after=2"], ["POST", `/discussion-bridge/v4/work/recoveries/${id}/claim.json`, ""],
  ]);
  for (const entry of seen) { assert.equal(entry.headers["X-DiscussionBridge-Connection"], config.connectionId); assert.equal(entry.headers["X-DiscussionBridge-Secret"], config.connectionSecret); }
  assert.deepEqual(JSON.parse(seen.at(-1).body), { mutation_id: id, work_id: id });
});

test("r6 rejects generic ready attestation, unknown selectors and changed normal Claim without dispatch", () => {
  let requests = 0; const client = new CmsClient(config, { fetchImplementation: async () => { requests++; throw new Error("Must not dispatch"); } });
  assert.throws(() => client.prepareMutation("V4-34", { mutation_id: id, context_sha256: "a".repeat(64), ready: true }, { inspection_id: id }));
  assert.throws(() => client.prepareMutation("V4-36", { mutation_id: id, work_id: id, mapping_id: id }, { recovery_id: id }));
  assert.throws(() => client.prepareMutation("V4-13", { mutation_id: id, work_id: id })); assert.equal(requests, 0);
  // The additive attention capability retains its R6 identity independently
  // of the current R7 URL/runtime artifact selection.
  assert.equal(cmsVendor.candidate_id, "discussionbridge-v4-core-20261029-r7");
  assert.equal(capability.candidate_id, "discussionbridge-v4-core-20261025-r6");
});
