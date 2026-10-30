import { Parser, parseDocument } from "./html-sanitizer.mjs";

// These nodes/handlers are removed by the CURRENT renderer. Describe the lost
// native facility, not whether source content is valid/safe or what application
// it implements. This does not select execution/provider policy or a fallback.
const facilities = {
  form: "native form submission structure", input: "native input control", button: "native button control",
  select: "native choice-selection control", textarea: "native text-entry control",
  details: "native disclosure expand/collapse", summary: "native disclosure summary control",
};
const handlers = new Set(["onclick", "ondblclick", "oninput", "onchange", "onsubmit", "onreset", "onload", "onerror", "onkeydown", "onkeyup", "onfocus", "onblur", "onpointerdown", "onpointerup", "onmouseover", "onmouseout", "ontouchstart", "ontouchend"]);

function reportNativeLoss(unsupported, functions) {
  if (!unsupported.size && !functions.size) return;
  const losses = [...unsupported].filter((name) => !facilities[name] && name !== "script").map((name) => `${name} content`).concat([...functions]);
  const error = new Error(`Ghost current native renderer cannot preserve ${losses.join(", ")}; supported handling or an explicit operator decision is required and the source remains retained`);
  error.localNativeLimitation = true;
  error.unsupportedNativeElements = [...unsupported];
  error.unsupportedNativeFunctions = [...functions];
  throw error;
}

// Observe the ACTUAL conversion, rather than banning a source format or
// guessing which finite set of browser functions might be removed. Attribute
// and element counts account for unwrapped nodes without shifting subsequent
// node identities. Decoded text/attributes ignore harmless entity spelling.
function conversionContents(html) {
  const elements = new Map(), attributes = new Map(); let text = "";
  const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  const nodeText = (node) => node.type === "text" ? node.data : (node.children ?? []).map(nodeText).join("");
  const visit = (node) => {
    if (node.type === "comment") return;
    if (node.name) {
      const entries = Object.entries(node.attribs ?? {}).filter(([name, value]) => !((/^on[a-z]/u.test(name) || name === "class" || name === "style") && !value.trim()));
      // Existing inert, empty placeholders do not assert an invented function.
      if (["script", "style"].includes(node.name) && !entries.length && !nodeText(node).trim()) return;
      count(elements, node.name);
      for (const [name, value] of entries) count(attributes, JSON.stringify([node.name, name, value]));
    }
    if (node.type === "text") text += node.data;
    for (const child of node.children ?? []) visit(child);
  };
  visit(parseDocument(html, { decodeEntities: true }));
  return { elements, attributes, text };
}

export function assertNativeConversionPreserved(original, converted) {
  const before = conversionContents(original), after = conversionContents(converted);
  const unsupported = new Set(), functions = new Set();
  for (const [name, count] of before.elements) if ((after.elements.get(name) ?? 0) < count) {
    unsupported.add(name);
    functions.add(name === "style" ? "source stylesheet content/data" : `source ${name} content/structure`);
  }
  for (const [key, count] of before.attributes) if ((after.attributes.get(key) ?? 0) < count) {
    const [tag, name] = JSON.parse(key);
    functions.add(/^on[a-z]/u.test(name) ? `source ${name} handler` : `source ${tag} ${name} attribute`);
  }
  if (before.text !== after.text) functions.add("source text/content");
  reportNativeLoss(unsupported, functions);
}

export function assertNativeContentRepresentable(html) {
  if (typeof html !== "string") throw new Error("Ghost native source content is unavailable");
  const unsupported = new Set(), functions = new Set();
  let script = null;
  const finishScript = () => {
    if (script && (script.source || script.content)) {
      unsupported.add("script");
      functions.add(["", "module", "text/javascript", "application/javascript"].includes(script.type) ? "source script execution" : ["application/json", "application/ld+json", "text/plain"].includes(script.type) ? "embedded script content/data" : "source script content");
    }
    script = null;
  };
  new Parser({
    onopentag(name, attributes) {
      if (["video", "audio", "iframe", "embed", "object"].includes(name)) unsupported.add(name);
      if (facilities[name]) { unsupported.add(name); functions.add(facilities[name]); }
      if (name === "script") {
        script = { type: (attributes.type ?? "").trim().toLowerCase(), source: Boolean(attributes.src?.trim()), content: false };
      }
    },
    onattribute(name, value) { if (handlers.has(name) && value.trim()) functions.add(`source ${name} handler`); },
    ontext(text) { if (script && text.trim()) script.content = true; },
    onclosetag(name) { if (name === "script") finishScript(); },
    onend() { finishScript(); },
  }).end(html);
  reportNativeLoss(unsupported, functions);
}
