import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import { createConfigReader, CONFIG_TAG_ID } from "../../src/page/inject-config.js";

const ORIGIN = "https://x.com";

function docWithTag(html) {
  return new JSDOM(html, { url: ORIGIN }).window.document;
}

test("inject-config: reads the token and config out of the injected tag", () => {
  const doc = docWithTag(
    `<script id="ragebait-config" type="application/json">{"token":"t-1","config":{"showNumber":true}}</script>`,
  );
  const reader = createConfigReader(doc);
  assert.equal(reader.getToken(), "t-1");
  assert.deepEqual(reader.getConfig(), { showNumber: true });
});

test("inject-config: exposes the tag id the content script injects", () => {
  assert.equal(CONFIG_TAG_ID, "ragebait-config");
});

test("inject-config: a missing tag yields a null token and empty config", () => {
  const reader = createConfigReader(docWithTag("<!doctype html><html><body></body></html>"));
  assert.equal(reader.getToken(), null);
  assert.deepEqual(reader.getConfig(), {});
});

test("inject-config: an unparseable tag yields a null token and empty config", () => {
  const doc = docWithTag(
    `<script id="ragebait-config" type="application/json">{not json</script>`,
  );
  const reader = createConfigReader(doc);
  assert.equal(reader.getToken(), null);
  assert.deepEqual(reader.getConfig(), {});
});

test("inject-config: a tag with a non-string token yields a null token", () => {
  const doc = docWithTag(
    `<script id="ragebait-config" type="application/json">{"token":{"a":1},"config":{}}</script>`,
  );
  assert.equal(createConfigReader(doc).getToken(), null);
});

test("inject-config: a non-object config is replaced with an empty object", () => {
  const doc = docWithTag(
    `<script id="ragebait-config" type="application/json">{"token":"t-1","config":"nope"}</script>`,
  );
  const reader = createConfigReader(doc);
  assert.equal(reader.getToken(), "t-1");
  assert.deepEqual(reader.getConfig(), {});
});

test("inject-config: parses the tag once, not on every call", () => {
  const doc = docWithTag(
    `<script id="ragebait-config" type="application/json">{"token":"t-1","config":{}}</script>`,
  );
  const tag = doc.getElementById("ragebait-config");
  let reads = 0;
  Object.defineProperty(tag, "textContent", {
    get() {
      reads += 1;
      return '{"token":"t-1","config":{}}';
    },
  });

  const reader = createConfigReader(doc);
  reader.getToken();
  reader.getToken();
  reader.getConfig();
  assert.equal(reads, 1);
});

test("inject-config: canIssueRequest is false without a token", () => {
  const reader = createConfigReader(docWithTag("<!doctype html><html><body></body></html>"));
  assert.equal(reader.canIssueRequest(), false);
});

test("inject-config: canIssueRequest is true with a token", () => {
  const doc = docWithTag(
    `<script id="ragebait-config" type="application/json">{"token":"t-1","config":{}}</script>`,
  );
  assert.equal(createConfigReader(doc).canIssueRequest(), true);
});