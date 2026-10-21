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
 * injected stylesheet and the label span's inline style; `steps` is how many
 * meter segments the band fills (low 1, medium 2, high 3 of three).
 *
 * These are the dark-theme values from Section 1 of the branding plan. They are
 * pinned to the --rb-band-* tokens in src/brand/brand.css by
 * tests/brand/tokens.test.js, so the two must move together.
 */
export const BAND_STYLES = {
  low: { cls: "rb-low", color: "#46c07a", steps: 1 },
  medium: { cls: "rb-medium", color: "#e3b63f", steps: 2 },
  high: { cls: "rb-high", color: "#f0445c", steps: 3 },
};

/** The line's root class. Also the selector used for idempotency checks. */
export const LINE_CLASS = "ragebait-line";

/** The one copy per UI state (plan Part 1 §6, D14: no staged render). */
const STATE_COPY = {
  loading: "analyzing\u2026",
  insufficient: "insufficient data",
  error: "analysis failed",
  quota: "quota exceeded \u2014 retry tomorrow",
};

const ELLIPSIS = "  \u00b7\u00b7\u00b7";

/** The stale indicator's qualifier and class modifier. */
const STALE_QUALIFIER = " (stale)";
const STALE_CLS = ` ${LINE_CLASS}-stale`;

/**
 * The line's part classes. Every state is a fixed list of parts, and the
 * rendered text is always their join -- the text is derived, never stored
 * beside the parts, so the two cannot drift (Task 3 Interfaces).
 *
 * A sep part carries `hidden: true` so Task 4's CSS can display:none it once
 * the line gets its flex gap; the marker is data-only here, and textContent
 * is unaffected by CSS either way.
 */
const PART_TAG = "ragebait-line-tag";
const PART_LABEL = "ragebait-line-label";
const PART_SEP = "ragebait-line-sep";
const PART_VALUE = "ragebait-line-value";
const PART_NOTE = "ragebait-line-note";

/**
 * The band meter: three segments, filled to the band's `steps`. The meter is
 * band-derived only -- a hostile percent can never widen or shrink it.
 */
const METER_CLS = "ragebait-line-meter";
const METER_STEPS = 3;
const SEG_CLS = "rb-seg";
const SEG_ON_CLS = "rb-on";

/** A line spec's `text` is always the join of its parts -- derived, never kept. */
const textOfParts = (parts) => parts.map((p) => p.text).join("");

/** First letter upper-cased: "low" -> "Low". */
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The spec's shape: cls + parts for the line, an optional band sub-element. */
const baseSpec = (cls, parts) => ({
  cls,
  parts,
  text: textOfParts(parts),
  meter: null,
  band: null,
  sub: null,
});

const noticeSpec = (key) => () =>
  baseSpec(`${LINE_CLASS} ${LINE_CLASS}-notice`, [
    { cls: PART_NOTE, text: STATE_COPY[key] },
  ]);

/** A known band key on `s`, or null (hostile/unknown bands never render). */
function knownBand(s) {
  return typeof s.band === "string" && Object.hasOwn(BAND_STYLES, s.band)
    ? s.band
    : null;
}

/**
 * The band-carrying states (result | estimated | stale). Only a known band
 * renders; anything else falls through to the error copy.
 */
function bandSpec(s) {
  const band = knownBand(s);
  if (!band) return noticeSpec("error")();

  const style = BAND_STYLES[band];
  const label = capitalize(band);
  const hasNumber = typeof s.percent === "number" &&
    Number.isFinite(s.percent) &&
    s.percent >= 0;

  let parts;
  if (hasNumber) {
    // The calibrated number, shown only once /config's showNumber gate
    // passes (plan Part 1 §1; the gate itself is Task 15).
    parts = [
      { cls: PART_TAG, text: "RAGEBAIT: " },
      { cls: PART_LABEL, text: label },
      { cls: PART_SEP, text: " \u00b7 ", hidden: true },
      { cls: PART_VALUE, text: `%${Math.round(s.percent)}` },
    ];
  } else {
    // No number yet: an estimated answer, not a definitive one.
    const qualifier = s.state === "estimated" ? " (no model)" : "";
    parts = [
      { cls: PART_TAG, text: "RAGEBAIT: " },
      { cls: PART_LABEL, text: label },
      { cls: PART_NOTE, text: `(estimated${qualifier})${ELLIPSIS}` },
    ];
  }
  return {
    cls: `${LINE_CLASS} ${style.cls}`,
    parts,
    text: textOfParts(parts),
    meter: { cls: METER_CLS, steps: METER_STEPS, filled: style.steps },
    band,
    sub: null,
  };
}

/**
 * Quota: the notice copy, with the heuristic band still rendered beneath it
 * (plan §6 table; Task 8 test f). The band lives in `sub`, so the outer
 * notice line never wears a band class itself.
 */
function quotaSpec(s) {
  const spec = noticeSpec("quota")();
  const band = knownBand(s);
  if (band) {
    spec.sub = {
      cls: BAND_STYLES[band].cls,
      text: capitalize(band),
      color: BAND_STYLES[band].color,
    };
  }
  return spec;
}

/**
 * The seven rendered states (plan Part 1 §6). Each builder maps a state
 * object to the line's fixed spec; lineSpec dispatches through this map, so
 * a state not in it -- including markup smuggled in as a state -- can only
 * ever render the error copy.
 */
export const STATE_MARKUP = Object.freeze({
  loading: () =>
    baseSpec(`${LINE_CLASS} ${LINE_CLASS}-loading`, [
      { cls: PART_TAG, text: "RAGEBAIT: " },
      { cls: PART_NOTE, text: STATE_COPY.loading },
    ]),
  result: bandSpec,
  estimated: bandSpec,
  stale: bandSpec,
  insufficient: noticeSpec("insufficient"),
  error: noticeSpec("error"),
  quota: quotaSpec,
});

