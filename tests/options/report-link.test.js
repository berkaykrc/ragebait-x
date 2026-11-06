// The options page shows a "Report a misclassification" link only when the
// build configures an issue tracker (src/config.js ISSUES_URL). Self-hosters
// set it to their own tracker — or to "", which hides the link entirely.
// This suite parses the real page markup so the hidden contract cannot drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { wireReportLink } from "../../src/options/index.js";

const html = readFileSync(
  new URL("../../src/options/index.html", import.meta.url),
  "utf8",
);

function page() {
  return new JSDOM(html).window.document;
}

test("report link stays hidden and untouched when no tracker is configured", () => {
  const doc = page();
  wireReportLink(doc, "");
  assert.equal(doc.getElementById("misclassification-report")?.hidden, true);
  wireReportLink(doc, undefined);
  assert.equal(doc.getElementById("misclassification-report")?.hidden, true);
});

test("report link is shown with the configured tracker URL", () => {
  const doc = page();
  wireReportLink(doc, "https://issues.self-hosted.test/tracker");
  const report = doc.getElementById("misclassification-report");
  assert.equal(report?.hidden, false);
  assert.equal(
    report?.querySelector("a")?.getAttribute("href"),
    "https://issues.self-hosted.test/tracker",
  );
});
