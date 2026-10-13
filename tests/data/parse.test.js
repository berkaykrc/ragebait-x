import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { extractProfileReplies } from "../../src/data/parse.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/fxtwitter-yooksiktir.json", import.meta.url),
    "utf8",
  ),
);

test("parse: only author's replies to others are returned", () => {
  const out = extractProfileReplies(fixture, "yooksiktir");
  assert.equal(out.length, 1);
  assert.equal(out[0].targetScreenName, "kviciemre");
  assert.equal(
    out[0].text,
    "@kviciemre knkk bak kullanamıyoruz seslide amk ya",
  );
  assert.equal(out[0].lang, "tr");
  assert.equal(out[0].replyCount, 2);
  assert.equal(out[0].createdAt, 1757000000);
});

test("parse: tolerates missing results and junk", () => {
  assert.deepEqual(extractProfileReplies({}, "yooksiktir"), []);
  assert.deepEqual(extractProfileReplies({ results: null }, "yooksiktir"), []);
  assert.deepEqual(extractProfileReplies({ results: "x" }, "yooksiktir"), []);
  assert.deepEqual(
    extractProfileReplies(
      { results: [{ author: null, replying_to: null }] },
      "yooksiktir",
    ),
    [],
  );
});

test("parse: field map includes parent id or null", () => {
  const out = extractProfileReplies(fixture, "yooksiktir");
  assert.equal(out[0].parentStatusId, "p1");
  assert.equal(out[0].id, "100");
});
