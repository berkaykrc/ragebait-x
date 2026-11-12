# Chrome Release Asset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach a Chrome-loadable MV3 zip to every release and keep the MV2, MV3, and package versions identical.

**Architecture:** `scripts/package-mv3.mjs` wraps `web-ext build` for `dist-mv3`, then copies the versioned output to a stable asset name. `release.yml` packages and scans it before attaching it to the Release. Version bumping moves from one manifest to a list of two, in both the local script and the workflow button path.

**Tech Stack:** Node 26.13.0 (`node:test`), web-ext, GitHub Actions, Deno lint/fmt.

**Spec:** `docs/superpowers/specs/2026-11-12-chrome-release-asset-design.md`

## Global Constraints

- No new dependency. Use the installed `web-ext`.
- Release passes without Chrome Web Store credentials. No store upload code.
- `manifest.mv2.json` stays the version of record.
- `npm run check` must pass.

## Review Focus

- Stale MV3 version in a release: both manifests must equal the tag.
- Old zip reused from `web-ext-artifacts/`: packaging runs with `--overwrite-dest`.
- Zip with a credential-shaped value: secret scan runs after packaging.
- Missing zip on the Release: `gh release create` lists it explicitly.
- Mozilla-only keys in the MV3 zip: unchanged; the Chrome root already carries them and Chrome ignores them.

---

### Task 1: Bump both manifests

**Files:**
- Modify: `scripts/release.mjs:22-23,60-74,156-174`
- Modify: `.github/workflows/release.yml:108-138,152-163`
- Test: `tests/release/release.test.js`
- Test: `tests/build/dual-manifest.test.js`

**Interfaces:**
- Consumes: existing `nextVersion(current, bump)`, `syncPackageVersion(version, cwd)`.
- Produces: `writeManifestVersion(version, root = ROOT) -> void`; exported for tests.

- [ ] **Step 1: Write the failing test**

Update the import in `tests/release/release.test.js` to include `writeManifestVersion`, then append this test (the file already imports `mkdtemp`, `readFile`, `rm`, `writeFile`, `os`, and `path`):

```js
test("writeManifestVersion updates both manifests", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ragebait-release-"));
  try {
    await writeFile(
      path.join(dir, "manifest.mv2.json"),
      `${JSON.stringify({ version: "0.1.1" }, null, 2)}\n`,
    );
    await writeFile(
      path.join(dir, "manifest.mv3.json"),
      `${JSON.stringify({ version: "0.1.1" }, null, 2)}\n`,
    );

    writeManifestVersion("0.1.2", dir);

    const mv2 = JSON.parse(
      await readFile(path.join(dir, "manifest.mv2.json"), "utf8"),
    );
    const mv3 = JSON.parse(
      await readFile(path.join(dir, "manifest.mv3.json"), "utf8"),
    );
    assert.equal(mv2.version, "0.1.2");
    assert.equal(mv3.version, "0.1.2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/release/release.test.js`
Expected: FAIL, `writeManifestVersion is not exported`.

- [ ] **Step 3: Implement**

In `scripts/release.mjs`:
- Replace `const MANIFEST` with `const MANIFEST = path.join(ROOT, "manifest.mv2.json")` plus `const MANIFESTS = ["manifest.mv2.json", "manifest.mv3.json"]`.
- Export `writeManifestVersion(version, root = ROOT)`. It loops both names, reads `path.join(root, name)`, replaces the first `"version": "..."`, writes back, and throws ``could not find a "version" field in ${name}`` when unchanged.
- `main()` keeps `writeManifestVersion(next)`, then stages `manifest.mv2.json`, `manifest.mv3.json`, `package.json`, `package-lock.json`.
- Update the printed release summary to list both manifests.

In `.github/workflows/release.yml` button step:
- Replace the single-file `node -e` block with a loop over `manifest.mv2.json` and `manifest.mv3.json` that rewrites the version in each.
- Widen the clean check and `git add` to four files.
- Tag assert: compare the tag version with `manifest.mv2.json` and `manifest.mv3.json`; fail if either differs.

