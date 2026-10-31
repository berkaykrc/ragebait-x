import { test } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeWithAi,
  fetchConfig,
  getInstallToken,
} from "../../src/ai/client.js";

const VALID_STATE = {
  handle: "testuser",
  features: { replyCount: 10, langSupported: true },
  replySample: ["hi"],
};

test("ai client: mode 'heuristic' makes no network call at all (d)", async () => {
  let fetchCalled = false;
  const mockFetch = () => {
    fetchCalled = true;
    return Promise.resolve();
  };

  const result = await analyzeWithAi(
    VALID_STATE,
    { mode: "heuristic", proxyUrl: "https://api.test/analyze" },
    mockFetch,
  );

  assert.equal(fetchCalled, false);
  assert.deepEqual(result, { fallback: "heuristic" });
});

test("ai client: mode 'byok' calls byokEndpoint with Authorization header (e)", async () => {
  let captured = null;
  const mockFetch = (url, opts) => {
    captured = { url, opts };
    return Promise.resolve(
      new Response(
        JSON.stringify({
          answers: { is_provocative: { noul: 0.9 } },
          model: "custom",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  const result = await analyzeWithAi(
    VALID_STATE,
    {
      mode: "byok",
      byokEndpoint: "https://custom.ai.test/v1/analyze",
      apiKey: "secret-byok-key",
      thresholds: { high: 0.75, medium: 0.45 },
    },
    mockFetch,
  );

  assert.equal(captured.url, "https://custom.ai.test/v1/analyze");
  assert.equal(
    captured.opts.headers["Authorization"],
    "Bearer secret-byok-key",
  );
  assert.equal(result.band, "high");
  assert.equal(result.percent, 90);
  assert.equal(result.model, "custom");
});

test("ai client: mode 'proxy' calls proxyUrl with X-Install-Token (f)", async () => {
  let captured = null;
  const mockFetch = (url, opts) => {
    captured = { url, opts };
    return Promise.resolve(
      new Response(
        JSON.stringify({
          answers: {
            is_provocative: { noul: 0.5 },
            is_engagement_bait: { noul: 0.5 },
            targets_group_identity: { noul: 0.5 },
            reply_farms_opponents: { noul: 0.5 },
          },
          model: "clef",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  const result = await analyzeWithAi(
    VALID_STATE,
    {
      mode: "proxy",
      proxyUrl: "https://api.ragebait-detector.test/analyze",
      installToken: "tok-test-123",
      proxyEnabled: true,
      thresholds: { high: 0.75, medium: 0.45 },
    },
    mockFetch,
  );

  assert.equal(captured.url, "https://api.ragebait-detector.test/analyze");
  assert.equal(captured.opts.headers["X-Install-Token"], "tok-test-123");
  assert.equal(result.band, "medium");
  assert.equal(result.percent, 50);
  assert.equal(result.model, "clef");
});

test("ai client: Worker 429 propagates {state:'quota'} (g)", async () => {
  const mockFetch = () => {
    return Promise.resolve(
      new Response(JSON.stringify({ state: "quota" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const result = await analyzeWithAi(
    VALID_STATE,
    {
      mode: "proxy",
      proxyUrl: "https://api.ragebait-detector.test/analyze",
      installToken: "tok-exhausted",
      proxyEnabled: true,
    },
    mockFetch,
  );

  assert.deepEqual(result, { state: "quota" });
});

test("ai client: 502 ai_unavailable falls back to heuristic (h)", async () => {
  const mockFetch = () => {
    return Promise.resolve(
      new Response(JSON.stringify({ error: "ai_unavailable" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const result = await analyzeWithAi(
    VALID_STATE,
    {
      mode: "proxy",
      proxyUrl: "https://api.ragebait-detector.test/analyze",
      installToken: "tok-err",
      proxyEnabled: true,
    },
    mockFetch,
  );

  assert.deepEqual(result, { fallback: "heuristic" });
});

test("ai client: getInstallToken generates and persists token", async () => {
  const storageMap = {};
  const mockStorage = {
    get(key) {
      return Promise.resolve({ [key]: storageMap[key] });
    },
    set(items) {
      Object.assign(storageMap, items);
      return Promise.resolve();
    },
  };

  const token1 = await getInstallToken(mockStorage);
  assert.equal(typeof token1, "string");
  assert.equal(token1.length, 32); // 16 bytes hex

  // Second call returns same token from storage
  const token2 = await getInstallToken(mockStorage);
  assert.equal(token2, token1);
});

test("ai client: fetchConfig requests GET /config", async () => {
  const mockFetch = (url) => {
    assert.equal(url, "https://api.test/config");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          bandThresholds: { high: 0.8, medium: 0.5 },
          showNumber: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  const config = await fetchConfig(
    "https://api.test/analyze",
    mockFetch,
  );
  assert.equal(config.showNumber, true);
  assert.equal(config.bandThresholds.high, 0.8);
});
