// Worker quota accounting for the hosted /analyze endpoint.
//
// SECURITY MODEL (public, binding policy — do not weaken):
//
// - Quota identity is FORGEABLE. `X-Install-Token` is a self-generated client
//   identifier and `X-Quota-Identity` is a pseudonymous X viewer account ID
//   candidate read off X's own page state. Neither proves anything about who
//   is calling: any direct HTTP client (curl, script, other browser) can send
//   ANY value, including another caller's public ID (whose quota bucket it
//   then shares, drainable). Per-identity quota is therefore an
//   inconvenience, not a wall; edge/WAF rate limits and global cost controls
//   (documented below) are the actual backstops.
// - `X-Install-Signature` is RESERVED for a future server-issued credential
//   flow (see plan §"Future Strong Authentication Option"). This deployment
//   does not check, require, or honor it. There is intentionally no client
//   HMAC path today: the extension cannot safely hold a shared secret, and
//   enabling `INSTALL_TOKEN_SECRET` as live authentication would reject every
//   legitimate proxy request while adding no real security.
// - `INSTALL_TOKEN_SECRET` is a server-side secret. It is used INSIDE the
//   Worker only, to HMAC-derive pseudonymous quota namespaces ("x-account:…"
//   / "install:…" material) before anything is written to KV. It is keying
//   material for privacy, not authentication: the derived namespace can be
//   recomputed by anyone who sends the same public ID, so it does not verify
//   the caller. Raw X account IDs are NEVER persisted in quota keys.
// - Concurrency: the KV read/put daily counter is NOT atomic and is best
//   effort only — simultaneous misses for one identity can overrun the limit.
//   A hard limit requires the serialized counter backend contract
//   (`checkAndConsumeQuotaAtomic`, backed by e.g. a Durable Object). Until
//   that backend is bound, KV quota must be treated as abuse resistance, not
//   an enforced cap.
// - Fail closed: when the quota backend is unavailable (missing CACHE_KV,
//   unusable store, unusable serialized backend, or a server secret that a
//   new-format identity requires), /analyze returns a bounded
//   `quota_unavailable` / `model_calls_paused` error and never serves an
//   anonymous model call.
// - Edge/WAF layer (NOT this repository): independent per-IP and additional
//   global request-rate limits belong in Cloudflare platform configuration
//   (WAF rate limiting rules / platform spend alerts and budget limits).
//   This repo deliberately does not implement IP-based enforcement locally —
//   client-supplied IPs (e.g. a spoofed `CF-Connecting-IP` in tests) are not
//   trust anchors. No comment or test here proves production enforcement;
//   that verification lives with the deployment (Task 6).

/** Maximum accepted length of a quota identifier (bounds KV key size). */
export const MAX_QUOTA_IDENTITY_LENGTH = 128;

/**
 * Aggregates every documented bounded /analyze error into one contract so
 * callers (extension and self-hosters) see a single source of truth. Response
 * bodies carry the machine-readable code only; the human explanation lives in
 * the comments where each response is constructed.
 *
 * - `install_token_required` (400): no bounded quota identity at all.
 * - `model_calls_paused` (503, Retry-After): global Model-call refusals —
 *   the operator kill switch is engaged, or the global daily model-call
 *   ceiling is exhausted. Cached responses stay available.
 * - `quota_unavailable` (503, Retry-After): quota protection itself could
 *   not run (store/backend unusable, or a secret-dependent identity could
 *   not be derived fail-closed).
 */
export const ANALYZE_ERRORS = {
  install_token_required: { status: 400 },
  model_calls_paused: { status: 503 },
  quota_unavailable: { status: 503 },
};

/**
 * Version tag in daily quota keys. "v2" keys carry an HMAC-derived namespace
 * digest; "v1"-style legacy keys (`quota:{token}:{ymd}`) remain on the
 * temporary no-secret migration path only (see `extractQuotaIdentity`).
 */
export const QUOTA_KEY_VERSION = "v2";

/**
 * X viewer account IDs are positive decimal integers; X IDs today fit well
 * within 64 bits. The Worker mirrors the extension's format check at its own
 * boundary (never trust the client blindly — but rejecting malformed
 * candidates here is hygiene, not security).
 */
