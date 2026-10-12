// Extension-world half of the page <-> background bridge.
//
// Both hops are here, in the EXTENSION world, because this is trusted code.
// The page bundle (src/page/) is untrusted and never runs the trust check.
//
//   page  --window.postMessage-->  [window "message" listener here]
//                                      | isTrustedRagebaitMessage()  <-- the gate
//                                      | parseScoreRequest()
//                                      v
//                            [browser.runtime.onMessage -> background]
//                                      |
//                                      v
//   page  <--window.postMessage--  [runtime listener posts back, token echoed]
//
// The token is session correlation, not a secret (see security.js).

import { isTrustedRagebaitMessage, parseScoreRequest } from "./security.js";

/** Background -> page message type. Not in ALLOWED_MSG_TYPES: that allowlist
 *  governs page -> extension messages, and the page may never send this one. */
export const SCORE_RESPONSE_TYPE = "rb:score-response";

/**
 * Install the bridge.
 *
 * @param {object} deps
 * @param {object} deps.win          window-like: addEventListener/removeEventListener/postMessage
 * @param {object} deps.browserApi   browser-like: runtime.sendMessage, runtime.onMessage
 * @param {() => string} deps.getOrigin   the page origin messages must come from and go to
 * @param {() => string} deps.getToken    the background-issued session token
 * @returns {{dispose: () => void}}
 */
export function createBridge({ win, browserApi, getOrigin, getToken }) {
  // --- page -> background ---------------------------------------------------
  function onWindowMessage(event) {
    const token = getToken();
    // The trust gate. Runs here, in the extension world, never in the page.
    if (!isTrustedRagebaitMessage(event, getOrigin(), token)) return;

    const data = event.data;

    if (data.type === "rb:score-request") {
      const parsed = parseScoreRequest(data);
      if (!parsed) return;
      void browserApi.runtime.sendMessage({
        type: "rb:score-request",
        handle: parsed.handle,
        token: parsed.token,
      });
      return;
    }

    // Cancel and refresh address the CURRENT dedupe key held by the
    // background; no handle round-trips back to the page.
    if (data.type === "rb:score-cancel" || data.type === "rb:score-refresh") {
      void browserApi.runtime.sendMessage({
        type: data.type,
        token,
        requestId: typeof data.requestId === "string" ? data.requestId : null,
      });
    }
  }

  // --- background -> page ---------------------------------------------------
  function onRuntimeMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type !== SCORE_RESPONSE_TYPE) return;

    const origin = getOrigin();
    win.postMessage({ ...message, token: getToken() }, origin);
  }

  win.addEventListener("message", onWindowMessage);
  browserApi.runtime.onMessage.addListener(onRuntimeMessage);

  return {
    dispose() {
      win.removeEventListener("message", onWindowMessage);
      browserApi.runtime.onMessage.removeListener(onRuntimeMessage);
    },
  };
}
