import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const artifacts = path.join(rootDir, "web-ext-artifacts");
const version = JSON.parse(
  readFileSync(path.join(rootDir, "manifest.mv2.json"), "utf8"),
).version;
const firefoxZip = path.join(artifacts, `ragebait_detector-${version}.zip`);
const chromeZip = path.join(artifacts, "ragebait-detector-mv3.zip");

function manifestVersionOf(zip) {
  return JSON.parse(
    execFileSync("unzip", ["-p", zip, "manifest.json"], {
      encoding: "utf8",
    }),
  ).manifest_version;
}

test("package:mv3 does not overwrite the Firefox package", async () => {
  await Promise.all([
    rm(firefoxZip, { force: true }),
    rm(chromeZip, { force: true }),
  ]);

  execFileSync("npm", ["run", "package"], { cwd: rootDir, stdio: "pipe" });
  execFileSync("node", ["scripts/package-mv3.mjs"], {
    cwd: rootDir,
    stdio: "pipe",
  });

  assert.equal(manifestVersionOf(firefoxZip), 2);
  assert.equal(manifestVersionOf(chromeZip), 3);
});
