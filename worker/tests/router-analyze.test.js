import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { buildCacheKey, sha256Hex } from "../src/cache.js";
import { canonicalModelState, validateAnalyzeBody } from "../src/analyze.js";

function createFakeKV() {
  const store = new Map();
  return {
    get(key, options) {
      if (!store.has(key)) return Promise.resolve(null);
      const raw = store.get(key);
      if (options?.type === "json") return Promise.resolve(JSON.parse(raw));
      return Promise.resolve(raw);
    },
    put(key, value) {
      store.set(key, typeof value === "string" ? value : JSON.stringify(value));
      return Promise.resolve();
    },
    _store: store,
  };
}

const VALID_STATE = {
  handle: "alice",
  features: { replyCount: 10, langSupported: true },
  replySample: ["hi"],
};

test("router: POST /analyze cache-first order serves cache without consuming quota", async () => {
  const kv = createFakeKV();
  // The cache key covers the canonical model state, not the handle alone.
  const cacheKey = await buildCacheKey(
    canonicalModelState(VALID_STATE),
    "h1",
    "f1",
  );
  const cachedData = {
    answers: { is_provocative: { noul: 0.1 } },
    model: "clef",
  };
  await kv.put(cacheKey, JSON.stringify(cachedData));

  const req = new Request("https://api.test/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Install-Token": "tok-cached",
    },
    body: JSON.stringify({ state: VALID_STATE }),
  });

  const res = await worker.fetch(req, { CACHE_KV: kv });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, cachedData);

  // Quota key was NOT touched since cache hit
  const quotaKeys = Array.from(kv._store.keys()).filter((k) =>
    k.startsWith("quota:tok-cached")
  );
  assert.equal(quotaKeys.length, 0);
});

test("router: POST /analyze consumes quota on miss and returns x-quota-remaining", async () => {
  const kv = createFakeKV();
  let modelCalled = false;

  const mockFetch = () => {
    modelCalled = true;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          answers: { is_provocative: { noul: 0.9 } },
          model: "clef",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  const req = new Request("https://api.test/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Install-Token": "tok-fresh",
    },
    body: JSON.stringify({ state: VALID_STATE }),
  });

  const res = await worker.fetch(
    req,
    { CACHE_KV: kv, CLOUDFLARE_ACCOUNT_ID: "acct-test", CLEF_API_KEY: "k" },
    null,
    mockFetch,
  );

  assert.equal(res.status, 200);
  assert.equal(modelCalled, true);
  assert.ok(res.headers.has("x-quota-remaining"));
  assert.equal(res.headers.get("x-quota-remaining"), "199");
});

test("router: POST /analyze returns 429 {state:'quota'} when daily limit reached", async () => {
  const kv = createFakeKV();

  // Set quota to exhausted (limit 200)
  const today = new Date().toISOString().slice(0, 10);
  await kv.put(`quota:tok-exhausted:${today}`, "200");

  const req = new Request("https://api.test/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Install-Token": "tok-exhausted",
    },
    body: JSON.stringify({ state: VALID_STATE }),
  });

  const res = await worker.fetch(req, { CACHE_KV: kv });
  assert.equal(res.status, 429);
  const data = await res.json();
  assert.equal(data.state, "quota");
});

// ---- Policy tests (Task 2) ----
// The hosted Worker is a public service: no path authenticates the extension.
// X-Install-Token is quota accounting / abuse resistance only, and direct
// HTTP clients get exactly the documented non-browser contract.

function mockModelFetch(counter) {
  return () => {
    counter.calls += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          answers: { is_provocative: { noul: 0.9 } },
          model: "clef",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };
}

