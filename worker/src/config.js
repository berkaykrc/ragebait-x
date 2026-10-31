// Worker proxy configuration.
//
// Shared defaults mirror the extension-side constants in src/config.js and
// selector definitions in src/page/hovercard.js.

export const MODEL_VERSION = "h1";
export const FEATURE_VERSION = "f1";

export const DEFAULT_PROXY_URL =
  "https://ragebait-proxy.dontseemyass.workers.dev/analyze";

export const SELECTORS = {
  layers: "#layers",
  hoverCard: '[data-testid="HoverCard"]',
  avatarContainer: 'div[data-testid^="UserAvatar-Container"]',
  followingLink: '[href$="/following"]',
};

/**
 * Builds the public configuration returned by GET /config.
 *
 * @param {Record<string, unknown> | null | undefined} env
 * @returns {{
 *   modelVersion: string,
 *   featureVersion: string,
 *   bandThresholds: { high: number, medium: number },
 *   selectors: Record<string, string>,
 *   showNumber: boolean,
 *   proxyUrl: string,
 *   proxyEnabled: boolean,
 * }}
 */
export function buildConfig(env) {
  const safeEnv = env && typeof env === "object" ? env : {};

  const high = safeEnv.BAND_HIGH !== undefined
    ? Number(safeEnv.BAND_HIGH)
    : 0.75;
  const medium = safeEnv.BAND_MEDIUM !== undefined
    ? Number(safeEnv.BAND_MEDIUM)
    : 0.45;

  const proxyEnabled = safeEnv.PROXY_ENABLED === "true" ||
    safeEnv.PROXY_ENABLED === true;

  const showNumber = safeEnv.SHOW_NUMBER === "true" ||
    safeEnv.SHOW_NUMBER === true;

  const modelVersion = typeof safeEnv.MODEL_VERSION === "string" &&
      safeEnv.MODEL_VERSION.length > 0
    ? safeEnv.MODEL_VERSION
    : MODEL_VERSION;

  const featureVersion = typeof safeEnv.FEATURE_VERSION === "string" &&
      safeEnv.FEATURE_VERSION.length > 0
    ? safeEnv.FEATURE_VERSION
    : FEATURE_VERSION;

  const proxyUrl = typeof safeEnv.PROXY_URL === "string" &&
      safeEnv.PROXY_URL.length > 0
    ? safeEnv.PROXY_URL
    : DEFAULT_PROXY_URL;

  return {
    modelVersion,
    featureVersion,
    bandThresholds: {
      high,
      medium,
    },
    selectors: { ...SELECTORS },
    showNumber,
    proxyUrl,
    proxyEnabled,
  };
}

const HIGH_LABELS = new Set(["ragebait", "high", true, 1]);

function isHighLabel(label) {
  return HIGH_LABELS.has(label);
}

/**
 * Precision-first threshold selection on the tune split.
 * Returns the threshold (a value from `tuneScores`) that maximises recall
 * among candidates with high-band precision >= minPrecision. Ties break to
 * the lowest threshold. Returns null if no candidate meets the gate.
 */
export function pickHighThreshold(tuneScores, tuneLabels, minPrecision = 0.9) {
  const scores = Array.isArray(tuneScores) ? tuneScores : [];
  const labels = Array.isArray(tuneLabels) ? tuneLabels : [];
  const n = Math.min(scores.length, labels.length);
  if (n === 0) return null;

  const candidates = [...new Set(scores.slice(0, n))].sort((a, b) => a - b);

  let best = null; // { threshold, recall }
  for (const threshold of candidates) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (let i = 0; i < n; i++) {
      const predictedHigh = scores[i] >= threshold;
      const actualHigh = isHighLabel(labels[i]);
      if (predictedHigh && actualHigh) tp++;
      else if (predictedHigh && !actualHigh) fp++;
      else if (!predictedHigh && actualHigh) fn++;
    }
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    if (precision >= minPrecision) {
      if (
        best === null ||
        recall > best.recall ||
        (recall === best.recall && threshold < best.threshold)
      ) {
        best = { threshold, recall };
      }
    }
  }

  return best ? best.threshold : null;
}

export function highBandPrecision(scores, labels, threshold) {
  const n = Math.min(scores.length, labels.length);
  if (n === 0) return 0;
  let tp = 0;
  let fp = 0;
  for (let i = 0; i < n; i++) {
    const predictedHigh = scores[i] >= threshold;
    const actualHigh = isHighLabel(labels[i]);
    if (predictedHigh && actualHigh) tp++;
    else if (predictedHigh && !actualHigh) fp++;
  }
  return tp + fp === 0 ? 1 : tp / (tp + fp);
}

export function shouldFlipShowNumber(
  heldOutEce,
  heldOutPrecision,
  minPrecision = 0.9,
  maxEce = 0.1,
) {
  return (
    typeof heldOutEce === "number" &&
    typeof heldOutPrecision === "number" &&
    heldOutEce <= maxEce &&
    heldOutPrecision >= minPrecision
  );
}
