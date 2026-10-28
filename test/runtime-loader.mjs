import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Local regression execution only. This retained workspace has the exact
// pinned production dependency versions; all implementation imports stay V4.
// No package install, copied implementation, or production loader is involved.
const require = createRequire(new URL("../../../ghost/package.json", import.meta.url));
const dependencies = new Set(["sanitize-html", "htmlparser2", "entities"]);

export async function resolve(specifier, context, nextResolve) {
  if (dependencies.has(specifier)) {
    return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
