# Ragebait Detector — Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the extension a real visual identity — a clinical/laboratory brand system, an extension icon set, a branded hovercard band, and a settings page that actually matches the DOM contract its own JavaScript expects.

**Architecture:** One hand-authored CSS file (`src/brand/brand.css`) is the single source of brand truth. It reaches two consumers by two different, CSP-safe routes: a `<link>` on the options page, and `content_scripts[0].css` in the manifest for the hovercard line. The hovercard line gains structure (`parts` + a band-derived meter) without changing a single byte of its rendered text, so every existing render test keeps passing. The icon set is generated from one geometry module that emits both the SVG and the PNGs, so the two cannot drift.

**Tech Stack:** Vanilla JS ES modules, Node 22 (`node:test`, jsdom, esbuild, web-ext), Deno (lint + fmt), plain CSS, `node:zlib` for PNG encoding. No new dependencies.

**Spec:** This plan *is* the spec — the approved design is folded in below (Sections 0–2) because the plan-mode harness restricts writes to this directory.

## Global Constraints

- No new npm dependencies. The toolchain stays exactly `esbuild`, `web-ext`, `jsdom`. PNG encoding uses the built-in `node:zlib`; CRC32 is implemented in-repo.
- No remote resources anywhere: no webfonts, no CDN, no `url(http…)` in CSS, no `<script src="http…">`. The add-on is offline-only and AMO rejects remote code.
- `src/page/render.js` stays an allowlist-only module: no `innerHTML`/`insertAdjacentHTML` (addons-linter runs with `--warnings-as-errors` and treats HTML assignment as `UNSAFE_VAR_ASSIGNMENT`), and no value from outside the module ever reaches the DOM. Band-derived numbers only.
- `src/shared/security.js` is never bundled into `page.js`.
- Every CSS rule that reaches x.com is scoped under a `ragebait-line`/`rb-` class. Zero selectors may reference X's own classes or `[data-testid]` — X restyles constantly and our pill must degrade, not vanish.
- `npm run check` is green at the end of every task. Run `npm run fmt` before committing (Deno owns formatting; `fmt:check` is a gate).
- MV2 only. `dist-mv2/` and `dist-mv3/` are gitignored and rebuilt; committed assets live in `assets/`.

## Review Focus

1. **X's light theme.** X's hovercard is white for light-mode users; pill colours tuned only for dark render pale, near-invisible text. Expectation: legible in both themes.
2. **One-sided palette edit.** A band colour changed in `render.js` but not in `brand.css` (or the reverse) makes the legend lie. Expectation: the mismatch fails a test.
3. **`percent` edge values.** `0`, `-5`, `NaN`, `Infinity`, a string. Expectation: never `"NaN"`/`"Infinity"`/`"%"`-with-no-number in the line; non-finite falls back to the estimated copy, `0` renders `%0`.
4. **Manifest declares assets the build does not emit.** Expectation: a bad `icons` or `css` path fails `tests/compliance/manifest.test.js` and a new icon test.
5. **Committed icons drift from their generator.** Someone edits `assets/icon-48.png` by hand, or the generator changes and nobody regenerates. Expectation: bytes compared against a fresh in-memory render, so drift fails.

---

## Section 0 — The bug this plan found (fix before anything visual)

`src/options/index.html` and `src/options/index.js` have drifted apart. The JS queries `input[name="mode"]` radios, `#mode-extra`, `#consent-ai`, `#proxy-fields`, `#byok-fields`, `#quota-used`, `#quota-limit`, `#misclassification-mailto`, `#status`, `#save-btn`. The HTML has a `<select id="mode">`, `#proxyFields`, `#byokFields`, `#stats`, `#limit`, `#reportLink`, and **no save button at all**. So today the settings page cannot save, cannot show quota, and never wires the report link. `readForm()` additionally hardcodes `misclassificationEmail: ""`, so saving silently wipes a stored address even though the page advertises the field.

Task 5 repairs the contract; Task 6 then makes it beautiful. A reviewer can reject the visual pass while approving the repair.

## Section 1 — Brand tokens (exact values, copied verbatim into `src/brand/brand.css`)

Base (dark) block, on `:root`:

