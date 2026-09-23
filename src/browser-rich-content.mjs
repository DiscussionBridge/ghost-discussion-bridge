import katex from "katex";
import mermaid from "mermaid";

const selector = "pre > code.lang-mermaid, pre > code.language-mermaid";

function renderMath(expression, target, displayMode = false) {
  katex.render(expression.trim(), target, {
    displayMode,
    output: "mathml",
    throwOnError: false,
    strict: "warn",
  });
  target.classList.add("discussionbridge-math");
}

function renderInlineMath(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const candidates = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement?.closest("code, pre, script, style, .katex, .math")) {
      candidates.push(node);
    }
  }

  for (const node of candidates) {
    const source = node.textContent ?? "";
    const pattern = /\[math\]([\s\S]*?)\[\/math\]|\$(?!\d)([^$\n]+?)(?<!\s)\$/gu;
    if (!pattern.test(source)) continue;
    pattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of source.matchAll(pattern)) {
      fragment.append(source.slice(offset, match.index));
      const span = document.createElement("span");
      renderMath(match[1] ?? match[2], span);
      fragment.append(span);
      offset = match.index + match[0].length;
    }
    fragment.append(source.slice(offset));
    node.replaceWith(fragment);
  }
}

function renderCookedMath(root) {
  for (const element of root.querySelectorAll(".math:not(.katex)")) {
    if (element.querySelector(".katex")) continue;
    const source = element.textContent?.trim();
    if (source) renderMath(source, element, element.tagName === "DIV");
  }
}

function renderBlockMath(root) {
  for (const paragraph of root.querySelectorAll("p")) {
    const match = /^\s*(?:\[math\]([\s\S]*?)\[\/math\]|\$\$([\s\S]*?)\$\$)\s*$/u.exec(
      paragraph.textContent ?? "",
    );
    if (!match) continue;
    paragraph.replaceChildren();
    renderMath(match[1] ?? match[2], paragraph, true);
  }
}

async function render(root = document) {
  renderBlockMath(root);
  renderCookedMath(root);
  renderInlineMath(root);
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
style.textContent = ".md-table{max-width:100%;overflow-x:auto}.md-table table{width:100%;border-collapse:collapse}.md-table th,.md-table td{padding:.65rem .75rem;border:1px solid color-mix(in srgb,currentColor 22%,transparent);text-align:left;vertical-align:top}.discussionbridge-mermaid,.discussionbridge-math{max-width:100%;overflow-x:auto}.discussionbridge-mermaid svg{display:block;height:auto;max-width:100%;margin-inline:auto}.discussionbridge-math[aria-hidden=true]+math{display:none}";
document.head.append(style);

const start = () => render(document).catch((error) => {
  document.documentElement.dataset.discussionbridgeRichContent = "attention";
  console.error("DiscussionBridge rich-content rendering failed", error);
});
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();

export { render };
