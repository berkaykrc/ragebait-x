// Local versioned cache for ragebait-detector.
//
// STORAGE SEAM (for the (future) browser.storage.local wrapper, Task 8):
//   - `storage` is an injected object with two methods plus optional
//     removal used to physically evict expired entries:
//       get(key) -> stored JSON string | null   (sync or Promise)
//       set(key, jsonString) -> void            (sync or Promise)
//       remove(keys: string[]) -> void          (optional, best-effort;
//       delete(key) -> void                     (fake dialect fallback)
//       keys() -> string[]                      (optional, used by sweep)
//   cache.js owns all JSON (de)serialisation and keying. Every read is
//   awaited internally so both synchronous fakes and a Promise-returning
//   browser.storage.local adapter work unchanged.
//   - `now` is an injected clock () -> number (ms). Defaults to Date.now.
//   - Any storage throw, corrupt JSON, missing field, or version/key mismatch
//     resolves to `null` and never throws (applies to get AND peek).
//
// Design: a Map front cache sits in front of the storage adapter. `get` checks
// memory first, then storage. TTL is derived from TTL_BY_STATE[value.state].

import { FEATURE_VERSION, MODEL_VERSION } from "../config.js";

/**
 * Time-to-live per result state. `quota` has a 0 TTL but, per the spec, is
 * never persisted at all (see set()).
 */
export const TTL_BY_STATE = Object.freeze({
  result: 7 * 24 * 3600e3,
  estimated: 3600e3,
  insufficient: 6 * 3600e3,
  error: 1800e3,
  quota: 0,
});

export const STALE_AFTER_FRACTION = 0.5;

function keyFor(mv, fv, handle) {
  return `ragebait:v1:${mv}:${fv}:${String(handle).toLowerCase()}`;
}

function parseEnvelope(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(obj, "value")) return null;
  if (typeof obj.fetchedAt !== "number" || !Number.isFinite(obj.fetchedAt)) {
    return null;
  }
  if (typeof obj.ttlMs !== "number" || !Number.isFinite(obj.ttlMs)) return null;
  return obj;
}

function stateOf(env) {
  return env && env.value && typeof env.value === "object"
    ? env.value.state
    : undefined;
}

function definedTtl(state) {
  // Returns the TTL for a known state, else undefined (= expired on read).
  return Object.prototype.hasOwnProperty.call(TTL_BY_STATE, state)
    ? TTL_BY_STATE[state]
    : undefined;
}

function isExpired(env, nowMs) {
  const state = stateOf(env);
  const ttl = definedTtl(state);
  if (typeof ttl !== "number" || !Number.isFinite(ttl)) return true; // unknown state
  return nowMs - env.fetchedAt > ttl;
}

function withStale(env, nowMs) {
  const state = stateOf(env);
  let ttl = definedTtl(state);
  if (typeof ttl !== "number" || !Number.isFinite(ttl)) ttl = env.ttlMs;
  const stale = typeof ttl === "number" && Number.isFinite(ttl)
    ? nowMs - env.fetchedAt > ttl * STALE_AFTER_FRACTION
    : true;
  return { ...env, stale };
}

async function tryStorageGet(storage, key) {
  if (!storage || typeof storage.get !== "function") {
    return { raw: null, threw: false, has: false };
  }
  try {
    const raw = await storage.get(key);
    return { raw: raw === undefined ? null : raw, threw: false, has: true };
  } catch {
    return { raw: null, threw: true, has: true };
  }
}

async function tryStorageSet(storage, key, json) {
  if (!storage || typeof storage.set !== "function") return;
  try {
    await storage.set(key, json);
  } catch {
    // Swallow: storage failures are reported as null reads, not throws.
  }
}

/**
 * Best-effort physical delete of an expired or corrupt entry. Supports both
 * seam dialects: `remove(keys)` (browser.storage.local, always an array) and
 * `delete(key)` (fakes, a single key). Never throws; a missing removal method
 * just leaves the entry unread.
 */
