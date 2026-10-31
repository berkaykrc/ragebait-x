// Worker AI analysis implementation.
//
// Routes analysis through Clef 27B primary with Jev fallback.

import { buildQuestionSet, isValidState } from "./questions.js";

const DEFAULT_TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

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
        bodyText = (await res.text()).slice(0, 400);
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
        bodyText = (await res.text()).slice(0, 400);
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
 * @param {Record<string, unknown>} body
 * @param {Record<string, unknown>} env
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Response>}
 */
export async function analyze(body, env, fetchImpl = globalThis.fetch) {
  if (!body || typeof body !== "object" || !isValidState(body.state)) {
    let msg = "Missing or invalid state";
    if (body?.state && typeof body.state === "object") {
      if (
        !("features" in body.state) || typeof body.state.features !== "object"
      ) {
        msg = "Invalid request: state must contain features object";
      }
    }
    return new Response(JSON.stringify({ error: msg }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const payload = buildQuestionSet(body.state);

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
