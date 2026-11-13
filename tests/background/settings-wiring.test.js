// Auto-boot wiring: the background must load the user's saved settings and
// install token fresh for every score request. Bug: the auto-boot block never
// read browser.storage, so proxy/BYOK selection and consent were ignored and
// the extension always scored with the heuristic (wrangler tail stayed empty).

import { test } from "node:test";
import assert from "node:assert/strict";

import { wireBrowserRuntime } from "../../src/background/index.js";

const SETTINGS_KEY = "settings";
const INSTALL_TOKEN_KEY = "ragebait_install_token";

function makeReplies(count = 8) {
  return Array.from({ length: count }, (_, i) => ({
    id: `r-${i}`,
    text: `Reply text number ${i}`,
    lang: "tr",
    targetScreenName: "target",
    parentStatusId: null,
    likes: 1,
    createdAt: 1000 + i,
  }));
}

/** Minimal fake of the browser API surface the background wiring uses. */
function makeBrowserApi(store) {
  const listeners = [];
  return {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
    storage: {
      local: {
        // Mirrors the real browser.storage.local dialect: get(key) -> Record,
        // set(items). The background seam adapts to this, not the other way.
        get: (key) =>
          Promise.resolve(store.has(key) ? { [key]: store.get(key) } : {}),
        set: (items) => {
          for (const [k, v] of Object.entries(items)) store.set(k, v);
          return Promise.resolve();
        },
      },
    },
    listeners,
  };
}

/** Invoke a wired listener like the real browser does: answer arrives via
 * sendResponse; the truthy return keeps the channel open. */
function callListener(listener, message) {
  return new Promise((resolve, reject) => {
    const returned = listener(message, {}, resolve);
    if (returned && typeof returned.then === "function") {
      returned.then(resolve, reject);
    }
  });
}

/** Spy AI implementation: records its options, returns a fixed score. */
function makeSpyAi(history) {
  return (_state, options) => {
    history.push(options);
    return Promise.resolve({ band: "medium", percent: 66, model: "spy" });
  };
}

function makeConfigFetch() {
  return (url) => {
    assert.equal(url, "https://example.test/config");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          showNumber: true,
          proxyEnabled: true,
          bandThresholds: { high: 0.8, medium: 0.5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };
}

test("wiring: saved proxy settings + consent are applied to every score request", async () => {
  const store = new Map();
  // Shape is exactly what options/saveSettings writes: JSON under "settings".
  store.set(
    SETTINGS_KEY,
    JSON.stringify({
      mode: "proxy",
      consentAccepted: true,
      proxyUrl: "https://example.test/analyze",
      byokEndpoint: "",
      apiKey: "",
    }),
  );

  const captured = [];
  const api = makeBrowserApi(store);
  const bg = wireBrowserRuntime(api, {
    fetchReplies: () => Promise.resolve({ ok: true, replies: makeReplies() }),
    analyzeWithAi: makeSpyAi(captured),
    fetchImpl: makeConfigFetch(),
    skipCache: true,
  });
  assert.ok(bg, "wiring should return the background instance");

  assert.equal(api.listeners.length, 1, "one runtime.onMessage listener");
  const listener = api.listeners[0];

  const pageConfig = await callListener(listener, { type: "rb:config" });
  assert.equal(pageConfig.config.showNumber, true);

  const response = await callListener(listener, {
    type: "rb:score-request",
    handle: "aphrodite",
  });

  assert.equal(response.handle, "aphrodite");
  assert.equal(response.result.state, "result");
  assert.equal(response.result.model, "spy", "AI result must win the response");
  assert.equal(response.result.band, "medium");

  assert.equal(captured.length, 1);
  assert.equal(captured[0].mode, "proxy");
  assert.equal(captured[0].proxyUrl, "https://example.test/analyze");
  assert.equal(captured[0].thresholds.high, 0.8);
  assert.equal(
    typeof captured[0].installToken,
    "string",
    "install token must reach the AI client",
  );
  assert.ok(captured[0].installToken.length > 0, "token must be non-empty");
  assert.ok(store.has(INSTALL_TOKEN_KEY), "token must persist for reuse");
});

test("wiring: rb:config token survives a background restart", async () => {
  // MV3 service workers are torn down and rebuilt. The correlation token the
  // content script got at tab load must still match after the restart, so the
  // worker must reload the token it persisted instead of minting a new one.
  const store = new Map();

  const firstApi = makeBrowserApi(store);
  wireBrowserRuntime(firstApi, {});
  const first = await callListener(firstApi.listeners[0], {
    type: "rb:config",
  });
  assert.equal(typeof first.token, "string");
  assert.ok(first.token.length > 0, "a token is always issued");
  assert.equal(
    store.get("session_token"),
    first.token,
    "the issued token is persisted for the next worker",
  );

  // The worker sleeps; a fresh one boots against the same storage.
  const secondApi = makeBrowserApi(store);
  wireBrowserRuntime(secondApi, {});
  const second = await callListener(secondApi.listeners[0], {
    type: "rb:config",
  });
  assert.equal(second.token, first.token, "restart must reuse the token");
});

test("wiring: bg.token never advertises a token the worker did not issue", async () => {
  // With a resolver wired, rb:config serves the storage-backed token. The
  // returned `bg.token` must not stay a second, different value.
  const store = new Map();
  const api = makeBrowserApi(store);
  const bg = wireBrowserRuntime(api, {});
  const pageConfig = await callListener(api.listeners[0], {
    type: "rb:config",
  });

  assert.equal(typeof pageConfig.token, "string");
  assert.equal(bg.token, null, "no shadow token next to the resolved one");
});

test("wiring: a transient token-storage failure does not pin a random token", async () => {
  const store = new Map();
  let sessionReads = 0;
  const api = makeBrowserApi(store);
  api.storage.local = {
    get: (key) => {
      if (key !== "session_token") return Promise.resolve({});
      sessionReads += 1;
      if (sessionReads === 1) return Promise.reject(new Error("transient"));
      return Promise.resolve({ session_token: "rb-persisted" });
    },
    set: (items) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
      return Promise.resolve();
    },
  };

  wireBrowserRuntime(api, {});
  const listener = api.listeners[0];

  const first = await callListener(listener, { type: "rb:config" });
  assert.notEqual(first.token, "rb-persisted", "failed read falls back");

  const second = await callListener(listener, { type: "rb:config" });
  assert.equal(
    second.token,
    "rb-persisted",
    "the next call must retry storage instead of reusing the failure",
  );
});

