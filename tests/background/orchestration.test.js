import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cancelScoreRequest,
  createBackground,
  handleScoreRequest,
} from "../../src/background/index.js";
import { makeScoreResponse, MSG } from "../../src/background/protocol.js";
import {
  consumeDailyProfile,
  MAX_DAILY_PROFILES,
} from "../../src/background/quota-local.js";
import { createCache } from "../../src/data/cache.js";

function makeStorage(seed = {}) {
  const data = { ...seed };
  return {
    get(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    set(key, value) {
      data[key] = value;
    },
    _data: data,
  };
}

function makeReplies(n, start = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: String(start + i),
    text: "reply",
    lang: "tr",
    targetScreenName: "target",
    parentStatusId: null,
    likes: 1,
    createdAt: 1000 + i,
  }));
}

function okFetch(replies) {
  let calls = 0;
  const fetchImpl = (_url) => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => ({
        results: replies.map((r) => ({
          author: { screen_name: "h" },
          replying_to: { screen_name: "target", status: "parent" },
          text: r.text,
          lang: r.lang,
          likes: r.likes,
          replies: 0,
          views: 1,
          created_timestamp: r.createdAt,
          id: r.id,
        })),
        cursor: {},
      }),
    };
  };
  fetchImpl.calls = () => calls;
  return fetchImpl;
}

test("background: corrupt handle rejected before network", async () => {
  let calls = 0;
  const fetchImpl = () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => ({ results: [], cursor: {} }),
    };
  };
  const storage = makeStorage();
  const r = await handleScoreRequest("!!!", {
    fetchImpl,
    storage,
    now: () => 1,
  });
  assert.equal(calls, 0);
  assert.equal(r.state, "error");
});

test("background: cache hit no network", async () => {
  const storage = makeStorage();
  const now = () => 1000;
  const cache = createCache({
    storage,
    now,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  await cache.set("h", {
    state: "result",
    band: "low",
    percent: 10,
    heuristic: true,
    fetchedAt: 1,
  });

  let calls = 0;
  const fetchImpl = () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => ({ results: [], cursor: {} }),
    };
  };
  const r = await handleScoreRequest("h", { fetchImpl, storage, now, cache });
  assert.equal(calls, 0);
  assert.equal(r.state, "result");
});

test("background: miss -> result", async () => {
  const storage = makeStorage();
  const now = () => 1000;
  const replies = makeReplies(6);
  // fxtwitter expects raw shape; our okFetch builds it
  const fetchImpl = okFetch(replies);
  const r = await handleScoreRequest("h", {
    fetchImpl,
    storage,
    now,
    sleepImpl: () => {},
  });
  assert.equal(r.state, "result");
  assert.equal(r.heuristic, true);
  assert.ok(r.band);
});

test("background: not_found -> error, no compose", async () => {
  const storage = makeStorage();
  const now = () => 1000;
  const fetchImpl = () => ({
    ok: false,
    status: 404,
    headers: { get: () => null },
    json: () => ({ code: 404 }),
  });
  // fxtwitter retries 404 twice; provide sleep
  const r = await handleScoreRequest("h", {
    fetchImpl,
    storage,
    now,
    sleepImpl: async () => {},
  });
  assert.equal(r.state, "error");
});

test("background: dedupe one network call", async () => {
  const storage = makeStorage();
  const now = () => 1000;
  const replies = makeReplies(6);
  const fetchImpl = okFetch(replies);
  const dedupe = new Map();
  const p1 = handleScoreRequest("h", {
    fetchImpl,
    storage,
    now,
    sleepImpl: () => {},
    dedupe,
  });
  const p2 = handleScoreRequest("h", {
    fetchImpl,
    storage,
    now,
    sleepImpl: () => {},
    dedupe,
  });
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(fetchImpl.calls(), 1);
  assert.equal(a.state, "result");
  assert.equal(b.state, "result");
});

test("background: rejected in-flight entry does not orphan later requests", async () => {
  const dedupe = new Map();
  let calls = 0;
  const fetchReplies = () => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new Error("worker request failed"))
      : Promise.resolve({ ok: true, replies: makeReplies(6) });
  };

  const first = await handleScoreRequest("recoverable", {
    dedupe,
    fetchReplies,
    skipCache: true,
  });
  const second = await handleScoreRequest("recoverable", {
    dedupe,
    fetchReplies,
    skipCache: true,
  });

  assert.equal(first.state, "error");
  assert.equal(second.state, "result");
  assert.equal(calls, 2);
  assert.equal(dedupe.size, 0);
});

