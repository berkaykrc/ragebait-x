// Structured-line tests for the injected hovercard line (Task 3).
//
// render.test.js and render-states.test.js pin the rendered TEXT; this file
// pins the STRUCTURE the text is derived from: every state is a list of parts,
// `text` is always the join of those parts (never maintained beside them), and
// the band meter is derived from the band -- never from a hostile percent.
// The byte-identical contract lives in the other two suites; here the exact
// `textContent` pins are repeated as proof the element path still produces it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import * as render from "../../src/page/render.js";

const ORIGIN = "https://x.com";

function makeDoc() {
  return new JSDOM(
    `<!doctype html><html><body><div id="host"></div></body></html>`,
    { url: ORIGIN },
  ).window.document;
}

// --- lineSpec: text is derived from parts ------------------------------------

test("render-parts: a result spec's text is the join of its parts", () => {
  const spec = render.lineSpec({ state: "result", band: "low", percent: 10 });
  assert.equal(spec.text, spec.parts.map((p) => p.text).join(""));
  assert.deepEqual(spec.parts.map((p) => p.text), [
    "Ragebait: ",
    "Low",
    " \u00b7 ",
    "%10",
  ]);
  // tag, label, sep (hidden), value
  assert.deepEqual(spec.parts.map((p) => p.cls), [
    "ragebait-line-tag",
    "ragebait-line-label",
    "ragebait-line-sep",
    "ragebait-line-value",
  ]);
  assert.equal(
    spec.parts.find((p) => p.cls === "ragebait-line-sep").hidden,
    true,
  );
});

test("render-parts: the meter follows the band, never the percent", () => {
  assert.equal(
    render.lineSpec({ state: "result", band: "low", percent: 10 }).meter
      .filled,
    1,
  ); // low
  assert.equal(
    render.lineSpec({ state: "result", band: "medium" }).meter.filled,
    2,
  );
  // A hostile percent cannot widen the meter: filled comes from the band.
  assert.equal(
    render.lineSpec({ state: "result", band: "high", percent: 99 }).meter
      .filled,
    3,
  );
  const meter =
    render.lineSpec({ state: "result", band: "low", percent: 10 }).meter;
  assert.equal(meter.steps, 3);
  assert.equal(meter.cls, "ragebait-line-meter");
});

test("render-parts: notice states carry no meter", () => {
  assert.equal(render.lineSpec({ state: "loading" }).meter, null);
  assert.equal(render.lineSpec({ state: "insufficient" }).meter, null);
  assert.equal(render.lineSpec({ state: "error" }).meter, null);
  assert.equal(render.lineSpec({ state: "quota" }).meter, null);
});

test("render-parts: the quota sub-element stays outside parts", () => {
  const spec = render.lineSpec({ state: "quota", band: "high" });
  // The notice alone is the line's text and its only part...
  assert.deepEqual(spec.parts.map((p) => p.text), [
    "quota exceeded \u2014 retry tomorrow",
  ]);
  assert.equal(spec.text, "quota exceeded \u2014 retry tomorrow");
  // ...and the heuristic band rides beneath it, in `sub`.
  assert.equal(spec.sub.text, "High");
});

test("render-parts: every state's text is the join of its parts", () => {
  const states = [
    { state: "loading" },
    { state: "result", band: "low", percent: 10 },
    { state: "result", band: "high", percent: null },
    { state: "estimated", band: "medium" },
    { state: "stale", band: "medium", percent: 50 },
    { state: "insufficient" },
    { state: "error" },
    { state: "quota" },
    { state: "quota", band: "high" },
    { state: "result", band: "low", stale: true },
    { state: "quota", band: "high", stale: true },
  ];
  for (const state of states) {
    const spec = render.lineSpec(state);
    assert.ok(
      spec.parts.length >= 1,
      `${state.state} renders at least one part`,
    );
    assert.equal(
      spec.text,
      spec.parts.map((p) => p.text).join(""),
      `${state.state}: text must be derived from parts`,
    );
    for (const part of spec.parts) {
      assert.equal(typeof part.cls, "string");
      assert.equal(typeof part.text, "string");
    }
  }
});

test("render-parts: the stale qualifier appends to the last part", () => {
  const spec = render.lineSpec({
    state: "stale",
    band: "medium",
    percent: null,
  });
  const last = spec.parts[spec.parts.length - 1];
  assert.ok(last.text.endsWith(" (stale)"));
  // The join still equals the full, byte-identical text.
  assert.equal(spec.text, spec.parts.map((p) => p.text).join(""));
  assert.equal(
    spec.text,
    "Ragebait: Medium(estimated)  \u00b7\u00b7\u00b7 (stale)",
  );
});

