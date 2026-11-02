// Worker entry point and fetch router.
//
// Routes GET /config, POST /analyze (input gate → cache → quota → ceiling →
// model), and OPTIONS for CORS.
//
// SECURITY MODEL (public, binding policy — see quota.js for the full text):
// - The hosted Worker is a PUBLIC SERVICE. CORS, quota identities and derived
//   namespaces are not authentication; curl/scripts/direct HTTP get the exact
//   same contract as the extension. Any caller can forge any public identity
//   (and shares/drifts into the claimed bucket when it does) — per-identity
//   quota is abuse resistance, not a wall.
// - Quota identity precedence: `X-Quota-Identity` (pseudonymous X viewer ID,
//   re-validated here) → documented `X-Install-Token` header → body
//   `installToken`. When `INSTALL_TOKEN_SECRET` is configured, BOTH kinds
//   are HMAC-derived inside the Worker before any storage: quota keys are
//   `quota:v2:{hmacDigest}:{YYYY-MM-DD}` and raw X account IDs never touch
//   stored quota keys (KV or Durable Object). The secret authenticates
//   nothing; it only makes stored identifiers non-reversible and namespace
//   derivability a server-side property.
// - Enabling `INSTALL_TOKEN_SECRET` does not reject anything: without a
//   valid `X-Quota-Identity` the request keeps the install-token bucket. A
//   request carrying `X-Quota-Identity` while the secret is MISSING fails
//   CLOSED with the bounded `quota_unavailable` error instead of silently
//   downgrading to a weaker identity while pretending it is fine.
// - `X-Install-Signature` is RESERVED for a future server-issued credential
//   flow and is neither checked nor required today.
// - Cost controls (this repo implements the contracts; ordering below):
//   per-identity daily quota, an optional global daily model-call ceiling
//   (`GLOBAL_DAILY_MODEL_CEILING`) and an emergency kill switch
//   (`QUOTA_KILL_SWITCH`) that disables model MISSES while cached responses
//   stay available. Independent per-IP and additional global request-rate
//   limits belong to the Cloudflare edge/WAF configuration — they are NOT
//   implemented in this repository and no comment or test here proves
//   production enforcement; that verification is a deployment step.
// - When quota protection is unavailable the request fails CLOSED with a
//   bounded error (`quota_unavailable` / `model_calls_paused`, 503,
//   Retry-After). Cached responses are still served; a model call is never
//   served without a consumed quota unit.
//
// Public /analyze error contract: `invalid_request` (400, Task-4 input gate
// — opaque code for every body shape/allowlist/bound violation),
// `install_token_required` (400), `model_calls_paused` (503, Retry-After:
// 60), `quota_unavailable` (503, Retry-After: 60), plus `{ state: "quota" }`
// (429) for an exhausted identifier.

import { buildConfig, FEATURE_VERSION, MODEL_VERSION } from "./config.js";
import { analyze, MAX_BODY_BYTES, validateAnalyzeBody } from "./analyze.js";
import {
  buildCacheKey,
  getCachedAnalysis,
  setCachedAnalysis,
} from "./cache.js";
import {
  ANALYZE_ERRORS,
  consumeQuotaForCounterKey,
  deriveQuotaNamespace,
  extractQuotaIdentity,
  getGlobalQuotaKey,
  getQuotaKey,
  getQuotaKeyV2,
  parseQuotaControls,
} from "./quota.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  // X-Install-Signature stays reserved for a future server-issued credential
  // flow; it is not checked or required anywhere in this deployment.
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Install-Token, X-Install-Signature, X-Quota-Identity",
  "Access-Control-Expose-Headers": "x-quota-remaining",
};

const DAILY_QUOTA_LIMIT = 200;

