# Review Findings Remediation Plan

**Created:** 2026-11-05 (reviews completed 2026-11-04/05 on the same machine)

**Goal:** one trackable list for every finding from the two completed reviews,
so the human partner can record a decision per item without re-reading the
review output.

**Source reviews:**

1. `git diff origin/main...main` — the 9 commits ahead of `origin/main`
   (`a966157`..`cc1b84e`): task 5/6 merge, compliance (update_url, data
   declaration, README/options disclosures), release workflow, artifact scan.
2. `git diff 74c4593..27d7ad9` — the "MV3 dual build" range: the whole Worker,
   AI layer, calibration tooling; treated by every SDD review as its
   untouched base (the worker-security plan's base is `27d7ad9`).

**Gate state at time of writing:** `npm run check` green (lint, fmt, build,
check:artifacts, web-ext 0 errors, 342/342 tests, Node 26.13.0).
`main` is 9 commits ahead of `origin/main` (`b6ae43f`); nothing from either
review is released.

**Not in this plan:** the worker-security plan's deferred items (staging
deploy evidence, production `/config` and 404 inspection) — those are tracked
in `.superpowers/sdd/2026-10-31-worker-security-plan/progress.md` and the
gate in `docs/release.md`. Nothing here invalidates the worker-security
conclusions.

**Severity key:** Critical > Important > Moderate > Minor. Nothing here is
Critical.

---

## A. Open findings — main-branch review (`origin/main...main`)

### A1 — Important (documentation): README contradicts the options page

- **Where:** `README.md:122-123` vs `src/options/index.html` (`#consent-ai`
  small print, added in `e05e16a`, shown in proxy/BYOK modes only)
- **What:** README claims "No first-run or options-page disclosure exists;
  the handle is sent immediately on hover." The options page ships a
  disclosure, so the blanket sentence is false for AI-mode users; it is
  true only for heuristic mode. This branch exists to make disclosure
  claims accurate (`e05e16a`, `17ab80e`); the contradiction undoes that.
- **Risk if wrong:** a reader (or an AMO reviewer) sees three different
  stories; the README is the public-facing one.
- **Options:**
  a. Reword (recommended): "In all modes the handle is sent immediately on
     hover. A notice on the options page (AI modes only) also explains it."
     — keep it to one line, British English, no promise about consent.
  b. Leave as is and accept the mismatch.
- **Your decision (2026-11-05):** A — reword, and also specify how heuristic
  mode uses the handle; the AI-only small print did not explain the
  heuristic path. Implemented: README privacy bullet now states the fetch
  happens in every mode and is the only off-device call in heuristic mode;
  the options page gained an always-visible amber `Data notice` strip
  (`.rb-notice`, every mode) and the AI-mode consent card now shows the
  disclosure **above** the checkbox, styled as a warning
  (`.rb-warning`), with the label reading "I accept the data handling
  described above". `.rb-small-print` (unstyled) is gone.
- [x] A1-a: reworded README privacy bullet; options page disclosure now
  covers the heuristic path and stands out as a warning.

### A2 — Minor (pre-existing): release.yml `workflow_dispatch` path cannot complete

- **Where:** `.github/workflows/release.yml` — header comment, "Assert the
  tag matches the manifest version", `gh release create "${GITHUB_REF_NAME}"`
- **What:** on the "Run workflow" path, `GITHUB_REF_NAME` is the branch
  (e.g. `main`), not the tag the job creates. The assert step fails
  (manifest version vs `main`) before signing — safe, but guaranteed to
  fail — and the release would be created against `main` even if the assert
  were skipped. The tag path (`npm run release patch`, documented in
  `docs/release.md`) is unaffected.
- **Risk if wrong:** an operator clicks "Run workflow" and gets a failed run
  (fail-closed at the assert; no signing occurs, no broken release created).
- **Options:**
  a. Delete the button path: remove `workflow_dispatch:` trigger + header
     comment; keep only the tag path. Smallest, safest.
  b. Fix it: capture the pushed tag in an env var during the bump step and
     use it for the assert step and `gh release create`.
  c. Leave and accept the misleading header.
