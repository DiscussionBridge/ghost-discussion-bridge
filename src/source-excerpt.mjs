import sanitizeHtml, { decodeHTML } from "./html-sanitizer.mjs";
const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// Existing To text-excerpt recipe, with no generated ownership or source
// admission policy. The separately prepared complete source remains required.
export function outboundArticle(html, maximumBytes) {
  const parts = [];
  sanitizeHtml(html, { allowedTags: [], allowedAttributes: {}, textFilter(text) { parts.push(text); return ""; }, onOpenTag(tag) { if (["p", "br", "h1", "h2", "h3", "li"].includes(tag)) parts.push(" "); } });
  const budget = maximumBytes - Buffer.byteLength("<p></p>");
  if (budget < 1) throw new Error("Ghost publication metadata leaves no room for a source excerpt.");
  // Slice whole Unicode code points; an excerpt must not introduce an unpaired
  // surrogate when a non-BMP character falls on the boundary.
  const characters = [...decodeHTML(parts.join("")).trim()];
  let end = Math.min(characters.length, budget);
  let text = characters.slice(0, end).join("");
  while (Buffer.byteLength(escape(text)) > budget) { end = Math.floor(end * 0.9); text = characters.slice(0, end).join(""); }
  return `<p>${escape(text)}</p>`;
}
