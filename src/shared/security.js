// Security boundary for the page <-> content-script bridge.
//
// READ THIS BEFORE CHANGING ANYTHING HERE.
//
// The per-injection token is a SESSION-CORRELATION TOKEN. It is NOT a secret
// and it is NOT a spoofing defence. It is delivered to the page world through
// a DOM-readable `<script id="ragebait-config">` tag, so any same-origin script
// (X's own bundle, a userscript) can read it. A page-world secret is
// impossible; calling this one would be a false security claim.
//
// The real boundary is structural (plan Part 1 §3):
//
//   1. A page-world message may only REQUEST a score for a handle. It can never
//      supply a band, a percent, or any rendering content. `ALLOWED_MSG_TYPES`
//      therefore has no page-supplied-result type, and any payload carrying a
//      score-bearing field is rejected outright.
//   2. The handle is validated against HANDLE_RE, lower-cased, and deduped
//      before any network or quota-consuming work.
//   3. Only known enum states are rendered, and every dynamic string is escaped.
//   4. Worker-side: per-install quota + WAF; the Worker never trusts a
//      caller-supplied score.
//   5. This trust check runs in the EXTENSION WORLD (the content script),
//      never in the page bundle, which is untrusted code.
//
// This module lives in src/shared/ because BOTH the content script and the
// background script import it.

export const HANDLE_RE = /^[a-zA-Z0-9_]{1,15}$/;

/** The complete set of message types that may cross the bridge. */
export const ALLOWED_MSG_TYPES = new Set([
  "rb:score-request",
  "rb:score-refresh",
  "rb:score-cancel",
  "rb:config",
]);

/**
 * Fields a page-world message must never carry. The page may ask for a score;
 * it may never tell us what the score is.
 */
const SCORE_BEARING_FIELDS = new Set(["result", "band", "percent"]);

/** Depth cap + cycle guard for the nested payload scan. */
const MAX_SCAN_DEPTH = 5;

/** Escape every character that could break out of HTML text or an attribute. */
export function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * True if `value` contains a score-bearing key at any depth (bounded).
 * A hostile page can nest the key to try to smuggle a score past a
 * top-level-only check, so the check recurses.
 */
function containsScoreField(value, depth = 0, seen = new Set()) {
  if (depth > MAX_SCAN_DEPTH) return false;
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  for (const key of Object.keys(value)) {
    if (SCORE_BEARING_FIELDS.has(key)) return true;
    if (containsScoreField(value[key], depth + 1, seen)) return true;
  }
  return false;
}

/**
 * The trust gate. Runs in the extension world.
 *
 * A message passes only if the origin matches AND the type is in the allowlist
 * AND the token matches the one background issued for this injection AND the
 * payload carries no score-bearing field.
 */
export function isTrustedRagebaitMessage(event, expectedOrigin, expectedToken) {
  if (!event || typeof event !== "object") return false;
  if (event.origin !== expectedOrigin) return false;

  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;

  if (typeof data.type !== "string" || !ALLOWED_MSG_TYPES.has(data.type)) return false;

  // A missing/!string token never matches, even if expectedToken is nullish.
  if (typeof data.token !== "string" || data.token.length === 0) return false;
  if (typeof expectedToken !== "string" || expectedToken.length === 0) return false;
  if (data.token !== expectedToken) return false;

  if (containsScoreField(data)) return false;

  return true;
}

/**
 * Validate a page-supplied score request's schema.
 * Returns `{handle, token}` with the handle lower-cased, or `null`.
 */
export function parseScoreRequest(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  if (typeof data.type !== "string" || !ALLOWED_MSG_TYPES.has(data.type)) return null;

  if (typeof data.handle !== "string" || !HANDLE_RE.test(data.handle)) return null;

  if (typeof data.token !== "string" || data.token.length === 0) return null;

  // Lower-cased: both the local cache key and the Worker KV key are built
  // from the lower-cased handle, so this is the single normalisation point.
  return { handle: data.handle.toLowerCase(), token: data.token };
}