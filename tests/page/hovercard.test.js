import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import {
  createHovercardObserver,
  extractScreenName,
  PAGE_SCORE_RESPONSE_TYPE,
  SELECTORS,
} from "../../src/page/hovercard.js";
import { bootPage } from "../../src/page/index.js";
import { SCORE_RESPONSE_TYPE } from "../../src/shared/messaging.js";

const ORIGIN = "https://x.com";

function makeDoc(bodyHtml) {
  return new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    url: ORIGIN,
  }).window.document;
}

/** Flush jsdom's MutationObserver microtask queue. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A hovercard with enough nesting that the following anchor has three parents
 * (the CP4T insertion point is the 3rd parent, afterend).
 */
const CARD_HTML = `
  <div>
    <div>
      <div data-testid="UserAvatar-Container"><div></div></div>
      <div>
        <div>
          <div><a href="/yoksiktir/following">yoksiktir</a></div>
        </div>
      </div>
    </div>
  </div>`.trim();

function cardHtml(inner = CARD_HTML) {
  return `<div data-testid="HoverCard">${inner}</div>`;
}

/** Capture console.warn calls without printing them. */
function warnCollector() {
  const warns = [];
  return { warns, warn: (...args) => warns.push(args) };
}

// --- extractScreenName --------------------------------------------------------

test("hovercard: extractScreenName reads the handle out of the path", () => {
  assert.equal(extractScreenName("/yoksiktir/following"), "yoksiktir");
});

test("hovercard: extractScreenName rejects a path with no handle", () => {
  assert.equal(extractScreenName("/following"), null);
});

test("hovercard: extractScreenName returns null for a non-string", () => {
  assert.equal(extractScreenName(null), null);
  assert.equal(extractScreenName(undefined), null);
});

test("hovercard: extractScreenName rejects a multi-segment path", () => {
  assert.equal(extractScreenName("/a/b/following"), null);
});

test("hovercard: extractScreenName preserves case (normalisation is the gate's job)", () => {
  assert.equal(extractScreenName("/Yoksiktir/following"), "Yoksiktir");
});

// --- SELECTORS ----------------------------------------------------------------

test("hovercard: SELECTORS holds exactly the four documented keys", () => {
  assert.deepEqual(Object.keys(SELECTORS).sort(), [
    "avatarContainer",
    "followingLink",
    "hoverCard",
    "layers",
  ]);
  for (const value of Object.values(SELECTORS)) {
    assert.equal(typeof value, "string");
    assert.ok(value.length > 0);
  }
});

// --- selector miss ------------------------------------------------------------

test("hovercard: a missing layers root warns once and never breaks", () => {
  const doc = makeDoc("<main></main>");
  const { warns, warn } = warnCollector();

  const observer = createHovercardObserver({
    document: doc,
    consoleLike: { warn },
  });
  assert.equal(warns.length, 1);
  assert.doesNotThrow(() => observer.dispose());
});

test("hovercard: the observer wakes up when #layers mounts after boot", async () => {
  // Production timing: page.js is injected at document_start, but X mounts
  // #layers much later. The observer must wait for the root instead of
  // permanently giving up ("not watching" is only for a crippling case).
  const doc = makeDoc("<main></main>");
  const { warns, warn } = warnCollector();

  const observer = createHovercardObserver({
    document: doc,
    consoleLike: { warn },
  });
  assert.equal(warns.length, 1); // one boot note, no more later
  assert.equal(observer.cards.size, 0);

  // The react root mounts, then a card is hovered.
  const layers = doc.createElement("div");
  layers.id = "layers";
  doc.body.appendChild(layers);
  layers.appendChild(doc.createElement("div")).innerHTML = cardHtml();
  await flush();

  assert.equal(observer.cards.size, 1, "expected the card to be picked up");
  const line = doc.querySelector(".ragebait-line");
  assert.ok(line, "expected the analyzing line to render");
  assert.equal(warns.length, 1, "recovery must not warn again");
  assert.doesNotThrow(() => observer.dispose());
});

// --- card open ----------------------------------------------------------------

test("hovercard: an opening card renders the analyzing line at the CP4T point", async () => {
  const doc = makeDoc(`<div id="layers"></div>`);
  const layers = doc.querySelector("#layers");
  const { warns, warn } = warnCollector();

  const observer = createHovercardObserver({
    document: doc,
    consoleLike: { warn },
    // Immediate stand-in for the rAF avatar poll: hand back the link.
    waitForCard: (card, done) =>
      done(card.querySelector(SELECTORS.followingLink)),
  });

  layers.appendChild(doc.createElement("div")).innerHTML = cardHtml();
  await flush();

  const anchor = doc.querySelector(SELECTORS.followingLink);
  const insertionPoint = anchor.parentElement.parentElement.parentElement;
  const line = insertionPoint.nextElementSibling;
  assert.ok(line, "no line was inserted after the 3rd parent");
  assert.match(line.className, /ragebait-line/);
  assert.match(line.textContent, /analyzing/);
  assert.equal(line.getAttribute("data-ragebait-handle"), "yoksiktir");
  assert.equal(warns.length, 0);

  observer.dispose();
});

