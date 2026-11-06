#!/usr/bin/env node
//
// Build the Firefox update manifest (`updates.json`) for the self-distributed
// release channel. Firefox reads it from the manifest's `update_url`
// (`releases/latest/download/updates.json`) and offers an update when the
// published version is newer.
//
// Every GitHub Release attaches the signed `.xpi` under a stable name
// (`ragebait-detector.xpi`), so
// `releases/latest/download/ragebait-detector.xpi` always resolves to the
// newest signed build. The repository must be public for those URLs to work.
//
//   node scripts/update-manifest.mjs [--out web-ext-artifacts/updates.json]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_REPO = "berkaykrc/ragebait-x";
export const STABLE_ASSET = "ragebait-detector.xpi";
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Update link served by the latest GitHub Release. */
export function updateLink(repo = DEFAULT_REPO) {
  return `https://github.com/${repo}/releases/latest/download/${STABLE_ASSET}`;
}

/** Firefox update manifest for one add-on id and version. */
export function buildUpdateManifest({ id, version, link }) {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("add-on id is required");
  }
  if (typeof version !== "string" || !VERSION_RE.test(version)) {
    throw new Error(`malformed version: ${JSON.stringify(version)}`);
  }
  if (typeof link !== "string" || !link.startsWith("https://")) {
    throw new Error(`update link must be https: ${JSON.stringify(link)}`);
  }
  return {
    addons: {
      [id]: {
        updates: [{ version, update_link: link }],
      },
    },
  };
}

export function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function main() {
  const argv = process.argv.slice(2);
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, "manifest.mv2.json"), "utf8"),
  );
  const id = manifest.browser_specific_settings?.gecko?.id;
  const version = argValue(argv, "--version") || manifest.version;
  const repo = argValue(argv, "--repo") || process.env.GITHUB_REPOSITORY ||
    DEFAULT_REPO;
  const link = argValue(argv, "--link") || updateLink(repo);
  const out = path.resolve(
    ROOT,
    argValue(argv, "--out") || "web-ext-artifacts/updates.json",
  );

  const updateManifest = buildUpdateManifest({ id, version, link });
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(updateManifest, null, 2)}\n`, "utf8");
  console.log(`wrote ${path.relative(ROOT, out)} (${id} ${version})`);
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main();
}
