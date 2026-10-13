import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Portable build-candidate runtime. Vendor this file and cms-schema.json
// byte-exact together; no sibling checkout or full frozen packet is required.
// Typed checks do not establish actual authority/native ownership/public proof.
export const implementationVersion = '0.3.0-alpha.1';
export const specIdentity = Object.freeze({
  path: 'approved-packet/ADAPTER_PROTOCOL_V2_WIRE_PROPOSAL_20261009.json',
  bytes: 193449,
  sha256: '5ee46f7190308914dd88c27cfad499709a899b517ac11ac6fe362de1f9f8cd8f',
  semanticsPath: 'approved-packet/ADAPTER_PROTOCOL_V2_WIRE_SPECIFICATION_20261009.md',
  semanticsBytes: 75343,
  semanticsSha256: '56f327cf5a9815b65c003a2fd42723c89946f6456905161d497d30dd8b1399e7',
});
export const cmsSchemaIdentity = Object.freeze({
  path: 'cms-schema.json',
  sha256: 'b5ce03ac60379a60e9adc3b4193b9f49e9f6c0687010a91a138577d4cbf95760',
});
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const schemaBytes = readFileSync(new URL('./cms-schema.json', import.meta.url));
if (hash(schemaBytes) !== cmsSchemaIdentity.sha256) throw new Error('CMS extracted grammar identity mismatch');
const extracted = JSON.parse(schemaBytes.toString('utf8'));
const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};
export const cmsSchema = deepFreeze({
  types: extracted.types,
  routes: extracted.routes,
  transport: extracted.transport,
  bounds: extracted.bounds,
  errors: extracted.errors,
  workTransitions: extracted.work_transitions,
});
const routes = cmsSchema.routes;
const errorSpecs = new Map(cmsSchema.errors.map((error) => [error.code, error]));

