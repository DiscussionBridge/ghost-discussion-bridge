import { Parser } from "./html-sanitizer.mjs";
import { escapeAttribute } from "entities";

// Mechanical target preservation, NOT a sanitizer or URI/provider policy.
// Preserve attribute spelling except the actual target value being anchored.
const scalarTargets = new Set(["href", "src", "poster", "xlink:href", "cite", "background", "longdesc"]);
export function anchorCopiedArticleReferences(html, articleUrl) {
  const patches = [];
  let seen, inTag = false, parser;
  const limited = (detail) => { throw new Error(`Ghost Bridge cannot preserve prepared article references (${detail}); preparation attention is required`); };
  const anchor = (value) => {
    try { new URL(value); return value; } catch {}
    try { return new URL(value, articleUrl).href; } catch { limited("unrepresentable original target"); }
  };
  const srcset = (value) => {
    const candidates = []; let position = 0;
    while (position < value.length) {
      while (/[\t\n\f\r ,]/u.test(value[position] ?? "") && position < value.length) position++;
      if (position === value.length) break;
      const start = position;
      while (position < value.length && !/[\t\n\f\r ]/u.test(value[position])) position++;
      let url = value.slice(start, position), descriptor = "";
      if (url.endsWith(",")) url = url.replace(/,+$/u, "");
      else {
        const descriptorStart = position;
        while (position < value.length && value[position] !== ",") position++;
        descriptor = value.slice(descriptorStart, position).trim();
        if (position < value.length) position++;
      }
      if (!url || descriptor && !/^(?:[1-9][0-9]*w|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)x)$/u.test(descriptor) || descriptor.endsWith("x") && !(Number(descriptor.slice(0, -1)) > 0)) limited("srcset candidate/descriptor grammar is not representable");
      candidates.push(anchor(url) + (descriptor ? ` ${descriptor}` : ""));
    }
    return candidates.join(", ");
  };
  const css = (value) => {
    if (/expression\s*\(|@import/iu.test(value)) limited("inline CSS execution/import function has no preserving native mapping");
    if (/\\[^;]*\(/u.test(value)) limited("escaped CSS reference/function grammar is not implemented");
    let parsed = 0;
    const anchored = value.replace(/url\s*\(([^)]*)\)/giu, (_match, content) => {
      parsed++;
      const token = content.trim(), quote = token[0]; let target;
      if (quote === '"' || quote === "'") {
        if (token.at(-1) !== quote || token.slice(1, -1).includes(quote) || token.includes("\\")) limited("quoted CSS URL grammar is not implemented");
        target = token.slice(1, -1);
      } else {
        if (/[\s'"()\\]/u.test(token)) limited("CSS URL grammar is not implemented");
        target = token;
      }
      return `url("${anchor(target).replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}")`;
    });
    if (parsed !== (value.match(/url\s*\(/giu) ?? []).length) limited("unfinished CSS URL reference grammar");
    return anchored;
  };
  parser = new Parser({
    onopentagname() { seen = new Set(); inTag = true; },
    onattribute(name, value, quote) {
      if (!scalarTargets.has(name) && !["srcset", "style"].includes(name)) return;
      if (seen.has(name)) limited(`duplicate ${name}`);
      seen.add(name);
      const target = name === "srcset" ? srcset(value) : name === "style" ? css(value) : anchor(value);
      if (target === value) return;
      const start = parser.startIndex, end = parser.endIndex, raw = html.slice(start, end);
      const token = /^[^\s=/>]+\s*=\s*([\s\S]*)$/u.exec(raw);
      if (!token || quote === undefined || quote !== null && (token[1][0] !== quote || token[1].at(-1) !== quote)) limited(`unsupported ${name} value token`);
      const valueStart = start + raw.length - token[1].length;
      patches.push({ start: valueStart, end, value: `"${escapeAttribute(target)}"` });
    },
    onopentag() { inTag = false; },
  }, { decodeEntities: true });
  parser.end(html);
  if (inTag) limited("unfinished opening tag");
  let result = html, previous = html.length;
  for (const patch of patches.sort((a, b) => b.start - a.start)) {
    if (patch.end > previous || patch.start >= patch.end) limited("overlapping reference tokens");
    result = result.slice(0, patch.start) + patch.value + result.slice(patch.end); previous = patch.start;
  }
  return result;
}
