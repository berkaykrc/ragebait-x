import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PROXY_URL as DEFAULT_PROXY_URL_FROM_OPTIONS,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  SETTINGS_KEY,
} from "../../src/options/index.js";
import { DEFAULT_PROXY_URL } from "../../src/config.js";

const DEFAULTS = {
  mode: "heuristic",
  consentAccepted: false,
  proxyUrl: DEFAULT_PROXY_URL,
  byokEndpoint: "",
  apiKey: "",
  misclassificationEmail: "",
};

function makeStorage(seed = {}) {
  const data = { ...seed };
  return {
    async get(key) {
      await Promise.resolve();
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    async set(key, value) {
      await Promise.resolve();
      data[key] = value;
    },
    _data: data,
  };
}

function makeSyncStorage(seed = {}) {
  const data = { ...seed };
  return {
    get(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    set(key, value) {
      data[key] = value;
    },
    _data: data,
  };
}

function throwingStorage() {
  return {
    get() {
      throw new Error("storage get boom");
    },
    set() {
      throw new Error("storage set boom");
    },
  };
}

// --- defaults -----------------------------------------------------------

test("settings: defaults when storage is null", async () => {
  const loaded = await loadSettings(null);
  assert.deepEqual(loaded, DEFAULTS);
});

test("settings: defaults when storage has no get", async () => {
  const loaded = await loadSettings({});
  assert.deepEqual(loaded, DEFAULTS);
});

test("settings: defaults when storage throws on get", async () => {
  const loaded = await loadSettings(throwingStorage());
  assert.deepEqual(loaded, DEFAULTS);
});

test("settings: defaults when storage is empty", async () => {
  const loaded = await loadSettings(makeStorage());
  assert.deepEqual(loaded, DEFAULTS);
});

test("settings: default mode is heuristic", async () => {
  const loaded = await loadSettings(makeStorage());
  assert.equal(loaded.mode, "heuristic");
});

test("settings: default consentAccepted is false", async () => {
  const loaded = await loadSettings(makeStorage());
  assert.equal(loaded.consentAccepted, false);
});

test("settings: default proxyUrl is DEFAULT_PROXY_URL", async () => {
  const loaded = await loadSettings(makeStorage());
  assert.equal(loaded.proxyUrl, DEFAULT_PROXY_URL);
});

test("settings: default byokEndpoint is empty string", async () => {
  const loaded = await loadSettings(makeStorage());
  assert.equal(loaded.byokEndpoint, "");
});

test("settings: default apiKey is empty string", async () => {
  const loaded = await loadSettings(makeStorage());
  assert.equal(loaded.apiKey, "");
});

test("settings: default misclassificationEmail is empty string", async () => {
  const loaded = await loadSettings(makeStorage());
  assert.equal(loaded.misclassificationEmail, "");
});

test("settings: sync storage roundtrip returns defaults", async () => {
  const loaded = await loadSettings(makeSyncStorage());
  assert.deepEqual(loaded, DEFAULTS);
});

// --- roundtrip ----------------------------------------------------------

test("settings: save then load roundtrip", async () => {
  const storage = makeStorage();
  const settings = {
    mode: "proxy",
    consentAccepted: true,
    proxyUrl: "https://example.custom/analyze",
    byokEndpoint: "",
    apiKey: "",
    misclassificationEmail: "",
  };
  await saveSettings(storage, settings);
  const loaded = await loadSettings(storage);
  assert.deepEqual(loaded, settings);
});

test("settings: roundtrip with byok values", async () => {
  const storage = makeStorage();
  const settings = {
    mode: "byok",
    consentAccepted: true,
    proxyUrl: DEFAULT_PROXY_URL,
    byokEndpoint: "https://my.endpoint/analyze",
    apiKey: "sk-test-123",
    misclassificationEmail: "user@example.com",
  };
  await saveSettings(storage, settings);
  const loaded = await loadSettings(storage);
  assert.deepEqual(loaded, settings);
});

test("settings: returns a copy, not the stored reference", async () => {
  const storage = makeStorage();
  await saveSettings(storage, {
    mode: "proxy",
    consentAccepted: true,
    proxyUrl: "https://x/",
    byokEndpoint: "",
    apiKey: "",
    misclassificationEmail: "",
  });
  const loaded = await loadSettings(storage);
  loaded.mode = "heuristic";
  const again = await loadSettings(storage);
  assert.equal(again.mode, "proxy");
});

test("settings: save swallows a throwing storage", async () => {
  // Should not throw even though the storage set throws.
  await saveSettings(throwingStorage(), {
    mode: "proxy",
    consentAccepted: true,
    proxyUrl: "https://x/",
    byokEndpoint: "",
    apiKey: "",
    misclassificationEmail: "",
  });
});

// --- corrupt ------------------------------------------------------------

test("settings: corrupt JSON string returns defaults", async () => {
  const storage = makeStorage({ settings: "{not valid json" });
  const loaded = await loadSettings(storage);
  assert.deepEqual(loaded, DEFAULTS);
});

test("settings: invalid mode returns defaults", async () => {
  const storage = makeStorage({
    settings: {
      mode: "nonsense",
      consentAccepted: false,
      proxyUrl: DEFAULT_PROXY_URL,
      byokEndpoint: "",
      apiKey: "",
      misclassificationEmail: "",
    },
  });
  const loaded = await loadSettings(storage);
  assert.deepEqual(loaded, DEFAULTS);
});

test("settings: missing fields returns defaults", async () => {
  const storage = makeStorage({ settings: { mode: "heuristic" } });
  const loaded = await loadSettings(storage);
  assert.deepEqual(loaded, DEFAULTS);
});

test("settings: consentAccepted not a boolean returns defaults", async () => {
  const storage = makeStorage({
    settings: {
      mode: "heuristic",
      consentAccepted: "yes",
      proxyUrl: DEFAULT_PROXY_URL,
      byokEndpoint: "",
      apiKey: "",
      misclassificationEmail: "",
    },
  });
  const loaded = await loadSettings(storage);
  assert.deepEqual(loaded, DEFAULTS);
});

test("settings: save then corrupt then load returns defaults", async () => {
  const storage = makeStorage();
  await saveSettings(storage, {
    mode: "byok",
    consentAccepted: true,
    proxyUrl: DEFAULT_PROXY_URL,
    byokEndpoint: "https://e/",
    apiKey: "k",
    misclassificationEmail: "a@b.c",
  });
  storage._data.settings = "{broken";
  const loaded = await loadSettings(storage);
  assert.deepEqual(loaded, DEFAULTS);
});

test("settings: storage shaped like browser.result {settings: {...}} works", async () => {
  const storage = makeStorage({
    settings: {
      mode: "byok",
      consentAccepted: true,
      proxyUrl: DEFAULT_PROXY_URL,
      byokEndpoint: "https://e/",
      apiKey: "k",
      misclassificationEmail: "a@b.c",
    },
  });
  const loaded = await loadSettings(storage);
  assert.equal(loaded.mode, "byok");
  assert.equal(loaded.consentAccepted, true);
});

// --- interface surface --------------------------------------------------

test("settings: SETTINGS_KEY is 'settings'", () => {
  assert.equal(SETTINGS_KEY, "settings");
});

test("settings: DEFAULT_SETTINGS matches the documented defaults", () => {
  assert.deepEqual(DEFAULT_SETTINGS, DEFAULTS);
});

test("settings: DEFAULT_PROXY_URL is re-exported from options index", () => {
  assert.equal(DEFAULT_PROXY_URL_FROM_OPTIONS, DEFAULT_PROXY_URL);
});
