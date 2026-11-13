import { extractProfileReplies } from "./parse.js";

const BASE = "https://api.fxtwitter.com/2/profile";

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
      if (attempt <= 2) {
        await sleep(attempt === 1 ? 500 : 1000);
        if (signal?.aborted) {
          const e = new Error("aborted");
          e.reason = "network";
          throw e;
        }
        continue;
      }
      const e = new Error("not_found");
      e.reason = "not_found";
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
        return { ok: false, reason: err?.reason || "network", replies };
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

      const pageReplies = extractProfileReplies(json, handle);
      replies = replies.concat(pageReplies);

      const next = json?.cursor?.bottom ?? json?.cursor?.next ??
        json?.cursor?.cursor ?? null;
      if (replies.length >= 5) break;
      if (!next) break;
      cursor = next;
    }

    return { ok: true, replies };
  } catch (err) {
    return { ok: false, reason: err?.reason || "network", replies };
  }
}
