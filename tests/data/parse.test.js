import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { extractProfileReplies } from "../../src/data/parse.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/fxtwitter-jack.json", import.meta.url),
    "utf8",
  ),
);

test("parse: only author's replies to others are returned", () => {
  const out = extractProfileReplies(fixture, "jack");
  assert.equal(out.length, 1);
  assert.equal(out[0].targetScreenName, "elonmusk");
  assert.equal(
    out[0].text,
    "@elonmusk knkk bak kullanamıyoruz seslide amk ya",
  );
  assert.equal(out[0].lang, "tr");
  assert.equal(out[0].replyCount, 2);
  assert.equal(out[0].createdAt, 1757000000);
});

test("parse: tolerates missing results and junk", () => {
  assert.deepEqual(extractProfileReplies({}, "jack"), []);
  assert.deepEqual(extractProfileReplies({ results: null }, "jack"), []);
  assert.deepEqual(extractProfileReplies({ results: "x" }, "jack"), []);
  assert.deepEqual(
    extractProfileReplies(
      { results: [{ author: null, replying_to: null }] },
      "jack",
    ),
    [],
  );
});

test("parse: field map includes parent id or null", () => {
  const out = extractProfileReplies(fixture, "jack");
  assert.equal(out[0].parentStatusId, "p1");
  assert.equal(out[0].id, "100");
});

test("parse: the author handle matches without regard to case", () => {
  // FxTwitter returns the handle with its original case. The background
  // always asks with the lower-case handle.
  const json = {
    results: [
      {
        id: "9",
        text: "hello",
        lang: "tr",
        author: { screen_name: "Jack" },
        replying_to: { screen_name: "Target", status: "p9" },
        likes: 2,
        replies: 1,
        views: 3,
        created_timestamp: 10,
      },
    ],
  };
  assert.equal(extractProfileReplies(json, "jack").length, 1);
  assert.equal(extractProfileReplies(json, "Jack").length, 1);
  assert.equal(extractProfileReplies(json, "someoneelse").length, 0);
});
