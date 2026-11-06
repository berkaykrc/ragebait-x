// The options page must always show which route produced the band:
// AI on (proxy/BYOK) or heuristic fallback while consent is missing.
// The AI card also carries one notice paragraph per mode; only the
// active mode's paragraph is visible. This suite parses the real page
// markup so the contract cannot drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import {
  DEFAULT_PROXY_URL,
  renderAiStatus,
  updateModeUI,
} from "../../src/options/index.js";

const html = readFileSync(
  new URL("../../src/options/index.html", import.meta.url),
  "utf8",
);

function page() {
  return new JSDOM(html).window.document;
}

function selectMode(doc, mode) {
  const radio = doc.querySelector(`input[name="mode"][value="${mode}"]`);
  radio.checked = true;
}

test("proxy + consent off shows heuristic fallback", () => {
  const doc = page();
  selectMode(doc, "proxy");
  renderAiStatus(doc);
  const status = doc.getElementById("ai-mode-status");
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /OFF/);
  assert.match(status.textContent, /heuristic/);
  assert.ok(status.classList.contains("rb-ai-status--off"));
});

test("proxy + consent on shows the configured host", () => {
  const doc = page();
  selectMode(doc, "proxy");
  doc.querySelector('input[name="proxyUrl"]').value =
    "https://proxy.example.com/analyze";
  doc.getElementById("consentAccepted").checked = true;
  renderAiStatus(doc);
  const status = doc.getElementById("ai-mode-status");
  assert.match(status.textContent, /ON/);
  assert.match(status.textContent, /proxy\.example\.com/);
  assert.ok(status.classList.contains("rb-ai-status--on"));
});

test("proxy + consent on + empty input falls back to the default endpoint host", () => {
  const doc = page();
  selectMode(doc, "proxy");
  doc.getElementById("consentAccepted").checked = true;
  renderAiStatus(doc);
  const status = doc.getElementById("ai-mode-status");
  const host = new URL(DEFAULT_PROXY_URL).host;
  assert.match(status.textContent, new RegExp(host.replaceAll(".", "\\.")));
});

test("byok + consent on + empty endpoint reports unavailable", () => {
  const doc = page();
  selectMode(doc, "byok");
  doc.getElementById("consentAccepted").checked = true;
  renderAiStatus(doc);
  const status = doc.getElementById("ai-mode-status");
  assert.match(status.textContent, /unavailable/);
  assert.ok(status.classList.contains("rb-ai-status--off"));
});

test("byok + consent on + endpoint set shows that endpoint's host", () => {
  const doc = page();
  selectMode(doc, "byok");
  doc.querySelector('input[name="byokEndpoint"]').value =
    "https://ai.my-host.example/v1";
  doc.getElementById("consentAccepted").checked = true;
  renderAiStatus(doc);
  const status = doc.getElementById("ai-mode-status");
  assert.match(status.textContent, /ON/);
  assert.match(status.textContent, /ai\.my-host\.example/);
});

test("heuristic mode hides the status line", () => {
  const doc = page();
  selectMode(doc, "heuristic");
  renderAiStatus(doc);
  assert.equal(doc.getElementById("ai-mode-status").hidden, true);
});

test("updateModeUI shows only the active mode's notice and quota in proxy", () => {
  const doc = page();
  updateModeUI(doc, "proxy");
  const proxyNote = doc.querySelector('[data-mode-note="proxy"]');
  const byokNote = doc.querySelector('[data-mode-note="byok"]');
  assert.equal(proxyNote.hidden, false);
  assert.equal(byokNote.hidden, true);
  assert.equal(doc.getElementById("quota-card").hidden, false);
  updateModeUI(doc, "byok");
  assert.equal(proxyNote.hidden, true);
  assert.equal(byokNote.hidden, false);
  assert.equal(doc.getElementById("quota-card").hidden, true);
  updateModeUI(doc, "heuristic");
  assert.equal(proxyNote.hidden, true);
  assert.equal(byokNote.hidden, true);
  assert.equal(doc.getElementById("consent-ai").hidden, true);
});
