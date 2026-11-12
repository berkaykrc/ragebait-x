# Release Version Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep `package.json` and `package-lock.json` in sync with the extension version on every release.

**Architecture:** Add a `syncPackageVersion` step to `scripts/release.mjs` that runs `npm pkg set version=<next>` and `npm install --package-lock-only`. Stage the two files together with the manifest. Do the same in the `release.yml` button path and widen its commit check to all three files.

**Tech Stack:** Node.js, npm, git, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-10-release-version-sync-design.md`

## Global Constraints

- Version format is strictly `x.y.z`. Prereleases are rejected.
- The release script refuses a dirty working tree.
- `npm install --package-lock-only` runs with `--no-audit --no-fund`.
- Do not edit `package-lock.json` by hand.
- `npm run check` must pass.

## Review Focus

- The release commit must include `package.json` and `package-lock.json`, not only `manifest.mv2.json`.
- The `release.yml` commit condition must not skip the commit when only `package.json` or `package-lock.json` changed.
- `npm pkg set` reformats `package.json` (expands `engines`, reorders `devDependencies`). `deno fmt --check` must still pass.
- `npm install --package-lock-only` must change only the two version fields, not dependency versions.

---

### Task 1: Add the version-sync function and its test

**Files:**
- Modify: `scripts/release.mjs:76-78` (add the function after `git`)
- Test: `tests/release/release.test.js` (create)

**Interfaces:**
- Consumes: `execFileSync` from `node:child_process`, `ROOT` from `scripts/release.mjs`.
- Produces: `syncPackageVersion(version: string, cwd?: string) => void`. Runs `npm pkg set version=<version>` then `npm install --package-lock-only --no-audit --no-fund` in `cwd` (default `ROOT`). Throws on a non-zero exit.

- [ ] **Step 1: Write the failing test**

Create `tests/release/release.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  isValidVersion,
  nextVersion,
  syncPackageVersion,
} from "../../scripts/release.mjs";

test("isValidVersion accepts only x.y.z", () => {
  assert.equal(isValidVersion("0.1.2"), true);
  assert.equal(isValidVersion("0.1"), false);
  assert.equal(isValidVersion("0.1.2-alpha"), false);
  assert.equal(isValidVersion(1), false);
});

test("nextVersion bumps patch, minor, major, or accepts an explicit version", () => {
  assert.equal(nextVersion("0.1.1", "patch"), "0.1.2");
  assert.equal(nextVersion("0.1.1", "minor"), "0.2.0");
  assert.equal(nextVersion("0.1.1", "major"), "1.0.0");
  assert.equal(nextVersion("0.1.1", "0.3.0"), "0.3.0");
});

test("nextVersion rejects a malformed bump", () => {
  assert.throws(() => nextVersion("0.1.1", "latest"), /malformed bump/);
  assert.throws(() => nextVersion("0.1", "patch"), /malformed current version/);
});

test("syncPackageVersion updates package.json and package-lock.json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ragebait-release-"));
  try {
    await writeFile(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "ragebait-detector", version: "0.1.1", type: "module" }, null, 2)}\n`,
    );
    await writeFile(
      path.join(dir, "package-lock.json"),
      `${JSON.stringify({
        name: "ragebait-detector",
        version: "0.1.1",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "ragebait-detector", version: "0.1.1" } },
      }, null, 2)}\n`,
    );

    syncPackageVersion("0.1.2", dir);

    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    const lock = JSON.parse(await readFile(path.join(dir, "package-lock.json"), "utf8"));
    assert.equal(pkg.version, "0.1.2");
    assert.equal(lock.version, "0.1.2");
    assert.equal(lock.packages[""].version, "0.1.2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/release/release.test.js`
Expected: FAIL with `syncPackageVersion is not a function` (or an import error).

- [ ] **Step 3: Implement `syncPackageVersion` in `scripts/release.mjs`**

Add after the `git` helper (line 78):

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/release/release.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/release/release.test.js scripts/release.mjs
git commit -m "feat(release): add package version sync helper"
```

### Task 2: Wire the sync into the release script

**Files:**
- Modify: `scripts/release.mjs:140-157`

**Interfaces:**
- Consumes: `syncPackageVersion` from Task 1.
- Produces: none.

- [ ] **Step 1: Call `syncPackageVersion` before the manifest rewrite**

In `main()`, replace:

```js
  writeManifestVersion(next);
  git("add", "manifest.mv2.json");
```

with:

```js
  syncPackageVersion(next);
  writeManifestVersion(next);
  git("add", "manifest.mv2.json", "package.json", "package-lock.json");
```

- [ ] **Step 2: Update the prompt text**

Change the prompt line `1. edit "version" in manifest.mv2.json` to `1. edit the version in manifest.mv2.json, package.json and package-lock.json`.

- [ ] **Step 3: Run the release test and the full check**

Run: `node --test tests/release/release.test.js && npm run check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add scripts/release.mjs
git commit -m "feat(release): bump package version on release"
```

### Task 3: Wire the sync into the release workflow button

**Files:**
- Modify: `.github/workflows/release.yml:108-131`

**Interfaces:**
- Consumes: `npm`, `git`.
- Produces: none.

- [ ] **Step 1: Add the two npm commands and widen the commit check**

In the `Bump, commit, tag and push (button path only)` step, after the
manifest rewrite `node -e` block and before `git config`, add:

```bash
npm pkg set version="${VERSION}"
npm install --package-lock-only --no-audit --no-fund
```

Change the commit block from:

```bash
if git diff --quiet -- manifest.mv2.json; then
  echo "manifest is already at ${VERSION}; tagging without a commit"
else
  git add manifest.mv2.json
  git commit -m "release: ${tag}"
fi
```

to:

```bash
if git diff --quiet -- manifest.mv2.json package.json package-lock.json; then
  echo "files are already at ${VERSION}; tagging without a commit"
else
  git add manifest.mv2.json package.json package-lock.json
  git commit -m "release: ${tag}"
fi
```

- [ ] **Step 2: Inspect the diff**

Run: `git diff .github/workflows/release.yml`
Expected: the two npm commands are inside the `run: |` block at the same
indentation as the manifest rewrite; the `git diff --quiet` and `git add` lines
list all three files.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat(ci): sync package version on the release button"
```

### Task 4: Full verification

- [ ] **Step 1: Run the full check**

Run: `npm run check`
Expected: PASS

- [ ] **Step 2: Commit any formatting fixes**

If `deno fmt` or `deno lint` reports issues, fix them and commit:

```bash
git add -u
git commit -m "style: format release version sync"
```
