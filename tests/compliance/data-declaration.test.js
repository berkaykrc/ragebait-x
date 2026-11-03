import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const UPDATE_URL =
  "https://github.com/berkaykrc/ragebait-x/releases/latest/download/updates.json";

async function readSourceManifest(target) {
  const file = path.join(rootDir, `manifest.${target}.json`);
  return JSON.parse(await readFile(file, "utf8"));
}

test("both manifests declare the real data surface", async () => {
  const [mv2, mv3] = await Promise.all([
    readSourceManifest("mv2"),
    readSourceManifest("mv3"),
  ]);

  for (const [target, manifest] of [["mv2", mv2], ["mv3", mv3]]) {
    const gecko = manifest.browser_specific_settings.gecko;
    assert.ok(
      !gecko.id.endsWith(".local"),
      `${target}: gecko id must not be a .local placeholder`,
    );
    assert.deepEqual(
      gecko.data_collection_permissions.required,
      ["websiteActivity"],
      `${target}: the hovered handle is always sent to FxTwitter`,
    );
    assert.deepEqual(
      gecko.data_collection_permissions.optional,
      ["websiteContent"],
      `${target}: AI mode sends reply text, but only after consent`,
    );
    assert.equal(gecko.update_url, UPDATE_URL);
  }

  assert.deepEqual(
    mv3.browser_specific_settings.gecko.data_collection_permissions,
    mv2.browser_specific_settings.gecko.data_collection_permissions,
  );
});

test("the update_url is an HTTPS manifest under releases/latest", async () => {
  const manifest = await readSourceManifest("mv2");
  const updateUrl = manifest.browser_specific_settings.gecko.update_url;
  assert.ok(updateUrl.startsWith("https://"));
  assert.ok(updateUrl.endsWith("/releases/latest/download/updates.json"));
});
