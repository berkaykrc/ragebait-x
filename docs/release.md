# Release

## Worker (Cloudflare)

1. Install wrangler locally in the Worker package: `cd worker && npm i -D wrangler`
2. Create KV namespace: `cd worker && npx wrangler kv namespace create CACHE_KV`
3. Put secrets: `cd worker && npx wrangler secret put CLOUDFLARE_API_TOKEN`, `cd worker && npx wrangler secret put JEV_API_KEY` (or `TYPESAFE_API_KEY`); set `CLOUDFLARE_ACCOUNT_ID` as a var in `wrangler.toml` or the dashboard.
4. Deploy: `cd worker && npx wrangler deploy`
5. Copy the deployed URL into `DEFAULT_PROXY_URL` in both `worker/src/config.js`
   and `src/config.js`, then rebuild.

## Extension

1. `npm run build`
2. `npm run package` (produces `web-ext-artifacts/*.zip`)
3. Sign: `web-ext sign --api-key=$AMO_KEY --api-secret=$AMO_SECRET`
   (keys from your AMO account; never commit them)
4. Upload the signed `.xpi` to GitHub Releases / AMO.
5. Tag: `git tag v1.0.0 && git push --tags`

## Verification

- `npm run check` (both suites, lint on dist-mv2)
- `npm run package` from a clean `web-ext-artifacts/`
- Load `dist-mv2/manifest.json` in Firefox via about:debugging