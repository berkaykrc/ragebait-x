// Page-world reader for the #ragebait-config tag the content script injects.
//
// NOTE: this runs in the PAGE world, which is untrusted. It performs no trust
// decisions. The token it hands back is a session-correlation token, publicly
// readable from the DOM by design (plan Part 1 §3) -- not a secret.

/** Must match the id the content script injects (src/content.js). */
export const CONFIG_TAG_ID = "ragebait-config";

const EMPTY = Object.freeze({ token: null, config: Object.freeze({}) });

/** Parse the tag once. Any failure degrades to the empty envelope. */
function readOnce(doc) {
  const el = doc.getElementById(CONFIG_TAG_ID);
  if (!el) return EMPTY;

  let parsed;
  try {
    parsed = JSON.parse(el.textContent ?? "");
  } catch {
    return EMPTY;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY;

  const token = typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null;
  const config =
    parsed.config && typeof parsed.config === "object" && !Array.isArray(parsed.config)
      ? parsed.config
      : {};

  return { token, config };
}

/**
 * @param {Document} doc
 * @returns {{getToken: () => string|null, getConfig: () => object, canIssueRequest: () => boolean}}
 */
export function createConfigReader(doc) {
  const { token, config } = readOnce(doc);
  return {
    getToken: () => token,
    getConfig: () => config,
    // A missing or unparseable tag means the page script must refuse to
    // issue requests rather than send a token-less message.
    canIssueRequest: () => token !== null,
  };
}