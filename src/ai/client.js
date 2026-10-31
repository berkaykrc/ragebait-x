// Extension AI client.
//
// Handles proxy and BYOK requests, 10s timeout, install token lifecycle,
// and response mapping.

import { mapNoulToScore } from "./map-response.js";

const INSTALL_TOKEN_KEY = "ragebait_install_token";
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Retrieves or generates the unique installation token stored in extension storage.
 *
 * @param {{ get(keys: string | string[]): Promise<Record<string, unknown>>, set(items: Record<string, unknown>): Promise<void> }} storage
 * @returns {Promise<string>}
 */
export async function getInstallToken(storage) {
  try {
    const data = await storage.get(INSTALL_TOKEN_KEY);
    if (
      typeof data?.[INSTALL_TOKEN_KEY] === "string" &&
      data[INSTALL_TOKEN_KEY].length > 0
    ) {
      return data[INSTALL_TOKEN_KEY];
    }

    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    await storage.set({ [INSTALL_TOKEN_KEY]: token });
    return token;
  } catch (_err) {
    // Fallback in-memory token if storage fails
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
  }
}

/**
 * Fetches remote configuration from the Worker /config endpoint.
 *
 * @param {string} proxyUrl
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function fetchConfig(proxyUrl, fetchImpl = globalThis.fetch) {
  try {
    const configUrl = proxyUrl.replace(/\/analyze\/?$/, "/config");
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await fetchImpl(configUrl, { method: "GET", signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_err) {
    return null;
  }
}

/**
 * Executes AI analysis for the profile state in proxy or BYOK mode.
 *
 * @param {object} state
 * @param {{
 *   mode?: string,
 *   proxyUrl?: string,
 *   byokEndpoint?: string,
 *   apiKey?: string,
 *   installToken?: string,
 *   proxyEnabled?: boolean,
 *   thresholds?: { high: number, medium: number },
 * }} options
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ band?: string, percent?: number, score?: number, model?: string, state?: string, fallback?: string }>}
 */
export async function analyzeWithAi(
  state,
  options,
  fetchImpl = globalThis.fetch,
) {
  const mode = options?.mode || "heuristic";

  // Heuristic mode or proxy disabled -> no network call at all
  if (mode === "heuristic") {
    return { fallback: "heuristic" };
  }
  if (mode === "proxy" && options?.proxyEnabled === false) {
    return { fallback: "heuristic" };
  }

  let endpoint = "";
  const headers = { "Content-Type": "application/json" };

  if (mode === "byok") {
    if (!options?.byokEndpoint) {
      return { fallback: "heuristic" };
    }
    endpoint = options.byokEndpoint;
    if (options?.apiKey) {
      headers["Authorization"] = `Bearer ${options.apiKey}`;
    }
  } else if (mode === "proxy") {
    if (!options?.proxyUrl) {
      return { fallback: "heuristic" };
    }
    endpoint = options.proxyUrl;
    if (options?.installToken) {
      headers["X-Install-Token"] = options.installToken;
    }
  } else {
    return { fallback: "heuristic" };
  }

  try {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const body = {
      state,
      installToken: options?.installToken,
    };

    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (res.status === 429) {
      return { state: "quota" };
    }

    if (!res.ok) {
      // Diagnosability: name the status and, when readable, the body. A
      // CORS-deployed worker answers errors with Access-Control-Allow-Origin,
      // so this normally succeeds; a block leaves only the status.
      try {
        const errBody = await res.text();
        console.warn(
          "ragebait:ai: proxy responded",
          res.status,
          errBody.slice(0, 300),
        );
      } catch (_readErr) {
        console.warn(
          "ragebait:ai: proxy responded",
          res.status,
          "(body unread)",
        );
      }
      return { fallback: "heuristic" };
    }

    const data = await res.json();
    if (!data || !data.answers || typeof data.answers !== "object") {
      return { fallback: "heuristic" };
    }

    const { score, band } = mapNoulToScore(data.answers, options?.thresholds);
    const percent = Math.round(score * 100);

    return {
      band,
      percent,
      score,
      model: data.model || mode,
    };
  } catch (_err) {
    // Network / timeout / DNS failure -> degrade to heuristic
    return { fallback: "heuristic" };
  }
}