// --- percent edge cases -------------------------------------------------------

test("render-parts: a hostile or absent percent yields the estimated copy", () => {
  const BAD_PERCENTS = [NaN, Infinity, -Infinity, -5, "80", undefined, null];
  for (const percent of BAD_PERCENTS) {
    const spec = render.lineSpec({ state: "result", band: "low", percent });
    assert.equal(
      spec.text,
      "Ragebait: Low(estimated)  \u00b7\u00b7\u00b7",
      `percent ${String(percent)} must fall back to the estimated copy`,
    );
    const doc = makeDoc();
    const el = render.createLineElement(doc, {
      state: "result",
      band: "low",
      percent,
    });
    const text = el.textContent;
    assert.equal(
      text.includes("NaN"),
      false,
      `percent ${String(percent)}: no NaN`,
    );
    assert.equal(
      text.includes("Infinity"),
      false,
      `percent ${String(percent)}: no Infinity`,
    );
    assert.equal(
      text.includes("undefined"),
      false,
      `percent ${String(percent)}: no undefined`,
    );
  }
});

test("render-parts: percent zero is a real number, not a fallback", () => {
  const spec = render.lineSpec({ state: "result", band: "low", percent: 0 });
  assert.equal(spec.text, "Ragebait: Low \u00b7 %0");
  assert.deepEqual(spec.parts.map((p) => p.text), [
    "Ragebait: ",
    "Low",
    " \u00b7 ",
    "%0",
  ]);
});

// --- createLineElement: the DOM keeps the exact text a plain span produced ----

test("render-parts: the element path renders the pinned text plus the meter", () => {
  const doc = makeDoc();
  const el = render.createLineElement(doc, {
    state: "result",
    band: "low",
    percent: 10,
  });
  assert.equal(el.textContent, "Ragebait: Low \u00b7 %10"); // the existing pin
  const meter = el.querySelector(".ragebait-line-meter");
  assert.equal(meter.children.length, 3);
  assert.equal(meter.children[0].className, "rb-seg rb-on");
  assert.equal(meter.children[1].className, "rb-seg");
  assert.equal(meter.children[2].className, "rb-seg");
  assert.equal(el.querySelector(".ragebait-line-label").textContent, "Low");
  assert.equal(el.querySelector(".ragebait-line-sep").textContent, " \u00b7 ");
});

test("render-parts: the band colour rides on the label span, not the line", () => {
  const doc = makeDoc();
  const el = render.createLineElement(doc, {
    state: "result",
    band: "low",
    percent: 10,
  });
  assert.equal(el.getAttribute("style"), null);
  assert.equal(
    el.querySelector(".ragebait-line-label").getAttribute("style"),
    `color: ${render.BAND_STYLES.low.color}`,
  );
});

test("render-parts: notice states render their copy as a single span", () => {
  const doc = makeDoc();
  // The notices are single-note specs: no child spans at all.
  for (
    const [state, copy] of [
      ["insufficient", "insufficient data"],
      ["error", "analysis failed"],
      ["quota", "quota exceeded \u2014 retry tomorrow"],
    ]
  ) {
    const el = render.createLineElement(doc, { state });
    assert.equal(el.textContent, copy, `${state} copy intact`);
    assert.equal(el.children.length, 0, `${state} has no child spans`);
  }
  // The quota heuristic band still renders as its own element beneath the notice.
  const quota = render.createLineElement(doc, { state: "quota", band: "high" });
  assert.equal(quota.children.length, 1);
  assert.equal(quota.children[0].className, "rb-high");
  assert.equal(quota.children[0].textContent, "High");
});

test("render-parts: loading renders its tag and note parts", () => {
  const doc = makeDoc();
  const el = render.createLineElement(doc, { state: "loading" });
  assert.equal(el.textContent, "Ragebait: analyzing\u2026"); // the existing pin
  assert.deepEqual(el.children.length, 2);
  assert.equal(el.children[0].className, "ragebait-line-tag");
  assert.equal(el.children[0].textContent, "Ragebait: ");
  assert.equal(el.children[1].className, "ragebait-line-note");
  assert.equal(el.children[1].textContent, "analyzing\u2026");
});
