import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_MSG_TYPES,
  escapeHtml,
  HANDLE_RE,
  isTrustedRagebaitMessage,
  parseScoreRequest,
} from "../../src/shared/security.js";

const ORIGIN = "https://x.com";
const TOKEN = "tok-abc-123";

/** Build a window `message` event shape. */
function msgEvent(data, origin = ORIGIN) {
  return { origin, data };
}

// --- isTrustedRagebaitMessage ------------------------------------------------

test("isTrustedRagebaitMessage: accepts a well-formed request from the right origin", () => {
  const event = msgEvent({
    type: "rb:score-request",
    handle: "yoksiktir",
    token: TOKEN,
  });
  assert.equal(isTrustedRagebaitMessage(event, ORIGIN, TOKEN), true);
});

test("isTrustedRagebaitMessage: rejects a session-origin mismatch", () => {
  const event = msgEvent({
    type: "rb:score-request",
    handle: "yoksiktir",
    token: TOKEN,
  }, "https://evil.example");
  assert.equal(isTrustedRagebaitMessage(event, ORIGIN, TOKEN), false);
});

test("isTrustedRagebaitMessage: rejects an unknown message type", () => {
  const event = msgEvent({
    type: "rb:totally-unknown",
    handle: "yooksiktir",
    token: TOKEN,
  });
  assert.equal(isTrustedRagebaitMessage(event, ORIGIN, TOKEN), false);
});

test("isTrustedRagebaitMessage: rejects a token mismatch", () => {
  const event = msgEvent({
    type: "rb:score-request",
    handle: "yooksiktir",
    token: "wrong-token",
  });
  assert.equal(isTrustedRagebaitMessage(event, ORIGIN, TOKEN), false);
});

test("isTrustedRagebaitMessage: rejects a message carrying a top-level result field", () => {
  const event = msgEvent({
    type: "rb:score-request",
    handle: "yooksiktir",
    token: TOKEN,
    result: "high",
  });
  assert.equal(isTrustedRagebaitMessage(event, ORIGIN, TOKEN), false);
});

test("isTrustedRagebaitMessage: rejects a message carrying a band field", () => {
  const event = msgEvent({
    type: "rb:score-request",
    handle: "yooksiktir",
    token: TOKEN,
    band: "high",
  });
  assert.equal(isTrustedRagebaitMessage(event, ORIGIN, TOKEN), false);
});

test("isTrustedRagebaitMessage: rejects a message carrying a percent field", () => {
  const event = msgEvent({
    type: "rb:score-request",
    handle: "yooksiktir",
    token: TOKEN,
    percent: 87,
  });
  assert.equal(isTrustedRagebaitMessage(event, ORIGIN, TOKEN), false);
});

test("isTrustedRagebaitMessage: rejects a score field nested inside the payload", () => {
  const event = msgEvent({
    type: "rb:score-request",
    handle: "yooksiktir",
    token: TOKEN,
    payload: { nested: { band: "high" } },
  });
  assert.equal(isTrustedRagebaitMessage(event, ORIGIN, TOKEN), false);
});

test("isTrustedRagebaitMessage: rejects a non-object payload", () => {
  assert.equal(
    isTrustedRagebaitMessage(msgEvent("rb:score-request"), ORIGIN, TOKEN),
    false,
  );
  assert.equal(isTrustedRagebaitMessage(msgEvent(null), ORIGIN, TOKEN), false);
});

// --- parseScoreRequest -------------------------------------------------------

test("parseScoreRequest: returns a lower-cased handle and the token", () => {
  const parsed = parseScoreRequest({
    type: "rb:score-request",
    handle: "Yooksiktir",
    token: TOKEN,
  });
  assert.deepEqual(parsed, { handle: "yooksiktir", token: TOKEN });
});

test("parseScoreRequest: returns null when type is missing", () => {
  assert.equal(parseScoreRequest({ handle: "yooksiktir", token: TOKEN }), null);
});

test("parseScoreRequest: returns null when type is not in the allowlist", () => {
  assert.equal(
    parseScoreRequest({
      type: "rb:unknown",
      handle: "yooksiktir",
      token: TOKEN,
    }),
    null,
  );
});

test("parseScoreRequest: returns null when the handle is not 1-15 chars", () => {
  assert.equal(
    parseScoreRequest({ type: "rb:score-request", handle: "", token: TOKEN }),
    null,
  );
  assert.equal(
    parseScoreRequest({
      type: "rb:score-request",
      handle: "x".repeat(16),
      token: TOKEN,
    }),
    null,
  );
});

test("parseScoreRequest: returns null when the handle contains a slash", () => {
  assert.equal(
    parseScoreRequest({
      type: "rb:score-request",
      handle: "yoksiktir/following",
      token: TOKEN,
    }),
    null,
  );
});

test("parseScoreRequest: returns null when the token is missing", () => {
  assert.equal(
    parseScoreRequest({ type: "rb:score-request", handle: "yooksiktir" }),
    null,
  );
});

test("parseScoreRequest: returns null for a non-object payload", () => {
  assert.equal(parseScoreRequest("yooksiktir"), null);
  assert.equal(parseScoreRequest(undefined), null);
});

// --- escapeHtml --------------------------------------------------------------

test("escapeHtml: escapes angle brackets", () => {
  assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
});

test("escapeHtml: escapes ampersands, quotes and apostrophes", () => {
  assert.equal(escapeHtml(`&"'`), "&amp;&quot;&#39;");
});

test("escapeHtml: leaves ordinary text untouched", () => {
  assert.equal(escapeHtml("yooksiktir"), "yooksiktir");
});

// --- HANDLE_RE ----------------------------------------------------------------

test("HANDLE_RE: accepts valid handles", () => {
  for (
    const h of ["a", "yoksiktir", "a_b", "ABC", "user_123", "x".repeat(15)]
  ) {
    assert.equal(HANDLE_RE.test(h), true, `expected accept: ${h}`);
  }
});

test("HANDLE_RE: rejects invalid handles", () => {
  for (
    const h of [
      "",
      "x".repeat(16),
      "a/following",
      "has space",
      "a-b",
      "@user",
      "ünïcode",
    ]
  ) {
    assert.equal(HANDLE_RE.test(h), false, `expected reject: ${h}`);
  }
});

// --- ALLOWED_MSG_TYPES --------------------------------------------------------

test("ALLOWED_MSG_TYPES: holds exactly the four bridge types", () => {
  assert.ok(ALLOWED_MSG_TYPES instanceof Set);
  assert.deepEqual(
    [...ALLOWED_MSG_TYPES].sort(),
    ["rb:config", "rb:score-cancel", "rb:score-refresh", "rb:score-request"],
  );
});

test("ALLOWED_MSG_TYPES: has no page-supplied-result type", () => {
  for (const t of ALLOWED_MSG_TYPES) {
    assert.doesNotMatch(t, /result|score-in|score-out/);
  }
});
