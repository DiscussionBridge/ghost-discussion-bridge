// Native public Core APIs may return safe numeric IDs. Bridge CoreId strings
// remain exact at native/public boundaries and are never rounded to Number.

export function nativeTopicUrl(value, origin, topicId) {
  const url = new URL(value);
  if (url.origin !== origin || url.username || url.password || url.search || url.hash || !isTopicIdentity(topicId) || !new RegExp(`^/t/(?:[^/]+/)?${topicId}/?$`, "u").test(url.pathname)) throw new Error("Invalid native topic URL/identity");
  return url.href;
}
export function isTopicIdentity(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0;
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/u.test(value) && (value.length < 19 || value <= "9223372036854775807");
}
