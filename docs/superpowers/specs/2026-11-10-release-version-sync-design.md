# Release Version Sync Design

**Date:** 2026-11-10

## Intent

On release, keep `package.json` and `package-lock.json` in sync with the
extension version in `manifest.mv2.json`.

## Approaches

- **A. `npm version <ver> --no-git-tag-version`** — one command, updates both
  files. Not idempotent: exits 1 with `Version not changed` when the version is
  already the target. Expands the one-line `engines` object.
- **B. Regex rewrite of both files** — minimal diff, but a regex can miss a
  field. Rejected.
- **C. `npm pkg set version=<ver>` + `npm install --package-lock-only`** — npm
  commands only, idempotent, authoritative lock sync. Chosen.

## Decisions

- Use `npm pkg set version=<ver>` to set the package version.
- Use `npm install --package-lock-only --no-audit --no-fund` to sync the lock.
- Stage `package.json`, `package-lock.json`, and `manifest.mv2.json` in the
  release commit.
- Widen the `release.yml` button-path commit condition to all three files.

## Edge cases

- `npm pkg set` expands the one-line `engines` object and reorders
  `devDependencies`. `deno fmt --check` accepts both.
- `npm install --package-lock-only` re-resolves the dependency tree. For a
  version-only change, it changes only the two version fields.
- A hand-bumped `package.json` is a no-op, not an error.

## Non-goals

- No change to `manifest.mv2.json` handling.
- No change to `worker/package.json`.
