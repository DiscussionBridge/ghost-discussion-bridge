import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { buildServer } from "../src/service.mjs";
import { operatorCsrfToken, renderOperatorPage } from "../src/operator-surface.mjs";

// Source-authored recovery coverage. Execution is separately held by Root.
const nativeId = "0123456789abcdef01234567";
const refusedMutationId = "11111111-1111-4111-8111-111111111111";
const config = {
  ghostOrigin: "https://ghost.example", serverUrl: "https://forum.example",
  adapterOrigin: "https://adapter.example", operatorOrigin: "https://adapter.example",
  operatorPassword: "p".repeat(32), webhookSecret: "s".repeat(32),
  connectionId: `dbc_${"a".repeat(24)}`,
};
const auth = `Basic ${Buffer.from(`discussionbridge:${config.operatorPassword}`).toString("base64")}`;
const initialState = () => ({ version: 1, posts: {}, publications: {}, presentations: {} });
const retryForm = () => new URLSearchParams({
  csrf: operatorCsrfToken(config.operatorPassword), native_id: nativeId,
  refused_mutation_id: refusedMutationId,
});

async function withServer(operations, run, state = initialState(), runtime = config) {
  const server = buildServer(runtime, { read: async () => structuredClone(state) }, {}, operations);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  const submit = (body = retryForm(), headers = {}, method = "POST") => fetch(`${address}/operator/retry-source`, {
    method, redirect: "manual", ...(method === "GET" || method === "HEAD" ? {} : { body }),
    headers: { Authorization: auth, Origin: config.operatorOrigin, "Content-Type": "application/x-www-form-urlencoded", ...headers },
  });
  try { await run({ address, submit }); }
  finally {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
}

async function noticePage(address, response) {
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie, "operator result uses the established signed notice cookie");
  assert.match(cookie, /; HttpOnly; Secure; SameSite=Strict/u);
  const result = await fetch(`${address}/operator/`, { headers: { Authorization: auth, Cookie: cookie.split(";", 1)[0] } });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  return result.text();
}

test("explicit protected source Retry passes only the exact source and refused intent to its operation", async () => {
  const calls = [];
  await withServer({ retrySource: async (request) => { calls.push(structuredClone(request)); return { outcome: "resolved" }; } }, async ({ address, submit }) => {
    const response = await submit();
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/discussionbridge/operator/");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(calls, [{ native_id: nativeId, refused_mutation_id: refusedMutationId }]);
    assert.equal(await response.text(), "");
    const html = await noticePage(address, response);
    assert.match(html, /Source retry completed\. Check its current delivery status and retained request history\./u);
    assert.doesNotMatch(html, new RegExp(config.operatorPassword, "u"));
  });
});

test("source Retry always requires the existing Basic operator credential, including before method checks", async () => {
  const calls = [];
  await withServer({ retrySource: async (request) => calls.push(request) }, async ({ address, submit }) => {
    assert.equal((await fetch(`${address}/operator/retry-source`, {
      method: "POST", body: retryForm(), headers: { "Content-Type": "application/x-www-form-urlencoded" },
    })).status, 401);
    for (const headers of [
      { Authorization: "" },
      { Authorization: `Basic ${Buffer.from("discussionbridge:wrong-password").toString("base64")}` },
      { Authorization: `Basic ${Buffer.from(`another-user:${config.operatorPassword}`).toString("base64")}` },
      { Authorization: "", "X-Ghost-Signature": "sha256=" + "a".repeat(64) + ", t=1792100000000" },
    ]) {
      const response = await submit(retryForm(), headers);
      assert.equal(response.status, 401);
      assert.match(response.headers.get("www-authenticate"), /^Basic realm="DiscussionBridge operator"/u);
    }
    assert.equal((await submit(undefined, { Authorization: "" }, "GET")).status, 401);
    assert.deepEqual(calls, []);
  });
  await withServer({ retrySource: async (request) => calls.push(request) }, async ({ submit }) => {
    assert.equal((await submit()).status, 401);
  }, initialState(), { ...config, operatorPassword: "" });
  assert.deepEqual(calls, []);
});

test("source Retry has no GET, HEAD, OPTIONS, PUT, PATCH or DELETE action", async () => {
  let calls = 0;
  await withServer({ retrySource: async () => { calls++; } }, async ({ submit }) => {
    for (const method of ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"]) {
      assert.equal((await submit(undefined, {}, method)).status, 405, method);
    }
    assert.equal(calls, 0);
  });
});

