(() => {
  if (!document.body.classList.contains("page-template")) return;
  if (document.body.classList.contains("page-ghost-demos") && !document.querySelector("style[data-discussionbridge-demo-index-style]")) {
    const style = document.createElement("style");
    style.setAttribute("data-discussionbridge-demo-index-style", "");
    style.textContent = ".discussionbridge-demo-index{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin-block:2rem}.discussionbridge-demo-index__card{display:block;padding:1.25rem;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:14px;color:inherit;text-decoration:none;transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease}.discussionbridge-demo-index__card:hover{transform:translateY(-2px);border-color:var(--ghost-accent-color);box-shadow:0 12px 28px color-mix(in srgb,currentColor 10%,transparent)}.discussionbridge-demo-index__card strong{display:block;margin-bottom:.45rem;font-size:1.15em}.discussionbridge-demo-index__card span{display:block;line-height:1.55}@media(max-width:700px){.discussionbridge-demo-index{grid-template-columns:1fr}}";
    document.head.appendChild(style);
  }
  if ([...document.querySelectorAll(".gh-container-title")].some((heading) => heading.textContent?.trim() === "Read more")) return;

  const demos = [
    {
      href: "/portable-rich-content-from-ghost/",
      title: "Publishing through The Bridge",
      description: "Ghost-authored structure, rich content, and discussion delivered to The Bridge.",
    },
    {
      href: "/from-the-bridge/",
      title: "From The Bridge",
      description: "Forum-authored content presented safely in stock Ghost.",
    },
    {
      href: "/ghost-simple-comments/",
      title: "Simple comments",
      description: "Lightweight native reply cards with bounded disclosure.",
    },
    {
      href: "/ghost-full-comments/",
      title: "Full comments",
      description: "The familiar plugin-free Discourse comments presentation.",
    },
    {
      href: "/the-bridge-publishes-everywhere/",
      title: "The Bridge — Discourse as Publisher",
      description: "One forum-owned source published natively across connected platforms.",
    },
  ];

  const current = new URL(window.location.href).pathname;
  const cards = demos.filter(({ href }) => href !== current).slice(0, 4);
  const section = document.createElement("section");
  section.className = "gh-container is-grid gh-outer discussionbridge-read-more";
  section.setAttribute("data-discussionbridge-read-more", "");
  const inner = document.createElement("div");
  inner.className = "gh-container-inner gh-inner";
  inner.style.display = "block";
  const heading = document.createElement("h2");
  heading.className = "gh-container-title";
  heading.textContent = "Read more";
  const feed = document.createElement("div");
  feed.className = "gh-feed";

  for (const demo of cards) {
    const article = document.createElement("article");
    article.className = "gh-card post no-image";
    const link = document.createElement("a");
    link.className = "gh-card-link";
    link.href = demo.href;
    const wrapper = document.createElement("div");
    wrapper.className = "gh-card-wrapper";
    const title = document.createElement("h3");
    title.className = "gh-card-title is-title";
    title.textContent = demo.title;
    const description = document.createElement("p");
    description.className = "gh-card-excerpt is-body";
    description.textContent = demo.description;
    wrapper.append(title, description);
    link.appendChild(wrapper);
    article.appendChild(link);
    feed.appendChild(article);
  }

  inner.append(heading, feed);
  section.appendChild(inner);
  document.querySelector(".gh-footer")?.before(section);
})();
