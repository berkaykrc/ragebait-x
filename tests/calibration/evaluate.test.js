import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluate } from "../../scripts/evaluate-calibration.mjs";

function makeRows() {
  const rows = [];
  // 10 ragebait -> high scores
  for (let i = 0; i < 10; i++) {
    rows.push({
      handle: `r${i}`,
      label: "ragebait",
      score: 0.9,
      label2: i < 4 ? "ragebait" : null,
      annotator2: i < 4 ? "a2" : null,
    });
  }
  // 10 normal -> low scores
  for (let i = 0; i < 10; i++) {
    rows.push({
      handle: `n${i}`,
      label: "normal",
      score: 0.1,
      label2: i < 3 ? "normal" : null,
      annotator2: i < 3 ? "a2" : null,
    });
  }
  return rows;
}

test("evaluate: high-band precision high on synthetic data", () => {
  const res = evaluate(makeRows(), { high: 0.75, medium: 0.45 });
  assert.ok(res.perBand.high.precision >= 0.9);
  assert.ok(res.perBand.high.recall >= 0.9);
});

test("evaluate: ECE in [0,1]", () => {
  const res = evaluate(makeRows(), { high: 0.75, medium: 0.45 });
  assert.ok(res.ece >= 0 && res.ece <= 1);
});

test("evaluate: confusion matrix sums to row totals", () => {
  const res = evaluate(makeRows(), { high: 0.75, medium: 0.45 });
  let total = 0;
  for (const p of Object.keys(res.confusion)) {
    for (const a of Object.keys(res.confusion[p])) {
      total += res.confusion[p][a];
    }
  }
  assert.equal(total, res.n);
});

test("evaluate: Wilson CIs present", () => {
  const res = evaluate(makeRows(), { high: 0.75, medium: 0.45 });
  assert.ok(res.wilsonCI.high);
  assert.ok(typeof res.wilsonCI.high.lower === "number");
  assert.ok(typeof res.wilsonCI.high.upper === "number");
});

test("evaluate: alpha on double-labelled subset", () => {
  const res = evaluate(makeRows(), { high: 0.75, medium: 0.45 });
  assert.ok(typeof res.krippendorffAlpha === "number");
  assert.equal(res.alphaN, 7);
});

test("evaluate: alpha null when no label2", () => {
  const rows = makeRows().map((r) => ({
    ...r,
    label2: null,
    annotator2: null,
  }));
  const res = evaluate(rows, { high: 0.75, medium: 0.45 });
  assert.equal(res.krippendorffAlpha, null);
  assert.equal(res.alphaN, 0);
});

test("evaluate: reliabilityBuckets length 10", () => {
  const res = evaluate(makeRows(), { high: 0.75, medium: 0.45 });
  assert.equal(res.reliabilityBuckets.length, 10);
});