export class CmsValidationError extends Error {
  constructor(code, path = '$') {
    // Do not include untrusted input, credentials, lease tokens or raw errors.
    super(`CMS ${code} at ${path}`);
    this.name = 'CmsValidationError';
    this.code = code;
    this.path = path;
    this.http = errorSpecs.get(code)?.http ?? 422;
  }
}
const fail = (path, code = 'invalid_field') => { throw new CmsValidationError(code, path); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const utf8Bytes = (value, path) => {
  // JSON \u escapes must not smuggle lone surrogates into a replacement-byte
  // identity. Round-trip UTF8 must preserve the decoded string exactly.
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.toString('utf8') !== value) fail(path);
  return bytes;
};
const validUrl = (value, path) => {
  const match = /^https:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?$/i.exec(value);
  if (!match || /[\s\p{Cc}]/u.test(value) || match[1].includes('@') || /%(?![a-f\d]{2})/i.test(value)) fail(path);
  let parsed;
  try { parsed = new URL(value); } catch { fail(path); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash) fail(path);
  for (const part of match[2].split('/')) {
    const dots = part.replace(/%2e/gi, '.');
    if (dots === '.' || dots === '..') fail(path);
  }
};
const validInstant = (value, path) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail(path);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail(path);
};
const decode64 = (value, url, path) => {
  const pattern = url ? /^[A-Za-z0-9_-]*$/ : /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!pattern.test(value)) fail(path);
  const bytes = Buffer.from(value, url ? 'base64url' : 'base64');
  if (bytes.toString(url ? 'base64url' : 'base64') !== value) fail(path);
  return bytes;
};
// Syntax-only ingress keeps lexical provenance on the original containers.
// Authenticate and validate that tree before cloning, mutating or extracting
// numeric leaves. A JS Number alone cannot recover its original JSON spelling.
const invalidNumericMembers = new WeakMap();
const numericMember = (container, key) => invalidNumericMembers.get(container)?.has(key) ?? false;
const exactCmsInteger = (token) => {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?)(\d+))?$/.exec(token);
  // All extracted CMS numeric types are nonnegative integers or nonnegative
  // integer enums; negative zero is invalid regardless of exponent spelling.
  if (!match || match[1] === '-') return undefined;
  const fraction = match[3] ?? '';
  const digits = match[2] + fraction;
  let first = 0;
  while (first < digits.length && digits[first] === '0') first++;
  if (first === digits.length) return 0;
  let end = digits.length;
  while (digits[end - 1] === '0') end--;
  const significant = digits.slice(first, end);
  // Once an exponent exceeds this bound, neither integrality nor safe range
  // can be rescued by the finite mantissa. Never allocate 10**exponent/BigInt.
  const exponentLimit = token.length + 17;
  let exponent = 0;
  for (const digit of match[5] ?? '') {
    exponent = Math.min(exponentLimit, exponent * 10 + digit.charCodeAt(0) - 48);
    if (exponent === exponentLimit) break;
  }
  if (match[4] === '-') exponent = -exponent;
  const scale = exponent - fraction.length + digits.length - end;
  const length = significant.length + scale;
  if (scale < 0 || length > 16) return undefined;
  const canonical = significant + '0'.repeat(scale); // At most sixteen digits.
  if (length === 16 && canonical > '9007199254740991') return undefined;
  return Number(canonical);
};
export const semanticIdentity = (value) => {
  if (value && typeof value === 'object' && invalidNumericMembers.get(value)?.size) fail('$');
  if (Array.isArray(value)) return `[${value.map(semanticIdentity).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${semanticIdentity(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const checkString = (name, spec, value, path) => {
  if (typeof value !== 'string') fail(path);
  const bytes = utf8Bytes(value, path).length;
  if (bytes < (spec.utf8_minimum_bytes ?? 0) || bytes > (spec.utf8_maximum_bytes ?? Infinity)) fail(path);
  if (spec.pattern && !new RegExp(spec.pattern).test(value)) fail(path);
  if (spec.control_characters === 'reject' && /\p{Cc}/u.test(value)) fail(path);
  if (['OpaqueId', 'Revision', 'Label', 'Title'].includes(name) && !value.trim()) fail(path);
  if (name === 'UUID' && value === '00000000-0000-0000-0000-000000000000') fail(path);
  if (name === 'CoreId' && BigInt(value) > 9223372036854775807n) fail(path);
  if (name === 'Instant') validInstant(value, path);
  if (name === 'Url') validUrl(value, path);
  if (['Base64', 'Base64Url', 'LeaseToken', 'PublicNonce'].includes(name)) {
    const decoded = decode64(value, name !== 'Base64', path);
    if (spec.decoded_bytes !== undefined && decoded.length !== spec.decoded_bytes) fail(path);
  }
};
const checkShape = (name, value, path, invalidNumeric = false) => {
  if (invalidNumeric) fail(path);
  const spec = cmsSchema.types[name];
  if (!spec) throw new Error(`Unavailable CMS type: ${name}`);
  switch (spec.kind) {
    case 'string': checkString(name, spec, value, path); break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < spec.minimum || value > spec.maximum) fail(path);
      break;
    case 'boolean': if (typeof value !== 'boolean') fail(path); break;
    case 'enum': if (!spec.values.some((item) => Object.is(value, item))) fail(path); break;
    case 'array': {
      if (!Array.isArray(value) || value.length < (spec.minimum_items ?? 0) || value.length > (spec.maximum_items ?? Infinity)) fail(path);
      value.forEach((item, index) => checkShape(spec.items, item, `${path}[${index}]`, numericMember(value, index)));
      if (spec.unique_items && new Set(value.map(semanticIdentity)).size !== value.length) fail(path);
      break;
    }
    case 'object': {
      if (!object(value)) fail(path);
      // Normative validation stage checks typed fields in declaration order.
      for (const [field, rule] of Object.entries(spec.fields)) {
        if (!Object.hasOwn(value, field)) {
          if (rule.required) fail(`${path}.${field}`);
        } else if (value[field] === null) {
          if (!rule.nullable) fail(`${path}.${field}`);
        } else checkShape(rule.type, value[field], `${path}.${field}`, numericMember(value, field));
      }
      if (Object.keys(value).some((field) => !Object.hasOwn(spec.fields, field))) fail(path, 'unknown_field');
      break;
    }
    case 'tagged_union': {
      if (!object(value) || !Object.hasOwn(value, spec.field) || typeof value[spec.field] !== 'string' || !Object.hasOwn(spec.variants, value[spec.field])) fail(`${path}.${spec.field}`);
      checkShape(spec.variants[value[spec.field]], value, path);
      break;
    }
    default: throw new Error(`Unsupported CMS grammar kind: ${spec.kind}`);
  }
};
// These checks require only the declared value. Rules involving current scope,
// stored objects, policy, leases or actual native/public state are not inferred.
const checkSemantics = (name, value, path) => {
  const spec = cmsSchema.types[name];
  if (spec.kind === 'object') {
    for (const [field, rule] of Object.entries(spec.fields)) {
      if (Object.hasOwn(value, field) && value[field] !== null) checkSemantics(rule.type, value[field], `${path}.${field}`);
    }
    if (value.source_created_at != null && value.source_updated_at != null && value.source_updated_at < value.source_created_at) fail(`${path}.source_updated_at`);
  } else if (spec.kind === 'array') value.forEach((item, index) => checkSemantics(spec.items, item, `${path}[${index}]`));
  else if (spec.kind === 'tagged_union') checkSemantics(spec.variants[value[spec.field]], value, path);
  if (name === 'SourceAuthors' && new Set(value.map((item) => item.id)).size !== value.length) fail(path);
  if (name === 'ToRecord') {
    if (value.primary_source_author_id !== undefined && !(value.source_authors ?? []).some((author) => author.id === value.primary_source_author_id)) fail(`${path}.primary_source_author_id`);
    const content = Buffer.from(value.content_html, 'utf8');
    if (value.representation.kind === 'full' && (content.length !== value.source_content_bytes || hash(content) !== value.source_content_sha256)) fail(`${path}.source_content_sha256`, 'content_hash_mismatch');
    if (value.representation.kind === 'bounded_excerpt' && (value.source_content_bytes <= 49152 || value.representation.read_more_url !== value.canonical_url)) fail(`${path}.representation`);
  }
  if (name === 'SourceFeedQuery' && value.stream === 'changes' && value.cursor === undefined) fail(`${path}.cursor`);
  if (name === 'SourceFeed') {
    if (value.stream === 'initial' && ((value.next_cursor === null) === (value.checkpoint_cursor === null))) fail(`${path}.checkpoint_cursor`);
    if (value.stream === 'changes' && value.checkpoint_cursor === null) fail(`${path}.checkpoint_cursor`);
  }
  if (name === 'ContentChunk') {
    const length = decode64(value.content_base64, false, `${path}.content_base64`).length;
    const end = value.offset + length;
    if (length > 32768 || !Number.isSafeInteger(end) || end > value.content_bytes ||
      (value.next_offset === null ? end !== value.content_bytes : value.next_offset !== end || end <= value.offset || end >= value.content_bytes)) fail(`${path}.next_offset`);
  }
  if (name === 'Policy') {
    if ((value.selection === 'categories') !== (value.category_ids.length > 0)) fail(`${path}.category_ids`);
    if (value.include_topic_ids.some((id) => value.exclude_topic_ids.includes(id))) fail(`${path}.exclude_topic_ids`);
    if (value.existing_record_adoption === 'disabled' && value.adoptable_resource_ids.length) fail(`${path}.adoptable_resource_ids`);
  }
  if (name === 'Connection') {
    const url = new URL(value.destination_origin);
    if (url.pathname !== '/' || url.search || /[?#]/.test(value.destination_origin)) fail(`${path}.destination_origin`);
  }
  if (name === 'Work' && ((value.action === 'withdraw') !== (value.source_revision === null) || value.attempt > 3)) fail(path);
  if (name === 'Lease') {
    if (value.lease_generation !== value.work.lease_generation || value.expires_at <= value.server_time) fail(`${path}.lease_generation`);
  }
  if (name === 'Failure' || name === 'Error') {
    const error = errorSpecs.get(value.code);
    if (name === 'Error' && value.retryable !== error.retryable) fail(`${path}.retryable`);
    if (value.retry_after_seconds !== null && (!error.retryable || value.retry_after_seconds < 1 || value.retry_after_seconds > 3600)) fail(`${path}.retry_after_seconds`);
  }
  if (name === 'PublishedVerification' && value.source_content_sha256 !== value.representation.source_content_sha256) fail(`${path}.representation.source_content_sha256`);
  if (name === 'SourceUrlMoveFinalize' && (value.new_source_revision === value.expected_source_revision || value.verification.source_revision !== value.new_source_revision)) fail(`${path}.new_source_revision`);
  if (name === 'ResolveResult') {
    const conflict = value.outcome === 'reconciliation_required';
    const protectedFields = ['resource_id', 'topic_id', 'topic_url', 'source_revision', 'synchronized_at'];
    if (protectedFields.some((field) => (value[field] === null) !== conflict)) fail(path);
    const reasons = ['identity_conflict', 'canonical_url_conflict', 'native_ownership_conflict', 'adoption_unavailable'];
    if (conflict !== reasons.includes(value.reason)) fail(`${path}.reason`);
  }
};

export function validateCms(name, value) {
  checkShape(name, value, '$');
  checkSemantics(name, value, '$');
  return value;
}
export function applyCmsDefaults(name, value) {
  validateCms(name, value);
  const apply = (type, input) => {
    const spec = cmsSchema.types[type];
    if (spec.kind === 'object') return Object.fromEntries(Object.entries(spec.fields).flatMap(([field, rule]) =>
      Object.hasOwn(input, field) ? [[field, input[field] === null ? null : apply(rule.type, input[field])]] :
        Object.hasOwn(rule, 'default') ? [[field, rule.default]] : []));
    if (spec.kind === 'array') return input.map((item) => apply(spec.items, item));
    if (spec.kind === 'tagged_union') return apply(spec.variants[input[spec.field]], input);
    return input;
  };
  return apply(name, value);
}

// Strict JSON parser retains duplicate-key detection at every depth. The
// browser/native caller still owns HTTP media, encoding and origin enforcement.
export function parseCmsJson(raw, { maximumBytes = 65536, rejectInvalidNumbers = true } = {}) {
  if (typeof rejectInvalidNumbers !== 'boolean') throw new TypeError('CMS numeric parser mode must be boolean');
  let bytes;
  try { bytes = typeof raw === 'string' ? utf8Bytes(raw, '$') : Buffer.from(raw); }
  catch { fail('$', 'invalid_json'); }
  if (bytes.length > maximumBytes) fail('$', 'body_too_large');
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) fail('$', 'invalid_json');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('$', 'invalid_json'); }
  let at = 0;
  let invalidNumberSeen = false;
  const whitespace = () => { while (/[\x20\x09\x0a\x0d]/.test(text[at] ?? '\u0000')) at++; };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      if (text[at] === '\\') { at += 2; continue; }
      if (text[at++] === '"') {
        let result;
        try { result = JSON.parse(text.slice(start, at)); } catch { fail('$', 'invalid_json'); }
        try { utf8Bytes(result, '$'); } catch { fail('$', 'invalid_json'); }
        return result;
      }
    }
    fail('$', 'invalid_json');
  };
  const value = (container, key) => {
    whitespace();
    if (text[at] === '"') return string();
    if (text[at] === '{') {
      at++; whitespace();
      const result = Object.create(null);
      if (text[at] === '}') { at++; return result; }
      for (;;) {
        if (text[at] !== '"') fail('$', 'invalid_json');
        const key = string();
        if (Object.hasOwn(result, key)) fail('$', 'invalid_json');
        whitespace();
        if (text[at++] !== ':') fail('$', 'invalid_json');
        result[key] = value(result, key); whitespace();
        if (text[at] === '}') { at++; return result; }
        if (text[at++] !== ',') fail('$', 'invalid_json');
        whitespace();
      }
    }
    if (text[at] === '[') {
      at++; whitespace();
      const result = [];
      if (text[at] === ']') { at++; return result; }
      for (;;) {
        result.push(value(result, result.length)); whitespace();
        if (text[at] === ']') { at++; return result; }
        if (text[at++] !== ',') fail('$', 'invalid_json');
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at))?.[0];
    if (!token) fail('$', 'invalid_json');
    at += token.length;
    if (/^[-\d]/.test(token)) {
      const exact = exactCmsInteger(token);
      if (exact !== undefined) return exact;
      invalidNumberSeen = true;
      if (container) {
        if (!invalidNumericMembers.has(container)) invalidNumericMembers.set(container, new Set());
        invalidNumericMembers.get(container).add(key);
      }
    }
    return JSON.parse(token);
  };
  try {
    const result = value(); whitespace();
    if (at !== text.length || !object(result)) fail('$', 'invalid_json');
    // Complete syntax/duplicates/root shape win over numeric typed semantics.
    // Servers may defer this stage until after authentication, using the same
    // annotated tree (or reparsing the retained raw body with this default).
    if (rejectInvalidNumbers && invalidNumberSeen) fail('$');
    return result;
  } catch (error) {
    if (error instanceof CmsValidationError) throw error;
    fail('$', 'invalid_json');
  }
}

export function parseCmsQuery(type, raw = '') {
  const spec = type === null ? { fields: {} } : cmsSchema.types[type];
  if (!spec || spec.kind !== 'object' && type !== null || typeof raw !== 'string') fail('$.query');
  const result = Object.create(null);
  if (raw) for (const member of raw.split('&')) {
    if (!member) fail('$.query');
    const equals = member.indexOf('=');
    const decode = (value) => {
      try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { fail('$.query'); }
    };
    const key = decode(equals < 0 ? member : member.slice(0, equals));
    let value = decode(equals < 0 ? '' : member.slice(equals + 1));
    if (!Object.hasOwn(spec.fields, key)) fail('$.query', 'unknown_field');
    if (Object.hasOwn(result, key)) fail('$.query');
    const fieldSpec = cmsSchema.types[spec.fields[key].type];
    if (fieldSpec.kind === 'integer') {
      if (!/^(?:0|[1-9]\d*)$/.test(value)) fail('$.query');
      value = Number(value);
    }
    result[key] = value;
  }
  if (type !== null) validateCms(type, result);
  return result;
}

export function parseCmsRequest(id, { rawBody, mediaType, contentEncoding, queryString = '', path = {}, method } = {}) {
  const route = routes.find((item) => item.id === id);
  if (!route) throw new Error('Unavailable CMS route');
  if (method !== undefined && method !== route.method) fail('$');
  let body;
  if (route.method === 'POST') {
    if (typeof mediaType !== 'string' || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:UTF-8|"UTF-8"))?\s*$/i.test(mediaType)) fail('$', 'unsupported_media_type');
    if (contentEncoding !== undefined && String(contentEncoding).toLowerCase() !== 'identity') fail('$', 'unsupported_media_type');
    body = parseCmsJson(rawBody, { rejectInvalidNumbers: false });
  } else if (rawBody !== undefined && Buffer.byteLength(rawBody) !== 0) fail('$');
  const query = parseCmsQuery(route.query, queryString);
  validateCmsRoute(id, { body, query, path, method });
  return { body, query };
}

export function validateCmsResponse(id, value, status) {
  const route = routes.find((item) => item.id === id);
  if (!route) throw new Error('Unavailable CMS route');
  if (status === 204 && route.success_http.includes(204)) {
    if (value !== undefined) fail('$');
    return value;
  }
  if (route.success_http.includes(status)) validateCms(route.response, value);
  else if (value?.outcome === 'rejected') {
    validateCms('Error', value);
    if (errorSpecs.get(value.code).http !== status) fail('$');
  } else if (id === 'V2-02' && status === 409 && value?.outcome === 'reconciliation_required') validateCms('ResolveResult', value);
  else fail('$');
  const maximum = route.response === 'ContentChunk' ? 65536 : 262144;
  if (Buffer.byteLength(JSON.stringify(value)) > maximum) fail('$', 'metadata_unavailable');
  return value;
}

export function validateCmsRoute(id, { body, query = {}, path = {}, method } = {}) {
  const route = routes.find((item) => item.id === id);
  if (!route) throw new Error('Unavailable CMS route');
  if (method !== undefined && method !== route.method) fail('$');
  if (route.input) validateCms(route.input, body);
  else if (body !== undefined) fail('$');
  if (route.query) validateCms(route.query, query);
  else if (!object(query) || Object.keys(query).length) fail('$.query', 'unknown_field');
  for (const key of [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])) {
    validateCms(['source_id'].includes(key) ? 'OpaqueId' : key === 'source_revision' ? 'Revision' : 'UUID', path[key]);
    const bodyValue = body?.[key] ?? body?.authority?.[key];
    if (bodyValue !== undefined && bodyValue !== path[key]) fail(`$.${key}`, 'identity_conflict');
  }
  return route;
}

export function nativeOwnershipReceiptSha256(receipt) {
  validateCms('NativeOwnershipReceipt', receipt);
  const parts = [];
  for (const field of Object.keys(cmsSchema.types.NativeOwnershipReceipt.fields)) {
    const value = receipt[field];
    const length = Buffer.alloc(4);
    if (value === null) length.writeUInt32BE(0xffffffff);
    else {
      const bytes = Buffer.from(String(value), 'utf8');
      length.writeUInt32BE(bytes.length);
      parts.push(length, bytes);
      continue;
    }
    parts.push(length);
  }
  return hash(Buffer.concat(parts));
}

export function cmsWorkTransition(state, event) {
  const transition = cmsSchema.workTransitions.find((item) => item.from === state && item.event === event);
  if (!transition) fail('$', 'invalid_transition');
  return transition.to;
}

export function cmsRetryDelay(code, attempt, retryAfterSeconds = null) {
  validateCms('UInt', attempt);
  if (attempt < 1 || attempt > 3 || !errorSpecs.has(code)) fail('$');
  const transient = ['rate_limited', 'transport_timeout', 'native_service_unavailable'].includes(code);
  if (retryAfterSeconds !== null && (!transient || !Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 3600)) fail('$');
  return transient && attempt < 3 ? Math.max([30, 120][attempt - 1], retryAfterSeconds ?? 0) : null;
}
