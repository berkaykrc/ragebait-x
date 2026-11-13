// Extension-world half of the page <-> background bridge.
//
// Both hops are here, in the EXTENSION world, because this is trusted code.
// The page bundle (src/page/) is untrusted and never runs the trust check.
//
//   page  --window.postMessage-->  [window "message" listener here]
//                                      | isTrustedRagebaitMessage()  <-- the gate
//                                      | parseScoreRequest()
//                                      v
//                            [browser.runtime.sendMessage (async)]
//                                      |  response is the Promise resolution
//                                      v
//   page  <--window.postMessage--  [postMessage back, token echoed]
//
// IMPORTANT: browser.runtime.sendMessage() returns a Promise that resolves
// with the value the background's onMessage handler returns. This is the
// correct response path for request-reply pairs (rb:score-request). The
// runtime.onMessage listener below handles push-style responses that the
// background may emit for async/deduped completions (e.g. when a second
// card joins an in-flight request for the same handle).
//
// The token is session correlation, not a secret (see security.js).

import { isTrustedRagebaitMessage, parseScoreRequest } from "./security.js";

/** Background -> page message type. Not in ALLOWED_MSG_TYPES: that allowlist
 *  governs page -> extension messages, and the page may never send this one. */
export const SCORE_RESPONSE_TYPE = "rb:score-response";

/**
 * Post a score response to the page, guarding against a stale token.
 * Internal helper shared by both the sendMessage resolution and the
 * runtime.onMessage push path.
 */
function postResponse(win, getOrigin, getToken, message) {
  if (!message || typeof message !== "object") return;
  if (message.type !== SCORE_RESPONSE_TYPE) return;
  const origin = getOrigin();
  win.postMessage({ ...message, token: getToken() }, origin);
}

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
      // Await the Promise: the background's onMessage handler returns the
      // response object, which resolves here. This is the primary response
      // path. browser.runtime.sendMessage FROM the background cannot reach
      // content-script onMessage listeners — that path is for push-style
      // duplicated responses only (see onRuntimeMessage below).
      void (async () => {
        try {
          const response = await browserApi.runtime.sendMessage({
            type: "rb:score-request",
            handle: parsed.handle,
            token: parsed.token,
          });
          postResponse(win, getOrigin, getToken, response);
        } catch {
          // background unavailable; page stays on "analyzing…"
        }
      })();
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

  // --- background -> page (push path) ---------------------------------------
  // Handles responses the background delivers via runtime.sendMessage when it
  // has completed an async/deduped request that was not originated by THIS
  // bridge instance's sendMessage call (e.g. a second tab joining an
  // in-flight dedupe). In the common single-request case the postResponse()
  // call in onWindowMessage fires first; this listener is the safety net.
  function onRuntimeMessage(message) {
    postResponse(win, getOrigin, getToken, message);
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
