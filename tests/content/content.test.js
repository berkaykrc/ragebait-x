import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import { bootContent } from "../../src/content.js";

const ORIGIN = "https://x.com";
const TOKEN = "tok-from-background";

function makeDom() {
  return new JSDOM("<!doctype html><html><body></body></html>", {
    url: ORIGIN,
  });
}

/** Fake browser API: captures what the content script sends and listens with. */
function makeBrowser(config = { showNumber: false }) {
  const sent = [];
  const storageListeners = [];
  return {
    sent,
    storageListeners,
    config,
    runtime: {
      sendMessage: (msg) => {
        sent.push(msg);
        return Promise.resolve({ token: TOKEN, config });
      },
      getURL: (p) => `moz-extension://abc/${p}`,
      onMessage: { addListener: () => {}, removeListener: () => {} },
    },
    storage: {
      onChanged: { addListener: (fn) => storageListeners.push(fn) },
    },
  };
}

/** Boot with postMessage observed, and return everything the tests assert on. */
function boot({ config = { showNumber: false } } = {}) {
  const dom = makeDom();
  const win = dom.window;
  const posted = [];
  win.postMessage = (data, origin) => posted.push({ data, origin });
  const browserApi = makeBrowser(config);
  const handle = bootContent({ doc: win.document, win, browserApi });
  return { win, doc: win.document, posted, browserApi, handle };
}

const settle = () => new Promise((r) => setImmediate(r));

test("content: asks the background for the session token and settings", async () => {
  const { browserApi } = boot();
  await settle();
  assert.deepEqual(browserApi.sent[0], { type: "rb:config" });
});

test("content: injects the ragebait-config tag with the background-issued token", async () => {
  const { doc } = boot();
  await settle();
  const tag = doc.getElementById("ragebait-config");
  assert.ok(tag, "expected a #ragebait-config tag to be injected");
  assert.equal(tag.getAttribute("type"), "application/json");
  const parsed = JSON.parse(tag.textContent);
  assert.equal(parsed.token, TOKEN);
  assert.deepEqual(parsed.config, { showNumber: false });
});

test("content: injects the page bundle from the extension URL", async () => {
  const { doc } = boot();
  await settle();
  const script = doc.querySelector('script[src="moz-extension://abc/page.js"]');
  assert.ok(
    script,
    "expected page.js to be injected from the extension origin",
  );
});

test("content: still provisions the page world when the background has no rb:config listener", async () => {
  // Task 8 ships the background that answers rb:config. Until then (and after
  // any background failure), booting the rendering must not depend on it:
  // rendering the line needs no token at all (D13, src/page/index.js header).
  // Today this test is RED: a rejected sendMessage kills the whole inject
  // chain and the extension renders nothing on x.com.
  const dom = makeDom();
  const browserApi = makeBrowser();
  browserApi.runtime.sendMessage = () =>
    Promise.reject(new Error("no matching message listener"));
  const { doc } = { doc: dom.window.document };
  bootContent({ doc, win: dom.window, browserApi });
  await settle();

  const tag = doc.getElementById("ragebait-config");
  assert.ok(
    tag,
    "expected the config tag to be injected even without a background answer",
  );
  assert.deepEqual(JSON.parse(tag.textContent), { token: null, config: {} });
  const script = doc.querySelector('script[src="moz-extension://abc/page.js"]');
  assert.ok(
    script,
    "expected page.js to be injected even without a background answer",
  );
});

test("content: registers a storage.onChanged listener", async () => {
  const { browserApi } = boot();
  await settle();
  assert.equal(browserApi.storageListeners.length, 1);
});

test("content: forwards a storage config change to the page world with the token", async () => {
  const { posted, browserApi } = boot({ config: { showNumber: false } });
  await settle();

  // Real storage.onChanged shape: changes is keyed by storage key, each entry
  // wrapped in {oldValue, newValue}.
  browserApi.storageListeners[0](
    {
      config: {
        oldValue: { showNumber: false },
        newValue: { showNumber: true },
      },
    },
    "local",
  );
  await settle();

  assert.equal(posted.length, 1);
  assert.equal(posted[0].origin, ORIGIN);
  assert.equal(posted[0].data.type, "rb:config");
  assert.equal(posted[0].data.token, TOKEN);
  assert.deepEqual(posted[0].data.config, { showNumber: true });
});

test("content: installs the window message bridge", async () => {
  const { win, browserApi } = boot();
  await settle();

  const seen = [];
  win.addEventListener("message", (e) => seen.push(e));

  win.dispatchEvent(Object.assign(new win.Event("message"), {
    origin: ORIGIN,
    data: { type: "rb:score-request", handle: "yooksiktir", token: TOKEN },
  }));
  await settle();

  assert.equal(
    browserApi.sent.length,
    2,
    "expected the bridge to forward the request to the background",
  );
  assert.deepEqual(browserApi.sent[1], {
    type: "rb:score-request",
    handle: "yooksiktir",
    token: TOKEN,
  });
});
