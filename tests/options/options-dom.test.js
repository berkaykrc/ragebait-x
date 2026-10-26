import assert from "node:assert/strict";
import { before, beforeEach, describe, test } from "node:test";
import { JSDOM } from "jsdom";

// deno-lint-ignore no-import-assertions

describe("options DOM contract", () => {
  let doc;

  before(async () => {
    // Mock browser as undefined to prevent auto-boot
    globalThis.browser = undefined;
    const fs = await import("fs");
    const html = fs.readFileSync("src/options/index.html", "utf8");
    const dom = new JSDOM(html);
    doc = dom.window.document;
  });

  beforeEach(() => {
    // Reset email value only; leave radio defaults intact
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
    assert.equal(doc.getElementById("mode-extra").hidden, true);
    assert.equal(doc.getElementById("consent-ai").hidden, true);

    mod.updateModeUI(doc, "byok");
    assert.equal(
      doc.getElementById("mode-extra").classList.contains("visible"),
      true,
    );
    assert.equal(doc.getElementById("mode-extra").hidden, false);
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
