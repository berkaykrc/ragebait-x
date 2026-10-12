import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const distDir = path.join(rootDir, "dist-mv2");

const manifest = JSON.parse(await readFile(path.join(rootDir, "manifest.mv2.json"), "utf8"));

/** Every asset path the manifest points at, collected generically. */
function referencedAssets(m) {
  return [
    ...(m.content_scripts ?? []).map((cs) => cs.js),
    ...(m.content_scripts ?? []).flatMap((cs) => cs.css ?? []),
    ...(m.background?.scripts ?? []),
    m.background?.service_worker,
    m.options_ui?.page,
    m.options_page,
    ...(m.web_accessible_resources ?? []).map((r) => (typeof r === "string" ? r : r.resources)),
  ].flat().filter((v) => typeof v === "string" && v.length > 0);
}

test("manifest: declares the fxtwitter host permission for the background cross-origin fetch", () => {
  assert.ok(
    manifest.permissions.includes("https://api.fxtwitter.com/*"),
    "content-script match patterns do NOT authorise a cross-origin fetch; the API origin must be an explicit host permission",
  );
  assert.ok(manifest.permissions.includes("storage"));
});

test("manifest: content_scripts[0].js is ['content.js']", () => {
  // Array, not the scalar "content.js" the plan's Step 6 asserts: addons-linter
  // (the linter that gates AMO submission) calls scriptRule.js.forEach and
  // crashes with `TypeError: scriptRule.js.forEach is not a function` on a scalar.
  assert.deepEqual(manifest.content_scripts[0].js, ["content.js"]);
});

test("manifest: runs the content script at document_start on x.com and twitter.com", () => {
  const cs = manifest.content_scripts[0];
  assert.equal(cs.run_at, "document_start");
  assert.ok(cs.matches.includes("https://x.com/*"));
  assert.ok(cs.matches.includes("https://twitter.com/*"));
});

test("manifest: exposes page.js as a web-accessible resource (the page-world bundle)", () => {
  const war = manifest.web_accessible_resources;
  const list = Array.isArray(war) ? war : (war ?? []).map((r) => r.resources).flat();
  assert.ok(list.includes("page.js"));
});

test("manifest: uses an MV2 background script page and an options page", () => {
  assert.equal(manifest.manifest_version, 2);
  assert.deepEqual(manifest.background.scripts, ["background.js"]);
  assert.equal(manifest.options_ui.page, "options.html");
  assert.equal(manifest.options_ui.open_in_tab, true);
});

test("manifest: pins strict_min_version and a placeholder gecko id", () => {
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "121.0");
  assert.match(manifest.browser_specific_settings.gecko.id, /@/);
});

test("manifest: every referenced asset resolves to a file the build emits", async () => {
  const assets = referencedAssets(manifest);
  assert.ok(assets.length > 0, "expected the manifest to reference at least one asset");
  for (const asset of assets) {
    await assert.doesNotReject(
      access(path.join(distDir, asset)),
      `manifest references "${asset}" but dist-mv2/ does not contain it — run \`npm run build\``,
    );
  }
});

test("manifest: no referenced path is prefixed with dist- or src/", () => {
  for (const asset of referencedAssets(manifest)) {
    assert.doesNotMatch(asset, /^(dist-|src\/)/, `manifest path "${asset}" must be relative to the build root`);
  }
});