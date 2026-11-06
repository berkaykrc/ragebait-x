// Options page portability: Chromium MV3 exposes only `chrome`. The page must
// boot there too, so every extension-API call resolves through one helper.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

import { browserStorageAdapter, updateModeUI } from "../../src/options/index.js";

const html = readFileSync(
  new URL("../../src/options/index.html", import.meta.url),
  "utf8",
);

function page() {
  return new JSDOM(html).window.document;
}

/** Run `fn` with `browser` undefined and a fake `chrome`, then restore both. */
async function withChromeOnly(chrome, fn) {
  const savedBrowser = globalThis.browser;
  const savedChrome = globalThis.chrome;
  try {
    delete globalThis.browser;
    globalThis.chrome = chrome;
    return await fn();
  } finally {
    globalThis.browser = savedBrowser;
    globalThis.chrome = savedChrome;
  }
}

test("options storage adapter reads and writes through chrome when browser is undefined", async () => {
  const written = [];
  const chrome = {
    storage: {
      local: {
        get: async (key) => ({ [key]: "stored-value" }),
        set: async (items) => {
          written.push(items);
        },
      },
    },
  };

  await withChromeOnly(chrome, async () => {
    const storage = browserStorageAdapter();
    assert.equal(await storage.get("settings"), "stored-value");
    await storage.set("settings", "next-value");
  });

  assert.deepEqual(written, [{ settings: "next-value" }]);
});

test("options: conditional cards toggle the hidden attribute, never inline display", () => {
  const doc = page();
  const proxyFields = doc.getElementById("proxy-fields");
  const byokFields = doc.getElementById("byok-fields");
  const proxyNote = doc.querySelector('[data-mode-note="proxy"]');
  const byokNote = doc.querySelector('[data-mode-note="byok"]');
  const consent = (value) => {
    doc.getElementById("consentAccepted").checked = value;
  };

  consent(true);
  updateModeUI(doc, "proxy");
  assert.equal(proxyFields.hidden, false);
  assert.equal(byokFields.hidden, true);
  assert.equal(proxyNote.hidden, false);
  assert.equal(byokNote.hidden, true);
  assert.equal(
    proxyFields.style.display,
    "",
    "the gate must not write an inline display",
  );

  updateModeUI(doc, "byok");
  assert.equal(proxyFields.hidden, true);
  assert.equal(byokFields.hidden, false);
  assert.equal(proxyNote.hidden, true);
  assert.equal(byokNote.hidden, false);

  updateModeUI(doc, "heuristic");
  assert.equal(proxyFields.hidden, true);
  assert.equal(byokFields.hidden, true);
  assert.equal(proxyNote.hidden, true);
  assert.equal(byokNote.hidden, true);

  consent(false);
  updateModeUI(doc, "proxy");
  assert.equal(proxyFields.hidden, true, "consent still gates the fields");
});
