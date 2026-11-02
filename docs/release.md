# Release

Everything in an **Operator step** subsection is work done in the
Cloudflare dashboard / wrangler CLI by the person deploying. This repository
cannot enforce those actions; repository-enforced checks are stated
separately — the `task5:` assertions in `worker/tests/deploy-config.test.js`
(secrets and environment contract of `worker/wrangler.toml` and
`worker/src`) and in `worker/tests/config.test.js` (no debug routes, no
secrets in `/config`) — and are covered by `npm run check`.

## Worker (Cloudflare)

1. Install wrangler locally in the Worker package: `cd worker && npm i -D wrangler`
2. Create KV namespace: `cd worker && npx wrangler kv namespace create CACHE_KV`.
   Copy the returned namespace ID into the `CACHE_KV` binding in
   `worker/wrangler.toml`; do not reuse the repository's production ID for a
   new deployment.
3. Put Worker model credentials with Wrangler: `CLOUDFLARE_API_TOKEN` and
   `JEV_API_KEY` (or `TYPESAFE_API_KEY`). Keep Worker API keys and deployment
   credentials in Cloudflare secrets only. AMO signing credentials are a
   separate release concern and belong only in the signing shell or GitHub
   Actions secrets. `CLOUDFLARE_ACCOUNT_ID` is a public account identifier,
   not an API credential; it may be a Worker variable.
4. Deploy: `cd worker && npx wrangler deploy`
5. Copy the deployed URL into `DEFAULT_PROXY_URL` in both `worker/src/config.js`
   and `src/config.js`, then rebuild.

### Operator step: separated environments

The deploy config now declares three environments in `worker/wrangler.toml`:
the top-level config (current production Worker), `[env.production]` (restates
the same production KV namespace and values), and `[env.staging]` with a
labelled placeholder KV id. Separation of namespaces and credentials lives in
the Cloudflare account; this file cannot enforce it.

1. Create the staging namespace and replace the placeholder id:
   `npx wrangler kv namespace create CACHE_KV --env staging`.
   Never point staging at the production namespace id.
2. Set staging credentials per environment:
   `npx wrangler secret put CLOUDFLARE_API_TOKEN --env staging`,
   `npx wrangler secret put TYPESAFE_API_KEY --env staging` (or
   `JEV_API_KEY`), and
   `npx wrangler secret put INSTALL_TOKEN_SECRET --env staging`.
   Wrangler secrets are scoped to the environment they are created against;
   a top-level secret is not visible to named environments and vice versa.
3. Use different token values per environment. A staging leak must never
   compromise production, and staging traffic must never pollute production
   cache or quota state.
4. When the release gate lands (Task 6), consider the deploy-time complement
   to these text-level checks: Wrangler v4 supports a non-inheritable
   `secrets` config key with a `required` list, so a deploy fails when a
   per-environment secret is missing instead of the Worker silently running
   without it.

### Operator step: minimum-scope Cloudflare access

1. Give the deployment a Cloudflare API token scoped to the minimum needed:
   Account: Workers Scripts: Edit, plus Account: Workers KV Storage: Edit for
   the namespaces the config binds. No zone-level permissions are required for
   this Worker.
2. The rails the token is used on are `npx wrangler deploy` (and
   `wrangler secret put`), preferred over dashboard edits so access stays
   auditable and reproducible.
3. If the account has team members, apply the least-privilege membership
   roles; `CLOUDFLARE_ACCOUNT_ID` is a public account identifier and not
   sensitive, but write access to the account is.

## Operations

### Alerting (docs only)

No code in this repository emits these metrics; the table below records what
an operator should watch and do. Source families: Cloudflare dashboard
(Workers/Limits analytics, WAF), wrangler tail, and `x-quota-remaining`
response headers from the quota contract.

