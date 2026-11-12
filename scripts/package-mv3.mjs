#!/usr/bin/env node
//
// Package the Chrome MV3 build as a release asset.
//
// web-ext names its output after the manifest (`ragebait_detector-<v>.zip`).
// That name changes every release, so copy it to a stable asset name:
// `ragebait-detector-mv3.zip`. The Release download URL then never moves.
//
// Chrome sees the same package the store would receive; the store signs the
// CRX on upload, so there is no local signing step.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = path.join(ROOT, "web-ext-artifacts");
const STABLE = path.join(ARTIFACTS, "ragebait-detector-mv3.zip");

if (!existsSync(path.join(ROOT, "dist-mv3", "manifest.json"))) {
  process.stderr.write(
    "error: dist-mv3/manifest.json is missing. Run `npm run build` first.\n",
  );
  process.exit(1);
}

const { version } = JSON.parse(
  readFileSync(path.join(ROOT, "manifest.mv3.json"), "utf8"),
);

execFileSync(
  "npx",
  [
    "--no-install",
    "web-ext",
    "build",
    "--source-dir",
    "dist-mv3",
    "--artifacts-dir",
    "web-ext-artifacts",
    "--overwrite-dest",
  ],
  { cwd: ROOT, stdio: "inherit" },
);

const built = path.join(ARTIFACTS, `ragebait_detector-${version}.zip`);
if (!existsSync(built)) {
  process.stderr.write(
    `error: web-ext did not produce ${path.relative(ROOT, built)}\n`,
  );
  process.exit(1);
}

copyFileSync(built, STABLE);
process.stdout.write(`chrome mv3 package: ${path.relative(ROOT, STABLE)}\n`);
