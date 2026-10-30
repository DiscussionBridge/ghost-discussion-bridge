import "htmlparser2";
import { createRequire } from "node:module";

// Evaluate the parser before the CommonJS sanitizer requires that same ESM
// dependency. Node 22.12 otherwise rejects some cold product import graphs as
// an immediate require(ESM) cycle. Keep the exact sanitizer and caller options.
export default createRequire(import.meta.url)("sanitize-html");
