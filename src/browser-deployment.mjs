// Capture document.currentScript.src before asynchronous work begins. Relative
// fetch URLs resolve against the Ghost document, not the script's host.
export function browserDeployment(scriptUrl) {
  const url = new URL(scriptUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.pathname !== "/discussionbridge/assets/loader.js") {
    throw new Error("Invalid DiscussionBridge loader URL");
  }
  const base = `${url.origin}/discussionbridge/`;
  const version = url.searchParams.get("v");
  if (version !== null && !/^[a-f0-9]{64}$/u.test(version)) throw new Error("Invalid DiscussionBridge asset version");
  return {
    base,
    stylesheet: `${base}assets/loader.css${version ? `?v=${version}` : ""}`,
  };
}
