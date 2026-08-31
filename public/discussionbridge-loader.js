(() => {
  function installContents(root) {
    if (!root || root.querySelector(":scope > .discussionbridge-contents")) return;
    const used = new Set();
    const headings = [...root.querySelectorAll("h2, h3")].filter((heading) => heading.textContent.trim() !== "Discussion");
    if (headings.length < 2) return;
    const items = headings.map((heading, index) => {
      const base = (heading.id || heading.textContent)
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || `section-${index + 1}`;
      let id = base;
      let suffix = 2;
      while (used.has(id) || (document.getElementById(id) && document.getElementById(id) !== heading)) id = `${base}-${suffix++}`;
      used.add(id);
      heading.id = id;
      const item = document.createElement("li");
      if (heading.tagName === "H3") item.className = "discussionbridge-contents__nested";
      const link = document.createElement("a");
      link.href = `#${id}`;
      link.textContent = heading.textContent.trim();
      item.appendChild(link);
      return item;
    });
    const nav = document.createElement("nav");
    nav.className = "discussionbridge-contents";
    nav.setAttribute("aria-label", "On this page");
    const title = document.createElement("strong");
    title.textContent = "On this page";
    const list = document.createElement("ol");
    list.append(...items);
    nav.append(title, list);
    root.prepend(nav);
    if (!document.querySelector("style[data-discussionbridge-contents-style]")) {
      const style = document.createElement("style");
      style.setAttribute("data-discussionbridge-contents-style", "");
      style.textContent = ".discussionbridge-contents{margin:0 0 2rem;padding:1rem 1.25rem;border:1px solid var(--color-border,#d8d8d8);border-radius:.5rem;background:var(--color-lighter-gray,#f7f7f7)}.discussionbridge-contents strong{display:block;margin-bottom:.5rem}.discussionbridge-contents ol{margin:0;padding-left:1.25rem}.discussionbridge-contents__nested{margin-left:1rem}";
      document.head.appendChild(style);
    }
  }

  for (const target of document.querySelectorAll("[data-discussionbridge-resource]")) {
    const resource = target.getAttribute("data-discussionbridge-resource");
    if (!/^[0-9a-f-]{36}$/i.test(resource || "")) continue;
    fetch(`/discussionbridge/presentation/${encodeURIComponent(resource)}`, { credentials: "same-origin", redirect: "error" })
      .then((response) => { if (!response.ok) throw new Error(); return response.text(); })
      .then((html) => { target.innerHTML = html; installContents(target); })
      .catch(() => { target.textContent = "Discussion is temporarily unavailable."; });
  }

  for (const target of document.querySelectorAll("[data-discussionbridge-comments]")) {
    const mode = target.getAttribute("data-discussionbridge-comments") || "full";
    if (!new Set(["full", "fullInteractive"]).has(mode)) {
      target.textContent = "Discussion is temporarily unavailable.";
      continue;
    }
    const source = new URL(document.querySelector('link[rel="canonical"]')?.href || window.location.href);
    installContents(document.querySelector(".gh-content"));
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
            dynamicHeight: false,
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
