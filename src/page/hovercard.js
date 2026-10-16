// Hovercard hook (page world).
//
// CP4T-verified pattern (plan Appendix A.4): watch #layers for the card, wait
// for the avatar container (the card's hydration signal), read the username
// from the following link's pathname, and insert the line at the 3rd parent
// of that anchor. A selector miss renders nothing and warns once -- the page
// must never break because our selectors rotted.
//
// This runs in the PAGE world, which is untrusted. It makes no trust
// decisions: the handle it reads is a rendering key only. Score validation
// and dedupe happen in the extension world (src/shared/security.js, which is
// deliberately NOT bundled into this bundle).

import { createLineElement } from "./render.js";

/** Selector registry. Mirrored by the Worker's /config selectors (Task 11).
 *  The tweet/socialContext scraper selectors are Phase-5 (D1) and absent. */
export const SELECTORS = {
  layers: "#layers",
  hoverCard: '[data-testid="HoverCard"]',
  avatarContainer: 'div[data-testid^="UserAvatar-Container"]',
  followingLink: '[href$="/following"]',
};

/** How long the avatar poll waits before giving up on a card. */
export const AVATAR_TIMEOUT_MS = 500;

/**
 * Response type this world listens for. A local literal on purpose: the
 * canonical constant lives in src/shared/messaging.js (extension world), and
 * importing it here would bundle the trust gate into page.js. The equality
 * of the two is pinned by a test.
 */
export const PAGE_SCORE_RESPONSE_TYPE = "rb:score-response";

/** Strip the handle out of a `/handle/following` pathname, or null. */
export function extractScreenName(followingPathname) {
  if (typeof followingPathname !== "string") return null;
  const match = followingPathname.match(/^\/([A-Za-z0-9_]{1,15})\/following$/);
  return match ? match[1] : null;
}

/**
 * Default avatar wait: rAF poll for the card's hydration, bounded by
 * AVATAR_TIMEOUT_MS. `done(anchorOrNull)` fires once; `onTimeout` is a
 * separate, silent path.
 */
function defaultWaitForCard(card, done, onTimeout) {
  const started = performance.now();
  const step = () => {
    if (card.querySelector(SELECTORS.avatarContainer)) {
      done(card.querySelector(SELECTORS.followingLink));
      return;
    }
    if (performance.now() - started >= AVATAR_TIMEOUT_MS) {
      onTimeout();
      return;
    }
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(step);
    } else {
      setTimeout(step, 16);
    }
  };
  step();
}

/** Build the line element for a handle, tagged with the handle for debugging. */
function createLine(doc, handle) {
  const line = createLineElement(doc, { state: "loading" });
  line.setAttribute("data-ragebait-handle", handle);
  return line;
}

/**
 * Watch the hovercards.
 *
 * @param {object} deps
 * @param {Document} deps.document
 * @param {{warn: Function}} [deps.consoleLike]
 * @param {Function} [deps.waitForCard]  (card, done(anchor|null), onTimeout) => void
 * @returns {{dispose: () => void, cards: Map<string, {line: Element, card: Element}>}}
 */
export function createHovercardObserver({
  document: doc,
  consoleLike = console,
  waitForCard = defaultWaitForCard,
}) {
  // The observer belongs to the document it watches, not to whatever global
  // scope happens to exist.
  const ObserverCtor = doc.defaultView?.MutationObserver ??
    (typeof MutationObserver !== "undefined" ? MutationObserver : null);

  /** Handles with a live line, for the response router (see index.js). */
  const cards = new Map();
  /** Cards already processed, so a re-added card does not double-render. */
  const seen = new WeakSet();

  /**
   * Watch one mounted #layers root for hovercards.
   *
   * @param {Element} root
   */
  function watchLayers(root) {
    const inner = new ObserverCtor((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue; // elements only
          const card = node.matches?.(SELECTORS.hoverCard)
            ? node
            : node.querySelector?.(SELECTORS.hoverCard);
          if (card) openCard(card);
        }
      }
    });
    inner.observe(root, { childList: true, subtree: true });
    return inner;
  }

  if (!ObserverCtor) {
    // No observer support: nothing to watch, one warning, zero breakage.
    consoleLike.warn(
      `ragebait: hovercard root ${SELECTORS.layers} not available; not watching`,
    );
    return { dispose: () => {}, cards };
  }

  const root = doc.querySelector(SELECTORS.layers);
  let inner = root ? watchLayers(root) : null;
  let rootWatcher = null;

  if (!root) {
    // Production timing: page.js boots at document_start, but X mounts
    // #layers much later. Wait for it instead of giving up: one note now,
    // then a document-level watcher installs the real observer when (and if)
    // the root appears. If it never appears, this watcher simply idles.
    consoleLike.warn(
      `ragebait: ${SELECTORS.layers} not mounted yet; waiting for it`,
    );
    rootWatcher = new ObserverCtor((records) => {
      const mounted = doc.querySelector(SELECTORS.layers);
      if (mounted && !inner) {
        rootWatcher.disconnect();
        rootWatcher = null;
        inner = watchLayers(mounted);
      }
      if (inner) {
        // The same batch may already carry the first cards (X's mount and a
        // hover can land in one synchronous JS turn). Those nodes were
        // delivered to the root watcher, not to inner, so replay them here;
        // openCard's `seen` set makes a double notification harmless.
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.nodeType !== 1) continue;
            const card = node.matches?.(SELECTORS.hoverCard)
              ? node
              : node.querySelector?.(SELECTORS.hoverCard);
            if (card) openCard(card);
          }
        }
      }
    });
    rootWatcher.observe(doc, { childList: true, subtree: true });
  }

  function openCard(card) {
    if (seen.has(card)) return;
    seen.add(card);

    waitForCard(
      card,
      (anchor) => {
        // One warning covers both misses: no following anchor at all, and an
        // anchor that is not `/handle/following`. Reaching here means the card
        // already has an avatar container, so it IS an account card and a
        // missing link means our selectors rotted -- exactly the case that
        // must be diagnosable from the console.
        const handle = extractScreenName(anchor?.pathname);
        if (!handle) {
          consoleLike.warn(
            "ragebait: hovercard has no /{handle}/following link; skipping",
          );
          return;
        }

        // CP4T insertion point: the 3rd parent of the following anchor.
        const insertionPoint = anchor.parentElement?.parentElement
          ?.parentElement;
        if (
          !insertionPoint ||
          typeof insertionPoint.insertAdjacentElement !== "function" ||
          insertionPoint.nextElementSibling?.classList.contains(
            "ragebait-line",
          )
        ) {
          // Shallower DOM than the pattern expects, or already rendered here.
          // Silent either way: nothing diagnosis-worthy, nothing broken.
          return;
        }

        const line = createLine(doc, handle);
        insertionPoint.insertAdjacentElement("afterend", line);
        cards.set(handle.toLowerCase(), { line, card });
      },
      () => {},
    );
  }

  return {
    cards,
    dispose: () => {
      inner?.disconnect();
      rootWatcher?.disconnect();
    },
  };
}