test("background: cancel releases dedupe", async () => {
  const storage = makeStorage();
  const now = () => 1000;
  // slow fetch
  let resolveFetch;
  const fetchPromise = new Promise((res) => {
    resolveFetch = res;
  });
  const fetchImpl = () => fetchPromise;
  const dedupe = new Map();
  const p = handleScoreRequest("h", {
    fetchImpl,
    storage,
    now,
    sleepImpl: () => {},
    dedupe,
  });
  // cancel
  cancelScoreRequest("h", { dedupe });
  // resolve fetch with replies
  resolveFetch({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => ({ results: [], cursor: {} }),
  });
  await p.catch(() => {});
  // next request should fetch again
  let calls = 0;
  const fetchImpl2 = () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => ({
        results: makeReplies(6).map((r) => ({
          author: { screen_name: "h" },
          replying_to: { screen_name: "target", status: "parent" },
          text: r.text,
          lang: r.lang,
          likes: r.likes,
          replies: 0,
          views: 1,
          created_timestamp: r.createdAt,
          id: r.id,
        })),
        cursor: {},
      }),
    };
  };
  const _r2 = await handleScoreRequest("h", {
    fetchImpl: fetchImpl2,
    storage,
    now,
    sleepImpl: () => {},
    dedupe,
  });
  assert.equal(calls, 1);
});

test("background: quota-local basic", async () => {
  const storage = makeStorage();
  const now = () => 1000;
  const r1 = await consumeDailyProfile(storage, now, 2);
  assert.equal(r1.allowed, true);
  const r2 = await consumeDailyProfile(storage, now, 2);
  assert.equal(r2.allowed, true);
  const r3 = await consumeDailyProfile(storage, now, 2);
  assert.equal(r3.allowed, false);
});

test("protocol: makeScoreResponse shape", () => {
  const r = makeScoreResponse({
    requestId: "abc",
    result: { state: "result" },
    handle: "H",
  });
  assert.equal(r.type, "rb:score-response");
  assert.equal(r.requestId, "abc");
  assert.equal(r.handle, "h");
  assert.equal(r.result.state, "result");
});

test("MSG is the allowlist", () => {
  assert.ok(MSG.has("rb:score-request"));
  assert.equal(MSG.size, 4);
});

test("createBackground handleMessage single response", async () => {
  const storage = makeStorage();
  const now = () => 1000;
  const replies = makeReplies(6);
  const fetchImpl = okFetch(replies);
  const responses = [];
  const bg = createBackground({
    storage,
    now,
    fetchImpl,
    sleepImpl: () => {},
    onResponse: (r) => responses.push(r),
  });
  const res = await bg.handleMessage({
    type: "rb:score-request",
    handle: "h",
    token: bg.token,
  });
  assert.equal(res.result.state, "result");
  assert.equal(responses.length, 1);
});

test("createBackground: an explicit token does not shadow the resolver", async () => {
  // Precedence must be visible: whatever rb:config serves is what bg.token
  // exposes, so an explicit token cannot linger as a second value.
  const bg = createBackground({
    token: "explicit-token",
    resolveToken: () => Promise.resolve("resolved-token"),
  });
  assert.equal(bg.token, null);
  const res = await bg.handleMessage({ type: "rb:config" });
  assert.equal(res.token, "resolved-token");
});

test("background: (c2) partial replies on network failure -> estimated", async () => {
  const storage = makeStorage();
  const now = () => 1000;
  const replies = makeReplies(6);
  const r = await handleScoreRequest("h", {
    storage,
    now,
    sleepImpl: () => {},
    fetchReplies: () => ({ ok: false, reason: "network", replies }),
  });
  assert.equal(r.state, "estimated");
  assert.equal(r.heuristic, true);
  assert.ok(r.band);
});

test("background: (c3) malformed with zero replies -> error", async () => {
  const storage = makeStorage();
  const now = () => 1000;
  const r = await handleScoreRequest("h", {
    storage,
    now,
    sleepImpl: () => {},
    fetchReplies: () => ({ ok: false, reason: "malformed", replies: [] }),
  });
  assert.equal(r.state, "error");
});

