import { test } from "node:test";
import assert from "node:assert/strict";

import { countLexiconHits } from "../../src/analysis/lexicon.js";

test("lexicon: amk and cope are two hits", () => {
  assert.equal(countLexiconHits("amk cope"), 2);
});

test("lexicon: matching is whole-word and case-insensitive", () => {
  assert.equal(countLexiconHits("AMK Cope"), 2);
  // Agglutination under-matches by design (deferred to Task 18).
  assert.equal(countLexiconHits("amkbetimlemeyecekmis"), 0);
});

test("lexicon: ordinary words are not provocation terms", () => {
  // "it" is one of the most common English words; "gece" and "geri" are
  // everyday Turkish. None of them may count as a lexicon hit.
  assert.equal(countLexiconHits("it was a long night"), 0);
  assert.equal(countLexiconHits("gece geri geldim, kopya degil"), 0);
});

test("lexicon: repeated mentions each count as one hit", () => {
  assert.equal(countLexiconHits("amk amk amk"), 3);
});

test("lexicon: empty and null text have no hits", () => {
  assert.equal(countLexiconHits(""), 0);
  assert.equal(countLexiconHits(null), 0);
  assert.equal(countLexiconHits(undefined), 0);
});
