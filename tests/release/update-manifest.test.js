import { test } from "node:test";
import assert from "node:assert/strict";
import {
  argValue,
  buildUpdateManifest,
  STABLE_ASSET,
  updateLink,
} from "../../scripts/update-manifest.mjs";

const ID = "{85dba044-1a23-412f-be1c-6a116cff5d54}";
const LINK = "https://example.test/ragebait-detector.xpi";

test("builds the Firefox update manifest", () => {
  assert.deepEqual(
    buildUpdateManifest({ id: ID, version: "1.2.3", link: LINK }),
    {
      addons: {
        [ID]: {
          updates: [{ version: "1.2.3", update_link: LINK }],
        },
      },
    },
  );
});

test("rejects a malformed version", () => {
  assert.throws(
    () => buildUpdateManifest({ id: ID, version: "1.2", link: LINK }),
    /malformed version/,
  );
});

test("rejects a non-HTTPS update link", () => {
  assert.throws(
    () => buildUpdateManifest({ id: ID, version: "1.2.3", link: "http://x" }),
    /must be https/,
  );
});

test("rejects a missing add-on id", () => {
  assert.throws(
    () => buildUpdateManifest({ id: "", version: "1.2.3", link: LINK }),
    /id is required/,
  );
});

test("argValue rejects a flag with no value", () => {
  assert.throws(() => argValue(["--out"], "--out"), /missing value for --out/);
  assert.throws(
    () => argValue(["--out", "--version", "1.2.3"], "--out"),
    /missing value for --out/,
  );
});

test("default link targets the stable release asset", () => {
  assert.equal(
    updateLink("owner/repo"),
    `https://github.com/owner/repo/releases/latest/download/${STABLE_ASSET}`,
  );
});
