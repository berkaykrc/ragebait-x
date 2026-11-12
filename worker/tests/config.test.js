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

test("task5: no debug or introspection routes exist on the router", async () => {
  // The Worker surface is only OPTIONS, GET /config and POST /analyze. These
  // paths are the ones an operator, load balancer probe or curious caller
  // might reasonably try; none may exist in any deployment environment.
  const debugPaths = [
    "/debug",
    "/__debug",
    "/admin",
    "/metrics",
    "/env",
    "/vars",
  ];

  for (const pathname of debugPaths) {
    const get = await worker.fetch(
      new Request(`https://api.ragebait-detector.test${pathname}`, {
        method: "GET",
      }),
      {},
    );
    assert.equal(get.status, 404, `GET ${pathname} must be 404`);

    const post = await worker.fetch(
      new Request(`https://api.ragebait-detector.test${pathname}`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
      {},
    );
    assert.equal(post.status, 404, `POST ${pathname} must be 404`);
  }
});

test("task5: GET /config output is public-only even with secrets in env", async () => {
  // Documented public key set for /config (buildConfig output). Anything
  // added there must be deliberately public and reviewed.
  const PUBLIC_CONFIG_KEYS = [
    "modelVersion",
    "featureVersion",
    "bandThresholds",
    "selectors",
    "showNumber",
    "proxyUrl",
    "proxyEnabled",
  ].sort();

  // Environment simulating a real deployment's secret surface, injected
  // through the same `env` the Worker uses for everything else.
  const SECRETS = [
    ["CLOUDFLARE_API_TOKEN", "cf-secret-do-not-serve-1234567890"],
    ["TYPESAFE_API_KEY", "typesafe-secret-do-not-serve-12345678"],
    ["INSTALL_TOKEN_SECRET", "hmac-secret-do-not-serve-123456789"],
    ["QUOTA_KILL_SWITCH", "pause-flag-42"],
  ];
  const env = {
    PROXY_ENABLED: "true",
    BAND_HIGH: "0.75",
    BAND_MEDIUM: "0.45",
    SHOW_NUMBER: "false",
    CLOUDFLARE_ACCOUNT_ID: "fe941e04eee6db1835c906a459435c1f",
    ...Object.fromEntries(SECRETS),
  };

  const res = await worker.fetch(
    new Request("https://api.ragebait-detector.test/config", { method: "GET" }),
    env,
  );
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.deepEqual(
    Object.keys(data).sort(),
    PUBLIC_CONFIG_KEYS,
    "/config must expose exactly the documented public keys",
  );

  // Serialized body must leak neither the secret names nor their values.
  const body = JSON.stringify(data);
  for (const [name, value] of SECRETS) {
    assert.ok(
      !body.includes(name),
      `/config body must not contain the name ${name}`,
    );
    assert.ok(
      !body.includes(value),
      `/config body must not contain the value of ${name}`,
    );
  }
});