- **Your decision (2026-11-05):** b — fix it. The bump step exports
  `RELEASE_TAG=<tag>` via `$GITHUB_ENV`; the tag-assert step and
  `gh release create` resolve `tag_name="${RELEASE_TAG:-${GITHUB_REF_NAME}}"`.
  The tag path behaviour is unchanged.
- [x] A2: applied decision b.

### A3 — Minor (documentation): line-number citations — DONE

- **Where:** `docs/release.md`
- **What:** citations like `worker/src/quota.js:188-228` drift from source.
  Replaced with symbol names only (`deriveQuotaNamespace`, `getQuotaKey`,
  `checkAndConsumeQuotaLegacyCounter`, `resolveQuotaCounter`,
  `buildQuotaCounterKey`, `callClef`, `callJev`).
- **Status:** fixed 2026-11-05; **uncommitted** (`M docs/release.md`).
- **Your decision (2026-11-05):** hold the commit. Commit each section only
  when sections A, B and C are all done.
- [x] A3: `docs/release.md` was committed as part of fc3b06b
  (symbol-name citations + zip-name wording). The 2026-11-05 ruling
  ("commit only when sections A, B and C are all done") never came into
  force — the human partner committed A1–A5 together on 2026-11-06.

### A4 — Nit (optional): `update-manifest.mjs` `argValue` does not validate values

- **Where:** `scripts/update-manifest.mjs`
- **What:** `--out` as the last argument yields an uncaught TypeError
  instead of a clear usage error; a following flag is taken as the value.
  CI always passes a value, so no runtime impact today.
- **Options:** add a 5-line guard + one test, or drop.
- **Your decision (2026-11-05):** add the guard + one test. Implemented
  (TDD): `argValue` is exported and rejects a trailing flag or a
  following `--flag` with `missing value for <flag>`; test watched fail
  first (no such export), then passes.
- [x] A4: guard + test added (`scripts/update-manifest.mjs`,
  `tests/release/update-manifest.test.js`).

### A5 — Nit (cosmetic): zip filename wording mismatch

- **Where:** `docs/release.md` extension step (`ragebait_detector-<version>.zip`)
  vs verification section (`web-ext-artifacts/*.zip`)
- **What:** both match `web-ext build` output; only wording differs.
- **Validation (2026-11-05):** `npm run package` produces
  `web-ext-artifacts/ragebait_detector-0.1.1.zip` by default — the
  `{name}-{version}.zip` template with the manifest name lowercased and
  non-alphanumerics replaced with `_` (web-ext source:
  `lib/cmd/build.js`). Both doc wordings were valid; unified to the
  explicit default filename, and the docs now note where the name comes
  from.
- **Your decision (2026-11-05):** validate first, then align. Done.
- [x] A5: validated against a real `npm run package` run; both sections of
  `docs/release.md` now use `ragebait_detector-<version>.zip`.

---

## B. Open findings — MV3-range review (`74c4593..27d7ad9`)

Baseline recap: these commits shipped the entire Worker + AI layer +
calibration tooling; the worker-security plan treated them as its untouched
base, so they were never reviewed until this pass. Nothing from this range
is released (no tag contains `27d7ad9`).

### B1 — Important (test coverage): AMO no-re-upload guard is untested

- **Where:** `scripts/release.mjs` (`isValidVersion`, `nextVersion`);
  deleted test was `tests/release/version.test.js`
- **What:** `230023f` ("prune brittle suites") deleted the only suite for
  the version bump logic. A bad bump creates an unrecoverable AMO version
  number; the only backstop now is AMO's own error mid-release.
- **Decision already given (2026-11-05, human partner):** accepted —
  classified as red-group brittle linter-like test (only checks semver string
  splitting; unrelated to extension function). Recorded; not re-raised.
- **Residual accepted:** if `npm run release patch` is ever edited, there is
  no safety net. No action.
- **Status:** CLOSED (decision recorded).

### B2 — Moderate (test coverage): MV2 FxTwitter host permission unpinned

- **Where:** `manifest.mv2.json` `permissions` (`https://api.fxtwitter.com/*`);
  deleted guard was `tests/compliance/manifest.test.js`
