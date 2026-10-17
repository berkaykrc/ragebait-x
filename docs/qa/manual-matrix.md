# Manual QA matrix

Heuristic mode only. Run against a Firefox Nightly / Developer Edition /
unbranded build with the extension loaded from `dist-mv2/`. Record the result
in the **Pass/Fail** column. A failure is a blocker for release.

Latency requirement: **only** the cache-hit path has a latency bound
(≤ 200 ms). No other path is timed.

| # | Condition | How to force it | Expected | Pass/Fail |
|---|-----------|-----------------|----------|-----------|
| 1 | Cache miss (first hover) | Clear extension storage (or use a handle never hovered), then hover the account. | Network fetch happens; line ends on `result` / `insufficient` / `error` per the account. No stale indicator. | |
| 2 | Cache hit (re-hover) | Hover an account, close the card, hover the same account again within its TTL. | No network request; cached value renders. | |
| 3 | Cache-hit latency (≤ 200 ms) | Time the second hover in (2) from card open to rendered line, e.g. with the Performance panel or `performance.now()`. | Rendered within 200 ms of the cache returning. This is the **only** latency requirement. | |
| 4 | Offline | Block the network (DevTools "Offline", or firewall `api.fxtwitter.com`), hover an account with no cached entry. | Fetch fails with no partial replies -> state `error`, copy "analysis failed". | |
| 5 | Flaky 404 (3 x 404) | Hover a handle FxTwitter answers with 404 (or mock `fetchImpl` returning 404 three times). The client retries 1 + 2 times. | State `error` ("analysis failed"), **not** `insufficient`. | |
| 6 | Transport error (5xx on page 2) | Force the second pagination request to return 5xx while partial replies (>= 5) are already collected, e.g. via a request-blocking rule or a mocked `fetchReplies`. | State `estimated`, band still shown, copy carries "(estimated (no model))". | |
| 7 | Rate limit (429) | Force FxTwitter to return 429 (or mock it); ensure partial replies (>= 5) are collected. | State `estimated`, band still shown. | |
| 8 | Quota exhaustion (local) | Pre-fill `stats:{YYYY-MM-DD}` to `MAX_DAILY_PROFILES` (200) in `browser.storage.local`, then hover an account that would otherwise score. | State `quota`, copy "quota exceeded - retry tomorrow", with the heuristic band still rendered beneath it. | |
| 9 | Hovercard-close cancellation | Hover an account, then move the pointer away before the fetch resolves. | The in-flight request is aborted, exactly one `rb:score-cancel` is emitted, and no quota is consumed. Re-hovering fetches fresh. | |
| 10 | DOM change (broken selectors) | In DevTools, remove or rename the hovercard's `following` link (or the avatar container), then hover an account. | No line is inserted; a console warning is logged ("ragebait: hovercard has no /{handle}/following link; skipping" for the link case). The page does not break. | |
| 11 | Account with < 5 replies | Hover an account whose qualifying replies are fewer than `MIN_REPLIES` (5). | State `insufficient`, copy "insufficient data", no band. | |
| 12 | Non-TR/EN account | Hover an account whose replies are in a language outside TR/EN. | Score still computes with `lexiconHits = null` and `langSupported = false`; state `result`/`insufficient` as applicable, no crash. | |

## Notes

- `error` is cached for 30 minutes; a false 404 therefore cannot latch beyond
  that. `estimated` is cached for 1 hour, `insufficient` for 6 hours, `result`
  for 7 days. `quota` is never cached.
- The stale indicator appears once a cached entry is past 50% of its TTL.
- To reset state between runs, clear `browser.storage.local` for the extension
  from `about:debugging` or the extension's options page.