export const X_ACCOUNT_ID_PATTERN = /^[1-9][0-9]{0,18}$/;

/**
 * Derives the legacy daily quota key: quota:{installToken}:{YYYY-MM-DD}.
 *
 * TEMPORARY migration path: this persists the raw (self-generated, random,
 * non-PII) install token in the key. Once `INSTALL_TOKEN_SECRET` is
 * configured, identities are HMAC-derived instead (`getQuotaKeyV2`).
 *
 * @param {string} installToken
 * @param {Date | string} [date]
 * @returns {string}
 */
export function getQuotaKey(installToken, date = new Date()) {
  const ymd = typeof date === "string" ? date : date.toISOString().slice(0, 10);
  return `quota:${installToken}:${ymd}`;
}

/**
 * Builds a v2 daily quota key from an already-derived namespace digest:
 * quota:v2:{hmacDigest}:{YYYY-MM-DD}.
 *
 * @param {string} namespace Hex digest from `deriveQuotaNamespace` (64 chars).
 * @param {Date | string} [date]
 * @returns {string}
 */
export function getQuotaKeyV2(namespace, date = new Date()) {
  const ymd = typeof date === "string" ? date : date.toISOString().slice(0, 10);
  return `quota:${QUOTA_KEY_VERSION}:${namespace}:${ymd}`;
}

/**
 * Builds the daily global model-call ceiling key (server-side domain, not a
 * caller-visible identity): quota:global:model-calls:{YYYY-MM-DD}.
 *
 * @param {Date | string} [date]
 * @returns {string}
 */
export function getGlobalQuotaKey(date = new Date()) {
  const ymd = typeof date === "string" ? date : date.toISOString().slice(0, 10);
  return `quota:global:model-calls:${ymd}`;
}

/**
 * Reads the quota identity for a request. This is NOT authentication (see the
 * security model at the top of this file) — every value is forgeable.
 *
 * Selection precedence (mirrors the extension's `resolveQuotaIdentity`
 * rollout contract):
 *   1. `X-Quota-Identity`   — numeric X viewer ID (kind "x-account").
 *   2. `X-Install-Token`    — documented install-token header.
 *   3. body `installToken`  — documented body field.
 *
 * A malformed `X-Quota-Identity` (non-numeric, oversized, whitespace) does
 * NOT fail the request: like the extension side, it falls back to the
 * install-token path when one is present, otherwise the router answers with
 * the bounded `install_token_required` error.
 *
 * Callers CAN still forge any returned value — e.g. claim another person's
 * viewer ID and share/drain that bucket. That tolerance is a documented
 * property of this adoption-stage abuse model, never advertised as stronger.
 *
 * @param {Request} request
 * @param {unknown} [body] Parsed JSON body (may be unavailable).
 * @returns {{ kind: "x-account" | "install", value: string } | null}
 *   Bounded quota identity, or null when absent/invalid.
 */
export function extractQuotaIdentity(request, body) {
  // 1. Optional pseudonymous X-account namespace candidate.
  const xQuotaIdentity = request.headers.get("X-Quota-Identity");
  if (typeof xQuotaIdentity === "string" && xQuotaIdentity.length > 0) {
    if (
      xQuotaIdentity.length <= MAX_QUOTA_IDENTITY_LENGTH &&
      X_ACCOUNT_ID_PATTERN.test(xQuotaIdentity)
    ) {
      return { kind: "x-account", value: xQuotaIdentity };
    }
    // Malformed candidates fall through to the install-token fallback;
    // they never block analysis (plan constraint).
  }

  // 2./3. Documented install-token header, with body-field fallback.
  const headerToken = request.headers.get("X-Install-Token");
  const candidate = typeof headerToken === "string" && headerToken.length > 0
    ? headerToken
    : typeof body === "object" && body !== null &&
        typeof (/** @type {Record<string, unknown>} */ (body).installToken) ===
          "string"
    ? /** @type {Record<string, unknown>} */ (body).installToken
    : null;

  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > MAX_QUOTA_IDENTITY_LENGTH
  ) {
    return null;
  }

  if (/[^\x21-\x7E]/.test(candidate)) {
    // Whitespace or control characters would poison KV keys; reject.
    return null;
  }

  return { kind: "install", value: candidate };
}

