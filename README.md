# Ragebait Detector

<a href="https://x.com/ragebaitdetector" target="_blank">
  <img src="assets/mark.svg" alt="Ragebait Detector" width="48" height="48">
</a>

A browser extension for X (Twitter) hovercards — Firefox (MV2) and Chrome (MV3)
— that shows a ragebait / engagement-bait band based on the target account's
replies.

The extension supports local heuristic scoring, a consent-gated hosted Worker
proxy, BYOK AI mode, and self-hosted Worker deployments. The hosted proxy URL is
public and discoverable by design; it is not an authenticated extension-only
endpoint. Proxy mode sends the extracted feature state and a bounded reply
sample to the configured Worker, which calls Clef and returns a band and score.

The open-source Worker source describes its processing behavior. API keys and
deployment secrets remain in Cloudflare Worker secrets and are never bundled in
the extension. X account IDs and install tokens are quota/accounting identifiers
only: they are forgeable, are not authentication, and do not prove that a
request came from an official or unmodified client.

[![Firefox](https://img.shields.io/badge/Firefox-Install-FF7139?style=flat-square&logo=firefoxbrowser)](https://github.com/berkaykrc/ragebait-x#install)
[![Chrome](https://img.shields.io/badge/Chrome-Install-4285F4?style=flat-square&logo=googlechrome)](https://github.com/berkaykrc/ragebait-x#install)

## Status

- Latest release:
  [Releases](https://github.com/berkaykrc/ragebait-x/releases/latest). The
  version of record is `version` in `manifest.mv2.json`; the release script and
  the release workflow bump it and keep `package.json` and `package-lock.json`
  in sync with it.
- Modes: heuristic, proxy, and BYOK (`MODEL_VERSION = "h1"`,
  `FEATURE_VERSION = "f1"`). Proxy mode uses the public endpoint
  `https://ragebait-proxy.dontseemyass.workers.dev/analyze` by default. The
  options page can point it at your own Worker.
- Browser: Firefox (MV2) and Chrome (MV3) — `npm run build` emits both roots.
  Firefox releases are signed via the release workflow. Chrome MV3 has no store
  or publish step, so the `ragebait-detector-mv3.zip` release asset is the
  distributable.
- Data source: the public FxTwitter API (`api.fxtwitter.com`)

## Install

The extension works on x.com and twitter.com in a desktop browser. The download
links below point at the latest GitHub Release, so they need a public repository
to resolve.

### Firefox

1. Download
   [`ragebait-detector.xpi`](https://github.com/berkaykrc/ragebait-x/releases/latest/download/ragebait-detector.xpi).
2. Open `about:addons` in Firefox.
3. Click the gear icon and choose "Install Add-on From File".
4. Select the downloaded `.xpi`.

The build is signed by AMO and released as an unlisted add-on, so it installs on
any Firefox build and does not appear in the AMO search. Firefox reads
`updates.json` on its own, so new versions install themselves.

### Chrome

1. Download
   [`ragebait-detector-mv3.zip`](https://github.com/berkaykrc/ragebait-x/releases/latest/download/ragebait-detector-mv3.zip).
2. Extract it.
3. Open `chrome://extensions` and turn on Developer mode.
4. Click "Load unpacked" and select the extracted folder.

There is no Chrome Web Store listing and no update path. After a new release,
download the zip again and load it over the existing folder.

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

## Hosted Worker API

The hosted Worker is a public service, not an authenticated extension-only
endpoint. CORS is open and its quota identities (install tokens, X viewer IDs)
are forgeable client identifiers: abuse resistance, not authentication. Any HTTP
client gets exactly the same contract.

- `GET /config` — public feature flags only (`modelVersion`, `featureVersion`,
  `bandThresholds`, `selectors`, `showNumber`, `proxyUrl`, `proxyEnabled`). No
  secrets or debug routes; wrong method is answered 405.
- `POST /analyze` — documented body `{ state, installToken }` with the optional
  `X-Install-Token` / `X-Quota-Identity` headers. The input gate accepts at most
  16 KiB of JSON, at most 12 reply snippets of at most 400 characters each, and
  strictly allowlisted body/state/feature keys. Every model miss consumes one
  daily quota unit for the caller's identity before the model is involved;
  cached results (the shared 48-hour cache) are returned with 200 and never
  consume quota or call the model.

`/analyze` errors are bounded, so callers get a stable contract:

| Body                                 | Status | Retry-After | Meaning                                                                                                                                               |
| ------------------------------------ | ------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{"error":"invalid_request"}`        | 400    | —           | Any input-gate violation (size, shape, allowlist key, depth or field bound). Opaque by design; the request body is never echoed or logged.            |
| `{"error":"install_token_required"}` | 400    | —           | No bounded quota identity in header or body.                                                                                                          |
| `{"state":"quota"}`                  | 429    | —           | That identity's daily model-call quota is exhausted (`x-quota-remaining: 0`). Cached responses keep returning 200.                                    |
| `{"error":"model_calls_paused"}`     | 503    | 60          | The operator kill switch (`QUOTA_KILL_SWITCH`) is engaged or the global daily model-call ceiling (`GLOBAL_DAILY_MODEL_CEILING`) is used up.           |
| `{"error":"quota_unavailable"}`      | 503    | 60          | Quota protection itself failed (KV store, counter backend or secret-dependent identity could not be derived) — fail closed, never silently unlimited. |
| `{"error":"ai_unavailable"}`         | 502    | —           | The model upstream failed (Clef, then the Jev fallback); the quota unit for that miss is spent.                                                       |

Routes outside `/config` and `/analyze` answer 404. Per-IP and global request
rate limits are Cloudflare edge/WAF configuration, not Worker code.

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

Node is pinned by `.nvmrc` (`26.13.0`); tooling is Deno.

```sh
npm install
npm run build
```

Then load the root for your browser:

1. Firefox: open Nightly, Developer Edition, or an unbranded build, then
   `about:debugging` -> "This Firefox" -> "Load Temporary Add-on" ->
   `dist-mv2/manifest.json`.
2. Chrome: `chrome://extensions` -> enable Developer mode -> "Load unpacked" ->
   `dist-mv3/`.

Unsigned builds run on Nightly / Developer Edition / unbranded builds only. That
is the local development path: `dist-mv2/manifest.json` is loaded as a temporary
add-on and disappears when Firefox closes. Nothing is signed locally. A
permanent install comes from the signed `.xpi` in the GitHub Release. See
[Install](#install) for the release install path.

## Privacy

- In **all** modes the extension contacts FxTwitter
  (`https://api.fxtwitter.com`) to fetch the target account's public replies;
  the handle is sent immediately on hover, and in heuristic mode this fetch is
  the only off-device call. The options page carries a data notice in every
  mode; the AI modes add the endpoint notice.
- Heuristic mode uses no AI. The band is computed inside the extension from the
  fetched replies, and no reply text is sent to a model or to the Worker. The
  FxTwitter fetch is the only off-device call in this mode. Proxy and BYOK modes
  require the data-handling notice to be accepted before sending feature state
  and sampled reply text to the selected endpoint.
- In proxy or BYOK mode, reply snippets have third-party `@username` handles
  scrubbed to `@…`, full `http(s)://` URLs replaced with `[link]`, and
  email-like addresses best-effort replaced with `[email]` before transmission.
  Decision models cannot browse links, so URLs cost tokens and contribute
  nothing; `@mentions` and email-like addresses add no signal either. This
  minimises token usage on the inference API and best-effort reduces broadcast
  of third-party handles and email-like addresses, while preserving quoted tweet
  contents, linguistic cues, and conversation context intact.
- Proxy mode sends `{ state, installToken }` to `/analyze`. `state` contains the
  handle, computed feature object, and at most 12 reply snippets truncated to
  400 characters each. The Worker sends the normalized state plus four binary
  questions and one three-level intensity question to Clef 27B, with Jev as a
  fallback. BYOK mode sends the same state to the user's configured endpoint
  with the user's API key. No API keys are bundled in the extension.
- **Install Token Lifecycle:** The installation token is a locally generated
  anonymous identifier (16 random crypto bytes stored in
  `browser.storage.local`). It is stored with **no rotation and no expiry**: one
  token per install, kept until storage is cleared or the extension is
  reinstalled. The _usage counter_ resets after each 200-per-day window; the
  token itself does not. The token contains no personal or device data and
  cannot identify a person. The hosted proxy sees the same token on every proxy
  request, so it can count that install's daily usage and block quota abuse. The
  token is sent only to the hosted proxy; it is not sent to any other website.
  It is intentionally **not exposed for manual reset or rotation**: offering a
  reset would let anyone mint a fresh token and bypass the 200/day limit,
  abusing the hosted proxy. This purpose is shown in the options page quota card
  (including as a tooltip).
- **Mozilla Data Collection Declaration (`data_collection_permissions`):** This
  is a _declaration of what is collected_, not a runtime permission. It is
  separate from host permissions (`https://x.com/*`, `https://twitter.com/*`,
  `https://api.fxtwitter.com/*`, the proxy), which grant network access.
  - `websiteActivity` (Required): Core functionality detects profile hovers on X
    and, in all modes, requests that account's public reply metadata from
    FxTwitter (`api.fxtwitter.com`) using the hovered handle.
  - `websiteContent` (Optional): In default Heuristic mode, tweet reply content
    never leaves the device. Only when the user voluntarily enables AI mode and
    accepts the consent gate are reply snippets (best-effort scrubbed) sent to
    the selected AI endpoint for scoring; this is declared as optional,
    user-consented collection under Mozilla AMO policy rather than as required.
  - The install token is a random anonymous identifier, not personal data. It is
    sent only to the hosted proxy for quota accounting and is described in the
    install-token lifecycle and options notice above.
- **Data Minimisation & Local Storage:**
  - Analysis results in `browser.storage.local` have a bounded 7-day TTL and are
    physically deleted on read once expired; a background boot sweep also
    removes expired entries for handles that are never re-hovered.
  - Historical daily quota counters (`stats:YYYY-MM-DD`) are automatically
    pruned after 7 days on background initialization.
  - Options page is hardened with a strict Content Security Policy
    (`default-src 'none'`) and `Referrer-Policy: no-referrer`. Extension pages
    are served as `moz-extension://`/`chrome-extension://` documents, so no HTTP
    response headers can be sent; these `<meta>` directives are the only
    available enforcement. A `Permissions-Policy` meta tag is deliberately not
    used: the specification defines it as a response header only, so a meta tag
    has no effect.
- Results are shown only to the hovering user. There are no public lists.

Self-hosting lets an operator deploy the open Worker source with their own
Cloudflare account, KV namespace, model credentials, limits, and endpoint. The
hosted service is optional; the operator can be contacted through the project's
[GitHub issue tracker](https://github.com/berkaykrc/ragebait-x/issues). The
Worker does not provide account-level export or deletion for its shared cache;
cached results expire after 48 hours, and a request cannot reliably identify all
records associated with a forgeable public identifier.

## Scripts

- `npm run check` - all gates in order: `lint:js` -> `fmt:check` -> `build` ->
  `check:artifacts` -> `lint` -> `test`.
- `npm run build` - esbuild both build roots (`dist-mv2/` and `dist-mv3/`).
- `npm run check:artifacts` - fail if built artifacts contain credential-shaped
  values.
- `npm run lint` - web-ext lint on `dist-mv2/` plus the dual-manifest test.
- `npm run lint:mv3` - the dual-manifest test on its own.
- `npm run lint:js` - Deno lint.
- `npm run fmt` / `npm run fmt:check` - Deno format.
- `npm test` - Node test runner for the extension and the Worker (requires
  `npm run build` first; two test files read the built roots off disk).
- `npm run package` - `web-ext build` on `dist-mv2/`, writes
  `web-ext-artifacts/*.zip`.
- `npm run package:mv3` - packages `dist-mv3/` as
  `web-ext-artifacts/ragebait-detector-mv3.zip`.
- `npm run icons` - regenerate the PNG icons and the mark.
- `npm run deploy:production` / `npm run deploy:staging` - deploy the Worker
  with `wrangler` (see `docs/release.md`).
- `npm run release` - bump the version, commit, tag, and push. The tag starts
  the release workflow, which signs with AMO and attaches the release assets.
  Usage: `npm run release patch|minor|major|x.y.z`.

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
  hand (calibration is not finished).

## License

Apache-2.0. See `LICENSE`.
