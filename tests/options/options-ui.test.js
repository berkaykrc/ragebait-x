// Options page portability: Chromium MV3 exposes only `chrome`. The page must
// boot there too, so every extension-API call resolves through one helper.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

import {
  browserStorageAdapter,
  updateModeUI,
} from "../../src/options/index.js";

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
        get: (key) => Promise.resolve({ [key]: "stored-value" }),
        set: (items) => {
          written.push(items);
          return Promise.resolve();
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

test("options page boots when only chrome exists", async () => {
  // The finding this covers: with the old `typeof browser` guard the page
  // stayed inert on Chromium. A fresh module instance (?boot) has to run the
  // auto-boot block with `chrome` only and render the stored settings.
  const doc = page();
  const savedDocument = globalThis.document;
  const stored = JSON.stringify({
    mode: "proxy",
    consentAccepted: true,
    proxyUrl: "https://proxy.test/analyze",
    byokEndpoint: "",
    apiKey: "",
  });
  const chrome = {
    storage: {
      local: {
        get: (key) =>
          Promise.resolve(key === "settings" ? { settings: stored } : {}),
        set: () => Promise.resolve(),
      },
    },
  };

  try {
    await withChromeOnly(chrome, async () => {
      globalThis.document = doc;
      await import("../../src/options/index.js?chromium-boot");
      // boot() is fire-and-forget; let its storage read settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  } finally {
    globalThis.document = savedDocument;
  }

  assert.equal(
    doc.getElementById("proxy-fields").hidden,
    false,
    "boot must render the stored proxy mode with chrome only",
  );
});

test("options storage adapter rejects with a clear error when storage is missing", async () => {
  await withChromeOnly({}, async () => {
    const storage = browserStorageAdapter();
    await assert.rejects(
      () => storage.get("settings"),
      /storage API unavailable/,
    );
    await assert.rejects(
      () => storage.set("settings", "x"),
      /storage API unavailable/,
    );
  });
});

test("options storage adapter resolves the API per call, not per construction", async () => {
  // The adapter is built once at load; the API can appear (or be swapped)
  // afterwards. A captured namespace would keep failing on the stale object.
  await withChromeOnly({}, async () => {
    const storage = browserStorageAdapter();
    await assert.rejects(
      () => storage.get("settings"),
      /storage API unavailable/,
    );

    globalThis.chrome = {
      storage: {
        local: {
          get: () => Promise.resolve({ settings: "late-value" }),
          set: () => Promise.resolve(),
        },
      },
    };

    assert.equal(
      await storage.get("settings"),
      "late-value",
      "the adapter must look the API up on every call",
    );
  });
});

test("options: mode notes start hidden before updateModeUI runs", () => {
  const doc = page();
  const notes = doc.querySelectorAll("[data-mode-note]");
  assert.equal(notes.length, 2);
  for (const note of notes) {
    assert.equal(note.hidden, true, "no flash of both notices on first paint");
  }
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

test("options: document carries strict CSP, referrer-policy and no inline styles", () => {
  const doc = page();
  const cspMeta = doc.querySelector(
    'meta[http-equiv="Content-Security-Policy"]',
  );
  assert.ok(cspMeta, "CSP meta tag must be present");
  assert.ok(cspMeta.content.includes("default-src 'none'"));
  assert.ok(cspMeta.content.includes("connect-src 'none'"));
  assert.ok(cspMeta.content.includes("script-src 'self'"));
  assert.ok(cspMeta.content.includes("style-src 'self'"));

  const referrerMeta = doc.querySelector('meta[name="referrer"]');
  assert.ok(referrerMeta, "referrer meta tag must be present");
  assert.equal(referrerMeta.content, "no-referrer");

  // A Permissions-Policy meta tag is deliberately absent: the spec defines
  // it as a response header only, so a meta tag has no effect.
  assert.equal(
    doc.querySelector('meta[http-equiv="Permissions-Policy"]'),
    null,
    "Permissions-Policy meta tag must not be present",
  );

  const inlineStyles = doc.querySelectorAll("[style]");
  assert.equal(
    inlineStyles.length,
    0,
    "options HTML must contain zero inline style attributes",
  );
});
