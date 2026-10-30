import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Test-only dependency resolution from this checkout, never an older worktree.
// The normal package does not ship this test hook.
const require = createRequire(import.meta.url);
const dependencies = new Set(["sanitize-html", "htmlparser2", "entities"]);

export async function resolve(specifier, context, nextResolve) {
  if (dependencies.has(specifier)) {
    return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
