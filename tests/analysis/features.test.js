import { test } from "node:test";
import assert from "node:assert/strict";

import { computeFeatures } from "../../src/analysis/features.js";

function reply(overrides = {}) {
  return {
    id: "r1",
    text: "",
    lang: "tr",
    targetScreenName: null,
    parentStatusId: null,
    likes: 0,
    replyCount: 0,
    views: 0,
    createdAt: 1000,
    ...overrides,
  };
}

test("features: capsRatio counts uppercase letters over all texts", () => {
  const replies = [
    reply({ text: "LAN BU NE" }),
    reply({ text: "123" }),
    reply({ text: "!!" }),
  ];
  const f = computeFeatures(replies);
  assert.equal(f.capsRatio, 1);
});

test("features: exclamationRatio is the share of replies with '!'", () => {
  const replies = [
    reply({ text: "harika!" }),
    reply({ text: "tamam" }),
    reply({ text: "lol!!" }),
    reply({ text: "svce" }),
  ];
  const f = computeFeatures(replies);
  assert.equal(f.exclamationRatio, 0.5);
});

test("features: rhetoricalQuestionRatio is the share of replies ending '?'", () => {
  const replies = [
    reply({ text: "bu ne?" }),
    reply({ text: "net mi" }),
    reply({ text: "neden?" }),
    reply({ text: "iyi" }),
  ];
  const f = computeFeatures(replies);
  assert.equal(f.rhetoricalQuestionRatio, 0.5);
});

test("features: hashtagDensity is hashtags over total words", () => {
  const replies = [reply({ text: "#x #y a b" })];
  const f = computeFeatures(replies);
  assert.equal(f.hashtagDensity, 0.5);
});

test("features: hashtagDensity is 0 without any words", () => {
  const f = computeFeatures([reply({ text: "   " })]);
  assert.equal(f.hashtagDensity, 0);
});

test("features: targetConcentration is the largest single-target share", () => {
  const replies = [
    reply({ targetScreenName: "a" }),
    reply({ targetScreenName: "a" }),
    reply({ targetScreenName: "b" }),
  ];
  const f = computeFeatures(replies);
  assert.equal(f.targetConcentration, 2 / 3);
  assert.equal(f.distinctTargets, 2);
});

test("features: targetConcentration is 1 when every reply targets one account", () => {
  const replies = [
    reply({ targetScreenName: "a" }),
    reply({ targetScreenName: "a" }),
    reply({ targetScreenName: "a" }),
  ];
  const f = computeFeatures(replies);
  assert.equal(f.targetConcentration, 1);
  assert.equal(f.distinctTargets, 1);
});

test("features: targetConcentration is 0 without targets", () => {
  const f = computeFeatures([reply({ targetScreenName: null })]);
  assert.equal(f.targetConcentration, 0);
});

test("features: repeatParentRatio is 1 when one parent is repeated", () => {
  const replies = [
    reply({ parentStatusId: "p1" }),
    reply({ parentStatusId: "p1" }),
    reply({ parentStatusId: "p1" }),
  ];
  const f = computeFeatures(replies);
  assert.equal(f.repeatParentRatio, 1);
});

test("features: parentless replies are excluded from the denominator", () => {
  const replies = [
    reply({ parentStatusId: null }),
    reply({ parentStatusId: null }),
    reply({ parentStatusId: "p1" }),
  ];
  const f = computeFeatures(replies);
  assert.equal(f.repeatParentRatio, 0);
});

test("features: lexiconHits counts whole-word matches case-insensitively", () => {
  const replies = [
    reply({ text: "AMK amk" }),
    reply({ text: "cope" }),
  ];
  const f = computeFeatures(replies);
  assert.equal(f.lexiconHits, 3);
});

test("features: lexicon is skipped for languages outside tr/en", () => {
  const replies = [
    reply({ lang: "fr", text: "amk" }),
    reply({ lang: "en" }),
  ];
  const f = computeFeatures(replies);
  assert.equal(f.langSupported, false);
  assert.equal(f.lexiconHits, null);
});

test("features: a missing language makes the lexicon unsupported", () => {
  const f = computeFeatures([reply({ lang: null })]);
  assert.equal(f.langSupported, false);
  assert.equal(f.lexiconHits, null);
});

test("features: tr and en are supported and the lexicon runs", () => {
  const replies = [reply({ lang: "tr" }), reply({ lang: "en" })];
  const f = computeFeatures(replies);
  assert.equal(f.langSupported, true);
  assert.notEqual(f.lexiconHits, null);
});

test("features: burstRatio is 1 when all replies arrive within one hour", () => {
  const replies = [
    reply({ createdAt: 1000 }),
    reply({ createdAt: 1200 }),
    reply({ createdAt: 3000 }),
  ];
  const f = computeFeatures(replies);
  assert.equal(f.burstRatio, 1);
});

test("features: burstRatio stays low when replies are spread over a day", () => {
  const replies = [];
  for (let i = 0; i < 10; i++) {
    replies.push(reply({ createdAt: 1000 + i * 21600 }));
  }
  const f = computeFeatures(replies);
  assert.ok(f.burstRatio < 0.3);
});

test("features: likesPerReply is the mean likes", () => {
  const replies = [reply({ likes: 10 }), reply({ likes: 20 })];
  const f = computeFeatures(replies);
  assert.equal(f.likesPerReply, 15);
});

test("features: likesPerReply is 0 without likes", () => {
  const f = computeFeatures([reply({ likes: 0 }), reply({ likes: null })]);
  assert.equal(f.likesPerReply, 0);
});

test("features: returns the full vector for any input", () => {
  const f = computeFeatures([]);
  assert.equal(f.replyCount, 0);
  assert.equal(f.distinctTargets, 0);
  assert.equal(f.targetConcentration, 0);
  assert.equal(f.repeatParentRatio, 0);
  assert.equal(f.capsRatio, 0);
  assert.equal(f.exclamationRatio, 0);
  assert.equal(f.rhetoricalQuestionRatio, 0);
  assert.equal(f.hashtagDensity, 0);
  assert.equal(f.lexiconHits, 0);
  assert.equal(f.likesPerReply, 0);
  assert.equal(f.burstRatio, 0);
  assert.equal(f.langSupported, true);
  assert.deepEqual(Object.keys(f), [
    "replyCount",
    "distinctTargets",
    "targetConcentration",
    "repeatParentRatio",
    "capsRatio",
    "exclamationRatio",
    "rhetoricalQuestionRatio",
    "hashtagDensity",
    "lexiconHits",
    "likesPerReply",
    "burstRatio",
    "langSupported",
  ]);
});

test("features: computes the vector below the minimum reply count", () => {
  const f = computeFeatures([reply({ text: "lan" }), reply({ text: "amk" })]);
  assert.equal(f.replyCount, 2);
  assert.notEqual(f.lexiconHits, null);
});
