import { createHash } from 'node:crypto';
import * as codec from './cms-runtime.mjs';
import { assertCmsVendor, sourceArtifactIdentity } from './cms-vendor.mjs';
import { createCmsHttpsTransport } from './cms-https-transport.mjs';
import {
  cmsSchema, CmsValidationError, parseCmsJson, validateCms, validateCmsRoute, validateCmsResponse,
} from './cms-runtime.mjs';

// Sole current V4 typed transport. No scheduler, native write, scope
// grant, fencing, ownership adoption or public verification happens here.
const READS = new Set(cmsSchema.routes.filter((route) => route.method === 'GET').map((route) => route.id));
const MUTATIONS = new Set(cmsSchema.routes.filter((route) => route.method === 'POST').map((route) => route.id));
const prepared = new WeakMap();
const definitiveRejections = new WeakMap();
const mediaType = /^application\/json(?:\s*;\s*charset\s*=\s*(?:UTF-8|"UTF-8"))?\s*$/i;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const segment = (value) => value === '.' ? '%2E' : value === '..' ? '%2E%2E' : encodeURIComponent(value);

export class CmsClientError extends Error {
  constructor(code, { status = null, retryable = false, retryAfterSeconds = null, requestOutcomeUncertain = false } = {}) {
    // Raw response/exception text and request headers are never diagnostics.
    super(`CMS request failed: ${code}`);
    this.name = 'CmsClientError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
    this.requestOutcomeUncertain = requestOutcomeUncertain;
  }
}
const rejected = (code = 'invalid_field') => { throw new CmsClientError(code); };
const cancel = (body) => { try { void Promise.resolve(body?.cancel()).catch(() => {}); } catch {} };
const duration = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 60_000;

export class CmsClient {
  #origin;
  #connectionId;
  #secret;
  #fetch;
  #connectTimeout;
  #responseTimeout;

