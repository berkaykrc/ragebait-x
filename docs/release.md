# Release

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