const nativeId = /^[a-f0-9]{24}$/u;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const check = (condition, message) => { if (!condition) throw new Error(message); };

// A signed native notification is an identity signal, never proof of deletion,
// unpublication, opt-in or current HTML. The shared writer reads actual Admin
// state under its native lock before choosing any action.
export function ghostSourceNotification(payload, state, config) {
  const post = payload?.post;
  check(object(post), "Invalid Ghost original source notification");
  const previousOnly = post.current === null || post.current === undefined || object(post.current) && Object.keys(post.current).length === 0;
  const notification = previousOnly ? post.previous : post.current;
  check(object(notification) && nativeId.test(notification.id ?? "") && (notification.type === undefined || notification.type === "post"), "Invalid Ghost original source notification");
  if (!previousOnly && object(post.previous) && Object.hasOwn(post.previous, "id")) check(post.previous.id === notification.id, "Ghost notification has conflicting native source identities");
  const prior = state.posts[`ghost-post:${notification.id}`];
  if (previousOnly) {
    const scope = prior?.cms_source?.native_source_scope;
    check(prior?.source_protocol === "v4" && prior.resource_id && prior.topic_id && prior.cms_source?.accepted_revision && scope?.native_id === notification.id && scope.native_type === "post" && scope.ghost_origin === config.ghostOrigin && scope.admin_origin === (config.ghostAdminOrigin ?? config.ghostOrigin), "Ghost previous-only notification has no accepted exact native source scope");
  }
  if (Array.isArray(notification.tags) && notification.tags.some((tag) => tag?.name === "#discussionbridge-source" || tag?.slug === "hash-discussionbridge-source") && !prior?.cms_source?.accepted_revision) throw new Error("A received source cannot become a Ghost original");
  return { nativeId: notification.id, previousOnly };
}
