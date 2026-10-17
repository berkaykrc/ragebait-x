import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PRIMS, SIZES } from "../../scripts/lib/mark-geometry.mjs";
import { renderIconPng, renderMarkSvg } from "../../scripts/icons.mjs";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const distDir = path.join(rootDir, "dist-mv2");

const manifest = JSON.parse(
  await readFile(path.join(rootDir, "manifest.mv2.json"), "utf8"),
);

// Section 2 of the branding plan: the manifest declares 48/96/128, the
// generator emits every render size, and both a reader (SVG) and a rasteriser
// (PNG) derive from the same PRIMS array so SVG and PNG cannot drift.
test("brand icons: every manifest icon path exists in assets/ and in dist-mv2/", async () => {
  assert.ok(
    manifest.icons,
    "manifest.mv2.json must declare an icons map (48/96/128)",
  );
  for (const [size, file] of Object.entries(manifest.icons)) {
    await assert.doesNotReject(
      access(path.join(rootDir, "assets", file)),
      `manifest icon ${size} points at ${file}, which assets/ does not contain`,
    );
    await assert.doesNotReject(
      access(path.join(distDir, file)),
      `manifest icon ${size} points at ${file}, which dist-mv2/ does not contain — run \`npm run build\``,
    );
  }
});

test("brand icons: committed PNGs are byte-identical to a fresh render", async () => {
  // Drift guard: if anyone edits a committed PNG by hand (or with an image
  // editor), it stops matching what scripts/icons.mjs emits from PRIMS and
  // this test fails. Regeneration is always `npm run icons`.
  for (const size of Object.keys(manifest.icons).map(Number)) {
    const committed = await readFile(
      path.join(rootDir, "assets", `icon-${size}.png`),
    );
    assert.deepEqual(
      committed,
      renderIconPng(size),
      `assets/icon-${size}.png does not match a fresh renderIconPng(${size}) — run \`npm run icons\``,
    );
  }
});

test("brand icons: IHDR dimensions equal the declared size, read from the PNG bytes", () => {
  // Parse the header rather than trusting the filename: the bytes must say
  // what the render was asked to produce.
  for (const size of SIZES) {
    const png = renderIconPng(size);
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert.equal(width, size, `icon-${size}.png IHDR width must be ${size}`);
    assert.equal(height, size, `icon-${size}.png IHDR height must be ${size}`);
  }
});

test("brand icons: the smallest feature survives the 16px render", () => {
  // At 16px the scale factor is 16/128. Any prim whose smallest on-screen
  // dimension falls below 1.5px turns into mush (alpha-only haze), so this is
  // the legibility floor for the mark.
  for (const prim of PRIMS) {
    const smallest = Math.min(prim.w, prim.h) * (16 / 128);
    assert.ok(
      smallest >= 1.5,
      `prim ${prim.fill} at (${prim.x},${prim.y}) renders ${smallest}px at 16px — below the 1.5px floor`,
    );
  }
});

test("brand icons: the SVG is one rect per prim on the 128 grid", () => {
  const svg = renderMarkSvg();
  assert.match(svg, /<svg [^>]*viewBox="0 0 128 128"/);
  const rects = svg.match(/<rect /g) ?? [];
  assert.equal(rects.length, PRIMS.length, "one <rect> per prim, no extras");
  for (const prim of PRIMS) {
    const rx = `rx="${prim.rx}"`;
    assert.ok(
      svg.includes(rx),
      `SVG must carry ${rx} so tile and bars render with the plan's radii`,
    );
    assert.ok(
      svg.includes(`fill="${prim.fill}"`),
      `SVG must paint a rect with the prim fill ${prim.fill}`,
    );
  }
});
