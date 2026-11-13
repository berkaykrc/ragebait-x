import { extractProfileReplies } from "./parse.js";

const BASE = "https://api.fxtwitter.com/2/profile";

/**
 * Read a JSON body without throwing.
 *
 * @param {any} response
 * @returns {Promise<object|null>}
 */
async function readJsonSafe(response) {
  try {
    if (!response || typeof response.json !== "function") return null;
    const value = await response.json();
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Does this body say that the account does not exist?
 *
 * Only the profile endpoint says it. The timeline endpoint answers 404 with
 * the same empty body for a missing account and for a timeline it cannot
 * read.
 *
 * @param {any} body
 * @returns {boolean}
 */
function isUserNotFound(body) {
  const message = body?.message;
  return typeof message === "string" && /user not found/i.test(message);
}

/**
 * Ask the profile endpoint whether the account does not exist.
 *
 * The profile endpoint fails now and then too, so one answer is not proof:
 * ask twice before you call the account missing. Any other failure means the
 * account may exist.
 *
 * @param {string} handle
 * @param {Function} fetchImpl
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean>} true when the account does not exist
 */
async function accountIsMissing(handle, fetchImpl, signal) {
  const url = `${BASE}/${encodeURIComponent(handle)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, signal ? { signal } : undefined);
    } catch {
      return false;
    }
    if (response && response.ok) return false;
    if (!response || response.status !== 404) return false;
    const body = await readJsonSafe(response);
    // An empty 404 means the timeline could not be read, not that the
    // account is gone.
    if (!isUserNotFound(body)) return false;
  }
  return true;
}

function parseRetryAfter(value) {
  if (value == null) return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function sleeperFactory(sleepImpl, signal) {
  const sleepFn = sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  return async (ms) => {
    if (signal?.aborted) return;
    let onAbort;
    try {
      await Promise.race([
        (async () => await sleepFn(ms))(),
        new Promise((_, reject) => {
          if (!signal) return;
          if (signal.aborted) return reject(new Error("aborted"));
          onAbort = () => reject(new Error("aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } catch {
      // Abort or sleep failure handled silently.
    } finally {
      if (signal && onAbort) {
        signal.removeEventListener?.("abort", onAbort);
      }
    }
  };
}

/**
 * Map a documented FxTwitter status code to a failure reason.
 *
 * The HTTP status already mirrors `code` on this API, so this is a defensive
 * check for a body that reports an error while the transport says 200.
 *
 * @param {number} code
 * @returns {"unavailable"|"rate_limit"|"network"}
 */
function reasonForCode(code) {
  if (code === 404) return "unavailable";
  if (code === 429) return "rate_limit";
  return "network";
}

/**
 * Apply the shared failure rule: an empty "unavailable" result asks the
 * profile endpoint whether the account exists at all.
 *
 * @param {string} reason
 * @param {Array<object>} replies
 * @param {string} handle
 * @param {Function} safeFetch
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok:false,reason:string,replies:Array<object>}>}
 */
async function handlePageFailure(reason, replies, handle, safeFetch, signal) {
  if (reason === "unavailable" && replies.length === 0) {
    // No replies came in. Ask the profile endpoint whether the account
    // exists at all. If replies came in, the account exists, so the
    // reason stays "unavailable".
    const missing = await accountIsMissing(handle, safeFetch, signal);
    return {
      ok: false,
      reason: missing ? "not_found" : "unavailable",
      replies,
    };
  }
  return { ok: false, reason, replies };
}

async function fetchPage(url, fetchImpl, signal, sleep) {
  let attempt = 0;
  while (true) {
    if (signal?.aborted) {
      const e = new Error("aborted");
      e.reason = "network";
      throw e;
    }
    attempt += 1;
    let response;
    try {
      response = await fetchImpl(url, signal ? { signal } : undefined);
    } catch {
      if (signal?.aborted) {
        const e = new Error("aborted");
        e.reason = "network";
        throw e;
      }
      const e = new Error("network");
      e.reason = "network";
      throw e;
    }

    if (response && response.ok) return response;

    const status = response ? response.status : 0;

    if (status === 404) {
      const body = await readJsonSafe(response);
      if (isUserNotFound(body)) {
        const e = new Error("not_found");
        e.reason = "not_found";
        throw e;
      }
      // The body is empty. The account may exist, but FxTwitter cannot read
      // the timeline now. Retry, then report "unavailable" and keep the
      // replies that came in.
      if (attempt <= 2) {
        await sleep(attempt === 1 ? 500 : 1000);
        if (signal?.aborted) {
          const e = new Error("aborted");
          e.reason = "network";
          throw e;
        }
        continue;
      }
      const e = new Error("unavailable");
      e.reason = "unavailable";
      throw e;
    }

    if (status === 429) {
      const header = typeof response.headers?.get === "function"
        ? response.headers.get("Retry-After")
        : null;
      const ms = parseRetryAfter(header) ?? 1000;
      await sleep(ms);
      const e = new Error("rate_limit");
      e.reason = "rate_limit";
      throw e;
    }

    if (status >= 500) {
      await sleep(500);
      const e = new Error("network");
      e.reason = "network";
      throw e;
    }

    const e = new Error("network");
    e.reason = "network";
    throw e;
  }
}

export async function fetchReplies(handle, deps = {}) {
  const {
    fetchImpl = typeof fetch !== "undefined" ? fetch : undefined,
    sleepImpl,
    maxPages = 3,
    count = 40,
    signal,
  } = deps;
  const sleep = sleeperFactory(sleepImpl, signal);
  const safeFetch = fetchImpl;

  let replies = [];
  let cursor = null;

  try {
    for (let page = 0; page < maxPages; page++) {
      if (signal?.aborted) {
        return { ok: false, reason: "network", replies };
      }

      const url = cursor
        ? `${BASE}/${
          encodeURIComponent(handle)
        }/statuses?with_replies=true&count=${count}&cursor=${
          encodeURIComponent(cursor)
        }`
        : `${BASE}/${
          encodeURIComponent(handle)
        }/statuses?with_replies=true&count=${count}`;

      let response;
      try {
        response = await fetchPage(url, safeFetch, signal, sleep);
      } catch (err) {
        return await handlePageFailure(
          err?.reason || "network",
          replies,
          handle,
          safeFetch,
          signal,
        );
      }

      let json;
      try {
        json = await (typeof response.json === "function"
          ? response.json()
          : response);
      } catch {
        return { ok: false, reason: "malformed", replies };
      }
      if (json == null || typeof json !== "object") {
        return { ok: false, reason: "malformed", replies };
      }

      // The docs say every response carries `code`. On this API the HTTP
      // status mirrors it, but a body can still report an error while the
      // transport says 200. Treat a non-200 `code` as the failure it is.
      const code = typeof json.code === "number" && Number.isFinite(json.code)
        ? Math.trunc(json.code)
        : null;
      if (code !== null && code !== 200) {
        return await handlePageFailure(
          reasonForCode(code),
          replies,
          handle,
          safeFetch,
          signal,
        );
      }

      const pageReplies = extractProfileReplies(json, handle);
      replies = replies.concat(pageReplies);

      const next = json?.cursor?.bottom ?? null;
      if (replies.length >= 5) break;
      if (!next) break;
      cursor = next;
    }

    return { ok: true, replies };
  } catch (err) {
    return { ok: false, reason: err?.reason || "network", replies };
  }
}