| Metric family | Why it matters | Suggested operator action |
| --- | --- | --- |
| Request volume | A spike can be viral extension traffic, abuse, or an attacker probing the proxy (which is public by design). | Check `GLOBAL_DAILY_MODEL_CEILING` headroom; enable Cloudflare edge rate limiting/WAF rules for per-IP throttling; pause model calls with `QUOTA_KILL_SWITCH` if spend risk appears. |
| Unique quota identities | Sudden growth in distinct quota identities, or one identity hammering `/analyze`, means quota-bucket abuse or extension-wide misbehavior. | Inspect the HMAC-derived quota keys in `CACHE_KV` (raw X IDs never appear in stored keys); tighten per-identity limits or invalidate suspicious install-token buckets. |
| 401 / 429 / 5xx rates | The quota path answers 429 `{state:"quota"}` for exhausted identities and 503 (`model_calls_paused`, `quota_unavailable`) for fail-closed pauses; rising 5xx rates mean the store, binding, or upstream model is unhealthy. | `wrangler tail` for the bounded error code family; if `quota_unavailable` persists, check the KV/QUOTA_COUNTER binding and `INSTALL_TOKEN_SECRET` presence; `model_calls_paused` is operator pause or daily ceiling — reset deliberately, not by silent drift. |
| Model spend | Workers AI (Clef via `CLOUDFLARE_API_TOKEN`) is the variable cost and the abuse target. | Compare daily model calls against `GLOBAL_DAILY_MODEL_CEILING`; set a Cloudflare spend alert on the account; lower the ceiling or enable the kill switch before the budget is consumed. |
| Cache misses | The 48h KV cache is the spend dampener; a miss-rate jump usually means a version bump (intended) or a cache-stampede/abuse pattern (not intended). | Verify cache key versioning around releases (`mv`/`fv` are part of the key, so bumps cause a one-time miss wave — expected); investigate otherwise. |
| Geographic / IP concentration | Unusual single-ASN or single-country concentration is the clearest circumvention signal against the forgeable public quota identity model. | Enable Cloudflare WAF country/ASN rules at the edge (out of repo scope by design, see worker/src/index.js); use wrangler tail plus Cloudflare analytics to identify the pattern before throttling. |

### Credential rotation and incident response

Controls that actually exist in this repository (server-side, documented in
worker/src/index.js and quota.js):

- `QUOTA_KILL_SWITCH` — operator pause: disables model **misses**
  (503 `model_calls_paused`, Retry-After: 60). Cached responses keep being
  served; no model call happens while it is engaged.
- `GLOBAL_DAILY_MODEL_CEILING` — the global daily model-call ceiling, shared
  across all identities and buckets; its last unit fails model-bound misses
  closed with the same bounded response.
- Per-identity daily quota — consumed before any model work, fail-closed via
  the bounded `quota_unavailable` when the counter backend is unusable.

Operator steps for rotation (per environment, `--env staging` /
`--env production`):

1. Rotate `CLOUDFLARE_API_TOKEN`:
   `npx wrangler secret put CLOUDFLARE_API_TOKEN --env <env>` — create the
   replacement token in the Cloudflare dashboard first, swap it into the
   Worker, then revoke the old token in the dashboard. Old and new overlap
   only during the swap.
2. Rotate `TYPESAFE_API_KEY` / `JEV_API_KEY` with
   `npx wrangler secret put <NAME> --env <env>` after generating the new key
   in the upstream model provider's console; verify `/analyze` succeeds, then
   revoke the old provider-side key.
3. Rotate `INSTALL_TOKEN_SECRET` with
   `npx wrangler secret put INSTALL_TOKEN_SECRET --env <env>`. Note the
   consequence: HMAC-derived quota namespaces and cache keys change, so daily
   quota counters and the cache reset to empty on rollover (access resets to
   zero usage for the day; no links between old and new persisted identities).

Incident response checklist:

1. **Disable model calls first**: set `QUOTA_KILL_SWITCH` (or lower
   `GLOBAL_DAILY_MODEL_CEILING`) with `npx wrangler secret put` / vars per
   affected environment. Cached responses stay served, so client impact is
   bounded while you investigate.
2. **Rotate the suspected credential** as above; a suspected server secret
   (`INSTALL_TOKEN_SECRET`) also invalidates stored quota namespaces.
3. **Inspect logs without collecting payloads**: this Worker never logs
   request bodies or reply text (the input gate's opaque `invalid_request` and
   the no-echo design in worker/src/index.js). Inspection is `wrangler tail`
   plus Cloudflare Workers analytics (status codes, routes, volumes) — never
   body dumps. Do not add body logging during an incident; it creates a new
   exposure.
4. **Notify users if personal-data exposure is suspected** (e.g. quota keys,
   cached analysis samples, or log destinations were compromised): publish a
   disclosure describing what was stored, for how long (the analysis cache is
   48h), what the exposure implies for replaying identities, and the rotation
   performed. Stored quota keys are HMAC-derived with `INSTALL_TOKEN_SECRET`
   precisely to limit what a KV-level compromise reveals; describe what
   was rotated and what it invalidates.

## Extension

1. `npm run build`
2. `npm run check:artifacts` (fails on credential-shaped values in build output)
3. `npm run package` (produces `web-ext-artifacts/*.zip`)
4. Sign: `web-ext sign --api-key=$AMO_KEY --api-secret=$AMO_SECRET`
   (keys from your AMO account; never commit them)
5. Upload the signed `.xpi` to GitHub Releases / AMO.
6. Tag: `git tag v1.0.0 && git push --tags`

## Verification

- `npm run check` (both suites, lint on dist-mv2)
- `npm run check:artifacts` after every build; it scans `dist-mv2/`, `dist-mv3/`,
  and any existing `web-ext-artifacts/`.
- `npm run package` from a clean `web-ext-artifacts/`
- Load `dist-mv2/manifest.json` in Firefox via about:debugging