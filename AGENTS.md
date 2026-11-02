# ragebait-detector

Firefox MV2 extension. Vanilla JS ES modules, no TypeScript. Node pinned by
`.nvmrc` (26.13.0); language tooling is Deno.

## Node is already on PATH

`node` and `npm` resolve to `~/.nvm/versions/node/v26.13.0/bin/*` on this
machine. **Do not prefix commands with `source ~/.nvm/nvm.sh` or `nvm use` — it
is redundant, it hides errors behind `2>/dev/null`, and it bloats every
command.** Just run `npm test`. `.nvmrc` exists for human shells that go through
nvm themselves; if the pinned version is not installed yet, run `nvm install`
once, then use it.

## Commands

```
npm run check     # all gates, in order — use this
npm test          # one suite only
```

`check` runs `lint:js` (deno lint) → `fmt:check` (deno fmt) → `build` → `lint`
(web-ext) → `test`. Single test: `node --test tests/shared/security.test.js`.

**`npm test` requires `npm run build` first.** Two tests read `dist-mv2/` off
disk and fail with ENOENT without it. That is not a code bug.

**Do not "fix" the test script to `node --test tests/`.** On Node 22 a bare
directory argument is loaded as a module and fails
(`Cannot find module '.../tests'`, exit 1). The script uses globs for that
reason.

The same trap applies to direct invocations: `node --test tests/` or
`node --test worker/tests/` fails the same way (a single wrapper failure
instead of running the suites). Use the glob form:

```
node --test 'tests/**/*.test.js'
node --test 'worker/tests/**/*.test.js'
node --test tests/shared/security.test.js   # single suite (see above)
```

To run a subset of suites, quote a glob — e.g.
`node --test 'tests/shared/*.test.js'` — never the bare directory.

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
              src/background/        (plan Task 8 — not built yet)
```

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

`npm run build`, then `about:debugging` → This Firefox → Load Temporary Add-on →
`dist-mv2/manifest.json`. Unsigned works on Nightly / Developer Edition /
unbranded only; release Firefox needs a signed `.xpi` (plan Task 10.5).
