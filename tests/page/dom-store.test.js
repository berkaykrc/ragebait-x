import { test } from "node:test";
import assert from "node:assert/strict";

import { createDomStore } from "../../src/page/dom-store.js";

/** A reply in the Task 4 shape. */
function reply(id, extra = {}) {
  return {
    id,
    text: `reply ${id}`,
    lang: "tr",
    targetScreenName: "elonmusk",
    parentStatusId: `parent-${id}`,
    likes: 3,
    replyCount: 1,
    views: 100,
    createdAt: 1757000000,
    ...extra,
  };
}

test("dom-store: record then get returns the stored replies", () => {
  const store = createDomStore();
  store.record("Jack", [reply("1"), reply("2")]);
  assert.deepEqual(store.get("jack"), [reply("1"), reply("2")]);
});

test("dom-store: get on an unseen handle returns null", () => {
  assert.equal(createDomStore().get("nobody"), null);
});

test("dom-store: merge deduplicates by id and prefers the API copy", () => {
  const store = createDomStore();
  store.record("jack", [reply("1"), reply("2")]);

  const merged = store.merge("jack", [
    { ...reply("2"), likes: 999 }, // conflicts with the stored copy
    reply("3"), // new
  ]);

  const byId = new Map(merged.map((r) => [r.id, r]));
  assert.equal(byId.size, 3, "union should hold three distinct ids");
  assert.equal(byId.get("2").likes, 999, "the API copy wins on conflict");
  assert.equal(byId.get("1").likes, 3, "the untouched stored copy is kept");
  assert.ok(byId.has("3"), "the API-only reply is present");
});

test("dom-store: merge with no stored replies returns the API replies", () => {
  const store = createDomStore();
  store.record("jack", []);
  assert.deepEqual(store.merge("jack", [reply("9")]), [reply("9")]);
});

test("dom-store: records lacking a parent id are stored with parentStatusId null", () => {
  const store = createDomStore();
  const { parentStatusId, ...noParent } = reply("1");
  assert.equal(parentStatusId, "parent-1"); // fixture sanity
  store.record("jack", [noParent]);

  const stored = store.get("jack");
  assert.deepEqual(stored, [{ ...noParent, parentStatusId: null }]);
});

test("dom-store: record overwrites, never accumulates", () => {
  const store = createDomStore();
  store.record("jack", [reply("1")]);
  store.record("jack", [reply("2")]);
  assert.deepEqual(store.get("jack"), [reply("2")]);
});

test("dom-store: a stored record is never mutated by the caller afterwards", () => {
  const store = createDomStore();
  const replies = [reply("1")];
  store.record("jack", replies);
  replies.push(reply("2"));
  assert.equal(store.get("jack").length, 1);
});

test("dom-store: merge tolerates junk without throwing", () => {
  const store = createDomStore();
  store.record("jack", [reply("1")]);
  const merged = store.merge("jack", [null, "nope", {}, reply("2")]);
  assert.deepEqual(merged.map((r) => r.id).sort(), ["1", "2"]);
});
