import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function readManifest(target) {
  const file = path.join(rootDir, `dist-${target}`, "manifest.json");
  return JSON.parse(await readFile(file, "utf8"));
}

test("dual build emits the MV2 and MV3 manifest contracts", async () => {
  const [mv2, mv3] = await Promise.all([
    readManifest("mv2"),
    readManifest("mv3"),
  ]);

  assert.equal(mv2.manifest_version, 2);
  assert.equal(mv3.manifest_version, 3);
  assert.deepEqual(mv2.background, { scripts: ["background.js"] });
  assert.deepEqual(mv3.background, { service_worker: "background.js" });
  assert.ok(mv3.action);
  assert.ok(Array.isArray(mv2.web_accessible_resources));
  assert.ok(Array.isArray(mv3.web_accessible_resources));
  assert.equal(typeof mv3.web_accessible_resources[0], "object");
  assert.deepEqual(mv3.host_permissions, [
    "https://api.fxtwitter.com/*",
    "https://ragebait-proxy.dontseemyass.workers.dev/*",
  ]);
  // MV2 has no separate host_permissions key; the FxTwitter host must still be
  // authorised via permissions, or every FxTwitter fetch fails at runtime.
  assert.ok(
    Array.isArray(mv2.permissions) &&
      mv2.permissions.includes("https://api.fxtwitter.com/*"),
    "MV2 must keep the FxTwitter host permission",
  );
  assert.deepEqual(
    mv3.browser_specific_settings.gecko.data_collection_permissions,
    mv2.browser_specific_settings.gecko.data_collection_permissions,
  );
  assert.equal(mv3.update_url, mv2.update_url);
});

test("both manifests and package.json carry the same version", async () => {
  const [mv2, mv3, pkg] = await Promise.all([
    readManifest("mv2"),
    readManifest("mv3"),
    readFile(path.join(rootDir, "package.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal(mv3.version, mv2.version);
  assert.equal(pkg.version, mv2.version);
});
