// HTTP/StateStore integration cases: deliberately separate from pure checks.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { StateStore } from "../src/state-store.mjs";
import { buildServer } from "../src/service.mjs";
import { fixture, config, id, key, resource, topic, sha } from "./fixtures/cms-source-fixture.mjs";

test("definitive preservation refusal survives signed duplicate notifications and StateStore restart without another request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ghost-v4-to-refusal-"));
  try {
    const path = join(directory, "state.json"), f = fixture(new StateStore(path)); await f.publish();
    const accepted = structuredClone((await f.store.read()).posts[key].cms_source);
    f.native.html = "<p>Changed native article requiring preservation</p>";
    f.preservationResponse = { outcome: "rejected", code: "content_preservation_unavailable", retryable: false, retry_after_seconds: null, correlation_id: null, core_fallback: false };
    let active = f; const webhookConfig = { ...config, adapterOrigin: "https://adapter.example", webhookSecret: "w".repeat(32) };
    const server = buildServer(webhookConfig, f.store, {}, { publishNativeSource: async (nativeId) => { assert.equal(nativeId, id); return active.publish(); } });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    try {
      const send = async () => {
        const raw = JSON.stringify({ post: { current: { id } } }), at = String(Date.now()), signature = createHmac("sha256", webhookConfig.webhookSecret).update(`${raw}${at}`).digest("hex");
        return fetch(`http://127.0.0.1:${server.address().port}/webhooks/ghost`, { method: "POST", body: raw, headers: { "Content-Type": "application/json", "X-Ghost-Signature": `sha256=${signature}, t=${at}` } });
      };
      assert.equal((await send()).status, 502);
      const refused = structuredClone((await f.store.read()).posts[key].cms_source.intent);
      assert.equal(refused.rejection_outcome.envelope.code, "content_preservation_unavailable"); assert.equal(refused.rejection_outcome.request_sha256, sha(JSON.stringify(refused.body)));
      assert.equal((await send()).status, 502); assert.equal(f.bodies.length, 2);
      active = fixture(new StateStore(path)); active.native = structuredClone(f.native); active.remote = structuredClone(f.remote);
      assert.equal((await send()).status, 502); assert.equal(active.bodies.length, 0);
      const saved = (await active.store.read()).posts[key]; assert.deepEqual(saved.cms_source.intent, refused); assert.deepEqual(saved.cms_source.accepted_receipt, accepted.accepted_receipt); assert.deepEqual(saved.cms_source.accepted_history, accepted.accepted_history);
      assert.match(saved.failure_reason, /content_preservation_unavailable/u); assert.equal(saved.topic_id, topic); assert.equal(saved.resource_id, resource);
    } finally { const closed = new Promise((done) => server.close(done)); server.closeAllConnections(); await closed; }
  } finally { if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}ghost-v4-to-refusal-`)) throw new Error("Unexpected refusal test path"); await rm(directory, { recursive: true, force: true }); }
});

