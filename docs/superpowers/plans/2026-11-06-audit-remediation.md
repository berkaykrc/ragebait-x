# Implementation Plan: Audit Findings Remediation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the low- and medium-priority compatibility and code quality findings identified in `docs/superpowers/plans/2026-11-06-audit-remediation.md`, as corrected by review (see Review Focus).

**Architecture:**
1. Do NOT persist a global token to fix verification — review proof: `src/shared/messaging.js:57` gates in the content script (page token vs content-script token), and `src/background/index.js:547-571` never checks `message.token`. SW restart token `T2` vs tab token `T1` still passes (`T1==T1`, SW ignores it). Real SW-restart loss is `sessions` Map + `dedupeMap` (`src/background/index.js:L524,L552`), not the trust gate. Task 1 is reduced to optional stability only; do not claim it fixes verification.
2. Unify extension API namespace resolution (`browser` vs `chrome`) in `src/options/index.js` matching `src/background/index.js` and `src/content.js`. Chromium failure mode is inert options page (no boot), not a crash.
3. Standardize conditional form section visibility in `src/options/index.js` and `src/options/index.html` to use the `hidden` attribute instead of inline `style.display`.
4. Clean up the polling safety-net timer in `src/page/hovercard.js` immediately when `#layers` is observed.
5. Add fallback color for `.ragebait-line-label` in `src/brand/brand.css`.

**Tech Stack:** Vanilla JavaScript (ES modules, Node 26.13.0 `node:test`, Deno lint/fmt, esbuild).

