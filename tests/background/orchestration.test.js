import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cancelScoreRequest,
  createBackground,
  handleScoreRequest,
} from "../../src/background/index.js";
import { makeScoreResponse, MSG } from "../../src/background/protocol.js";
import { consumeDailyProfile } from "../../src/background/quota-local.js";
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
          replying_to: { screen_name: "target" },
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
          replying_to: { screen_name: "target" },
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
