import { test } from "node:test";
import assert from "node:assert/strict";

import { scrubReplyMentions } from "../../src/background/index.js";

test("scrubReplyMentions replaces @mentions with ellipsis", () => {
  assert.equal(scrubReplyMentions("@elonmusk hello there"), "@… hello there");
  assert.equal(
    scrubReplyMentions("@alice @bob_123 are discussing topic"),
    "@… @… are discussing topic",
  );
});

test("scrubReplyMentions replaces email addresses with [email]", () => {
  assert.equal(
    scrubReplyMentions("Contact us at info@example.com or @twitter_handle"),
    "Contact us at [email] or @…",
  );
});

test("scrubReplyMentions best-effort scrubs IDN, Unicode, and dot-less emails", () => {
  assert.equal(scrubReplyMentions("mail a@b.рф now"), "mail [email] now");
  assert.equal(
    scrubReplyMentions("mail café@example.com now"),
    "mail [email] now",
  );
  assert.equal(
    scrubReplyMentions("mail user@localhost now"),
    "mail [email] now",
  );
});

test("scrubReplyMentions preserves quoted tweet content and conversation text", () => {
  const quoteReply =
    `RT @quoted_author "This is the original quoted statement that gives crucial context." exactly!`;
  assert.equal(
    scrubReplyMentions(quoteReply),
    `RT @… "This is the original quoted statement that gives crucial context." exactly!`,
  );
});

test("scrubReplyMentions handles empty, nullish or non-string inputs", () => {
  assert.equal(scrubReplyMentions(""), "");
  assert.equal(scrubReplyMentions(null), "");
  assert.equal(scrubReplyMentions(undefined), "");
  assert.equal(scrubReplyMentions(123), "");
});

test("scrubReplyMentions preserves words without leading @", () => {
  const text = "Mentioning handle @valid_user_1";
  assert.equal(scrubReplyMentions(text), "Mentioning handle @…");
});

test("scrubReplyMentions replaces URLs with [link] (models cannot browse links)", () => {
  assert.equal(
    scrubReplyMentions("see https://x.com/bob/status/123 for proof"),
    "see [link] for proof",
  );
  assert.equal(
    scrubReplyMentions(
      "reply to https://twitter.com/alice/status/456 @alice ok",
    ),
    "reply to [link] @… ok",
  );
});

test("scrubReplyMentions scrubs uppercase schemes", () => {
  assert.equal(
    scrubReplyMentions("see HTTPS://X.COM/bob/status/123 now"),
    "see [link] now",
  );
});

test("scrubReplyMentions does not eat trailing punctuation", () => {
  assert.equal(scrubReplyMentions("see https://x.com/a."), "see [link].");
  assert.equal(scrubReplyMentions("see https://x.com/a)"), "see [link])");
  assert.equal(
    scrubReplyMentions("see https://x.com/a, then more"),
    "see [link], then more",
  );
});
