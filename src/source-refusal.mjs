import { createHash } from "node:crypto";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const known = (value, key) => object(value) && Object.hasOwn(value, key) && value[key] !== undefined;

// This reserved private outcome is written from the client's actual validated
// response witness. Generic failure text/error flags are never imported into it.
// Older witnessed refusals may lack diagnostics; absent fields stay UNKNOWN.
export function matchesInvalidFieldRejection(evidence, intent, config) {
  if (!object(evidence) || !object(intent?.body) || evidence.route_id !== "V4-02" || evidence.status !== 422) return false;
  const envelope = evidence.envelope;
  if (envelope !== undefined && envelope !== null && !object(envelope)) return false;
  const code = evidence.code ?? envelope?.code;
  if (code !== "invalid_field" || known(envelope, "code") && envelope.code !== code) return false;
  for (const [key, expected] of [["outcome", "rejected"], ["retryable", false], ["retry_after_seconds", null], ["core_fallback", false]]) {
    if (known(envelope, key) && envelope[key] !== expected || known(evidence, key) && evidence[key] !== expected) return false;
  }
  for (const [key, expected] of [
    ["service_origin", config.serverUrl], ["connection_id", config.connectionId],
    ["mutation_id", intent.body.mutation_id], ["request_sha256", hash(JSON.stringify(intent.body))],
  ]) if (known(evidence, key) && evidence[key] !== expected) return false;
  if (known(evidence, "path") && (!object(evidence.path) || Object.keys(evidence.path).length !== 0)) return false;
  if (known(evidence.artifact_binding, "wire_version") && evidence.artifact_binding.wire_version !== "v4") return false;
  return true;
}

export function matchesPreservationRejection(evidence, intent, config) {
  return evidence?.route_id === "V4-02" && evidence.status === 422 && evidence.service_origin === config.serverUrl &&
    evidence.mutation_id === intent?.body?.mutation_id && evidence.request_sha256 === hash(JSON.stringify(intent.body)) &&
    evidence.envelope?.outcome === "rejected" && evidence.envelope.code === "content_preservation_unavailable" && evidence.envelope.retryable === false && evidence.envelope.retry_after_seconds === null && evidence.envelope.core_fallback === false;
}

export function sourceRejectionCode(evidence, intent, config) {
  if (matchesInvalidFieldRejection(evidence, intent, config)) return "invalid_field";
  if (matchesPreservationRejection(evidence, intent, config)) return "content_preservation_unavailable";
  return undefined;
}

export function sourceRetryAvailable(key, item, config) {
  const intent = item?.cms_source?.intent, record = intent?.body?.bridge_record;
  return /^ghost-post:[a-f0-9]{24}$/u.test(key) && record?.direction === "to_discourse" && record.external_id === key &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(intent.body.mutation_id ?? "") && intent.body.mutation_id !== "00000000-0000-0000-0000-000000000000" &&
    typeof record.canonical_url === "string" && (!item.canonical_url || item.canonical_url === record.canonical_url) &&
    !item.cms_source.withdrawal && !item.cms_source.source_url_move &&
    matchesInvalidFieldRejection(intent.rejection_outcome, intent, config);
}
