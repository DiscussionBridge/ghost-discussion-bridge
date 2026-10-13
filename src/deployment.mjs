export const PUBLIC_PREFIX = "/discussionbridge/";

export function adapterPublicBase(origin) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Invalid public adapter origin");
  }
  return `${url.origin}${PUBLIC_PREFIX}`;
}