/**
 * Builds the daily counter key for a quota identity, HMAC-derived inside the
 * Worker before any storage (ruling: never persist raw X IDs in quota keys).
 *
 * - `x-account` identities REQUIRE the configured server secret: without it
 *   no stable non-reversible namespace exists (an unsecreted digest of an
 *   enumerable numeric ID space would be brute-forceable back to X IDs), so
 *   this honestly throws and the router fails closed with the bounded
 *   `quota_unavailable` degradation — no silent weaker-identity downgrade.
 * - `install` identities derive under the "install:" domain when the secret
 *   is configured. Without a secret they keep the documented TEMPORARY
 *   legacy raw key (`quota:{token}:{ymd}`) until the operator enables
 *   `INSTALL_TOKEN_SECRET` (rollout per the X-account quota plan).
 *
 * Domain separation ("x-account:"/"install:" prefixes) keeps equal material
 * under different kinds from ever colliding into one bucket.
 *
 * @param {{ kind: "x-account" | "install", value: string }} quotaIdentity
 *   Validated quota identity from `extractQuotaIdentity`.
 * @param {string | null} secret Server-side `INSTALL_TOKEN_SECRET` (never
 *   shipped to clients), or null when unconfigured.
 * @returns {Promise<string>}
 */
async function buildQuotaCounterKey(quotaIdentity, secret) {
  if (quotaIdentity.kind === "x-account") {
    if (!secret) {
      throw new Error("Server secret required for x-account namespace");
    }
    return await getQuotaKeyV2(
      await deriveQuotaNamespace(`x-account:${quotaIdentity.value}`, secret),
    );
  }

  if (secret) {
    return await getQuotaKeyV2(
      await deriveQuotaNamespace(`install:${quotaIdentity.value}`, secret),
    );
  }
  return getQuotaKey(quotaIdentity.value);
}

/**
 * A brief 503 response carrying Retry-After: 60, for the bounded global
 * model-call refusals (`model_calls_paused`: operator pause / global daily
 * ceiling exhausted) and bounded quota-store failures (`quota_unavailable`).
 *
 * @param {"model_calls_paused" | "quota_unavailable"} code Bounded 503 code.
 * @returns {Response}
 */
function bounded503(code) {
  const err = ANALYZE_ERRORS[code];
  return new Response(JSON.stringify({ error: code }), {
    status: err.status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Retry-After": "60",
    },
  });
}

/**
 * The bounded Task-4 rejection: every input-gate failure (byte size, JSON
 * shape, nesting depth, key allowlists, handle format, field bounds) returns
 * this same opaque 400 so the public endpoint never leaks a distinguishable
 * reason oracle. Bounded code only; the request body is never echoed or
 * logged.
 *
 * @returns {Response}
 */
function invalidRequest() {
  return new Response(JSON.stringify({ error: "invalid_request" }), {
    status: 400,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    },
  });
}

/**
 * Resolves the serialized quota counter binding, if the deployment binds one
 * (`env.QUOTA_COUNTER`, e.g. a Durable Object stub). A binding that is present
 * but does not satisfy the increment contract is a configuration error:
 * quota protection must fail closed, not degrade silently to the non-atomic
 * legacy counter.
 *
 * @param {Record<string, unknown> | null | undefined} env
 * @returns {{ incr(key: string): Promise<number> } | null} Serialized
 *   backend satisfying the counter contract, or null when unbound.
 */
function resolveQuotaCounter(env) {
  const binding = /** @type {unknown} */ (
    env && typeof env === "object"
      ? /** @type {Record<string, unknown>} */ (env).QUOTA_COUNTER
      : undefined
  );
  if (binding === undefined || binding === null) {
    return null;
  }
  const counter = /** @type {{ incr?: unknown }} */ (binding);
  if (typeof counter.incr !== "function") {
    throw new Error("QUOTA_COUNTER binding does not satisfy the contract");
  }
  return /** @type {{ incr(key: string): Promise<number> }} */ (counter);
}