- **What:** content-script match patterns do **not** authorise a
  cross-origin fetch; the permission is mandatory in all modes. Nothing now
  pins it for MV2 (dual-manifest test pins MV3 `host_permissions` only;
  data-declaration test pins data-collection permissions only;
  `web-ext lint` proves lint-cleanliness, not permission necessity).
- **Risk if wrong:** a dropped/renamed permission builds and lints clean,
  then every FxTwitter fetch fails at runtime.
- **Decision already given (2026-11-05, human partner):** accepted —
  group deleted as red-group; manifest correctness is entrusted to
  `web-ext lint`. Recorded; not re-raised.
- **Residual accepted:** keep the permission; if it is ever removed, no test
  fires. No action.
- **Status:** CLOSED (decision recorded).

### B3 — Moderate (data governance): real people labelled in a public repo

- **Where:** `data/labeled/accounts.jsonl` (18 rows; `OtakuPride11037`,
  `pearl_white`-class handles; several duplicate lines, e.g. `Envi_4` ×4)
- **What:** real, identifiable X accounts publicly labelled `ragebait` /
  `normal`, in a public repository. Public handle + reputational claim.
  Not in the XPI; purely repo-visibility exposure.
- **Risk if wrong:** members of the public see their handle listed as
  "ragebait" in a public repo; reputational harm and no consent.
- **Options:**
  a. Delete the file; keep the calibration pipeline non-reproducible but
     honest, or regenerate from a private source.
  b. Anonymise: replace handles with stable hashes; keep labels for the
     eval; drop names.
  c. Keep as is (public handles are public data; labels are your own
     opinion) — recorded as a deliberate decision.
- **Your decision (2026-11-06):** keep — the file stays as committed in
  `c7adb47`. It will NOT be added to `.gitignore`, and history will NOT be
  rewritten: a single commit already shipped, and a recall would do more
  harm than good. When calibration is done, the human partner deletes or
  moves `data/labeled/accounts.jsonl` out of the repo. No code change;
  recorded only.
- [x] B3: decision recorded (keep in-tree; delete/move after calibration —
  human partner action).

### B4 — Minor (code hygiene): duplicated assignment block

- **Where:** `src/background/index.js:395-401`
- **What:** `band = aiRes.band; model = aiRes.model || mode;
  heuristic = false;` appears twice, verbatim. Harmless at runtime; a marker
  that this block merged without re-reading. Still present on `main`.
- **Options:** delete the duplicate three lines (1-line diff) or leave.
- **Your decision (2026-11-06):** remove the duplicates.
- [x] B4: the verbatim duplicated three lines were removed
  (`src/background/index.js`, the doubled `band = aiRes.band; model =
  aiRes.model || mode; heuristic = false;`). Full gate green.

### B5 — Minor (privacy): `installToken` forwarded on BYOK requests

- **Where:** `src/ai/client.js:147`
- **What:** the request body to the **user's own BYOK endpoint** also
  carries the user's `installToken`. It serves no purpose there (BYOK auth is
  `Bearer apiKey`) and hands a third-party service a stable tracking ID.
- **Options:** send `installToken` only when `mode === "proxy"` (or omit when
  unset); or leave (documented behaviour, harmless for self-hosted endpoints).
- **Your decision (2026-11-06):** gate `installToken` to proxy mode only
  (`mode === "proxy"`).
- [x] B5: implemented (TDD) — the BYOK request body no longer carries
  `installToken` (body is `{ state }`); proxy mode keeps the documented
  `{ state, installToken }` payload; `X-Install-Token` remains proxy-only.
  Test watched fail first, then pass.

### B6 — Minor (performance): `/config` fetched on every proxy-mode hover

- **Where:** `wireBrowserRuntime` in `src/background/index.js`,
  `fetchConfig` in `src/ai/client.js`
- **What:** every `rb:score-request` in proxy mode triggers an extra GET to
  the Worker `/config` before FxTwitter + `/analyze`; on Worker failure
  `config` degrades silently to `{}` (handled, but `bandThresholds` and
  `showNumber` revert to code defaults with no signal).
