// Worker AI analysis implementation.
//
// Routes analysis through Clef 27B primary with Jev fallback.
//
// INPUT GATE (Task 4): the request body is caller-supplied and the model is a
// paid, shared resource, so every body is validated and CANONICALIZED before
// it can reach either the cache key or the model:
// - strict allowlists (body ⊆ {state, installToken}; state ⊆ {handle,
//   features, replySample}; features ⊆ the canonical feature keys) — unknown
//   fields at any level are refused;
// - byte/depth/array/text bounds (MAX_* constants below) plus per-field
//   numeric-range checks; NaN/Infinity and numeric strings are rejected
//   everywhere;
// - the handle is validated against the shared bounded HANDLE_RE and
//   lower-cased exactly once (canonicalModelState), and the canonical state
//   is the ONE normalization point: both the cache key and the model payload
//   are built from it, so a caller can never prime a shared cache entry for
//   a handle with state another caller did not submit.
//
// Every gate failure is the same bounded `invalid_request` 400 — no prose
// messages and no distinguishable rejection oracle. Request bodies, parsed
// states, reply samples and tokens are never logged; operational logging is
// limited to status codes and a short truncated upstream-response snippet.

import { HANDLE_RE } from "../../src/shared/security.js";

import { buildQuestionSet } from "./questions.js";

const DEFAULT_TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

// ---- Input gate (Task 4) ----
// Canonical feature keys, taken from the Worker-side feature vector shape
// (src/analysis/features.js). The allowlist AND the canonical key order both
// derive from this single list, so a reordering in features.js is a deliberate
// two-place change.

export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_BODY_DEPTH = 4;
export const MAX_REPLY_SAMPLE_ITEMS = 12;
export const MAX_REPLY_SNIPPET_CHARS = 400;

export const FEATURE_KEYS = [
  "replyCount",
  "distinctTargets",
  "targetConcentration",
  "repeatParentRatio",
  "capsRatio",
  "exclamationRatio",
  "rhetoricalQuestionRatio",
  "hashtagDensity",
  "lexiconHits",
  "likesPerReply",
  "burstRatio",
  "langSupported",
];

const BODY_KEYS = new Set(["state", "installToken"]);
const STATE_KEYS = new Set(["handle", "features", "replySample"]);
const FEATURE_KEYS_SET = new Set(FEATURE_KEYS);

const RATIO_KEYS = new Set([
  "targetConcentration",
  "repeatParentRatio",
  "capsRatio",
  "exclamationRatio",
  "rhetoricalQuestionRatio",
  "hashtagDensity",
  "burstRatio",
]);

const COUNT_CEILING = 100000;
const LIKE_RATE_CEILING = 1000000;
const REPLY_COUNT_CEILING = 1000;

