# Ragebait Detector

<a href="https://x.com/ragebaitdetector" target="_blank">
  <img src="assets/mark.svg" alt="Ragebait Detector" width="48" height="48">
</a>

A Firefox extension (MV2) that shows a ragebait / engagement-bait band inside X
(Twitter) hovercards, based on the target account's replies.

The extension supports local heuristic scoring, a consent-gated Worker proxy,
and BYOK AI mode. Proxy mode sends the extracted feature state and a bounded
reply sample to the configured Worker, which calls the Clef model and returns a
band and score.

## Status

- Latest release: [Releases](../../releases/latest). The version of record is
  `version` in `manifest.mv2.json`, which the release workflow bumps.
- Modes: heuristic, proxy, and BYOK (`MODEL_VERSION = "h1"`,
  `FEATURE_VERSION = "f1"`)
- Browser: Firefox (MV2). Chrome/MV3 is post-v1 and unverified.
- Data source: the public FxTwitter API (`api.fxtwitter.com`)

## How it works

1. Hover over an account on x.com / twitter.com.
2. The extension reads that account's replies through FxTwitter.
3. It computes a feature vector (caps, exclamation, rhetorical questions, target
   concentration, repeat-parent ratio, hashtag density, likes per reply, burst
   ratio, and a TR/EN ragebait lexicon) and composes a 0-1 score.
4. In proxy or BYOK mode, the feature state and up to 12 reply texts are sent to
   the selected AI endpoint after the user accepts the data-handling notice.
5. The AI band replaces the heuristic band when the model succeeds; failures
   retain the heuristic result.
6. A band (Low / Medium / High) is rendered in the hovercard. The numeric
   percentage is shown only when the Worker `/config` response enables
   `showNumber`.
7. Accounts with fewer than 5 qualifying replies show "insufficient data".

Results are cached locally per state with a per-state TTL, so re-hovering an
account does not re-fetch. Local results use a 7-day TTL; proxy analyses also
use the Worker's shared 48-hour cache.

## Brand

The mark at the top of this README is a miniature signal meter: three stacked
bars of increasing width inside a rounded-square tile, with the accent colour on
the longest bar. The bars are a signal meter in the same idea as the hovercard
pill — Low fills 1 segment, Medium 2, High 3 — but the mark itself is grayscale
with the accent on the longest bar; the green/amber/red band colours live on the
hovercard pill (see `--rb-band-low`, `--rb-band-medium`, `--rb-band-high`).

The tile uses the `--rb-ink` token for its background. Regenerate icons with
`npm run icons`.

## Development install

Node is pinned by `.nvmrc` (`22.13.0`); tooling is Deno.

```sh
npm install
npm run build
```

Then load `dist-mv2/` as a temporary add-on:

1. Open Firefox Nightly, Developer Edition, or an unbranded build.
2. Go to `about:debugging` -> "This Firefox" -> "Load Temporary Add-on".
3. Select `dist-mv2/manifest.json`.

Unsigned builds run on Nightly / Developer Edition / unbranded builds only.
`xpinstall.signatures.required=false` (about:config) allows an unsigned
_persistent_ install on those non-release builds. It does **not** work on
release Firefox, which requires a signed `.xpi` (see Task 10.5, not included in
this alpha).

## Privacy

- In **all** modes the extension contacts FxTwitter
  (`https://api.fxtwitter.com`) to fetch the target account's replies. That
  fetch is an off-device disclosure of the hovered handle. It is disclosed on
  the options page (`src/options/index.html`).
- Heuristic mode keeps AI processing local. Proxy and BYOK modes require the
  data-handling notice to be accepted before sending feature state and sampled
  reply text to the selected endpoint.
- Proxy mode sends data to the configured Worker, which may forward the sample
  to Clef and Jev. BYOK mode sends it to the user's configured endpoint with the
  user's API key. No API keys are bundled in the extension.
- Results are stored in `browser.storage.local` on the user's machine; there is
  no extension user account. Proxy responses may be shared through the Worker's
  48-hour cache.
- Results are shown only to the hovering user. There are no public lists.

## Scripts

- `npm run check` - all gates in order: `lint:js` -> `fmt:check` -> `build` ->
  `lint` -> `test`.
- `npm run build` - esbuild both build roots.
- `npm run lint` - web-ext lint on `dist-mv2/`.
- `npm run lint:js` - Deno lint.
- `npm run fmt` / `npm run fmt:check` - Deno format.
- `npm test` - Node test runner (requires `npm run build` first; two tests read
  `dist-mv2/` off disk).
- `npm run package` - produces `web-ext-artifacts/*.zip`.

## Contributing

1. Fork and create a branch.
2. `npm ci`
3. Make your change. Keep edits small and focused.
4. Run `npm run check` and fix every failure.
5. Run `npm run fmt` so Deno owns the formatting.
6. Do not commit `dist-mv2/`, `dist-mv3/`, or `web-ext-artifacts/`.
7. Open a pull request describing what and why.

Notes for contributors:

- The trust boundary lives in `src/shared/security.js` and runs in the extension
  world only. Never bundle it into `page.js`.
- The page world may request a score; it may never supply one.
- Weights in `src/analysis/compose.js` are placeholders; do not tune them by
  hand (calibration is Plan 3).

## Roadmap

- **Plan 2 - AI layer**: complete for the Worker proxy path; BYOK support and
  diagnostics are also wired in the extension.
- **Plan 3 - Calibration**: labelled set, reliability report, and enabling the
  numeric percent in the hovercard through the Worker's `showNumber` gate.
- **Phase 4 - Compliance & release**: AMO submission, first-run consent screen,
  `data_collection_permissions` declaration, signed `.xpi`, `update_url`, real
  gecko id.
- **Phase 5 - Deep mode (deferred)**: `UserByScreenName` /
  `UserRepliesTimeline`, transaction signing, DOM enrichment.

Out of scope for v1: Chrome support, mobile Firefox, deep mode, a third AI tier,
target-account size asymmetry, bundled local model, multi-device sync.

## License

Apache-2.0. See `LICENSE`.
