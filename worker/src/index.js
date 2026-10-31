// Worker entry point and fetch router.
//
// Routes GET /config, POST /analyze (cache → quota → model), and OPTIONS for CORS.

import { buildConfig, FEATURE_VERSION, MODEL_VERSION } from "./config.js";
import { analyze } from "./analyze.js";
import {
  buildCacheKey,
  getCachedAnalysis,
  setCachedAnalysis,
} from "./cache.js";
import { checkAndConsumeQuota, verifyInstallToken } from "./quota.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

      // 1. Verify token / signature
      const isTokenValid = await verifyInstallToken(request, env);
      if (!isTokenValid) {
        return new Response(
          JSON.stringify({ error: "Unauthorized: invalid install token" }),
          {
            status: 401,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "application/json",
            },
          },
        );
      }

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

      const mv = typeof env?.MODEL_VERSION === "string"
        ? env.MODEL_VERSION
        : MODEL_VERSION;
      const fv = typeof env?.FEATURE_VERSION === "string"
        ? env.FEATURE_VERSION
        : FEATURE_VERSION;

      const cacheKey = await buildCacheKey(handle, mv, fv);
      const kv = /** @type {any} */ (env?.CACHE_KV);

      // 2. Cache check (D7: cache before quota)
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

      // 3. Quota check (only consumed on model-call miss)
      const installToken = request.headers.get("X-Install-Token") ||
        body.installToken || "anonymous";

      let quota;
      if (kv) {
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
          // Quota KV failure -> 503 degraded
          return new Response(
            JSON.stringify({ error: "Quota store temporarily unavailable" }),
            {
              status: 503,
              headers: {
                ...CORS_HEADERS,
                "Content-Type": "application/json",
                "Retry-After": "60",
              },
            },
          );
        }
      }

      // 4. Model call
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