test("background: (c4) malformed with 8 replies -> estimated", async () => {
  const storage = makeStorage();
  const now = () => 1000;
  const replies = makeReplies(8);
  const r = await handleScoreRequest("h", {
    storage,
    now,
    sleepImpl: () => {},
    fetchReplies: () => ({ ok: false, reason: "malformed", replies }),
  });
  assert.equal(r.state, "estimated");
  assert.equal(r.heuristic, true);
});

test("background: unavailable with 6 replies -> estimated", async () => {
  const storage = makeStorage();
  const now = () => 1000;
  const replies = makeReplies(6);
  const r = await handleScoreRequest("h", {
    storage,
    now,
    sleepImpl: () => {},
    fetchReplies: () => ({ ok: false, reason: "unavailable", replies }),
  });
  assert.equal(r.state, "estimated");
  assert.equal(r.heuristic, true);
  assert.ok(r.band);
});

test("background: unavailable with 3 replies -> insufficient", async () => {
  const storage = makeStorage();
  const now = () => 1000;
  const replies = makeReplies(3);
  const r = await handleScoreRequest("h", {
    storage,
    now,
    sleepImpl: () => {},
    fetchReplies: () => ({ ok: false, reason: "unavailable", replies }),
  });
  assert.equal(r.state, "insufficient");
});

test("background: unavailable with no replies -> error", async () => {
  const storage = makeStorage();
  const now = () => 1000;
  const r = await handleScoreRequest("h", {
    storage,
    now,
    sleepImpl: () => {},
    fetchReplies: () => ({ ok: false, reason: "unavailable", replies: [] }),
  });
  assert.equal(r.state, "error");
});

test("background: a missing account keeps the error state", async () => {
  const storage = makeStorage();
  const now = () => 1000;
  const r = await handleScoreRequest("h", {
    storage,
    now,
    sleepImpl: () => {},
    fetchReplies: () => ({ ok: false, reason: "not_found", replies: [] }),
  });
  assert.equal(r.state, "error");
});

test("background: (d) fewer than 5 replies -> insufficient", async () => {
  const storage = makeStorage();
  const now = () => 1000;
  const replies = makeReplies(3);
  const r = await handleScoreRequest("h", {
    storage,
    now,
    sleepImpl: () => {},
    fetchReplies: () => ({ ok: true, replies }),
  });
  assert.equal(r.state, "insufficient");
  assert.equal(r.percent, null);
});

test("background: (f) quota exceeded keeps band (proxy mode)", async () => {
  const storage = makeStorage();
  const replies = makeReplies(6);
  // Pre-fill the daily counter to the limit.
  const key = "stats:1970-01-01";
  storage.set(key, MAX_DAILY_PROFILES);
  const r = await handleScoreRequest("h", {
    storage,
    now: () => 0,
    sleepImpl: () => {},
    fetchReplies: () => ({ ok: true, replies }),
    limit: MAX_DAILY_PROFILES,
    // The local cap gates proxy mode only; the AI call is a spy so no
    // network happens in the test.
    settings: {
      mode: "proxy",
      consentAccepted: true,
      proxyUrl: "https://example.test/analyze",
    },
    analyzeWithAi: () =>
      Promise.resolve({ band: "medium", percent: 66, model: "spy" }),
  });
  assert.equal(r.state, "quota");
  assert.ok(r.band);
  assert.equal(r.heuristic, false);
});

test("background: (f2) local quota does not gate heuristic mode", async () => {
  const storage = makeStorage();
  const replies = makeReplies(6);
  const key = "stats:1970-01-01";
  storage.set(key, MAX_DAILY_PROFILES);
  const r = await handleScoreRequest("h", {
    storage,
    now: () => 0,
    sleepImpl: () => {},
    fetchReplies: () => ({ ok: true, replies }),
    limit: MAX_DAILY_PROFILES,
    settings: { mode: "heuristic" },
  });
  assert.equal(r.state, "result");
});

test("background: (i) handleMessage single makeScoreResponse", async () => {
  const storage = makeStorage();
  const now = () => 1000;
  const replies = makeReplies(6);
  const responses = [];
  const bg = createBackground({
    storage,
    now,
    sleepImpl: () => {},
    fetchReplies: () => ({ ok: true, replies }),
    onResponse: (r) => responses.push(r),
  });
  const res = await bg.handleMessage({
    type: "rb:score-request",
    handle: "h",
    token: bg.token,
  });
  assert.equal(res.result.state, "result");
  assert.equal(responses.length, 1);
});
