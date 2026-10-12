// Line rendering for the injected hovercard line.
//
// SECURITY: this module is the last gate before the DOM, and it is allowlist
// only. Every rendered state is a fixed string, the band is looked up in
// BAND_STYLES (anything else falls through to the error copy), and no value
// from outside this module is ever placed into the line. The page world may
// request a score; it may never supply one, and this file is what enforces
// "never supply rendered content" on the way out (plan Part 1 §3 control 3:
// "numeric band enums are ever rendered ... no page-supplied text reaches
// the DOM").
//
// Because nothing dynamic is interpolated, this module needs no escaper --
// and it must not import one from src/shared/security.js: that module holds
// the trust gate, and AGENTS.md forbids bundling it into page.js (a trust
// check in the page world is worthless -- the page world is what it checks).
// If a future state ever needs a dynamic string, its escaper must live in a
// page-safe module, not in security.js.
//
// LINT: the line is built with createElement/textContent and inserted with
// insertAdjacentElement, never innerHTML/insertAdjacentHTML. `npm run lint`
// (web-ext --warnings-as-errors) treats HTML assignment as UNSAFE_VAR_ASSIGNMENT
// and addons-linter does not honour eslint-disable comments (verified), so
// parsing markup here would fail a required gate. lineSpec() is the single
// source both the element path and buildLineMarkup() read, so the two can
// never disagree about what a state looks like.

/**
 * Colour map for the three bands. Exactly three keys -- asserted by a test.
 * `cls` is the line modifier class; `color` is the rendered colour, for the
 * injected stylesheet.
 */
export const BAND_STYLES = {
  low: { cls: "rb-low", color: "#3ba55d" },
  medium: { cls: "rb-medium", color: "#e2b93b" },
  high: { cls: "rb-high", color: "#e0294f" },
};

/** The line's root class. Also the selector used for idempotency checks. */
export const LINE_CLASS = "ragebait-line";

/** The one copy per UI state (plan Part 1 §6, D14: no staged render). */
const STATE_COPY = {
  loading: "analyzing\u2026",
  insufficient: "insufficient data",
  error: "analysis failed",
  quota: "quota exceeded",
};

const ELLIPSIS = "  \u00b7\u00b7\u00b7";

/** First letter upper-cased: "low" -> "Low". */
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * What a state looks like: a class list and the line's text. Pure data, no
 * DOM, no HTML. Every branch returns a literal from this module.
 *
 * @param {{state: string, band?: string, percent?: number|null}} state
 * @returns {{cls: string, text: string, band: string|null}}
 */
export function lineSpec(state) {
  const s = state && typeof state === "object" ? state : {};
  const cls = LINE_CLASS;

  if (s.state === "loading") {
    return {
      cls: `${cls} ${cls}-loading`,
      text: `Ragebait: ${STATE_COPY.loading}`,
      band: null,
    };
  }

  // Only these two states carry a band, and the band must be a known key.
  if (
    (s.state === "result" || s.state === "estimated") &&
    typeof s.band === "string" &&
    Object.hasOwn(BAND_STYLES, s.band)
  ) {
    const style = BAND_STYLES[s.band];
    const label = capitalize(s.band);
    const hasNumber = typeof s.percent === "number" &&
      Number.isFinite(s.percent);

    if (hasNumber) {
      // The calibrated number, shown only once /config's showNumber gate
      // passes (plan Part 1 §1; the gate itself is Task 15).
      return {
        cls: `${cls} ${style.cls}`,
        text: `Ragebait: ${label} \u00b7 %${Math.round(s.percent)}`,
        band: s.band,
      };
    }

    // No number yet: an estimated answer, not a definitive one.
    const qualifier = s.state === "estimated" ? " (no model)" : "";
    return {
      cls: `${cls} ${style.cls}`,
      text: `Ragebait: ${label}(estimated${qualifier})${ELLIPSIS}`,
      band: s.band,
    };
  }

  if (s.state === "insufficient" || s.state === "quota") {
    return {
      cls: `${cls} ${cls}-notice`,
      text: STATE_COPY[s.state],
      band: null,
    };
  }

  // error, and anything unrecognized (including markup smuggled in as a state).
  return { cls: `${cls} ${cls}-notice`, text: STATE_COPY.error, band: null };
}

/**
 * The line's markup for a state. The plan's pure string interface (Task 3
 * Interfaces; Task 7 asserts on it), derived from lineSpec so it cannot drift
 * from the element path. Nothing in the extension bundle inserts this string
 * -- see the LINT note above.
 *
 * @param {object} state
 * @returns {string} HTML for one `.ragebait-line` element
 */
export function buildLineMarkup(state) {
  const spec = lineSpec(state);
  const color = spec.band ? BAND_STYLES[spec.band].color : "";
  const style = color ? ` style="color:${color}"` : "";
  return `<span class="${spec.cls}"${style}>${spec.text}</span>`;
}

/**
 * Build the line as a DOM element. The production path: no HTML is parsed, so
 * there is nothing for a hostile value to break out of.
 *
 * @param {Document} doc
 * @param {object} state
 * @returns {Element}
 */
export function createLineElement(doc, state) {
  const spec = lineSpec(state);
  const el = doc.createElement("span");
  el.className = spec.cls;
  el.textContent = spec.text;
  if (spec.band) el.style.color = BAND_STYLES[spec.band].color;
  return el;
}

/**
 * Idempotency guard for the line: never render a second line into the same
 * hovercard.
 *
 * @param {Element|null} $hoverCard
 * @returns {boolean}
 */
export function shouldRenderLine($hoverCard) {
  if (!$hoverCard || typeof $hoverCard.querySelector !== "function") {
    return false;
  }
  return $hoverCard.querySelector(`.${LINE_CLASS}`) === null;
}

/**
 * Replace a rendered line in place with a new state. Returns the new element
 * (the caller's reference must be refreshed -- replaceWith detaches the old
 * node).
 *
 * @param {Element} $line
 * @param {object} state
 * @returns {Element} the new line element
 */
export function applyState($line, state) {
  if (!$line || !$line.ownerDocument) return $line;
  const next = createLineElement($line.ownerDocument, state);
  // Keep the debugging handle across a state change.
  const handle = $line.getAttribute("data-ragebait-handle");
  if (handle) next.setAttribute("data-ragebait-handle", handle);
  $line.replaceWith(next);
  return next;
}
