// Background orchestration (Task 8, heuristic phase).
//
// Heuristic-only in v1: cache -> (FxTwitter fetch) -> features -> compose ->
// local quota check -> cache.set -> one final response. The AI upgrade merges
// into this same single response in Task 15; nothing here stages or streams.

import { HANDLE_RE } from "../shared/security.js";
import { createCache } from "../data/cache.js";
import { fetchReplies as fxFetchReplies } from "../data/fxtwitter.js";
import { computeFeatures as defaultComputeFeatures } from "../analysis/features.js";
import {
  composeScore as defaultComposeScore,
  MIN_REPLIES,
} from "../analysis/compose.js";
import {
  consumeDailyProfile as defaultConsumeDailyProfile,
  MAX_DAILY_PROFILES,
} from "./quota-local.js";
import { makeScoreResponse } from "./protocol.js";
import {
  analyzeWithAi as defaultAnalyzeWithAi,
  fetchConfigCached,
  getInstallToken,
} from "../ai/client.js";
import { loadSettings, SETTINGS_KEY } from "../options/index.js";

function isFn(v) {
  return typeof v === "function";
}

function nowOf(deps) {
  if (isFn(deps.now)) return deps.now;
  if (typeof deps.now === "number") return () => deps.now;
  return () => Date.now();
}

function resolveDeps(deps = {}) {
  const d = deps || {};
  const now = nowOf(d);
  const storage = d.storage ?? d.browserStorage ?? d.storeStorage ?? null;
  // A passed-in `store` may be a DOM store (has merge) or a storage adapter.
  const domStore = d.domStore ?? d.domStoreInstance ??
    (d.store && isFn(d.store.merge) ? d.store : null);
  const storageAdapter = (d.storage || d.browserStorage || d.storeStorage)
    ? (d.storage ?? d.browserStorage ?? d.storeStorage)
    : (d.store && !isFn(d.store.merge) ? d.store : storage);

  const fetchImpl = d.fetchImpl ?? d.fetch ??
    (typeof fetch !== "undefined" ? fetch : undefined);
  const sleepImpl = d.sleepImpl ?? d.sleep ?? d.sleeper;
  const modelVersion = d.modelVersion ?? d.mv ?? "h1";
  const featureVersion = d.featureVersion ?? d.fv ?? "f1";

  let cache = d.cache ?? null;
  if (!cache) {
    try {
      cache = createCache({
        storage: storageAdapter,
        now,
        modelVersion,
        featureVersion,
      });
    } catch {
      cache = {
        get() {
          return null;
        },
        set() {},
        peek() {
          return null;
        },
      };
    }
  }

  // Resolve a fetchReplies function.
  let fetchReplies = d.fetchReplies;
  const adapter = d.adapter ?? d.dataAdapter ?? d.fxAdapter ?? d.fetchAdapter ??
    d.primaryAdapter;
  if (!fetchReplies && adapter && isFn(adapter.fetchReplies)) {
    fetchReplies = adapter.fetchReplies.bind(adapter);
  }
  if (!fetchReplies) {
    fetchReplies = async (handle, opts = {}) => {
      const signal = opts.signal;
      const fi = opts.fetchImpl ?? fetchImpl;
      const si = opts.sleepImpl ?? sleepImpl;
      try {
        return await fxFetchReplies(handle, {
          fetchImpl: fi,
          sleepImpl: si,
          signal,
          maxPages: opts.maxPages,
          count: opts.count,
        });
      } catch (e) {
        return { ok: false, reason: (e && e.reason) || "network", replies: [] };
      }
    };
  }

  // Service workers can be stopped and restarted at any time. Keep this map
  // scoped to one background instance and use the cache as the durable state.
  const dedupeMap = d.dedupe ?? d.dedupeMap ?? d.inflight ?? new Map();

  const consume = d.consumeDailyProfile ?? d.consumeQuota ??
    (d.quota && isFn(d.quota.consume) ? d.quota.consume.bind(d.quota) : null) ??
    defaultConsumeDailyProfile;

  const limit = typeof d.limit === "number"
    ? d.limit
    : (typeof d.dailyLimit === "number" ? d.dailyLimit : MAX_DAILY_PROFILES);

  const computeFeatures = d.computeFeatures ?? defaultComputeFeatures;
  const composeScore = d.composeScore ?? defaultComposeScore;

  const token = d.token ?? d.sessionToken ?? null;
  const resolveToken = isFn(d.resolveToken) ? d.resolveToken : null;
  const config = d.config && typeof d.config === "object" ? d.config : {};
  const browserApi = d.browserApi ?? d.browser ?? null;
  const onResponse = isFn(d.onResponse) ? d.onResponse : null;
  const onResult = isFn(d.onResult) ? d.onResult : null;
  const analyzeWithAi = d.analyzeWithAi ?? defaultAnalyzeWithAi;
  const settings = d.settings ?? d.currentSettings ?? { mode: "heuristic" };
  const proxyUrl = d.proxyUrl ?? d.config?.proxyUrl;
  const installToken = d.installToken ?? null;
  // Background diagnostics: silent by default, so tests and library callers
  // stay clean. The live wiring injects a console-based logger.
  const log = isFn(d.log) ? d.log : () => {};

  return {
    now,
    storage: storageAdapter,
    domStore,
    fetchImpl,
    sleepImpl,
    modelVersion,
    featureVersion,
    cache,
    fetchReplies,
    dedupeMap,
    consume,
    limit,
    computeFeatures,
    composeScore,
    token,
    resolveToken,
    config,
    browserApi,
    onResponse,
    onResult,
    analyzeWithAi,
    settings,
    proxyUrl,
    installToken,
    log,
    skipCache: !!d.skipCache,
  };
}

