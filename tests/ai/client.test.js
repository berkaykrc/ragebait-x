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

// ---- Policy tests (Task 2) ----
// The install token is a self-generated, forgeable quota identifier. The
// client holds no shared secret, computes no HMAC, and must never send
// X-Install-Signature; that header is reserved for a future server-issued
// credential flow.

test("ai client: proxy request never sends X-Install-Signature (no shared secret)", async () => {
  let captured = null;
  const mockFetch = (url, opts) => {
    captured = { url, opts };
    return Promise.resolve(
      new Response(
        JSON.stringify({
          answers: { is_provocative: { noul: 0.5 } },
          model: "clef",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  await analyzeWithAi(
    VALID_STATE,
    {
      mode: "proxy",
      proxyUrl: "https://api.ragebait-detector.test/analyze",
      installToken: "tok-no-secret",
      proxyEnabled: true,
    },
    mockFetch,
  );

  assert.equal(captured.opts.headers["X-Install-Token"], "tok-no-secret");
  assert.equal("X-Install-Signature" in captured.opts.headers, false);
  // Body is the documented { state, installToken } payload.
  const parsed = JSON.parse(captured.opts.body);
  assert.equal(parsed.installToken, "tok-no-secret");
  assert.deepEqual(Object.keys(parsed), ["state", "installToken"]);
});

test("ai client: token rotation is sent as-is — a fresh token simply replaces the old one", async () => {
  const requests = [];
  const mockFetch = (_url, opts) => {
    requests.push(JSON.parse(opts.body).installToken);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          answers: { is_provocative: { noul: 0.5 } },
          model: "clef",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  // Install A: first token.
  const storageA = createVolatileStorage();
  const tokenA = await getInstallToken(storageA);

  // Install B: a separate storage (new device/reinstall) generates a
  // different forgeable token; per-identity quota starts from zero again.
  const storageB = createVolatileStorage();
  const tokenB = await getInstallToken(storageB);
  assert.notEqual(tokenA, tokenB);

  await analyzeWithAi(
    VALID_STATE,
    {
      mode: "proxy",
      proxyUrl: "https://api.ragebait-detector.test/analyze",
      installToken: tokenA,
      proxyEnabled: true,
    },
    mockFetch,
  );

  await analyzeWithAi(
    VALID_STATE,
    {
      mode: "proxy",
      proxyUrl: "https://api.ragebait-detector.test/analyze",
      installToken: tokenB,
      proxyEnabled: true,
    },
    mockFetch,
  );

  assert.deepEqual(requests, [tokenA, tokenB]);
});

/**
 * Minimal volatile browser.storage.local double: each instance starts empty,
 * mirroring a fresh install (fresh quota identity).
 *
 * @returns {{ get(key: string): Promise<Record<string, unknown>>, set(items: Record<string, unknown>): Promise<void> }}
 */
function createVolatileStorage() {
  const map = new Map();
  return {
    get(key) {
      return Promise.resolve(
        { [key]: map.has(key) ? map.get(key) : undefined },
      );
    },
    set(items) {
      for (const [k, v] of Object.entries(items)) map.set(k, v);
      return Promise.resolve();
    },
  };
}
