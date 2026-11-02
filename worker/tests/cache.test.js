import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCacheKey,
  getCachedAnalysis,
  setCachedAnalysis,
} from "../src/cache.js";
import { canonicalModelState } from "../src/analyze.js";

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

test("cache: buildCacheKey generates consistent sha256 hex (canonical model state)", async () => {
  const state = {
    handle: "yoksiktir",
    features: { replyCount: 3, langSupported: true },
    replySample: ["x"],
  };
  const key1 = await buildCacheKey(canonicalModelState(state), "h1", "f1");
  const stateUpper = { ...state, handle: "Yoksiktir" };
  const key2 = await buildCacheKey(
    canonicalModelState(stateUpper),
    "h1",
    "f1",
  );

  assert.equal(typeof key1, "string");
  assert.equal(key1.length, 64); // sha256 hex
  assert.equal(key1, key2); // case-insensitive handle
});

test("cache: key depends on the canonical model state, not the handle alone", async () => {
  const base = {
    handle: "alice",
    features: { replyCount: 10, langSupported: true },
    replySample: ["hi"],
  };
  const key1 = await buildCacheKey(canonicalModelState(base), "h1", "f1");

  // Different state under the SAME handle -> different key. This is the
  // cache-poisoning defence: a primed entry for a handle can only ever be
  // served to a request carrying the same canonical state.
  const otherState = {
    ...base,
    features: { replyCount: 11, langSupported: true },
  };
  const key2 = await buildCacheKey(canonicalModelState(otherState), "h1", "f1");
  assert.notEqual(key1, key2);

  // Same state, different property insertion order -> same key.
  const reordered = {
    replySample: ["hi"],
    features: { langSupported: true, replyCount: 10 },
    handle: "ALICE",
  };
  const key3 = await buildCacheKey(canonicalModelState(reordered), "h1", "f1");
  assert.equal(key1, key3);

  // Different reply sample -> different key.
  const otherSample = { ...base, replySample: ["hey"] };
  const key4 = await buildCacheKey(
    canonicalModelState(otherSample),
    "h1",
    "f1",
  );
  assert.notEqual(key1, key4);
});

test("cache: missing replySample canonicalizes to the empty array", async () => {
  const without = { handle: "alice", features: { replyCount: 1 } };
  const withEmpty = {
    handle: "alice",
    features: { replyCount: 1 },
    replySample: [],
  };
  const keyA = await buildCacheKey(canonicalModelState(without), "h1", "f1");
  const keyB = await buildCacheKey(canonicalModelState(withEmpty), "h1", "f1");
  assert.equal(keyA, keyB);
});

test("cache: setCachedAnalysis and getCachedAnalysis roundtrip", async () => {
  const kv = createFakeKV();
  const key = await buildCacheKey(
    canonicalModelState({ handle: "alice", features: {}, replySample: [] }),
    "h1",
    "f1",
  );
  const data = { answers: { is_provocative: { noul: 0.9 } }, model: "clef" };

  await setCachedAnalysis(kv, key, data, 48);
  const retrieved = await getCachedAnalysis(kv, key);

  assert.deepEqual(retrieved, data);
  // TTL must be 48 hours in seconds (48 * 3600 = 172800)
  assert.equal(kv._ttls.get(key), 48 * 3600);
});

test("cache: returns null on cache miss", async () => {
  const kv = createFakeKV();
  const key = await buildCacheKey(
    canonicalModelState({ handle: "ghost", features: {}, replySample: [] }),
    "h1",
    "f1",
  );
  const res = await getCachedAnalysis(kv, key);

  assert.equal(res, null);
});
