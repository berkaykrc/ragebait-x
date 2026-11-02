import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { buildCacheKey } from "../src/cache.js";

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
  const cacheKey = await buildCacheKey("alice", "h1", "f1");
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
