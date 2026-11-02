// Worker shared KV cache for analysis results (48h TTL).
//
// Key is sha256("ragebait:v2:{modelVersion}:{featureVersion}:{canonicalState}")
// where canonicalState is the deterministic serialization of the CANONICAL
// MODEL STATE (normalized handle, features, truncated reply sample) — never
// the handle alone (Task 4: one caller must not be able to prime a shared
// cache entry for a handle with state another caller did not submit). The v2
// prefix also orphans any legacy handle-only entries from old deployments.

/**
 * Computes the SHA-256 hex digest of a string using Web Crypto.
 *
 * @param {string} input
 * @returns {Promise<string>}
 */
export async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Deterministic serialization of key material: object keys sorted, array
 * order preserved (reply sample order is part of the model input). Two
 * canonical states with the same content therefore hash identically even
 * when their property insertion order differs.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${
    keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")
  }}`;
}

/**
 * Builds the canonical unified cache key for a CANONICAL MODEL STATE and
 * versions. `modelState` is the validated canonical state as produced by
 * `canonicalModelState` (analyze.js): { handle (lower-cased), features
 * (canonical order), replySample (truncated) }.
 *
 * @param {{ handle: string, features: Record<string, unknown>, replySample: string[] }} modelState
 * @param {string} modelVersion
 * @param {string} featureVersion
 * @returns {Promise<string>}
 */
export async function buildCacheKey(modelState, modelVersion, featureVersion) {
  const rawKey = `ragebait:v2:${modelVersion}:${featureVersion}:${
    stableStringify(modelState)
  }`;
  return await sha256Hex(rawKey);
}

/**
 * Retrieves a cached analysis from Cloudflare Workers KV.
 *
 * @param {{ get(key: string, options?: { type?: string }): Promise<unknown> } | null | undefined} kv
 * @param {string} key
 * @returns {Promise<object | null>}
 */
export async function getCachedAnalysis(kv, key) {
  if (!kv || typeof kv.get !== "function") return null;
  try {
    const val = await kv.get(key, { type: "json" });
    return val && typeof val === "object" ? val : null;
  } catch (_err) {
    return null;
  }
}

/**
 * Stores an analysis result into Cloudflare Workers KV with an expiration TTL.
 *
 * @param {{ put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> } | null | undefined} kv
 * @param {string} key
 * @param {object} value
 * @param {number} [ttlHours=48]
 * @returns {Promise<void>}
 */
export async function setCachedAnalysis(kv, key, value, ttlHours = 48) {
  if (!kv || typeof kv.put !== "function") return;
  try {
    const expirationTtl = Math.max(60, ttlHours * 3600);
    await kv.put(key, JSON.stringify(value), { expirationTtl });
  } catch (_err) {
    // KV write failures must never fail the request
  }
}
