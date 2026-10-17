import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { BAND_STYLES } from "../../src/page/render.js";

// Section 1 of the branding plan fixes these tokens, values and names alike.
// brand.css is their single definition; this test is the guard that keeps the
// stylesheet and the hovercard palette from drifting apart (plan Review Focus
// #2: a one-sided palette edit makes the legend lie).
const SECTION_1_TOKENS = [
  "rb-ink",
  "rb-panel",
  "rb-panel-2",
  "rb-line",
  "rb-text",
  "rb-muted",
  "rb-accent",
  "rb-band-low",
  "rb-band-medium",
  "rb-band-high",
];

const BANDS = ["low", "medium", "high"];

const css = await readFile("src/brand/brand.css", "utf8");
const token = (name) =>
  css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`))?.[1];

test("brand tokens: every Section 1 token is defined", () => {
  for (const name of SECTION_1_TOKENS) {
    assert.ok(token(name), `brand.css must define --${name} as a 6-digit hex`);
  }
});

test("brand tokens: the band colours equal render.js BAND_STYLES", () => {
  for (const band of BANDS) {
    assert.equal(
      token(`rb-band-${band}`),
      BAND_STYLES[band].color,
      `render.js BAND_STYLES.${band} and brand.css --rb-band-${band} must be the same hex`,
    );
  }
});

test("brand tokens: the accent is not any band colour", () => {
  const accent = token("rb-accent");
  for (const band of BANDS) {
    assert.notEqual(
      accent,
      token(`rb-band-${band}`),
      `--rb-accent must stay distinct from --rb-band-${band}`,
    );
  }
});

test("brand tokens: the light scheme overrides all three band tokens", () => {
  const light = css.match(
    /@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root\s*\{([^}]*)\}/s,
  )?.[1];
  assert.ok(
    light,
    "brand.css must hold an @media (prefers-color-scheme: light) :root block",
  );
  for (const band of BANDS) {
    const name = `rb-band-${band}`;
    const value = light.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`))?.[1];
    assert.ok(value, `the light block must override --${name}`);
    assert.notEqual(
      value,
      token(name),
      `the light block must change --${name}, not repeat the dark hex`,
    );
  }
});
