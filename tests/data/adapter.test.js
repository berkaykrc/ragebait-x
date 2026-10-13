import { test } from "node:test";
import assert from "node:assert/strict";

import { createDomStore } from "../../src/page/dom-store.js";
import {
  domAdapter,
  fxtwitterAdapter,
  mergeAdapters,
} from "../../src/data/adapter.js";

test("adapter: fxtwitter delegates", async () => {
  const fetchImpl = () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => ({ results: [], cursor: {} }),
  });
  const r = await fxtwitterAdapter.fetchReplies("h", {
    fetchImpl,
    sleepImpl: () => {},
  });
  assert.equal(r.ok, true);
});

test("adapter: dom returns data or not_found", async () => {
  const store = createDomStore();
  const r1 = await domAdapter(store).fetchReplies("h");
  assert.deepEqual(r1, { ok: false, reason: "not_found", replies: [] });

  const reply = {
    id: "1",
    text: "x",
    lang: "en",
    targetScreenName: "t",
    parentStatusId: null,
    likes: 0,
    replyCount: 0,
    views: 0,
    createdAt: 1,
  };
  store.record("h", [reply]);
  const r2 = await domAdapter(store).fetchReplies("h");
  assert.equal(r2.ok, true);
  assert.equal(r2.replies.length, 1);
});

test("adapter: merge falls back to the secondary source", async () => {
  const primary = {
    name: "p",
    fetchReplies: () => ({ ok: false, reason: "network", replies: [] }),
  };
  const fallback = {
    name: "f",
    fetchReplies: () => ({ ok: true, replies: [{ id: "x" }] }),
  };
  const m = mergeAdapters(primary, fallback);
  const r = await m.fetchReplies("h", {});
  assert.equal(r.ok, true);
  assert.equal(r.replies[0].id, "x");
});

test("adapter: merge keeps the primary result when it succeeds", async () => {
  const primary = {
    name: "p",
    fetchReplies: () => ({ ok: true, replies: [{ id: "api" }] }),
  };
  const fallback = {
    name: "f",
    fetchReplies: () => ({ ok: true, replies: [{ id: "dom" }] }),
  };
  const r = await mergeAdapters(primary, fallback).fetchReplies("h", {});
  assert.equal(r.replies[0].id, "api");
});