test("wiring: concurrent rb:config callers during transient read failure receive the same token", async () => {
  const store = new Map();
  let sessionReads = 0;
  const api = makeBrowserApi(store);
  api.storage.local = {
    get: async (key) => {
      if (key !== "session_token") return {};
      sessionReads += 1;
      // Yield to let concurrent callers enqueue before rejecting.
      await new Promise((r) => setTimeout(r, 5));
      if (sessionReads === 1) throw new Error("transient");
      return { session_token: "rb-persisted" };
    },
    set: (items) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
      return Promise.resolve();
    },
  };

  wireBrowserRuntime(api, {});
  const listener = api.listeners[0];

  const [first, second] = await Promise.all([
    callListener(listener, { type: "rb:config" }),
    callListener(listener, { type: "rb:config" }),
  ]);

  assert.equal(typeof first.token, "string");
  assert.equal(
    first.token,
    second.token,
    "concurrent callers awaiting in-flight resolution must get the same token",
  );
  assert.notEqual(first.token, "rb-persisted");

  const third = await callListener(listener, { type: "rb:config" });
  assert.equal(
    third.token,
    "rb-persisted",
    "subsequent call retries storage after transient failure",
  );
});

test("wiring: a token-write failure keeps one fallback token for the worker", async () => {
  // Storage accepts reads but rejects writes. The minted token never reaches
  // disk, but it must stay stable for this worker: live tabs hold the value
  // and a token that changes per rb:config defeats correlation.
  const api = makeBrowserApi(new Map());
  api.storage.local = {
    get: () => Promise.resolve({}),
    set: () => Promise.reject(new Error("quota exceeded")),
  };

  wireBrowserRuntime(api, {});
  const listener = api.listeners[0];

  const first = await callListener(listener, { type: "rb:config" });
  assert.equal(typeof first.token, "string");
  assert.ok(first.token.length > 0);

  const second = await callListener(listener, { type: "rb:config" });
  assert.equal(
    second.token,
    first.token,
    "a write failure must not mint a new token on every call",
  );
});