test("router: POST /analyze rejects a missing token with bounded 400 and no model call", async () => {
  const counter = { calls: 0 };
  const kv = createFakeKV();

  // No header and no body field.
  const reqNone = new Request("https://api.test/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: VALID_STATE }),
  });
  const resNone = await worker.fetch(
    reqNone,
    { CACHE_KV: kv },
    null,
    mockModelFetch(counter),
  );
  assert.equal(resNone.status, 400);
  assert.deepEqual(await resNone.json(), { error: "install_token_required" });
  assert.equal(counter.calls, 0);

  // A blank/oversized header counts as missing.
  const reqBlank = new Request("https://api.test/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Install-Token": "   ",
    },
    body: JSON.stringify({ state: VALID_STATE }),
  });
  const resBlank = await worker.fetch(
    reqBlank,
    { CACHE_KV: kv },
    null,
    mockModelFetch(counter),
  );
  assert.equal(resBlank.status, 400);
  assert.equal(counter.calls, 0);

  // No "anonymous" fallback bucket is ever created.
  const anonKeys = Array.from(kv._store.keys()).filter((k) =>
    k.startsWith("quota:anonymous")
  );
  assert.equal(anonKeys.length, 0);
});

test("router: POST /analyze with body-only installToken works (documented fallback)", async () => {
  const counter = { calls: 0 };
  const kv = createFakeKV();

  const req = new Request("https://api.test/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: VALID_STATE, installToken: "tok-body" }),
  });

  const res = await worker.fetch(
    req,
    { CACHE_KV: kv, CLOUDFLARE_ACCOUNT_ID: "acct-test", CLEF_API_KEY: "k" },
    null,
    mockModelFetch(counter),
  );
  assert.equal(res.status, 200);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(kv._store.has(`quota:tok-body:${today}`));
});

test("router: arbitrary token accepted even with INSTALL_TOKEN_SECRET set — the secret authenticates nothing", async () => {
  const counter = { calls: 0 };
  const kv = createFakeKV();

  // Direct HTTP, no browser headers at all: no Origin, no signature. The
  // documented policy says this is the same public contract as the extension.
  const req = new Request("https://api.test/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Install-Token": "forged-token-from-curl",
    },
    body: JSON.stringify({ state: VALID_STATE }),
  });

  const res = await worker.fetch(
    req,
    {
      CACHE_KV: kv,
      CLOUDFLARE_ACCOUNT_ID: "acct-test",
      CLEF_API_KEY: "k",
      // The operator must never be able to "fix" abuse by turning this on:
      // the extension sends no X-Install-Signature, so enabling it as auth
      // would break every legitimate request and protect nothing.
      INSTALL_TOKEN_SECRET: "operator-only-secret-123",
    },
    null,
    mockModelFetch(counter),
  );

  assert.equal(res.status, 200);
  assert.equal(counter.calls, 1);
});

test("router: token rotation gets a fresh bucket (documented limitation of per-identity quota)", async () => {
  const kv = createFakeKV();
  const today = new Date().toISOString().slice(0, 10);

  // Identifier A is exhausted.
  await kv.put(`quota:tok-rot-A:${today}`, "200");
  const reqA = new Request("https://api.test/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Install-Token": "tok-rot-A",
    },
    body: JSON.stringify({ state: VALID_STATE }),
  });
  const resA = await worker.fetch(reqA, { CACHE_KV: kv });
  assert.equal(resA.status, 429);

  // Client rotates (reinstall / new device / forged token): B is fresh and
  // gets a full new bucket. Documented limitation: per-identifier quota is
  // abuse resistance only; rotation is trivial. Edge/IP and global limits
  // (Task 3) must cover the rest.
  const counter = { calls: 0 };
  const reqB = new Request("https://api.test/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Install-Token": "tok-rot-B",
    },
    body: JSON.stringify({ state: VALID_STATE }),
  });
  const resB = await worker.fetch(
    reqB,
    { CACHE_KV: kv, CLOUDFLARE_ACCOUNT_ID: "acct-test", CLEF_API_KEY: "k" },
    null,
    mockModelFetch(counter),
  );
  assert.equal(resB.status, 200);
  assert.equal(counter.calls, 1);
  // The fresh token consumed one quota unit before the model call.
  assert.equal(kv._store.get(`quota:tok-rot-B:${today}`), "1");
});

