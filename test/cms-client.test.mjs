import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, copyFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { CmsClient, CmsClientError } from '../lib/cms-client.mjs';
import { createCmsHttpsTransport } from '../lib/cms-https-transport.mjs';
import { CmsValidationError, validateCms } from '../lib/cms-runtime.mjs';
import { cmsVendor } from '../lib/cms-vendor.mjs';

const config = { serviceOrigin: 'https://forum.example', connectionId: `dbc_${'a'.repeat(24)}`, connectionSecret: 'SYNTHETIC-CMS-SECRET' };
const id = '11111111-1111-4111-8111-111111111111';
const mappingId = '22222222-2222-4222-8222-222222222222';
const revision = 'opaque/édition%:?';
const sourceId = 'source/雪%?';
const authority = { work_id: id, lease_token: Buffer.alloc(32, 7).toString('base64url'), lease_generation: 2,
  source_revision: revision, policy_revision: 'policy-opaque' };
const work = { work_id: id, mapping_id: mappingId, source_id: sourceId, source_revision: revision,
  policy_revision: 'policy-opaque', action: 'publish_revision', state: 'leased', attempt_cycle: id,
  attempt: 1, lease_generation: 2, retry_at: null, last_failure_code: null };
const mapping = { mapping_id: mappingId, resource_id: id, connection_id: config.connectionId, source_id: sourceId,
  external_id: 'native-external-opaque', mapping_revision: 'mapping-rev', destination_native_id: 'native-123',
  canonical_url: 'https://ghost.example/article/', retired_url_count: 0, mapping_state: 'pending', presentation_mode: 'full',
  desired_source_revision: revision, synchronized_source_revision: null, publicly_verified_source_revision: null,
  destination_native_revision: null, source_created_at: null, source_updated_at: null, synchronized_at: null, publicly_verified_at: null };
const lease = { work, lease_token: authority.lease_token, lease_generation: 2,
  expires_at: '2026-10-13T06:05:00.000Z', server_time: '2026-10-13T06:00:00.000Z' };
const status = { work, mapping, lease_expires_at: lease.expires_at };
const feed = { stream: 'initial', items: [], next_cursor: null, checkpoint_cursor: 'checkpoint-opaque' };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const padBytes = (text, size) => `${text}${' '.repeat(size - Buffer.byteLength(text))}`;
const source = (bytes) => ({ source_id: sourceId, source_revision: revision, topic_id: '9223372036854775807',
  topic_url: 'https://forum.example/t/9223372036854775807', title: 'Source', content_sha256: hash(bytes), content_bytes: bytes.length,
  source_created_at: null, source_updated_at: null, source_authors: [{ id: 'author-opaque', name: 'Source author' }] });
const wireError = (code, retryable = false, retryAfter = null) => ({ outcome: 'rejected', code, retryable,
  retry_after_seconds: retryAfter, correlation_id: null, core_fallback: false });
const reply = (res, payload, statusCode = 200, headers = {}) => {
  const bytes = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length), ...headers });
  res.end(bytes);
};

const toHtml = '<p>Exact source</p>';
const toRecord = { direction: 'to_discourse', external_id: 'ghost-post:native-id', canonical_url: 'https://ghost.example/original/', title: 'Original', content_html: toHtml, published: true, source_revision: revision, expected_source_revision: null, source_created_at: null, source_updated_at: null, representation: { kind: 'full' }, source_content_sha256: hash(toHtml), source_content_bytes: Buffer.byteLength(toHtml), source_authors: [{ id: 'native-author', name: 'Native author' }] };
const toResult = { outcome: 'created', reason: 'record_created', resource_id: id, topic_id: '9223372036854775807', topic_url: 'https://forum.example/t/original/9223372036854775807', direction: 'to_discourse', source_revision: revision, synchronized_at: '2026-10-14T00:00:00.000Z', core_fallback: false };
const toMetadata = { resource_id: id, direction: 'to_discourse', state: 'active', topic_id: toResult.topic_id, topic_url: toResult.topic_url, external_id: toRecord.external_id, canonical_url: toRecord.canonical_url, source_revision: revision, source_created_at: null, source_updated_at: null, synchronized_at: toResult.synchronized_at, mapping_id: null };

test('current To02–05 use exact closed source bodies/metadata and preserve CoreId strings without rounding', async () => {
  await fixture((req, res) => {
    if (req.url.endsWith('/resolve.json')) reply(res, toResult, 201);
    else if (req.url.endsWith('/withdraw.json')) reply(res, { ...toMetadata, state: 'withdrawn' });
    else if (req.url.includes('bridge-records.json')) reply(res, { items: [toMetadata], next_cursor: null });
    else reply(res, toMetadata);
  }, async (client, seen) => {
    const result = await client.resolveSource({ mutation_id: id, bridge_record: toRecord }); assert.equal(result.topic_id, '9223372036854775807');
    assert.equal((await client.sourceRecords()).items[0].topic_id, result.topic_id);
    assert.equal((await client.sourceRecord(id)).source_revision, revision);
    await client.withdrawSource(id, { mutation_id: mappingId, expected_source_revision: revision, reason: 'source_unpublished' });
    assert.deepEqual(seen.map((call) => [call.method, call.url]), [['POST', '/discussion-bridge/v4/bridge-records/resolve.json'], ['GET', '/discussion-bridge/v4/bridge-records.json'], ['GET', `/discussion-bridge/v4/bridge-records/${id}.json`], ['POST', `/discussion-bridge/v4/bridge-records/${id}/withdraw.json`]]);
    assert.deepEqual(JSON.parse(seen[0].body).bridge_record, toRecord);
  });
});

