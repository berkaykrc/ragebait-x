// The background's score-response broadcast (runtime.sendMessage from the
// background) rejects with "Receiving end does not exist" when no tab has a
// content script listening (tab closed / navigated mid-flight). That rejection
// is expected noise: the response has already been delivered via sendResponse.
// Before the fix, the rejection surfaced as an unhandled promise rejection on
// every hover (bug report evidence at background.js broadcast site).

import { test } from "node:test";
import assert from "node:assert/strict";

import { createBackground } from "../../src/background/index.js";

function makeReplies(count = 8) {
  return Array.from({ length: count }, (_, i) => ({
    id: `r-${i}`,
    text: `Reply text number ${i}`,
    lang: "tr",
    targetScreenName: "target",
    parentStatusId: null,
    likes: 1,
    createdAt: 1000 + i,
  }));
}

const DEAD_TAB_BROWSER_API = {
  runtime: {
    // Tab with no content script: broadcast rejects immediately.
    sendMessage: () =>
      Promise.reject(
        new Error(
          "Could not establish connection. Receiving end does not exist.",
        ),
      ),
  },
};

test("bg: broadcast rejection on rb:score-request is not unhandled", async () => {
  const rejections = [];
  const collect = (err) => rejections.push(err);
  process.on("unhandledRejection", collect);
  try {
    const bg = createBackground({
      browserApi: DEAD_TAB_BROWSER_API,
      fetchReplies: () => Promise.resolve({ ok: true, replies: makeReplies() }),
      settings: { mode: "heuristic" },
      skipCache: true,
    });

    const res = await bg.handleMessage(
      { type: "rb:score-request", handle: "quiettabone" },
      {},
    );

    assert.equal(res.result.state, "result", "delivery must not be affected");

    // Let any stray rejection surface.
    await new Promise((resolve) => setImmediate(resolve));
    const dead = rejections.filter((e) =>
      e instanceof Error && e.message.includes("Receiving end does not exist")
    );
    assert.equal(
      dead.length,
      0,
      "broadcast rejection must be caught, not unhandled",
    );
  } finally {
    process.off("unhandledRejection", collect);
  }
});

test("bg: broadcast rejection on rb:score-refresh is not unhandled", async () => {
  const rejections = [];
  const collect = (err) => rejections.push(err);
  process.on("unhandledRejection", collect);
  try {
    const bg = createBackground({
      browserApi: DEAD_TAB_BROWSER_API,
      fetchReplies: () => Promise.resolve({ ok: true, replies: makeReplies() }),
      settings: { mode: "heuristic" },
      skipCache: true,
    });

    const res = await bg.handleMessage(
      { type: "rb:score-refresh", handle: "quiettabtwo" },
      {},
    );

    assert.equal(res.result.state, "result");

    await new Promise((resolve) => setImmediate(resolve));
    const dead = rejections.filter((e) =>
      e instanceof Error && e.message.includes("Receiving end does not exist")
    );
    assert.equal(dead.length, 0);
  } finally {
    process.off("unhandledRejection", collect);
  }
});
