// Hovercard hook (page world).
//
// CP4T-verified pattern (plan Appendix A.4): watch #layers for the card, wait
// for the avatar container (the card's hydration signal), read the username
// from the following link's pathname, and insert the line at the 3rd parent
// of that anchor. A selector miss renders nothing and warns once -- the page
// must never break because our selectors rotted.
//
// Live flow (Task 7): opening a card renders "analyzing…" and sends a score
// request for its handle; the line is clickable (refresh: back to loading +
// rb:score-refresh); and a card LEAVING the DOM aborts its in-flight request
// (per-card AbortController) and emits exactly one rb:score-cancel so the
// background releases the dedupe entry without consuming quota (Review
// Focus #2). The click listener is delegated on the document so it survives
// applyState's replaceWith.
//
// This runs in the PAGE world, which is untrusted. It makes no trust
// decisions: the handle it reads is a rendering key only. Score validation
// and dedupe happen in the extension world (src/shared/security.js, which is
// deliberately NOT bundled into this bundle).

import { createConfigReader } from "./inject-config.js";
import { createPageMessaging } from "./messaging.js";
import { applyState, createLineElement, LINE_CLASS } from "./render.js";

/** Selector registry. Mirrored by the Worker's /config selectors (Task 11).
 *  The tweet/socialContext scraper selectors are Phase-5 (D1) and absent. */
export const SELECTORS = {
  layers: "#layers",
  hoverCard: '[data-testid="HoverCard"]',
  avatarContainer: 'div[data-testid^="UserAvatar-Container"]',
  followingLink: '[href$="/following"]',
};

/** How long the avatar poll waits before giving up on a card. */
export const AVATAR_TIMEOUT_MS = 2000;

/**
 * Response type this world listens for. Now owned by the page-world bridge
 * module (a local literal there, for the same reason as here: the canonical
 * constant lives in src/shared/messaging.js, and importing it here would
 * bundle the trust gate into page.js). Re-exported for index.js; the
 * equality with the canonical constant is pinned by a test.
 */
export { PAGE_SCORE_RESPONSE_TYPE } from "./messaging.js";

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
 * @param {object} [deps.messaging]  page-world bridge (createPageMessaging shape);
 *        defaults to a real bridge wired to this document's config tag. Send
 *        spies are injected by the tests.
 * @returns {{dispose: () => void, cards: Map<string, {handle: string, line: Element, card: Element, controller: AbortController}>}}
 */
