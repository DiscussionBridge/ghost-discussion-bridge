import { randomUUID } from "node:crypto";
import { validateCms } from "../lib/cms-runtime.mjs";
import { nativeOwnershipHash } from "./cms-native-publication.mjs";

export function ghostMoveDestination(address, origin) {
  validateCms("Url", address);
  const url = new URL(address);
  if (url.href !== address || url.origin !== origin || url.username || url.password || url.search || url.hash || !/^\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/u.test(url.pathname) || url.pathname.length > 193) throw new Error("Ghost URL movement supports an exact same-origin root slug URL only");
  return url.pathname.slice(1, -1);
}

// Local protected intent only. No claim/work/lease/publication authority is
// created by an operator request. The existing authorized worker consumes it.
export async function queueGhostPresentationMove(config, store, request) {
  if (typeof store.withNativeLock !== "function") throw new Error("Ghost URL movement requires the current V4 native writer");
  validateCms("UUID", request.mapping_id); validateCms("Revision", request.expected_mapping_revision);
  ghostMoveDestination(request.new_url, config.ghostOrigin);
  return store.withNativeLock(async (assertNative) => {
    await assertNative();
    let requestId;
    await store.update(async (state) => {
      const matches = Object.values(state.publications).filter((item) => item.cms?.mapping_id === request.mapping_id);
      if (matches.length !== 1) throw new Error("Ghost URL move requires one current native CMS mapping");
      const item = matches[0], receipt = item.cms.ownership_receipt;
      if (!receipt || nativeOwnershipHash(receipt) !== item.cms.ownership_receipt_sha256 || receipt.mapping_id !== request.mapping_id || receipt.native_id !== item.ghost_post_id || receipt.canonical_url !== item.canonical_url || receipt.connection_id !== config.connectionId || receipt.forum_origin !== config.serverUrl) throw new Error("Ghost URL move requires an exact current native ownership receipt");
      if (request.new_url === item.canonical_url || Object.values(state.publications).some((other) => other !== item && (other.canonical_url === request.new_url || other.cms?.url_move_request?.new_url === request.new_url || other.cms?.url_history?.some((entry) => entry.url === request.new_url))) || Object.values(state.posts).some((other) => other.canonical_url === request.new_url)) throw new Error("Ghost proposed move URL collides with current or retained material");
      const prior = item.cms.url_move_request;
      if (prior && !["committed", "aborted"].includes(prior.state)) {
        if (prior.new_url === request.new_url && prior.expected_mapping_revision === request.expected_mapping_revision) { requestId = prior.request_id; return; }
        if (prior.state !== "queued" || prior.old_native || prior.move || prior.native_intent || prior.new_url !== request.new_url) throw new Error("Ghost prior move must be reconciled before another URL is requested");
      }
      requestId = randomUUID();
      item.cms.url_move_request = { request_id: requestId, expected_mapping_revision: request.expected_mapping_revision, old_url: item.canonical_url, new_url: request.new_url, state: "queued", requested_at: new Date().toISOString() };
    });
    return { request_id: requestId, state: "queued" };
  });
}
