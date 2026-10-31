import { test } from "node:test";
import assert from "node:assert/strict";

import { handleScoreRequest } from "../../src/background/index.js";

function makeReplies(count = 10) {
  return Array.from({ length: count }, (_, i) => ({
    id: `r-${i}`,
    text: `Reply text number ${i}`,
    lang: "tr",
    targetScreenName: "target",
    parentStatusId: null,
    likes: 1,
    createdAt: 1000 + i,
  }));
}

test("orchestration-ai: AI success + showNumber: false -> percent: null", async () => {
  const mockAnalyzeAi = () =>
    Promise.resolve({
      band: "high",
      percent: 87,
      score: 0.87,
      model: "clef",
    });

  const res = await handleScoreRequest("alice", {
    fetchReplies: () => Promise.resolve({ ok: true, replies: makeReplies(10) }),
    analyzeWithAi: mockAnalyzeAi,
    settings: { mode: "proxy", proxyEnabled: true, consentAccepted: true },
    config: { showNumber: false },
    skipCache: true,
  });

  assert.equal(res.state, "result");
  assert.equal(res.band, "high");
  assert.equal(res.percent, null);
  assert.equal(res.model, "clef");
});

test("orchestration-ai: AI success + showNumber: true -> percent is rounded integer", async () => {
  const mockAnalyzeAi = () =>
    Promise.resolve({
      band: "medium",
      percent: 57,
      score: 0.567,
      model: "clef",
    });

  const res = await handleScoreRequest("bob", {
    fetchReplies: () => Promise.resolve({ ok: true, replies: makeReplies(10) }),
    analyzeWithAi: mockAnalyzeAi,
    settings: { mode: "proxy", proxyEnabled: true, consentAccepted: true },
    config: { showNumber: true },
    skipCache: true,
  });

  assert.equal(res.state, "result");
  assert.equal(res.band, "medium");
  assert.equal(res.percent, 57);
});

test("orchestration-ai: {fallback: 'heuristic'} -> keeps heuristic band and percent null", async () => {
  const mockAnalyzeAi = () => Promise.resolve({ fallback: "heuristic" });

  const res = await handleScoreRequest("charlie", {
    fetchReplies: () => Promise.resolve({ ok: true, replies: makeReplies(10) }),
    analyzeWithAi: mockAnalyzeAi,
    settings: { mode: "proxy", proxyEnabled: true, consentAccepted: true },
    config: { showNumber: true },
    skipCache: true,
  });

  assert.equal(res.state, "result");
  assert.ok(res.band); // heuristic band present
  assert.equal(res.percent, null);
  assert.equal(res.heuristic, true);
});

test("orchestration-ai: AI error / 502 -> retains heuristic band, never error", async () => {
  const mockAnalyzeAi = () => {
    return Promise.reject(new Error("502 Bad Gateway"));
  };

  const res = await handleScoreRequest("dave", {
    fetchReplies: () => Promise.resolve({ ok: true, replies: makeReplies(10) }),
    analyzeWithAi: mockAnalyzeAi,
    settings: { mode: "proxy", proxyEnabled: true, consentAccepted: true },
    config: { showNumber: true },
    skipCache: true,
  });

  assert.equal(res.state, "result");
  assert.ok(res.band);
  assert.equal(res.percent, null);
  assert.equal(res.heuristic, true);
});

test("orchestration-ai: Worker 429 -> state: 'quota' with heuristic band retained", async () => {
  const mockAnalyzeAi = () => Promise.resolve({ state: "quota" });

  const res = await handleScoreRequest("eve", {
    fetchReplies: () => Promise.resolve({ ok: true, replies: makeReplies(10) }),
    analyzeWithAi: mockAnalyzeAi,
    settings: { mode: "proxy", proxyEnabled: true, consentAccepted: true },
    config: { showNumber: true },
    skipCache: true,
  });

  assert.equal(res.state, "quota");
  assert.ok(res.band); // heuristic band retained
  assert.equal(res.percent, null);
});

test("orchestration-ai: AI failure must never erase an existing result from the cache", async () => {
  let cachedEntry = {
    state: "result",
    band: "high",
    percent: 85,
    heuristic: false,
    fetchedAt: 1000,
  };

  const fakeCache = {
    get() {
      return Promise.resolve({ value: cachedEntry, stale: false });
    },
    set(_key, val) {
      cachedEntry = val;
      return Promise.resolve();
    },
  };

  const mockAnalyzeAi = () => {
    return Promise.reject(new Error("502 ai_unavailable"));
  };

  // Normal request hits cache
  const res = await handleScoreRequest("frank", {
    cache: fakeCache,
    analyzeWithAi: mockAnalyzeAi,
    settings: { mode: "proxy", consentAccepted: true },
  });

  assert.equal(res.state, "result");
  assert.equal(res.band, "high");
  assert.equal(res.percent, 85);
});
