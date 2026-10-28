import { sourceTime } from "./source-time.mjs";
import { nativeIntegrationInput } from "./native-integration-input.mjs";

function limitation(detail) {
  const error = new Error(`Ghost native source-activity date projection is unavailable: ${detail}; source metadata remains valid and retained`);
  error.localNativeLimitation = true;
  error.unsupportedNativeFunctions = ["actual source-activity publication-date projection"];
  return error;
}

function nativeSecond(instant) {
  const second = 1_000_000_000n, remainder = instant % second;
  // Ghost's native publication datetime stores whole seconds. BigInt division
  // truncates toward zero, so explicitly floor negative source instants too.
  return instant - remainder - (remainder < 0n ? second : 0n);
}

export function sourceActivityDate(source) {
  const created = sourceTime(source.source_created_at), updated = sourceTime(source.source_updated_at);
  if (source.source_created_at !== null && created === null || source.source_updated_at !== null && updated === null) throw limitation("actual source timestamp cannot be represented");
  if (created !== null && updated !== null && updated < created) throw limitation("actual source chronology differs");
  // An independently known actual edit does not require known creation. Equal
  // actual creation/update is the unedited edition. Native-object existence is
  // never used to select creation over an already known edit on first import.
  if (updated === null) throw limitation("actual edit/unedited distinction is unknown; no creation/native-save fallback is selected");
  const selected = created !== null && created === updated ? created : updated;
  return new Date(Number(nativeSecond(selected) / 1_000_000n)).toISOString();
}

export function activityDateMatches(nativeDate, expected) {
  const actual = sourceTime(nativeDate), original = sourceTime(expected);
  // Project only the expectation, including saved pre-projection intents.
  // Actual subsecond or wrong-second native values never gain a tolerance.
  return actual !== null && original !== null && actual === nativeSecond(original);
}

export function assertSourceActivityRoute(config, mapping, post = null) {
  const url = new URL(mapping.canonical_url);
  if (url.origin !== config.ghostOrigin || url.username || url.password || url.search || url.hash || !/^\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/u.test(url.pathname)) throw limitation("only the approved stable root-slug canonical URL is implemented; date-token movement is not supported");
  const input = nativeIntegrationInput(config);
  if (input) {
    if (input.permalink !== "/{slug}/") throw limitation("the actual configured native permalink is not stable /{slug}/; no date-token URL is changed");
  } else if (!post || post.status !== "published" || post.url !== mapping.canonical_url || post.slug !== url.pathname.slice(1, -1)) {
    throw limitation("the first publication needs the actual installed /{slug}/ permalink fact in the existing protected native integration descriptor");
  }
}