**Spec:** [`docs/superpowers/plans/2026-11-06-audit-remediation.md`](file:///home/berkay-fedora/Belgeler/ragebait-x/docs/superpowers/plans/2026-11-06-audit-remediation.md)

---

## Global Constraints

- Vanilla JS ES modules; no TypeScript; no external dependencies in extension code.
- Follow existing patterns for `extensionApi` detection (`typeof browser !== "undefined" ? browser : (typeof chrome !== "undefined" ? chrome : null)`).
- All gates must pass: `npm run check` (deno lint -> deno fmt --check -> build -> lint -> test).
- No regression: full `npm test` passes.

---

## Review Focus

1. **Service Worker Wakeup (corrected):** Token is correlation only, not a secret (D13, `src/shared/security.js:5-9`). Restart does not break `isTrustedRagebaitMessage`; background never validates `message.token`. Any token persistence is optional stability (global token stays equal for old + new tabs). Use `storage.local` only — `storage.session` is MV3-only and absent on MV2. Real restart loss is `sessions`/`dedupeMap`; cancel-by-`requestId` after restart is known limit, not fixed by token storage.
2. **Chromium Options Page Boot (corrected):** No crash. `src/options/index.js:400` guards boot on `typeof browser`, so Chromium = inert page (form never wires). `browserStorageAdapter:137` would throw `ReferenceError` only if called directly. Goal: page boots via `chrome` fallback.
3. **HTML Hidden State Display Conflicts:** Replacing `style.display` with `.hidden` in options must respect the author style `body.rb-options [hidden] { display: none !important; }`.
4. **Observer Race Condition in Hovercard:** Clearing `pollInterval` in the `MutationObserver` mount handler must not crash if called multiple times or after already cleared.
5. **Deno Formatting and Lint Rules:** All touched files must pass `deno lint` and `deno fmt --check`.

---

## Tasks

### Task 1: Optional — Stabilise Global Token via `storage.local` (Not a Verification Fix)

> Review note: the audit's 🔴 Critical is overstated. Persisting does not fix a real verification break. Keep only if owner wants a single stable token across SW restarts; otherwise skip and accept `sessions`/`dedupeMap` loss on restart.

**Files:**
- Modify: [`src/background/index.js`](file:///home/berkay-fedora/Belgeler/ragebait-x/src/background/index.js)
- Test: [`tests/background/orchestration.test.js`](file:///home/berkay-fedora/Belgeler/ragebait-x/tests/background/orchestration.test.js)

**Interfaces:**
- Consumes: `browserApi.storage.local` (via existing `storage`/`storageAdapter` seam at `src/background/index.js:692-704`)
- Produces: Stable `token` across `wireBrowserRuntime` re-boots; async load must not make `rb:config` return `undefined` on first call.

- [ ] **Step 1: Write the failing test**
In `tests/background/orchestration.test.js`, add a test verifying that when an existing session token is stored in session/local storage, `wireBrowserRuntime` or `createBackground` restores it instead of generating a new random token on every boot.

```javascript
test("background restores session token from storage if present", async () => {
  const fakeStorage = new Map([["session_token", "rb-persisted-token-12345"]]);
  const storageAdapter = {
    async get(key) { return fakeStorage.get(key) ?? null; },
    async set(key, val) { fakeStorage.set(key, val); }
  };
  const bg = createBackground({ storage: storageAdapter });
  // token should be retrieved or initialized with persistence
  assert.equal(await bg.getToken(), "rb-persisted-token-12345");
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `node --test tests/background/orchestration.test.js`
Expected: FAIL (bg.getToken is not a function or token does not match persisted value).

- [ ] **Step 3: Implement token persistence in `src/background/index.js`**
Add storage helpers to retrieve/store the token in `storage.local` (NOT `storage.session` — MV2 has none). Reuse the existing `storage` seam in `wireBrowserRuntime` (`:692-704`), not a new `session_token` key format. Expose `getToken()` on the background orchestrator and ensure `wireBrowserRuntime` uses the persisted token. Note: `storage.local` persistence means the token outlives the browser session — acceptable (correlation only, public by design) but state it in code comment.

- [ ] **Step 4: Run test to verify it passes**
Run: `node --test tests/background/orchestration.test.js`
Expected: PASS.

- [ ] **Step 5: Verify all background tests pass**
Run: `node --test 'tests/background/*.test.js'`
Expected: All pass.

---

### Task 2: Cross-Browser API Portability in Options Page

**Files:**
- Modify: [`src/options/index.js`](file:///home/berkay-fedora/Belgeler/ragebait-x/src/options/index.js)
- Test: [`tests/options/options-ui.test.js`](file:///home/berkay-fedora/Belgeler/ragebait-x/tests/options/options-ui.test.js)

**Interfaces:**
- Consumes: `globalThis.browser`, `globalThis.chrome`
- Produces: `getExtensionApi()` helper providing consistent `storage.local` access.

- [ ] **Step 1: Write the failing test**
In `tests/options/options-ui.test.js`, add a test testing options page boot in an environment where only `chrome` exists (and `browser` is `undefined`).

```javascript
test("options page boots and adapts storage when only chrome global exists", async () => {
  // simulate Chrome environment where window.browser is undefined but window.chrome is present
  const originalBrowser = globalThis.browser;
  const originalChrome = globalThis.chrome;
  try {
    delete globalThis.browser;
    globalThis.chrome = {
      storage: {
        local: {
          get: async (k) => ({ [k]: JSON.stringify({ mode: "proxy", consentAccepted: true }) }),
          set: async () => {}
        }
      }
    };
    // Should successfully read storage via chrome fallback without throwing
    const settings = await loadSettings(browserStorageAdapter());
    assert.equal(settings.mode, "proxy");
  } finally {
    globalThis.browser = originalBrowser;
    globalThis.chrome = originalChrome;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `node --test tests/options/options-ui.test.js`
Expected: FAIL (boot is inert — `isExtensionPage()` returns false / `loadAndRender` never runs, not a thrown `ReferenceError`).

- [ ] **Step 3: Implement `extensionApi` resolution in `src/options/index.js`**
Define (matches `src/background/index.js:796` and `src/content.js:80`):
```javascript
const extensionApi = typeof browser !== "undefined"
  ? browser
  : (typeof chrome !== "undefined" ? chrome : null);
```
Replace every direct `browser.storage.local` (adapter `:137-144`, `refreshQuota:287-294`, save path) and `isExtensionPage()` / auto-boot guard (`:154,:400`) with `extensionApi`. Guard: `chrome.storage.local.get(string)` promise shape matches `browser` shape used by the adapter; no callback-style rewrite.

- [ ] **Step 4: Run test to verify it passes**
Run: `node --test tests/options/options-ui.test.js`
Expected: PASS.

---

### Task 3: Standardize Options Page DOM to `hidden` Attribute

**Files:**
- Modify: [`src/options/index.html`](file:///home/berkay-fedora/Belgeler/ragebait-x/src/options/index.html)
- Modify: [`src/options/index.js`](file:///home/berkay-fedora/Belgeler/ragebait-x/src/options/index.js)
- Test: [`tests/options/options-ui.test.js`](file:///home/berkay-fedora/Belgeler/ragebait-x/tests/options/options-ui.test.js)

- [ ] **Step 1: Write test for `.hidden` property updates**
Verify that `updateModeUI(doc, "heuristic")` sets `proxyFields.hidden = true` and `byokFields.hidden = true` rather than manipulating `style.display`.

- [ ] **Step 2: Run test to verify it fails**
Run: `node --test tests/options/options-ui.test.js`
Expected: FAIL (verifying `hidden` attribute).

- [ ] **Step 3: Update `src/options/index.html` and `src/options/index.js`**
1. In `src/options/index.html`, change `<div id="proxy-fields" style="display: none" class="rb-card">` to `<div id="proxy-fields" hidden class="rb-card">`, and do the same for `#byok-fields`.
2. In `src/options/index.js`, update `updateModeUI` to use `.hidden` for all conditional sections — include the `note` loop at `:261-263` (`[data-mode-note]`), not only `#proxy-fields` / `#byok-fields` (`:254-259`). Audit missed this third site.
   ```javascript
   if (proxyFields) {
     proxyFields.hidden = !(mode === "proxy" && consented);
   }
   if (byokFields) {
     byokFields.hidden = !(mode === "byok" && consented);
   }
   ```

- [ ] **Step 4: Run tests to verify they pass**
Run: `node --test tests/options/options-ui.test.js`
Expected: PASS.

---

### Task 4: Immediate Interval Cancellation in Hovercard Observer & CSS Fallback

**Files:**
- Modify: [`src/page/hovercard.js`](file:///home/berkay-fedora/Belgeler/ragebait-x/src/page/hovercard.js)
- Modify: [`src/brand/brand.css`](file:///home/berkay-fedora/Belgeler/ragebait-x/src/brand/brand.css)
- Test: [`tests/page/hovercard-observer.test.js`](file:///home/berkay-fedora/Belgeler/ragebait-x/tests/page/hovercard-observer.test.js)

- [ ] **Step 1: Add test asserting timer is cleared when `#layers` observer fires**
Verify in `tests/page/hovercard-observer.test.js` that when the `rootWatcher` detects `#layers`, any active fallback interval is cleared immediately.

- [ ] **Step 2: Run test to verify it fails**
Run: `node --test tests/page/hovercard-observer.test.js`

- [ ] **Step 3: Implement early `clearInterval` in `src/page/hovercard.js` and CSS fallback in `src/brand/brand.css`**
1. In `src/page/hovercard.js`, hoist `pollInterval` (and `pollAttempts`) above the `rootWatcher` callback — do not just reference the `const` at `:254` from the callback at `:208` (TDZ risk). Clear `pollInterval` inside `rootWatcher` callback as soon as `mounted && !inner`. Also fix the guard at `:240` (`if (checkedRoot && !inner)`) so a poll tick after the observer wins still clears the interval instead of idling to `pollMaxAttempts`.
2. In `src/brand/brand.css`, change `.ragebait-line-label` color to `var(--rb-band, var(--rb-muted));` (nit severity — missing `var()` with no fallback makes `color` inherit, it does not hide text).

- [ ] **Step 4: Run tests to verify they pass**
Run: `node --test tests/page/hovercard-observer.test.js`
Expected: PASS.

---

### Task 5: Full Project Verification & Build

- [ ] **Step 1: Run format and lint checks**
Run: `npm run lint:js && npm run fmt:check`

- [ ] **Step 2: Run build and extension lint**
Run: `npm run build && npm run check:artifacts && npm run lint`

- [ ] **Step 3: Run full test suite**
Run: `npm test`
Expected: All tests pass with 0 failures (run `npm run check` as final gate, not just `npm test`).
