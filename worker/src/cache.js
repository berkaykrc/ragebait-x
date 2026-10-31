// Worker shared KV cache for analysis results (48h TTL).
//
// Key is sha256("ragebait:v1:{modelVersion}:{featureVersion}:{lowerHandle}").

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
 * Builds the canonical unified cache key for a given handle and versions.
 *
 * @param {string} handle
 * @param {string} modelVersion
 * @param {string} featureVersion
 * @returns {Promise<string>}
 */
export async function buildCacheKey(handle, modelVersion, featureVersion) {
  const rawKey =
    `ragebait:v1:${modelVersion}:${featureVersion}:${handle.toLowerCase()}`;
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