- **Options:** cache the config with a TTL (5–10 min) in extension storage;
  or leave (simple, correct, just chatty).
- **Your decision (2026-11-06):** add TTL cache; TTL = 5 min, in extension
  storage.
- [x] B6: implemented (TDD) — `fetchConfigCached` in `src/ai/client.js`:
  5-minute TTL, entry bound to the `proxyUrl` it was fetched from (a proxy
  change never serves a stale Worker's config), failed fetches are never
  cached (next call retries), corrupt entries are ignored. Wired into
  `wireBrowserRuntime` via a hoisted items-dialect storage adapter shared
  with `getInstallToken`. Wiring test proves one `/config` fetch per TTL
  window across score requests.

---

## C. Verification and bookkeeping

- Applied changes: A1 (README + options page + `brand.css`), A2
  (`.github/workflows/release.yml`), A3/A4/A5 (`docs/release.md`,
  `scripts/update-manifest.mjs` + test) — all committed as fc3b06b
  ("fix: close review findings A1-A5", 2026-11-06). B3 is a decision, not a
  change. B4 (`src/background/index.js`), B5 (`src/ai/client.js`) and B6
  (`src/ai/client.js` + `wireBrowserRuntime` in `src/background/index.js`;
  tests in `tests/ai/client.test.js` and
  `tests/background/settings-wiring.test.js`) are implemented and
  **uncommitted** as of 2026-11-06.
- Re-verify A3 with
  `grep -n -E '\.js:[0-9]+' docs/release.md` → no matches (re-checked
  2026-11-06, exit 1).
- B4/B5/B6 touch shipped files; full gate (`npm run check`) re-run
  2026-11-06 after implementing them: deno lint (81 files), fmt, build,
  check:artifacts, web-ext lint clean, 365/365 tests (342 at plan time,
  357 after the A1–A5 test additions, +8 for B5/B6).
- Commit policy (human partner, 2026-11-05): nothing is committed until
  sections A, B and C are all done. In practice the partner committed
  A1–A5 as fc3b06b before B was decided. B4/B5/B6 remain in the working
  tree; committing them is the human partner's call. Pushing stays your
  call.
- All B decisions are now recorded (B1, B2 closed 2026-11-05; B3–B6
  decided 2026-11-06). A1, A2, B4, B5, B6 are independent and can land in
  any order. B3 leaves `data/labeled/accounts.jsonl` in the repo until
  calibration is done, then it is deleted or moved (human partner action).
- `main` is 10 commits ahead of `origin/main` (fc3b06b); pushing stays
  your call. None of these items blocks the staged-gate release procedure
  in `docs/release.md`.
- Worker-security plan's deferred items (staging evidence etc.) stay in
  `.superpowers/sdd/2026-10-31-worker-security-plan/progress.md`; this plan
  deliberately does not duplicate them.

## D. Decisions summary (fill in)

| ID  | Decision | Status (open/done/rejected) | Date |
| --- | -------- | ---------------------------- | ---- |
| A1  | reword + heuristic path + warning-styled disclosure | done (committed fc3b06b) | 2026-11-05 |
| A2  | b — RELEASE_TAG via GITHUB_ENV | done (committed fc3b06b) | 2026-11-05 |
| A3  | commit only when sections A, B, C all done | done (committed fc3b06b) | 2026-11-06 |
| A4  | guard + one test (TDD) | done (committed fc3b06b) | 2026-11-05 |
| A5  | validate first; unified on `ragebait_detector-<version>.zip` | done (committed fc3b06b) | 2026-11-05 |
| B1  | keep deleted (accepted)      | closed 2026-11-05 | 2026-11-05 |
| B2  | keep deleted (accepted)      | closed 2026-11-05 | 2026-11-05 |
| B3  | keep; delete/move after calibration (no gitignore, no history rewrite) | done (delete/move = human partner action after calibration) | 2026-11-06 |
| B4  | remove the duplicate | done (uncommitted) | 2026-11-06 |
| B5  | gate `installToken` to proxy mode only (`mode === "proxy"`) | done (uncommitted) | 2026-11-06 |
| B6  | TTL cache = 5 min in extension storage | done (uncommitted) | 2026-11-06 |