test('To uncertain exact replay retains mutation/body; typed409 reconciliation returns no protected identity or creation', async () => {
  await fixture((_req, res, _body, count) => count === 1 ? reply(res, wireError('native_service_unavailable', true), 503) : reply(res, toResult, 201), async (client, seen) => {
    const packet = client.prepareMutation('V4-02', { mutation_id: id, bridge_record: structuredClone(toRecord) });
    await assert.rejects(client.execute(packet), (error) => error.requestOutcomeUncertain); await client.execute(packet);
    assert.equal(seen.length, 2); assert.equal(seen[0].body, seen[1].body);
  });
  const reconciliation = { outcome: 'reconciliation_required', reason: 'native_ownership_conflict', resource_id: null, topic_id: null, topic_url: null, direction: 'to_discourse', source_revision: null, synchronized_at: null, core_fallback: false };
  await fixture((_req, res) => reply(res, reconciliation, 409), async (client) => assert.deepEqual({ ...await client.resolveSource({ mutation_id: id, bridge_record: toRecord }) }, reconciliation));
});

// Actual isolated local HTTP fixture. A trusted injected native request driver
// maps the checked HTTPS options to loopback solely for these synthetic tests.
// This proves raw path/HTTP boundaries; it is not TLS/native CMS proof.
async function fixture(handler, run) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, method: req.method, headers: req.headers, body });
    try { await handler(req, res, body, seen.length); }
    catch { if (!res.headersSent) reply(res, wireError('native_service_unavailable', true), 503); else res.destroy(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const transport = createCmsHttpsTransport(config.serviceOrigin, { requestImplementation(options, callback) {
    assert.equal(options.protocol, 'https:');
    assert.equal(options.hostname, 'forum.example');
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.minVersion, 'TLSv1.2');
    return httpRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: server.address().port }, callback);
  } });
  const fetcher = async (address, options) => {
    assert.equal(new URL(address).origin, config.serviceOrigin);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers['Accept-Encoding'], 'identity');
    return transport(address, options);
  };
  try { return await run(new CmsClient(config, { fetchImplementation: fetcher }), seen, fetcher); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test('configuration and typed route preflight refuse unsafe authority without requests', async () => {
  let calls = 0;
  const fetchImplementation = async () => { calls++; throw new Error(config.connectionSecret); };
  for (const serviceOrigin of ['http://forum.example', 'https://forum.example/path', 'https://u:p@forum.example', 'https://forum.example/#']) {
    assert.throws(() => new CmsClient({ ...config, serviceOrigin }, { fetchImplementation }));
  }
  const client = new CmsClient(config, { fetchImplementation });
  for (const mutation_id of [id.toUpperCase().replace('11111111', 'AAAAAAAA'), '00000000-0000-0000-0000-000000000000', 123]) {
    assert.throws(() => client.prepareMutation('V4-13', { mutation_id }));
  }
  assert.throws(() => client.prepareMutation('V4-15', { mutation_id: id, authority }, { work_id: mappingId }), /identity_conflict/);
  assert.throws(() => client.prepareMutation('V4-99', {}), /invalid_transition/);
  assert.throws(() => client.sources({ stream: 'changes' }));
  assert.throws(() => client.contentChunk(sourceId, revision, -1));
  const invalidSource = { ...source(Buffer.alloc(0)), topic_id: 9223372036854775807 };
  await assert.rejects(client.completeSource(invalidSource));
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(client), '{}');
});

test('actual HTTP mutation replay freezes identical bytes and performs no automatic retry', async () => {
  await fixture((_req, res, _body, n) => reply(res, n === 1 ? wireError('native_service_unavailable', true) : lease, n === 1 ? 503 : 200), async (client, seen) => {
    const body = { mutation_id: id, mapping_id: mappingId };
    const packet = client.prepareMutation('V4-13', body);
    body.mapping_id = id;
    await assert.rejects(client.execute(packet), (error) => error instanceof CmsClientError && error.code === 'native_service_unavailable' && error.retryable);
    assert.equal(seen.length, 1);
    const actual = await client.execute(packet);
    assert.equal(actual.work.work_id, id);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].body, seen[1].body);
    assert.equal(JSON.parse(seen[0].body).mapping_id, mappingId);
    for (const request of seen) {
      assert.equal(request.headers['x-discussionbridge-secret'], config.connectionSecret);
      assert.equal(request.url.includes(config.connectionSecret), false);
    }
    assert.equal(JSON.stringify(packet).includes(authority.lease_token), false);
  });
});

test('claim, work status, renewal, synchronized/verified ack and failure use current candidate endpoints', async () => {
  await fixture((req, res) => reply(res, req.url.endsWith('/claim.json') || req.url.endsWith('/renew.json') ? lease : status), async (client, seen) => {
    await client.claim({ mutation_id: id });
    await client.work(id);
    await client.renew(id, { mutation_id: mappingId, authority });
    const representation = { kind: 'full', source_content_sha256: 'a'.repeat(64) };
    await client.acknowledge(id, { mutation_id: id, stage: 'synchronized', authority, native_result: {
      kind: 'publish_revision', native_id: 'native-123', external_id: mapping.external_id, canonical_url: mapping.canonical_url,
      native_revision: null, ownership_receipt_sha256: 'b'.repeat(64), representation,
    } });
    await client.acknowledge(id, { mutation_id: mappingId, stage: 'verified', authority, verification: {
      kind: 'published', url: mapping.canonical_url, native_id: 'native-123', source_revision: revision,
      source_content_sha256: 'a'.repeat(64), native_publication_sha256: 'c'.repeat(64), verification_profile: 'fixture-only-profile',
      checked_at: '2026-10-13T06:00:00.000Z', representation,
    } });
    await client.fail(id, { mutation_id: id, authority, code: 'native_ownership_conflict', native_change_applied: false,
      safe_detail: null, retry_after_seconds: null });
    assert.deepEqual(seen.map((r) => r.url), [
      '/discussion-bridge/v4/work/claim.json', `/discussion-bridge/v4/work/${id}.json`,
      `/discussion-bridge/v4/work/${id}/renew.json`, `/discussion-bridge/v4/work/${id}/acknowledge.json`,
      `/discussion-bridge/v4/work/${id}/acknowledge.json`, `/discussion-bridge/v4/work/${id}/fail.json`,
    ]);
    assert.equal(seen[1].body, '');
  });
});

