// Score composition (plan Part 2, Task 5).
//
// Weighted sum over the present features, renormalised over the present
// weights, clamped to [0, 1]. "Present" means the feature value is a number —
// never null — so a zero is present and contributes nothing.
//
// The initial weights are PLACEHOLDER pending Task 18 (calibration); they are
// marked as such here and are not final. `exclamationRatio` is computed by
// features.js but deliberately carries no weight in v1 (plan D9).

export const MIN_REPLIES = 5;

const HIGH_THRESHOLD = 0.75;
const MEDIUM_THRESHOLD = 0.45;

/** Initial weights (sum = 1). The exclamationRatio feature is intentionally
 * absent from this table. */
const FEATURES = [
  {
    key: "lexiconHits",
    weight: 0.25,
    // lexiconHits / (0.5 * replyCount), clamped to 1.
    normalise(value, replyCount) {
      return Math.min(1, value / (0.5 * replyCount));
    },
  },
  { key: "capsRatio", weight: 0.15 },
  { key: "rhetoricalQuestionRatio", weight: 0.15 },
  { key: "targetConcentration", weight: 0.15 },
  { key: "repeatParentRatio", weight: 0.15 },
  {
    key: "hashtagDensity",
    weight: 0.05,
    // hashtagDensity / 0.25, clamped to 1.
    normalise(value) {
      return Math.min(1, value / 0.25);
    },
  },
  {
    key: "likesPerReply",
    weight: 0.10,
    // log1p(likesPerReply) / log1p(500), clamped to 1.
    normalise(value) {
      return Math.min(1, Math.log1p(value) / Math.log1p(500));
    },
  },
];

/** Band from the clamped score (plan Part 1 D6, half-open intervals). */
function bandOf(score) {
  if (score >= HIGH_THRESHOLD) return "high";
  if (score >= MEDIUM_THRESHOLD) return "medium";
  return "low";
}

/**
 * @param {object} features
 *   The 12-key vector returned by computeFeatures.
 * @returns {{score:number,band:'low'|'medium'|'high',heuristic:true}|{insufficient:true}}
 */
export function composeScore(features) {
  const f = features ?? {};
  const replyCount = typeof f.replyCount === "number" ? f.replyCount : 0;
  if (replyCount < MIN_REPLIES) return { insufficient: true };

  let presentWeight = 0;
  let weightedSum = 0;
  for (const feature of FEATURES) {
    const raw = f[feature.key];
    if (typeof raw !== "number") continue; // absent (null)
    const value = feature.normalise ? feature.normalise(raw, replyCount) : raw;
    presentWeight += feature.weight;
    weightedSum += feature.weight * value;
  }

  const score = presentWeight === 0
    ? 0
    : Math.max(0, Math.min(1, weightedSum / presentWeight));

  return { score, band: bandOf(score), heuristic: true };
}
