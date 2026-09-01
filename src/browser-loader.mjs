import katex from "katex";
import "katex/dist/katex.min.css";
import mermaid from "mermaid";

mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });

function installStylesheet() {
  if (document.querySelector('link[data-discussionbridge-renderer-style]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/discussionbridge/assets/loader.css";
  link.setAttribute("data-discussionbridge-renderer-style", "");
  document.head.appendChild(link);
}

function renderInlineMath(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const candidates = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement?.closest("code, pre, script, style, .katex")) candidates.push(node);
  }
  for (const node of candidates) {
    const source = node.textContent;
    const pattern = /\[math\]([\s\S]*?)\[\/math\]|\$([^$\n]+?)\$/gu;
    if (!pattern.test(source)) continue;
    pattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of source.matchAll(pattern)) {
      fragment.append(source.slice(offset, match.index));
      const span = document.createElement("span");
      katex.render((match[1] ?? match[2]).trim(), span, { throwOnError: false, strict: "warn" });
      fragment.append(span);
      offset = match.index + match[0].length;
    }
    fragment.append(source.slice(offset));
    node.replaceWith(fragment);
  }
}

function renderCookedMath(root) {
  for (const element of root.querySelectorAll(".math")) {
    if (element.querySelector(".katex")) continue;
    const source = element.textContent.trim();
    if (!source) continue;
    katex.render(source, element, {
      displayMode: element.tagName === "DIV",
      throwOnError: false,
      strict: "warn",
    });
  }
}

async function renderRichContent(root) {
  if (!root) return;
  installStylesheet();
  const diagrams = [];
  for (const code of root.querySelectorAll("pre > code.lang-mermaid, pre > code.language-mermaid")) {
    const diagram = document.createElement("div");
    diagram.className = "mermaid discussionbridge-mermaid";
    diagram.textContent = code.textContent;
    code.parentElement.replaceWith(diagram);
    diagrams.push(diagram);
  }
  for (const paragraph of root.querySelectorAll("p")) {
    const match = /^\s*(?:\[math\]([\s\S]*?)\[\/math\]|\$\$([\s\S]*?)\$\$)\s*$/u.exec(paragraph.textContent);
    if (!match) continue;
    paragraph.replaceChildren();
    katex.render((match[1] ?? match[2]).trim(), paragraph, { displayMode: true, throwOnError: false, strict: "warn" });
  }
  renderCookedMath(root);
  renderInlineMath(root);
  if (diagrams.length) await mermaid.run({ nodes: diagrams, suppressErrors: false });
}

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
    style.textContent = ".discussionbridge-contents{margin:0 0 2rem;padding:1rem 1.25rem;border:1px solid var(--color-border,#d8d8d8);border-radius:.5rem;background:var(--color-lighter-gray,#f7f7f7)}.discussionbridge-contents strong{display:block;margin-bottom:.5rem}.discussionbridge-contents ol{margin:0;padding-left:1.25rem}.discussionbridge-contents__nested{margin-left:1rem}.discussionbridge-mermaid{max-width:100%;margin-block:1.5rem;overflow-x:auto}.discussionbridge-mermaid svg{display:block;height:auto;max-width:100%;margin-inline:auto}";
    document.head.appendChild(style);
  }
}

function installDiscussionStyles() {
  if (!document.querySelector("style[data-discussionbridge-comments-style]")) {
    const style = document.createElement("style");
    style.setAttribute("data-discussionbridge-comments-style", "");
    style.textContent = ".discussionbridge-comments-header{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;margin-block:2rem 1rem}.discussionbridge-comments-header h2{margin:0}.discussionbridge-simple__reply{display:grid;grid-template-columns:2.75rem minmax(0,1fr);gap:1rem;padding:1rem 0;border-top:1px solid color-mix(in srgb,currentColor 14%,transparent)}.discussionbridge-simple__avatar{display:grid;width:2.75rem;height:2.75rem;overflow:hidden;place-items:center;border-radius:50%;background:color-mix(in srgb,currentColor 10%,transparent);font-weight:750}.discussionbridge-simple__avatar img{width:100%;height:100%;object-fit:cover}.discussionbridge-simple__content{min-width:0}.discussionbridge-simple__meta{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;margin:0 0 .65rem;font-size:14px}.discussionbridge-simple__more summary{width:max-content;max-width:100%;margin:1rem auto;padding:.55rem .9rem;border:1px solid color-mix(in srgb,currentColor 24%,transparent);border-radius:999px;cursor:pointer;font-weight:700}.discussionbridge-simple__more-open{display:none}.discussionbridge-simple__more[open] .discussionbridge-simple__more-closed{display:none}.discussionbridge-simple__more[open] .discussionbridge-simple__more-open{display:inline}.discussionbridge-simple__limit{text-align:center;font-size:.9rem}@media(max-width:520px){.discussionbridge-comments-header,.discussionbridge-simple__meta{align-items:flex-start;flex-direction:column}}";
    document.head.appendChild(style);
  }
}

