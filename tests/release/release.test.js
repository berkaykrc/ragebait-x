import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  isNoTerminalError,
  isValidVersion,
  nextVersion,
  readConfirmation,
  syncPackageVersion,
  writeManifestVersion,
} from "../../scripts/release.mjs";

test("isValidVersion accepts only x.y.z", () => {
  assert.equal(isValidVersion("0.1.2"), true);
  assert.equal(isValidVersion("0.1"), false);
  assert.equal(isValidVersion("0.1.2-alpha"), false);
  assert.equal(isValidVersion(1), false);
});

test("nextVersion bumps patch, minor, major, or accepts an explicit version", () => {
  assert.equal(nextVersion("0.1.1", "patch"), "0.1.2");
  assert.equal(nextVersion("0.1.1", "minor"), "0.2.0");
  assert.equal(nextVersion("0.1.1", "major"), "1.0.0");
  assert.equal(nextVersion("0.1.1", "0.3.0"), "0.3.0");
});

test("nextVersion rejects a malformed bump", () => {
  assert.throws(() => nextVersion("0.1.1", "latest"), /malformed bump/);
  assert.throws(() => nextVersion("0.1", "patch"), /malformed current version/);
});

test("readConfirmation accepts only y or yes", () => {
  assert.equal(readConfirmation("y\n"), true);
  assert.equal(readConfirmation("Y\n"), true);
  assert.equal(readConfirmation("yes\n"), true);
  assert.equal(readConfirmation("  YES  \n"), true);
  assert.equal(readConfirmation("n\n"), false);
  assert.equal(readConfirmation("\n"), false);
  assert.equal(readConfirmation(""), false);
});

test("isNoTerminalError recognises a stdin without a terminal", () => {
  assert.equal(isNoTerminalError({ code: "EAGAIN" }), true);
  assert.equal(isNoTerminalError({ code: "ENXIO" }), true);
  assert.equal(isNoTerminalError({ code: "ENOENT" }), false);
  assert.equal(isNoTerminalError(new Error("boom")), false);
  assert.equal(isNoTerminalError(undefined), false);
});

test("syncPackageVersion updates package.json and package-lock.json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ragebait-release-"));
  try {
    await writeFile(
      path.join(dir, "package.json"),
      `${
        JSON.stringify(
          { name: "ragebait-detector", version: "0.1.1", type: "module" },
          null,
          2,
        )
      }\n`,
    );
    await writeFile(
      path.join(dir, "package-lock.json"),
      `${
        JSON.stringify(
          {
            name: "ragebait-detector",
            version: "0.1.1",
            lockfileVersion: 3,
            requires: true,
            packages: { "": { name: "ragebait-detector", version: "0.1.1" } },
          },
          null,
          2,
        )
      }\n`,
    );

    syncPackageVersion("0.1.2", dir);

    const pkg = JSON.parse(
      await readFile(path.join(dir, "package.json"), "utf8"),
    );
    const lock = JSON.parse(
      await readFile(path.join(dir, "package-lock.json"), "utf8"),
    );
    assert.equal(pkg.version, "0.1.2");
    assert.equal(lock.version, "0.1.2");
    assert.equal(lock.packages[""].version, "0.1.2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
