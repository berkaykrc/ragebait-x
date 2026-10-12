import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BAND_STYLES,
  buildLineMarkup,
  shouldRenderLine,
} from "../../src/page/render.js";

// --- buildLineMarkup: one assertion per rendered state ----------------------

test("render: the loading state shows the analyzing copy", () => {
  const html = buildLineMarkup({ state: "loading" });
  assert.match(html, /analyzing/);
  assert.match(html, /ragebait-line/);
});

test("render: a result with no percent shows the band and the estimated label", () => {
  const html = buildLineMarkup({
    state: "result",
    band: "high",
    percent: null,
  });
  assert.match(html, /Ragebait: High/);
  assert.match(html, /estimated/);
  assert.match(html, /rb-low|rb-medium|rb-high/);
  assert.match(html, /rb-high/);
});

test("render: the estimated state carries the no-model label", () => {
  const html = buildLineMarkup({ state: "estimated", band: "medium" });
  assert.match(html, /Ragebait: Medium/);
  assert.match(html, /estimated \(no model\)/);
  assert.match(html, /rb-medium/);
});

test("render: the insufficient state renders its copy", () => {
  assert.match(buildLineMarkup({ state: "insufficient" }), /insufficient data/);
});

test("render: the error state renders its copy", () => {
  assert.match(buildLineMarkup({ state: "error" }), /analysis failed/);
});

test("render: the quota state renders its copy", () => {
  assert.match(buildLineMarkup({ state: "quota" }), /quota exceeded/);
});

// --- XSS: only known enums and escaped text reach the markup -----------------

test("render: a band value carrying markup never reaches the DOM", () => {
  const html = buildLineMarkup({
    state: "result",
    band: "<b>high</b>",
    percent: null,
  });
  // Spec Part 1 §3 control 3: numeric band enums are the only bands ever
  // rendered, and no page-supplied text reaches the DOM. An unknown band
  // therefore falls through to the error copy rather than being escaped in.
  assert.doesNotMatch(html, /<b>/);
  assert.doesNotMatch(html, /rb-(low|medium|high)/);
  assert.match(html, /analysis failed/);
});

test("render: a state carrying markup falls through to the error copy", () => {
  const html = buildLineMarkup({ state: "<img src=x>", band: "low" });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /analysis failed/);
});

test("render: BAND_STYLES holds exactly the three band keys", () => {
  assert.deepEqual(Object.keys(BAND_STYLES).sort(), ["high", "low", "medium"]);
  for (const band of Object.keys(BAND_STYLES)) {
    assert.equal(typeof BAND_STYLES[band].cls, "string");
    assert.equal(typeof BAND_STYLES[band].color, "string");
  }
});

test("render: the percent renders beside the band when present", () => {
  const html = buildLineMarkup({ state: "result", band: "low", percent: 12 });
  assert.match(html, /Ragebait: Low/);
  assert.match(html, /12/);
  assert.doesNotMatch(html, /estimated/);
});

// --- shouldRenderLine --------------------------------------------------------

test("shouldRenderLine: true for a hovercard that has no line yet", () => {
  const card = { querySelector: () => null };
  assert.equal(shouldRenderLine(card), true);
});

test("shouldRenderLine: false once a line is already in the hovercard", () => {
  const card = {
    querySelector: (sel) => (sel === ".ragebait-line" ? {} : null),
  };
  assert.equal(shouldRenderLine(card), false);
});

test("shouldRenderLine: false for a missing element", () => {
  assert.equal(shouldRenderLine(null), false);
});
