import { test } from "node:test";
import assert from "node:assert/strict";

import { composeScore } from "../../src/analysis/compose.js";

function baseFeatures(overrides = {}) {
  return {
    replyCount: 10,
    distinctTargets: 1,
    targetConcentration: null,
    repeatParentRatio: null,
    capsRatio: null,
    exclamationRatio: null,
    rhetoricalQuestionRatio: null,
    hashtagDensity: null,
    lexiconHits: null,
    likesPerReply: null,
    burstRatio: null,
    langSupported: true,
    ...overrides,
  };
}

test("compose: all weighted features at maximum score 1 and band high", () => {
  const f = baseFeatures({
    lexiconHits: 10,
    capsRatio: 1,
    rhetoricalQuestionRatio: 1,
    targetConcentration: 1,
    repeatParentRatio: 1,
    hashtagDensity: 1,
    likesPerReply: 1000,
  });
  const out = composeScore(f);
  assert.equal(out.score, 1);
  assert.equal(out.band, "high");
  assert.equal(out.heuristic, true);
});

test("compose: band thresholds at 0.75, 0.45 and the just-below values", () => {
  const high = composeScore(baseFeatures({ capsRatio: 0.75 }));
  assert.ok(Math.abs(high.score - 0.75) < 1e-12);
  assert.equal(high.band, "high");

  const justBelowHigh = composeScore(baseFeatures({ capsRatio: 0.7499 }));
  assert.ok(Math.abs(justBelowHigh.score - 0.7499) < 1e-12);
  assert.equal(justBelowHigh.band, "medium");

  const medium = composeScore(baseFeatures({ capsRatio: 0.45 }));
  assert.ok(Math.abs(medium.score - 0.45) < 1e-12);
  assert.equal(medium.band, "medium");

  const justBelowMedium = composeScore(baseFeatures({ capsRatio: 0.4499 }));
  assert.ok(Math.abs(justBelowMedium.score - 0.4499) < 1e-12);
  assert.equal(justBelowMedium.band, "low");
});

test("compose: zero counts as present, not absent", () => {
  const f = baseFeatures({
    lexiconHits: 10,
    capsRatio: 1,
    rhetoricalQuestionRatio: 1,
    targetConcentration: 1,
    repeatParentRatio: 0,
    exclamationRatio: 0,
    hashtagDensity: 0,
    likesPerReply: 0,
  });
  const out = composeScore(f);
  // (0.25 + 0.15 + 0.15 + 0.15) / 1.00 = 0.70
  assert.ok(Math.abs(out.score - 0.7) < 1e-12);
  assert.equal(out.band, "medium");
});

test("compose: fewer than MIN_REPLIES replies is insufficient", () => {
  const out = composeScore(baseFeatures({ replyCount: 4 }));
  assert.deepEqual(out, { insufficient: true });
});

test("compose: an absent lexicon renormalises the score", () => {
  const f = baseFeatures({
    capsRatio: 1,
    rhetoricalQuestionRatio: 1,
    targetConcentration: 1,
    repeatParentRatio: 1,
    hashtagDensity: 1,
    likesPerReply: 1000,
  });
  const out = composeScore(f);
  // numerator = 0.15 * 4 + 0.05 + 0.10 = 0.75, denominator = 0.75
  assert.equal(out.score, 1);
  assert.equal(out.band, "high");
});

test("compose: lexicon hits clamp at one and never exceed it", () => {
  const f = baseFeatures({
    lexiconHits: 12,
    capsRatio: 1,
    rhetoricalQuestionRatio: 1,
    targetConcentration: 1,
    repeatParentRatio: 1,
    hashtagDensity: 1,
    likesPerReply: 1000,
  });
  const out = composeScore(f);
  assert.equal(out.score, 1);
});
