import { Parser } from "htmlparser2";
import { anchorCopiedArticleReferences } from "./article-references.mjs";

// A preserving native-copy preparation, not a generic sanitizer/preset or a
// source-format gate. Keep original markup/data; report actual facilities whose
// copied function is not implemented rather than deleting them. Native receiver
// rendering still needs qualification and can reject a non-preserving copy.
const controls = {
  audio: "audio playback and native media controls", video: "video playback and native media controls/captions",
  iframe: "embedded frame/provider function", object: "embedded object function/data", embed: "embedded provider function/data",
  form: "form submission", input: "input control", button: "button control", select: "choice-selection control",
  textarea: "text-entry control", details: "disclosure expand/collapse", summary: "disclosure summary control",
};
const handlers = new Set(("onclick ondblclick oninput onchange onsubmit onreset onload onerror onkeydown onkeyup onkeypress onfocus onblur onpointerdown onpointerup onpointermove onmouseover onmouseout onmousemove onmousedown onmouseup ontouchstart ontouchend onanimationstart onanimationend ontransitionend ondrag ondrop onpaste oncopy oncut onplay onpause onended onseeked ontimeupdate onwheel onscroll ontoggle onbeforetoggle onloadstart onloadeddata oncanplay onabort oninvalid onbeforeinput").split(" "));
export function sourcePreparationLimitation(detail) {
  const error = new Error(`Ghost Bridge cannot preserve ${detail}; the native source remains intact and supported handling or an explicit operator choice is required`);
  error.localSourcePreparationLimitation = true;
  return error;
}

function inspectLexical(capture) {
  if (capture.lexical === null || capture.lexical === undefined) return;
  let lexical;
  try { lexical = JSON.parse(capture.lexical); }
  catch { throw sourcePreparationLimitation("the supplied native Lexical/card context because its JSON is malformed"); }
  if (!lexical || typeof lexical !== "object" || Array.isArray(lexical)) throw sourcePreparationLimitation("the supplied native Lexical/card context because its root is unavailable");
  const pending = [lexical];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object") continue;
    const web = !Array.isArray(node) && node.visibility && typeof node.visibility === "object" ? node.visibility.web : undefined;
    if (web !== undefined && (!web || typeof web !== "object" || web.nonMember !== true || web.memberSegment)) {
      // Admin HTML alone does not establish an audience-selected card variant.
      // Do not strip that original context or invent a public audience rule.
      throw sourcePreparationLimitation("the native card visibility/audience context without an established matching article variant");
    }
    for (const value of Object.values(node)) if (value && typeof value === "object") pending.push(value);
  }
}

export function prepareGhostSourceHtml(html, capture) {
  if (typeof html !== "string" || Buffer.from(html).toString("utf8") !== html || capture?.html !== html || typeof capture.article_url !== "string") {
    throw sourcePreparationLimitation("the complete captured native article and its original URL exactly");
  }
  inspectLexical(capture);
  let script = null, style = false;
  const ancestors = [];
  const finishScript = () => {
    if (!script) return;
    if (!script.source && !script.content) { script = null; return; }
    const executable = ["", "module", "text/javascript", "application/javascript"].includes(script.type);
    throw sourcePreparationLimitation(executable ? "source script execution and its native runtime dependency" : "embedded script content/data and its native consumer");
  };
  new Parser({
    onopentag(name, attributes) {
      if (controls[name]) throw sourcePreparationLimitation(name === "button" && ancestors.some((node) => node.toggle) ? "native toggle disclosure expand/collapse control" : controls[name]);
      ancestors.push({ name, toggle: Object.hasOwn(attributes, "data-kg-toggle-state") });
      if (name === "script") script = { type: (attributes.type ?? "").trim().toLowerCase(), source: Boolean(attributes.src?.trim()), content: false };
      if (name === "style") style = true;
      if (name === "base") throw sourcePreparationLimitation("the article base-URL context without changing original reference targets");
      if (name === "meta" && (attributes["http-equiv"] ?? "").toLowerCase() === "refresh") throw sourcePreparationLimitation("automatic refresh/navigation");
      if (name === "link" && /(?:^|\s)(?:stylesheet|import)(?:\s|$)/iu.test(attributes.rel ?? "")) throw sourcePreparationLimitation("the external stylesheet/import dependency");
      for (const [attribute, value] of Object.entries(attributes)) {
        if (handlers.has(attribute) && value.trim()) throw sourcePreparationLimitation(`the source ${attribute} handler function`);
        if (["href", "src", "poster", "xlink:href", "action", "formaction"].includes(attribute) && /^[\s\p{Cc}]*(?:j[\s\p{Cc}]*a[\s\p{Cc}]*v[\s\p{Cc}]*a[\s\p{Cc}]*s[\s\p{Cc}]*c[\s\p{Cc}]*r[\s\p{Cc}]*i[\s\p{Cc}]*p[\s\p{Cc}]*t|vbscript)[\s\p{Cc}]*:/iu.test(value)) {
          throw sourcePreparationLimitation(`source script execution-bearing navigation/reference in ${attribute}`);
        }
      }
    },
    ontext(text) { if (script && text.trim()) script.content = true; if (style && text.trim()) throw sourcePreparationLimitation("the embedded stylesheet data/runtime and its compound references"); },
    onclosetag(name) { if (name === "script") finishScript(); if (name === "style") style = false; ancestors.pop(); },
    onend() { finishScript(); },
  }, { decodeEntities: true }).end(html);
  // No text/prose test: image-only and unformatted text remain source content.
  // The shared codec retains its own exact bounds; no filler/absence rule here.
  return anchorCopiedArticleReferences(html, capture.article_url);
}
