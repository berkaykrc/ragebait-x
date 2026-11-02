# Privacy Policy — Ragebait Detector

Last updated: 2026-11-02

## What the extension does

Ragebait Detector adds a band (low/medium/high) to X (Twitter) hovercards,
based on an account's recent replies.

## Data collected

- **Heuristic mode (default):** the hovered handle is sent to
  `api.fxtwitter.com` to fetch that account's public replies. No other data
  leaves your device. Reply text is processed locally.
- **AI mode (opt-in):** additionally sends `{ state, installToken }` to the
  selected endpoint. `state` contains the handle, computed feature vector, and
  up to 12 reply snippets trimmed to 400 characters each. In hosted proxy mode,
  the Worker forwards a normalized state plus four binary questions and one
  three-level intensity question to Clef 27B, falling back to Jev if Clef is
  unavailable. This requires explicit consent in Settings before it can be
  enabled.

Heuristic mode keeps AI processing local. Proxy mode uses the public hosted
Worker URL, which is discoverable by design and is not an authenticated
extension-only API. BYOK sends the same state to the endpoint and API key the
user configures. Self-hosted mode uses a Worker deployment operated by the
user. The open-source Worker source documents processing behavior; model API
keys and deployment secrets stay in Cloudflare Worker secrets.

## Retention

No personal data is retained by the extension beyond your local settings and
cache. The Worker shared KV cache stores analysis results under a derived key
for up to 48 hours. Model misses consume one daily quota unit per install
token. X account IDs, where enabled, and install tokens are quota/accounting
identifiers only: callers can forge them, and they are not authentication or
proof of an official client. No account-level history is kept.

The hosted Worker does not offer reliable account-level export or deletion: a
public identifier is not proof of identity, and cached entries expire
automatically after 48 hours.

The hosted Worker's logs carry only bounded operational metadata: HTTP status
codes, short upstream error-response snippets, and failure descriptions. Log
lines never contain reply snippets, request bodies, install tokens, API keys,
raw X account IDs, or model-generated content.

## Sub-processors

- FxTwitter (`api.fxtwitter.com`) — public reply data.
- Cloudflare (Workers + KV) — proxy execution, AI inference, and caching (AI
  mode only).
- Clef 27B and Jev via the Worker-configured model provider — model processing
  of the payload above (proxy mode only).

## Your rights (GDPR)

For operator questions or misclassification reports, use the project's
[GitHub issue tracker](https://github.com/berkaykrc/ragebait-x/issues). The
hosted service cannot reliably locate or delete records by a public quota
identifier; cached results expire after 48 hours.

## Not definitive

Bands are estimates, not definitive judgments. A "high" band is not an
accusation of wrongdoing.

## Changes

This policy may change; the version shipped with the extension applies.