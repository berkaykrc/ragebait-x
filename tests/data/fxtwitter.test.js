import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchReplies } from "../../src/data/fxtwitter.js";

function resp(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (headers[k] ?? headers[k.toLowerCase()] ?? null) },
    json() {
      if (body === "BROKEN") throw new Error("bad json");
      return body;
    },
  };
}

function makeReplies(n, start = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: String(start + i),
    text: "reply",
    lang: "tr",
    author: { screen_name: "h" },
    replying_to: { screen_name: "target" },
    likes: 1,
    replies: 0,
    views: 1,
    created_timestamp: 1,
  }));
}

test("fxtwitter: (a) 404 then 200 -> ok", async () => {
  let calls = 0;
  const fetchImpl = () => {
    calls += 1;
    if (calls === 1) return resp(404, { code: 404 });
    return resp(200, { results: makeReplies(1), cursor: {} });
  };
  const sleepImpl = () => {};
  const r = await fetchReplies("h", { fetchImpl, sleepImpl });
  assert.equal(r.ok, true);
});

test("fxtwitter: (b) 3x 404 -> not_found empty", async () => {
  const fetchImpl = () => resp(404, { code: 404 });
  const sleepImpl = async () => {};
  const r = await fetchReplies("h", { fetchImpl, sleepImpl });
  assert.deepEqual(r, { ok: false, reason: "not_found", replies: [] });
});

test("fxtwitter: (c) url + paging + missing cursor terminates", async () => {
  const urls = [];
  let calls = 0;
  const fetchImpl = (url) => {
    urls.push(url);
    calls += 1;
    if (calls === 1) {
      return resp(200, { results: makeReplies(2), cursor: { bottom: "c1" } });
    }
    if (calls === 2) {
      return resp(200, { results: makeReplies(3, 2), cursor: {} });
    }
    return resp(200, { results: [], cursor: {} });
  };
  const r = await fetchReplies("h", { fetchImpl, sleepImpl: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.replies.length, 5);
  assert.equal(calls, 2, "stops after >=5");
  assert.ok(urls[0].includes("count=40"));
  assert.ok(urls[0].includes("with_replies=true"));

  // missing cursor stops immediately
  const fetchImpl2 = () => resp(200, { results: makeReplies(1), cursor: {} });
  const r2 = await fetchReplies("h", {
    fetchImpl: fetchImpl2,
    sleepImpl: () => {},
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.replies.length, 1);
});

test("fxtwitter: (d) network throw -> network", async () => {
  const fetchImpl = () => {
    throw new Error("boom");
  };
  const r = await fetchReplies("h", { fetchImpl, sleepImpl: () => {} });
  assert.deepEqual(r, { ok: false, reason: "network", replies: [] });
});

test("fxtwitter: (e) broken json -> malformed", async () => {
  const fetchImpl = () => resp(200, "BROKEN");
  const r = await fetchReplies("h", { fetchImpl, sleepImpl: () => {} });
  assert.deepEqual(r, { ok: false, reason: "malformed", replies: [] });
});

test("fxtwitter: (f) 429 honours Retry-After", async () => {
  const sleeps = [];
  const fetchImpl = () => resp(429, { code: 429 }, { "Retry-After": "2" });
  const sleepImpl = (ms) => {
    sleeps.push(ms);
  };
  const r = await fetchReplies("h", { fetchImpl, sleepImpl });
  assert.deepEqual(r, { ok: false, reason: "rate_limit", replies: [] });
  assert.deepEqual(sleeps, [2000]);
});

test("fxtwitter: (g) 5xx -> network", async () => {
  const fetchImpl = () => resp(500, { code: 500 });
  const r = await fetchReplies("h", { fetchImpl, sleepImpl: () => {} });
  assert.deepEqual(r, { ok: false, reason: "network", replies: [] });
});

test("fxtwitter: (h) 5xx page2 keeps page1 replies", async () => {
  let calls = 0;
  const fetchImpl = () => {
    calls += 1;
    if (calls === 1) {
      return resp(200, { results: makeReplies(2), cursor: { bottom: "c1" } });
    }
    return resp(500, { code: 500 });
  };
  const r = await fetchReplies("h", { fetchImpl, sleepImpl: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "network");
  assert.equal(r.replies.length, 2);
});

test("fxtwitter: (i) aborted signal -> network with collected replies", async () => {
  let calls = 0;
  const controller = new AbortController();
  const fetchImpl = (_url, _opts) => {
    calls += 1;
    if (calls === 1) {
      return resp(200, { results: makeReplies(2), cursor: { bottom: "c1" } });
    }
    // simulate abort on second
    controller.abort();
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  };
  const r = await fetchReplies("h", {
    fetchImpl,
    sleepImpl: () => {},
    signal: controller.signal,
  });
  // first page already collected 2
  assert.equal(r.ok, false);
  assert.equal(r.reason, "network");
  assert.equal(r.replies.length, 2);
});
