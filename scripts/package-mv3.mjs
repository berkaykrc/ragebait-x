#!/usr/bin/env node
//
// Package the Chrome MV3 build as a release asset.
//
// web-ext defaults to `{name}-{version}.zip`, the same file name the Firefox
// package uses. Passing `--filename` writes the stable Chrome name directly
// instead of overwriting the Firefox zip:
// `web-ext-artifacts/ragebait-detector-mv3.zip`. The Release download URL
// then never moves.
//
// Chrome sees the same package the store would receive; the store signs the
// CRX on upload, so there is no local signing step.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STABLE = path.join("web-ext-artifacts", "ragebait-detector-mv3.zip");

if (!existsSync(path.join(ROOT, "dist-mv3", "manifest.json"))) {
  process.stderr.write(
    "error: dist-mv3/manifest.json is missing. Run `npm run build` first.\n",
  );
  process.exit(1);
}

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
    "--filename",
    "ragebait-detector-mv3.zip",
    "--overwrite-dest",
  ],
  { cwd: ROOT, stdio: "inherit" },
);

process.stdout.write(`chrome mv3 package: ${STABLE}\n`);
