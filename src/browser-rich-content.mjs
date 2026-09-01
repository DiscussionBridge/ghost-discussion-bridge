import mermaid from "mermaid";

const selector = "pre > code.lang-mermaid, pre > code.language-mermaid";

async function render(root = document) {
  const diagrams = [...root.querySelectorAll(selector)].map((code) => {
    const container = document.createElement("div");
    container.className = "mermaid discussionbridge-mermaid";
    container.textContent = code.textContent ?? "";
    code.parentElement.replaceWith(container);
    return container;
  });
  if (!diagrams.length) return;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  await mermaid.run({ nodes: diagrams, suppressErrors: false });
}

const style = document.createElement("style");
style.textContent = ".discussionbridge-mermaid{max-width:100%;overflow-x:auto}.discussionbridge-mermaid svg{display:block;height:auto;max-width:100%;margin-inline:auto}";
document.head.append(style);

const start = () => render(document).catch(() => {});
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();

export { render };