test("source Retry rejects missing or foreign Origin before calling the operation", async () => {
  let calls = 0;
  await withServer({ retrySource: async () => { calls++; } }, async ({ address, submit }) => {
    assert.equal((await fetch(`${address}/operator/retry-source`, {
      method: "POST", body: retryForm(), headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    })).status, 403);
    for (const origin of ["", config.ghostOrigin, "https://foreign.example", `${config.operatorOrigin}/`, `${config.operatorOrigin}.foreign.example`]) {
      const response = await submit(retryForm(), { Origin: origin });
      assert.equal(response.status, 403, origin);
      assert.deepEqual(await response.json(), { error: "origin_denied" });
    }
    assert.equal(calls, 0);
  });
});

test("source Retry accepts only the strict URL-encoded form media type", async () => {
  let calls = 0;
  await withServer({ retrySource: async () => { calls++; return { outcome: "resolved" }; } }, async ({ submit }) => {
    for (const type of ["", "application/json", "text/plain", "multipart/form-data", "application/x-www-form-urlencoded-foreign"]) {
      const response = await submit(retryForm().toString(), { "Content-Type": type });
      assert.equal(response.status, 415, type);
      assert.deepEqual(await response.json(), { error: "content_type" });
    }
    assert.equal(calls, 0);
    assert.equal((await submit(retryForm(), { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" })).status, 303);
    assert.equal(calls, 1);
  });
});

test("source Retry rejects missing, duplicate or extra form fields without inferring authority", async () => {
  const fields = ["csrf", "native_id", "refused_mutation_id"];
  let calls = 0;
  await withServer({ retrySource: async () => { calls++; } }, async ({ submit }) => {
    for (const field of fields) {
      const missing = retryForm(); missing.delete(field);
      assert.equal((await submit(missing)).status, 400, `missing ${field}`);
      const duplicate = retryForm(); duplicate.append(field, duplicate.get(field));
      assert.equal((await submit(duplicate)).status, 400, `duplicate ${field}`);
    }
    for (const [field, value] of [["actor", "Phil"], ["source_revision", "replacement"], ["force", "1"], ["retry", "true"], ["csrf[]", "token"]]) {
      const extra = retryForm(); extra.append(field, value);
      assert.equal((await submit(extra)).status, 400, `extra ${field}`);
    }
    assert.equal(calls, 0);
  });
});

test("source Retry refuses malformed native identity or refused-request identity", async () => {
  let calls = 0;
  await withServer({ retrySource: async () => { calls++; } }, async ({ submit }) => {
    for (const value of ["", nativeId.slice(1), `${nativeId}0`, nativeId.toUpperCase(), "g".repeat(24), `ghost-post:${nativeId}`, `${nativeId}\n`]) {
      const form = retryForm(); form.set("native_id", value);
      assert.equal((await submit(form)).status, 400, `native identity ${JSON.stringify(value)}`);
    }
    for (const value of ["", "not-a-uuid", refusedMutationId.replaceAll("-", ""), `${refusedMutationId}/`, "11111111-1111-4111-7111-111111111111", `${refusedMutationId}\n`]) {
      const form = retryForm(); form.set("refused_mutation_id", value);
      assert.equal((await submit(form)).status, 400, `refused identity ${JSON.stringify(value)}`);
    }
    assert.equal(calls, 0);
  });
});

test("source Retry uses the existing operator CSRF token and never invokes on a wrong token", async () => {
  let calls = 0;
  await withServer({ retrySource: async () => { calls++; } }, async ({ submit }) => {
    for (const value of ["", "bad", "0".repeat(64), operatorCsrfToken("different-operator-password")]) {
      const form = retryForm(); form.set("csrf", value);
      const response = await submit(form);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "csrf_denied" });
    }
    assert.equal(calls, 0);
  });
});

test("source Retry enforces its 1024-byte body bound before the operation", async () => {
  let calls = 0;
  await withServer({ retrySource: async () => { calls++; return { outcome: "resolved" }; } }, async ({ submit }) => {
    const valid = retryForm().toString();
    // Empty separators add bytes without adding fields to URLSearchParams.
    const atLimit = valid + "&".repeat(1024 - Buffer.byteLength(valid));
    assert.equal(Buffer.byteLength(atLimit), 1024);
    assert.equal((await submit(atLimit)).status, 303);
    assert.equal(calls, 1);
    const oversized = `${atLimit}&`;
    let response;
    try { response = await submit(oversized); }
    catch (error) { assert.ok(error instanceof TypeError, "a destroyed oversized request can close its HTTP socket"); }
    if (response) {
      assert.equal(response.status, 502); // Existing bounded-reader failure handling.
      assert.deepEqual(await response.json(), { error: "adapter_failure", reason: "request_failed" });
    }
    assert.equal(calls, 1);
  });
});

test("unavailable source Retry is explicit and does not fall through to another operation", async () => {
  const calls = [];
  await withServer({ synchronize: async () => calls.push("from"), publishNativeSource: async () => calls.push("webhook") }, async ({ submit }) => {
    assert.equal((await submit()).status, 409);
    assert.deepEqual(calls, []);
  });
});

test("source Retry keeps raw operation failures out of its notice and redirects to protected attention", async () => {
  const privateFailure = "private-request-body-and-secret-do-not-display";
  let calls = 0;
  await withServer({ retrySource: async () => { calls++; throw new Error(privateFailure); } }, async ({ address, submit }) => {
    const response = await submit();
    assert.equal(response.status, 303);
    const html = await noticePage(address, response);
    assert.match(html, /Source retry needs attention\. Its exact request and retained history remain available for reconciliation\./u);
    assert.doesNotMatch(html, new RegExp(privateFailure, "u"));
    assert.equal(calls, 1);
  });
});

test("ordinary From Synchronize and signed native webhook do not become explicit source Retry", async () => {
  const calls = [];
  await withServer({
    retrySource: async () => { calls.push("retry"); },
    synchronize: async () => { calls.push("from"); return { created: 0, updated: 0, unchanged: 0, failed: 0 }; },
    publishNativeSource: async (id) => { calls.push(["webhook", id]); return { resource_id: refusedMutationId, topic_id: "18", outcome: "resolved" }; },
  }, async ({ address }) => {
    const sync = await fetch(`${address}/operator/synchronize`, {
      method: "POST", redirect: "manual", body: new URLSearchParams({ csrf: operatorCsrfToken(config.operatorPassword) }),
      headers: { Authorization: auth, Origin: config.operatorOrigin, "Content-Type": "application/x-www-form-urlencoded" },
    });
    assert.equal(sync.status, 303);
    const raw = JSON.stringify({ post: { current: { id: nativeId, type: "post", status: "published" } } });
    const now = String(Date.now());
    const digest = createHmac("sha256", config.webhookSecret).update(`${raw}${now}`).digest("hex");
    const webhook = await fetch(`${address}/webhooks/ghost`, {
      method: "POST", body: raw,
      headers: { "Content-Type": "application/json", "X-Ghost-Signature": `sha256=${digest}, t=${now}` },
    });
    assert.equal(webhook.status, 200);
    assert.deepEqual(calls, ["from", ["webhook", nativeId]]);
  });
});

function refusedSource() {
  const article = "<p>Source article retained privately.</p>";
  const body = {
    mutation_id: refusedMutationId,
    bridge_record: {
      direction: "to_discourse", external_id: `ghost-post:${nativeId}`,
      canonical_url: `${config.ghostOrigin}/native-source/`,
      title: "Native source", content_html: article, published: true, visibility: "unlisted",
      adapter_id: "ghost-discussion-bridge", adapter_version: "0.4.0-alpha.1",
      source_revision: "44444444-4444-4444-8444-444444444444", expected_source_revision: null,
      source_created_at: null, source_updated_at: null,
      source_content_sha256: createHash("sha256").update(article).digest("hex"),
      source_content_bytes: Buffer.byteLength(article), representation: { kind: "full" },
    },
  };
  return {
    canonical_url: body.bridge_record.canonical_url, outcome: "attention",
    failure_reason: "Ghost invalid_field: receiver rejected this exact source request",
    cms_source: {
      intent: {
        body,
        rejection_outcome: {
          route_id: "V4-02", status: 422, code: "invalid_field",
          service_origin: config.serverUrl, connection_id: config.connectionId,
          mutation_id: refusedMutationId,
          request_sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
          envelope: {
            outcome: "rejected", code: "invalid_field", retryable: false,
            retry_after_seconds: null, correlation_id: null, core_fallback: false,
          },
        },
      },
    },
  };
}

function pageForSource(item, key = `ghost-post:${nativeId}`) {
  const current = initialState();
  current.posts[key] = item;
  return renderOperatorPage(config, current);
}

function sourceRetryForms(html) {
  return [...html.matchAll(/<form\b[^>]*action="\/discussionbridge\/operator\/retry-source"[^>]*>[\s\S]*?<\/form>/gu)].map(([form]) => form);
}

test("known source-specific To02 refusal renders one protected Retry with exact hidden intent", () => {
  const html = pageForSource(refusedSource());
  const forms = sourceRetryForms(html);
  assert.equal(forms.length, 1);
  assert.match(html, /Source delivery needs attention/u);
  assert.match(forms[0], /method="post"/u);
  assert.match(forms[0], /Retry this source/u);
  const fields = [...forms[0].matchAll(/<input\b[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/gu)].map(([, name, value]) => [name, value]);
  assert.deepEqual(fields, [
    ["csrf", operatorCsrfToken(config.operatorPassword)],
    ["native_id", nativeId],
    ["refused_mutation_id", refusedMutationId],
  ]);
  assert.doesNotMatch(forms[0], /name="(?:actor|source_revision|force|attestation)"/u);
});

test("missing historical full Error envelope does not hide an otherwise witnessed definitive refusal", () => {
  const item = refusedSource();
  delete item.cms_source.intent.rejection_outcome.envelope;
  assert.equal(sourceRetryForms(pageForSource(item)).length, 1);
  item.cms_source.intent.rejection_outcome = { route_id: "V4-02", status: 422, code: "invalid_field" };
  assert.equal(sourceRetryForms(pageForSource(item)).length, 1);
});

test("source Retry UI does not infer known refusal from a generic failure or unrelated rejected operation", () => {
  const variants = [
    ["generic failure only", (item) => { delete item.cms_source.intent.rejection_outcome; }],
    ["uncertain outcome", (item) => { item.outcome = "reconciliation_required"; delete item.cms_source.intent.rejection_outcome; }],
    ["different operation", (item) => { item.cms_source.intent.rejection_outcome.route_id = "V4-29"; }],
    ["different error", (item) => { item.cms_source.intent.rejection_outcome.code = "content_preservation_unavailable"; }],
    ["different status", (item) => { item.cms_source.intent.rejection_outcome.status = 409; }],
    ["different receiver", (item) => { item.cms_source.intent.rejection_outcome.service_origin = "https://other-forum.example"; }],
    ["different connection", (item) => { item.cms_source.intent.rejection_outcome.connection_id = `dbc_${"b".repeat(24)}`; }],
    ["different intent", (item) => { item.cms_source.intent.rejection_outcome.mutation_id = "22222222-2222-4222-8222-222222222222"; }],
    ["different exact request", (item) => { item.cms_source.intent.rejection_outcome.request_sha256 = "0".repeat(64); }],
    ["missing intent", (item) => { delete item.cms_source.intent; }],
    ["withdrawal retained", (item) => { item.cms_source.withdrawal = { state: "pending" }; }],
    ["source move pending", (item) => { item.cms_source.source_url_move = { intent: { mutation_id: refusedMutationId } }; }],
  ];
  for (const [name, alter] of variants) {
    const item = refusedSource(); alter(item);
    assert.equal(sourceRetryForms(pageForSource(item)).length, 0, name);
  }
  assert.equal(sourceRetryForms(pageForSource(refusedSource(), "ghost-post:not-a-native-id")).length, 0);
  assert.equal(sourceRetryForms(pageForSource(refusedSource(), "ghost-post:abcdefabcdefabcdefabcdef")).length, 0);
});

test("source Retry form and attention copy escape safe labels without publishing private request or diagnostics", () => {
  const item = refusedSource();
  item.failure_reason = '<script>unsafe-label()</script> & "retained"';
  const record = item.cms_source.intent.body.bridge_record;
  record.content_html = "<p>private-article-bytes-do-not-display</p>";
  record.source_content_sha256 = createHash("sha256").update(record.content_html).digest("hex");
  record.source_content_bytes = Buffer.byteLength(record.content_html);
  item.cms_source.intent.rejection_outcome.request_sha256 = createHash("sha256").update(JSON.stringify(item.cms_source.intent.body)).digest("hex");
  item.cms_source.intent.rejection_outcome.envelope.correlation_id = "33333333-3333-4333-8333-333333333333";
  const html = pageForSource(item);
  assert.equal(sourceRetryForms(html).length, 1);
  assert.match(html, /&lt;script&gt;unsafe-label\(\)&lt;\/script&gt; &amp; &quot;retained&quot;/u);
  assert.doesNotMatch(html, /<script>unsafe-label|private-article-bytes-do-not-display|33333333-3333-4333-8333-333333333333/u);
  assert.doesNotMatch(html, new RegExp(config.operatorPassword, "u"));
});
