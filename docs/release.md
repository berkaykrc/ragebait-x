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
4. The repository-side gate has landed: `npm run check:artifacts` runs inside
   `npm run check` and as its own step immediately after Build in the CI and
   release workflows, so the workflow that signs the XPI cannot skip the
   artifact secret scan. The deploy-time complement is still operator work:
   Wrangler v4 supports a non-inheritable `secrets` config key with a
   `required` list, so a deploy fails when a per-environment secret is missing
   instead of the Worker silently running without it.

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

### Operator step: production hardening (identity privacy + atomic limit)

`worker/wrangler.toml` declares only the `CACHE_KV` namespaces, the three
environments, and the public `[vars]` tables — no `[[durable_objects]]`
entry and no operator secrets. Two protections above the code defaults are
therefore deploy-side only. A docs-following deploy that skips this step
runs the best-effort legacy quota counter and persists raw install-token
quota keys:

1. Bind the server derivation secret:
   `npx wrangler secret put INSTALL_TOKEN_SECRET --env production`
   (type the value on stdin when prompted). With it, daily quota keys are
   HMAC-derived pseudonymous namespaces (`deriveQuotaNamespace`,
   `worker/src/quota.js`): the raw X viewer ID or install token
   never appears in a stored key. Without it, the legacy migration path keys
   KV as `quota:{installToken}:{date}` (`getQuotaKey`,
   `worker/src/quota.js`), and a request presenting
   `X-Quota-Identity` fails closed with the bounded
   `{"error":"quota_unavailable"}` 503 ("Server secret required for
   x-account namespace", `buildQuotaCounterKey` in `worker/src/index.js`).
2. Bind a serialized daily counter as `env.QUOTA_COUNTER` — the binding
   contract is `incr(key: string): Promise<number>` returning the
   post-increment count and never racing across concurrent requests
   (contract + atomic consumer in `worker/src/quota.js`; binding
   resolution in `resolveQuotaCounter`, `worker/src/index.js`). This repository ships **no**
   such class: a serialized backend (e.g. a Cloudflare Durable Object keyed
   by the counter key) is operator-provided infrastructure, out of
   `wrangler.toml` by design. State plainly in release evidence: without
   this binding the daily per-identity limit is the legacy KV read/put
   counter (legacy path `checkAndConsumeQuotaLegacyCounter`, `worker/src/quota.js`), which is **best effort under
   concurrency** (a concurrent race can consume beyond the limit); the
   atomic, truly-enforced daily limit requires this operator-provided
   binding. A binding that is present but does not satisfy the contract
   fails closed with the bounded `quota_unavailable` 503 — it never
   silently degrades to the legacy counter
   (`resolveQuotaCounter` and the fail-closed quota 503 path,
   `worker/src/index.js`).

### Operator step: staged behavior gate (not runnable from this repository)

Deploying to staging and probing the live Worker needs Cloudflare credentials,
so no `npm run check` gate can ever cover it — this is an external gap by
design. Run it once per Worker release and attach the filled evidence table to
the release notes before publishing.

Set up (deploy staging per the steps above, then):

```sh
export STAGE="https://ragebait-proxy-staging.<your-subdomain>.workers.dev"
export STAGE_TOKEN="stage-gate-$(date +%s)"   # any fresh value; forgeable by design
# payload.json: {"state":{...},"installToken": "..."} — a body the Task-4 gate accepts
cat > payload.json <<'JSON'
{
  "state": {
    "handle": "example",
    "features": { "capsRatio": 0.1, "exclamationRatio": 0.2 },
    "replySample": ["a probe reply used for release-gate evidence"]
  },
  "installToken": "stage-gate-evidence"
}
JSON
```

Type secret values on stdin when `wrangler secret put` prompts — never in a
shell command line or this file.

1. **Public config only** — every check starts here:

   ```sh
   curl -sS "$STAGE/config"
   ```

   Expected: exactly `modelVersion`, `featureVersion`, `bandThresholds`,
   `selectors`, `showNumber`, `proxyUrl`, `proxyEnabled`. No secrets, no debug
   routes (repository-side proof: `worker/tests/config.test.js`).

2. **Cache behavior** — an identical body returns the identical 200 without a
   further quota decrement and without a model call:

   ```sh
   curl -sS -D miss.headers -o miss.json -X POST "$STAGE/analyze" \
     -H 'content-type: application/json' -H "X-Install-Token: $STAGE_TOKEN" \
     --data-binary @payload.json
   curl -sS -D hit.headers -o hit.json -X POST "$STAGE/analyze" \
     -H 'content-type: application/json' -H "X-Install-Token: $STAGE_TOKEN" \
     --data-binary @payload.json
   diff miss.json hit.json          # identical (200; no x-quota-remaining on hits)
   # grep exits 1 when the count is 0 (the expected value), so neutralize it
   # for `set -e` scripts and read the printed count instead:
   retry_count=$(grep -ci retry-after hit.headers || true)
   echo "$retry_count"              # 0 — never a 503 while cached
   ```

3. **Quota exhaustion (429 shape)** — the per-identity daily limit is code
   (`DAILY_QUOTA_LIMIT = 200` in `worker/src/index.js`), so each request needs
   a distinct canonical state to be a real miss that consumes a unit:

   ```sh
   jq -c --arg r "rate probe 201: quota must be exhausted" \
     '.state.replySample[0] = $r' payload.json > probe201.json
   for i in $(seq 1 200); do
     jq -c --arg r "rate probe $i: distinct reply sample consumes a unit" \
       '.state.replySample[0] = $r' payload.json > probe.json
     curl -sS -o /dev/null -X POST "$STAGE/analyze" \
       -H 'content-type: application/json' -H "X-Install-Token: $STAGE_TOKEN" \
       --data-binary @probe.json
   done
   curl -sS -D probe.headers -o probe.json -X POST "$STAGE/analyze" \
     -H 'content-type: application/json' -H "X-Install-Token: $STAGE_TOKEN" \
     --data-binary @probe201.json
   cat probe.headers; cat probe.json
   ```

   Expected: HTTP 429, body exactly `{"state":"quota"}`,
   `x-quota-remaining: 0`. The loop performs about 200 real upstream model
   calls on staging (minutes); leave `GLOBAL_DAILY_MODEL_CEILING` unset until
   check (5), and keep `$STAGE_TOKEN` — it stays exhausted for the day, which
   is the point. Every later check uses its own fresh identity, because quota
   is consumed before the pause/ceiling/model steps act.

4. **Kill switch** — model misses pause, cached responses keep serving:

   ```sh
   npx wrangler secret put QUOTA_KILL_SWITCH --env staging   # enter: true
   jq -c '.state.replySample[0] = "kill switch probe"' payload.json > probe.json
   curl -sS -D - -o probe.out -X POST "$STAGE/analyze" \
     -H 'content-type: application/json' \
     -H "X-Install-Token: ks-$STAGE_TOKEN" \
     --data-binary @probe.json
   curl -sS -D - -o hit.json -X POST "$STAGE/analyze" \
     -H 'content-type: application/json' \
     -H "X-Install-Token: ks-$STAGE_TOKEN" \
     --data-binary @payload.json
   npx wrangler secret put QUOTA_KILL_SWITCH --env staging   # enter: false
   ```

   Expected: probe returns HTTP 503 `{"error":"model_calls_paused"}` with
   `Retry-After: 60`; the cached body still returns 200.

5. **Global daily ceiling** — a global counter shared across all identities
   (`getGlobalQuotaKey()` in `worker/src/quota.js`). Each distinct miss
   consumes a ceiling unit on top of the identity unit; exhaustion refuses the
   whole service with the same bounded 503:

   ```sh
   npx wrangler secret put GLOBAL_DAILY_MODEL_CEILING --env staging   # enter: 3
   for i in 1 2 3; do
     jq -c --arg r "ceiling probe $i: must succeed" \
       '.state.replySample[0] = $r' payload.json > probe.json
     curl -sS -o /dev/null -X POST "$STAGE/analyze" \
       -H 'content-type: application/json' \
       -H "X-Install-Token: ceil-$STAGE_TOKEN-$i" \
       --data-binary @probe.json
   done
   jq -c --arg r "ceiling probe 4: must be paused" \
     '.state.replySample[0] = $r' payload.json > probe.json
   curl -sS -D - -o probe.out -X POST "$STAGE/analyze" \
     -H 'content-type: application/json' \
     -H "X-Install-Token: ceil-$STAGE_TOKEN-4" \
     --data-binary @probe.json
   npx wrangler secret delete GLOBAL_DAILY_MODEL_CEILING --env staging   # prompts for confirmation on stdin; answer with y
   ```

   Expected: three fresh-identity misses succeed; the fourth distinct miss
   returns HTTP 503 `{"error":"model_calls_paused"}`, `Retry-After: 60`. The
   refusal is identity-independent: any fresh identity gets this 503 while the
   ceiling stays empty (per-identity quota is checked first, so an exhausted
   identity would keep its 429 — the ceiling is only checked on the allowed
   path).

6. **Model failure (ai_unavailable)** — valid only **while Clef cannot
   succeed on staging**: on the documented minimum-scope deploy token (Workers
   Scripts + KV, no AI run permission) Clef always fails, so both models
   returning null proves the bounded 502. If staging's Worker credential
   *does* carry the `@cf` AI-run permission, a 200 here means exactly that —
   Clef is live — and the bypass check below misses its target. To make the
   boundary invisible neither model may work, so corrupt **both** upstream
   credentials (the Worker secret `CLOUDFLARE_API_TOKEN` read at request time
   is not the wrangler shell credential: `wrangler secret put` still
   authenticates with its own token, so this is safe to corrupt and restore).
   Corrupt the names the deployment actually configured — Clef reads the
   Worker secrets `CLOUDFLARE_API_TOKEN` then `CLEF_API_KEY`
   (`callClef`, `worker/src/analyze.js`); Jev reads `TYPESAFE_API_KEY` then
   `JEV_API_KEY` (`callJev`, `worker/src/analyze.js`):

   ```sh
   npx wrangler secret put CLOUDFLARE_API_TOKEN --env staging   # enter: invalid-for-gate
   npx wrangler secret put TYPESAFE_API_KEY --env staging       # enter: invalid-for-gate
   jq -c '.state.replySample[0] = "model failure probe"' payload.json > probe.json
   curl -sS -D - -o probe.out -X POST "$STAGE/analyze" \
     -H 'content-type: application/json' \
     -H "X-Install-Token: mf-$STAGE_TOKEN" \
     --data-binary @probe.json
   npx wrangler secret put CLOUDFLARE_API_TOKEN --env staging   # restore the real token
   npx wrangler secret put TYPESAFE_API_KEY --env staging       # restore the real key
   ```

   Expected: HTTP 502 `{"error":"ai_unavailable"}` with an
   `x-quota-remaining` header showing the consumed unit — a miss spends its
   unit even when the model fails, and a failed miss is not cached. A 200
   response is not evidence of a broken gate: this procedure corrupts
   **both** upstream credentials, so a 200 means one of them was still live —
   the deployment's configured name differs from the one corrupted (Clef
   reads `CLOUDFLARE_API_TOKEN` then `CLEF_API_KEY`; Jev reads
   `TYPESAFE_API_KEY` then `JEV_API_KEY`), or the restore step above already
   ran. Re-corrupt the names this deployment actually configures and rerun
   with a further-distinct `replySample[0]`, since the 200 was cached for
   the identical body.

