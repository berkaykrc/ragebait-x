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
