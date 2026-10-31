# X Account Quota Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 200-profile daily quota survive extension removal and reinstall for normal users by using the logged-in X viewer's numeric account ID as the quota namespace, while retaining the existing install-token fallback.

**Architecture:** The page/content side discovers only a candidate numeric viewer ID from X's authenticated page state; the extension background selects and forwards it with the Worker request. The Worker derives a non-reversible quota identity with an HMAC secret and owns the authoritative daily counter. The ID is a quota key, not authentication: modified clients and forged IDs remain out of scope for this adoption-stage abuse model.

**Tech Stack:** Firefox MV2, vanilla JavaScript ES modules, esbuild, Node `node:test`, Cloudflare Workers, Workers KV initially with an atomic-counter migration path.

**Spec:** User-approved requirements from the conversation: no user authentication system; distinguish users by their logged-in X account ID; tolerate account switching; resist casual reinstall resets; retain a fallback for pages where the ID cannot be read.

## Global Constraints

- Keep the extension heuristic/proxy modes and existing score protocol unchanged.
- Never use the hovered target account ID as the viewer identity.
- Never send X session cookies, API keys, or X authentication credentials to the Worker.
- Treat the X account ID as pseudonymous quota metadata, not proof of account control.
- The Worker remains authoritative; local `browser.storage.local` quota is only an optimization and display value.
- Keep the existing random install token as fallback when no valid viewer ID is available.
- Do not enable the HMAC verification path until the extension can produce a valid server-verifiable signature; the HMAC secret must never ship in the extension.

## Review Focus

- **Two X accounts:** switching the logged-in viewer changes the quota namespace instead of reusing the previous account's count. Test in the identity-selection and request-wiring tasks.
- **Reinstall:** the same viewer ID maps to the same Worker quota namespace after local storage is deleted. Test at the Worker identity boundary.
- **Missing or malformed ID:** empty, non-numeric, oversized, and target-profile IDs fall back to the install token without blocking analysis. Test in the extractor task.
- **Forged ID:** a caller can claim another public ID; the system must document and tolerate this rather than pretending it is authentication. Test request acceptance and document the limitation.
- **Concurrent misses:** simultaneous requests must not silently exceed the configured daily limit. Test the atomic quota implementation before replacing the current KV read/put path.

### Task 1: Viewer Identity Candidate Extraction

**Files:**
- Create: `src/page/viewer-identity.js`
- Modify: `src/page/index.js`
- Modify: `src/content.js`
- Test: `tests/page/viewer-identity.test.js`
- Test: `tests/content/content.test.js`

**Interfaces:**
- Consumes: X page DOM/page-state markers available to the injected page bundle; the existing page-to-content bridge.
- Produces: `extractViewerAccountId(document) -> string | null`; a bridge message carrying `{ viewerAccountId }` only when the candidate passes the numeric format check.

- [ ] **Step 1: Write failing extractor tests** for a valid numeric ID, missing ID, malformed ID, and a target hovercard ID that must not be selected as the viewer ID.
- [ ] **Step 2: Run `node --test tests/page/viewer-identity.test.js`** and confirm the new tests fail because the extractor does not exist.
- [ ] **Step 3: Implement `extractViewerAccountId(document)`** using one isolated selector/parser seam. Accept only the documented X viewer marker and a bounded decimal ID; return `null` for all other inputs. Do not read cookies or call X internal APIs.
- [ ] **Step 4: Add bridge wiring tests** proving the candidate reaches the extension world without changing score request semantics and without allowing page-supplied score fields.
- [ ] **Step 5: Run `node --test tests/page/viewer-identity.test.js tests/content/content.test.js`** and confirm the focused tests pass.

### Task 2: Background Identity Selection and Worker Request Contract

**Files:**
- Modify: `src/background/index.js`
- Modify: `src/ai/client.js`
- Modify: `src/shared/security.js`
- Modify: `tests/background/orchestration.test.js`
- Modify: `tests/ai/client.test.js`
- Modify: `tests/shared/security.test.js`

**Interfaces:**
- Consumes: `viewerAccountId` candidate from Task 1; existing `getInstallToken(storage)`.
- Produces: `resolveQuotaIdentity({ viewerAccountId, installToken }) -> { kind: "x-account" | "install", value: string }`; proxy header `X-Quota-Identity` containing the selected raw candidate only over HTTPS.

