// Clef (@cf/cloudflare/clef) contract conformance.
//
// Evidence (Fri Oct 31 2026 live 422): the model validates noul criteria as a
// dictionary ({true, false}) and rejects plain strings; score questions
// require an ordered criteria ARRAY. The plan doc predates the model release
// and sketched criteria as prose strings -- the deployable truth is the
// published schema (developers.cloudflare.com/workers-ai/models/clef).

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildQuestionSet, QUESTIONS } from "../src/questions.js";

const NOUL_IDS = [
  "is_provocative",
  "is_engagement_bait",
  "targets_group_identity",
  "reply_farms_opponents",
];

const VALID_STATE = {
  handle: "alice",
  features: { replyCount: 10, langSupported: true },
  replySample: ["hi"],
};

test("questions: noul criteria is a {true,false} object per Clef schema", () => {
  for (const id of NOUL_IDS) {
    const c = QUESTIONS[id].criteria;
    assert.ok(
      c && typeof c === "object" && !Array.isArray(c),
      `${id}.criteria must be an object, got: ${typeof c}`,
    );
    assert.ok("true" in c, `${id}.criteria must describe "true"`);
    assert.ok("false" in c, `${id}.criteria must describe "false"`);
  }
});

test("questions: score criteria is an ordered array of 2-10 levels", () => {
  const q = QUESTIONS.intensity;
  assert.equal(q.type, "score");
  assert.ok(
    Array.isArray(q.criteria),
    `intensity.criteria must be an array, got: ${typeof q.criteria}`,
  );
  assert.ok(q.criteria.length >= 2 && q.criteria.length <= 10);
  for (const level of q.criteria) {
    assert.ok(
      typeof level === "string" && level.length > 0,
      "each level must be a non-empty string description",
    );
  }
});

test("questions: outbound payload carries the exact Clef field set", () => {
  const payload = buildQuestionSet(VALID_STATE);
  const qs = payload.questions;
  assert.equal(Object.keys(qs).length, 5);
  for (const id of NOUL_IDS) {
    assert.equal(qs[id].type, "noul");
    assert.equal(typeof qs[id].instructions, "string");
    assert.ok(qs[id].instructions.length > 0);
    assert.ok(!("topic" in qs));
  }
  assert.equal(qs.intensity.type, "score");
});