export default {
  /**
   * Cloudflare Worker fetch event handler.
   *
   * @param {Request} request
   * @param {Record<string, unknown>} env
   * @param {unknown} [_ctx]
   * @param {typeof fetch} [fetchImpl]
   * @returns {Promise<Response>}
   */
  async fetch(request, env, _ctx, fetchImpl = globalThis.fetch) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    if (url.pathname === "/config") {
      if (request.method !== "GET") {
        return new Response(
          JSON.stringify({ error: "Method Not Allowed" }),
          {
            status: 405,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "application/json",
              "Allow": "GET",
            },
          },
        );
      }

      const config = buildConfig(env);
      return new Response(JSON.stringify(config), {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json",
        },
      });
    }

    if (url.pathname === "/analyze") {
      if (request.method !== "POST") {
        return new Response(
          JSON.stringify({ error: "Method Not Allowed" }),
          {
            status: 405,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "application/json",
              "Allow": "POST",
            },
          },
        );
      }

      // 1. Parse the documented body ({ state, installToken }). The Task-4
      // input gate precedes any cache, quota or model work: byte bound
      // checked BEFORE JSON parsing (read as text, count, then parse), then
      // strict allowlists (body/state/feature keys), depth <= 4 and per-field
      // bounds in analyze.js's gate. Every violation is the same bounded
      // `invalid_request` 400.
      let raw;
      let body;
      try {
        raw = await request.text();
      } catch (_readErr) {
        return invalidRequest();
      }
      if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
        return invalidRequest();
      }
      try {
        body = JSON.parse(raw);
      } catch (_parseErr) {
        return invalidRequest();
      }

      // Canonical, normalized state from the single validation point — the
      // same object the cache key below and the model payload (via analyze())
      // are built from.
      const validated = validateAnalyzeBody(body);
      if (!validated.ok) {
        return invalidRequest();
      }

      const kv = /** @type {any} */ (env?.CACHE_KV);

      // 2. Quota identity. NOT authentication: install tokens are self-
      // generated and X viewer IDs are page-read candidates, so every value
      // is forgeable by design (see quota.js security model). Precedence and
      // validation: `X-Quota-Identity` (numeric X viewer ID) →
      // `X-Install-Token` → body `installToken`; a malformed X candidate
      // falls back to the install-token bucket instead of failing the
      // request. No anonymous model-call bucket: a request without a bounded
      // identity is rejected with the documented 400 before any
      // cache/quota/model work. X-Install-Signature, when present, is
      // ignored (reserved for a future server-issued credential flow).
      const quotaIdentity = extractQuotaIdentity(request, body);
      if (!quotaIdentity) {
        const err = ANALYZE_ERRORS.install_token_required;
        return new Response(
          JSON.stringify({ error: "install_token_required" }),
          {
            status: err.status,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "application/json",
            },
          },
        );
      }

      const mv = typeof env?.MODEL_VERSION === "string"
        ? env.MODEL_VERSION
        : MODEL_VERSION;
      const fv = typeof env?.FEATURE_VERSION === "string"
        ? env.FEATURE_VERSION
        : FEATURE_VERSION;

      // Cache key covers the CANONICAL MODEL STATE (normalized handle,
      // features, truncated reply sample) plus versions — never the handle
      // alone: one caller priming a shared entry for a handle can only have
      // it served to requests carrying the same canonical state (Task 4).
      const cacheKey = await buildCacheKey(validated.state, mv, fv);

      // 3. Cache check (D7: cache before quota). Cached responses keep
      // working even while the operator pause is engaged (step 4 below).
      const cached = await getCachedAnalysis(kv, cacheKey);
      if (cached) {
        return new Response(JSON.stringify(cached), {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json",
          },
        });
      }

      // 4. Operator pause (after cache so cached responses keep working;
      // before quota so no unit is consumed while paused). Global and
      // server-side: a forgeable quota identity cannot bypass it. Honest
      // scope note: only model misses seen HERE are stopped here; WAF /
      // platform-level spend brakes live in Cloudflare configuration and
      // their enforcement is verified there, not by this code.
      if (parseQuotaControls(env).killSwitch) {
        return bounded503("model_calls_paused");
      }

      if (!kv) {
        // CACHE_KV is still required in this deployment: the cache-first
        // design (D7) and the legacy quota counter live there. Fail closed —
        // a model call is never served without quota protection.
        return bounded503("quota_unavailable");
      }

      // 5. Quota protection, all before any model work. Fail closed: any
      // unusable counter piece (missing secret for an x-account identity,
      // unusable store/atomic backend, broken QUOTA_COUNTER binding) turns
      // into the bounded 503 below; quota protection is never bypassed.
      // Concurrency: with `env.QUOTA_COUNTER` (Durable Object–backed
      // binding) this consumes through the serialized hard-limit contract;
      // without it, the legacy KV read/put counter is best effort (see
      // quota.js for the pinned non-atomic race — not a hard limit).
      const secret = typeof env?.INSTALL_TOKEN_SECRET === "string" &&
          env.INSTALL_TOKEN_SECRET.length > 0
        ? env.INSTALL_TOKEN_SECRET
        : null;

      let quota;
      try {
        const counter = resolveQuotaCounter(env);
        const counterKey = await buildQuotaCounterKey(quotaIdentity, secret);

        quota = await consumeQuotaForCounterKey(
          kv,
          counter,
          counterKey,
          DAILY_QUOTA_LIMIT,
        );
        if (!quota.allowed) {
          return new Response(
            JSON.stringify({ state: "quota" }),
            {
              status: 429,
              headers: {
                ...CORS_HEADERS,
                "Content-Type": "application/json",
                "x-quota-remaining": "0",
              },
            },
          );
        }

        // 6. Global daily model-call ceiling (optional). Consumed only on
        // model-bound misses (cached responses never touch it), across all
        // identities and forgeable buckets: the operator's last in-repo cost
        // brake for runaway spend. Exhaustion shares the bounded
        // `model_calls_paused` response with the kill switch.
        const globalDailyCeiling = parseQuotaControls(env).globalDailyCeiling;
        if (globalDailyCeiling !== null) {
          const ceiling = await consumeQuotaForCounterKey(
            kv,
            counter,
            getGlobalQuotaKey(),
            globalDailyCeiling,
          );
          if (!ceiling.allowed) {
            // Honest note: the identity unit consumed above is not refunded
            // when the global ceiling refuses — a global refusal pauses the
            // whole service, and a refund would require an atomic decrement
            // contract for no abuse-reduction gain.
            return bounded503("model_calls_paused");
          }
        }
      } catch (_err) {
        // Quota protection failure (store, backend, binding, secret-required
        // identity derivation) -> fail closed, bounded documented error.
        return bounded503("quota_unavailable");
      }

      // 7. Model call (outside the quota try/catch: analyze() returns
      // bounded error Responses for its own failures and must not be
      // misreported as a quota problem). analyze() re-runs the same input
      // gate and builds its payload from the canonical state, so the model
      // input always matches the cache key built above.
      const modelRes = await analyze(body, env, fetchImpl);
      if (modelRes.status === 200) {
        const data = await modelRes.json();
        // Store in shared KV cache (48 hours)
        await setCachedAnalysis(kv, cacheKey, data, 48);

        const headers = {
          ...CORS_HEADERS,
          "Content-Type": "application/json",
        };
        if (quota) {
          headers["x-quota-remaining"] = String(quota.remaining);
        }

        return new Response(JSON.stringify(data), {
          status: 200,
          headers,
        });
      }

      // Model 4xx/5xx bodies must be readable by the browser too: analyze()
      // builds its error Responses without CORS headers, so re-wrap them with
      // the same headers the 200 path gets. Otherwise the client sees only a
      // CORS block instead of e.g. "ai_unavailable".
      const text = await modelRes.text();
      const headers = {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
      };
      if (quota) {
        headers["x-quota-remaining"] = String(quota.remaining);
      }
      return new Response(text, {
        status: modelRes.status,
        statusText: modelRes.statusText,
        headers,
      });
    }

    return new Response(
      JSON.stringify({ error: "Not Found" }),
      {
        status: 404,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json",
        },
      },
    );
  },
};