  constructor({ serviceOrigin, connectionId, connectionSecret }, {
    fetchImplementation, connectTimeoutMs = 10_000, responseTimeoutMs = 10_000,
  } = {}) {
    assertCmsVendor();
    if (Object.keys(arguments[1] ?? {}).some((key) => !['fetchImplementation', 'connectTimeoutMs', 'responseTimeoutMs'].includes(key))) rejected();
    validateCms('Url', serviceOrigin);
    const origin = new URL(serviceOrigin);
    if (origin.pathname !== '/' || origin.search || /[?#]/.test(serviceOrigin)) rejected();
    validateCms('ConnectionId', connectionId);
    if (typeof connectionSecret !== 'string' || !connectionSecret.trim() || /[\p{Cc}\r\n]/u.test(connectionSecret)) rejected();
    if (fetchImplementation !== undefined && typeof fetchImplementation !== 'function' || !duration(connectTimeoutMs) || !duration(responseTimeoutMs)) rejected();
    this.#origin = origin.origin;
    this.#connectionId = connectionId;
    this.#secret = connectionSecret;
    this.#fetch = fetchImplementation ?? createCmsHttpsTransport(this.#origin);
    // Header deadline includes TCP/TLS connection, upload and response headers;
    // a separate deadline covers the entire response body, including slow reads.
    this.#connectTimeout = connectTimeoutMs;
    this.#responseTimeout = responseTimeoutMs;
  }

  get codec() { return codec; }

  // Evidence exists only after this client validated the actual HTTP response.
  // A caller-created error/code/retryable flag is not a definitive receipt.
  rejectedResponse(error) {
    const known = definitiveRejections.get(error);
    return known?.client === this ? known.evidence : undefined;
  }

  prepareMutation(routeId, body, path = {}) {
    if (!MUTATIONS.has(routeId)) rejected('invalid_transition');
    codec.validateCmsRoute(routeId, { body, path });
    const bytes = Buffer.from(JSON.stringify(body), 'utf8');
    if (bytes.length > 65_536) rejected('body_too_large');
    // Snapshot and validate the actual bytes sent, rather than holding mutable
    // caller objects or trusting custom JSON serialization.
    const snapshot = codec.parseCmsJson(bytes);
    const pathSnapshot = codec.parseCmsJson(JSON.stringify(path));
    codec.validateCmsRoute(routeId, { body: snapshot, path: pathSnapshot });
    const packet = Object.freeze({ routeId, mutationId: snapshot.mutation_id });
    prepared.set(packet, { client: this, routeId, body: bytes.toString('utf8'), path: pathSnapshot });
    return packet;
  }

  async execute(packet) {
    const operation = prepared.get(packet);
    if (!operation || operation.client !== this) rejected();
    // Calling execute again sends the identical mutation ID, path and bytes.
    // Recovery callers durably retain the same body/context outside this client.
    return this.#request(operation.routeId, { body: operation.body, path: operation.path });
  }

  connection() { return this.#read('V4-01'); }
  sourceRecords(query = {}) { return this.#read('V4-03', { query }); }
  sourceRecord(resourceId) { return this.#read('V4-04', { path: { resource_id: resourceId } }); }
  policy() { return this.#read('V4-08'); }
  sources(query) { return this.#read('V4-06', { query }); }
  contentChunk(sourceId, sourceRevision, offset = 0) {
    return this.#read('V4-07', { path: { source_id: sourceId, source_revision: sourceRevision }, query: { offset } });
  }
  mappings(query = {}) { return this.#read('V4-10', { query }); }
  mapping(mappingId) { return this.#read('V4-11', { path: { mapping_id: mappingId } }); }
  urlHistory(mappingId, query = {}) { return this.#read('V4-12', { path: { mapping_id: mappingId }, query }); }
  work(workId) { return this.#read('V4-14', { path: { work_id: workId } }); }
  catalog(query) { return this.#read('V4-27', { query }); }
  resolveSource(body) { return this.execute(this.prepareMutation('V4-02', body)); }
  withdrawSource(resourceId, body) { return this.execute(this.prepareMutation('V4-05', body, { resource_id: resourceId })); }
  prepareMapping(body) { return this.execute(this.prepareMutation('V4-09', body)); }
  claim(body) { return this.execute(this.prepareMutation('V4-13', body)); }
  renew(workId, body) { return this.execute(this.prepareMutation('V4-15', body, { work_id: workId })); }
  acknowledge(workId, body) { return this.execute(this.prepareMutation('V4-16', body, { work_id: workId })); }
  fail(workId, body) { return this.execute(this.prepareMutation('V4-17', body, { work_id: workId })); }
  prepareUrlMove(mappingId, body) { return this.execute(this.prepareMutation('V4-21', body, { mapping_id: mappingId })); }
  finalizeUrlMove(mappingId, moveId, body) { return this.execute(this.prepareMutation('V4-22', body, { mapping_id: mappingId, move_id: moveId })); }
  abortUrlMove(mappingId, moveId, body) { return this.execute(this.prepareMutation('V4-23', body, { mapping_id: mappingId, move_id: moveId })); }
  beginCatalog(body) { return this.execute(this.prepareMutation('V4-24', body)); }
  catalogPage(uploadId, body) { return this.execute(this.prepareMutation('V4-25', body, { upload_id: uploadId })); }
  finalizeCatalog(uploadId, body) { return this.execute(this.prepareMutation('V4-26', body, { upload_id: uploadId })); }

  prepareStatic(workId, body) { return this.execute(this.prepareMutation('V4-18', body, { work_id: workId })); }
  finalizeStatic(workId, body) { return this.execute(this.prepareMutation('V4-19', body, { work_id: workId })); }
  abortStatic(workId, body) { return this.execute(this.prepareMutation('V4-20', body, { work_id: workId })); }
  prepareSourceUrlMove(resourceId, body) { return this.execute(this.prepareMutation('V4-28', body, { resource_id: resourceId })); }
  finalizeSourceUrlMove(resourceId, moveId, body) { return this.execute(this.prepareMutation('V4-29', body, { resource_id: resourceId, move_id: moveId })); }
  abortSourceUrlMove(resourceId, moveId, body) { return this.execute(this.prepareMutation('V4-30', body, { resource_id: resourceId, move_id: moveId })); }
  sourceUrlHistory(resourceId, query = {}) { return this.#read('V4-31', { path: { resource_id: resourceId }, query }); }
  attentionCapability() { return this.#read('V4-32'); }
  attentionInspections(query = {}) { return this.#read('V4-33', { query }); }
  reportAttention(inspectionId, body) { return this.execute(this.prepareMutation('V4-34', body, { inspection_id: inspectionId })); }
  attentionRecoveries(query = {}) { return this.#read('V4-35', { query }); }
  claimRecovery(recoveryId, body) { return this.execute(this.prepareMutation('V4-36', body, { recovery_id: recoveryId })); }

  async completeSource(source, { beforeChunk = async () => {} } = {}) {
    validateCms('Source', source);
    source = parseCmsJson(JSON.stringify(source));
    validateCms('Source', source);
    if (typeof beforeChunk !== 'function') rejected();
    const chunks = [];
    let offset = 0;
    for (;;) {
      // The future worker supplies current authority/renewal checks here. This
      // transport helper cannot infer lease or native fencing authority itself.
      await beforeChunk();
      const chunk = await this.contentChunk(source.source_id, source.source_revision, offset);
      if (chunk.source_id !== source.source_id || chunk.source_revision !== source.source_revision ||
          chunk.offset !== offset || chunk.content_bytes !== source.content_bytes || chunk.content_sha256 !== source.content_sha256) {
        rejected('content_hash_mismatch');
      }
      const bytes = Buffer.from(chunk.content_base64, 'base64');
      chunks.push(bytes);
      offset += bytes.length;
      if (chunk.next_offset === null) break;
    }
    let bytes;
    try { bytes = Buffer.concat(chunks, offset); } catch { rejected('storage_exhausted'); }
    if (offset !== source.content_bytes || digest(bytes) !== source.content_sha256) rejected('content_hash_mismatch');
    let html;
    try { html = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { rejected('content_hash_mismatch'); }
    // Complete immutable bytes, not an excerpt or native publication result.
    return { bytes, html };
  }

  #read(routeId, { path = {}, query = {} } = {}) {
    if (!READS.has(routeId)) rejected('invalid_transition');
    validateCmsRoute(routeId, { path, query });
    return this.#request(routeId, { path, query });
  }

  async #request(routeId, { body, path = {}, query = {} }) {
    const route = codec.cmsSchema.routes.find((item) => item.id === routeId);
    const relative = route.path.replace(/\{([^}]+)\}/g, (_all, field) => segment(path[field]));
    const search = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])).toString();
    const address = `${this.#origin}${relative}${search ? `?${search}` : ''}`;
    // Native HTTPS transports this exact raw encoded path, including dot-only
    // opaque source/revision IDs, without parsing it as a navigable URL path.
    const controller = new AbortController();
    const uncertain = route.method === 'POST';
    let timer, response, reader;
    const timeout = () => new CmsClientError('transport_timeout', { retryable: true, requestOutcomeUncertain: uncertain });
    const deadline = (milliseconds) => new Promise((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(timeout()); }, milliseconds);
    });
    const failure = (code = 'invalid_field') => { throw new CmsClientError(code, { requestOutcomeUncertain: uncertain }); };
    try {
      const arriving = Promise.resolve().then(() => this.#fetch(address, {
        method: route.method, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
        headers: {
          Accept: 'application/json', 'Accept-Encoding': 'identity',
          'X-DiscussionBridge-Connection': this.#connectionId, 'X-DiscussionBridge-Secret': this.#secret,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        }, ...(body === undefined ? {} : { body }),
      })).then((received) => { if (controller.signal.aborted) cancel(received.body); return received; });
      response = await Promise.race([arriving, deadline(this.#connectTimeout)]);
      clearTimeout(timer);
      if (!response || response.redirected || response.url !== address || new URL(response.url).origin !== this.#origin) failure();
      const status = response.status;
      if (!Number.isInteger(status) || status < 200 || status > 599) failure();
      const encoding = response.headers.get('content-encoding');
      if (encoding !== null && encoding.toLowerCase() !== 'identity') failure('unsupported_media_type');
      if (status !== 204 && !mediaType.test(response.headers.get('content-type') ?? '')) failure('unsupported_media_type');
      const maximum = status === 204 ? 0 : route.response === 'ContentChunk' ? 65_536 : 262_144;
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^(?:0|[1-9]\d*)$/.test(declared) || BigInt(declared) > BigInt(maximum))) failure('metadata_unavailable');
      const chunks = [];
      let length = 0;
      const bodyDeadline = deadline(this.#responseTimeout);
      if (response.body) {
        reader = response.body.getReader();
        for (;;) {
          const { done, value } = await Promise.race([reader.read(), bodyDeadline]);
          if (done) break;
          if (!(value instanceof Uint8Array) || value.byteLength > maximum - length) failure('metadata_unavailable');
          chunks.push(value);
          length += value.byteLength;
        }
      }
      const bytes = Buffer.concat(chunks, length);
      const result = status === 204 ? undefined : codec.parseCmsJson(bytes, { maximumBytes: maximum });
      codec.validateCmsResponse(routeId, result, status);
      if (routeId === 'V4-02' && status === 409 && result.outcome === 'reconciliation_required') return result;
      if (!route.success_http.includes(status)) {
        const preservation = ['V4-02', 'V4-29'].includes(routeId) && status === 422 && result.code === 'content_preservation_unavailable' && result.retryable === false && result.retry_after_seconds === null;
        const invalidField = routeId === 'V4-02' && status === 422 && result.code === 'invalid_field' && result.retryable === false && result.retry_after_seconds === null;
        const definitive = preservation || invalidField;
        const error = new CmsClientError(result.code, { status, retryable: result.retryable,
          retryAfterSeconds: result.retry_after_seconds, requestOutcomeUncertain: definitive ? false : uncertain });
        if (definitive) definitiveRejections.set(error, { client: this, evidence: Object.freeze({
          route_id: routeId, status, service_origin: this.#origin,
          ...(invalidField ? { code: result.code, connection_id: this.#connectionId } : {}),
          request_sha256: digest(Buffer.from(body, 'utf8')), mutation_id: codec.parseCmsJson(body).mutation_id,
          path: Object.freeze({ ...path }), envelope: Object.freeze({ ...result }),
          artifact_binding: Object.freeze({ ...sourceArtifactIdentity }),
        }) });
        throw error;
      }
      return result;
    } catch (error) {
      controller.abort();
      if (reader) { try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch {} }
      else cancel(response?.body);
      if (error instanceof CmsClientError) throw error;
      if (error instanceof codec.CmsValidationError) {
        throw new CmsClientError(error.code, { requestOutcomeUncertain: uncertain });
      }
      throw timeout();
    } finally {
      clearTimeout(timer);
      try { reader?.releaseLock(); } catch {}
    }
  }
}