test("router: direct HTTP request over the limit is refused by quota, not by CORS", async () => {
  const kv = createFakeKV();
  const today = new Date().toISOString().slice(0, 10);

  const req = new Request("https://api.test/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Deliberately NO Origin/UserAgent/Sec-Fetch*: direct HTTP client.
      "X-Install-Token": "tok-script",
    },
    body: JSON.stringify({ state: VALID_STATE }),
  });

  await kv.put(`quota:tok-script:${today}`, "200");
  const res = await worker.fetch(req, { CACHE_KV: kv });
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { state: "quota" });
  assert.equal(res.headers.get("x-quota-remaining"), "0");
});

test("router: missing CACHE_KV fails closed with bounded 503 quota_unavailable, no model call", async () => {
  const counter = { calls: 0 };
  const req = new Request("https://api.test/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Install-Token": "tok-nokv",
    },
    body: JSON.stringify({ state: VALID_STATE }),
  });

  const res = await worker.fetch(
    req,
    { CLOUDFLARE_ACCOUNT_ID: "acct-test", CLEF_API_KEY: "k" },
    null,
    mockModelFetch(counter),
  );
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "quota_unavailable" });
  assert.equal(res.headers.get("Retry-After"), "60");
  assert.equal(counter.calls, 0);
});

test("router: quota store failure fails closed with bounded 503 quota_unavailable, no model call", async () => {
  const counter = { calls: 0 };
  const brokenKV = {
    get() {
      return Promise.reject(new Error("KV read failed"));
    },
    put() {
      return Promise.reject(new Error("KV write failed"));
    },
  };

  const req = new Request("https://api.test/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Install-Token": "tok-broken-kv",
    },
    body: JSON.stringify({ state: VALID_STATE }),
  });

  const res = await worker.fetch(
    req,
    {
      CACHE_KV: brokenKV,
      CLOUDFLARE_ACCOUNT_ID: "acct-test",
      CLEF_API_KEY: "k",
    },
    null,
    mockModelFetch(counter),
  );
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "quota_unavailable" });
  assert.equal(res.headers.get("Retry-After"), "60");
  assert.equal(counter.calls, 0);
});

// ---- Input gate tests (Task 4) ----
// The body is caller-supplied and the model is a paid, shared resource: a
// strict gate (size, depth, allowlists, handle, bounds) runs before any
// cache/quota/model work, every rejection shares the bounded opaque
// `invalid_request` 400, and the cache key covers the canonical model input,
// never the handle alone.

/** Runs one gate case and asserts the bounded rejection + no side effects. */
async function expectInvalidRequest(kv, req, counter, message) {
  const res = await worker.fetch(
    req,
    { CACHE_KV: kv },
    null,
    mockModelFetch(counter),
  );
  assert.equal(res.status, 400, message);
  assert.deepEqual(await res.json(), { error: "invalid_request" }, message);
  assert.equal(counter.calls, 0, message);
  const quotaKeys = Array.from(kv._store.keys()).filter((k) =>
    k.startsWith("quota:")
  );
  assert.equal(quotaKeys.length, 0, message);
}

function gateRequest(payload) {
  return new Request("https://api.test/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Install-Token": "tok-gate",
    },
    body: JSON.stringify(payload),
  });
}

test("task4: unknown top-level body field -> bounded 400, no quota key, no model call", async () => {
  const kv = createFakeKV();
  const counter = { calls: 0 };
  await expectInvalidRequest(
    kv,
    gateRequest({ state: VALID_STATE, installToken: "tok-gate", extra: 1 }),
    counter,
  );
});

test("task4: unknown state field and unknown feature key -> bounded 400, no model call", async () => {
  const counter = { calls: 0 };

  const kvState = createFakeKV();
  await expectInvalidRequest(
    kvState,
    gateRequest({
      state: { ...VALID_STATE, evil: 1 },
      installToken: "tok-gate",
    }),
    counter,
  );

  const kvFeature = createFakeKV();
  await expectInvalidRequest(
    kvFeature,
    gateRequest({
      state: {
        handle: "alice",
        features: { replyCount: 1, mood: "angry" },
        replySample: [],
      },
    }),
    counter,
  );
});

test("task4: oversized body (> 16 KiB) -> bounded 400 before any work", async () => {
  const kv = createFakeKV();
  const counter = { calls: 0 };
  await expectInvalidRequest(
    kv,
    gateRequest({
      state: { ...VALID_STATE, replySample: ["x".repeat(20000)] },
    }),
    counter,
  );
});

