import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import process from "node:process";

import { composeScore } from "../src/analysis/compose.js";

const BANDS = ["low", "medium", "high"];
const LABEL_TO_BAND = { normal: "low", ambiguous: "medium", ragebait: "high" };

function scoreOf(row) {
  if (typeof row?.score === "number") return row.score;
  if (row?.features) {
    const c = composeScore(row.features);
    if (c && typeof c.score === "number") return c.score;
  }
  return 0;
}

function bandFor(score, thresholds) {
  const high = thresholds?.high ?? 0.75;
  const medium = thresholds?.medium ?? 0.45;
  if (score >= high) return "high";
  if (score >= medium) return "medium";
  return "low";
}

function expectedBand(row) {
  if (row?.expectedBand) return row.expectedBand;
  if (row?.label && LABEL_TO_BAND[row.label]) return LABEL_TO_BAND[row.label];
  return null;
}

function wilsonCI(successes, n, z = 1.96) {
  if (n === 0) return { lower: 0, upper: 1 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return {
    lower: (centre - half) / denom,
    upper: (centre + half) / denom,
  };
}

export function evaluate(dataset, thresholds = { high: 0.75, medium: 0.45 }) {
  const rows = Array.isArray(dataset) ? dataset : [];
  const scored = rows.map((r) => {
    const score = scoreOf(r);
    const predicted = bandFor(score, thresholds);
    const actual = expectedBand(r);
    return { row: r, score, predicted, actual };
  });

  // confusion[predicted][actual]
  const confusion = {};
  for (const b of BANDS) {
    confusion[b] = {};
    for (const a of BANDS) confusion[b][a] = 0;
  }
  for (const s of scored) {
    if (s.actual && confusion[s.predicted]) {
      confusion[s.predicted][s.actual] =
        (confusion[s.predicted][s.actual] || 0) + 1;
    }
  }

  const perBand = {};
  for (const b of BANDS) {
    const tp = scored.filter((s) => s.predicted === b && s.actual === b).length;
    const fp = scored.filter((s) => s.predicted === b && s.actual !== b).length;
    const fn = scored.filter((s) => s.predicted !== b && s.actual === b).length;
    const support = scored.filter((s) => s.actual === b).length;
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    perBand[b] = {
      precision,
      recall,
      support,
      tp,
      fp,
      fn,
      wilsonCI: wilsonCI(tp, tp + fp),
    };
  }

  // reliability buckets (10 bins)
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    bucket: i,
    range: [i / 10, (i + 1) / 10],
    n: 0,
    confSum: 0,
    accSum: 0,
  }));
  for (const s of scored) {
    const idx = Math.min(9, Math.floor(s.score * 10));
    const b = buckets[idx];
    b.n += 1;
    b.confSum += s.score;
    b.accSum += s.predicted === s.actual ? 1 : 0;
  }
  const reliabilityBuckets = buckets.map((b) => ({
    bucket: b.bucket,
    range: b.range,
    n: b.n,
    avgConf: b.n ? b.confSum / b.n : 0,
    avgAcc: b.n ? b.accSum / b.n : 0,
  }));

  // ECE
  const n = scored.length || 1;
  let ece = 0;
  for (const b of reliabilityBuckets) {
    if (b.n === 0) continue;
    ece += (b.n / n) * Math.abs(b.avgConf - b.avgAcc);
  }

  // Krippendorff alpha on double-labelled subset
  const doubleLabelled = scored.filter((s) => s.row?.label2 != null);
  let krippendorffAlpha = null;
  const alphaN = doubleLabelled.length;
  if (alphaN > 0) {
    const mismatches = doubleLabelled.filter((s) =>
      s.row.label !== s.row.label2
    ).length;
    const Do = mismatches / alphaN;
    // expected disagreement from pooled categories
    const counts = {};
    for (const s of doubleLabelled) {
      counts[s.row.label] = (counts[s.row.label] || 0) + 1;
      counts[s.row.label2] = (counts[s.row.label2] || 0) + 1;
    }
    const total = alphaN * 2;
    let sumSq = 0;
    for (const c of Object.values(counts)) {
      sumSq += (c / total) ** 2;
    }
    const De = 1 - sumSq;
    krippendorffAlpha = De === 0 ? 1 : 1 - Do / De;
  }

  return {
    n: scored.length,
    thresholds,
    perBand,
    confusion,
    ece,
    reliabilityBuckets,
    wilsonCI: Object.fromEntries(
      BANDS.map((b) => [b, perBand[b].wilsonCI]),
    ),
    krippendorffAlpha,
    alphaN,
  };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const inputPath = process.argv[2] || "data/labeled/dataset-tune.jsonl";
  const outPath = process.argv[3] ||
    `docs/calibration/report-${new Date().toISOString().slice(0, 10)}.md`;
  let rows = [];
  try {
    const text = readFileSync(inputPath, "utf8");
    rows = text
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    rows = [];
  }
  const thresholds = { high: 0.75, medium: 0.45 };
  const res = evaluate(rows, thresholds);
  mkdirSync(outPath.split("/").slice(0, -1).join("/") || ".", {
    recursive: true,
  });
  const lines = [];
  lines.push(`# Calibration report`);
  lines.push("");
  lines.push(
    `n = ${res.n}, thresholds = ${JSON.stringify(res.thresholds)}, ECE = ${
      res.ece.toFixed(4)
    }`,
  );
  lines.push("");
  lines.push("## Per band");
  for (const b of BANDS) {
    const p = res.perBand[b];
    lines.push(
      `- ${b}: precision=${p.precision.toFixed(3)} recall=${
        p.recall.toFixed(3)
      } support=${p.support} Wilson=[${p.wilsonCI.lower.toFixed(3)},${
        p.wilsonCI.upper.toFixed(3)
      }]`,
    );
  }
  lines.push("");
  lines.push("## Krippendorff alpha");
  lines.push(`alpha=${res.krippendorffAlpha} n=${res.alphaN}`);
  writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  console.log(`wrote ${outPath}`);
}
