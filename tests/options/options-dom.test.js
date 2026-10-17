import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { before, beforeEach, describe, test } from "node:test";

// deno-lint-ignore no-import-assertions
const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Ragebait settings</title>
  </head>
  <body>
    <h1>Ragebait Detector settings</h1>

    <fieldset>
      <legend>Mode</legend>
      <label for="mode-heuristic"><input type="radio" name="mode" value="heuristic" id="mode-heuristic" checked> Heuristic (v1)</label>
      <label for="mode-proxy"><input type="radio" name="mode" value="proxy" id="mode-proxy"> Proxy (Phase 2)</label>
      <label for="mode-byok"><input type="radio" name="mode" value="byok" id="mode-byok"> Bring your own key (Phase 2)</label>
    </fieldset>

    <div id="mode-extra"></div>

    <div id="consent-ai" hidden>
      <label for="consentAccepted"><input type="checkbox" name="consentAccepted" id="consentAccepted"> I accept the data handling above</label>
    </div>

    <div id="proxy-fields" style="display:none">
      <label for="proxyUrl">Proxy URL</label>
      <input type="url" name="proxyUrl" id="proxyUrl">
    </div>

    <div id="byok-fields" style="display:none">
      <label for="byokEndpoint">BYOK endpoint</label>
      <input type="url" name="byokEndpoint" id="byokEndpoint">
      <label for="apiKey">API key</label>
      <input type="password" name="apiKey" id="apiKey">
    </div>

    <label for="misclassification-email">Misclassification report email</label>
    <input type="email" id="misclassification-email">

    <p>
      Profiles analysed today: <span id="quota-used">0</span> / <span id="quota-limit">200</span>
    </p>

    <p><a id="misclassification-mailto" href="#">Report a misclassification</a></p>

    <span id="status"></span>

    <button id="save-btn">Save</button>

    <script src="options.js"></script>
  </body>
</html>`;

describe("options DOM contract", () => {
  let doc;

  before(() => {
    // Mock browser as undefined to prevent auto-boot
    globalThis.browser = undefined;
    const dom = new JSDOM(html, { runScripts: "dangerously" });
    doc = dom.window.document;
  });

  beforeEach(() => {
    // Reset form state
    const radios = doc.querySelectorAll('input[name="mode"]');
    for (const r of radios) r.checked = false;
    const email = doc.getElementById("misclassification-email");
    if (email) email.value = "";
  });

  test("readForm reads mode from radios", async () => {
    const mod = await import("../../src/options/index.js", {
      assert: { type: "module" },
    });
    const settings = mod.readForm(doc);
    assert.equal(settings.mode, "heuristic");
  });

  test("readForm reads mode change from DOM", async () => {
    const mod = await import("../../src/options/index.js", {
      assert: { type: "module" },
    });
    const proxy = doc.querySelector('input[name="mode"][value="proxy"]');
    proxy.checked = true;
    const settings = mod.readForm(doc);
    assert.equal(settings.mode, "proxy");
  });

  test("readForm reads misclassificationEmail from email input", async () => {
    const mod = await import("../../src/options/index.js", {
      assert: { type: "module" },
    });
    const email = doc.getElementById("misclassification-email");
    email.value = "e@example.com";
    const settings = mod.readForm(doc);
    assert.equal(settings.misclassificationEmail, "e@example.com");
  });

  test("applySettings rounds trip", async () => {
    const mod = await import("../../src/options/index.js", {
      assert: { type: "module" },
    });
    mod.applySettings(doc, { mode: "byok", misclassificationEmail: "a@b.c" });
    assert.equal(
      doc.querySelector('input[name="mode"][value="byok"]').checked,
      true,
    );
    assert.equal(doc.querySelector("#misclassification-email").value, "a@b.c");
  });

  test("updateModeUI toggles visible/hidden/display", async () => {
    const mod = await import("../../src/options/index.js", {
      assert: { type: "module" },
    });
    mod.updateModeUI(doc, "heuristic");
    assert.equal(
      doc.getElementById("mode-extra").classList.contains("visible"),
      false,
    );
    assert.equal(doc.getElementById("consent-ai").hidden, true);

    mod.updateModeUI(doc, "byok");
    assert.equal(
      doc.getElementById("mode-extra").classList.contains("visible"),
      true,
    );
    assert.equal(doc.getElementById("consent-ai").hidden, false);
  });

  test("buildMailto returns raw address in label", async () => {
    const mod = await import("../../src/options/index.js", {
      assert: { type: "module" },
    });
    const { label } = mod.buildMailto("a&b@c.d");
    assert.equal(label, "Report by email (a&b@c.d)");
  });

  test("updateMailto applies raw address to link", async () => {
    const mod = await import("../../src/options/index.js", {
      assert: { type: "module" },
    });
    mod.updateMailto(doc, "a&b@c.d");
    const link = doc.getElementById("misclassification-mailto");
    assert.equal(link.textContent, "Report by email (a&b@c.d)");
    assert(link.href.includes("a&b@c.d"));
  });

  test("drift guard: all getElementById targets exist in HTML", async () => {
    const _mod = await import("../../src/options/index.js", {
      assert: { type: "module" },
    });
    const src = await import("fs").then((m) =>
      m.readFileSync("src/options/index.js", "utf8")
    );
    const ids = [...src.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) =>
      m[1]
    );
    for (const id of ids) {
      assert.ok(doc.getElementById(id), `options.html is missing #${id}`);
    }
  });

  test("drift guard: all input[name=…] targets exist in HTML", async () => {
    const _mod = await import("../../src/options/index.js", {
      assert: { type: "module" },
    });
    const src = await import("fs").then((m) =>
      m.readFileSync("src/options/index.js", "utf8")
    );
    const names = [
      ...new Set(
        [...src.matchAll(/input\[name="([^"]+)"\]/g)].map((m) => m[1]),
      ),
    ];
    for (const name of names) {
      assert.ok(
        doc.querySelector(`input[name="${name}"]`),
        `options.html is missing input[name="${name}"]`,
      );
    }
  });

  test("drift guard: every control is labelled", () => {
    for (const el of doc.querySelectorAll("input, select")) {
      assert.ok(
        el.id && doc.querySelector(`label[for="${el.id}"]`),
        `unlabelled control: ${el.name || el.id}`,
      );
    }
  });
});
