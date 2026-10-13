class ResponseBoundaryError extends Error {}

// One deadline covers headers AND the decoded body. Retain at most the admitted
// byte budget rather than accumulating an unbounded body before inspecting it.
export async function boundedResponse(fetchImplementation, address, options, {
  origin, mediaType, maximumBytes, timeoutMs = 10_000,
  transportError, originError, mediaError, limitError,
}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error("Invalid response boundary");
  const controller = new AbortController();
  const expiresAt = performance.now() + timeoutMs;
  let rejectDeadline;
  const deadline = new Promise((_resolve, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => { controller.abort(); rejectDeadline(new ResponseBoundaryError(transportError)); }, timeoutMs);
  let response, reader;
  const checkDeadline = () => { if (performance.now() >= expiresAt) throw new ResponseBoundaryError(transportError); };
  try {
    response = await Promise.race([fetchImplementation(address, { ...options, signal: controller.signal }), deadline]);
    checkDeadline();
    if (response.url && new URL(response.url).origin !== origin) throw new ResponseBoundaryError(originError);
    if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith(mediaType)) throw new ResponseBoundaryError(mediaError);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximumBytes) throw new ResponseBoundaryError(limitError);
    const chunks = [];
    let length = 0;
    if (response.body) {
      reader = response.body.getReader();
      for (;;) {
        checkDeadline();
        const { done, value } = await Promise.race([reader.read(), deadline]);
        checkDeadline();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new ResponseBoundaryError(mediaError);
        if (value.byteLength > maximumBytes - length) throw new ResponseBoundaryError(limitError);
        chunks.push(value);
        length += value.byteLength;
      }
    }
    return { response, bytes: Buffer.concat(chunks, length) };
  } catch (error) {
    controller.abort();
    // Cancellation must not become another unbounded awaited operation. The
    // request is already failed; release any reader once cancellation settles.
    try {
      const cancellation = reader ? reader.cancel() : response?.body?.cancel();
      if (cancellation) void Promise.resolve(cancellation).catch(() => {}).finally(() => { try { reader?.releaseLock(); } catch {} });
    } catch {}
    throw error instanceof ResponseBoundaryError ? error : new Error(transportError);
  } finally {
    clearTimeout(timer);
    try { reader?.releaseLock(); } catch {}
  }
}