7. **Fail-closed quota store** — with the KV binding temporarily removed from
   the staging config (`npx wrangler deploy --env staging`), a fresh model
   miss must answer HTTP 503 `{"error":"quota_unavailable"}`,
   `Retry-After: 60`. With the binding gone there is no store and no cached
   entry can be returned (`getCachedAnalysis` returns null without KV, and
   every `/analyze` miss takes this 503) — only the miss-side 503 is
   testable here. The "cached responses keep serving" property belongs to
   the kill switch (check 4), not to a removed binding. Restore the binding
   and redeploy immediately after recording.

8. **Edge WAF / per-IP rate limits** — independent of Worker code by design
   (they are Cloudflare edge configuration, documented in `worker/src/index.js`
   comments). Enable a per-IP rate-limiting rule on the staging route, verify
   it throttles burst HTTP traffic (HTTP 429 from the edge, observed in
   Security analytics), then mirror the rule in production.

Evidence record (fill per release; keep with the release notes):

| # | Check | Expected (contract) | Command | Date | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | `/config` exposes public flags only | the seven fields, nothing else | (1) | | |
| 2 | Cache hit: no quota decrement, no model call | identical bodies, `diff` empty | (2) | | |
| 3 | Exhausted identity fails closed | 429 `{"state":"quota"}` | (3) | | |
| 4 | Kill switch pauses misses, cache serves | 503 `model_calls_paused`, `Retry-After: 60` | (4) | | |
| 5 | Global ceiling shared and bounded | 503 `model_calls_paused`, `Retry-After: 60` | (5) | | |
| 6 | Model failure bounded, unit spent (only while Clef cannot succeed — both upstream credentials corrupted; a 200 means Clef is live) | 502 `{"error":"ai_unavailable"}` | (6) | | |
| 7 | Unusable quota store fails closed | 503 `{"error":"quota_unavailable"}` | (7) | | |
| 8 | Edge per-IP rate limit enforced | edge 429 in Cloudflare analytics | (8) | | |

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
3. `npm run package` (`web-ext build`; writes its default
   `web-ext-artifacts/ragebait_detector-<version>.zip` — the `{name}-{version}.zip`
   template with the manifest name lowercased and non-alphanumerics replaced
   with `_`).
