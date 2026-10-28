import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { validateCms } from './cms-runtime.mjs';

// Native HTTPS options preserve the encoded request path byte-for-byte. Parsing
// a complete URL with WHATWG fetch would collapse valid dot-only opaque IDs.
// No redirects are followed, no certificate verification is disabled, and no
// connection credentials are copied to another service. requestImplementation
// is a trusted test seam; normal callers always use Node's verified HTTPS.
export function createCmsHttpsTransport(serviceOrigin, { requestImplementation = httpsRequest } = {}) {
  validateCms('Url', serviceOrigin);
  const origin = new URL(serviceOrigin);
  if (origin.pathname !== '/' || origin.search || /[?#]/.test(serviceOrigin) || typeof requestImplementation !== 'function') {
    throw new Error('Invalid CMS transport origin');
  }
  return (address, options) => new Promise((resolve, reject) => {
    if (typeof address !== 'string' || !address.startsWith(`${origin.origin}/`)) {
      reject(new Error('Invalid CMS transport address')); return;
    }
    const path = address.slice(origin.origin.length);
    if (!path.startsWith('/') || /[#\p{Cc}\s]/u.test(path)) {
      reject(new Error('Invalid CMS transport path')); return;
    }
    try {
      const request = requestImplementation({
        protocol: 'https:', hostname: origin.hostname.replace(/^\[|\]$/g, ''), port: origin.port || 443,
        path, method: options.method, headers: options.headers, signal: options.signal,
        rejectUnauthorized: true, minVersion: 'TLSv1.2',
      }, (response) => {
        const headers = { get(name) {
          const value = response.headers[String(name).toLowerCase()];
          return value === undefined ? null : Array.isArray(value) ? value.join(', ') : String(value);
        } };
        resolve({ status: response.statusCode, url: address, redirected: false, headers, body: Readable.toWeb(response) });
      });
      request.once('error', () => reject(new Error('CMS transport failed')));
      request.end(options.body);
    } catch { reject(new Error('CMS transport failed')); }
  });
}
