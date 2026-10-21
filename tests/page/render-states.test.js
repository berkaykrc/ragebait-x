// State-machine tests for the injected line (Task 7).
//
// render.test.js pins the static markup per state; this file pins the LIVE
// flow: a line moves between states through applyState, all seven plan
// states (loading|result|estimated|insufficient|error|quota|stale) render,
// the stale indicator follows the cache envelope's `stale` flag (ruling:
// past 50% of that state's TTL -- there is no single STALE_AFTER_MS), and a
// state change for one handle never mutates another handle's line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import * as render from "../../src/page/render.js";
import { createCache } from "../../src/data/cache.js";

const ORIGIN = "https://x.com";

function makeDoc() {
  return new JSDOM(
    `<!doctype html><html><body><div id="host"></div></body></html>`,
    { url: ORIGIN },
  ).window.document;
}

/**
 * Mount a loading line and return accessors that survive applyState's
 * replaceWith (the reference must be refreshed after every transition).
 */
function mountedLoadingLine(doc) {
  const host = doc.getElementById("host");
  const box = { line: render.createLineElement(doc, { state: "loading" }) };
  host.appendChild(box.line);
  return {
    host,
    current: () => box.line,
    put: (next) => {
      box.line = next;
    },
  };
}

// --- the seven states ---------------------------------------------------------

test("render-states: STATE_MARKUP covers exactly the seven plan states", () => {
  assert.deepEqual(Object.keys(render.STATE_MARKUP).sort(), [
    "error",
    "estimated",
    "insufficient",
    "loading",
    "quota",
    "result",
    "stale",
  ]);
});

// --- loading -> result --------------------------------------------------------

test("render-states: loading then result renders the band and the estimated label", () => {
  const doc = makeDoc();
  const { current, put } = mountedLoadingLine(doc);
  assert.match(current().textContent, /analyzing/);

  put(
    render.applyState(current(), {
      state: "result",
      band: "high",
      percent: null,
    }),
  );
  assert.match(current().textContent, /RAGEBAIT: High/);
  assert.match(current().textContent, /estimated/);
  assert.match(current().className, /rb-high/);
  assert.doesNotMatch(current().textContent, /analyzing/);
});

test("render-states: loading then estimated shows the no-model label", () => {
  const doc = makeDoc();
  const { current, put } = mountedLoadingLine(doc);

  put(render.applyState(current(), { state: "estimated", band: "medium" }));
  assert.match(current().textContent, /RAGEBAIT: Medium/);
  assert.match(current().textContent, /estimated \(no model\)/);
  assert.match(current().className, /rb-medium/);
});

test("render-states: result then refresh returns the line to loading", () => {
  const doc = makeDoc();
  const { current, put } = mountedLoadingLine(doc);
  put(
    render.applyState(current(), { state: "result", band: "low", percent: 12 }),
  );
  assert.match(current().textContent, /RAGEBAIT: Low/);
  assert.doesNotMatch(current().textContent, /estimated/);

  put(render.applyState(current(), { state: "loading" }));
  assert.match(current().textContent, /analyzing/);
  assert.doesNotMatch(current().className, /rb-low/);
});

test("render-states: each band renders its colour class", () => {
  const doc = makeDoc();
  for (const band of ["low", "medium", "high"]) {
    const el = render.createLineElement(doc, {
      state: "result",
      band,
      percent: null,
    });
    assert.match(
      el.className,
      new RegExp(`\\b${render.BAND_STYLES[band].cls}\\b`),
    );
  }
});

test("render-states: the markup carries the band colour as an inline style", () => {
  const html = render.buildLineMarkup({
    state: "result",
    band: "high",
    percent: 87,
  });
  assert.match(
    html,
    new RegExp(`style="color:${render.BAND_STYLES.high.color}"`),
  );
});

test("render-states: insufficient and error render their copy in the DOM", () => {
  const doc = makeDoc();
  const { current, put } = mountedLoadingLine(doc);

  put(render.applyState(current(), { state: "insufficient" }));
  assert.match(current().textContent, /insufficient data/);

  put(render.applyState(current(), { state: "error" }));
  assert.match(current().textContent, /analysis failed/);
});

// --- quota: notice + heuristic band beneath ----------------------------------

test("render-states: quota shows the retry-tomorrow notice with the heuristic band beneath", () => {
  const doc = makeDoc();
  const { current, put } = mountedLoadingLine(doc);

  put(render.applyState(current(), { state: "quota", band: "high" }));
  // The notice copy...
  assert.match(current().textContent, /quota exceeded \u2014 retry tomorrow/);
  // ...and the heuristic band still rendered beneath it, as its own element.
  const bandEl = current().querySelector(".rb-high");
  assert.ok(bandEl, "expected the heuristic band element beneath the notice");
  assert.equal(bandEl.textContent, "High");
  // "Beneath" means a child element, not the outer line wearing the band class.
  assert.doesNotMatch(current().className, /rb-high/);
});

test("render-states: quota without a band renders only the notice", () => {
  const doc = makeDoc();
  const { current, put } = mountedLoadingLine(doc);

  put(render.applyState(current(), { state: "quota" }));
  assert.match(current().textContent, /quota exceeded \u2014 retry tomorrow/);
  assert.equal(current().querySelector(".rb-low, .rb-medium, .rb-high"), null);
});

