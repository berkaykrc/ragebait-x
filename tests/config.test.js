import { test } from "node:test";
import assert from "node:assert/strict";

import { FEATURE_VERSION, MODEL_VERSION } from "../src/config.js";

test("config: version constants", () => {
  assert.equal(MODEL_VERSION, "h1");
  assert.equal(FEATURE_VERSION, "f1");
});
