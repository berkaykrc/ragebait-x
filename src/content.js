// Content script — runs in the EXTENSION world at document_start.
//
// Responsibilities (plan Part 1 §3):
//   1. Ask the background for the session-correlation token + current settings.
//   2. Inject #ragebait-config so the page-world bundle can read them.
//   3. Inject page.js from the extension URL (web_accessible_resources).
//   4. Own the window.message <-> runtime.sendMessage bridge.
//   5. Forward browser.storage config changes to the page world.
//
// The trust gate lives here, not in the page bundle — the page is untrusted.

import { createBridge } from "./shared/messaging.js";
import { CONFIG_TAG_ID } from "./page/inject-config.js";

/**
 * Boot the content script.
 *
 * @param {object} deps
 * @param {Document} deps.doc
 * @param {Window}  [deps.win]
 * @param {object}  deps.browserApi
 * @returns {{getToken: () => string|null, dispose: () => void}}
 */
export function bootContent({ doc, win, browserApi }) {
  const w = win ?? doc.defaultView;
  let token = null;

  const getToken = () => token;

  const bridge = createBridge({
    win: w,
    browserApi,
    getOrigin: () => w.location.origin,
    getToken,
  });

  // Ask the background for the token + settings, then provision the page
  // world. The background that answers rb:config ships in Task 8; until then
  // (and after any failure) the page world must still boot — rendering the
  // line needs no token at all (D13), and a dead injection chain would leave
  // the extension invisible on x.com. Failure mode: token null, config {}.
  const provisionPageWorld = (res) => {
    token = typeof res?.token === "string" ? res.token : null;
    const config = res?.config && typeof res.config === "object"
      ? res.config
      : {};

    const tag = doc.createElement("script");
    tag.id = CONFIG_TAG_ID;
    tag.type = "application/json";
    // PUBLICLY READABLE BY DESIGN. This is session correlation, not a secret:
    // any same-origin script can read it. The real boundary is structural --
    // the page may only REQUEST a score, never supply one (src/shared/security.js).
    tag.textContent = JSON.stringify({ token, config });
    (doc.head ?? doc.documentElement).appendChild(tag);

    const pageScript = doc.createElement("script");
    pageScript.src = browserApi.runtime.getURL("page.js");
    (doc.head ?? doc.documentElement).appendChild(pageScript);
  };

  void Promise.resolve(
    browserApi.runtime.sendMessage({ type: "rb:config" }),
  ).then(provisionPageWorld, () => provisionPageWorld(undefined));

  // Settings changed -> tell the page world, with the token echoed.
  browserApi.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes || !("config" in changes)) return;
    w.postMessage(
      { type: "rb:config", token, config: changes.config.newValue ?? {} },
      w.location.origin,
    );
  });

  return { getToken, dispose: () => bridge.dispose() };
}

// Auto-boot in the extension only; importing this module in a test must not.
const extensionApi = typeof browser !== "undefined"
  ? browser
  : (typeof chrome !== "undefined" ? chrome : null);

if (extensionApi && typeof document !== "undefined") {
  bootContent({ doc: document, win: window, browserApi: extensionApi });
}