/** Plain (non-null, non-array) object check. */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when every key of `value` is in the `allowed` set. */
function keysAllowed(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

/**
 * Walks the JSON-shaped value bounded: each object/array level costs one
 * depth step and every scalar contributes its own level (`body` itself is
 * depth 1, `body.state` 2, `state.features` 3, feature values 4). Returns
 * true as soon as any level exceeds `limit`, so the walk never recurses
 * deeper than one step past the cap. Comparison happens inside the walk —
 * no full unbounded pass first.
 */
function exceedsMaxDepth(value, depth) {
  if (depth > MAX_BODY_DEPTH) return true;
  if (value === null || typeof value !== "object") return false;
  for (const child of Object.values(value)) {
    if (exceedsMaxDepth(child, depth + 1)) return true;
  }
  return false;
}

/**
 * Per-key feature validation. typeof checks reject numeric strings and
 * booleans; Number.isFinite rejects NaN and ±Infinity in one shot.
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {boolean}
 */
function validFeatureValue(key, value) {
  if (key === "langSupported") {
    return typeof value === "boolean";
  }
  if (key === "lexiconHits") {
    return value === null ||
      (typeof value === "number" && Number.isFinite(value) &&
        value >= 0 && value <= COUNT_CEILING);
  }
  if (key === "likesPerReply") {
    return typeof value === "number" && Number.isFinite(value) &&
      value >= 0 && value <= LIKE_RATE_CEILING;
  }
  if (key === "replyCount") {
    return Number.isInteger(value) && value >= 0 &&
      value <= REPLY_COUNT_CEILING;
  }
  if (RATIO_KEYS.has(key)) {
    return typeof value === "number" && Number.isFinite(value) &&
      value >= 0 && value <= 1;
  }
  // Remaining count-valued keys (distinctTargets).
  return typeof value === "number" && Number.isInteger(value) &&
    value >= 0 && value <= COUNT_CEILING;
}

/**
 * Canonicalizes a VALIDATED state into the exact shape fed to the model:
 * handle lower-cased, features rebuilt in canonical key order, reply sample
 * truncated to the same 12 x 400 caps `buildQuestionSet` applies. This is
 * the ONE normalization point for the model input — the cache key is built
 * from the same object, so the key always equals the real model input.
 *
 * @param {{ handle: string, features: Record<string, unknown>, replySample?: unknown }} state
 * @returns {{ handle: string, features: Record<string, unknown>, replySample: string[] }}
 */
export function canonicalModelState(state) {
  const features = {};
  for (const key of FEATURE_KEYS) {
    if (key in state.features) features[key] = state.features[key];
  }
  const rawSample = Array.isArray(state.replySample) ? state.replySample : [];
  const replySample = rawSample.slice(0, MAX_REPLY_SAMPLE_ITEMS).map((item) =>
    typeof item === "string" ? item.slice(0, MAX_REPLY_SNIPPET_CHARS) : ""
  );
  return {
    handle: state.handle.toLowerCase(),
    features,
    replySample,
  };
}

/**
 * Validates the raw parsed body against the strict input gate and returns
 * either `{ ok: true, state }` with the CANONICAL state (the same object the
 * cache key and the model payload are built from), or `{ ok: false }`. Pure:
 * called from index.js before any cache/quota/model work and again inside
 * analyze() (idempotent, single normalization source).
 *
 * @param {unknown} body
 * @returns {{ ok: true, state: { handle: string, features: Record<string, unknown>, replySample: string[] } } | { ok: false }}
 */
export function validateAnalyzeBody(body) {
  if (!isPlainObject(body) || !keysAllowed(body, BODY_KEYS)) {
    return { ok: false };
  }
  if (exceedsMaxDepth(body, 1)) {
    return { ok: false };
  }

  const state = body.state;
  if (
    !isPlainObject(state) || !keysAllowed(state, STATE_KEYS)
  ) {
    return { ok: false };
  }

  // Shared bounded handle format; normalized exactly once in
  // canonicalModelState below.
  if (typeof state.handle !== "string" || !HANDLE_RE.test(state.handle)) {
    return { ok: false };
  }

  if (!isPlainObject(state.features)) {
    return { ok: false };
  }
  // The allowlist implies the key-count ceiling: only feature keys may exist.
  if (!keysAllowed(state.features, FEATURE_KEYS_SET)) {
    return { ok: false };
  }
  for (const [key, value] of Object.entries(state.features)) {
    if (!validFeatureValue(key, value)) {
      return { ok: false };
    }
  }

  if (state.replySample !== undefined) {
    if (!Array.isArray(state.replySample)) {
      return { ok: false };
    }
    if (state.replySample.length > MAX_REPLY_SAMPLE_ITEMS) {
      return { ok: false };
    }
    for (const item of state.replySample) {
      if (
        typeof item !== "string" || item.length > MAX_REPLY_SNIPPET_CHARS
      ) {
        return { ok: false };
      }
    }
  }

  return { ok: true, state: canonicalModelState(state) };
}

/**
 * The bounded, opaque rejection shared by every input-gate failure. NOTE: no
 * CORS headers on purpose — index.js re-wraps model-side 4xx/5xx Responses
 * with CORS_HEADERS (see the /analyze error re-wrap there), so CORS is added
 * there; a future direct serve of this response must not drop those headers.
 */
export function invalidRequestResponse() {
  return new Response(JSON.stringify({ error: "invalid_request" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Call the Clef 27B model via TypeSafe-compatible endpoint.
 *
 * @param {object} payload
 * @param {Record<string, unknown>} env
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{ answers: Record<string, unknown>, model: string } | null>}
 */
export async function callClef(payload, env, fetchImpl) {
  const apiToken = (typeof env?.CLOUDFLARE_API_TOKEN === "string" &&
    env.CLOUDFLARE_API_TOKEN) ||
    (typeof env?.CLEF_API_KEY === "string" && env.CLEF_API_KEY) ||
    "";

  const accountId = typeof env?.CLOUDFLARE_ACCOUNT_ID === "string"
    ? env.CLOUDFLARE_ACCOUNT_ID
    : "";

  const endpoint =
    typeof env?.CLEF_API_URL === "string" && env.CLEF_API_URL.length > 0
      ? env.CLEF_API_URL
      : accountId
      ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/clef`
      : "";

  if (!endpoint || !apiToken) {
    console.warn("clef: misconfigured", {
      hasEndpoint: Boolean(endpoint),
      hasApiToken: Boolean(apiToken),
      hasAccountId: Boolean(accountId),
    });
    return null;
  }

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiToken}`,
  };

  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "clef", ...payload }),
    });

    if (!res.ok) {
      let bodyText = "";
      try {
        // Operational detail only: a short snippet of the UPSTREAM response,
        // never the request body, parsed state, reply sample or tokens.
        bodyText = (await res.text()).slice(0, 120);
      } catch (_readErr) {
        bodyText = "(unreadable)";
      }
      console.warn("clef: upstream error", {
        status: res.status,
        statusText: res.statusText,
        body: bodyText,
      });
      return null;
    }

    const data = await res.json();
    const answers =
      (data && typeof data.answers === "object" && data.answers !== null
        ? data.answers
        : null) ||
      (data &&
          data.result &&
          typeof data.result.answers === "object" &&
          data.result.answers !== null
        ? data.result.answers
        : null);

    if (!answers) {
      console.warn("clef: unexpected response shape (no answers object)");
      return null;
    }

    return { answers, model: "clef" };
  } catch (_err) {
    console.warn("clef: network failure", {
      message: _err instanceof Error ? _err.message : String(_err),
    });
    return null;
  }
}

