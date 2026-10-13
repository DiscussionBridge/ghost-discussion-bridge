export const PUBLIC_COMMENTS_MODES = Object.freeze(["simple", "full", "interactive"]);

export function normalizeCommentsMode(value) {
  return PUBLIC_COMMENTS_MODES.includes(value) ? value : null;
}

export function isInteractiveCommentsMode(value) {
  return normalizeCommentsMode(value) === "interactive";
}