test("task4: nesting depth > 4 -> bounded 400", async () => {
  const kv = createFakeKV();
  const counter = { calls: 0 };
  await expectInvalidRequest(
    kv,
    gateRequest({
      state: {
        handle: "alice",
        features: { replyCount: { a: { b: { c: 1 } } } },
      },
    }),
    counter,
  );
});

test("task4: > 12 replies and > 400-char snippet -> bounded 400", async () => {
  const counter = { calls: 0 };

  const kvLong = createFakeKV();
  await expectInvalidRequest(
    kvLong,
    gateRequest({
      state: {
        handle: "alice",
        features: { replyCount: 13 },
        replySample: Array.from({ length: 13 }, (_v, i) => `r${i}`),
      },
    }),
    counter,
  );

  const kvBig = createFakeKV();
  await expectInvalidRequest(
    kvBig,
    gateRequest({
      state: {
        handle: "alice",
        features: { replyCount: 1 },
        replySample: ["a".repeat(401)],
      },
    }),
    counter,
  );
});

test("task4: wrong feature value type or range -> bounded 400 each", async () => {
  const cases = [
    ["ratio > 1", { replyCount: 3, capsRatio: 1.5 }],
    ["ratio < 0", { replyCount: 3, exclamationRatio: -0.1 }],
    ["non-integer count", { replyCount: 3.5 }],
    ["negative count", { replyCount: 3, distinctTargets: -1 }],
    ["count > 100000", { replyCount: 3, distinctTargets: 100001 }],
    ["replyCount > 1000", { replyCount: 1001 }],
    ["string number", { replyCount: "10" }],
    ["boolean number", { replyCount: true }],
    ["likesPerReply too large", { replyCount: 3, likesPerReply: 1000001 }],
    ["likesPerReply negative", { replyCount: 3, likesPerReply: -1 }],
    ["langSupported string", { replyCount: 3, langSupported: "true" }],
    ["lexiconHits string", { replyCount: 3, lexiconHits: "3" }],
    ["lexiconHits negative", { replyCount: 3, lexiconHits: -1 }],
    ["feature value object", { replyCount: { nested: 1 } }],
  ];

  for (const [name, features] of cases) {
    const kv = createFakeKV();
    const counter = { calls: 0 };
    await expectInvalidRequest(
      kv,
      gateRequest({
        state: { handle: "alice", features, replySample: [] },
      }),
      counter,
      name,
    );
  }
});

test("task4: validator rejects non-JSON-reachable NaN and Infinity", () => {
  const nan = validateAnalyzeBody({
    state: { handle: "alice", features: { capsRatio: NaN }, replySample: [] },
  });
  assert.equal(nan.ok, false);

  const inf = validateAnalyzeBody({
    state: {
      handle: "alice",
      features: { replyCount: Infinity },
      replySample: [],
    },
  });
  assert.equal(inf.ok, false);
});

test("task4: JSON 1e999 leaks Infinity -> bounded 400", async () => {
  const kv = createFakeKV();
  const counter = { calls: 0 };
  const req = new Request("https://api.test/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Install-Token": "tok-gate",
    },
    // JSON.parse("1e999") produces Infinity.
    body:
      `{"state":{"handle":"alice","features":{"replyCount":1e999},"replySample":[]}}`,
  });
  await expectInvalidRequest(kv, req, counter);
});

test("task4: invalid handles -> bounded 400", async () => {
  const badHandles = ["alice!", "", "abcdefghijklmnop", "a b", "héllo"];
  for (const handle of badHandles) {
    const kv = createFakeKV();
    const counter = { calls: 0 };
    await expectInvalidRequest(
      kv,
      gateRequest({
        state: { handle, features: { replyCount: 1 }, replySample: [] },
      }),
      counter,
    );
  }
});