/**
 * HMAC-SHA256-derives a non-reversible pseudonymous quota namespace from
 * domain-separated identity material:
 *
 *   deriveQuotaNamespace(`x-account:${viewerId}`, secret)
 *   deriveQuotaNamespace(`install:${installToken}`, secret)
 *
 * The caller MUST pass domain-separated material so that equal raw strings
 * under different kinds can never collide into one bucket. The derived
 * digest is standalone: recomputing it needs the raw public identity, which
 * callers can send anyway, so the digest adds privacy (no raw X IDs at rest)
 * — NOT caller verification.
 *
 * @param {string} material Namespaced identity material ("kind:value").
 * @param {string} secret Server-only secret (INSTALL_TOKEN_SECRET). The
 *   secret never ships to clients (see `worker/wrangler.toml.example`) and a long
 *   random value keeps the digest strong enough to protect raw IDs at rest.
 * @returns {Promise<string>} 64-char hex digest.
 */
export async function deriveQuotaNamespace(material, secret) {
  if (typeof material !== "string" || material.length === 0) {
    throw new Error("Namespace material required");
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("Derivation secret required");
  }
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(material),
  );
  return Array.from(new Uint8Array(mac)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

/**
 * Parses the operator quota controls from the Worker environment.
 *
 * - `QUOTA_KILL_SWITCH`: emergency brake — "1" / "true" / "on" (i.e. the
 *   documented truthy flag set) disables model MISSES; cached responses stay
 *   available in the router (cache is checked first). The actual production
 *   enforcement of the wider edge-side brake (platform-level spend
 *   stop/disable) lives in Cloudflare config, not this repository.
 * - `GLOBAL_DAILY_MODEL_CEILING`: a positive global daily model-call cap
 *   (UTC days, like the per-identity bucket). Unset or unparseable disables
 *   the ceiling; callers must rely on per-identity quota + edge rate limits
 *   in that case (disclosure: see security model — abuse resistance, not a
 *   wall).
 *
 * @param {Record<string, unknown> | null | undefined} env
 * @returns {{ killSwitch: boolean, globalDailyCeiling: number | null }}
 */
export function parseQuotaControls(env) {
  const safeEnv = env && typeof env === "object" ? env : {};

  const killRaw = typeof safeEnv.QUOTA_KILL_SWITCH === "string"
    ? safeEnv.QUOTA_KILL_SWITCH.trim()
    : "";
  const killSwitch = /^(1|true|on)$/i.test(killRaw);

  const ceilingRaw = typeof safeEnv.GLOBAL_DAILY_MODEL_CEILING === "number"
    ? safeEnv.GLOBAL_DAILY_MODEL_CEILING
    : Number.parseInt(
      typeof safeEnv.GLOBAL_DAILY_MODEL_CEILING === "string"
        ? safeEnv.GLOBAL_DAILY_MODEL_CEILING
        : "",
      10,
    );
  const globalDailyCeiling = Number.isFinite(ceilingRaw) && ceilingRaw > 0
    ? ceilingRaw
    : null;

  return { killSwitch, globalDailyCeiling };
}

/** Retention for daily counters (48h, covers timezone boundaries). */
const DAILY_COUNTER_TTL_SECONDS = 172800;

/**
 * Serialized counter backend contract (hard limit).
 *
 * `incr(key)` must return the post-increment count for `key` and MUST be
 * serialized across concurrent requests. A Cloudflare Durable Object keyed
 * by the counter key gives this (a single DO instance serializes its I/O).
 * KV get/put does NOT give this — that is the legacy path below.
 *
 * @typedef {{ incr(key: string): Promise<number> }} QuotaCounterBackend
 */

/**
 * Serialized/atomic daily counter: the hard-limit path.
 *
 * Unlike the legacy KV read/put flow, increments cannot observably race:
 * concurrent calls on the same key receive distinct post-increment counts
 * (1, 2, 3, …) exactly once each, so `dailyLimit` is truly enforced.
 *
 * Throws when the backend is unusable — the router turns that into the
 * bounded fail-closed `quota_unavailable` response (a model call is never
 * served without a consumed, counted unit).
 *
 * @param {QuotaCounterBackend} backend Serialized counter backend.
 * @param {string} key Daily counter key (`getQuotaKeyV2`/`getGlobalQuotaKey`).
 * @param {number} dailyLimit
 * @returns {Promise<{ allowed: boolean, remaining: number }>}
 */
export async function checkAndConsumeQuotaAtomic(
  backend,
  key,
  dailyLimit,
) {
  if (!backend || typeof backend.incr !== "function") {
    throw new Error("Serialized quota counter unavailable");
  }

  const count = await backend.incr(key);

  if (count > dailyLimit) {
    return { allowed: false, remaining: 0 };
  }

  return { allowed: true, remaining: Math.max(0, dailyLimit - count) };
}

/**
 * Legacy non-serialized counter over read/put stores (KV). BEST EFFORT ONLY:
 * two concurrent requests can both read the same count and both consume one
 * unit beyond the limit. Honest documentation (and a pinned race test) — do
 * not treat this as a hard limit; bind `env.QUOTA_COUNTER` (a serialized
 * backend) for that, and keep the edge/WAF limits as the real backstop.
 *
 * Throws when the store is unusable (fail closed, see security model).
 *
 * @param {{ get(key: string): Promise<string | null>, put(key: string, val: string, opts?: { expirationTtl?: number }): Promise<void> }} kv
 * @param {string} key Daily counter key.
 * @param {number} dailyLimit
 * @returns {Promise<{ allowed: boolean, remaining: number }>}
 */
export async function checkAndConsumeQuotaLegacyCounter(kv, key, dailyLimit) {
  if (!kv || typeof kv.get !== "function" || typeof kv.put !== "function") {
    throw new Error("Quota store unavailable");
  }

  const raw = await kv.get(key);
  const currentCount = raw ? parseInt(raw, 10) || 0 : 0;

  if (currentCount >= dailyLimit) {
    return { allowed: false, remaining: 0 };
  }

  const newCount = currentCount + 1;
  await kv.put(key, String(newCount), {
    expirationTtl: DAILY_COUNTER_TTL_SECONDS,
  });

  return {
    allowed: true,
    remaining: Math.max(0, dailyLimit - newCount),
  };
}

/**
 * Checks and consumes 1 unit of daily quota for a derived namespace on the
 * available counter. Routes to the serialized atomic backend when one is
 * bound (hard limit), otherwise to the legacy KV read/put counter (best
 * effort; see the test pinning its race).
 *
 * Throws when neither path is usable; the router turns that into the bounded
 * 503 `quota_unavailable` response (fail closed — a model call is never
 * served without a consumed quota unit).
 *
 * @param {{ get(key: string): Promise<string | null>, put(key: string, val: string, opts?: { expirationTtl?: number }): Promise<void> } | null | undefined} kv
 * @param {QuotaCounterBackend | null | undefined} counter
 * @param {string} counterKey Daily counter key for the identity.
 * @param {number} [dailyLimit=200]
 * @returns {Promise<{ allowed: boolean, remaining: number }>}
 */
export async function consumeQuotaForCounterKey(
  kv,
  counter,
  counterKey,
  dailyLimit = 200,
) {
  if (counter) {
    return await checkAndConsumeQuotaAtomic(counter, counterKey, dailyLimit);
  }
  return await checkAndConsumeQuotaLegacyCounter(kv, counterKey, dailyLimit);
}

/**
 * Checks and consumes 1 unit of quota for a legacy raw install token.
 * Kept for the no-secret migration path and existing callers/tests.
 * See `checkAndConsumeQuotaLegacyCounter` for the concurrency caveat.
 *
 * @param {Parameters<typeof checkAndConsumeQuotaLegacyCounter>[0]} kv
 * @param {string} installToken
 * @param {number} [dailyLimit=200]
 * @param {Date | string} [date]
 * @returns {Promise<{ allowed: boolean, remaining: number }>}
 */
export async function checkAndConsumeQuota(
  kv,
  installToken,
  dailyLimit = 200,
  date = new Date(),
) {
  return await checkAndConsumeQuotaLegacyCounter(
    kv,
    getQuotaKey(installToken, date),
    dailyLimit,
  );
}