4. Inspect the zip before release:
   `unzip -l web-ext-artifacts/ragebait_detector-<version>.zip`. The member
   list must contain only `manifest.json`, bundled code (`*.js`, `*.css`),
   `options.*`, and icon/brand assets (`*.png`, `*.svg`) — no dotfiles, no
   configuration or secret material. Member contents were already scanned by
   `check:artifacts` (it expands zip members). Record the listing with the
   release evidence.
5. Release through CI: `npm run release patch` (bumps the version, commits,
   tags, and pushes). The tag starts `.github/workflows/release.yml`, which
   builds, tests, signs with the `AMO_KEY`/`AMO_SECRET` repository secrets, and
   attaches two assets to the GitHub Release: `ragebait-detector.xpi` (stable
   name) and `updates.json` (the Firefox update manifest). Signing never runs
   locally: `scripts/sign.sh` refuses outside GitHub Actions.
6. `update_url` points at
   `https://github.com/berkaykrc/ragebait-x/releases/latest/download/updates.json`.
   The add-on is self-hosted (GitHub Releases), so `npm run lint` passes
   `--self-hosted` to web-ext; without it, addons-linter rejects `update_url`
   as an AMO-hosted field. The repository must be public: the release workflow
   refuses to sign when `gh api repos/<owner>/<repo>` reports anything other
   than `public`, because private release assets cannot serve update checks.
