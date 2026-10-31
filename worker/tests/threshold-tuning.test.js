import { test } from "node:test";
import assert from "node:assert/strict";

import {
  highBandPrecision,
  pickHighThreshold,
  shouldFlipShowNumber,
} from "../src/config.js";

test("tuning: picks precision-first threshold", () => {
  const scores = [
    ...Array(10).fill(0.85), // high-label, predicted high at 0.8
    0.75, // high-label, only predicted high at 0.7
    ...Array(10).fill(0.75), // normal, predicted high at 0.7 only
  ];
  const labels = [
    ...Array(10).fill("ragebait"),
    "ragebait",
    ...Array(10).fill("normal"),
  ];
  const t = pickHighThreshold(scores, labels, 0.9);
  assert.equal(t, 0.85);
});

test("tuning: returns null when no threshold meets minPrecision", () => {
  const scores = [0.5, 0.5, 0.5, 0.5];
  const labels = ["ragebait", "normal", "ragebait", "normal"];
  const t = pickHighThreshold(scores, labels, 0.9);
  assert.equal(t, null);
});

test("tuning: highBandPrecision computes correctly", () => {
  const scores = [0.9, 0.8, 0.2];
  const labels = ["ragebait", "normal", "normal"];
  // threshold 0.5 -> predicted high: 0.9,0.8 ; actual high only first -> precision 1/2
  assert.equal(highBandPrecision(scores, labels, 0.5), 0.5);
});

test("tuning: shouldFlipShowNumber true only when both gates pass", () => {
  assert.equal(shouldFlipShowNumber(0.05, 0.95), true);
  assert.equal(shouldFlipShowNumber(0.2, 0.95), false);
  assert.equal(shouldFlipShowNumber(0.05, 0.8), false);
});
