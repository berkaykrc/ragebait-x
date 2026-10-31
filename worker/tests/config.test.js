import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildConfig,
  DEFAULT_PROXY_URL as WORKER_DEFAULT_PROXY_URL,
  SELECTORS as WORKER_SELECTORS,
} from "../src/config.js";
import {
  DEFAULT_PROXY_URL as EXTENSION_DEFAULT_PROXY_URL,
  FEATURE_VERSION,
  MODEL_VERSION,
} from "../../src/config.js";
import worker from "../src/index.js";

test("config: DEFAULT_PROXY_URL in worker matches extension", () => {
  assert.equal(WORKER_DEFAULT_PROXY_URL, EXTENSION_DEFAULT_PROXY_URL);
  assert.equal(typeof WORKER_DEFAULT_PROXY_URL, "string");
  assert.ok(WORKER_DEFAULT_PROXY_URL.startsWith("https://"));
});

test("config: buildConfig returns defaults when env is absent", () => {
  const config = buildConfig();

  assert.deepEqual(config.bandThresholds, {
    high: 0.75,
    medium: 0.45,
  });
  assert.equal(config.proxyEnabled, false);
  assert.equal(config.showNumber, false);
  assert.equal(config.proxyUrl, WORKER_DEFAULT_PROXY_URL);
  assert.equal(config.modelVersion, MODEL_VERSION);
  assert.equal(config.featureVersion, FEATURE_VERSION);
  assert.deepEqual(config.selectors, WORKER_SELECTORS);
});

test("config: buildConfig handles null/empty env gracefully", () => {
  const fromNull = buildConfig(null);
  const fromEmpty = buildConfig({});

  assert.equal(fromNull.proxyEnabled, false);
  assert.equal(fromEmpty.proxyEnabled, false);
  assert.deepEqual(fromNull.bandThresholds, { high: 0.75, medium: 0.45 });
  assert.deepEqual(fromEmpty.bandThresholds, { high: 0.75, medium: 0.45 });
});

test("config: BAND_HIGH and BAND_MEDIUM env overrides change thresholds", () => {
  const config = buildConfig({
    BAND_HIGH: "0.85",
    BAND_MEDIUM: "0.35",
  });

  assert.deepEqual(config.bandThresholds, {
    high: 0.85,
    medium: 0.35,
  });
});

test("config: proxyEnabled is true only when enabled in env", () => {
  const enabledStr = buildConfig({ PROXY_ENABLED: "true" });
  assert.equal(enabledStr.proxyEnabled, true);

  const enabledBool = buildConfig({ PROXY_ENABLED: true });
  assert.equal(enabledBool.proxyEnabled, true);

  const disabled = buildConfig({ PROXY_ENABLED: "false" });
  assert.equal(disabled.proxyEnabled, false);
});

test("config: selectors is always present and contains all required keys", () => {
  const config = buildConfig();

  assert.ok(config.selectors, "selectors must be present");
  const keys = Object.keys(config.selectors).sort();
  assert.deepEqual(keys, [
    "avatarContainer",
    "followingLink",
    "hoverCard",
    "layers",
  ]);
  for (const [key, val] of Object.entries(config.selectors)) {
    assert.equal(
      typeof val,
      "string",
      `selector ${key} must be a non-empty string`,
    );
    assert.ok(val.length > 0, `selector ${key} must not be empty`);
  }
});

test("router: GET /config returns 200 with JSON configuration", async () => {
  const req = new Request("https://api.ragebait-detector.test/config", {
    method: "GET",
  });
  const res = await worker.fetch(req, {
    BAND_HIGH: "0.80",
    PROXY_ENABLED: "true",
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") || "", /application\/json/);

  const data = await res.json();
  assert.equal(data.bandThresholds.high, 0.80);
  assert.equal(data.proxyEnabled, true);
  assert.ok(data.selectors);
});

test("router: non-GET request to /config returns 405 Method Not Allowed", async () => {
  const req = new Request("https://api.ragebait-detector.test/config", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const res = await worker.fetch(req, {});

  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "GET");
});

test("router: unknown route returns 404 Not Found", async () => {
  const req = new Request("https://api.ragebait-detector.test/nonexistent", {
    method: "GET",
  });
  const res = await worker.fetch(req, {});

  assert.equal(res.status, 404);
});
