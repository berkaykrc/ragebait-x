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
    replying_to: { screen_name: "target", status: "parent" },
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

test("fxtwitter: (b) a missing account -> not_found empty", async () => {
  // The profile endpoint is the only place that says "User not found".
  const fetchImpl = (url) => {
    if (url.includes("/statuses")) {
      return resp(404, {
        code: 404,
        results: [],
        cursor: { top: null, bottom: null },
      });
    }
    return resp(404, { code: 404, message: "User not found" });
  };
  const sleepImpl = async () => {};
  const r = await fetchReplies("h", { fetchImpl, sleepImpl });
  assert.deepEqual(r, { ok: false, reason: "not_found", replies: [] });
});

test("fxtwitter: (k) an empty 404 body -> unavailable, not not_found", async () => {
  // FxTwitter answers 404 with an empty body when it cannot read the
  // timeline. The account itself exists, so the reason is "unavailable".
  const urls = [];
  const fetchImpl = (url) => {
    urls.push(url);
    if (url.includes("/statuses")) {
      return resp(404, {
        code: 404,
        results: [],
        cursor: { top: null, bottom: null },
      });
    }
    return resp(200, { code: 200, user: { screen_name: "h" } });
  };
  const r = await fetchReplies("h", { fetchImpl, sleepImpl: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unavailable");
  assert.deepEqual(r.replies, []);
  assert.ok(
    urls.some((u) => u.endsWith("/2/profile/h")),
    "the profile endpoint was asked whether the account exists",
  );
});

test("fxtwitter: (l) an empty 404 on page 2 keeps the page 1 replies", async () => {
  let calls = 0;
  const fetchImpl = (url) => {
    if (!url.includes("/statuses")) {
      return resp(200, { code: 200, user: { screen_name: "h" } });
    }
    calls += 1;
    if (calls === 1) {
      return resp(200, { results: makeReplies(2), cursor: { bottom: "c1" } });
    }
    return resp(404, {
      code: 404,
      results: [],
      cursor: { top: null, bottom: null },
    });
  };
  const r = await fetchReplies("h", { fetchImpl, sleepImpl: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unavailable");
  assert.equal(r.replies.length, 2);
});

test("fxtwitter: (m) a 200 body with code 404 is not ok", async () => {
  // The docs say every response carries `code`. A body reporting an error
  // while the transport says 200 must be treated as that error, not as ok.
  const fetchImpl = (url) => {
    if (url.includes("/statuses")) {
      return resp(200, {
        code: 404,
        results: [],
        cursor: { top: null, bottom: null },
      });
    }
    return resp(404, { code: 404, message: "User not found" });
  };
  const r = await fetchReplies("h", { fetchImpl, sleepImpl: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not_found");
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

test("fxtwitter: (j) sleeperFactory cleans up abort listener when sleep wins", async () => {
  const controller = new AbortController();
  let addCount = 0;
  let removeCount = 0;
  const origAdd = controller.signal.addEventListener.bind(controller.signal);
  const origRemove = controller.signal.removeEventListener.bind(
    controller.signal,
  );
  controller.signal.addEventListener = (...args) => {
    addCount += 1;
    return origAdd(...args);
  };
  controller.signal.removeEventListener = (...args) => {
    removeCount += 1;
    return origRemove(...args);
  };

  let calls = 0;
  const fetchImpl = () => {
    calls += 1;
    if (calls === 1) return resp(404, { code: 404 });
    return resp(200, { results: makeReplies(1), cursor: {} });
  };
  const sleepImpl = async () => {};
  const r = await fetchReplies("h", {
    fetchImpl,
    sleepImpl,
    signal: controller.signal,
  });

  assert.equal(r.ok, true);
  assert.ok(addCount > 0, "abort listener was attached during sleep");
  assert.equal(
    removeCount,
    addCount,
    "abort listener was removed when sleep won",
  );
});