test("render-states: a quota band carrying markup falls through to the notice alone", () => {
  const doc = makeDoc();
  const { current, put } = mountedLoadingLine(doc);

  put(render.applyState(current(), { state: "quota", band: "<b>high</b>" }));
  assert.match(current().textContent, /quota exceeded/);
  assert.equal(current().querySelector(".rb-low, .rb-medium, .rb-high"), null);
  assert.doesNotMatch(current().outerHTML, /<b>/);
});

// --- stale: the envelope's flag drives the indicator --------------------------

test("render-states: an estimated envelope past 50% of its TTL renders the stale indicator", async () => {
  // No single STALE_AFTER_MS exists: cache.js marks an envelope stale once it
  // is past 50% of ITS state's TTL (estimated: 1h -> 30min). This test feeds
  // the real cache's stale flag into applyState, as the live flow does.
  let nowMs = 1_700_000_000_000;
  const cache = createCache({ now: () => nowMs });
  await cache.set("yoksiktir", { state: "estimated", band: "medium" });

  const doc = makeDoc();
  const { current, put } = mountedLoadingLine(doc);

  // 29 minutes in: under the 30-minute mark, so the answer is fresh.
  nowMs += 29 * 60e3;
  const fresh = await cache.get("yoksiktir");
  assert.equal(fresh.stale, false);
  put(render.applyState(current(), { ...fresh.value, stale: fresh.stale }));
  assert.doesNotMatch(current().className, /ragebait-line-stale/);
  assert.doesNotMatch(current().textContent, /\(stale\)/);

  // 31 minutes in: past half the TTL, so the envelope is stale.
  nowMs += 2 * 60e3;
  const staleEnv = await cache.get("yoksiktir");
  assert.equal(staleEnv.stale, true);
  put(
    render.applyState(current(), { ...staleEnv.value, stale: staleEnv.stale }),
  );
  assert.match(current().className, /ragebait-line-stale/);
  assert.match(current().textContent, /\(stale\)/);
  // The band and the estimated label survive the stale qualifier.
  assert.match(current().textContent, /RAGEBAIT: Medium/);
  assert.match(current().textContent, /estimated \(no model\)/);
  assert.match(current().className, /rb-medium/);
});

test("render-states: the stale state itself renders the band with the indicator", () => {
  const doc = makeDoc();
  const el = render.createLineElement(doc, {
    state: "stale",
    band: "medium",
    percent: null,
  });
  assert.match(el.className, /ragebait-line-stale/);
  assert.match(el.className, /rb-medium/);
  assert.match(el.textContent, /\(stale\)/);
});

// --- applyState contract ------------------------------------------------------

test("render-states: applyState is idempotent for the same state", () => {
  const doc = makeDoc();
  const { host, current, put } = mountedLoadingLine(doc);
  const state = { state: "result", band: "low", percent: 10 };

  put(render.applyState(current(), state));
  put(render.applyState(current(), state));

  assert.equal(host.querySelectorAll(".ragebait-line").length, 1);
  assert.equal(current().textContent, "RAGEBAIT: Low \u00b7 %10");
});

test("render-states: applyState replaces the whole line body", () => {
  // A quota line carries a band sub-element; moving it to a plain result must
  // leave no stale sub-element behind.
  const doc = makeDoc();
  const { current, put } = mountedLoadingLine(doc);

  put(render.applyState(current(), { state: "quota", band: "high" }));
  assert.ok(current().querySelector(".rb-high"));

  put(
    render.applyState(current(), { state: "result", band: "low", percent: 5 }),
  );
  assert.equal(current().querySelector(".rb-high"), null);
  assert.match(current().textContent, /RAGEBAIT: Low \u00b7 %5/);
});

test("render-states: applyState keeps the debugging handle attribute", () => {
  const doc = makeDoc();
  const { current, put } = mountedLoadingLine(doc);
  current().setAttribute("data-ragebait-handle", "yoksiktir");

  put(
    render.applyState(current(), {
      state: "result",
      band: "high",
      percent: 87,
    }),
  );
  assert.equal(current().getAttribute("data-ragebait-handle"), "yoksiktir");
});

// --- handle isolation ---------------------------------------------------------

test("render-states: a transition for one handle never mutates another handle's line", () => {
  const doc = makeDoc();
  const host = doc.getElementById("host");

  const lineA = render.createLineElement(doc, {
    state: "result",
    band: "low",
    percent: 10,
  });
  lineA.setAttribute("data-ragebait-handle", "alpha");
  const lineB = render.createLineElement(doc, { state: "loading" });
  lineB.setAttribute("data-ragebait-handle", "beta");
  host.appendChild(lineA);
  host.appendChild(lineB);

  const textA = lineA.textContent;
  const clsA = lineA.className;
  const nextB = render.applyState(lineB, {
    state: "result",
    band: "high",
    percent: 90,
  });

  assert.equal(lineA.isConnected, true);
  assert.equal(lineA.textContent, textA);
  assert.equal(lineA.className, clsA);
  assert.match(nextB.textContent, /RAGEBAIT: High/);
});
