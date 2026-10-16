// Provocative-term lexicon (Turkish + English), used by the feature stage.
//
// Starter set for Task 5. Matching is whole-word and case-insensitive. Turkish
// agglutination ("amk" inside "amkleyince") will under-match; stemming is
// deferred to Task 18 (plan §Task 5). The regex is built once at module load
// and shared read-only, so it is safe to import from both extension worlds.

/** Escape every regular-expression metacharacter in a term. */
function escapeRegExp(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Terms, lower-cased: matching itself is case-insensitive via the "i" flag. */
// Every entry must be a provocation or ragebait marker on its own. Ordinary
// vocabulary ("it", "gece", "geri", ...) is excluded: a whole-word match on a
// common word would inflate lexiconHits for innocuous replies. Turkish
// agglutination ("amkk", "salakligi") under-matches: the substring/stemming
// policy belongs to calibration (Task 18).
const TERMS = [
  // Turkish (profanity abbreviations and insults)
  "amk",
  "aq",
  "oç",
  "siktir",
  "orospu",
  "piç",
  "yarak",
  "salak",
  "aptal",
  "mal",
  "gerizekalı",
  "embesgil",
  "hıyar",
  "lan",
  "ulan",
  "yahu",
  // English (ragebait markers)
  "cope",
  "copium",
  "seethe",
  "rage",
  "bait",
  "baited",
  "cringe",
  "troll",
  "clown",
  "moron",
  "idiot",
  "loser",
  "triggered",
  "yikes",
  "ratio",
  "grifter",
];

const PATTERN = new RegExp(
  `\\b(?:${TERMS.map(escapeRegExp).join("|")})\\b`,
  "gi",
);

/**
 * Count whole-word, case-insensitive matches of the lexicon in one text.
 * Two mentions in one text count as two.
 * @param {string|null} text
 * @returns {number}
 */
export function countLexiconHits(text) {
  if (text == null) return 0;

  const value = String(text);
  let count = 0;
  let match;
  // Node's `lastIndex` is reset defensively: the shared pattern must stay
  // reusable across calls.
  PATTERN.lastIndex = 0;
  while ((match = PATTERN.exec(value)) !== null) {
    count += 1;
    if (match.index === PATTERN.lastIndex) PATTERN.lastIndex += 1;
  }
  return count;
}