7. Permanent install uses the signed `.xpi` from the GitHub Release. Local
   development loads the unsigned `dist-mv2/manifest.json` as a temporary
   add-on.

## Verification

Repository-local (every push/PR runs it in CI; locally it is `npm run check`):

- `npm run check` — `lint:js` -> `fmt:check` -> `build` -> `check:artifacts` ->
  `lint` -> `test`.
- `check:artifacts` is additionally a standalone step immediately after
  Build in `.github/workflows/ci.yml` and `.github/workflows/release.yml`, so
  the workflow that signs the XPI cannot skip the artifact secret scan.

Clean XPI inspection (per release; never sign or upload at this step):

1. `npm run build`
2. `npm run package` from a clean `web-ext-artifacts/`
3. `npm run check:artifacts` (scans `dist-mv2/`, `dist-mv3/`, and every
   zip/xpi member in `web-ext-artifacts/`)
4. `unzip -l web-ext-artifacts/ragebait_detector-<version>.zip` — members are
   only manifests, code, icons and UI assets (Extension steps above).
5. A grep over the extracted members confirms only public endpoint and config
   identifiers besides code (the hosted proxy URL is public by design).

Docs against deployed behavior: the disclosure documents are checked against
the Worker source itself (the repository is the pre-deploy source of truth):
`worker/src/index.js` (routing, error contract, fail-closed ordering, no
debug routes), `worker/src/quota.js` (identity handling, bounded error
statuses, kill switch / ceiling parsing), `worker/src/analyze.js` (input gate,
Clef/Jev models, bounded logging, `ai_unavailable`), `worker/src/config.js`
(public `/config` flags), `worker/src/cache.js` (48-hour TTL), and
`worker/src/questions.js` (four binary questions + one three-level intensity
question). After deploy, re-check the same facts with the staged gate
commands above.

Staged live behavior — `npm run check` does NOT cover it: the staged behavior
gate (operator step above) is the only proof of staging/production quota
exhaustion, cache behavior, edge rate limits, kill switch, and model failure.
This is an explicit external gap in the automated gate: no Cloudflare
credential exists in this repository, so a green `npm run check` is not
evidence that staging was exercised.

Do not release until:

- the staged behavior gate evidence table is filled for the target
  environment,
- the disclosure documents match the observed staged behavior (they match the
  repository source today), and
- the clean XPI inspection shows no secret material.