- [ ] **Step 4: Add the equality guard**

Append to `tests/build/dual-manifest.test.js`:

```js
test("both manifests and package.json carry the same version", async () => {
  const [mv2, mv3, pkg] = await Promise.all([
    readManifest("mv2"),
    readManifest("mv3"),
    readFile(path.join(rootDir, "package.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal(mv3.version, mv2.version);
  assert.equal(pkg.version, mv2.version);
});
```

- [ ] **Step 5: Run tests**

Run: `npm run build && node --test tests/release/release.test.js tests/build/dual-manifest.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/release.mjs .github/workflows/release.yml tests/release/release.test.js tests/build/dual-manifest.test.js
git commit -m "fix(release): bump both extension manifests"
```

---

### Task 2: Package and attach the Chrome zip

**Files:**
- Create: `scripts/package-mv3.mjs`
- Modify: `package.json` (scripts block)
- Modify: `.github/workflows/release.yml:165-218`
- Modify: `docs/release.md`
- Modify: `README.md` (Status or release section)

**Interfaces:**
- Consumes: `dist-mv3/` from `npm run build`, `web-ext` from devDependencies.
- Produces: `web-ext-artifacts/ragebait-detector-mv3.zip`; npm script `package:mv3`.

- [ ] **Step 1: Write the packaging script**

`scripts/package-mv3.mjs`:
- Read `manifest.mv3.json` version.
- `execFileSync("npx", ["--no-install", "web-ext", "build", "--source-dir", "dist-mv3", "--artifacts-dir", "web-ext-artifacts", "--overwrite-dest"], { cwd: ROOT, stdio: "inherit" })`.
- Source zip: `web-ext-artifacts/ragebait_detector-${version}.zip`.
- `copyFileSync` it to `web-ext-artifacts/ragebait-detector-mv3.zip`.
- Print the stable path.
- Fail with a clear message if `dist-mv3/manifest.json` is missing.

- [ ] **Step 2: Wire the npm script**

In `package.json` add `"package:mv3": "node scripts/package-mv3.mjs"` next to `package`.

- [ ] **Step 3: Verify locally**

Run: `npm run build && npm run package:mv3 && npm run check:artifacts && unzip -l web-ext-artifacts/ragebait-detector-mv3.zip | head`
Expected: zip exists, `manifest.json` listed, artifact scan passes.

- [ ] **Step 4: Update the release workflow**

After the `Build` step: add `Package Chrome MV3` running `npm run package:mv3`. Move nothing else; `Artifact secret scan` stays after it so the zip is scanned.

In `Attach the signed .xpi to the Release`, add `web-ext-artifacts/ragebait-detector-mv3.zip` to the `gh release create` asset list. Rename the step to `Attach the release assets`.

- [ ] **Step 5: Update docs**

- `docs/release.md`: state that each Release carries the signed Firefox XPI, `updates.json`, and `ragebait-detector-mv3.zip` for unpacked/manual Chrome install; no Chrome Web Store publish exists.
- `README.md`: in the Chrome note, say the release zip is the distributable today.

- [ ] **Step 6: Run the full gate and commit**

Run: `npm run check`
Expected: PASS, 400+ tests.

```bash
git add scripts/package-mv3.mjs package.json .github/workflows/release.yml docs/release.md README.md
git commit -m "feat(release): attach a Chrome MV3 zip to releases"
```

---

## Verification After Both Tasks

Run: `npm run check`
Expected: lint, fmt, build, artifact scan, web-ext lint, and all tests pass.

Manual: `npm run package:mv3`, then confirm `web-ext-artifacts/ragebait-detector-mv3.zip` contains `manifest.json` with `"manifest_version": 3` and the same `version` as `manifest.mv2.json`.
