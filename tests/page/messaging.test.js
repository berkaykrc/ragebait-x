// Page-world messaging tests (Task 7).
//
// src/page/messaging.js is the page-world half of the bridge (Task 2's
// src/shared/messaging.js is the extension-world half). The tests pin:
//   - what the page emits (score-request / refresh / cancel, token-gated),
//   - that it can never emit a score-bearing payload (structural rule 1),
//   - that the page-world type literals stay equal to the canonical
//     constants in the extension world,
//   - the extension-world gate's behaviour where the two halves compose
//     (unknown type ignored without runtime.sendMessage, hostile payloads
//     rejected outright, unknown-handle results ignored).
//   - the hovercard wiring: open -> sendScoreRequest, click -> refresh +
//     loading, card removal -> AbortController.abort() + exactly one
//     rb:score-cancel (plan Review Focus #2).

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import {
  carriesScoreField,
  createPageMessaging,
  PAGE_SCORE_RESPONSE_TYPE,
  SCORE_CANCEL_TYPE,
  SCORE_REFRESH_TYPE,
  SCORE_REQUEST_TYPE,
} from "../../src/page/messaging.js";
import { createBridge } from "../../src/shared/messaging.js";
import { ALLOWED_MSG_TYPES } from "../../src/shared/security.js";
import { SCORE_RESPONSE_TYPE } from "../../src/shared/messaging.js";
import { applyState } from "../../src/page/render.js";
import {
  createHovercardObserver,
  SELECTORS,
} from "../../src/page/hovercard.js";
import { bootPage } from "../../src/page/index.js";

const ORIGIN = "https://x.com";
const TOKEN = "tok-abc-123";

function makeDoc(bodyHtml) {
  return new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    url: ORIGIN,
  }).window.document;
}

/** Flush jsdom's MutationObserver microtask queue. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A hovercard for `handle` with the CP4T nesting the observer expects. */
function cardHtml(handle) {
  return `
    <div data-testid="HoverCard">
      <div>
        <div data-testid="UserAvatar-Container"><div></div></div>
        <div>
          <div>
            <div><a href="/${handle}/following">${handle}</a></div>
          </div>
        </div>
      </div>
    </div>`.trim();
}

/** A fake window hosting the page bridge's listeners and outgoing posts. */
function makeFakeWin() {
  const posted = [];
  const listeners = [];
  const win = {
    location: { origin: ORIGIN },
    postMessage: (data, origin) => posted.push({ data, origin }),
    addEventListener: (_type, fn) => listeners.push(fn),
    removeEventListener: (_type, fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  return {
    win,
    posted,
    listeners,
    dispatch: (data, origin = ORIGIN) => {
      for (const fn of [...listeners]) fn({ origin, data });
    },
  };
}

/** Send spies, so tests assert on the messages without a real window. */
function makeMessagingSpies() {
  const requests = [];
  const refreshes = [];
  const cancels = [];
  return {
    requests,
    refreshes,
    cancels,
    messaging: {
      sendScoreRequest: (handle) => requests.push(handle),
      sendRefresh: (handle) => refreshes.push(handle),
      sendCancel: (handle) => cancels.push(handle),
    },
  };
}

/**
 * The two bridge halves on ONE fake window: the page bridge posts into
 * `posted`, the extension-world bridge listens for those window messages and
 * forwards to `sent` (its fake runtime.sendMessage).
 */
function makeRelay() {
  const w = makeFakeWin();
  const sent = [];
  const browserApi = {
    runtime: {
      sendMessage: (msg) => {
        sent.push(msg);
        return Promise.resolve();
      },
      onMessage: {
        addListener: () => {},
        removeListener: () => {},
      },
    },
  };
  createBridge({
    win: w.win,
    browserApi,
    getOrigin: () => ORIGIN,
    getToken: () => TOKEN,
  });
  const messaging = createPageMessaging({
    win: w.win,
    getToken: () => TOKEN,
    getOrigin: () => ORIGIN,
  });
  return { ...w, sent, messaging };
}

// --- the page-world send half -------------------------------------------------

test("messaging: sendScoreRequest emits the request triple through postMessage", () => {
  const { win, posted } = makeFakeWin();
  const messaging = createPageMessaging({
    win,
    getToken: () => TOKEN,
    getOrigin: () => ORIGIN,
  });

  // Mixed case on purpose: normalisation is the extension gate's job, the
  // page world forwards the handle it read.
  messaging.sendScoreRequest("Jack");

  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].data, {
    type: "rb:score-request",
    handle: "Jack",
    token: TOKEN,
  });
  assert.equal(posted[0].origin, ORIGIN);
});

