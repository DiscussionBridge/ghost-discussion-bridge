(() => {
  for (const target of document.querySelectorAll("[data-discussionbridge-resource]")) {
    const resource = target.getAttribute("data-discussionbridge-resource");
    if (!/^[0-9a-f-]{36}$/i.test(resource || "")) continue;
    fetch(`/discussionbridge/presentation/${encodeURIComponent(resource)}`, { credentials: "same-origin", redirect: "error" })
      .then((response) => { if (!response.ok) throw new Error(); return response.text(); })
      .then((html) => { target.innerHTML = html; })
      .catch(() => { target.textContent = "Discussion is temporarily unavailable."; });
  }

  for (const target of document.querySelectorAll("[data-discussionbridge-comments]")) {
    const mode = target.getAttribute("data-discussionbridge-comments") || "full";
    if (!new Set(["full", "fullInteractive"]).has(mode)) {
      target.textContent = "Discussion is temporarily unavailable.";
      continue;
    }
    const source = new URL(document.querySelector('link[rel="canonical"]')?.href || window.location.href);
    source.search = "";
    source.hash = "";
    fetch(`/discussionbridge/comments?source=${encodeURIComponent(source.href)}`, { credentials: "same-origin", redirect: "error" })
      .then((response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then((record) => {
        if (!Number.isSafeInteger(record.topic_id) || record.topic_id <= 0 || new URL(record.topic_url).origin !== record.forum_origin) throw new Error();
        const header = document.createElement("div");
        header.className = "discussionbridge-comments-header";
        const heading = document.createElement("h2");
        heading.textContent = "Discussion";
        const link = document.createElement("a");
        link.href = record.topic_url;
        link.textContent = "Open discussion";
        link.rel = "nofollow noopener noreferrer";
        header.append(heading, link);
        target.before(header);
        if (!document.querySelector("style[data-discussionbridge-comments-style]")) {
          const style = document.createElement("style");
          style.setAttribute("data-discussionbridge-comments-style", "");
          style.textContent = ".discussionbridge-comments-header{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;margin-block-end:1rem}.discussionbridge-comments-header h2{margin:0}";
          document.head.appendChild(style);
        }
        target.id = "discourse-comments";
        window.DiscourseEmbed = {
          discourseUrl: `${record.forum_origin}/`,
          topicId: record.topic_id,
          ...(mode === "fullInteractive" ? {
            fullApp: true,
            embedHeight: "800px",
            dynamicHeight: true,
            embedMinHeight: "360",
          } : {}),
        };
        const script = document.createElement("script");
        script.async = true;
        script.src = `${record.forum_origin}/javascripts/embed.js`;
        script.setAttribute("data-discussionbridge-comments-script", "");
        document.head.appendChild(script);
      })
      .catch(() => { target.textContent = "Discussion is temporarily unavailable."; });
  }
})();