/**
 * Call the Jev model fallback via TypeSafe endpoint.
 *
 * @param {object} payload
 * @param {Record<string, unknown>} env
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{ answers: Record<string, unknown>, model: string } | null>}
 */
export async function callJev(payload, env, fetchImpl) {
  const endpoint = typeof env?.TYPESAFE_API_URL === "string" &&
      env.TYPESAFE_API_URL.length > 0
    ? env.TYPESAFE_API_URL
    : DEFAULT_TYPESAFE_ENDPOINT;

  const model = typeof env?.JEV_MODEL === "string" && env.JEV_MODEL.length > 0
    ? env.JEV_MODEL
    : "jev-latest";

  const apiKey =
    (typeof env?.TYPESAFE_API_KEY === "string" && env.TYPESAFE_API_KEY) ||
    (typeof env?.JEV_API_KEY === "string" && env.JEV_API_KEY) || "";

  const headers = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...payload, model }),
    });

    if (!res.ok) {
      let bodyText = "";
      try {
        // Operational detail only: a short snippet of the UPSTREAM response,
        // never the request body, parsed state, reply sample or tokens.
        bodyText = (await res.text()).slice(0, 120);
      } catch (_readErr) {
        bodyText = "(unreadable)";
      }
      console.warn("jev: upstream error", {
        status: res.status,
        statusText: res.statusText,
        endpoint,
        body: bodyText,
      });
      return null;
    }

    const data = await res.json();
    if (!data || typeof data.answers !== "object" || data.answers === null) {
      console.warn("jev: unexpected response shape (no answers object)");
      return null;
    }

    return { answers: data.answers, model: "jev" };
  } catch (_err) {
    console.warn("jev: network failure", {
      message: _err instanceof Error ? _err.message : String(_err),
    });
    return null;
  }
}

/**
 * Analyzes the submitted state using Clef primary and Jev fallback.
 *
 * `body` may be the raw parsed request body; it is re-run through the same
 * input gate used by index.js (pure and idempotent), and the model payload is
 * built from the resulting CANONICAL state — the same object the cache key is
 * built from. buildQuestionSet's own lower-casing/truncation are therefore
 * no-ops on an already-canonical state, kept as defensive idempotence.
 *
 * @param {Record<string, unknown>} body
 * @param {Record<string, unknown>} env
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Response>}
 */
export async function analyze(body, env, fetchImpl = globalThis.fetch) {
  const validated = validateAnalyzeBody(body);
  if (!validated.ok) {
    return invalidRequestResponse();
  }

  const payload = buildQuestionSet(validated.state);

  // Clef 27B primary
  let result = await callClef(payload, env, fetchImpl);

  // Jev fallback on Clef failure
  if (!result) {
    result = await callJev(payload, env, fetchImpl);
  }

  if (!result) {
    return new Response(JSON.stringify({ error: "ai_unavailable" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
