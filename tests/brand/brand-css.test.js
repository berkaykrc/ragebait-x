import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cssPath = path.join(
  path.dirname(fileURLToPath(new URL(import.meta.url))),
  "..",
  "..",
  "src",
  "brand",
  "brand.css",
);
const css = await readFile(cssPath, "utf8");
// Strip CSS comments before scanning selectors — comments may contain dotted
// paths (e.g. "docs/superpowers/...") that are not selectors.
const cssForSelectors = css.replace(/\/\*[\s\S]*?\*\//g, "");

// every selector is scoped to our own classes
test("CSS: no data-testid selectors", () => {
  assert.doesNotMatch(css, /\[data-testid/);
});

// Allowlist: rb-* and ragebait-* are ours; `visible` and `error` are class
// names that JS assigns, so they cannot be renamed to the rb- prefix.
const ALLOWED = ["rb-", "ragebait-", "visible", "error"];
const badSelectors = [...cssForSelectors.matchAll(/(^|[},])\s*([^{}@]+)\{/g)]
  .map((m) => m[2].trim())
  .filter((sel) =>
    /\.[a-zA-Z]/.test(sel) &&
    ![...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)]
      .every((c) => ALLOWED.some((a) => c[1].startsWith(a)))
  );
test("CSS: every class selector must be in the allowlist", () => {
  assert.deepEqual(
    badSelectors,
    [],
    "every class selector must be in the allowlist",
  );
});

// no remote resources, ever
test("CSS: no remote url()", () => {
  assert.doesNotMatch(css, /url\(\s*['"]?https?:/);
});
test("CSS: no @import", () => {
  assert.doesNotMatch(css, /@import/);
});

// the line and every part it renders have a rule
test("CSS: all required selectors are defined", () => {
  for (
    const sel of [
      ".ragebait-line",
      ".ragebait-line-tag",
      ".ragebait-line-label",
      ".ragebait-line-sep",
      ".ragebait-line-value",
      ".ragebait-line-meter",
      ".rb-seg",
      ".rb-low",
      ".rb-medium",
      ".rb-high",
    ]
  ) {
    assert.match(css, new RegExp(sel.replace(".", "\\.")));
  }
});

// manifest ships it as a content-script stylesheet, and the build emits it
test("manifest: content_scripts[0].css is ['brand.css']", async () => {
  const m = JSON.parse(
    await readFile(
      path.join(
        path.dirname(fileURLToPath(new URL(import.meta.url))),
        "..",
        "..",
        "manifest.mv2.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(m.content_scripts[0].css, ["brand.css"]);
});

test("build: dist-mv2/brand.css exists", async () => {
  await access("dist-mv2/brand.css");
});

// Step 1 markup assertions
test("markup: references brand.css", async () => {
  const html = await readFile("src/options/index.html", "utf8");
  assert.match(html, /<link rel="stylesheet" href="brand\.css">/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /@font-face|<style/);
});

test("markup: legend has three band swatches", async () => {
  const html = await readFile("src/options/index.html", "utf8");
  const matches = html.match(/rb-legend-(low|medium|high)/g) ?? [];
  assert.equal(matches.length, 3);
});

test("markup: every component class used in HTML is defined in brand.css", async () => {
  const html = await readFile("src/options/index.html", "utf8");
  const css = await readFile(cssPath, "utf8");
  const cssForSelectors = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const usedClasses = [...html.matchAll(/class="(rb-[\w-]+)/g)].map((m) =>
    m[1]
  );
  for (const cls of usedClasses) {
    assert.match(
      cssForSelectors,
      new RegExp(`\\.${cls}\\b`),
      `brand.css has no rule for .${cls}`,
    );
  }
});
