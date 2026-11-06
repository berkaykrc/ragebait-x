// Options page portability: Chromium MV3 exposes only `chrome`. The page must
// boot there too, so every extension-API call resolves through one helper.

import { test } from "node:test";
import assert from "node:assert/strict";

import { browserStorageAdapter } from "../../src/options/index.js";

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