test("messaging: sendRefresh emits rb:score-refresh", () => {
  const { win, posted } = makeFakeWin();
  const messaging = createPageMessaging({
    win,
    getToken: () => TOKEN,
    getOrigin: () => ORIGIN,
  });

  messaging.sendRefresh("jack");

  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].data, {
    type: "rb:score-refresh",
    handle: "jack",
    token: TOKEN,
  });
});

test("messaging: sendCancel emits rb:score-cancel", () => {
  const { win, posted } = makeFakeWin();
  const messaging = createPageMessaging({
    win,
    getToken: () => TOKEN,
    getOrigin: () => ORIGIN,
  });

  messaging.sendCancel("jack");

  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].data, {
    type: "rb:score-cancel",
    handle: "jack",
    token: TOKEN,
  });
});

test("messaging: nothing is emitted without a token", () => {
  const { win, posted } = makeFakeWin();
  const messaging = createPageMessaging({
    win,
    getToken: () => null,
    getOrigin: () => ORIGIN,
  });

  messaging.sendScoreRequest("jack");
  messaging.sendRefresh("jack");
  messaging.sendCancel("jack");

  assert.equal(posted.length, 0);
});

test("messaging: a non-string or empty handle is never emitted", () => {
  const { win, posted } = makeFakeWin();
  const messaging = createPageMessaging({
    win,
    getToken: () => TOKEN,
    getOrigin: () => ORIGIN,
  });

  messaging.sendScoreRequest("");
  messaging.sendScoreRequest(undefined);
  messaging.sendScoreRequest({ nested: "object" });

  assert.equal(posted.length, 0);
});

// --- the page may never supply a score (structural rule 1) --------------------

test("messaging: carriesScoreField flags result/band/percent at any depth", () => {
  assert.equal(carriesScoreField({ result: {} }), true);
  assert.equal(carriesScoreField({ band: "high" }), true);
  assert.equal(carriesScoreField({ percent: 12 }), true);
  assert.equal(
    carriesScoreField({ a: { b: { result: { band: "high" } } } }),
    true,
  );
  // The KEY is score-bearing, not the value.
  assert.equal(carriesScoreField({ a: { b: "band" } }), false);
  assert.equal(carriesScoreField({ handle: "jack", token: "t" }), false);
  assert.equal(carriesScoreField("high"), false);
  assert.equal(carriesScoreField(null), false);

  // Cycles must not hang the scan, with and without a hit.
  const cyc = {};
  cyc.self = cyc;
  assert.equal(carriesScoreField(cyc), false);
  const hit = { band: "high" };
  hit.self = hit;
  assert.equal(carriesScoreField(hit), true);
});

test("messaging: an emitted request survives the extension-world trust gate end to end", () => {
  const relay = makeRelay();

  relay.messaging.sendScoreRequest("Jack");
  assert.equal(relay.posted.length, 1);

  // The content script receives the page's postMessage as a window event.
  relay.dispatch(relay.posted[0].data);

  assert.equal(relay.sent.length, 1);
  assert.deepEqual(relay.sent[0], {
    type: "rb:score-request",
    // Lower-cased by the gate (parseScoreRequest), never by the page.
    handle: "jack",
    token: TOKEN,
  });
});

test("messaging: a payload carrying band/percent/result is rejected outright", () => {
  const relay = makeRelay();

  // Nested to try to slip past a top-level-only check.
  relay.dispatch({
    type: SCORE_REQUEST_TYPE,
    handle: "jack",
    token: TOKEN,
    meta: { deep: { result: { band: "high" } } },
  });
  relay.dispatch({
    type: SCORE_CANCEL_TYPE,
    token: TOKEN,
    requestId: "r-1",
    band: "high",
  });

  assert.equal(relay.sent.length, 0);
});

test("messaging: an unknown type is ignored without a runtime.sendMessage call", () => {
  const relay = makeRelay();
  const seen = [];
  relay.messaging.onScoreResult((m) => seen.push(m));

  relay.dispatch({ type: "rb:weird", token: TOKEN, handle: "jack" });

  // Neither half moves: the extension bridge never reaches runtime.sendMessage...
  assert.equal(relay.sent.length, 0);
  // ...and the page bridge never calls the result callback.
  assert.equal(seen.length, 0);
});

