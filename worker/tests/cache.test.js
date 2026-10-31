import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCacheKey,
  getCachedAnalysis,
  setCachedAnalysis,
} from "../src/cache.js";

// Minimal fake KV store mimicking Cloudflare Workers KV
function createFakeKV() {
  const store = new Map();
  const ttls = new Map();

  return {
    get(key, options) {
      if (!store.has(key)) return Promise.resolve(null);
      const raw = store.get(key);
      if (options?.type === "json") {
        return Promise.resolve(JSON.parse(raw));
      }
      return Promise.resolve(raw);
    },
    put(key, value, options) {
      store.set(key, value);
      if (options?.expirationTtl) {
        ttls.set(key, options.expirationTtl);
      }
      return Promise.resolve();
    },
    _store: store,
    _ttls: ttls,
  };
}

test("cache: buildCacheKey generates consistent sha256 hex", async () => {
  const key1 = await buildCacheKey("yoksiktir", "h1", "f1");
  const key2 = await buildCacheKey("Yoksiktir", "h1", "f1");

  assert.equal(typeof key1, "string");
  assert.equal(key1.length, 64); // sha256 hex
  assert.equal(key1, key2); // case-insensitive handle
});

test("cache: setCachedAnalysis and getCachedAnalysis roundtrip", async () => {
  const kv = createFakeKV();
  const key = await buildCacheKey("alice", "h1", "f1");
  const data = { answers: { is_provocative: { noul: 0.9 } }, model: "clef" };

  await setCachedAnalysis(kv, key, data, 48);
  const retrieved = await getCachedAnalysis(kv, key);

  assert.deepEqual(retrieved, data);
  // TTL must be 48 hours in seconds (48 * 3600 = 172800)
  assert.equal(kv._ttls.get(key), 48 * 3600);
});

test("cache: returns null on cache miss", async () => {
  const kv = createFakeKV();
  const key = await buildCacheKey("ghost", "h1", "f1");
  const res = await getCachedAnalysis(kv, key);

  assert.equal(res, null);
});