/** Append the stale indicator to a built spec. */
function withStaleIndicator(spec) {
  // The qualifier appends to the LAST part's text, so the join still equals
  // the full text and the byte-identical contract survives the split.
  const parts = spec.parts.map((p) => ({ ...p }));
  const last = parts[parts.length - 1];
  last.text = `${last.text}${STALE_QUALIFIER}`;
  return {
    ...spec,
    cls: `${spec.cls}${STALE_CLS}`,
    parts,
    text: textOfParts(parts),
  };
}

/**
 * What a state looks like: a class list, a fixed list of parts (whose join is
 * the line's text), and an optional band-derived meter. Pure data, no DOM, no
 * HTML. Every branch returns a literal from this module.
 *
 * STALE RULING: there is no single STALE_AFTER_MS. cache.js marks an
 * envelope stale once it is past 50% of ITS state's TTL
 * (STALE_AFTER_FRACTION); the caller forwards `envelope.stale` here and the
 * indicator is added when it is true. The `stale` state forces it on.
 *
 * @param {{state: string, band?: string, percent?: number|null, stale?: boolean}} state
 * @returns {{cls: string, text: string, parts: {cls: string, text: string, hidden?: boolean}[], meter: {cls: string, steps: number, filled: number}|null, band: string|null, sub: {cls: string, text: string, color: string}|null}}
 */
export function lineSpec(state) {
  const s = state && typeof state === "object" ? state : {};
  const key = typeof s.state === "string" &&
      Object.hasOwn(STATE_MARKUP, s.state)
    ? s.state
    : "error";
  const spec = STATE_MARKUP[key](s);
  return s.stale === true || s.state === "stale"
    ? withStaleIndicator(spec)
    : spec;
}

/**
 * The line's markup for a state. The plan's pure string interface (Task 3
 * Interfaces; Task 7 asserts on it), derived from lineSpec so it cannot drift
 * from the element path. Nothing in the extension bundle inserts this string
 * -- see the LINT note above.
 *
 * Emission order matches the element path: one span per part (a single-part
 * spec stays flat, no wrapper child), then the meter, then the sub. The band
 * colour rides on the label span as `style="color:<hex>"` -- no space after
 * the colon, the exact substring render-states.test.js greps for.
 *
 * @param {object} state
 * @returns {string} HTML for one `.ragebait-line` element
 */
export function buildLineMarkup(state) {
  const spec = lineSpec(state);
  const color = spec.band ? BAND_STYLES[spec.band].color : "";
  // A single-note spec keeps the flat shape today's markup interface promised.
  const body = spec.parts.length > 1
    ? spec.parts.map((part) =>
      `<span class="${part.cls}"${
        part.cls === PART_LABEL && color ? ` style="color:${color}"` : ""
      }>${part.text}</span>`
    ).join("")
    : spec.text;
  const meter = spec.meter
    ? `<span class="${spec.meter.cls}">${
      Array.from({ length: spec.meter.steps }, (_, i) =>
        `<span class="${
          i < spec.meter.filled ? `${SEG_CLS} ${SEG_ON_CLS}` : SEG_CLS
        }"></span>`).join("")
    }</span>`
    : "";
  // Quota's heuristic band beneath the notice (sub). All literals.
  const sub = spec.sub
    ? `<span class="${spec.sub.cls}" style="color:${spec.sub.color}">${spec.sub.text}</span>`
    : "";
  return `<span class="${spec.cls}">${body}${meter}${sub}</span>`;
}

/**
 * Build the line as a DOM element. The production path: no HTML is parsed, so
 * there is nothing for a hostile value to break out of.
 *
 * A single-part spec sets textContent and stays flat, exactly as a plain span
 * did; a multi-part spec appends one span per part, then the meter, then the
 * sub -- createElement + textContent at every step, never markup. The band
 * colour rides on the label span's inline style, not the line.
 *
 * @param {Document} doc
 * @param {object} state
 * @returns {Element}
 */
export function createLineElement(doc, state) {
  const spec = lineSpec(state);
  const el = doc.createElement("span");
  el.className = spec.cls;
  // textContent first: setting it would wipe any child appended before it.
  if (spec.parts.length === 1) {
    el.textContent = spec.text;
  } else {
    const color = spec.band ? BAND_STYLES[spec.band].color : "";
    for (const part of spec.parts) {
      const span = doc.createElement("span");
      span.className = part.cls;
      // setAttribute, not style.color: cssstyle re-serializes a hex to
      // rgb(...), and the exact "color: <hex>" value is part of the contract.
      if (part.cls === PART_LABEL && color) {
        span.setAttribute("style", `color: ${color}`);
      }
      span.textContent = part.text;
      el.appendChild(span);
    }
    if (spec.meter) {
      const meter = doc.createElement("span");
      meter.className = spec.meter.cls;
      for (let i = 0; i < spec.meter.steps; i++) {
        const seg = doc.createElement("span");
        seg.className = i < spec.meter.filled
          ? `${SEG_CLS} ${SEG_ON_CLS}`
          : SEG_CLS;
        meter.appendChild(seg);
      }
      el.appendChild(meter);
    }
  }
  if (spec.sub) {
    const band = doc.createElement("span");
    band.className = spec.sub.cls;
    band.textContent = spec.sub.text;
    if (spec.sub.color) band.style.color = spec.sub.color;
    el.appendChild(band);
  }
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
