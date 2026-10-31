# Privacy Policy — Ragebait Detector

Last updated: 2026-10-28

## What the extension does

Ragebait Detector adds a band (low/medium/high) to X (Twitter) hovercards,
based on an account's recent replies.

## Data collected

- **Heuristic mode (default):** the hovered handle is sent to
  `api.fxtwitter.com` to fetch that account's public replies. No other data
  leaves your device. Reply text is processed locally.
- **AI mode (opt-in):** additionally sends the handle, computed feature
  vector, and up to 12 reply snippets (trimmed to 400 characters) to the
  Worker proxy, which forwards them to Cloudflare (Clef 27B). This requires
  explicit consent in Settings before it can be enabled.

## Retention

No personal data is retained by the extension beyond your local settings
and cache. The Worker cache stores analysis results keyed by handle for up
to 48 hours. No account-level history is kept.

## Sub-processors

- FxTwitter (`api.fxtwitter.com`) — public reply data.
- Cloudflare (Workers + KV) — AI inference and caching (AI mode only).

## Your rights (GDPR)

You can request access or deletion of any data held about you by emailing
`ragebait-detector@example.com` (replace with the real address before
release). Misclassification reports can be submitted via the same address
using the template in the extension settings.

## Not definitive

Bands are estimates, not definitive judgments. A "high" band is not an
accusation of wrongdoing.

## Changes

This policy may change; the version shipped with the extension applies.