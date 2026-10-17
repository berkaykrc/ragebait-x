import { test } from "node:test";
import assert from "node:assert/strict";

import { makeScoreResponse, MSG } from "../../src/background/protocol.js";
import { MAX_DAILY_PROFILES } from "../../src/background/quota-local.js";
import { ALLOWED_MSG_TYPES } from "../../src/shared/security.js";

test("protocol: MSG is the same allowlist reference", () => {
  assert.equal(MSG, ALLOWED_MSG_TYPES);
  assert.equal(MSG.size, 4);
});

test("protocol: makeScoreResponse minimal shape", () => {
  const r = makeScoreResponse({ requestId: "r1", result: { state: "result" } });
  assert.deepEqual(r, {
    type: "rb:score-response",
    requestId: "r1",
    result: { state: "result" },
  });
});

test("protocol: makeScoreResponse stringifies requestId", () => {
  const r = makeScoreResponse({ requestId: 42, result: null });
  assert.equal(r.requestId, "42");
});

test("protocol: makeScoreResponse null requestId", () => {
  const r = makeScoreResponse({ result: { state: "error" } });
  assert.equal(r.requestId, null);
});

test("MAX_DAILY_PROFILES is 200", () => {
  assert.equal(MAX_DAILY_PROFILES, 200);
});