test('204 claim is bodyless and a replay remains a replay, not a new poll', async () => {
  await fixture((_req, res) => { res.writeHead(204); res.end(); }, async (client, seen) => {
    const packet = client.prepareMutation('V4-13', { mutation_id: id });
    assert.equal(await client.execute(packet), undefined);
    assert.equal(await client.execute(packet), undefined);
    assert.equal(seen[0].body, seen[1].body);
  });
});

test('credential redirects never reach a second HTTP origin and diagnostics contain no secrets', async () => {
  let trapHits = 0;
  const trap = createServer((_req, res) => { trapHits++; res.end(); });
  await new Promise((resolve) => trap.listen(0, '127.0.0.1', resolve));
  try {
    await fixture((_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${trap.address().port}/capture` }); res.end(); }, async (client, seen) => {
      const error = await client.claim({ mutation_id: id }).catch((value) => value);
      assert.ok(error instanceof CmsClientError);
      assert.equal(error.requestOutcomeUncertain, true);
      assert.equal(seen.length, 1);
      assert.equal(trapHits, 0);
      assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(config.connectionSecret), false);
    });
  } finally { trap.closeAllConnections(); await new Promise((resolve) => trap.close(resolve)); }
});

test('returned cross-origin URL, redirect flag, compression and invalid media fail permanently', async () => {
  for (const variant of ['cross-origin', 'redirected', 'compression', 'media']) {
    const headers = variant === 'compression' ? { 'Content-Encoding': 'gzip' }
      : variant === 'media' ? { 'Content-Type': 'application/json-invalid' } : {};
    await fixture((_req, res) => reply(res, feed, 200, headers), async (_client, seen, fetcher) => {
      const client = new CmsClient(config, { fetchImplementation: async (url, options) => {
        const response = await fetcher(url, options);
        if (variant === 'cross-origin') return { body: response.body, url: 'https://other.example/sources.json' };
        if (variant === 'redirected') return { body: response.body, url, redirected: true };
        return response;
      } });
      await assert.rejects(client.sources({ stream: 'initial' }), (error) => error instanceof CmsClientError && !error.retryable);
      assert.equal(seen.length, 1);
    });
  }
});

test('strict response JSON rejects duplicate keys, invalid UTF8, BOM and server transient coercion', async () => {
  const cases = [
    Buffer.from('{"stream":"initial","stream":"initial","items":[],"next_cursor":null,"checkpoint_cursor":"c"}'),
    Buffer.concat([Buffer.from(JSON.stringify(feed)), Buffer.from([0xff])]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(feed))]),
  ];
  for (const bytes of cases) await fixture((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(bytes); }, async (client, seen) => {
    await assert.rejects(client.sources({ stream: 'initial' }), /invalid_json/);
    assert.equal(seen.length, 1);
  });
  for (const lexeme of ['2.00000000000000001', '9007199254740991.4', '-0']) {
    const raw = JSON.stringify(lease).replace('"lease_generation":2', `"lease_generation":${lexeme}`);
    await fixture((_req, res) => reply(res, raw), async (client, seen) => {
      await assert.rejects(client.claim({ mutation_id: id }), /invalid_field/);
      assert.equal(seen.length, 1);
    });
  }
  const underflow = JSON.stringify(status).replace('"retired_url_count":0', '"retired_url_count":1e-999');
  await fixture((_req, res) => reply(res, underflow), async (client, seen) => {
    await assert.rejects(client.work(id), /invalid_field/);
    assert.equal(seen.length, 1);
  });
  for (const lexeme of ['2.0', '2e0']) {
    const raw = JSON.stringify(lease).replaceAll('"lease_generation":2', `"lease_generation":${lexeme}`);
    await fixture((_req, res) => reply(res, raw), async (client, seen) => {
      assert.equal((await client.claim({ mutation_id: id })).lease_generation, 2);
      assert.equal(seen.length, 1);
    });
  }
  await fixture((_req, res) => reply(res, wireError('native_ownership_conflict', true), 409), async (client, seen) => {
    await assert.rejects(client.claim({ mutation_id: id }), (error) => error instanceof CmsClientError && !error.retryable);
    assert.equal(seen.length, 1);
  });
  await fixture((_req, res) => reply(res, wireError('native_ownership_conflict'), 409), async (client, seen) => {
    await assert.rejects(client.claim({ mutation_id: id }), (error) => error instanceof CmsClientError && error.code === 'native_ownership_conflict' && !error.retryable);
    assert.equal(seen.length, 1);
  });
});

test('content response admits exact 65536 wire bytes and rejects excess wire/decoded chunk bytes', async () => {
  for (const variant of ['exact', 'wire-excess', 'decoded-excess']) {
    const bytes = Buffer.alloc(variant === 'decoded-excess' ? 32769 : 32768, 97);
    const expected = source(bytes);
    const chunk = { source_id: sourceId, source_revision: revision, content_sha256: hash(bytes), content_bytes: bytes.length,
      offset: 0, next_offset: null, content_base64: bytes.toString('base64') };
    await fixture((_req, res) => reply(res, padBytes(JSON.stringify(chunk), variant === 'wire-excess' ? 65537 : 65536)), async (client, seen) => {
      if (variant === 'exact') assert.deepEqual((await client.completeSource(expected)).bytes, bytes);
      else await assert.rejects(client.completeSource(expected), (error) => error instanceof CmsClientError && !error.retryable);
      assert.equal(seen.length, 1);
    });
  }
});

test('metadata decoded bytes admit exact 262144 boundary and reject one extra byte', async () => {
  for (const size of [262_144, 262_145]) {
    await fixture((_req, res) => reply(res, padBytes(JSON.stringify(feed), size)), async (client) => {
      if (size === 262_144) assert.equal((await client.sources({ stream: 'initial' })).checkpoint_cursor, feed.checkpoint_cursor);
      else await assert.rejects(client.sources({ stream: 'initial' }), /metadata_unavailable/);
    });
  }
});

test('complete source assembles split UTF8 across bounded chunks with opaque path identity and no total publication cap', async () => {
  const bytes = Buffer.from(`${'a'.repeat(32767)}雪${'b'.repeat(40000)}`);
  const input = source(bytes);
  let checkpoints = 0;
  await fixture((req, res) => {
    const offset = Number(new URL(req.url, config.serviceOrigin).searchParams.get('offset'));
    const part = bytes.subarray(offset, offset + 32768);
    reply(res, { source_id: sourceId, source_revision: revision, content_sha256: hash(bytes), content_bytes: bytes.length,
      offset, next_offset: offset + part.length === bytes.length ? null : offset + part.length, content_base64: part.toString('base64') });
  }, async (client, seen) => {
    const pending = client.completeSource(input, { beforeChunk: async () => { checkpoints++; } });
    input.source_revision = 'mutated-by-caller';
    const actual = await pending;
    assert.deepEqual(actual.bytes, bytes);
    assert.equal(actual.html, bytes.toString('utf8'));
    assert.equal(checkpoints, 3);
    assert.equal(seen.length, 3);
    assert.ok(seen.every((r) => r.url.includes(encodeURIComponent(sourceId)) && r.url.includes(encodeURIComponent(revision))));
    assert.ok(seen.every((r) => !r.url.includes('publication_contract=')));
  });
});

test('native raw path preserves legal dot-only opaque source and revision IDs encoded exactly once', async () => {
  const bytes = Buffer.from('<p>Dot identity</p>');
  const expected = { ...source(bytes), source_id: '.', source_revision: '..' };
  await fixture((req, res) => {
    assert.equal(req.url, '/discussion-bridge/v4/sources/%2E/revisions/%2E%2E/content.json?offset=0');
    reply(res, { source_id: '.', source_revision: '..', content_sha256: hash(bytes), content_bytes: bytes.length,
      offset: 0, next_offset: null, content_base64: bytes.toString('base64') });
  }, async (client, seen) => {
    assert.deepEqual((await client.completeSource(expected)).bytes, bytes);
    assert.equal(seen.length, 1);
  });
});

test('chunk identity/hash, canonical Base64 and complete UTF8 failures cannot become native success', async () => {
  for (const kind of ['identity', 'hash', 'base64', 'utf8']) {
    const bytes = kind === 'utf8' ? Buffer.from([0xff]) : Buffer.from('<p>Source</p>');
    const expected = source(bytes);
    await fixture((_req, res) => reply(res, { source_id: kind === 'identity' ? 'other-source' : sourceId,
      source_revision: revision, content_sha256: kind === 'hash' ? '0'.repeat(64) : hash(bytes), content_bytes: bytes.length,
      offset: 0, next_offset: null, content_base64: kind === 'base64' ? 'Zg' : bytes.toString('base64') }), async (client, seen) => {
      await assert.rejects(client.completeSource(expected), (error) => error instanceof CmsClientError && !error.retryable);
      assert.equal(seen.length, 1);
    });
  }
});

test('header/connect and entire body deadlines abort stalled requests without leaked raw errors', async () => {
  let signal;
  const client = new CmsClient(config, { connectTimeoutMs: 20, responseTimeoutMs: 20, fetchImplementation: (_url, options) => {
    signal = options.signal; return new Promise(() => {});
  } });
  await assert.rejects(client.claim({ mutation_id: id }), (error) => error.code === 'transport_timeout' && error.requestOutcomeUncertain);
  assert.equal(signal.aborted, true);
  let cancelled = 0;
  const slow = new CmsClient(config, { connectTimeoutMs: 100, responseTimeoutMs: 20, fetchImplementation: async (url) => {
    const response = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'Content-Type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  } });
  await assert.rejects(slow.sources({ stream: 'initial' }), /transport_timeout/);
  assert.equal(cancelled, 1);
  const thrown = new CmsClient(config, { fetchImplementation: () => { throw new Error(config.connectionSecret); } });
  const error = await thrown.claim({ mutation_id: id }).catch((value) => value);
  assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(config.connectionSecret), false);
});

test('vendor is byte-exact and isolated client imports without sibling checkout or full packet', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'discussionbridge-cms-client-'));
  try {
    for (const file of ['cms-runtime.mjs', 'cms-schema.json', 'cms-client.mjs', 'cms-https-transport.mjs', 'cms-vendor.mjs']) {
      await copyFile(new URL(`../lib/${file}`, import.meta.url), join(directory, file));
    }
    for (const [name, identity] of [['cms-runtime.mjs', cmsVendor.runtime], ['cms-schema.json', cmsVendor.schema]]) {
      const bytes = await readFile(join(directory, name));
      assert.equal(bytes.length, identity.bytes);
      assert.equal(hash(bytes), identity.sha256);
    }
    const runtime = await import(pathToFileURL(join(directory, 'cms-runtime.mjs')));
    assert.equal(Object.keys(runtime.cmsSchema.types).some((name) => name.startsWith('Network')), false);
    validateCms('CoreId', '9223372036854775807');
    assert.throws(() => validateCms('CoreId', '9223372036854775808'), CmsValidationError);
    const isolated = await import(pathToFileURL(join(directory, 'cms-client.mjs')));
    assert.equal(typeof isolated.CmsClient, 'function');
  } finally {
    // Resolve and verify the exact owned mkdtemp path before recursive removal.
    const owned = await realpath(directory), root = await realpath(tmpdir());
    assert.equal(dirname(owned), root);
    assert.ok(basename(owned).startsWith('discussionbridge-cms-client-'));
    await rm(owned, { recursive: true, force: true });
  }
});

const uploadId = '33333333-3333-4333-8333-333333333333';
const catalogItems = [
  { id: 'author/e\u0301%?', label: ' Author one ', available: true },
  { id: 'author/é%?', label: 'Author two', available: false },
];

const moveId = '44444444-4444-4444-8444-444444444444';
const moveOwnership = { resource_id: id, external_id: mapping.external_id, native_id: mapping.destination_native_id,
  canonical_url: mapping.canonical_url, source_revision: revision, ownership_receipt_sha256: 'a'.repeat(64) };
const moveRequest = { mutation_id: id, authority, expected_mapping_revision: mapping.mapping_revision,
  old_url: mapping.canonical_url, new_url: 'https://ghost.example/new-address/', ownership: moveOwnership };
const preparedMove = { move_id: moveId, mapping_id: mappingId, expected_mapping_revision: mapping.mapping_revision,
  old_url: moveRequest.old_url, new_url: moveRequest.new_url, proof_nonce: Buffer.alloc(32, 3).toString('base64url'),
  state: 'prepared', prepared_at: '2026-10-14T00:00:00.000Z' };
const moveVerification = { kind: 'published', url: moveRequest.new_url, native_id: mapping.destination_native_id,
  source_revision: revision, source_content_sha256: 'b'.repeat(64), native_publication_sha256: 'c'.repeat(64),
  verification_profile: 'ghost-owned-fragment-v1', checked_at: '2026-10-14T00:00:01.000Z',
  representation: { kind: 'full', source_content_sha256: 'b'.repeat(64) } };

test('base presentation URL prepare/finalize/no-move abort use exact current21–23 methods, paths and typed bodies', async () => {
  const finalize = { mutation_id: mappingId, authority, move_id: moveId, proof_nonce: preparedMove.proof_nonce,
    ownership: { ...moveOwnership, canonical_url: moveRequest.new_url }, verification: moveVerification };
  const abort = { mutation_id: moveId, authority, move_id: moveId, native_change_applied: false, ownership: moveOwnership };
  await fixture((req, res) => {
    if (req.url.endsWith('/finalize.json')) reply(res, { ...mapping, mapping_revision: 'mapping-moved', canonical_url: moveRequest.new_url, retired_url_count: 1 });
    else reply(res, { ...preparedMove, state: req.url.endsWith('/abort.json') ? 'aborted' : 'prepared' });
  }, async (client, seen) => {
    assert.equal((await client.prepareUrlMove(mappingId, moveRequest)).move_id, moveId);
    assert.equal((await client.finalizeUrlMove(mappingId, moveId, finalize)).canonical_url, moveRequest.new_url);
    assert.equal((await client.abortUrlMove(mappingId, moveId, abort)).state, 'aborted');
    assert.deepEqual(seen.map(({ method, url }) => [method, url]), [
      ['POST', `/discussion-bridge/v4/mappings/${mappingId}/url-moves.json`],
      ['POST', `/discussion-bridge/v4/mappings/${mappingId}/url-moves/${moveId}/finalize.json`],
      ['POST', `/discussion-bridge/v4/mappings/${mappingId}/url-moves/${moveId}/abort.json`],
    ]);
    assert.deepEqual(seen.map(({ body }) => JSON.parse(body)), [moveRequest, finalize, abort]);
  });
});

test('base move mutations preserve uncertain exact replay and reject malformed nonce/path/amendment fields before dispatch', async () => {
  let sent = 0;
  await fixture((_req, res) => {
    if (++sent === 1) reply(res, wireError('native_service_unavailable', true), 503);
    else reply(res, preparedMove);
  }, async (client, seen) => {
    const packet = client.prepareMutation('V4-21', moveRequest, { mapping_id: mappingId });
    await assert.rejects(client.execute(packet), (error) => error.requestOutcomeUncertain);
    await client.execute(packet);
    assert.equal(seen[0].url, seen[1].url); assert.equal(seen[0].body, seen[1].body);
    const finalize = { mutation_id: id, authority, move_id: moveId, proof_nonce: preparedMove.proof_nonce,
      ownership: { ...moveOwnership, canonical_url: moveRequest.new_url }, verification: moveVerification };
    for (const proof_nonce of ['', 'a'.repeat(42), 'a'.repeat(44), 'bad/nonce']) assert.throws(() => client.prepareMutation('V4-22', { ...finalize, proof_nonce }, { mapping_id: mappingId, move_id: moveId }));
    assert.throws(() => client.prepareMutation('V4-22', { ...finalize, move_id: id }, { mapping_id: mappingId, move_id: moveId }));
    assert.throws(() => client.prepareMutation('V4-21', { ...moveRequest, url_transport_amendment: true }, { mapping_id: mappingId }));
    assert.equal(seen.length, 2);
  });
});
const catalogBegin = { mutation_id: id, kind: 'authors', native_revision: revision, total_items: 2 };
const catalogUpload = { upload_id: uploadId, kind: 'authors', native_revision: revision, total_items: 2,
  received_items: 0, next_page: 0, expires_at: '2026-10-14T06:00:00.000Z' };
const catalogSnapshot = { kind: 'authors', catalog_revision: 'catalog-opaque', native_revision: revision,
  total_items: 2, items: catalogItems, next_cursor: null };

test('catalog begin, page, finalize and snapshot reads use only current methods, paths and fields', async () => {
  await fixture((req, res) => {
    if (req.url === '/discussion-bridge/v4/catalog/uploads.json') reply(res, catalogUpload, 201);
    else if (req.url.endsWith('/pages.json')) reply(res, { ...catalogUpload, received_items: 2, next_page: 1 });
    else if (req.url.endsWith('/finalize.json')) reply(res, { ...catalogSnapshot, items: [catalogItems[0]], next_cursor: 'snapshot_next-1' });
    else reply(res, req.url.includes('cursor=') ? { ...catalogSnapshot, items: [catalogItems[1]] } : catalogSnapshot);
  }, async (client, seen) => {
    assert.equal((await client.beginCatalog({ ...catalogBegin })).upload_id, uploadId);
    const page = { mutation_id: mappingId, page: 0, items: catalogItems };
    assert.equal((await client.catalogPage(uploadId, page)).received_items, 2);
    const finalize = { mutation_id: id, upload_id: uploadId, expected_total_items: 2 };
    const first = await client.finalizeCatalog(uploadId, finalize);
    assert.equal(first.next_cursor, 'snapshot_next-1');
    assert.equal(first.items.length, 1);
    const next = await client.catalog({ kind: 'authors', cursor: first.next_cursor });
    assert.equal(next.items[0].id, catalogItems[1].id);
    assert.equal(next.next_cursor, null);
    assert.equal((await client.catalog({ kind: 'authors' })).items[0].id, catalogItems[0].id);
    assert.deepEqual(seen.map(({ method, url }) => [method, url]), [
      ['POST', '/discussion-bridge/v4/catalog/uploads.json'],
      ['POST', `/discussion-bridge/v4/catalog/uploads/${uploadId}/pages.json`],
      ['POST', `/discussion-bridge/v4/catalog/uploads/${uploadId}/finalize.json`],
      ['GET', '/discussion-bridge/v4/catalog.json?kind=authors&cursor=snapshot_next-1'],
      ['GET', '/discussion-bridge/v4/catalog.json?kind=authors'],
    ]);
    assert.deepEqual(seen.slice(0, 3).map(({ body }) => JSON.parse(body)), [catalogBegin, page, finalize]);
    for (const request of seen) {
      assert.equal(request.headers['x-discussionbridge-connection'], config.connectionId);
      assert.equal(request.headers['x-discussionbridge-secret'], config.connectionSecret);
      assert.equal(request.headers.accept, 'application/json');
      assert.equal(request.headers['accept-encoding'], 'identity');
      assert.equal(request.url.includes(config.connectionSecret), false);
      assert.equal(request.body.includes(config.connectionSecret), false);
      if (request.method === 'GET') {
        assert.equal(request.body, '');
        assert.equal(request.headers['content-type'], undefined);
      } else assert.equal(request.headers['content-type'], 'application/json');
    }
  });
});

test('catalog typed preflight rejects invalid counters, IDs, entries and undocumented fields before dispatch', () => {
  let calls = 0;
  const client = new CmsClient(config, { fetchImplementation: async () => { calls++; throw new Error('must not dispatch'); } });
  for (const body of [
    { ...catalogBegin, kind: 'users' }, { ...catalogBegin, native_revision: ' ' },
    { ...catalogBegin, total_items: '2' }, { ...catalogBegin, total_items: -1 },
    { ...catalogBegin, total_items: 0.5 }, { ...catalogBegin, total_items: 9007199254740992 },
    { ...catalogBegin, catalog_refresh_request: true }, { ...catalogBegin, mutation_id: '00000000-0000-0000-0000-000000000000' },
  ]) assert.throws(() => client.beginCatalog(body), CmsValidationError);
  for (const body of [
    { mutation_id: id, page: -1, items: [] }, { mutation_id: id, page: '0', items: [] },
    { mutation_id: id, page: 0, items: Array.from({ length: 101 }, (_, i) => ({ id: `id-${i}`, label: 'Label', available: true })) },
    { mutation_id: id, page: 0, items: [{ ...catalogItems[0], available: 'true' }] },
    { mutation_id: id, page: 0, items: [{ ...catalogItems[0], label: '雪'.repeat(67) }] },
    { mutation_id: id, page: 0, items: [{ ...catalogItems[0], id: '\n' }] },
    { mutation_id: id, page: 0, items: [{ ...catalogItems[0], native_role: 'administrator' }] },
  ]) assert.throws(() => client.catalogPage(uploadId, body), CmsValidationError);
  const finalize = { mutation_id: id, upload_id: uploadId, expected_total_items: 2 };
  assert.throws(() => client.finalizeCatalog(mappingId, finalize), /identity_conflict/);
  assert.throws(() => client.finalizeCatalog(uploadId, { ...finalize, expected_total_items: null }), CmsValidationError);
  assert.throws(() => client.catalogPage('not-a-uuid', { mutation_id: id, page: 0, items: catalogItems }), CmsValidationError);
  for (const query of [{}, { kind: 'users' }, { kind: 'authors', cursor: null },
    { kind: 'authors', cursor: 'a'.repeat(2049) }, { kind: 'taxonomy', limit: 100 },
    { kind: 'authors', catalog_refresh_request: true }]) {
    assert.throws(() => client.catalog(query), CmsValidationError);
  }
  assert.equal(calls, 0);
});

test('each catalog mutation preserves exact path and serialized bytes for explicit uncertain-result replay', async () => {
  for (const operation of [
    { routeId: 'V4-24', body: { ...catalogBegin }, path: {}, response: catalogUpload, status: 201 },
    { routeId: 'V4-25', body: { mutation_id: id, page: 0, items: catalogItems.map((item) => ({ ...item })) },
      path: { upload_id: uploadId }, response: { ...catalogUpload, received_items: 2, next_page: 1 }, status: 200 },
    { routeId: 'V4-26', body: { mutation_id: id, upload_id: uploadId, expected_total_items: 2 },
      path: { upload_id: uploadId }, response: catalogSnapshot, status: 200 },
  ]) await fixture((_req, res, _body, n) => reply(res, n === 1 ? wireError('native_service_unavailable', true) : operation.response,
    n === 1 ? 503 : operation.status), async (client, seen) => {
    const expectedBody = JSON.stringify(operation.body);
    const packet = client.prepareMutation(operation.routeId, operation.body, operation.path);
    operation.body.mutation_id = mappingId;
    if (operation.body.items) operation.body.items[0].id = 'caller-mutated-native-id';
    else if (operation.body.native_revision) operation.body.native_revision = 'caller-mutated-revision';
    else operation.body.upload_id = mappingId;
    operation.path.upload_id = mappingId;
    await assert.rejects(client.execute(packet), (error) => error instanceof CmsClientError && error.retryable && error.requestOutcomeUncertain);
    assert.equal(seen.length, 1);
    await client.execute(packet);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].body, expectedBody);
    assert.equal(seen[1].body, expectedBody);
    assert.equal(seen[0].url, seen[1].url);
    if (operation.routeId !== 'V4-24') assert.ok(seen[0].url.includes(`/${uploadId}/`));
    assert.equal(packet.mutationId, id);
    assert.equal(JSON.stringify(packet).includes(config.connectionSecret), false);
    const other = new CmsClient(config, { fetchImplementation: async () => { throw new Error('must not dispatch'); } });
    await assert.rejects(other.execute(packet), /invalid_field/);
  });
});

test('catalog page limit counts complete raw JSON escape bytes at 65536 and does not truncate 100 entries', async () => {
  const pageAtSize = (size) => {
    const body = { mutation_id: id, page: 0,
      items: Array.from({ length: 100 }, (_, i) => ({ id: `entry-${i}`, label: 'a'.repeat(200), available: true })) };
    let remaining = size - Buffer.byteLength(JSON.stringify(body));
    for (const item of body.items) {
      const quotes = Math.min(255 - Buffer.byteLength(item.id), Math.floor(remaining / 2));
      item.id += '"'.repeat(quotes);
      remaining -= quotes * 2;
      if (remaining === 1 && Buffer.byteLength(item.id) < 255) { item.id += 'a'; remaining--; }
    }
    assert.equal(remaining, 0);
    assert.equal(Buffer.byteLength(JSON.stringify(body)), size);
    return body;
  };
  await fixture((_req, res) => reply(res, { ...catalogUpload, total_items: 100, received_items: 100, next_page: 1 }), async (client, seen) => {
    const exact = pageAtSize(65_536);
    await client.catalogPage(uploadId, exact);
    assert.equal(Buffer.byteLength(seen[0].body), 65_536);
    assert.deepEqual(JSON.parse(seen[0].body).items, exact.items);
    assert.throws(() => client.catalogPage(uploadId, pageAtSize(65_537)), /body_too_large/);
    assert.equal(seen.length, 1);
  });
});

test('catalog metadata responses accept exact decoded 262144 bytes and reject one byte beyond', async () => {
  for (const size of [262_144, 262_145]) await fixture((_req, res) => reply(res, padBytes(JSON.stringify(catalogSnapshot), size)), async (client, seen) => {
    if (size === 262_144) assert.equal((await client.catalog({ kind: 'authors' })).catalog_revision, catalogSnapshot.catalog_revision);
    else await assert.rejects(client.catalog({ kind: 'authors' }), (error) => error.code === 'metadata_unavailable' && !error.retryable && !error.requestOutcomeUncertain);
    assert.equal(seen.length, 1);
  });
});

test('catalog response types and route-specific success statuses remain strict for all four operations', async () => {
  const begin = (client) => client.beginCatalog({ ...catalogBegin });
  const page = (client) => client.catalogPage(uploadId, { mutation_id: id, page: 0, items: catalogItems });
  const finalize = (client) => client.finalizeCatalog(uploadId, { mutation_id: id, upload_id: uploadId, expected_total_items: 2 });
  const read = (client) => client.catalog({ kind: 'authors' });
  const cases = [
    [begin, catalogUpload, 200], [page, catalogUpload, 201], [finalize, catalogSnapshot, 201], [read, catalogSnapshot, 201],
    [begin, { ...catalogUpload, expires_at: '2026-02-30T06:00:00.000Z' }, 201],
    [page, { ...catalogUpload, upload_id: 'not-a-uuid' }, 200],
    [page, { ...catalogUpload, next_page: '1' }, 200],
    [finalize, { ...catalogSnapshot, accepted_at: '2026-10-13T06:00:00.000Z' }, 200],
    [read, { ...catalogSnapshot, items: Array.from({ length: 101 }, (_, i) => ({ id: `id-${i}`, label: 'Label', available: true })) }, 200],
    [read, { ...catalogSnapshot, items: [{ ...catalogItems[0], available: 1 }] }, 200],
    [read, { ...catalogSnapshot, native_revision: null }, 200],
    [page, wireError('catalog_page_conflict'), 422],
  ];
  for (const [run, response, httpStatus] of cases) await fixture((_req, res) => reply(res, response, httpStatus), async (client, seen) => {
    await assert.rejects(run(client), (error) => error instanceof CmsClientError && !error.retryable);
    assert.equal(seen.length, 1);
  });
});

test('catalog duplicate JSON and altered custom serialization fail without unsafe payload acceptance', async () => {
  const duplicate = JSON.stringify(catalogSnapshot).replace('"kind":"authors"', '"kind":"authors","kind":"taxonomy"');
  await fixture((_req, res) => reply(res, duplicate), async (client, seen) => {
    await assert.rejects(client.catalog({ kind: 'authors' }), /invalid_json/);
    assert.equal(seen.length, 1);
  });
  let calls = 0;
  const client = new CmsClient(config, { fetchImplementation: async () => { calls++; throw new Error('must not dispatch'); } });
  const body = Object.assign(Object.create({ toJSON() {
    return { mutation_id: id, page: 0, items: Array.from({ length: 101 }, (_, i) => ({ id: `id-${i}`, label: 'Label', available: true })) };
  } }), { mutation_id: id, page: 0, items: catalogItems });
  assert.throws(() => client.prepareMutation('V4-25', body, { upload_id: uploadId }), CmsValidationError);
  assert.equal(calls, 0);
});

test('both catalog kinds support declared zero totals without automatic pages or producer work', async () => {
  for (const kind of ['authors', 'taxonomy']) await fixture((req, res) => {
    if (req.url.endsWith('/uploads.json')) reply(res, { ...catalogUpload, kind, total_items: 0 }, 201);
    else reply(res, { ...catalogSnapshot, kind, total_items: 0, items: [] });
  }, async (client, seen) => {
    assert.equal((await client.beginCatalog({ ...catalogBegin, kind, total_items: 0 })).total_items, 0);
    assert.equal((await client.finalizeCatalog(uploadId, { mutation_id: mappingId, upload_id: uploadId, expected_total_items: 0 })).items.length, 0);
    assert.equal((await client.catalog({ kind })).total_items, 0);
    assert.equal(seen.length, 3);
    assert.ok(seen.every(({ url }) => !url.endsWith('/pages.json') && !url.includes('/work/')));
  });
});

test('approved preservation rejection is definitive only on To02/29 with exact validated private request/response provenance', async () => {
  const sourceMove = { mutation_id: id, move_id: moveId, proof_nonce: preparedMove.proof_nonce, expected_source_revision: revision, new_source_revision: 'fresh-move-edition', source_updated_at: null,
    verification: { url: 'https://ghost.example/new-source/', external_id: toRecord.external_id, source_revision: 'fresh-move-edition', source_content_sha256: hash(toHtml), native_ownership_receipt_sha256: 'a'.repeat(64), native_publication_sha256: 'b'.repeat(64), verification_profile: 'synthetic-source-proof-transport-only', checked_at: '2026-10-15T00:00:00.000Z' } };
  for (const [routeId, body, path] of [['V4-02', { mutation_id: id, bridge_record: toRecord }, {}], ['V4-29', sourceMove, { resource_id: id, move_id: moveId }]]) {
    await fixture((_req, res) => reply(res, wireError('content_preservation_unavailable'), 422), async (client, seen, fetcher) => {
      const packet = client.prepareMutation(routeId, body, path);
      await assert.rejects(client.execute(packet), (error) => {
        assert.equal(error.code, 'content_preservation_unavailable'); assert.equal(error.status, 422); assert.equal(error.retryable, false); assert.equal(error.requestOutcomeUncertain, false);
        const evidence = client.rejectedResponse(error); assert.equal(evidence.route_id, routeId); assert.equal(evidence.request_sha256, hash(seen[0].body)); assert.equal(evidence.mutation_id, id); assert.deepEqual(evidence.envelope, wireError('content_preservation_unavailable')); assert.deepEqual(evidence.path, path);
        assert.equal(evidence.artifact_binding.candidate_id, cmsVendor.candidate_id); assert.equal(Object.isFrozen(evidence), true); assert.equal(Object.isFrozen(evidence.envelope), true);
        assert.equal(new CmsClient(config, { fetchImplementation: fetcher }).rejectedResponse(error), undefined);
        assert.ok(!JSON.stringify(evidence).includes(config.connectionSecret)); return true;
      });
      assert.equal(seen.length, 1);
    });
  }
});

test('new To-only code cannot become a From response/failure/work attention or a malformed definitive outcome', async () => {
  assert.throws(() => validateCms('Failure', { mutation_id: id, authority, code: 'content_preservation_unavailable', native_change_applied: false, safe_detail: null, retry_after_seconds: null }));
  assert.throws(() => validateCms('Work', { ...work, last_failure_code: 'content_preservation_unavailable' }));
  for (const [routeId, body, path, response, http] of [
    ['V4-17', { mutation_id: id, authority, code: 'native_ownership_conflict', native_change_applied: false, safe_detail: null, retry_after_seconds: null }, { work_id: id }, wireError('content_preservation_unavailable'), 422],
    ['V4-02', { mutation_id: id, bridge_record: toRecord }, {}, { ...wireError('content_preservation_unavailable'), retryable: true }, 422],
    ['V4-02', { mutation_id: id, bridge_record: toRecord }, {}, { ...wireError('content_preservation_unavailable'), detail: 'not an allowed field' }, 422],
    ['V4-02', { mutation_id: id, bridge_record: toRecord }, {}, wireError('content_preservation_unavailable'), 409],
  ]) await fixture((_req, res) => reply(res, response, http), async (client, seen) => {
    await assert.rejects(client.execute(client.prepareMutation(routeId, body, path)), (error) => error.requestOutcomeUncertain === true && client.rejectedResponse(error) === undefined);
    assert.equal(seen.length, 1);
  });
});

test('receiver catalog conflicts and expiry errors retain exact typed status without automatic retry', async () => {
  for (const [code, httpStatus, read] of [
    ['catalog_page_conflict', 409, false], ['catalog_upload_expired', 410, false], ['cursor_expired', 410, true],
  ]) await fixture((_req, res) => reply(res, wireError(code), httpStatus), async (client, seen) => {
    const operation = read ? client.catalog({ kind: 'authors', cursor: 'expired_cursor' })
      : client.catalogPage(uploadId, { mutation_id: id, page: 0, items: catalogItems });
    await assert.rejects(operation, (error) => error instanceof CmsClientError && error.code === code && error.status === httpStatus &&
      !error.retryable && error.requestOutcomeUncertain === !read && !`${error.stack}${JSON.stringify(error)}`.includes(config.connectionSecret));
    assert.equal(seen.length, 1);
  });
});
