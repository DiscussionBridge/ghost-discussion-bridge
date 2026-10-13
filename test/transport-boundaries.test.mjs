import assert from "node:assert/strict";
import test from "node:test";
import { BridgeClient } from "../src/bridge-client.mjs";
import { GhostAdminClient } from "../src/ghost-admin-client.mjs";
import { safeSummary } from "../src/publication-operations.mjs";
import { buildServer } from "../src/service.mjs";

const config = {
  serverUrl: "https://forum.example", ghostOrigin: "https://ghost.example",
  ghostAdminOrigin: "https://admin.example", adapterOrigin: "https://adapter.example",
  connectionId: "dbc_0123456789abcdef01234567", connectionSecret: "synthetic-connection-secret-123456",
  webhookSecret: "synthetic-webhook-secret-123456789", operatorPassword: "synthetic-operator-password-12345",
  ghostAdminApiKey: `${"a".repeat(24)}:${"b".repeat(64)}`,
};
const resourceId = "11111111-1111-4111-8111-111111111111";

async function publicFailure(client) {
  let result;
  const server = buildServer(config, { read: async () => ({ presentations: { [resourceId]: {} } }) }, client);
  const response = {
    headers: {}, setHeader(key, value) { this.headers[key] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(value) { result = { status: this.status, headers: this.headers, body: String(value) }; },
  };
  await server.listeners("request")[0]({ method: "GET", url: `/presentation/${resourceId}`, headers: { origin: config.ghostOrigin } }, response);
  return result;
}

test("public upstream failures never declassify protected or arbitrary reason text", async () => {
  for (const reason of [...[config.connectionSecret, config.webhookSecret, config.ghostAdminApiKey, config.operatorPassword].map((secret) => `upstream\n${secret}\u0000detail`), "x".repeat(8_192), { unexpected: "private detail" }]) {
    const client = new BridgeClient(config, async () => new Response(JSON.stringify({ reason }), { status: 403, headers: { "Content-Type": "application/json" } }));
    const result = await publicFailure(client);
    assert.equal(result.status, 502);
    assert.equal(result.headers["Access-Control-Allow-Origin"], config.ghostOrigin);
    assert.deepEqual(JSON.parse(result.body), { error: "adapter_failure", reason: "request_failed" });
    for (const secret of [config.connectionSecret, config.webhookSecret, config.ghostAdminApiKey, config.operatorPassword]) assert.equal(result.body.includes(secret), false);
    const error = await client.record(resourceId).catch((value) => value);
    assert.equal(error.status, 403);
    assert.equal(error.reason, "request_failed");
  }
  const summary = safeSummary({ errors: [{ reason: Object.values(config).join("\n") }] }, config);
  for (const secret of [config.connectionSecret, config.webhookSecret, config.ghostAdminApiKey, config.operatorPassword]) assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.doesNotMatch(summary.errors[0].reason, /[\u0000-\u001f\u007f]/u);
});

const responseClasses = [
  { name: "Discourse JSON", limit: 65_536, type: "application/json", content: (size) => JSON.stringify({ pad: "x".repeat(size - 10) }),
    invoke: (fetcher, timeoutMs) => new BridgeClient(config, fetcher, { timeoutMs }).publicTopic(42) },
  { name: "Ghost Admin JSON", limit: 256 * 1024, type: "application/json", content: (size) => JSON.stringify({ pad: "x".repeat(size - 10) }),
    invoke: (fetcher, timeoutMs) => new GhostAdminClient(config, fetcher, { timeoutMs }).request("GET", "/ghost/api/admin/posts/") },
  { name: "Discourse branding", limit: 512 * 1024, type: "text/html", content: (size) => {
    const base = `<script id="data-preloaded">${JSON.stringify({ siteSettings: JSON.stringify({ enable_powered_by_discourse: true }) })}</script>`;
    return base.padEnd(size, " ");
  }, invoke: (fetcher, timeoutMs) => new BridgeClient(config, fetcher, { timeoutMs }).publicPoweredByDiscourse() },
];

for (const responseClass of responseClasses) {
  test(`${responseClass.name}: deadline includes header-fast stalled body and cancellation`, async () => {
    let signal, cancelled = 0, release;
    const fetcher = async (_url, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({
        start(controller) { release = setTimeout(() => { try { controller.enqueue(new TextEncoder().encode(responseClass.content(256))); controller.close(); } catch {} }, 100); },
        cancel() { cancelled += 1; },
      }), { headers: { "Content-Type": responseClass.type } });
    };
    try { await assert.rejects(responseClass.invoke(fetcher, 30), /transport failed/); }
    finally { clearTimeout(release); }
    assert.equal(signal.aborted, true);
    assert.equal(cancelled, 1);
  });

  test(`${responseClass.name}: slow chunks cannot extend the overall deadline`, async () => {
    let signal, cancelled = 0, pulls = 0, bodyController;
    const stream = new ReadableStream({
      start(controller) { bodyController = controller; },
      async pull(controller) {
        pulls += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        try { controller.enqueue(new Uint8Array([32])); } catch {}
      }, cancel() { cancelled += 1; },
    });
    const fetcher = async (_url, options) => { signal = options.signal; return new Response(stream, { headers: { "Content-Type": responseClass.type } }); };
    // A harness watchdog releases the old unbounded implementation without a
    // hung test, while the corrected 30-ms boundary cancels before it fires.
    const watchdog = setTimeout(() => { try { bodyController.close(); } catch {} }, 100);
    const pending = responseClass.invoke(fetcher, 30);
    try {
      const observed = await pending.then(() => null, (error) => error);
      assert.match(observed?.message ?? "", /transport failed/);
      assert.equal(signal.aborted, true);
      assert.equal(cancelled, 1);
      assert.ok(pulls < 8);
    } finally {
      clearTimeout(watchdog);
      try { bodyController.close(); } catch {}
    }
  });

  test(`${responseClass.name}: actual byte limit is enforced with absent or misleading length`, async () => {
    for (const contentLength of [undefined, "1"]) {
      for (const extra of [0, 1]) {
        const bytes = new TextEncoder().encode(responseClass.content(responseClass.limit + extra));
        assert.equal(bytes.length, responseClass.limit + extra);
        let cancelled = 0, offset = 0;
        const stream = new ReadableStream({ pull(controller) {
          if (offset === bytes.length) return controller.close();
          const end = Math.min(bytes.length, offset + 4_096);
          controller.enqueue(bytes.subarray(offset, end)); offset = end;
        }, cancel() { cancelled += 1; } }, { highWaterMark: 0 });
        const headers = { "Content-Type": responseClass.type, ...(contentLength ? { "Content-Length": contentLength } : {}) };
        const pending = responseClass.invoke(async () => new Response(stream, { headers }), 5_000);
        if (extra) { await assert.rejects(pending, /[Rr]esponse too large/); assert.equal(cancelled, 1); }
        else { await pending; assert.equal(cancelled, 0); }
        assert.equal(stream.locked, false);
      }
    }
  });

  test(`${responseClass.name}: failed headers cancel without consuming and never reflect transport text`, async () => {
    for (const failure of ["length", "origin", "media", "body"]) {
      let cancelled = 0, pulls = 0, signal;
      const stream = new ReadableStream({ pull(controller) {
        pulls += 1;
        controller.error(new Error(config.connectionSecret));
      }, cancel() { cancelled += 1; } }, { highWaterMark: 0 });
      const response = new Response(stream, { headers: { "Content-Type": failure === "media" ? "text/plain" : responseClass.type,
        ...(failure === "length" ? { "Content-Length": String(responseClass.limit + 1) } : {}) } });
      if (failure === "origin") Object.defineProperty(response, "url", { value: "https://foreign.example/error" });
      const error = await responseClass.invoke(async (_url, options) => { signal = options.signal; return response; }, 1_000).catch((value) => value);
      assert.ok(error instanceof Error); assert.equal(error.message.includes(config.connectionSecret), false);
      assert.equal(signal.aborted, true); assert.equal(stream.locked, false);
      assert.equal(pulls, failure === "body" ? 1 : 0); assert.equal(cancelled, failure === "body" ? 0 : 1);
    }
  });

  test(`${responseClass.name}: success releases reader and clears deadline`, async () => {
    let signal;
    const response = new Response(responseClass.content(256), { headers: { "Content-Type": responseClass.type } });
    await responseClass.invoke(async (_url, options) => { signal = options.signal; return response; }, 100);
    assert.equal(response.body.locked, false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(signal.aborted, false);
  });
}