test("task4: cache-poisoning proof — distinct states for one handle get distinct cache entries", async () => {
  const kv = createFakeKV();
  const counter = { calls: 0 };

  // Pre-poison the legacy handle-only key so a regression back to it is
  // observable: a valid request must MISS it and call the model.
  const legacyKey = await sha256Hex("ragebait:v1:h1:f1:alice");
  await kv.put(legacyKey, JSON.stringify({ poisoned: true }));

  const makeFetch = () => {
    return (_url) => {
      counter.calls += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            answers: { is_provocative: { noul: 0.5 + 0.1 * counter.calls } },
            model: "clef",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    };
  };
  const env = {
    CACHE_KV: kv,
    MODEL_VERSION: "h1",
    FEATURE_VERSION: "f1",
    CLOUDFLARE_ACCOUNT_ID: "acct-test",
    CLEF_API_KEY: "k",
  };

  const state1 = {
    handle: "alice",
    features: { replyCount: 10, langSupported: true },
    replySample: ["hi"],
  };
  const state2 = {
    handle: "alice",
    features: { replyCount: 11, langSupported: true },
    replySample: ["hi"],
  };

  // Caller A: handle alice + state S1 -> model call + cache write.
  const reqA = gateRequestWithToken(state1, "tok-poison-A");
  const resA = await worker.fetch(reqA, env, null, makeFetch());
  assert.equal(resA.status, 200);
  const dataA = await resA.json();
  assert.equal(counter.calls, 1);
  assert.deepEqual(dataA, {
    answers: { is_provocative: { noul: 0.6 } },
    model: "clef",
  });

  // Caller B: SAME handle, different state S2 -> must MISS (distinct cache
  // key) and call the model again. The poisoned entry is never served.
  const reqB = gateRequestWithToken(state2, "tok-poison-B");
  const resB = await worker.fetch(reqB, env, null, makeFetch());
  assert.equal(resB.status, 200);
  const dataB = await resB.json();
  assert.equal(counter.calls, 2);
  assert.deepEqual(dataB, {
    answers: { is_provocative: { noul: 0.7 } },
    model: "clef",
  });

  // Caller C: state S1 under a differently-cased handle -> same canonical
  // key as A -> cache HIT, no third model call.
  const stateC = { ...state1, handle: "ALICE" };
  const reqC = gateRequestWithToken(stateC, "tok-poison-C");
  const resC = await worker.fetch(reqC, env, null, makeFetch());
  assert.equal(resC.status, 200);
  const dataC = await resC.json();
  assert.equal(counter.calls, 2);
  assert.deepEqual(dataC, dataA);
});

function gateRequestWithToken(state, token) {
  return new Request("https://api.test/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Install-Token": token,
    },
    body: JSON.stringify({ state }),
  });
}

test("task4: upstream-error logs never contain request body or reply text", async () => {
  const kv = createFakeKV();
  const counter = { calls: 0 };
  const req = gateRequestWithToken(
    {
      handle: "alice",
      features: { replyCount: 1 },
      replySample: ["SUPER-SECRET-REPLY-TEXT"],
    },
    "tok-token-log",
  );
  const brokenFetch = () => {
    counter.calls += 1;
    return Promise.resolve(new Response("upstream failed", { status: 500 }));
  };

  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args);
  try {
    const res = await worker.fetch(
      req,
      {
        CACHE_KV: kv,
        CLOUDFLARE_ACCOUNT_ID: "acct-test",
        CLEF_API_KEY: "cf-token",
        TYPESAFE_API_KEY: "jev-key",
      },
      null,
      brokenFetch,
    );
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "ai_unavailable" });
  } finally {
    console.warn = origWarn;
  }

  assert.ok(warns.length > 0); // the upstream-error path did log something
  for (const args of warns) {
    const flat = args.map((
      a,
    ) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    assert.ok(!flat.includes("SUPER-SECRET-REPLY-TEXT"), "logged reply text");
    assert.ok(!flat.includes("tok-token-log"), "logged install token");
    assert.ok(!flat.includes('"replySample"'), "logged request structure");
    // Truncated upstream snippet: every logged body string is <= 120 chars.
    for (const arg of args) {
      if (arg && typeof arg === "object" && typeof arg.body === "string") {
        assert.ok(arg.body.length <= 120);
      }
    }
  }
});