// --- the page-world receive half ----------------------------------------------

test("messaging: onScoreResult delivers score responses with a lower-cased handle", () => {
  const { win, dispatch, listeners } = makeFakeWin();
  const messaging = createPageMessaging({
    win,
    getToken: () => TOKEN,
    getOrigin: () => ORIGIN,
  });

  const seen = [];
  const off = messaging.onScoreResult((m) => seen.push(m));
  assert.equal(listeners.length, 1, "one window listener while subscribed");

  dispatch({
    type: PAGE_SCORE_RESPONSE_TYPE,
    handle: "Jack",
    result: { state: "result", band: "low", percent: 10 },
  });
  dispatch({ type: "rb:config", token: TOKEN, config: {} });
  dispatch({ data: null });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    handle: "jack",
    result: { state: "result", band: "low", percent: 10 },
  });

  off();
  assert.equal(listeners.length, 0, "unsubscribe removes the listener");

  dispatch({ type: PAGE_SCORE_RESPONSE_TYPE, handle: "jack", result: {} });
  assert.equal(seen.length, 1);
});

// --- literal parity with the extension world ----------------------------------

test("messaging: the page-world literals match the extension-world canonical constants", () => {
  assert.equal(SCORE_REQUEST_TYPE, "rb:score-request");
  assert.equal(SCORE_REFRESH_TYPE, "rb:score-refresh");
  assert.equal(SCORE_CANCEL_TYPE, "rb:score-cancel");
  assert.equal(PAGE_SCORE_RESPONSE_TYPE, SCORE_RESPONSE_TYPE);
  // The page's sendable types are exactly the request-flavoured members of
  // the extension world's allowlist.
  for (
    const type of [SCORE_REQUEST_TYPE, SCORE_REFRESH_TYPE, SCORE_CANCEL_TYPE]
  ) {
    assert.ok(ALLOWED_MSG_TYPES.has(type), `${type} must stay allowlisted`);
  }
});

// --- hovercard wiring: the live flow ------------------------------------------

test("messaging: opening a card sends exactly one score request for its handle", async () => {
  const doc = makeDoc(`<div id="layers"></div>`);
  const spies = makeMessagingSpies();
  const observer = createHovercardObserver({
    document: doc,
    consoleLike: { warn: () => {}, info: () => {} },
    waitForCard: (card, done) =>
      done(card.querySelector(SELECTORS.followingLink)),
    messaging: spies.messaging,
  });

  doc.querySelector("#layers").appendChild(doc.createElement("div"))
    .innerHTML = cardHtml("jack");
  await flush();

  assert.deepEqual(spies.requests, ["jack"]);
  assert.deepEqual(spies.cancels, []);
  observer.dispose();
});

test("messaging: clicking the line emits a refresh and resets it to loading", async () => {
  const doc = makeDoc(`<div id="layers"></div>`);
  const spies = makeMessagingSpies();
  const observer = createHovercardObserver({
    document: doc,
    consoleLike: { warn: () => {}, info: () => {} },
    waitForCard: (card, done) =>
      done(card.querySelector(SELECTORS.followingLink)),
    messaging: spies.messaging,
  });

  doc.querySelector("#layers").appendChild(doc.createElement("div"))
    .innerHTML = cardHtml("jack");
  await flush();

  const entry = observer.cards.get("jack");
  entry.line = applyState(entry.line, {
    state: "result",
    band: "high",
    percent: 87,
  });
  assert.match(entry.line.textContent, /RAGEBAIT: High/);

  entry.line.dispatchEvent(
    new doc.defaultView.MouseEvent("click", { bubbles: true }),
  );
  assert.deepEqual(spies.refreshes, ["jack"]);
  assert.match(entry.line.textContent, /analyzing/);

  // The click listener is delegated on the document, so it survives
  // applyState's replaceWith: clicking the NEW line refreshes again.
  entry.line.dispatchEvent(
    new doc.defaultView.MouseEvent("click", { bubbles: true }),
  );
  assert.equal(spies.refreshes.length, 2);

  // A click outside the line does nothing.
  doc.body.dispatchEvent(
    new doc.defaultView.MouseEvent("click", { bubbles: true }),
  );
  assert.equal(spies.refreshes.length, 2);

  observer.dispose();
});

