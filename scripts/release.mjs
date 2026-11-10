#!/usr/bin/env node
//
// Release: bump the version, commit, tag, push. The tag push is what triggers
// .github/workflows/release.yml, which signs with AMO and attaches the .xpi to
// the tag's GitHub Release.
//
//   npm run release patch      # 0.1.0 -> 0.1.1
//   npm run release minor      # 0.1.0 -> 0.2.0
//   npm run release major      # 0.1.0 -> 1.0.0
//   npm run release 0.3.0      # explicit version
//   npm run release patch -- --yes   # skip the confirmation prompt
//
// This script never touches AMO credentials. Signing happens in CI, using
// GitHub Actions secrets. Locally you only need push access to the remote.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "manifest.mv2.json");

const BUMP_KINDS = ["patch", "minor", "major"];
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Strictly x.y.z. Prereleases are rejected on purpose. */
export function isValidVersion(value) {
  return typeof value === "string" && VERSION_RE.test(value);
}

/**
 * Next version for a bump word, or the explicit target if one was given.
 * Throws rather than guessing: a wrong version here produces an add-on AMO
 * will never let you re-upload under that number again.
 */
export function nextVersion(current, bump) {
  if (!isValidVersion(current)) {
    throw new Error(`malformed current version: ${JSON.stringify(current)}`);
  }
  if (BUMP_KINDS.includes(bump)) {
    const [major, minor, patch] = current.split(".").map(Number);
    if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
    if (bump === "minor") return `${major}.${minor + 1}.0`;
    return `${major + 1}.0.0`;
  }
  if (isValidVersion(bump)) return bump;
  throw new Error(
    `malformed bump: ${
      JSON.stringify(bump)
    } (expected patch, minor, major, or x.y.z)`,
  );
}

function readManifest() {
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

/**
 * Rewrite only the "version" value, preserving the file's existing layout.
 * JSON.parse/stringify would reflow the whole file and bury the real change.
 */
function writeManifestVersion(version) {
  const source = readFileSync(MANIFEST, "utf8");
  const updated = source.replace(
    /("version"\s*:\s*)"[^"]*"/,
    (_m, prefix) => `${prefix}"${version}"`,
  );
  if (updated === source) {
    throw new Error(`could not find a "version" field in ${MANIFEST}`);
  }
  writeFileSync(MANIFEST, updated, "utf8");
}

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/**
 * Set the package version and sync the lock file. npm owns both files;
 * a hand edit to package-lock.json would drift from npm's own output.
 */
export function syncPackageVersion(version, cwd = ROOT) {
  execFileSync("npm", ["pkg", "set", `version=${version}`], {
    cwd,
    encoding: "utf8",
  });
  execFileSync(
    "npm",
    ["install", "--package-lock-only", "--no-audit", "--no-fund"],
    { cwd, encoding: "utf8" },
  );
}

function gitStatusPorcelain() {
  return execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
}

function tagExists(tag) {
  try {
    git("rev-parse", "--verify", "--quiet", `refs/tags/${tag}`);
    return true;
  } catch {
    return false;
  }
}

function prompt(question) {
  process.stdout.write(`${question} `);
  const answer = readFileSync(0, "utf8").trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--yes");
  const assumeYes = process.argv.slice(2).includes("--yes");
  const bump = args[0];

  if (!bump) {
    process.stderr.write(
      "usage: npm run release <patch|minor|major|x.y.z> [-- --yes]\n",
    );
    process.exit(1);
  }

  const current = readManifest().version;
  let next;
  try {
    next = nextVersion(current, bump);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }

  // Refuse to release anything that is not committed. Tagging a dirty tree
  // signs one commit while leaving the working copy somewhere else entirely.
  const dirty = gitStatusPorcelain();
  if (dirty) {
    process.stderr.write(
      "error: working tree is not clean. Commit or stash first:\n" +
        `${dirty}\n`,
    );
    process.exit(1);
  }

  const tag = `v${next}`;
  if (tagExists(tag)) {
    process.stderr.write(`error: tag ${tag} already exists locally\n`);
    process.exit(1);
  }

  process.stdout.write(
    `\n  ${current} -> ${next}   (tag ${tag})\n\n` +
      `  1. edit "version" in manifest.mv2.json\n` +
      `  2. commit + tag as "${tag}"\n` +
      `  3. push, which triggers CI to sign and attach the .xpi\n\n`,
  );

  if (!assumeYes && !prompt("release this version? [y/N]")) {
    process.stdout.write("aborted\n");
    process.exit(1);
  }

  writeManifestVersion(next);
  git("add", "manifest.mv2.json");
  git("commit", "-m", `release: ${tag}`);
  git("tag", tag);
  git("push", "origin", "HEAD");
  git("push", "origin", tag);

  process.stdout.write(
    `\nreleased ${tag}\n` +
      "CI is signing now. Watch it here:\n" +
      `  gh run watch\n` +
      "or open the Actions tab on the remote.\n",
  );
}

// Only run when invoked directly, so importing nextVersion in a test does not
// start a release. `import.meta.main` is not available on Node 22.
const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main();
}