export function createHovercardObserver({
  document: doc,
  consoleLike = console,
  waitForCard = defaultWaitForCard,
  messaging,
}) {
  // The observer belongs to the document it watches, not to whatever global
  // scope happens to exist.
  const ObserverCtor = doc.defaultView?.MutationObserver ??
    (typeof MutationObserver !== "undefined" ? MutationObserver : null);

  /** Handles with a live line, for the response router (see index.js). */
  const cards = new Map();
  /** Cards already processed, so a re-added card does not double-render. */
  const seen = new WeakSet();

  // The default bridge reads the session token from the config tag the
  // content script injects BEFORE page.js boots (provisionPageWorld order).
  const configReader = createConfigReader(doc);
  const bridge = messaging ?? createPageMessaging({
    win: doc.defaultView,
    getToken: () => configReader.getToken(),
    getOrigin: () => doc.defaultView?.location?.origin || "*",
  });

  /**
   * Watch one mounted #layers root for hovercards.
   *
   * @param {Element} root
   */
  function watchLayers(root) {
    const inner = new ObserverCtor(handleRecords);
    inner.observe(root, { childList: true, subtree: true });
    return inner;
  }

  /** Process one observer batch: cards opening, and cards leaving the DOM. */
  function handleRecords(records) {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue; // elements only
        const card = node.matches?.(SELECTORS.hoverCard)
          ? node
          : node.querySelector?.(SELECTORS.hoverCard);
        if (card) openCard(card);
      }
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1) continue;
        releaseRemoved(node);
      }
    }
  }

  /**
   * A removed node covered the card: the card left the DOM. Abort its
   * in-flight request and tell the background to release the dedupe entry --
   * exactly once per card (the entry is deleted, so late responses and
   * further removal records can never cancel twice).
   */
  function releaseRemoved(node) {
    for (const [key, entry] of cards) {
      const covered = node === entry.card ||
        (typeof node.contains === "function" && node.contains(entry.card));
      if (!covered) continue;
      // A node detached and re-attached in the same turn is a move, not a
      // close (X re-parents cards): still connected when this runs, so the
      // line survives and no cancel is sent.
      if (entry.card.isConnected) continue;
      cards.delete(key);
      entry.controller.abort();
      bridge.sendCancel(entry.handle);
    }
  }

  /** Delegated click: the line refreshes its handle's score. */
  function onDocumentClick(event) {
    const target = event?.target;
    if (!target || typeof target.closest !== "function") return;
    const line = target.closest(`.${LINE_CLASS}`);
    if (!line) return;
    const handle = line.getAttribute("data-ragebait-handle");
    if (!handle) return;
    const entry = cards.get(handle.toLowerCase());
    if (!entry || !entry.line.isConnected) return;
    // Back to "analyzing…" immediately, then ask for a fresh score.
    entry.line = applyState(entry.line, { state: "loading" });
    bridge.sendRefresh(entry.handle);
  }
  doc.addEventListener("click", onDocumentClick);

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
  // Fallback poll. Declared here, not next to setInterval below, because both
  // the observer callback and dispose() stop it.
  let pollInterval = null;
  const stopPoll = () => {
    if (pollInterval !== null) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  };

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
        consoleLike.info?.(
          "ragebait: #layers mounted — hovercard observer active",
        );
        inner = watchLayers(mounted);
      }
      // The observer found the root: the fallback poll has nothing left to do.
      if (mounted) stopPoll();
      if (inner) {
        // The same batch may already carry the first cards (X's mount and a
        // hover can land in one synchronous JS turn). Those nodes were
        // delivered to the root watcher, not to inner, so replay them here;
        // openCard's `seen` set makes a double notification harmless.
        // handleRecords also processes removals, so a card that closed in
        // the same batch releases its entry instead of leaking.
        handleRecords(records);
      }
    });
    rootWatcher.observe(doc, { childList: true, subtree: true });

    // FALLBACK: Some Firefox/X.com environments dont fire MutationObserver
    // # when #layers is added lazily. Poll every 200ms as a reliable safety net.
    // After 3 seconds (15 attempts) of polling without success, we keep the
    // document-level observer active instead of continuing to poll.
    const pollMaxAttempts = 15; // 3 seconds at 200ms
    let pollAttempts = 0;

    const pollHandler = () => {
      pollAttempts += 1;
      const checkedRoot = doc.querySelector(SELECTORS.layers);
      if (checkedRoot && !inner) {
        rootWatcher.disconnect();
        rootWatcher = null;
        consoleLike.info?.(
          "ragebait: #layers mounted (poll) — hovercard observer active",
        );
        inner = watchLayers(checkedRoot);
      }
      // Root found by either watcher, or budget spent: stop polling.
      if (checkedRoot || pollAttempts >= pollMaxAttempts) stopPoll();
    };

    pollInterval = setInterval(pollHandler, 200);
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
          insertionPoint.nextElementSibling?.classList.contains(LINE_CLASS)
        ) {
          // Shallower DOM than the pattern expects, or already rendered here.
          // Silent either way: nothing diagnosis-worthy, nothing broken.
          return;
        }

        const line = createLine(doc, handle);
        insertionPoint.insertAdjacentElement("afterend", line);
        const entry = {
          handle,
          line,
          card,
          // Page-side bookkeeping for the in-flight request: aborted when the
          // card leaves the DOM, which also emits the rb:score-cancel that
          // releases the background's dedupe entry (Review Focus #2).
          controller: new AbortController(),
        };
        cards.set(handle.toLowerCase(), entry);
        consoleLike.info?.(`ragebait: requesting score for @${handle}`);
        // The live flow: a rendered line is a requested score. Refused
        // (token-less, malformed) sends keep the line on "analyzing…"; the
        // background dedupes repeat requests for the same handle.
        bridge.sendScoreRequest(handle);
      },
      () => {
        consoleLike.warn(
          `ragebait: avatar hydration timed out after ${AVATAR_TIMEOUT_MS}ms; card skipped`,
        );
      },
    );
  }

  return {
    cards,
    dispose: () => {
      inner?.disconnect();
      rootWatcher?.disconnect();
      stopPoll();
      doc.removeEventListener("click", onDocumentClick);
    },
  };
}
