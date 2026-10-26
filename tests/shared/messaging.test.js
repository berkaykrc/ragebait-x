import { test } from "node:test";
import assert from "node:assert/strict";

import { createBridge } from "../../src/shared/messaging.js";

const ORIGIN = "https://x.com";
const TOKEN = "tok-abc-123";

/** Minimal fakes for the two worlds the bridge sits between. */
function makeWorlds() {
  const listeners = { message: [], runtime: [] };
  const sent = [];
  const posted = [];

  // This fake only simulates the "message" channel, so the event type is not
  // dispatched on.
  const win = {
    addEventListener: (_type, fn) => listeners.message.push(fn),
    removeEventListener: (_type, fn) => {
      const i = listeners.message.indexOf(fn);
      if (i >= 0) listeners.message.splice(i, 1);
    },
    postMessage: (data, origin) => posted.push({ data, origin }),
  };

  const browserApi = {
    runtime: {
      sendMessage: (msg) => {
        sent.push(msg);
        return Promise.resolve();
      },
      onMessage: {
        addListener: (fn) => listeners.runtime.push(fn),
        removeListener: (fn) => {
          const i = listeners.runtime.indexOf(fn);
          if (i >= 0) listeners.runtime.splice(i, 1);
        },
      },
    },
  };

  return { win, browserApi, listeners, sent, posted };
}

function setup() {
  const w = makeWorlds();
  const bridge = createBridge({
    win: w.win,
    browserApi: w.browserApi,
    getOrigin: () => ORIGIN,
    getToken: () => TOKEN,
  });
  return { ...w, bridge };
}

const pageMsg = (data, origin = ORIGIN) => ({ origin, data });

// --- page -> background ------------------------------------------------------

test("bridge: forwards a valid score request to the background", () => {
  const { listeners, sent } = setup();
  listeners.message[0](
    pageMsg({ type: "rb:score-request", handle: "Yooksiktir", token: TOKEN }),
  );

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: "rb:score-request",
    handle: "yooksiktir",
    token: TOKEN,
  });
});

test("bridge: drops a message from a foreign origin", () => {
  const { listeners, sent } = setup();
  listeners.message[0](
    pageMsg(
      { type: "rb:score-request", handle: "yoksiktir", token: TOKEN },
      "https://evil.example",
    ),
  );
  assert.equal(sent.length, 0);
});

test("bridge: drops a message with a token mismatch", () => {
  const { listeners, sent } = setup();
  listeners.message[0](
    pageMsg({ type: "rb:score-request", handle: "yoksiktir", token: "wrong" }),
  );
  assert.equal(sent.length, 0);
});

test("bridge: drops a message carrying a score-bearing field", () => {
  const { listeners, sent } = setup();
  listeners.message[0](
    pageMsg({
      type: "rb:score-request",
      handle: "yoksiktir",
      token: TOKEN,
      band: "high",
    }),
  );
  assert.equal(sent.length, 0);
});

test("bridge: drops a request whose handle fails the regex", () => {
  const { listeners, sent } = setup();
  listeners.message[0](
    pageMsg({ type: "rb:score-request", handle: "a/b", token: TOKEN }),
  );
  assert.equal(sent.length, 0);
});

test("bridge: forwards cancel without a handle round-trip", () => {
  const { listeners, sent } = setup();
  listeners.message[0](
    pageMsg({ type: "rb:score-cancel", token: TOKEN, requestId: "r-1" }),
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "rb:score-cancel");
  assert.equal(sent[0].token, TOKEN);
  assert.equal(sent[0].requestId, "r-1");
  assert.equal("handle" in sent[0], false);
});

test("bridge: forwards refresh without a handle round-trip", () => {
  const { listeners, sent } = setup();
  listeners.message[0](
    pageMsg({ type: "rb:score-refresh", token: TOKEN, requestId: "r-1" }),
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "rb:score-refresh");
  assert.equal("handle" in sent[0], false);
});

// --- background -> page (push path) -----------------------------------------

test("bridge: posts a background score response back to the page with the token echoed", () => {
  const { listeners, posted } = setup();
  listeners.runtime[0](
    {
      type: "rb:score-response",
      requestId: "r-1",
      result: { state: "result", band: "high" },
    },
  );

  assert.equal(posted.length, 1);
  assert.equal(posted[0].origin, ORIGIN);
  assert.equal(posted[0].data.token, TOKEN);
  assert.deepEqual(posted[0].data.result, { state: "result", band: "high" });
});

test("bridge: does not post a background message that is not a score response", () => {
  const { listeners, posted } = setup();
  listeners.runtime[0]({ type: "rb:something-else" });
  assert.equal(posted.length, 0);
});

// --- background -> page (await-Promise path) ---------------------------------

test("bridge: posts the score response resolved from the sendMessage Promise", async () => {
  // The real browser resolves runtime.sendMessage with the value returned
  // by the background's onMessage handler.  The push-path (runtime.onMessage)
  // is the fallback; the primary path is the Promise resolution here.
  const w = makeWorlds();
  const scoreResponse = {
    type: "rb:score-response",
    requestId: "r-2",
    handle: "yooksiktir",
    result: { state: "result", band: "medium" },
  };
  // Override sendMessage to resolve with the background's return value.
  w.browserApi.runtime.sendMessage = (msg) => {
    w.sent.push(msg);
    return Promise.resolve(scoreResponse);
  };
  createBridge({
    win: w.win,
    browserApi: w.browserApi,
    getOrigin: () => ORIGIN,
    getToken: () => TOKEN,
  });

  w.listeners.message[0](
    pageMsg({ type: "rb:score-request", handle: "Yooksiktir", token: TOKEN }),
  );

  // Let the micro-task queue drain so the .then() fires.
  await Promise.resolve();

  assert.equal(w.posted.length, 1, "expected exactly one postMessage");
  assert.equal(w.posted[0].origin, ORIGIN);
  assert.equal(w.posted[0].data.token, TOKEN);
  assert.deepEqual(w.posted[0].data.result, {
    state: "result",
    band: "medium",
  });
});

test("bridge: does not throw when the background is unavailable (Promise rejects)", async () => {
  const w = makeWorlds();
  w.browserApi.runtime.sendMessage = () =>
    Promise.reject(new Error("no matching listener"));
  createBridge({
    win: w.win,
    browserApi: w.browserApi,
    getOrigin: () => ORIGIN,
    getToken: () => TOKEN,
  });

  w.listeners.message[0](
    pageMsg({ type: "rb:score-request", handle: "Yooksiktir", token: TOKEN }),
  );

  // Rejection must be swallowed; no unhandled rejection, no postMessage.
  await Promise.resolve();
  assert.equal(w.posted.length, 0);
});

// --- lifecycle ---------------------------------------------------------------

test("bridge: dispose removes both the window and runtime listeners", () => {
  const { listeners, bridge } = setup();
  assert.equal(listeners.message.length, 1);
  assert.equal(listeners.runtime.length, 1);

  bridge.dispose();

  assert.equal(listeners.message.length, 0);
  assert.equal(listeners.runtime.length, 0);
});
