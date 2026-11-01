// Worker entry point and fetch router.
//
// Routes GET /config, POST /analyze (cache → quota → model), and OPTIONS for CORS.
//
// SECURITY MODEL (public, binding policy — see quota.js for the full text):
// - The hosted Worker is a PUBLIC SERVICE. CORS, install tokens and install
//   signatures are not authentication; curl/scripts/direct HTTP get the exact
//   same contract as the extension.
// - `X-Install-Token` is a forgeable quota identifier (quota accounting and
//   abuse resistance only). POST /analyze requires one: there is no
//   "anonymous" model-call bucket (fail closed, bounded error
//   `install_token_required`).
// - `X-Install-Signature` is RESERVED for a future server-issued credential
//   flow and is neither checked nor required today.
// - When quota protection is unavailable the request fails CLOSED with the
//   bounded error `quota_unavailable` (503, Retry-After). Cached responses
//   are still served; a model call is never served without a consumed quota
//   unit.
//
// Public /analyze error contract: `install_token_required` (400),
// `quota_unavailable` (503, Retry-After: 60), plus `{ state: "quota" }` (429)
// for an exhausted identifier.

import { buildConfig, FEATURE_VERSION, MODEL_VERSION } from "./config.js";
import { analyze } from "./analyze.js";
import {
  buildCacheKey,
  getCachedAnalysis,
  setCachedAnalysis,
} from "./cache.js";
import {
  ANALYZE_ERRORS,
  checkAndConsumeQuota,
  extractQuotaIdentity,
} from "./quota.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  // X-Install-Signature stays reserved for a future server-issued credential
  // flow; it is not checked or required anywhere in this deployment.
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Install-Token, X-Install-Signature",
  "Access-Control-Expose-Headers": "x-quota-remaining",
};

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

      // 1. Parse the documented body ({ state, installToken }). Validation
      // precedes any cache, quota or model work.
      let body;
      try {
        body = await request.json();
      } catch (_err) {
        return new Response(
          JSON.stringify({ error: "Malformed JSON body" }),
          {
            status: 400,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "application/json",
            },
          },
        );
      }

      const handle = body?.state?.handle;
      if (typeof handle !== "string" || handle.length === 0) {
        return new Response(
          JSON.stringify({ error: "Missing or invalid state.handle" }),
          {
            status: 400,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "application/json",
            },
          },
        );
      }

      const kv = /** @type {any} */ (env?.CACHE_KV);

      // 2. Quota identity. NOT authentication: the install token is a
      // forgeable, self-generated client identifier used for quota accounting
      // and abuse resistance only (see quota.js security model). There is no
      // anonymous model-call bucket: a request without a bounded identity is
      // rejected with the documented 400 before any cache/quota/model work.
      // X-Install-Signature, when present, is ignored (reserved for a future
      // server-issued credential flow).
      const installToken = extractQuotaIdentity(request, body);
      if (!installToken) {
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

      const cacheKey = await buildCacheKey(handle, mv, fv);

      // 3. Cache check (D7: cache before quota)
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

      // 4. Quota check (only consumed on model-call miss). Fail closed: with
      // no CACHE_KV binding or a failing store, the model call is refused
      // with the bounded 503; quota protection is never bypassed.
      let quota;
      if (!kv) {
        return new Response(
          JSON.stringify({ error: "quota_unavailable" }),
          {
            status: ANALYZE_ERRORS.quota_unavailable.status,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "application/json",
              "Retry-After": "60",
            },
          },
        );
      }
      try {
        quota = await checkAndConsumeQuota(kv, installToken, 200);
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
      } catch (_err) {
        // Quota store failure -> fail closed, bounded documented error.
        return new Response(
          JSON.stringify({ error: "quota_unavailable" }),
          {
            status: ANALYZE_ERRORS.quota_unavailable.status,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "application/json",
              "Retry-After": "60",
            },
          },
        );
      }

      // 5. Model call
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
      if (modelRes.status !== 200) {
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

      return modelRes;
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
