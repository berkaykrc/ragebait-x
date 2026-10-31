// Extension response mapper for AI scoring.
//
// PLACEHOLDER weights pending Task 18 calibration:
// is_provocative: 0.3, is_engagement_bait: 0.3, targets_group_identity: 0.2, reply_farms_opponents: 0.2.
// Intensity is recorded for audit/calibration but is NOT a multiplier in v1.

export const NOUL_WEIGHTS = {
  is_provocative: 0.3,
  is_engagement_bait: 0.3,
  targets_group_identity: 0.2,
  reply_farms_opponents: 0.2,
};

export const DEFAULT_THRESHOLDS = {
  high: 0.75,
  medium: 0.45,
};

/**
 * Maps the AI question answers to a single composite score and band.
 * Renormalises weights over present answers so missing answers never produce NaN.
 *
 * @param {Record<string, { noul?: number } | unknown>} answers
 * @param {{ high: number, medium: number }} [thresholds]
 * @returns {{ score: number, band: "high" | "medium" | "low" }}
 */
export function mapNoulToScore(answers, thresholds = DEFAULT_THRESHOLDS) {
  if (!answers || typeof answers !== "object") {
    return { score: 0, band: "low" };
  }

  let totalWeightedScore = 0;
  let totalPresentWeight = 0;

  for (const [key, weight] of Object.entries(NOUL_WEIGHTS)) {
    const ans = answers[key];
    if (ans && typeof ans === "object" && typeof ans.noul === "number") {
      const val = Math.max(0, Math.min(1, ans.noul));
      totalWeightedScore += weight * val;
      totalPresentWeight += weight;
    }
  }

  if (totalPresentWeight === 0) {
    return { score: 0, band: "low" };
  }

  const score = totalWeightedScore / totalPresentWeight;
  const highCut = typeof thresholds?.high === "number"
    ? thresholds.high
    : DEFAULT_THRESHOLDS.high;
  const medCut = typeof thresholds?.medium === "number"
    ? thresholds.medium
    : DEFAULT_THRESHOLDS.medium;

  let band = "low";
  if (score >= highCut) {
    band = "high";
  } else if (score >= medCut) {
    band = "medium";
  }

  return { score, band };
}
