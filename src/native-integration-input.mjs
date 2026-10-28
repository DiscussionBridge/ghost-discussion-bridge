import { openSync, readSync, closeSync } from "node:fs";
import { parseCmsJson } from "../lib/cms-runtime.mjs";

// Existing protected native integration facts, not publication authority or a
// guessed native route. Read at most the descriptor's existing16KiB budget.
export function nativeIntegrationInput(config) {
  if (config.sourceNativeIntegration) return config.sourceNativeIntegration;
  if (!config.sourceNativeIntegrationFile) return null;
  let descriptor;
  try {
    descriptor = openSync(config.sourceNativeIntegrationFile, "r");
    const bytes = Buffer.alloc(16385), length = readSync(descriptor, bytes, 0, bytes.length, null);
    return parseCmsJson(bytes.subarray(0, length), { maximumBytes: 16384 });
  } catch { throw new Error("Ghost native integration descriptor is unavailable within its protected read budget"); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