function installInteractiveDiscussion(target, record, addHeader = true, sourcePresentation = false) {
  if (!target || !Number.isSafeInteger(record.topic_id) || record.topic_id <= 0) throw new Error("Invalid discussion identity");
  const topicUrl = new URL(record.topic_url);
  const forumOrigin = new URL(record.forum_origin);
  if (topicUrl.origin !== forumOrigin.origin || forumOrigin.href !== `${forumOrigin.origin}/`) throw new Error("Invalid discussion origin");
  if (addHeader) {
    const header = document.createElement("div");
    header.className = "discussionbridge-comments-header";
    const heading = document.createElement("h2");
    heading.textContent = "Discussion";
    const link = document.createElement("a");
    link.href = topicUrl.href;
    link.textContent = "Open discussion";
    link.rel = "nofollow noopener noreferrer";
    header.append(heading, link);
    target.before(header);
  }
  installDiscussionStyles();
  target.id = "discourse-comments";
  window.DiscourseEmbed = {
    discourseUrl: forumOrigin.href,
    topicId: record.topic_id,
    fullApp: true,
    embedHeight: "800px",
    dynamicHeight: false,
    embedMinHeight: "360",
    ...(sourcePresentation ? { className: "discussion-bridge-source-presentation" } : {}),
  };
  const script = document.createElement("script");
  script.async = true;
  script.src = `${forumOrigin.origin}/javascripts/embed.js`;
  script.setAttribute("data-discussionbridge-comments-script", "");
  document.head.appendChild(script);
}

const nativeArticle = document.querySelector(".gh-content");
if (nativeArticle) {
  renderRichContent(nativeArticle).then(() => installContents(nativeArticle));
  if (document.body.classList.contains("tag-hash-discussionbridge-source") && !nativeArticle.querySelector("[data-discussionbridge-comments]")) {
    const discussion = document.createElement("div");
    discussion.setAttribute("data-discussionbridge-comments", "fullInteractive");
    nativeArticle.appendChild(discussion);
  }
}

for (const target of document.querySelectorAll("[data-discussionbridge-resource]")) {
  if (target.dataset.discussionbridgePresentationMounted === "true") continue;
  target.dataset.discussionbridgePresentationMounted = "true";
  const resource = target.getAttribute("data-discussionbridge-resource");
  if (!/^[0-9a-f-]{36}$/i.test(resource || "")) continue;
  fetch(`/discussionbridge/presentation/${encodeURIComponent(resource)}`, { credentials: "same-origin", redirect: "error" })
    .then((response) => { if (!response.ok) throw new Error(); return response.text(); })
    .then(async (html) => {
      target.innerHTML = html;
      await renderRichContent(target);
      installContents(target);
      const discussion = target.querySelector("[data-discussionbridge-presentation-comments]");
      if (!discussion) throw new Error();
      installInteractiveDiscussion(discussion, {
        topic_id: Number(discussion.getAttribute("data-topic-id")),
        topic_url: discussion.getAttribute("data-topic-url"),
        forum_origin: discussion.getAttribute("data-forum-origin"),
      }, false, true);
    })
    .catch(() => { target.textContent = "Discussion is temporarily unavailable."; });
}

for (const target of document.querySelectorAll("[data-discussionbridge-comments]")) {
  if (target.dataset.discussionbridgeCommentsMounted === "true") continue;
  target.dataset.discussionbridgeCommentsMounted = "true";
  const mode = target.getAttribute("data-discussionbridge-comments") || "full";
  if (!new Set(["simple", "full", "fullInteractive"]).has(mode)) {
    target.textContent = "Discussion is temporarily unavailable.";
    continue;
  }
  const source = new URL(document.querySelector('link[rel="canonical"]')?.href || window.location.href);
  source.search = "";
  source.hash = "";
  if (mode === "simple") {
    installDiscussionStyles();
    fetch(`/discussionbridge/simple?source=${encodeURIComponent(source.href)}`, { credentials: "same-origin", redirect: "error" })
      .then((response) => { if (!response.ok) throw new Error(); return response.text(); })
      .then((html) => { target.innerHTML = html; return renderRichContent(target); })
      .catch(() => { target.textContent = "Discussion is temporarily unavailable."; });
    continue;
  }
  fetch(`/discussionbridge/comments?source=${encodeURIComponent(source.href)}`, { credentials: "same-origin", redirect: "error" })
    .then((response) => { if (!response.ok) throw new Error(); return response.json(); })
    .then((record) => {
      if (mode === "fullInteractive") {
        installInteractiveDiscussion(target, record);
        return;
      }
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
      installDiscussionStyles();
      target.id = "discourse-comments";
      window.DiscourseEmbed = { discourseUrl: `${record.forum_origin}/`, topicId: record.topic_id };
      const script = document.createElement("script");
      script.async = true;
      script.src = `${record.forum_origin}/javascripts/embed.js`;
      script.setAttribute("data-discussionbridge-comments-script", "");
      document.head.appendChild(script);
    })
    .catch(() => { target.textContent = "Discussion is temporarily unavailable."; });
}