test("hovercard: a card without the following link warns once and renders nothing", async () => {
  const doc = makeDoc(`<div id="layers"></div>`);
  const layers = doc.querySelector("#layers");
  const { warns, warn } = warnCollector();

  const observer = createHovercardObserver({
    document: doc,
    consoleLike: { warn },
    waitForCard: (card, done) =>
      done(card.querySelector(SELECTORS.followingLink)),
  });

  layers.appendChild(doc.createElement("div")).innerHTML = cardHtml(
    "<div><div><div>no link here</div></div></div>",
  );
  await flush();

  assert.equal(doc.querySelectorAll(".ragebait-line").length, 0);
  assert.equal(warns.length, 1);

  observer.dispose();
});

test("hovercard: re-adding the same card does not render twice", async () => {
  const doc = makeDoc(`<div id="layers"></div>`);
  const layers = doc.querySelector("#layers");
  const { warns, warn } = warnCollector();

  const observer = createHovercardObserver({
    document: doc,
    consoleLike: { warn },
    waitForCard: (card, done) =>
      done(card.querySelector(SELECTORS.followingLink)),
  });

  const card = doc.createElement("div");
  card.innerHTML = cardHtml();
  layers.appendChild(card);
  await flush();

  // X can detach and re-attach the same card node; the childList observer
  // fires again, and the seen-guard must stop a second line.
  layers.removeChild(card);
  layers.appendChild(card);
  await flush();

  assert.equal(doc.querySelectorAll(".ragebait-line").length, 1);
  assert.equal(warns.length, 0);

  observer.dispose();
});

test("hovercard: an avatar-wait timeout is a silent no-op", async () => {
  const doc = makeDoc(`<div id="layers"></div>`);
  const layers = doc.querySelector("#layers");
  const { warns, warn } = warnCollector();

  const observer = createHovercardObserver({
    document: doc,
    consoleLike: { warn },
    waitForCard: (_card, _done, onTimeout) => onTimeout(),
  });

  layers.appendChild(doc.createElement("div")).innerHTML = cardHtml();
  await flush();

  assert.equal(doc.querySelectorAll(".ragebait-line").length, 0);
  assert.equal(warns.length, 0);

  observer.dispose();
});

test("hovercard: the default avatar wait renders without any injection", async () => {
  // The production path: no waitForCard stub, real requestAnimationFrame.
  const doc = new JSDOM(
    `<!doctype html><html><body><div id="layers"></div></body></html>`,
    { url: ORIGIN, pretendToBeVisual: true },
  ).window.document;
  const layers = doc.querySelector("#layers");
  const { warns, warn } = warnCollector();

  const observer = createHovercardObserver({
    document: doc,
    consoleLike: { warn },
  });

  layers.appendChild(doc.createElement("div")).innerHTML = cardHtml();
  await flush();

  assert.match(doc.querySelector(".ragebait-line").textContent, /analyzing/);
  assert.equal(warns.length, 0);

  observer.dispose();
});

// --- response routing (the seam Task 7 completes) ------------------------------

test("hovercard: bootPage routes a score response to the open line", async () => {
  const doc = makeDoc(`<div id="layers"></div>`);
  const win = doc.defaultView;
  const { warns, warn } = warnCollector();

  bootPage({
    document: doc,
    win,
    consoleLike: { warn },
    waitForCard: (card, done) =>
      done(card.querySelector(SELECTORS.followingLink)),
  });

  const layers = doc.querySelector("#layers");
  layers.appendChild(doc.createElement("div")).innerHTML = cardHtml();
  await flush();

  const line = doc.querySelector(".ragebait-line");
  assert.match(line.textContent, /analyzing/);

  win.postMessage({
    // The type comes from the extension-world bridge; if the page-side
    // literal drifts from it, this test fails.
    type: SCORE_RESPONSE_TYPE,
    handle: "yoksiktir",
    result: { state: "result", band: "high", percent: null },
  }, "*");
  await flush();

  const updated = doc.querySelector(".ragebait-line");
  assert.match(updated.textContent, /Ragebait: High/);
  assert.match(updated.textContent, /estimated/);
  assert.equal(warns.length, 0);
});

test("hovercard: the page response literal matches the extension-world bridge", () => {
  assert.equal(PAGE_SCORE_RESPONSE_TYPE, SCORE_RESPONSE_TYPE);
});

test("hovercard: a response for an unknown handle is ignored", async () => {
  const doc = makeDoc(`<div id="layers"></div>`);
  const win = doc.defaultView;
  const { warns, warn } = warnCollector();

  bootPage({
    document: doc,
    win,
    consoleLike: { warn },
    waitForCard: (card, done) =>
      done(card.querySelector(SELECTORS.followingLink)),
  });

  win.postMessage({
    type: SCORE_RESPONSE_TYPE,
    handle: "someone-else",
    result: { state: "result", band: "low", percent: 10 },
  }, "*");
  await flush();

  assert.equal(doc.querySelectorAll(".ragebait-line").length, 0);
  assert.equal(warns.length, 0);
});

test("hovercard: bootPage works without the config tag (render needs no token)", async () => {
  const doc = makeDoc(`<div id="layers"></div>`);
  const { warns, warn } = warnCollector();

  bootPage({
    document: doc,
    win: doc.defaultView,
    consoleLike: { warn },
    waitForCard: (card, done) =>
      done(card.querySelector(SELECTORS.followingLink)),
  });

  const layers = doc.querySelector("#layers");
  layers.appendChild(doc.createElement("div")).innerHTML = cardHtml();
  await flush();

  assert.match(doc.querySelector(".ragebait-line").textContent, /analyzing/);
  assert.equal(warns.length, 0);
});
