# Hosted Worker Security and Transparency Plan

> **For agentic workers:** Implement this plan task-by-task. Keep the checkbox
> steps and run the focused validation named by each task before moving on.

**Goal:** Protect the operator's AI credits and users' data without pretending
that a public Firefox extension can contain a secret or cryptographically prove
that a request came from an unmodified extension.

**Decision:** The hosted Worker is a public service, not an authenticated
extension-only API. The Worker source, request contract, data handling, and
limits are public. Deployment secrets remain only in Cloudflare Worker
secrets. Abuse resistance comes from server-owned quotas, rate limits, WAF and
cost controls. Users who do not want to use the hosted service can use BYOK or
self-host the Worker.

**Related plan:** [X Account Quota Identity Implementation Plan](./2026-10-31-x-account-quota-plan.md)
defines the optional pseudonymous quota namespace. This plan defines the
security and transparency boundary around it; it does not turn an X account ID
into authentication.

## Findings and Threat Model

### Current findings

- `DEFAULT_PROXY_URL` is intentionally shipped in the extension and can always
  be recovered from the XPI or browser network activity.
- The extension creates its own install token, so an attacker can create an
  arbitrary number of tokens.
- With no `INSTALL_TOKEN_SECRET`, the Worker accepts any non-empty token.
- With `INSTALL_TOKEN_SECRET` enabled, the current extension sends no
  `X-Install-Signature`, so legitimate proxy requests fail authentication.
- CORS does not protect the endpoint from scripts, curl, or other HTTP clients.
- The Worker accepts caller-provided analysis state. Cache identity must prevent
  one caller from poisoning the shared result for another caller.

### In scope

- Unauthorized model calls that consume operator credits.
- Quota bypass through token rotation, forged public identities, reinstall, or
  direct HTTP requests.
- Prompt/state and response data exposure through logs, cache, or diagnostics.
- Cache poisoning and request replay.
- Honest disclosure of the hosted service in an open-source project.

### Out of scope

- Making a public extension an authenticated client without introducing a
  server-issued user credential or account system.
- Preventing reverse engineering of the extension or discovery of its API URL.
- Treating an X viewer ID, install token, browser fingerprint, or CORS origin as
  proof of user identity.

## Security Invariants

- No API key, Worker secret, signing key, or privileged Cloudflare credential
  ships in source, `dist-*`, or the XPI.
- The Worker fails closed when a required secret, quota store, or model binding
  is unavailable; it never silently falls back to unlimited model calls.
- Every model miss consumes an authoritative server-side quota unit. Cached
  results do not call the model.
- The Worker validates request size, schema, handle format, feature bounds, and
  allowed fields before cache, quota, or model work.
- Cache keys include every input that can affect the model result, or the Worker
  computes the canonical model input itself. A handle-only key is not enough
  when the caller supplies the state.
- Logs never contain reply snippets, full request bodies, API keys, install
  tokens, raw viewer IDs, or model responses.
- The privacy policy states exactly what AI mode sends, where it goes, how long
  it is retained, and that the hosted Worker is optional.

## Implementation Tasks

### Task 1: Publish the security boundary and deployment contract

**Files:**

- Modify: `README.md`
- Modify: `docs/privacy-policy.md`
- Modify: `docs/release.md`
- Modify: `worker/wrangler.toml` comments or deployment documentation
- Test: release/smoke assertions where applicable

- [ ] State that the proxy URL is public and discoverable by design.
- [ ] State that the open-source Worker source describes processing behavior,
      while API keys and deployment secrets stay in Cloudflare secrets.
- [ ] Document heuristic, proxy, BYOK, and self-hosted modes.
- [ ] Document the exact AI payload, sub-processors, cache retention, quota
      identity, deletion limitations, and operator contact.
- [ ] Document that X account IDs and install tokens are quota identifiers, not
      authentication or proof of an official client.
- [ ] Add release checks that fail if secret-looking values appear in built
      artifacts.

### Task 2: Remove the false HMAC authentication path

**Files:**

- Modify: `worker/src/quota.js`
- Modify: `worker/src/index.js`
- Modify: `src/ai/client.js`
- Modify: `worker/tests/quota.test.js`
- Modify: `worker/tests/router-analyze.test.js`
- Modify: `tests/ai/client.test.js`

- [ ] Decide explicitly whether `X-Install-Signature` is removed or reserved
      for a future server-issued credential flow.
- [ ] Do not enable `INSTALL_TOKEN_SECRET` as if it authenticated the current
      public extension; the client cannot safely hold the secret.
