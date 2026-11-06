// Endpoint configuration (Proxy URL / BYOK endpoint + API key) stays
// hidden until the AI data notice is accepted, and only in the matching
// mode. This suite parses the real page markup so the gate cannot drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { updateModeUI } from "../../src/options/index.js";

const html = readFileSync(
  new URL("../../src/options/index.html", import.meta.url),
  "utf8",
);

function page() {
  return new JSDOM(html).window.document;
}

function consent(doc, accepted) {
  doc.getElementById("consentAccepted").checked = accepted;
}

test("proxy: fields hidden until the notice is accepted", () => {
  const doc = page();
  updateModeUI(doc, "proxy");
  const fields = doc.getElementById("proxy-fields");
  assert.equal(fields.hidden, true);
  consent(doc, true);
  updateModeUI(doc, "proxy");
  assert.equal(fields.hidden, false);
  consent(doc, false);
  updateModeUI(doc, "proxy");
  assert.equal(fields.hidden, true);
});

test("byok: fields hidden until the notice is accepted", () => {
  const doc = page();
  updateModeUI(doc, "byok");
  const fields = doc.getElementById("byok-fields");
  assert.equal(fields.hidden, true);
  consent(doc, true);
  updateModeUI(doc, "byok");
  assert.equal(fields.hidden, false);
});

test("heuristic mode never shows endpoint fields, even with consent", () => {
  const doc = page();
  consent(doc, true);
  updateModeUI(doc, "heuristic");
  assert.equal(doc.getElementById("proxy-fields").hidden, true);
  assert.equal(doc.getElementById("byok-fields").hidden, true);
});

test("proxy consent does not unhide the byok fields and vice versa", () => {
  const doc = page();
  consent(doc, true);
  updateModeUI(doc, "proxy");
  assert.equal(doc.getElementById("byok-fields").hidden, true);
  updateModeUI(doc, "byok");
  assert.equal(doc.getElementById("proxy-fields").hidden, true);
});
