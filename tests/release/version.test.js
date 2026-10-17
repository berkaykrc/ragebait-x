import { test } from "node:test";
import assert from "node:assert/strict";

import { isValidVersion, nextVersion } from "../../scripts/release.mjs";

test("release: patch bumps the third component only", () => {
  assert.equal(nextVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(nextVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(nextVersion("0.9.9", "patch"), "0.9.10");
});

test("release: minor bumps the second component and zeroes the third", () => {
  assert.equal(nextVersion("0.1.0", "minor"), "0.2.0");
  assert.equal(nextVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(nextVersion("0.9.9", "minor"), "0.10.0");
});

test("release: major bumps the first component and zeroes the rest", () => {
  assert.equal(nextVersion("0.1.0", "major"), "1.0.0");
  assert.equal(nextVersion("1.2.3", "major"), "2.0.0");
});

test("release: an explicit version passes through untouched", () => {
  assert.equal(nextVersion("0.1.0", "0.3.0"), "0.3.0");
  assert.equal(nextVersion("0.1.0", "10.20.30"), "10.20.30");
});

test("release: every bump actually changes the version", () => {
  // AMO rejects a re-upload of a version it already holds, and the release
  // tag must not equal the manifest, so a no-op bump is a hard error.
  for (const current of ["0.1.0", "1.2.3", "0.9.9"]) {
    for (const bump of ["patch", "minor", "major"]) {
      assert.notEqual(nextVersion(current, bump), current);
    }
  }
});

test("release: rejects a malformed current version instead of guessing", () => {
  assert.throws(() => nextVersion("0.1", "patch"), /malformed/i);
  assert.throws(() => nextVersion("v0.1.0", "patch"), /malformed/i);
  assert.throws(() => nextVersion("", "patch"), /malformed/i);
  assert.throws(() => nextVersion("0.1.0-alpha", "patch"), /malformed/i);
});

test("release: rejects a malformed explicit target", () => {
  assert.throws(() => nextVersion("0.1.0", "1.0"), /malformed/i);
  assert.throws(
    () => nextVersion("0.1.0", "banana"),
    /malformed|patch|minor|major/i,
  );
  assert.throws(() => nextVersion("0.1.0", ""), /malformed|patch|minor|major/i);
});

test("release: isValidVersion agrees with the parser", () => {
  assert.equal(isValidVersion("0.1.0"), true);
  assert.equal(isValidVersion("10.20.30"), true);
  assert.equal(isValidVersion("0.1"), false);
  assert.equal(isValidVersion("0.1.0-alpha"), false);
  assert.equal(isValidVersion(""), false);
});
