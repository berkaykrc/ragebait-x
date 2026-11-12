# ragebait-detector

Browser extension for X (Twitter) hovercards, dual-target: Firefox MV2
(`dist-mv2/`) and Chrome MV3 (`dist-mv3/`). Vanilla JS ES modules, no
TypeScript. Node pinned by `.nvmrc` (26.13.0); language tooling is Deno.

## Commands

```
npm run check     # all gates, in order — use this
npm test          # one suite only
```

`check` runs `lint:js` (deno lint) → `fmt:check` (deno fmt) → `build` → `lint`
(web-ext) → `test`. Single test: `node --test tests/shared/security.test.js`.

**`npm test` requires a prior `npm run build`.** Two test files read the built
roots off disk — `tests/smoke.test.js` reads `dist-mv2/manifest.json`, and
`tests/build/dual-manifest.test.js` reads both `dist-mv2/manifest.json` and
`dist-mv3/manifest.json` — and fail with ENOENT without it. That is not a code
bug. `npm run check` builds before it tests, so its artifacts are always fresh.

**Bare directories work on the pinned Node** (verified on v26.13.0:
`node --test tests/` and `node --test worker/tests/` run their suites, same
counts as the globs). The `test` script still uses globs because they are
explicit and portable — on Node 22 a bare directory argument is loaded as a
module and fails (`Cannot find module '.../tests'`, exit 1). Prefer the glob
form:

```
node --test 'tests/**/*.test.js'
node --test 'worker/tests/**/*.test.js'
node --test tests/shared/security.test.js   # single suite (see above)
```

To run a subset of suites, quote a glob — e.g.
`node --test 'tests/shared/*.test.js'`.

## How it runs

Two separate JavaScript worlds, and the split is the whole design:

```
src/content.js ──injects──► src/page/index.js
  EXTENSION world            PAGE world
  (trusted)                  (untrusted — X's own code runs here too)
       │                            │
       └──── window.postMessage ────┘
            src/shared/messaging.js  ← the only bridge
                    │ browser.runtime.sendMessage
                    ▼
              src/background/index.js
              cache → FxTwitter → features → compose → quota → AI (proxy/BYOK)
                    │ makeScoreResponse
                    ▼
              back through the same bridge to the page
```

`npm run build` bundles content, page, background and options into BOTH roots:
`dist-mv2/` (Firefox, background as a script) and `dist-mv3/` (Chrome,
background as a service worker). Each root gets its own `manifest.json` copied
from `manifest.mv2.json` / `manifest.mv3.json`.

`src/shared/security.js` holds the trust gate and is imported by _both_ sides.
It lives in `shared/` for that reason and must never be bundled into `page.js` —
a trust check that runs in the page world is worthless, because the page world
is what you're checking.

The page may **request** a score for a handle. It may never **supply** one:
`ALLOWED_MSG_TYPES` has no result-carrying message type, and any payload with
`result`/`band`/`percent` at any nesting depth is rejected.

The session token in `<script id="ragebait-config">` is correlation, not
authentication — anything on the page can read it. See plan §3 and decision D13.

## Load it

`npm run build` emits both roots, then load the one for your browser:

- Firefox: `about:debugging` → This Firefox → Load Temporary Add-on →
  `dist-mv2/manifest.json`.
- Chrome: `chrome://extensions` → enable Developer mode → Load unpacked →
  `dist-mv3/`.

Unsigned Firefox builds work on Nightly / Developer Edition / unbranded only;
release Firefox needs the signed `.xpi` that the release workflow attaches to
the GitHub Release (`npm run release` pushes a tag; CI signs with AMO). Chrome
MV3 is loaded unpacked for now — there is no store or publish step yet.
