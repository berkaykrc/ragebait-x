# Chrome Release Asset Design

**Date:** 2026-11-12
**Status:** Approved

## Intent

Every GitHub Release already ships a signed Firefox XPI. Chrome MV3 is built
and linted but never published, so installing it means building locally. Ship
a Chrome-loadable zip as a release asset, and make the MV3 version impossible
to drift from MV2.

## Goals

- `release.yml` packages `dist-mv3` after the build and attaches
  `web-ext-artifacts/ragebait-detector-mv3.zip` to the Release.
- The artifact secret scan runs after packaging, so the zip is scanned too.
- `scripts/release.mjs` bumps `manifest.mv2.json` and `manifest.mv3.json`
  together.
- The `release.yml` button path bumps, commits, and asserts both manifests.
- `tests/build/dual-manifest.test.js` asserts MV2, MV3, and `package.json`
  carry the same version.

## Non-Goals

- Chrome Web Store upload or publish.
- OAuth client, refresh token, or store item ID secrets.
- CRX signing. The Chrome Web Store signs server-side when it accepts an
  upload; no local signing step exists.
- Store listing, screenshots, or review workflow.

## Constraints

- No new dependency. `web-ext` is already a devDependency and already
  packages the MV2 root.
- The release must pass with no Chrome credentials configured.
- The Firefox release contract is unchanged: same XPI name, same
  `updates.json`, same tag and version rules.

## Approaches Considered

1. **Release asset only.** Build, scan, zip, attach. No store code. Chosen.
2. **Asset plus gated store upload.** Same asset, plus a `CWS_*`-gated upload
   step. Rejected for now: no credentials exist, and the upload code cannot be
   exercised.
3. **Require store publish.** Fail the release without credentials. Rejected:
   impossible today.

## Decisions

- Use `web-ext build` for the MV3 zip. It is already installed and already
  drives the MV2 package step.
- Copy the versioned web-ext output to the stable asset name
  `ragebait-detector-mv3.zip`, so the download URL never changes between
  releases.
- Keep `manifest.mv2.json` as the version of record. The script reads it and
  writes that version into both manifests.
