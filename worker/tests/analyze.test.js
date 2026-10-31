import { test } from "node:test";
import assert from "node:assert/strict";

import { buildQuestionSet } from "../src/questions.js";
import { analyze } from "../src/analyze.js";

const VALID_STATE = {
  handle: "testuser",
  features: {
    replyCount: 15,
    capsRatio: 0.1,
    rhetoricalQuestionRatio: 0.2,
    hashtagDensity: 0.05,
    lexiconHits: 1,
    likesPerReply: 3.5,
    burstRatio: 0.2,
    langSupported: true,
  },
  replySample: ["First reply text", "Second provocative reply"],
};

const MOCK_ANSWERS = {
  is_provocative: { noul: 0.8 },
  is_engagement_bait: { noul: 0.7 },
  targets_group_identity: { noul: 0.2 },
  reply_farms_opponents: { noul: 0.1 },
  intensity: {
    score: 0.75,
    legend: "provocative",
    probabilities: [0.1, 0.7, 0.2],
    confidence: 0.85,
  },
};

test("questions: payload carries exactly the 5 questions with correct types and NO topic", () => {
  const payload = buildQuestionSet(VALID_STATE);

  assert.equal("topic" in payload.questions, false);
  const qKeys = Object.keys(payload.questions).sort();
  assert.deepEqual(qKeys, [
    "intensity",
    "is_engagement_bait",
    "is_provocative",
    "reply_farms_opponents",
    "targets_group_identity",
  ]);

  assert.equal(payload.questions.is_provocative.type, "noul");
  assert.equal(payload.questions.is_engagement_bait.type, "noul");
  assert.equal(payload.questions.targets_group_identity.type, "noul");
  assert.equal(payload.questions.reply_farms_opponents.type, "noul");
  assert.equal(payload.questions.intensity.type, "score");
});

test("questions: trims reply sample to max 12 items and 400 chars each", () => {
  const largeSample = Array.from(
    { length: 20 },
    (_, i) => `Reply ${i}: ${"a".repeat(500)}`,
  );
  const stateWithLargeSample = { ...VALID_STATE, replySample: largeSample };
  const payload = buildQuestionSet(stateWithLargeSample);

  assert.equal(payload.state.replySample.length, 12);
  for (const item of payload.state.replySample) {
    assert.ok(item.length <= 400);
  }
});

test("analyze: rejects missing state with 400 and named reason", async () => {
  const res = await analyze({}, {});
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /missing or invalid state/i);
});

test("analyze: rejects state without features with 400 and named reason", async () => {
  const res = await analyze({ state: { handle: "foo" } }, {});
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /features/i);
});

test("analyze: Clef success -> 200 + answers + model: 'clef'", async () => {
  let outboundBody = null;
  const mockFetch = (_url, options) => {
    outboundBody = JSON.parse(options.body);
    return Promise.resolve(
      new Response(JSON.stringify({ answers: MOCK_ANSWERS }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const res = await analyze(
    { state: VALID_STATE, installToken: "tok-123" },
    { CLOUDFLARE_ACCOUNT_ID: "acct-test", CLEF_API_KEY: "cf-token" },
    mockFetch,
  );

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.model, "clef");
  assert.deepEqual(data.answers, MOCK_ANSWERS);
  assert.ok(outboundBody.questions.is_provocative);
  assert.equal("topic" in outboundBody.questions, false);
});

test("analyze: Clef 529/5xx -> Jev fallback called, model: 'jev'", async () => {
  const calls = [];
  const mockFetch = (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      // Clef failure (529 overloaded)
      return Promise.resolve(new Response("Overloaded", { status: 529 }));
    }
    // Jev success
    return Promise.resolve(
      new Response(JSON.stringify({ answers: MOCK_ANSWERS }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const res = await analyze(
    { state: VALID_STATE, installToken: "tok-123" },
    {
      CLOUDFLARE_ACCOUNT_ID: "acct-test",
      CLEF_API_KEY: "cf-token",
      TYPESAFE_API_KEY: "jev-key",
    },
    mockFetch,
  );

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.model, "jev");
  assert.deepEqual(data.answers, MOCK_ANSWERS);
  assert.equal(calls.length, 2);
});

test("analyze: both Clef and Jev fail -> 502 with ai_unavailable", async () => {
  const mockFetch = () => {
    return Promise.resolve(new Response("Error", { status: 500 }));
  };

  const res = await analyze(
    { state: VALID_STATE, installToken: "tok-123" },
    {
      CLOUDFLARE_ACCOUNT_ID: "acct-test",
      CLEF_API_KEY: "cf-token",
      TYPESAFE_API_KEY: "jev-key",
    },
    mockFetch,
  );

  assert.equal(res.status, 502);
  const data = await res.json();
  assert.equal(data.error, "ai_unavailable");
});

test("analyze: noul answers arrive as {noul: number} objects", async () => {
  const mockFetch = () => {
    return Promise.resolve(
      new Response(JSON.stringify({ answers: MOCK_ANSWERS }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const res = await analyze(
    { state: VALID_STATE, installToken: "tok-123" },
    { CLOUDFLARE_ACCOUNT_ID: "acct-test", CLEF_API_KEY: "cf-token" },
    mockFetch,
  );

  const data = await res.json();
  assert.equal(typeof data.answers.is_provocative.noul, "number");
  assert.equal(typeof data.answers.is_engagement_bait.noul, "number");
});