test("wiring: /config is fetched at most once per TTL window (B6)", async () => {
  const store = new Map();
  store.set(
    SETTINGS_KEY,
    JSON.stringify({
      mode: "proxy",
      consentAccepted: true,
      proxyUrl: "https://example.test/analyze",
      byokEndpoint: "",
      apiKey: "",
    }),
  );

  let configFetches = 0;
  const countingConfigFetch = (url) => {
    configFetches += 1;
    assert.equal(url, "https://example.test/config");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          showNumber: true,
          proxyEnabled: true,
          bandThresholds: { high: 0.8, medium: 0.5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  const api = makeBrowserApi(store);
  wireBrowserRuntime(api, {
    fetchReplies: () => Promise.resolve({ ok: true, replies: makeReplies() }),
    analyzeWithAi: makeSpyAi([]),
    fetchImpl: countingConfigFetch,
    skipCache: true,
  });
  const listener = api.listeners[0];

  await callListener(listener, { type: "rb:score-request", handle: "one" });
  await callListener(listener, { type: "rb:score-request", handle: "two" });
  assert.equal(
    configFetches,
    1,
    "second request must serve /config from storage cache",
  );
});

test("wiring: settings saved AFTER load are picked up on a later request", async () => {
  // Nothing stored yet: first request is heuristic.
  const store = new Map();
  const captured = [];
  const api = makeBrowserApi(store);
  const spy = makeSpyAi(captured);
  wireBrowserRuntime(api, {
    fetchReplies: () => Promise.resolve({ ok: true, replies: makeReplies() }),
    analyzeWithAi: spy,
    fetchImpl: makeConfigFetch(),
    skipCache: true,
  });
  const listener = api.listeners[0];

  const first = await callListener(listener, {
    type: "rb:score-request",
    handle: "nomode",
  });
  assert.equal(first.result.model, "heuristic");
  assert.equal(captured.length, 0, "heuristic mode never calls the AI");

  // The user saves proxy mode on the options page. No extension reload.
  store.set(
    SETTINGS_KEY,
    JSON.stringify({
      mode: "proxy",
      consentAccepted: true,
      proxyUrl: "https://example.test/analyze",
      byokEndpoint: "",
      apiKey: "",
    }),
  );

  const second = await callListener(listener, {
    type: "rb:score-request",
    handle: "nomode",
  });
  assert.equal(second.result.model, "spy", "new mode applies without reload");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].mode, "proxy");
});

test("wiring: boot prunes old stats counters via the keys-only storage read", async () => {
  const store = new Map();
  store.set("stats:2020-01-01", 5);
  store.set("stats:2099-01-01", 7);
  store.set("settings", "{}");

  let pruneDone;
  const pruneStarted = new Promise((resolve) => {
    pruneDone = resolve;
  });

  const api = makeBrowserApi(store);
  api.storage.local.getKeys = () => Promise.resolve([...store.keys()]);
  api.storage.local.remove = (keys) => {
    for (const k of keys) store.delete(k);
    pruneDone();
    return Promise.resolve();
  };

  wireBrowserRuntime(api, {});
  await pruneStarted;

  assert.equal(store.has("stats:2020-01-01"), false, "old counter pruned");
  assert.equal(store.has("stats:2099-01-01"), true, "future counter kept");
  assert.equal(store.has("settings"), true, "unrelated key kept");
});

test("wiring: keys() skips pruning when getKeys is unavailable (no get(null))", async () => {
  const store = new Map();
  store.set("stats:2020-01-01", 5);

  let getNullCalled = false;
  const api = makeBrowserApi(store);
  // No getKeys: the adapter must not fall back to a whole-store get(null).
  api.storage.local.get = (key) => {
    if (key === null) getNullCalled = true;
    return Promise.resolve(store.has(key) ? { [key]: store.get(key) } : {});
  };

  wireBrowserRuntime(api, {});
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(getNullCalled, false, "must not read the whole store");
  assert.equal(store.has("stats:2020-01-01"), true, "no pruning without keys");
});

test("wiring: boot tolerates a cache with no sweep() method", () => {
  const api = makeBrowserApi(new Map());
  // A broken/legacy cache seam without sweep must not prevent wiring.
  const bg = wireBrowserRuntime(api, {
    cache: {
      get: () => null,
      set: () => {},
      peek: () => null,
    },
  });
  assert.ok(bg, "background wired despite missing sweep");
  assert.doesNotThrow(() => bg.sweepCache(), "sweepCache is guarded");
});
