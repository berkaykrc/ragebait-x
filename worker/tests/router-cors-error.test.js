// /analyze error responses must carry the same CORS headers as successes.
// Bug (evidence, Fri Oct 30 2026): a 502 from the model-call path reached the
// extension WITHOUT Access-Control-Allow-Origin, so the browser blocked the
// read entirely and the client could only see "CORS blocked", never the
// error body ("ai_unavailable"). Successes were re-wrapped with CORS_HEADERS;
// the router passed analyze()'s raw Response through untouched.

import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

const VALID_STATE = {
  handle: "alice",
  features: { replyCount: 10, langSupported: true },
  replySample: ["hi"],
};

function makeRequest() {
  return new Request("https://api.test/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Install-Token": "tok-cors",
    },
    body: JSON.stringify({ state: VALID_STATE }),
  });
}

const FAILING_FETCH = () => Promise.reject(new Error("upstream down"));

test("router: /analyze non-200 (ai_unavailable) carries CORS headers", async () => {
  // No model env configured -> callClef/callJev both fail -> analyze 502.
  const res = await worker.fetch(makeRequest(), {}, FAILING_FETCH);

  assert.equal(res.status, 502);
  assert.equal(
    res.headers.get("Access-Control-Allow-Origin"),
    "*",
    "error responses must be readable by the browser like successes",
  );
  const body = await res.json();
  assert.equal(body.error, "ai_unavailable");
});

test("router: /analyze 400 (invalid state) carries CORS headers", async () => {
  const req = new Request("https://api.test/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Install-Token": "tok-cors",
    },
    body: JSON.stringify({ state: { handle: "" } }),
  });
  const res = await worker.fetch(req, {}, FAILING_FETCH);

  assert.equal(res.status, 400);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
});
