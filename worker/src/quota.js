// Worker per-install daily quota tracking and install token verification.

/**
 * Constant-time string equality check to avoid timing attacks on signatures.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

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
 * Signs an install token with HMAC-SHA256 for a given date.
 *
 * @param {string} installToken
 * @param {string} secret
 * @param {string} [dateStr]
 * @returns {Promise<string>}
 */
export async function signInstallToken(
  installToken,
  secret,
  dateStr = new Date().toISOString().slice(0, 10),
) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = enc.encode(`${installToken}.${dateStr}`);
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, data);
  const sigArray = Array.from(new Uint8Array(signatureBuffer));
  return sigArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verifies the install token and optional HMAC signature from the incoming request.
 *
 * @param {Request} request
 * @param {Record<string, unknown>} env
 * @param {string} [overrideDateStr]
 * @returns {Promise<boolean>}
 */
export async function verifyInstallToken(request, env, overrideDateStr) {
  const token = request.headers.get("X-Install-Token");
  if (!token || typeof token !== "string" || token.length === 0) {
    return false;
  }

  const secret = typeof env?.INSTALL_TOKEN_SECRET === "string" &&
      env.INSTALL_TOKEN_SECRET.length > 0
    ? env.INSTALL_TOKEN_SECRET
    : null;

  // If no secret configured in Worker environment, installToken is accepted
  if (!secret) {
    return true;
  }

  const signature = request.headers.get("X-Install-Signature");
  if (!signature) {
    return false;
  }

  const dateStr = overrideDateStr || new Date().toISOString().slice(0, 10);
  const expectedToday = await signInstallToken(token, secret, dateStr);

  return timingSafeEqual(signature, expectedToday);
}

/**
 * Checks and consumes 1 unit of quota for the given install token.
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
  if (!kv || typeof kv.get !== "function") {
    // If KV is unavailable, fail degraded (never fail open)
    throw new Error("KV store unavailable");
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