test("messaging: closing the card aborts the request and emits exactly one rb:score-cancel", async () => {
  // Review Focus #2: the card closes before the analysis finishes -> the
  // in-flight request is aborted, the background dedupe entry is released,
  // and no quota is consumed.
  const doc = makeDoc(`<div id="layers"></div>`);
  const spies = makeMessagingSpies();
  const observer = createHovercardObserver({
    document: doc,
    consoleLike: { warn: () => {}, info: () => {} },
    waitForCard: (card, done) =>
      done(card.querySelector(SELECTORS.followingLink)),
    messaging: spies.messaging,
  });

  const wrapper = doc.createElement("div");
  doc.querySelector("#layers").appendChild(wrapper).innerHTML = cardHtml(
    "jack",
  );
  await flush();

  assert.deepEqual(spies.requests, ["jack"]);
  const entry = observer.cards.get("jack");
  assert.equal(entry.controller.signal.aborted, false);

  // The card leaves the DOM inside a removed ancestor ("removedNodes
  // covering the card").
  wrapper.remove();
  await flush();

  assert.deepEqual(spies.cancels, ["jack"]);
  assert.equal(entry.controller.signal.aborted, true);
  assert.equal(observer.cards.has("jack"), false);

  // Another removal batch must not emit a second cancel for the same card.
  doc.querySelector("#layers")?.firstElementChild?.remove();
  await flush();
  assert.equal(spies.cancels.length, 1);

  observer.dispose();
});

test("messaging: a card detached and re-attached in one turn is a move, not a close", async () => {
  const doc = makeDoc(`<div id="layers"></div>`);
  const spies = makeMessagingSpies();
  const observer = createHovercardObserver({
    document: doc,
    consoleLike: { warn: () => {}, info: () => {} },
    waitForCard: (card, done) =>
      done(card.querySelector(SELECTORS.followingLink)),
    messaging: spies.messaging,
  });

  const card = doc.createElement("div");
  card.innerHTML = cardHtml("jack");
  doc.querySelector("#layers").appendChild(card);
  await flush();

  card.remove();
  doc.querySelector("#layers").appendChild(card);
  await flush();

  // Still connected when the observer runs -> no cancel, entry kept.
  assert.deepEqual(spies.cancels, []);
  assert.equal(observer.cards.has("jack"), true);
  assert.equal(doc.querySelectorAll(".ragebait-line").length, 1);

  observer.dispose();
});

test("messaging: the default bridge sends the request when the config tag has a token", async () => {
  const doc = new JSDOM(
    `<!doctype html><html><head><script id="ragebait-config" type="application/json">{"token":"tok-1","config":{}}</` +
      `script></head><body><div id="layers"></div></body></html>`,
    { url: ORIGIN },
  ).window.document;
  const win = doc.defaultView;

  // Spy on the real window's postMessage (verified assignable in jsdom).
  const posted = [];
  win.postMessage = (data, origin) => posted.push({ data, origin });

  const observer = createHovercardObserver({
    document: doc,
    consoleLike: { warn: () => {}, info: () => {} },
    waitForCard: (card, done) =>
      done(card.querySelector(SELECTORS.followingLink)),
  });

  doc.querySelector("#layers").appendChild(doc.createElement("div"))
    .innerHTML = cardHtml("jack");
  await flush();

  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].data, {
    type: "rb:score-request",
    handle: "jack",
    token: "tok-1",
  });
  assert.equal(posted[0].origin, ORIGIN);

  observer.dispose();
});

// --- routing (composition with index.js, unmodified) ---------------------------

test("messaging: a result for an unknown handle never touches the open lines", async () => {
  const doc = makeDoc(`<div id="layers"></div>`);
  const win = doc.defaultView;

  bootPage({
    document: doc,
    win,
    consoleLike: { warn: () => {}, info: () => {} },
    waitForCard: (card, done) =>
      done(card.querySelector(SELECTORS.followingLink)),
  });

  const layers = doc.querySelector("#layers");
  layers.appendChild(doc.createElement("div")).innerHTML = cardHtml(
    "jack",
  );
  layers.appendChild(doc.createElement("div")).innerHTML = cardHtml(
    "elonmusk",
  );
  await flush();

  const before = [...doc.querySelectorAll(".ragebait-line")].map((l) =>
    l.textContent
  );

  win.postMessage({
    type: SCORE_RESPONSE_TYPE,
    handle: "ghost",
    result: { state: "result", band: "high", percent: 88 },
  }, "*");
  await flush();

  assert.deepEqual(
    [...doc.querySelectorAll(".ragebait-line")].map((l) => l.textContent),
    before,
  );
});
