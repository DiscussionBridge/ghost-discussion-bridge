// Load the ESM parser/entity dependencies to completion before the CommonJS
// sanitizer requires them. Dynamic ESM loading also respects a caller's linked
// parser graph on Node 22.12, avoiding an immediate require(ESM) cycle in either
// co-import order. Keep the exact locked functions and all caller options.
const { Parser, parseDocument } = await import("htmlparser2");
const { decodeHTML } = await import("entities");
const { default: sanitizeHtml } = await import("sanitize-html");
export { Parser, parseDocument, decodeHTML };
export default sanitizeHtml;
