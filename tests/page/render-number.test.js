import { test } from "node:test";
import assert from "node:assert/strict";

import { buildLineMarkup } from "../../src/page/render.js";

test("render-number: displays number percentage when percent is present", () => {
  const html = buildLineMarkup({
    state: "result",
    band: "high",
    percent: 87,
  });

  assert.match(html, /RAGEBAIT:/i);
  assert.match(html, /High/i);
  assert.match(html, /%87/);
  assert.doesNotMatch(html, /estimated/i);
});

test("render-number: displays estimated when percent is null or absent", () => {
  const html = buildLineMarkup({
    state: "result",
    band: "high",
    percent: null,
  });

  assert.match(html, /RAGEBAIT:/i);
  assert.match(html, /High/i);
  assert.match(html, /estimated/i);
  assert.doesNotMatch(html, /%\d+/);
});
