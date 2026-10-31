import { test } from "node:test";
import assert from "node:assert/strict";

import { mapNoulToScore } from "../../src/ai/map-response.js";

test("map-response: weighted score calculation (a)", () => {
  // 0.3*0.9 + 0.3*0.8 + 0.2*0.2 + 0.2*0.1 = 0.27 + 0.24 + 0.04 + 0.02 = 0.57
  const answers = {
    is_provocative: { noul: 0.9 },
    is_engagement_bait: { noul: 0.8 },
    targets_group_identity: { noul: 0.2 },
    reply_farms_opponents: { noul: 0.1 },
  };

  const { score, band } = mapNoulToScore(answers, { high: 0.75, medium: 0.45 });
  assert.equal(Math.round(score * 100) / 100, 0.57);
  assert.equal(band, "medium");
});

test("map-response: all 1.0 -> score 1.0 -> high (b)", () => {
  const answers = {
    is_provocative: { noul: 1.0 },
    is_engagement_bait: { noul: 1.0 },
    targets_group_identity: { noul: 1.0 },
    reply_farms_opponents: { noul: 1.0 },
  };

  const { score, band } = mapNoulToScore(answers, { high: 0.75, medium: 0.45 });
  assert.equal(score, 1.0);
  assert.equal(band, "high");
});

test("map-response: missing noul answer renormalises weights without NaN (c)", () => {
  // Only is_provocative (0.3) and is_engagement_bait (0.3) present
  // score = (0.3*0.6 + 0.3*0.4) / (0.3 + 0.3) = 0.30 / 0.60 = 0.50
  const answers = {
    is_provocative: { noul: 0.6 },
    is_engagement_bait: { noul: 0.4 },
  };

  const { score, band } = mapNoulToScore(answers, { high: 0.75, medium: 0.45 });
  assert.equal(score, 0.5);
  assert.equal(band, "medium");
});

test("map-response: thresholds come from argument, not hardcoded (i)", () => {
  const answers = {
    is_provocative: { noul: 0.6 },
    is_engagement_bait: { noul: 0.6 },
    targets_group_identity: { noul: 0.6 },
    reply_farms_opponents: { noul: 0.6 },
  };

  // With high=0.55, 0.60 is high
  const res1 = mapNoulToScore(answers, { high: 0.55, medium: 0.35 });
  assert.equal(res1.band, "high");

  // With high=0.75, 0.60 is medium
  const res2 = mapNoulToScore(answers, { high: 0.75, medium: 0.45 });
  assert.equal(res2.band, "medium");
});
