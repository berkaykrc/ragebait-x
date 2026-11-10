import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  isValidVersion,
  nextVersion,
  syncPackageVersion,
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