function invalidResult(now) {
  return {
    state: "error",
    band: undefined,
    percent: null,
    heuristic: false,
    fetchedAt: now(),
  };
}

function generateToken() {
  try {
    if (typeof crypto !== "undefined" && isFn(crypto.randomUUID)) {
      return crypto.randomUUID();
    }
  } catch { /* ignore */ }
  return `rb-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export async function handleScoreRequest(handle, deps = {}) {
  const r = resolveDeps(deps);
  const now = r.now;

  // Corrupt handle: reject before any network or quota work.
  if (typeof handle !== "string" || !HANDLE_RE.test(handle)) {
    return invalidResult(now);
  }
  const h = handle.toLowerCase();

  const dedupeMap = r.dedupeMap;

  // Join an in-flight request for the same handle.
  const existing = dedupeMap.get(h);
  if (existing && existing.promise) {
    try {
      return await existing.promise;
    } catch {
      return invalidResult(now);
    }
  }

  const controller = new AbortController();
  if (deps && deps.signal) {
    if (deps.signal.aborted) controller.abort();
    else if (typeof deps.signal.addEventListener === "function") {
      deps.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }
  const entry = { handle: h, controller, promise: null };
  dedupeMap.set(h, entry);

  const run = async () => {
    try {
      // Cache hit (unless forced refresh).
      const forceRefresh =
        !!(deps.forceRefresh || deps.refresh || deps.skipCache || r.skipCache);
      if (!forceRefresh) {
        try {
          const cached = await r.cache.get(h);
          if (cached && cached.value && typeof cached.value === "object") {
            r.log(
              "score",
              h,
              "cache hit ->",
              cached.value.state,
              "model:",
              cached.value.model,
            );
            return cached.value;
          }
        } catch { /* ignore */ }
      }

      // Fetch replies.
      let fetchResult;
      try {
        fetchResult = await r.fetchReplies(h, {
          fetchImpl: r.fetchImpl,
          sleepImpl: r.sleepImpl,
          signal: controller.signal,
        });
      } catch (_e) {
        fetchResult = {
          ok: false,
          reason: (_e && _e.reason) || "network",
          replies: [],
        };
      }

      if (controller.signal.aborted) {
        return {
          state: "error",
          percent: null,
          heuristic: false,
          fetchedAt: now(),
          cancelled: true,
        };
      }

      const rawReplies = Array.isArray(fetchResult?.replies)
        ? fetchResult.replies
        : [];
      // DOM-store merge (replies surfaced while the Replies tab was open).
      let replies = rawReplies;
      if (r.domStore && isFn(r.domStore.merge)) {
        try {
          replies = r.domStore.merge(h, rawReplies);
          if (!Array.isArray(replies)) replies = rawReplies;
        } catch {
          replies = rawReplies;
        }
      }

      const ok = fetchResult?.ok !== false;
      const reason = fetchResult?.reason;

      const minReplies = typeof MIN_REPLIES === "number" ? MIN_REPLIES : 5;

      let state = null;
      // Error mapping per Part 1 §7.
      if (reason === "not_found") {
        state = "error";
      } else if (!ok && reason === "malformed") {
        state = replies.length >= minReplies ? "estimated" : "error";
      } else if (!ok && (reason === "network" || reason === "rate_limit")) {
        state = replies.length >= minReplies ? "estimated" : "error";
      } else if (!ok) {
        // Unknown failure: estimated only if we have partial replies.
        state = replies.length >= minReplies ? "estimated" : "error";
      } else {
        // ok
        state = replies.length >= minReplies ? "result" : "insufficient";
      }

      r.log(
        "score",
        h,
        "fetch:",
        ok ? "ok" : `failed (${reason})`,
        "replies:",
        replies.length,
        "-> state:",
        state,
      );

      let band = undefined;
      let _score = null;
      let features = null;

      if (state === "result" || state === "estimated") {
        try {
          features = r.computeFeatures(replies);
        } catch {
          features = null;
        }
        let composed = null;
        try {
          composed = features ? r.composeScore(features) : null;
        } catch {
          composed = null;
        }
        if (composed && composed.insufficient) {
          state = "insufficient";
          band = undefined;
          _score = null;
        } else if (composed) {
          band = composed.band;
          _score = typeof composed.score === "number" ? composed.score : null;
        } else {
          // Could not compose: degrade to error unless partial.
          state = replies.length >= minReplies ? "estimated" : "error";
        }
      }

      // Task 15: AI Upgrade Step.
      // percent is set ONLY when config.showNumber is true AND the AI path produced a score.
      let percent = null;
      let heuristic = state === "result" || state === "estimated";
      let model = "heuristic";

      const settings = r.settings || {};
      // Consent gate: AI modes are blocked until the user accepts the
      // data-handling notice (Task 19). Fall back to heuristic otherwise.
      const consented = settings.consentAccepted === true;
      const mode =
        (settings.mode && settings.mode !== "heuristic" && !consented)
          ? "heuristic"
          : (settings.mode || "heuristic");

      if (
        (state === "result" || state === "estimated") &&
        mode !== "heuristic" &&
        features
      ) {
        try {
          const aiOptions = {
            mode,
            proxyUrl: settings.proxyUrl || r.proxyUrl,
            byokEndpoint: settings.byokEndpoint,
            apiKey: settings.apiKey,
            installToken: r.installToken,
            proxyEnabled: settings.proxyEnabled ?? r.config?.proxyEnabled,
            thresholds: r.config?.bandThresholds,
          };
          const aiState = {
            handle: h,
            features,
            replySample: replies.slice(0, 12).map((rep) =>
              typeof rep === "string" ? rep : (rep?.text || "")
            ),
          };

          r.log(
            "score",
            h,
            `AI attempt: mode=${mode} consented=${consented}`,
            mode === "proxy" ? "proxyUrl set" : "endpoint:",
            mode === "byok" ? !!settings.byokEndpoint : "(proxy)",
          );
          const aiRes = await r.analyzeWithAi(aiState, aiOptions, r.fetchImpl);
          if (aiRes && aiRes.state === "quota") {
            r.log("score", h, "AI -> quota");
            state = "quota";
            percent = null;
          } else if (aiRes && aiRes.band) {
            r.log(
              "score",
              h,
              "AI ->",
              aiRes.band,
              aiRes.percent ?? "",
              "via",
              aiRes.model,
            );
            band = aiRes.band;
            model = aiRes.model || mode;
            heuristic = false;
            if (
              r.config?.showNumber === true && typeof aiRes.percent === "number"
            ) {
              percent = Math.round(aiRes.percent);
            } else {
              percent = null;
            }
          } else {
            r.log(
              "score",
              h,
              "AI -> fallback:",
              aiRes?.fallback ?? "unknown",
              "(heuristic band kept)",
            );
          }
        } catch (_aiErr) {
          // AI error / 502 -> retains heuristic band, never error
          r.log(
            "score",
            h,
            "AI threw ->",
            _aiErr?.message ?? _aiErr,
            "(heuristic band kept)",
          );
          percent = null;
          heuristic = true;
        }
      } else {
        r.log(
          "score",
          h,
          `AI skipped (state=${state}, mode=${mode},`,
          `consented=${consented}, features=${!!features})`,
        );
      }

      // Local daily quota check — proxy mode only. The hosted service runs
      // on the cloud with real per-install limits and cost; heuristic and
      // BYOK consume nothing of ours, so no cap applies there (BYOK runs
      // against the endpoint the user configured, under its own limits).
      // Cache hits return earlier and never consume.
      let quotaAllowed = true;
      if (mode === "proxy") {
        try {
          const q = await r.consume(r.storage, now(), r.limit);
          if (q && q.allowed === false) quotaAllowed = false;
        } catch {
          quotaAllowed = true;
        }
      }

      if (
        !quotaAllowed &&
        (state === "result" || state === "estimated" ||
          state === "insufficient")
      ) {
        state = "quota";
      }

      const result = {
        state,
        band,
        percent,
        heuristic,
        model,
        fetchedAt: now(),
      };

      // Never persist `quota` (local limit, re-evaluated every hover).
      if (state !== "quota") {
        try {
          await r.cache.set(h, result);
        } catch { /* ignore */ }
      }

      return result;
    } catch (_e) {
      return {
        state: "error",
        band: undefined,
        percent: null,
        heuristic: false,
        fetchedAt: now(),
      };
    } finally {
      if (dedupeMap.get(h) === entry) {
        dedupeMap.delete(h);
      }
    }
  };

  entry.promise = run();
  // Ensure stored before first await resolves (already set above).
  return entry.promise;
}

export function cancelScoreRequest(handle, deps = {}) {
  const r = resolveDeps(deps);
  const dedupeMap = r.dedupeMap;
  if (handle == null) {
    // Cancel everything.
    for (const entry of [...dedupeMap.values()]) {
      try {
        entry.controller.abort();
      } catch { /* ignore */ }
    }
    dedupeMap.clear();
    return;
  }
  const h = String(handle).toLowerCase();
  const entry = dedupeMap.get(h);
  if (entry) {
    try {
      entry.controller.abort();
    } catch { /* ignore */ }
    dedupeMap.delete(h);
  }
}

export function createBackground(deps = {}) {
  const r = resolveDeps(deps);
  const dedupeMap = r.dedupeMap;
  const resolveToken = r.resolveToken;
  // With a resolver wired, the resolver is the single source of truth for
  // `rb:config`, so this stays null even if a caller passes an explicit token.
  // Without one, this is the per-instance token.
  const token = resolveToken ? null : (r.token || generateToken());
  const config = r.config && typeof r.config === "object" ? r.config : {};
  const browserApi = r.browserApi;
  const sessions = new Map();

  const handleScoreRequestBound = (handle, extra = {}) =>
    handleScoreRequest(handle, {
      ...r,
      ...extra,
      dedupeMap,
      token,
      config: extra.config ?? config,
    });

  const cancelBound = (handle) =>
    cancelScoreRequest(handle, { ...r, dedupeMap });

  async function handleMessage(message, _sender, extra = {}) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return null;
    }

    if (message.type === "rb:config") {
      // Correlation token (public by design, D13). Reading it from storage
      // keeps it stable across service-worker restarts in MV3.
      const sessionToken = resolveToken ? await resolveToken() : token;
      return { token: sessionToken, config: extra.config ?? config };
    }

    if (message.type === "rb:score-request") {
      const handle = message.handle;
      const requestId = message.requestId != null
        ? message.requestId
        : generateToken();
      sessions.set(String(requestId), String(handle ?? "").toLowerCase());

      const result = await handleScoreRequestBound(handle, {
        forceRefresh: false,
        ...extra,
      });

      const response = {
        ...makeScoreResponse({ requestId, result }),
        handle: String(handle ?? "").toLowerCase(),
      };

      if (r.onResponse) {
        try {
          r.onResponse(response);
        } catch { /* ignore */ }
      }
      if (r.onResult) {
        try {
          r.onResult(response);
        } catch { /* ignore */ }
      }
      if (
        browserApi && browserApi.runtime && isFn(browserApi.runtime.sendMessage)
      ) {
        try {
          // Firefox returns a rejected promise when no tab has a content
          // script listening (e.g. the initiating tab was closed). The
          // broadcast is a best-effort push-path duplication; a rejection is
          // noise, not delivery failure.
          const broadcast = browserApi.runtime.sendMessage(response);
          if (broadcast && typeof broadcast.then === "function") {
            broadcast.catch(() => {/* ignore */});
          }
        } catch { /* ignore */ }
      }
      return response;
    }

    if (message.type === "rb:score-refresh") {
      const handle = message.handle;
      const requestId = message.requestId != null
        ? message.requestId
        : generateToken();
      sessions.set(String(requestId), String(handle ?? "").toLowerCase());

      const result = await handleScoreRequestBound(handle, {
        forceRefresh: true,
        ...extra,
      });

      const response = {
        ...makeScoreResponse({ requestId, result }),
        handle: String(handle ?? "").toLowerCase(),
      };

      if (r.onResponse) {
        try {
          r.onResponse(response);
        } catch { /* ignore */ }
      }
      if (r.onResult) {
        try {
          r.onResult(response);
        } catch { /* ignore */ }
      }
      if (
        browserApi && browserApi.runtime && isFn(browserApi.runtime.sendMessage)
      ) {
        try {
          // Same broadcast-rejection silencing as rb:score-request above.
          const broadcast = browserApi.runtime.sendMessage(response);
          if (broadcast && typeof broadcast.then === "function") {
            broadcast.catch(() => {/* ignore */});
          }
        } catch { /* ignore */ }
      }
      return response;
    }

    if (message.type === "rb:score-cancel") {
      let handle = message.handle;
      if (
        !handle && message.requestId != null &&
        sessions.has(String(message.requestId))
      ) {
        handle = sessions.get(String(message.requestId));
      }
      // Resolve handle from requestId map even if stored lower-cased.
      cancelBound(handle);
      if (message.requestId != null) sessions.delete(String(message.requestId));
      return { ok: true };
    }

    return null;
  }

  return {
    token,
    config,
    browserApi,
    dedupeMap,
    sessions,
    handleScoreRequest: handleScoreRequestBound,
    cancelScoreRequest: cancelBound,
    cancelScore: cancelBound,
    cancel: cancelBound,
    abort: cancelBound,
    releaseDedupe: cancelBound,
    handleMessage,
    onMessage: handleMessage,
    handleRuntimeMessage: handleMessage,
    dispose() {},
  };
}

// Aliases for callers/tests that expect different factory names.
export const createListener = createBackground;
export const createMessageListener = createBackground;
export const createBackgroundOrchestrator = createBackground;
export const createOrchestrator = createBackground;
export const createHandler = createBackground;
export const bootBackground = createBackground;

// Auto-boot in the extension (background) world only.
//
// The saved settings MUST be read per request, not at boot: nothing on the
// options page pushes a reload of this background, so the user's proxy/BYOK
// choice, consent flag and proxy URL would otherwise go live only after an
// extension restart. The same request-time read also generates and persists
// the install token for the worker (X-Install-Token).
export function wireBrowserRuntime(browserApi, deps = {}) {
  if (
    !browserApi || !browserApi.runtime ||
    !browserApi.runtime.onMessage ||
    !browserApi.runtime.onMessage.addListener
  ) {
    return null;
  }

  const storage = browserApi.storage && browserApi.storage.local
    ? {
      async get(key) {
        const res = await browserApi.storage.local.get(key);
        return res && Object.prototype.hasOwnProperty.call(res, key)
          ? res[key]
          : null;
      },
      async set(key, value) {
        await browserApi.storage.local.set({ [key]: value });
      },
    }
    : null;

  // getInstallToken and the config cache speak the items-shaped storage
  // dialect used by browser.storage.local (get(keys) -> Record,
  // set(items)), so adapt the (key, value) seam to it once.
  const itemsStorage = storage && {
    get: (key) => storage.get(key).then((value) => ({ [key]: value })),
    set: (items) =>
      Promise.all(
        Object.entries(items).map(([k, v]) => storage.set(k, v)),
      ),
  };

  // Session-correlation token. Correlation, not authentication (D13): the
  // page can read it from the config tag. Persisted in storage.local (MV2 has
  // no storage.session) so an MV3 service-worker restart hands the same token
  // to FUTURE rb:config callers (new tabs, reloads). Content scripts already
  // running keep the token they were given and are never re-issued one.
  // The background does not validate this token: this is stability, not a
  // trust fix. Outliving the browser session is fine for a public id.
  const SESSION_TOKEN_KEY = "session_token";
  let sessionTokenPromise = null;
  const resolveSessionToken = () => {
    if (!sessionTokenPromise) {
      sessionTokenPromise = (async () => {
        // No storage at all: one token per worker instance is the best we can
        // do, and retrying would only mint a new one on every call.
        if (!storage) return { token: generateToken(), keep: true };
        try {
          const stored = await storage.get(SESSION_TOKEN_KEY);
          if (typeof stored === "string" && stored.length > 0) {
            return { token: stored, keep: true };
          }
        } catch {
          // Transient read failure: fall back for this call, retry next time.
          return { token: generateToken(), keep: false };
        }
        const fresh = generateToken();
        try {
          await storage.set(SESSION_TOKEN_KEY, fresh);
          return { token: fresh, keep: true };
        } catch {
          // Write failure: the token never left memory. Keep this one for the
          // worker's lifetime so live tabs and later rb:config callers still
          // agree; only a failed READ is worth retrying.
          return { token: fresh, keep: true };
        }
      })().then((res) => {
        // Only pin a result the storage actually confirmed; a failed read must
        // not freeze a random token for the rest of this worker's life.
        if (!res.keep) sessionTokenPromise = null;
        return res.token;
      });
    }
    return sessionTokenPromise;
  };

  // Load the saved settings and the install token fresh for every score
  // request. Never throws: any storage failure leaves the defaults in place.
  const requestDeps = async () => {
    if (!storage) return {};
    try {
      const settings = await loadSettings(storage);
      const installToken = await getInstallToken(itemsStorage);
      const config = settings.mode === "proxy"
        ? await fetchConfigCached(
          settings.proxyUrl,
          deps.fetchImpl ?? globalThis.fetch,
          itemsStorage,
        )
        : null;
      return { settings, installToken, config: config ?? {} };
    } catch (err) {
      console.warn("ragebait:bg: request deps load failed:", err);
      return {};
    }
  };

  const bg = createBackground({
    browserApi,
    storage,
    resolveToken: resolveSessionToken,
    fetchImpl: typeof fetch !== "undefined" ? fetch : undefined,
    now: () => Date.now(),
    // Diagnosability: the page world logs; the background must too, or a
    // silent stop is invisible (Bug report: empty wrangler tail).
    log: (...args) => console.info("ragebait:bg:", ...args),
    ...deps,
  });

  // Boot line: proves the new background is actually running after a reload.
  // Absence of this line after a reload means the background script failed to
  // load (or the add-on is still running a stale build).
  console.info(
    "ragebait:bg: wired — storage:",
    !!storage,
    "| settings key:",
    SETTINGS_KEY,
  );

  browserApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const p = (async () => {
      if (
        message && typeof message === "object" &&
        (message.type === "rb:score-request" ||
          message.type === "rb:score-refresh" ||
          message.type === "rb:config")
      ) {
        const extra = await requestDeps();
        if (message.type === "rb:score-request") {
          return bg.handleMessage(message, sender, extra);
        }
        return bg.handleMessage(message, sender, extra);
      }
      return bg.handleMessage(message, sender);
    })();
    if (p && typeof p.then === "function") {
      p.then((res) => {
        try {
          if (sendResponse) sendResponse(res);
        } catch { /* ignore */ }
      }).catch(() => {
        try {
          if (sendResponse) sendResponse(null);
        } catch { /* ignore */ }
      });
    } else {
      try {
        if (sendResponse) sendResponse(p);
      } catch { /* ignore */ }
    }
    return true;
  });

  return bg;
}

const extensionApi = typeof browser !== "undefined"
  ? browser
  : (typeof chrome !== "undefined" ? chrome : null);

if (extensionApi) {
  try {
    wireBrowserRuntime(extensionApi, {});
  } catch { /* ignore */ }
}

export { DAILY_KEY, MAX_DAILY_PROFILES } from "./quota-local.js";
export { cancelScoreRequest as cancelScore };
export { cancelScoreRequest as cancel };
export { cancelScoreRequest as abort };
export default createBackground;
