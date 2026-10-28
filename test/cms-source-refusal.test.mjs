// Pure injected transport/private-evidence checks. No real HTTP/native service.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CmsClient } from "../lib/cms-client.mjs";
import { matchesInvalidFieldRejection } from "../src/source-refusal.mjs";

const config = { serverUrl: "https://forum.example", connectionId: "dbc_0123456789abcdef01234567" };
const secret = "SYNTHETIC-REFUSAL-SECRET";
const mutationId = "11111111-1111-4111-8111-111111111111";
const moveId = "22222222-2222-4222-8222-222222222222";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const html = "<p>Unchanged complete source</p>";
const body = { mutation_id: mutationId, bridge_record: {
  direction: "to_discourse", external_id: `ghost-post:${"a".repeat(24)}`,
  canonical_url: "https://ghost.example/source/", title: "Source", content_html: html,
  published: true, source_revision: "native-edition", expected_source_revision: null,
  source_created_at: null, source_updated_at: null, representation: { kind: "full" },
  source_content_sha256: hash(html), source_content_bytes: Buffer.byteLength(html),
} };
const errorBody = (code = "invalid_field") => ({ outcome: "rejected", code, retryable: false,
  retry_after_seconds: null, correlation_id: "actual-correlation", core_fallback: false });
function fixture(payload = errorBody(), { status = 422, contentType = "application/json", failure } = {}) {
  const calls = [];
  const fetchImplementation = async (address, options) => {
    calls.push({ address, body: options.body, method: options.method });
    if (failure) throw failure;
    const response = new Response(typeof payload === "string" ? payload : JSON.stringify(payload),
      { status, headers: { "Content-Type": contentType } });
    Object.defineProperty(response, "url", { value: address });
    return response;
  };
  const client = new CmsClient({ serviceOrigin: config.serverUrl, connectionId: config.connectionId,
    connectionSecret: secret }, { fetchImplementation });
  return { calls, client, fetchImplementation };
}

test("future actual validated To02 invalid_field422 retains exact private evidence from this client only", async () => {
  const f = fixture();
  await assert.rejects(f.client.resolveSource(body), (error) => {
    assert.equal(error.code, "invalid_field"); assert.equal(error.status, 422);
    assert.equal(error.requestOutcomeUncertain, false); assert.equal(error.retryable, false);
    const witness = f.client.rejectedResponse(error);
    assert.equal(witness.route_id, "V4-02"); assert.equal(witness.code, "invalid_field");
    assert.equal(witness.connection_id, config.connectionId); assert.equal(witness.service_origin, config.serverUrl);
    assert.equal(witness.mutation_id, mutationId); assert.equal(witness.request_sha256, hash(f.calls[0].body));
    assert.deepEqual(witness.envelope, errorBody()); assert.deepEqual(witness.path, {});
    assert.equal(Object.isFrozen(witness), true); assert.equal(Object.isFrozen(witness.envelope), true);
    assert.equal(matchesInvalidFieldRejection(witness, { body }, config), true);
    const other = new CmsClient({ serviceOrigin: config.serverUrl, connectionId: config.connectionId,
      connectionSecret: secret }, { fetchImplementation: f.fetchImplementation });
    assert.equal(other.rejectedResponse(error), undefined);
    assert.ok(!JSON.stringify(witness).includes(secret)); return true;
  });
  assert.equal(f.calls.length, 1);
});

test("malformed HTML/wrong status/invalid Error never manufacture a definitive invalid_field witness", async () => {
  const cases = [
    ["<html>not a typed response</html>", { contentType: "text/html" }],
    [errorBody(), { status: 409 }],
    [{ ...errorBody(), retryable: true }, {}],
    [{ ...errorBody(), unexpected: "not a valid field" }, {}],
    [{ ...errorBody(), core_fallback: true }, {}],
    ["{", {}],
  ];
  for (const [payload, options] of cases) {
    const f = fixture(payload, options);
    await assert.rejects(f.client.resolveSource(body), (error) =>
      error.requestOutcomeUncertain === true && f.client.rejectedResponse(error) === undefined);
    assert.equal(f.calls.length, 1);
  }
});

test("transport failure and a caller-created error retain uncertainty without private refusal evidence", async () => {
  const f = fixture(undefined, { failure: new Error("Synthetic transport loss") });
  await assert.rejects(f.client.resolveSource(body), (error) =>
    error.requestOutcomeUncertain === true && f.client.rejectedResponse(error) === undefined);
  assert.equal(f.client.rejectedResponse(Object.assign(new Error("invalid_field"),
    { code: "invalid_field", status: 422, retryable: false })), undefined);
  assert.equal(f.calls.length, 1);
});

const moveBody = { mutation_id: mutationId, move_id: moveId,
  proof_nonce: Buffer.alloc(32, 7).toString("base64url"), expected_source_revision: "native-edition",
  new_source_revision: "new-native-edition", source_updated_at: null,
  verification: { url: "https://ghost.example/moved/", external_id: body.bridge_record.external_id,
    source_revision: "new-native-edition", source_content_sha256: hash(html),
    native_ownership_receipt_sha256: "a".repeat(64), native_publication_sha256: "b".repeat(64),
    verification_profile: "synthetic-source-proof-transport-only", checked_at: "2026-10-15T00:00:00.000Z" } };
test("invalid_field definitiveness does not expand to To29 or source withdrawal", async () => {
  for (const invoke of [
    (client) => client.finalizeSourceUrlMove(mutationId, moveId, moveBody),
    (client) => client.withdrawSource(mutationId, { mutation_id: moveId, expected_source_revision: "native-edition", reason: "source_unpublished" }),
  ]) {
    const f = fixture();
    await assert.rejects(invoke(f.client), (error) =>
      error.requestOutcomeUncertain === true && f.client.rejectedResponse(error) === undefined);
    assert.equal(f.calls.length, 1);
  }
});

test("existing To29 content-preservation refusal remains definitive with its actual decoded Error", async () => {
  const f = fixture(errorBody("content_preservation_unavailable"));
  await assert.rejects(f.client.finalizeSourceUrlMove(mutationId, moveId, moveBody), (error) => {
    assert.equal(error.requestOutcomeUncertain, false);
    assert.equal(f.client.rejectedResponse(error).envelope.code, "content_preservation_unavailable");
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test("a retained historical actual witness keeps missing Error fields UNKNOWN and checks every known identity", () => {
  const witness = { route_id: "V4-02", status: 422, code: "invalid_field", mutation_id: mutationId };
  const original = structuredClone(witness);
  assert.equal(matchesInvalidFieldRejection(witness, { body }, config), true);
  assert.deepEqual(witness, original); assert.equal(Object.hasOwn(witness, "envelope"), false);
  assert.equal(Object.hasOwn(witness, "correlation_id"), false);
  for (const extra of [
    { service_origin: "https://other.example" }, { connection_id: "dbc_aaaaaaaaaaaaaaaaaaaaaaaa" },
    { mutation_id: moveId }, { request_sha256: "a".repeat(64) }, { path: { resource_id: moveId } },
    { artifact_binding: { wire_version: "other" } }, { route_id: "V4-29" }, { status: 409 },
    { envelope: { code: "revision_conflict" } }, { retryable: true },
  ]) assert.equal(matchesInvalidFieldRejection({ ...witness, ...extra }, { body }, config), false);
});