```
--rb-ink: #0b0d10
--rb-panel: #12151a
--rb-panel-2: #171b21
--rb-line: #23282f
--rb-text: #e7eaee
--rb-muted: #8b95a1
--rb-accent: #4cc2c4
--rb-band-low: #46c07a
--rb-band-medium: #e3b63f
--rb-band-high: #f0445c
```

`@media (prefers-color-scheme: light)` overrides:

```
--rb-ink: #f6f7f9
--rb-panel: #ffffff
--rb-panel-2: #f1f3f6
--rb-line: #e2e6ec
--rb-text: #10141a
--rb-muted: #5c6673
--rb-band-low: #128a4c
--rb-band-medium: #8a6a00
--rb-band-high: #c8102e
```

Typography: sans `ui-sans-serif, system-ui, "Segoe UI", sans-serif`; mono `ui-monospace, "Cascadia Mono", Menlo, monospace`. Micro-labels are mono, uppercase, 11px, `letter-spacing: .08em`. Numbers are mono with `font-variant-numeric: tabular-nums`.

`BAND_STYLES` colours in `render.js` are the **dark** values (X's default theme is dark): `low #46c07a`, `medium #e3b63f`, `high #f0445c`. The parity test in Task 1 compares against the base block only.

## Section 2 — The mark

A rounded-square "specimen" tile with three stacked bars of increasing width — the icon is a miniature signal meter, the same idea as the hovercard pill, so icon and product read as one thing.

Geometry on a 128-unit grid: tile rect `(0,0,128,128) rx 28` fill `#0b0d10`; three bars, height 16, vertical gap 10, widths `40 / 64 / 88`, left-aligned at `x = 20`, top y = 18/44/70, fill `#e7eaee` except the longest bar in `#4cc2c4`. Emitted PNG sizes: 16, 32, 48, 64, 96, 128. Manifest declares 48/96/128.

---

### Task 1: Brand token file and the palette parity guard

**Files:**
- Create: `src/brand/brand.css` (token blocks only in this task)
- Modify: `src/page/render.js:32-36` (`BAND_STYLES` colours)
- Create: `tests/brand/tokens.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: CSS custom properties named in Section 1, on `:root`, plus a light-scheme override block. Task 3 keys band CSS off these names; Task 6's legend uses them.

- [ ] **Step 1: Write the failing parity test**

`tests/brand/tokens.test.js` reads `src/brand/brand.css` as text and extracts custom properties with a regex per name. Assert:

```js
const css = await readFile("src/brand/brand.css", "utf8");
const token = (name) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`))?.[1];

for (const band of ["low", "medium", "high"]) {
  assert.equal(token(`rb-band-${band}`), BAND_STYLES[band].color,
    `render.js BAND_STYLES.${band} and brand.css --rb-band-${band} must be the same hex`);
}
```

Plus: every token in the Section 1 list is present; `--rb-accent` is not equal to any band colour; and a light-scheme block exists that overrides all three band tokens (`@media (prefers-color-scheme: light)` … `--rb-band-low:`) — Review Focus #1 as a falsifiable check.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/brand/tokens.test.js`
Expected: FAIL — `ENOENT` on `src/brand/brand.css`.

- [ ] **Step 3: Create `src/brand/brand.css` with the token blocks**

Write `:root { … }` with the eleven dark tokens, then `@media (prefers-color-scheme: light) { :root { … } }` with the eleven light overrides. No component rules yet. Then update `BAND_STYLES` in `src/page/render.js` to `low #46c07a`, `medium #e3b63f`, `high #f0445c` (add a comment that these are the dark-theme values and are pinned to the CSS by `tests/brand/tokens.test.js`).

- [ ] **Step 4: Run the tests**

Run: `node --test tests/brand/tokens.test.js tests/page/render.test.js tests/page/render-states.test.js`
Expected: PASS. The render tests pass because they build their regexes from `BAND_STYLES` itself.

- [ ] **Step 5: Format and run the full gate**

Run: `npm run fmt && npm run check`
Expected: all gates green.

- [ ] **Step 6: Commit**

```bash
git add src/brand/brand.css src/page/render.js tests/brand/tokens.test.js
git commit -m "feat(brand): token file and the palette parity guard"
```

---

### Task 2: Icon set generated from one geometry module

**Files:**
- Create: `scripts/lib/mark-geometry.mjs`
- Create: `scripts/icons.mjs`
- Create: `assets/mark.svg`, `assets/icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-64.png`, `icon-96.png`, `icon-128.png` (generated, committed)
- Modify: `manifest.mv2.json` (add `icons`)
- Modify: `esbuild.config.mjs` (copy `assets/` into each dist root)
- Modify: `tests/compliance/manifest.test.js:19-31` (`referencedAssets` gains `m.icons` values)
- Create: `tests/brand/icons.test.js`
- Modify: `deno.json` (add `assets` to `lint.exclude` and `fmt.exclude` — generated output must not be formatted)

**Interfaces:**
- Consumes: the Section 2 geometry.
- Produces:
  - `scripts/lib/mark-geometry.mjs` exports `PRIMS` (array of `{type: "rect", x, y, w, h, rx, fill}` on the 128 grid) and `SIZES = [16, 32, 48, 64, 96, 128]`.
  - `scripts/icons.mjs` exports `renderIconPng(size: number): Buffer`, `renderMarkSvg(): string`, `writeAssets(dir: string): Promise<string[]>`; run as a script it calls `writeAssets("assets")` and logs each path written.
  - `npm run icons` → `node scripts/icons.mjs`.

- [ ] **Step 1: Write the failing geometry test**

`tests/brand/icons.test.js`:

```js
// every manifest icon path exists in assets/ and in dist-mv2/
for (const [size, file] of Object.entries(manifest.icons)) { /* access both */ }
// committed PNGs are byte-identical to a fresh render (drift guard, Review Focus #5)
for (const size of Object.keys(manifest.icons).map(Number)) {
  assert.deepEqual(await readFile(`assets/icon-${size}.png`), renderIconPng(size));
}
// IHDR dimensions equal the declared size, read from the PNG bytes
```

Also assert the smallest feature survives 16px: for every prim, `min(w, h) * 16 / 128 >= 1.5` (Review Focus #5's legibility half).

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/brand/icons.test.js`
Expected: FAIL — module not found `scripts/lib/mark-geometry.mjs`.

- [ ] **Step 3: Implement the geometry module**

`PRIMS` as four rects per Section 2 (tile + three bars). Coordinates are exact numbers; the module holds no rendering logic.

- [ ] **Step 4: Implement the two emitters from `PRIMS`**

- SVG: one `<rect>` per prim with `rx`, written by `renderMarkSvg()`.
- PNG: `renderIconPng(size)` builds an RGBA buffer at `size`, supersampling each pixel 4×4 and computing rounded-rect signed-distance coverage per sample from the prims scaled by `size / 128`; rows are prefixed with a filter byte 0, then `deflateSync` from `node:zlib`, wrapped in IHDR/IDAT/IEND with a CRC32 helper implemented in the same file. Alpha is straight (not premultiplied); the tile is opaque.

- [ ] **Step 5: Generate the assets and wire the build**

Run: `node scripts/icons.mjs` → writes the six PNGs plus `assets/mark.svg`.
Add to `manifest.mv2.json`:

```json
"icons": { "48": "icon-48.png", "96": "icon-96.png", "128": "icon-128.png" }
```

In `esbuild.config.mjs`, add an `copyAssetsPlugin(outdir)` alongside the existing plugins: `readdir("assets")` then `copyFile` each entry to `outdir` in `onEnd`. Add `"icons": "node scripts/icons.mjs"` to `package.json` scripts (so `npm run icons` exists). Extend `referencedAssets` in `tests/compliance/manifest.test.js` with `Object.values(m.icons ?? {})` so the existing "every referenced asset resolves to a file the build emits" test covers icons too (Review Focus #4). Add `assets` to both `exclude` arrays in `deno.json` with a comment saying it is generated output.

- [ ] **Step 6: Run the tests**

Run: `node --test tests/brand/icons.test.js tests/compliance/manifest.test.js`
Expected: PASS (the manifest test needs `npm run build` first — AGENTS.md, build before test).

- [ ] **Step 7: Format, gate, commit**

Run: `npm run fmt && npm run check`
Expected: green. Then:

```bash
git add scripts/lib/mark-geometry.mjs scripts/icons.mjs assets manifest.mv2.json esbuild.config.mjs deno.json tests/brand/icons.test.js tests/compliance/manifest.test.js package.json
git commit -m "feat(brand): generated icon set wired into the manifest and build"
```

---

### Task 3: Structured hovercard line — `parts` and the band meter

**Files:**
- Modify: `src/page/render.js` (`BAND_STYLES` gains `steps`; `lineSpec` returns `parts` and `meter`; `buildLineMarkup` and `createLineElement` emit them)
- Create: `tests/page/render-parts.test.js`

**Interfaces:**
- Consumes: `BAND_STYLES` from Task 1 (Task 3 does not change the colours it set).
- Produces: `lineSpec(state)` returns
  `{ cls: string, text: string, parts: {cls: string, text: string, hidden?: boolean}[], meter: {cls: string, steps: number, filled: number} | null, band: string | null, sub: {cls, text, color} | null }`
  where **`text === parts.map(p => p.text).join("")`** and `sub` stays outside `parts` (so `spec.text` for the quota notice is still the notice alone). `BAND_STYLES[band]` gains `steps`: `low 1`, `medium 2`, `high 3`. Part classes: `ragebait-line-tag`, `ragebait-line-label`, `ragebait-line-sep`, `ragebait-line-value`, `ragebait-line-note`. Meter element: `class="ragebait-line-meter"` with `steps` children `class="rb-seg rb-on"` / `class="rb-seg"`.

**Text contract — the invariant this task exists to protect.** Every rendered string is byte-identical to today, because the existing tests pin exact `textContent`:

| state | `text` | `parts` |
|---|---|---|
| `result` + percent | `RAGEBAIT: Low · %10` | tag `"RAGEBAIT: "`, label `"Low"`, sep `" · "`, value `"%10"` |
| `result` no percent | `RAGEBAIT: Low(estimated)  ···` | tag, label, note `"(estimated)" + ELLIPSIS` |
| `estimated` | `RAGEBAIT: Medium(estimated (no model))  ···` | tag, label, note `"(estimated (no model))" + ELLIPSIS` |
| `loading` | `RAGEBAIT: analyzing…` | tag, note |
| `insufficient` / `error` / `quota` | the notice copy | single note |
| stale | the band text + `" (stale)"` | as its base state, plus the qualifier appended to the last part's text |

`hidden: true` marks the `sep` parts so Task 4's CSS can `display: none` them (the flex gap replaces the dot visually) — `textContent` is unaffected by CSS, so the invariant holds either way.

- [ ] **Step 1: Write the failing tests**

`tests/page/render-parts.test.js` (jsdom, same `makeDoc()` helper shape as `render-states.test.js`):

```js
// text is derived from parts, never maintained beside them
const spec = render.lineSpec({ state: "result", band: "low", percent: 10 });
assert.equal(spec.text, spec.parts.map((p) => p.text).join(""));
assert.deepEqual(spec.parts.map((p) => p.text), ["RAGEBAIT: ", "Low", " · ", "%10"]);
assert.equal(spec.meter.filled, 1);  // low
assert.equal(spec.meter.steps, 3);

// the DOM keeps the exact text a plain span produced
const el = render.createLineElement(doc, { state: "result", band: "low", percent: 10 });
assert.equal(el.textContent, "RAGEBAIT: Low \u00b7 %10");   // the existing pin
assert.equal(el.querySelector(".ragebait-line-meter").children.length, 3);
assert.equal(el.querySelector(".ragebait-line-label").textContent, "Low");

// the meter is band-derived, never percent-derived: a hostile percent cannot widen it
assert.equal(render.lineSpec({ state: "result", band: "high", percent: 99 }).meter.filled, 3);

// notice states carry no meter; the quota sub-element still renders as today
assert.equal(render.lineSpec({ state: "error" }).meter, null);
assert.equal(render.lineSpec({ state: "quota" }).meter, null);
assert.equal(render.lineSpec({ state: "quota", band: "high" }).sub.text, "High");

// the band colour rides on the label span, not the whole line
assert.equal(el.getAttribute("style"), null);
assert.equal(el.querySelector(".ragebait-line-label").getAttribute("style"),
             `color: ${render.BAND_STYLES.low.color}`);
```

Plus the `percent` edge cases (Review Focus #3): `NaN`, `Infinity`, `-5`, `"80"` and `undefined` all yield the estimated copy and no `NaN`/`Infinity`/`undefined` substring in `textContent`; `percent: 0` yields `RAGEBAIT: Low · %0`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/page/render-parts.test.js`
Expected: FAIL — `spec.meter` is `undefined`/`null` on every state.

- [ ] **Step 3: Implement `parts` and `meter` in `render.js`**

Add `steps` to `BAND_STYLES`. Each spec builder in `STATE_MARKUP` returns `parts` instead of composing a single `text` string; add one helper that derives `text` as the join. `knownBand` stays the only path to a band, so an unknown band still falls through to the error copy. In `createLineElement`, set `el.textContent` only for a single-part spec; otherwise append one span per part (`createElement` + `textContent`, never markup), then the meter, then `sub`. The band colour moves from the line to the label span's inline style. In `buildLineMarkup`, emit the same order as spans, keeping the exact substring `style="color:<hex>"` (no space after the colon — `render-states.test.js:124` greps for it).

- [ ] **Step 4: Update the three substring assertions the segmentation breaks**

`buildLineMarkup` output now has a tag between the label's neighbours, so the *contiguous* regexes at `tests/page/render.test.js:24`, `:31` and `:81` (`/RAGEBAIT: High/`, `/RAGEBAIT: Medium/`, `/RAGEBAIT: Low/`) can no longer match the string. The rendered **text** is unchanged — only the markup's nesting changed. Replace those three with per-part assertions:

```js
assert.match(html, />RAGEBAIT: </);   // tag part
assert.match(html, />High</);         // label part
```

Leave every other assertion in both render test files untouched. If `npm test` shows a failure outside these three, the byte-identical text invariant was broken — stop and fix Task 3 rather than editing the test.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/page/render-parts.test.js tests/page/render.test.js tests/page/render-states.test.js tests/page/hovercard.test.js`
Expected: PASS — including the pre-existing exact-`textContent` assertions, which is the proof the invariant held.

- [ ] **Step 6: Gate and commit**

Run: `npm run fmt && npm run check`
Expected: green. Then:

```bash
git add src/page/render.js tests/page/render-parts.test.js
git commit -m "feat(render): segmented line with a band-derived meter"
```

---

### Task 4: Hovercard pill CSS, delivered through the manifest

**Files:**
- Modify: `src/brand/brand.css` (append the hovercard block)
- Modify: `manifest.mv2.json` (`content_scripts[0].css: ["brand.css"]`)
- Modify: `esbuild.config.mjs` (copy `brand.css` next to `options.html`)
- Create: `tests/brand/brand-css.test.js`

**Interfaces:**
- Consumes: Task 3's part and meter class names; Task 1's tokens.
- Produces: `.ragebait-line` as an inline-flex pill with `gap`, `.ragebait-line-tag` (mono, uppercase, muted), `.ragebait-line-label` (band colour, semibold), `.ragebait-line-sep` (`display: none`), `.ragebait-line-value` (mono, tabular numerals), `.ragebait-line-meter`/`.rb-seg`/`.rb-seg.rb-on`, `.ragebait-line-notice`, `.ragebait-line-loading` (accent pulse), `.ragebait-line-stale` (reduced opacity). Each band modifier `.rb-low`/`.rb-medium`/`.rb-high` sets `--rb-band` to its token; pill background and border are `color-mix(in srgb, var(--rb-band) 12%, var(--rb-panel))` and `… 32%`.

- [ ] **Step 1: Write the failing CSS safety test**

`tests/brand/brand-css.test.js`, parsing `src/brand/brand.css` as text:

```js
// every selector is scoped to our own classes (Review Focus: X restyles constantly)
assert.doesNotMatch(css, /\[data-testid/);
// Allowlist: rb-* and ragebait-* are ours; `visible` (src/options/index.js:209)
// and `error` (src/options/index.js:281) are class names that JS assigns, so
// they cannot be renamed to the rb- prefix.
const ALLOWED = ["rb-", "ragebait-", "visible", "error"];
const badSelectors = [...css.matchAll(/(^|[},])\s*([^{}@]+)\{/g)]
  .map((m) => m[2].trim())
  .filter((sel) => /\.[a-zA-Z]/.test(sel) &&
    ![...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)]
      .every((c) => ALLOWED.some((a) => c[1].startsWith(a))));
assert.deepEqual(badSelectors, [], "every class selector must be in the allowlist");
// no remote resources, ever
assert.doesNotMatch(css, /url\(\s*['"]?https?:/);
assert.doesNotMatch(css, /@import/);
// the line and every part it renders have a rule
for (const sel of [".ragebait-line", ".ragebait-line-tag", ".ragebait-line-label",
                   ".ragebait-line-sep", ".ragebait-line-value",
                   ".ragebait-line-meter", ".rb-seg", ".rb-low", ".rb-medium", ".rb-high"]) {
  assert.match(css, new RegExp(sel.replace(".", "\\.")));
}
// manifest ships it as a content-script stylesheet, and the build emits it
assert.deepEqual(manifest.content_scripts[0].css, ["brand.css"]);
await access("dist-mv2/brand.css");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/brand/brand-css.test.js`
Expected: FAIL — `manifest.content_scripts[0].css` is `undefined`.

- [ ] **Step 3: Write the hovercard block**

Append the rules above to `src/brand/brand.css`, with the light-scheme band tokens already supplying light-theme values. Keyframes: `rb-pulse` (opacity, 1.6s, `ease-in-out`, infinite) used only by `.ragebait-line-loading`.

- [ ] **Step 4: Wire it through the manifest and the build**

Add `"css": ["brand.css"]` to `content_scripts[0]` in `manifest.mv2.json` (note: `js` stays an array — `tests/compliance/manifest.test.js:41` pins that, and addons-linter crashes on a scalar). In `esbuild.config.mjs`, extend the static-copy plugin to also copy `src/brand/brand.css` → `<outdir>/brand.css` for both targets.

- [ ] **Step 5: Gate and commit**

Run: `npm run fmt && npm run check`
Expected: green, including `web-ext lint` with `--warnings-as-errors`. Then:

```bash
git add src/brand/brand.css manifest.mv2.json esbuild.config.mjs tests/brand/brand-css.test.js
git commit -m "feat(brand): hovercard pill styles via the manifest stylesheet"
```

---

### Task 5: Repair the options page contract and make its DOM testable

**Files:**
- Modify: `src/options/index.js` (inject `doc` into the UI functions, export them, wire the email field)
- Rewrite: `src/options/index.html` (structure and ids only — no brand styling yet)
- Create: `tests/options/options-dom.test.js`

**Interfaces:**
- Consumes: nothing from Tasks 1–4 except `manifest.options_ui.page`.
- Produces these exports from `src/options/index.js` (each takes an explicit document; `readForm` defaults to `globalThis.document`):
  - `readForm(doc = globalThis.document): {mode, consentAccepted, proxyUrl, byokEndpoint, apiKey, misclassificationEmail}`
  - `applySettings(doc, settings): void` — fills the form, then calls `updateModeUI(doc, settings.mode)`
  - `updateModeUI(doc, mode): void` — toggles `#mode-extra`'s `.visible` class, `#consent-ai`'s `hidden` attribute, and the `display` of `#proxy-fields` / `#byok-fields`
  - `buildMailto(email: string): {href: string, label: string}` — pure; `updateMailto(doc, email)` applies it to `#misclassification-mailto`
- The HTML contract every test below pins: three radios `input[name="mode"]` with values `heuristic`, `proxy`, `byok`; `input[name="proxyUrl"]`, `input[name="byokEndpoint"]`, `input[name="apiKey"]`, `input[name="consentAccepted"]`, `#misclassification-email`; containers `#mode-extra`, `#consent-ai`, `#proxy-fields`, `#byok-fields`; readouts `#quota-used`, `#quota-limit`; `#misclassification-mailto`; `#status`; `#save-btn`. Keep `<script src="options.js">`.

- [ ] **Step 1: Write the failing tests**

`tests/options/options-dom.test.js`, loading the real `src/options/index.html` into JSDOM with scripts disabled:

```js
// readForm reads what the page actually says (this is the bug: the HTML and the
// JS named different things, so the page read nothing)
const settings = readForm(doc);
assert.equal(settings.mode, "heuristic");
// after choosing proxy in the DOM
assert.equal(readForm(doc).mode, "proxy");
// the address the page advertises is no longer discarded on save
assert.equal(readForm(doc).misclassificationEmail, "e@example.com");
// applySettings is the inverse
applySettings(doc, { ...DEFAULTS, mode: "byok", misclassificationEmail: "a@b.c" });
assert.equal(doc.querySelector('input[name="mode"][value="byok"]').checked, true);
assert.equal(doc.querySelector("#misclassification-email").value, "a@b.c");
// mode UI
updateModeUI(doc, "heuristic");
assert.equal(doc.getElementById("mode-extra").classList.contains("visible"), false);
updateModeUI(doc, "byok");
assert.equal(doc.getElementById("consent-ai").hidden, false);
// mailto carries the raw address as text, not an escaped entity
assert.equal(buildMailto("a&b@c.d").label, "Report by email (a&b@c.d)");
```

Then the drift guard, which is the test that makes the whole class of bug unrepeatable — source-scan `src/options/index.js` for every `getElementById("…")` and `querySelector(All)?('input[name="…"]'…)` and assert each one matches an element in the parsed HTML:

```js
const src = await readFile("src/options/index.js", "utf8");
const ids = [...src.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]);
for (const id of ids) assert.ok(doc.getElementById(id), `options.html is missing #${id}`);
const names = [...src.matchAll(/input\[name="([^"]+)"\]/g)].map((m) => m[1]);
for (const name of new Set(names)) {
  assert.ok(doc.querySelector(`input[name="${name}"]`), `options.html is missing input[name="${name}"]`);
}
// and every control is labelled
for (const el of doc.querySelectorAll("input, select")) {
  assert.ok(el.id && doc.querySelector(`label[for="${el.id}"]`), `unlabelled control: ${el.name || el.id}`);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/options/options-dom.test.js`
Expected: FAIL — the exports do not exist, and the drift guard names `#misclassification-mailto`, which the HTML lacks under that id.

- [ ] **Step 3: Refactor the UI seam in `index.js`**

Thread `doc` through `readForm`, `applySettings`, `updateModeUI`, `updateMailto`; export all four plus `buildMailto`; update `boot()` to pass `document`. In `readForm`, read `#misclassification-email` instead of returning `""`. Replace the `escapeHtml(to)` call in the link label with the raw address — `textContent` already escapes, so `escapeHtml` double-escapes (and becomes unused, which `deno lint` would flag). Remove `escapeHtml` if nothing else references it.

- [ ] **Step 4: Rewrite `index.html` to the contract**

Same prose as today, restructured: `<h1>`, the three mode radios in a `<fieldset>` with `<legend>`, the consent block (`#consent-ai` carries `hidden` initially), `#mode-extra` (empty, no `visible` class), `#proxy-fields` and `#byok-fields` (both `style="display:none"` initially), the email input, the quota line (`#quota-used`, `#quota-limit`), the `#misclassification-mailto` link, `#status` (empty), and `#save-btn`. No CSS beyond what already exists — Task 6 replaces it.

- [ ] **Step 5: Run the tests**

Run: `node --test tests/options/options-dom.test.js tests/options/settings.test.js`
Expected: PASS. The storage tests are untouched — the refactor changes signatures, not `loadSettings`/`saveSettings`.

- [ ] **Step 6: Gate and commit**

Run: `npm run fmt && npm run check`
Expected: green. Then:

```bash
git add src/options/index.js src/options/index.html tests/options/options-dom.test.js
git commit -m "fix(options): rebuild the settings DOM to the contract its own JS expects"
```

---

### Task 6: Brand the options page and the README

> Execute this task with the `design-taste-frontend` skill loaded (the partner asked for the design skills by name). The tokens are already fixed in Section 1 — this task composes them, it does not choose new ones.

**Files:**
- Modify: `src/options/index.html` (mark + wordmark header, hairline cards, mono micro-labels, band legend)
- Modify: `src/brand/brand.css` (options-page component classes)
- Modify: `README.md`
- Modify: `tests/brand/brand-css.test.js` (extend the selector and remote-resource scans to the component classes)

**Interfaces:**
- Consumes: every task above. Task 5's ids and classes are the hooks.
- Produces: `options.html` references `brand.css` via `<link rel="stylesheet" href="brand.css">`, and the options-page classes `.rb-shell`, `.rb-head`, `.rb-mark`, `.rb-card`, `.rb-legend`, `.rb-legend-item`, `.rb-stat`, `.rb-btn`, `.rb-input`, `.rb-status`.

- [ ] **Step 1: Write the failing markup test**

Extend `tests/brand/brand-css.test.js`:

```js
const html = await readFile("src/options/index.html", "utf8");
// the page loads the brand stylesheet and nothing remote
assert.match(html, /<link rel="stylesheet" href="brand\.css">/);
assert.doesNotMatch(html, /https?:\/\//);
assert.doesNotMatch(html, /@font-face|<style/);   // no inline style block, no webfont
// the legend teaches the three bands the hovercard paints, in the band tokens
assert.equal((html.match(/rb-legend-(low|medium|high)/g) ?? []).length, 3);
// every component class the page uses is defined in the stylesheet
for (const cls of [...html.matchAll(/class="(rb-[\w-]+)/g)].map((m) => m[1])) {
  assert.match(css, new RegExp(`\\.${cls}\\b`), `brand.css has no rule for .${cls}`);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/brand/brand-css.test.js`
Expected: FAIL — no `<link>` to `brand.css` yet.

- [ ] **Step 3: Compose the options page**

In `index.html`: a header with the 48px mark (`<img src="icon-48.png" alt="" width="48" height="48">` — Task 2 already ships it to the dist root), the wordmark in the sans stack, and one line of positioning under it. Each of the four groups (mode, consent, contact, quota) is a `.rb-card` with a mono `.rb-label` heading. A `.rb-legend` block lists the three bands as `.rb-legend-item` swatches — a 3-segment meter matching the hovercard — beside `Low` / `Medium` / `High` and one clause of what each means. Quota numerals in mono with `tabular-nums`. `#save-btn` as the single accent-filled button. Structure and ids from Task 5 unchanged.

- [ ] **Step 4: Write the component CSS**

Append the component rules to `brand.css` using the tokens only: card background `--rb-panel`, hairline `1px solid var(--rb-line)`, section labels in the mono stack at 11px/`.08em`/uppercase/`--rb-muted`, inputs on `--rb-panel-2` with a `--rb-line` border and a `--rb-accent` focus ring, `#status` muted and `#status.error` in `--rb-band-high`. `#mode-extra { display: none }` and `.visible { display: block }` — the bare name because `updateModeUI` toggles `visible`, not an `rb-` prefixed one (Task 5's drift test does not scan class names, so this is safe).

- [ ] **Step 5: README**

Put the mark at the top (`assets/mark.svg`), and add a short "Brand" section: what the three bars mean, the palette tokens, and `npm run icons` as the regeneration command. No version numbers in prose — `tests/docs/no-hardcoded-version.test.js` enforces that.

- [ ] **Step 6: Run the tests**

Run: `node --test tests/brand/ && npm run check`
Expected: PASS.

- [ ] **Step 7: Manual verification, then commit**

Load `dist-mv2/manifest.json` as a temporary add-on (AGENTS.md), then check: the hovercard line reads as a pill and is legible in X's **light and dark** themes; hovering a `high` account shows three filled segments, a `low` account one; the settings page saves (button → `#status` says Saved, quota numbers appear, the report link is a populated mailto).

```bash
git add src/options/index.html src/brand/brand.css README.md tests/brand/brand-css.test.js
git commit -m "feat(brand): clinical identity across the settings page and README"
```

---

## Non-goals

- No light/dark *theme switch* for the options page — `prefers-color-scheme` only.
- No screenshot tooling, no store listing copy, no changelog, no new manifest metadata (AMO `homepage_url` etc. is Phase-4 compliance work, not branding).
- The AI/proxy fields stay functional-looking but hidden behind `#mode-extra` exactly as today; Phase 2 makes them real.
- `worker/` and `data/` are untouched.