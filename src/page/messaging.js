// Page-world half of the page <-> extension bridge (Task 7).
//
//   page world (THIS module)              extension world (src/shared/messaging.js)
//   sendScoreRequest / sendRefresh /
//   sendCancel  --window.postMessage-->  [isTrustedRagebaitMessage + parseScoreRequest]
//   onScoreResult <--window.postMessage--  [runtime.onMessage -> postMessage, token echoed]
//
// SECURITY: this module runs in the PAGE world, which is untrusted. It makes
// no trust decisions and MUST NOT import src/shared/security.js or
// src/shared/messaging.js -- AGENTS.md forbids bundling the trust gate into
// page.js (a trust check in the page world is worthless: the page world is
// what it checks). The message types below are local literals on purpose;
// a test pins their equality with the canonical constants.
//
// What the page world CAN still enforce on the way out is the plan's
// structural rule 1 (Part 1 §3): it may only ever EMIT a request (fixed type
// allowlist), only with the session-correlation token, and never any payload
// carrying a score-bearing field (result/band/percent, at any depth) -- the
// page may request a score, never supply one. The extension world re-checks
// all of this at the gate; this side is belt-and-braces.

export const SCORE_REQUEST_TYPE = "rb:score-request";
export const SCORE_REFRESH_TYPE = "rb:score-refresh";
export const SCORE_CANCEL_TYPE = "rb:score-cancel";

/**
 * Response type this world listens for. A local literal on purpose: the
 * canonical constant lives in src/shared/messaging.js (extension world), and
 * importing it here would bundle the trust gate into page.js. The equality
 * of the two is pinned by a test.
 */
export const PAGE_SCORE_RESPONSE_TYPE = "rb:score-response";

/** The types this world may emit. Deliberately no score-supplying type. */
const SENDABLE_TYPES = new Set([
  SCORE_REQUEST_TYPE,
  SCORE_REFRESH_TYPE,
  SCORE_CANCEL_TYPE,
]);

/**
 * Local copy of the extension world's score-bearing scan (security.js's
 * SCORE_BEARING_FIELDS + depth cap). Keep the two in lockstep: a parity test
 * pins this against the gate's behaviour.
 */
const SCORE_BEARING_FIELDS = new Set(["result", "band", "percent"]);
const MAX_SCAN_DEPTH = 5;

/**
 * True if `value` carries a score-bearing key at any depth (bounded,
 * cycle-safe). Same contract as security.js's private scan.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @param {Set<object>} [seen]
 * @returns {boolean}
 */
export function carriesScoreField(value, depth = 0, seen = new Set()) {
  if (depth > MAX_SCAN_DEPTH) return false;
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  for (const key of Object.keys(value)) {
    if (SCORE_BEARING_FIELDS.has(key)) return true;
    if (carriesScoreField(value[key], depth + 1, seen)) return true;
  }
  return false;
}

/**
 * The page-world bridge. Sends are token-gated and type-allowlisted; the
 * receive half filters for the score-response type and hands
 * `{handle, result}` to the subscriber (correlation by handle is the page
 * world's job; Task 8 moves the wire protocol to requestId).
 *
 * @param {object} deps
 * @param {object} deps.win       window-like: postMessage/add/removeEventListener
 * @param {() => string|null} deps.getToken   the session-correlation token
 * @param {() => string} [deps.getOrigin]     targetOrigin for postMessage
 * @returns {{
 *   sendScoreRequest: (handle: string) => boolean,
 *   sendRefresh: (handle: string) => boolean,
 *   sendCancel: (handle: string) => boolean,
 *   onScoreResult: (cb: (m: {handle: string|null, result: unknown}) => void) => () => void,
 * }}
 */
export function createPageMessaging({ win, getToken, getOrigin }) {
  const originOf = getOrigin ?? (() => win?.location?.origin || "*");

  function emit(type, handle) {
    if (!SENDABLE_TYPES.has(type)) return false;
    if (!win || typeof win.postMessage !== "function") return false;
    // inject-config's contract: never send a token-less message. The
    // extension gate would drop it anyway; refusing here keeps the noise off
    // the wire.
    const token = typeof getToken === "function" ? getToken() : null;
    if (typeof token !== "string" || token.length === 0) return false;
    if (typeof handle !== "string" || handle.length === 0) return false;

    const payload = { type, token, handle };
    // Structural rule 1, mirrored page-side: whatever the payload shape ever
    // grows into, a page-world message may never carry a score.
    if (carriesScoreField(payload)) return false;

    win.postMessage(payload, originOf());
    return true;
  }

  return {
    sendScoreRequest: (handle) => emit(SCORE_REQUEST_TYPE, handle),
    sendRefresh: (handle) => emit(SCORE_REFRESH_TYPE, handle),
    sendCancel: (handle) => emit(SCORE_CANCEL_TYPE, handle),

    onScoreResult(cb) {
      if (!win || typeof win.addEventListener !== "function") {
        return () => {};
      }
      const listener = (event) => {
        const data = event?.data;
        if (!data || typeof data !== "object" || Array.isArray(data)) return;
        if (data.type !== PAGE_SCORE_RESPONSE_TYPE) return;
        const handle = typeof data.handle === "string" && data.handle.length > 0
          ? data.handle.toLowerCase()
          : null;
        if (!handle) return;
        cb({ handle, result: data.result });
      };
      win.addEventListener("message", listener);
      return () => win.removeEventListener("message", listener);
    },
  };
}
