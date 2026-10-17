import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const distDir = path.join(rootDir, "dist-mv2");

const manifest = JSON.parse(
  await readFile(path.join(rootDir, "manifest.mv2.json"), "utf8"),
);

/** Every asset path the manifest points at, collected generically. */
function referencedAssets(m) {
  return [
    ...(m.content_scripts ?? []).map((cs) => cs.js),
    ...(m.content_scripts ?? []).flatMap((cs) => cs.css ?? []),
    ...(m.background?.scripts ?? []),
    m.background?.service_worker,
    m.options_ui?.page,
    m.options_page,
    ...(m.web_accessible_resources ?? []).map((
      r,
    ) => (typeof r === "string" ? r : r.resources)),
  ].flat().filter((v) => typeof v === "string" && v.length > 0);
}

test("manifest: declares the fxtwitter host permission for the background cross-origin fetch", () => {
  assert.ok(
    manifest.permissions.includes("https://api.fxtwitter.com/*"),
    "content-script match patterns do NOT authorise a cross-origin fetch; the API origin must be an explicit host permission",
  );
  assert.ok(manifest.permissions.includes("storage"));
});

test("manifest: content_scripts[0].js is ['content.js']", () => {
  // Array, not the scalar "content.js" the plan's Step 6 asserts: addons-linter
  // (the linter that gates AMO submission) calls scriptRule.js.forEach and
  // crashes with `TypeError: scriptRule.js.forEach is not a function` on a scalar.
  assert.deepEqual(manifest.content_scripts[0].js, ["content.js"]);
});

test("manifest: runs the content script at document_start on x.com and twitter.com", () => {
  const cs = manifest.content_scripts[0];
  assert.equal(cs.run_at, "document_start");
  assert.ok(cs.matches.includes("https://x.com/*"));
  assert.ok(cs.matches.includes("https://twitter.com/*"));
});

test("manifest: exposes page.js as a web-accessible resource (the page-world bundle)", () => {
  const war = manifest.web_accessible_resources;
  const list = Array.isArray(war)
    ? war
    : (war ?? []).map((r) => r.resources).flat();
  assert.ok(list.includes("page.js"));
});

test("manifest: uses an MV2 background script page and an options page", () => {
  assert.equal(manifest.manifest_version, 2);
  assert.deepEqual(manifest.background.scripts, ["background.js"]);
  assert.equal(manifest.options_ui.page, "options.html");
  assert.equal(manifest.options_ui.open_in_tab, true);
});

test("manifest: gecko id is an opaque GUID that carries no author identity", () => {
  const id = manifest.browser_specific_settings.gecko.id;
  // AMO matches every future update to this exact string and never changes it
  // for you, so a malformed id orphans the add-on. Both formats MDN accepts:
  // a GUID, or a string matching ^[a-zA-Z0-9-._]*@[a-zA-Z0-9-._]+$.
  assert.match(
    id,
    /^\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$/,
    "gecko id must be a well-formed GUID",
  );
  // Anonymity is a requirement here, not a preference. The id ships inside the
  // .xpi, so anything identifying in it is readable by anyone who installs the
  // add-on — an email-style id would hand out a real address (and attract spam,
  // per MDN) and would link the add-on to an online identity.
  assert.doesNotMatch(
    id,
    /@/,
    "email-style ids embed an address; use the GUID form",
  );
  assert.doesNotMatch(
    id,
    /berkay|krc|kirci/i,
    "the gecko id must not cross-reference an online identity",
  );
});

test("manifest: strict_min_version is 128.0, the signature-recognition floor", () => {
  // Below 128.0 (other than 115 ESR) Firefox no longer recognises extension
  // signatures, so a lower floor claims support for installs that can never
  // receive a signed update from update_url.
  assert.equal(
    manifest.browser_specific_settings.gecko.strict_min_version,
    "128.0",
  );
});

test("manifest: declares the v1 data-collection truth and nothing more", () => {
  const gecko = manifest.browser_specific_settings.gecko;
  const dcp = gecko.data_collection_permissions;
  // Mandatory for every NEW AMO submission since 2025-11-03. Omitting it is a
  // rejection, not a warning (addons-linter MISSING_DATA_COLLECTION_PERMISSIONS).
  assert.ok(
    dcp,
    "data_collection_permissions is required for new AMO submissions",
  );
  // v1 transmits exactly one thing off-device: the hovered handle, to FxTwitter.
  // Reply text is only ever fetched inward; the AI/Cloudflare path is Phase 2.
  assert.deepEqual(
    dcp.required,
    ["websiteActivity"],
    "v1 collects/transmits the hovered account handle and nothing else",
  );
  assert.equal(
    dcp.optional,
    undefined,
    "v1 has no optional collection — do not declare an intent to collect",
  );
  assert.ok(
    !("has_previous_consent" in dcp),
    "has_previous_consent is reserved and rejected by addons-linter",
  );
  assert.ok(
    !dcp.required.includes("none"),
    "`none` must not be combined with real required categories",
  );
});

test("manifest: declared data collection still matches the real network surface", () => {
  // The declaration is a compliance claim, so it must be falsifiable against the
  // code. A new external host means something else leaves the device, which means
  // data_collection_permissions has to change with it.
  const externalHosts = manifest.permissions.filter((p) => p.includes("*"));
  assert.deepEqual(
    externalHosts,
    ["https://api.fxtwitter.com/*"],
    "a new external host changes what leaves the device — revisit data_collection_permissions",
  );
});

test("manifest: every referenced asset resolves to a file the build emits", async () => {
  const assets = referencedAssets(manifest);
  assert.ok(
    assets.length > 0,
    "expected the manifest to reference at least one asset",
  );
  for (const asset of assets) {
    await assert.doesNotReject(
      access(path.join(distDir, asset)),
      `manifest references "${asset}" but dist-mv2/ does not contain it — run \`npm run build\``,
    );
  }
});

test("manifest: no referenced path is prefixed with dist- or src/", () => {
  for (const asset of referencedAssets(manifest)) {
    assert.doesNotMatch(
      asset,
      /^(dist-|src\/)/,
      `manifest path "${asset}" must be relative to the build root`,
    );
  }
});