- [ ] **Step 1: Write failing tests** for valid viewer ID selection, fallback to install token, account switching, and rejection of malformed IDs before any network call.
- [ ] **Step 2: Run the focused background and AI tests** and confirm they fail on the missing identity contract.
- [ ] **Step 3: Implement the identity resolver** with the exact precedence `viewerAccountId` then `installToken`; preserve the existing install-token header for backward compatibility during rollout.
- [ ] **Step 4: Ensure the background reads the viewer identity per request** so an X account switch takes effect without an extension restart.
- [ ] **Step 5: Run `node --test tests/background/orchestration.test.js tests/ai/client.test.js tests/shared/security.test.js`** and confirm the focused tests pass.

### Task 3: Worker-Side HMAC Namespace and Migration Compatibility

**Files:**
- Modify: `worker/src/quota.js`
- Modify: `worker/src/index.js`
- Modify: `worker/tests/quota.test.js`
- Modify: `worker/tests/index.test.js` or the existing Worker router test file
- Modify: `worker/wrangler.toml` only for documented secret/binding configuration

**Interfaces:**
- Consumes: `X-Quota-Identity` and the existing `X-Install-Token` header.
- Produces: `deriveQuotaNamespace(identity, secret) -> Promise<string>`; Worker quota keys in the form `quota:v2:{hmacDigest}:{YYYY-MM-DD}`.

- [ ] **Step 1: Write failing Worker tests** proving the same X ID produces the same namespace across reinstalls, different X IDs produce different namespaces, and the install token is used only when the X ID is absent.
- [ ] **Step 2: Run `node --test 'worker/tests/**/*.test.js'`** and confirm the new tests fail.
- [ ] **Step 3: Implement HMAC-SHA256 namespace derivation** inside the Worker using `INSTALL_TOKEN_SECRET`; never expose the secret to extension code and never persist the raw X ID in KV.
- [ ] **Step 4: Keep a controlled rollout path**: accept the new header when configured, retain old install-token behavior temporarily, and return a clear degraded response if the required server secret is missing rather than silently claiming stronger identity.
- [ ] **Step 5: Run the Worker quota/router tests** and confirm the migration behavior passes.

### Task 4: Atomic Daily Quota Counter

**Files:**
- Create or modify: `worker/src/atomic-quota.js`
- Modify: `worker/src/index.js`
- Test: `worker/tests/atomic-quota.test.js`
- Modify: `worker/wrangler.toml` if a Durable Object binding is selected

**Interfaces:**
- Consumes: the derived quota namespace from Task 3 and daily limit `200`.
- Produces: `checkAndConsumeQuotaAtomic(namespace, dailyLimit, date) -> Promise<{ allowed: boolean, remaining: number }>`.

- [ ] **Step 1: Write failing concurrency tests** for exactly-200 success responses, the 201st rejection, and concurrent requests sharing one namespace.
- [ ] **Step 2: Select the smallest atomic backend supported by the deployment**: prefer a Durable Object for serialized increments; use D1 only if an atomic transaction is already available in the project.
- [ ] **Step 3: Implement the counter with UTC day keys** and preserve `429` plus `x-quota-remaining` response behavior.
- [ ] **Step 4: Change `/analyze` to check cache first, then atomically consume quota, then call the model**, preserving the existing cached-result behavior.
- [ ] **Step 5: Run `node --test 'worker/tests/**/*.test.js'`** and confirm all Worker tests pass.

### Task 5: Privacy, Operations, and Rollout Documentation

**Files:**
- Modify: `docs/privacy-policy.md`
- Modify: `README.md`
- Modify: `docs/release.md`
- Modify: `worker/wrangler.toml` comments or deployment documentation
- Test: `tests/smoke.test.js` if release configuration is asserted there

**Interfaces:**
- Consumes: the shipped behavior from Tasks 1-4.
- Produces: operator instructions for `INSTALL_TOKEN_SECRET`, quota rollout, fallback monitoring, and data-retention expectations.

- [ ] **Step 1: Document that the extension sends a pseudonymous viewer-account quota identifier, not X credentials or cookies.**
- [ ] **Step 2: Document that IDs are HMAC-derived before storage and that changing X accounts changes the quota namespace.**
- [ ] **Step 3: Document the deliberate limitation: a modified client can forge a public ID, so this is abuse reduction rather than authentication.**
- [ ] **Step 4: Add rollout checks** for missing secrets, unexpected fallback volume, quota errors, and Worker/KV/Durable Object usage.
- [ ] **Step 5: Run `npm run check`** and confirm the complete extension and Worker gates pass.

## Stop Condition

Ship the X-account namespace plus fallback only after Tasks 1-3 and focused tests pass. Do not add authentication, fingerprinting, cookie collection, or anti-abuse escalation until real traffic shows a spike that justifies the additional privacy and operational cost.