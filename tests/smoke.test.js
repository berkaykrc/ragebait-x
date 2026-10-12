import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("toolchain works: dist-mv2/manifest.json exists and parses", async () => {
  const manifestPath = path.join(rootDir, "dist-mv2", "manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  assert.equal(typeof manifest, "object");
  assert.notEqual(manifest, null);
});