- [ ] If the legacy token path remains during rollout, label it as quota
      accounting and abuse resistance only.
- [ ] Return a bounded, documented error when quota protection is unavailable;
      never accept anonymous model calls.
- [ ] Test missing token, arbitrary token, token rotation, and direct HTTP
      requests against the documented policy.

### Task 3: Make quota identity server-authoritative enough for the threat model

**Files:**

- Implement alongside: `docs/superpowers/plans/2026-10-31-x-account-quota-plan.md`
- Modify: `worker/src/quota.js`
- Modify: `worker/src/index.js`
- Modify: `worker/tests/quota.test.js`

- [ ] Use the X-account namespace plan to reduce casual reinstall resets, while
      documenting that callers can forge a public ID.
- [ ] HMAC-derive any identity before KV/Durable Object storage; never persist
      raw X IDs in quota keys.
- [ ] Add independent per-IP and global rate limits at the edge/WAF layer.
- [ ] Add a global daily spending ceiling and an emergency kill switch that
      disables model misses while preserving cached responses.
- [ ] Replace the current non-atomic KV read/put counter before relying on it
      for a hard limit; use a serialized/atomic backend.
- [ ] Test concurrent requests, token rotation, forged IDs, account switching,
      reinstall, and quota-store failure.

### Task 4: Validate and isolate model input

**Files:**

- Modify: `worker/src/index.js`
- Modify: `worker/src/cache.js`
- Modify: `worker/src/analyze.js`
- Modify: `worker/tests/router-analyze.test.js`
- Modify: `worker/tests/cache.test.js`

- [ ] Reject unknown top-level fields and impose strict byte/depth/array/text
      limits before processing.
- [ ] Validate handles with the shared bounded format and normalize them once.
- [ ] Bound reply count, snippet length, feature count, and numeric ranges.
- [ ] Ensure the cache key includes canonical model inputs, not only the target
      handle, unless the Worker becomes the sole feature extractor.
- [ ] Add a test proving a caller cannot prime a result for a handle with a
      different state and have that result served to another request.
- [ ] Avoid logging request bodies and truncate operational error details.

### Task 5: Protect operations and secrets

**Files:**

- Modify: `worker/wrangler.toml`
- Modify: `docs/release.md`
- Add or modify: deployment/CI secret checks

- [ ] Store model API credentials and any quota HMAC secret with `wrangler
      secret`, never in `wrangler.toml`, source, fixtures, or build output.
- [ ] Use separate development, staging, and production credentials and KV
      namespaces.
- [ ] Restrict Cloudflare account permissions to the minimum deployment scope.
- [ ] Alert on request volume, unique quota identities, 401/429/5xx rates,
      model spend, cache misses, and unusual geographic/IP concentration.
- [ ] Rotate credentials and document incident response: disable model calls,
      rotate keys, inspect logs without collecting payloads, and notify users if
      personal data exposure is suspected.
- [ ] Verify the production Worker has no debug routes and that `/config`
      contains no secrets.

### Task 6: Verification and release gate

**Files:**

- Modify tests as required by Tasks 1-5
- Modify: `README.md`, `docs/privacy-policy.md`, `docs/release.md`

- [ ] Run focused Worker security and cache tests.
- [ ] Run `npm run build` and inspect `dist-mv2/` and `dist-mv3/` for secret
      material.
- [ ] Run `npm run check`.
- [ ] Deploy to staging and verify quota exhaustion, cache behavior, WAF/rate
      limits, kill switch, and model failure behavior with direct HTTP requests.
- [ ] Perform a clean XPI inspection and confirm only public endpoint/config
      data is present.
- [ ] Do not release until the privacy policy and hosted-service disclosure
      match the deployed behavior.

## Future Strong Authentication Option

If the hosted service later needs to serve only paying or registered users,
introduce a server-issued credential obtained through an explicit account or
license flow. Keep that credential short-lived, revocable, scoped, and stored
using the browser's protected extension storage. Do not call it an extension
secret, and do not assume that a determined user cannot extract or replay it.
The Worker must still enforce quotas, expiry, revocation, rate limits, and cost
ceilings because a legitimate credential can be shared or stolen.

## Stop Condition

The security work is complete when the hosted service is openly described,
secrets are absent from all client artifacts, direct callers cannot obtain
unlimited model calls, shared cache entries cannot be poisoned through caller
state, quota failures fail closed, and the documented privacy behavior matches
the deployed Worker. Do not add fingerprinting, cookie collection, X session
credentials, or client-side obfuscation as substitutes for authentication.