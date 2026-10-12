// Page-world entry (the esbuild `page` bundle, injected by src/content.js).
//
// Wiring only: read the injected config, start the hovercard observer, create
// the DOM store, and route score responses to the open line. The outbound
// request half of the bridge (sendScoreRequest/cancel/refresh) is Task 7;
// until then a hovered account's line renders "analyzing…" and waits.
//
// Everything here runs in the PAGE world, which is untrusted. Nothing in this
// file performs a trust decision, and nothing it renders reaches the DOM
// except through render.js's allowlist.

import { createConfigReader } from "./inject-config.js";
import { createDomStore } from "./dom-store.js";
import {
  createHovercardObserver,
  PAGE_SCORE_RESPONSE_TYPE,
} from "./hovercard.js";
import { applyState } from "./render.js";

/**
 * Boot the page world.
 *
 * @param {object} deps
 * @param {Document} deps.document
 * @param {Window} deps.win
 * @param {{warn: Function}} [deps.consoleLike]
 * @param {Function} [deps.waitForCard]  injected for tests
 * @returns {{configReader: object, store: object, dispose: () => void}}
 */
export function bootPage({
  document: doc,
  win,
  consoleLike = console,
  waitForCard,
}) {
  // The tag is publicly readable by design (D13): token is correlation, and
  // rendering the line needs no token at all.
  const configReader = createConfigReader(doc);
  const store = createDomStore();
  const observer = createHovercardObserver({
    document: doc,
    consoleLike,
    waitForCard,
  });

  function onWindowMessage(event) {
    const message = event?.data;
    if (!message || typeof message !== "object") return;
    if (message.type !== PAGE_SCORE_RESPONSE_TYPE) return;

    const handle = typeof message.handle === "string"
      ? message.handle.toLowerCase()
      : null;
    if (!handle) return;

    const entry = observer.cards.get(handle);
    if (!entry || !entry.line.isConnected) return; // card gone; drop it

    // Ask 3 seam: the response is correlated by handle here; Task 7/8 move
    // this to requestId. Whatever arrives, forged or genuine, is rendered
    // through render.js's allowlist -- a hostile band can only become a
    // known state or the error copy, never injected markup.
    entry.line = applyState(entry.line, message.result);
  }

  win.addEventListener("message", onWindowMessage);

  return {
    configReader,
    store,
    dispose: () => {
      win.removeEventListener("message", onWindowMessage);
      observer.dispose();
    },
  };
}

// Auto-boot in the page world only. The page world has NO `browser` object
// (that is why the postMessage bridge exists), so the guard is document +
// window -- importing this module in a Node test must not boot.
if (typeof document !== "undefined" && typeof window !== "undefined") {
  bootPage({ document, win: window });
}
