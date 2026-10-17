import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

// Live documents. docs/plan/ is deliberately excluded: those are dated plan
// records whose whole purpose is to state the version they were written
// against, so pinning them is correct rather than drift.
const LIVE_DOCS = ["README.md", path.join("docs", "qa", "manual-matrix.md")];

// x.y.z, optionally prefixed with v, not preceded by a dot so "115.0" style
// prose and file paths do not match.
const VERSION_RE = /(?<![\w.])v?\d+\.\d+\.\d+(?![\w.])/g;

// Toolchain versions are not the extension's version and must stay pinned in
// prose -- they document the environment, not this add-on's release.
const TOOLCHAIN_VERSIONS = new Set([
  "22.13.0", // Node, pinned by .nvmrc
]);

for (const rel of LIVE_DOCS) {
  test(`docs: ${rel} hardcodes no version number`, async () => {
    const text = await readFile(path.join(rootDir, rel), "utf8");

    // A version in prose is wrong the moment the next release is cut, and
    // nothing fails when it goes stale -- it just quietly lies. The version of
    // record is `version` in manifest.mv2.json, surfaced by the release tag.
    // Refer to the release instead of restating the number.
    const found = [...text.matchAll(VERSION_RE)]
      .map((m) => m[0])
      .filter((v) => !TOOLCHAIN_VERSIONS.has(v.replace(/^v/, "")));

    assert.deepEqual(
      found,
      [],
      `${rel} hardcodes ${found.join(", ")}. Point at the latest release ` +
        `instead, or the doc will be stale after the next version bump.`,
    );
  });
}

test("docs: the README points at the release rather than a version", async () => {
  const readme = await readFile(path.join(rootDir, "README.md"), "utf8");

  // A relative link, not an external badge service: this repo is private, and
  // shields.io cannot read a private repo, so a badge would render blank.
  assert.match(readme, /\]\(\.\.\/\.\.\/releases\/latest\)/);
  assert.doesNotMatch(
    readme,
    /img\.shields\.io/,
    "external badges cannot read a private repo",
  );
});

test("docs: the manifest remains the single version of record", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(rootDir, "manifest.mv2.json"), "utf8"),
  );

  assert.match(
    manifest.version,
    /^\d+\.\d+\.\d+$/,
    "manifest.version is what the release workflow bumps and what AMO matches against",
  );
});