async function tryStorageRemove(storage, key) {
  if (!storage) return;
  try {
    if (typeof storage.remove === "function") {
      await storage.remove([key]);
    } else if (typeof storage.delete === "function") {
      await storage.delete(key);
    }
  } catch {
    // Swallow: pruning must never break a score lookup.
  }
}

export function createCache({
  storage,
  now,
  modelVersion = MODEL_VERSION,
  featureVersion = FEATURE_VERSION,
} = {}) {
  const mem = new Map();
  const nowFn = typeof now === "function" ? now : () => Date.now();
  const mv = modelVersion;
  const fv = featureVersion;

  function key(handle) {
    return keyFor(mv, fv, handle);
  }

  async function get(handle) {
    const k = key(handle);
    const currentNow = nowFn();

    // 1. Memory (front cache).
    if (mem.has(k)) {
      const parsed = parseEnvelope(mem.get(k));
      if (parsed && !isExpired(parsed, currentNow)) {
        return withStale(parsed, currentNow);
      }
      mem.delete(k);
    }

    // 2. Storage adapter.
    const res = await tryStorageGet(storage, k);
    if (res.threw) return null;
    if (res.raw === null || res.raw === undefined) return null;

    const parsed = parseEnvelope(res.raw);
    if (!parsed) {
      // Corrupt JSON is never readable again; evict it so it cannot
      // accumulate in storage.local.
      await tryStorageRemove(storage, k);
      return null;
    }
    if (isExpired(parsed, currentNow)) {
      // Physical eviction, not just logical expiry: without this, expired
      // envelopes accumulate in storage.local forever.
      await tryStorageRemove(storage, k);
      return null;
    }

    mem.set(k, parsed);
    return withStale(parsed, currentNow);
  }

  async function peek(handle) {
    const k = key(handle);

    if (mem.has(k)) {
      const parsed = parseEnvelope(mem.get(k));
      if (parsed) return parsed;
      mem.delete(k);
    }

    const res = await tryStorageGet(storage, k);
    if (res.threw) return null;
    if (res.raw === null || res.raw === undefined) return null;

    const parsed = parseEnvelope(res.raw);
    if (!parsed) {
      await tryStorageRemove(storage, k);
      return null;
    }
    // Peek is TTL-agnostic by contract, but do not seed the front cache with
    // an expired envelope: `get` would only delete it again.
    if (!isExpired(parsed, nowFn())) {
      mem.set(k, parsed);
    }
    return parsed;
  }

  async function set(handle, result) {
    // `quota` is never persisted (0 TTL, and the spec forbids writing it).
    if (result && result.state === "quota") return;

    const k = key(handle);
    const fetchedAt = nowFn();
    const env = {
      value: result,
      fetchedAt,
      ttlMs: definedTtl(result && result.state),
    };

    // If no TTL entry exists, store a 0 TTL so the record is immediately
    // expired on read but still parseable for peek.
    if (typeof env.ttlMs !== "number" || !Number.isFinite(env.ttlMs)) {
      env.ttlMs = 0;
    }

    mem.set(k, env);

    let json;
    try {
      json = JSON.stringify(env);
    } catch {
      return;
    }
    await tryStorageSet(storage, k, json);
  }

  async function sweep() {
    if (!storage || typeof storage.keys !== "function") return [];
    let keys;
    try {
      keys = await storage.keys();
    } catch {
      return [];
    }
    if (!Array.isArray(keys)) return [];
    const currentNow = nowFn();
    const removed = [];
    for (const k of keys) {
      if (typeof k !== "string" || !k.startsWith("ragebait:")) continue;
      const res = await tryStorageGet(storage, k);
      if (res.threw) continue;
      if (res.raw === null || res.raw === undefined) {
        await tryStorageRemove(storage, k);
        removed.push(k);
        continue;
      }
      const parsed = parseEnvelope(res.raw);
      if (!parsed || isExpired(parsed, currentNow)) {
        await tryStorageRemove(storage, k);
        removed.push(k);
      }
    }
    return removed;
  }

  return { get, set, peek, sweep };
}

export default createCache;
