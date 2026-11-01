// Worker quota accounting for the hosted /analyze endpoint.
//
// SECURITY MODEL (public, binding policy — do not weaken):
//
// - `X-Install-Token` is a FORGEABLE, self-generated client identifier. It
//   supports quota accounting and abuse resistance only. It is NOT
//   authentication: it proves nothing about who is calling, and any direct
//   HTTP client (curl, script, other browser) can send any token it likes.
//   Per-identifier quota is therefore an inconvenience, not a wall; edge /
//   global rate limits and cost ceilings (Task 3) complete the protection.
// - `X-Install-Signature` is RESERVED for a future server-issued credential
//   flow (see plan §"Future Strong Authentication Option"). This deployment
//   does not check, require, or honor it. There is intentionally no client
//   HMAC path today: the extension cannot safely hold a shared secret, and
//   enabling `INSTALL_TOKEN_SECRET` as live authentication would reject every
//   legitimate proxy request while adding no real security.
// - `INSTALL_TOKEN_SECRET` must not be treated as authenticating the public
//   extension. Future server-side uses (HMAC-derived quota namespaces) must
//   derive identity inside the Worker and never hand the secret to clients.
// - Quota protection must fail CLOSED: when the quota store is unavailable,
//   /analyze returns the bounded `quota_unavailable` error and never serves
//   an anonymous model call.

/** Maximum accepted length of a quota identifier (bounds KV key size). */
export const MAX_QUOTA_IDENTITY_LENGTH = 128;

/**
 * Aggregates every documented bounded /analyze error into one contract so
 * callers (extension and self-hosters) see a single source of truth. Response
 * bodies carry the machine-readable code only; the human explanation lives in
 * the comments where each response is constructed.
 */
export const ANALYZE_ERRORS = {
  install_token_required: { status: 400 },
  quota_unavailable: { status: 503 },
};

/**
 * Derives the daily quota key for an install token: quota:{installToken}:{YYYY-MM-DD}.
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
 * Extracts and validates the quota identifier for a request.
 *
 * This is NOT authentication (see the security model comment at the top of
 * this file). It reads the `X-Install-Token` header, falling back to the
 * documented `installToken` body field, and rejects values that are missing,
 * empty, oversized, or contain whitespace/control characters (KV key hygiene).
 *
 * A configured `INSTALL_TOKEN_SECRET` is deliberately ignored here: the
 * extension sends no signature, and the identifier is forgeable by design.
 *
 * @param {Request} request
 * @param {unknown} [body] Parsed JSON body (may be unavailable).
 * @returns {string | null} Bounded quota identifier, or null when absent/invalid.
 */
export function extractQuotaIdentity(request, body) {
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

  return candidate;
}

/**
 * Checks and consumes 1 unit of quota for the given install token.
 *
 * Throws when the quota store is unusable; the router turns that into the
 * bounded 503 `quota_unavailable` response (fail closed — a model call is
 * never served without a consumed quota unit).
 *
 * @param {{ get(key: string): Promise<string | null>, put(key: string, val: string, opts?: { expirationTtl?: number }): Promise<void> }} kv
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
  if (!kv || typeof kv.get !== "function" || typeof kv.put !== "function") {
    // Quota protection unavailable -> the model call must not happen.
    throw new Error("Quota store unavailable");
  }

  const key = getQuotaKey(installToken, date);
  const raw = await kv.get(key);
  const currentCount = raw ? parseInt(raw, 10) || 0 : 0;

  if (currentCount >= dailyLimit) {
    return { allowed: false, remaining: 0 };
  }

  const newCount = currentCount + 1;
  // Retain for 48h (172800s) to cover timezone boundaries
  await kv.put(key, String(newCount), { expirationTtl: 172800 });

  return {
    allowed: true,
    remaining: Math.max(0, dailyLimit - newCount),
  };
}
