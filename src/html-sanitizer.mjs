// Let the CommonJS sanitizer finish its synchronous parser loading before
// requesting those same ESM exports. Enter it through dynamic import so a
// caller's static parser graph can finish first on Node 22.12; do not start a
// competing parser import that races the sanitizer on Node 24. Keep the exact
// locked functions and all caller options.
const { default: sanitizeHtml } = await import("sanitize-html");
const { Parser, parseDocument } = await import("htmlparser2");
const { decodeHTML } = await import("entities");
export { Parser, parseDocument, decodeHTML };
export default sanitizeHtml;
