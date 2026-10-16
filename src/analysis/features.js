// Heuristic feature computation (plan Part 2, Task 5).
//
// Pure: runs in both the extension and the page worlds, with no DOM and no
// browser APIs. `Reply[]` -> the 12-key feature vector consumed by
// composeScore. If any reply's language is outside TR/EN the lexicon is
// skipped (`lexiconHits: null`, `langSupported: false`) but every other
// feature is still computed.

import { countLexiconHits } from "./lexicon.js";

const SUPPORTED_LANGS = new Set(["tr", "en"]);

// `createdAt` is FxTwitter's unix timestamp in seconds.
const WINDOW_SECONDS = 60 * 60;

/** Uppercase ASCII letters are the caps signal; count only [A-Z] characters. */
function isAsciiUpper(ch) {
  return ch >= "A" && ch <= "Z";
}

/** Alphabetic characters are [a-zA-Z]; every other character is not counted. */
function isAsciiAlpha(ch) {
  return (ch >= "a" && ch <= "z") || isAsciiUpper(ch);
}

/** Per-reply text statistics, accumulated across every reply text. */
function textStats(text) {
  const value = text == null ? "" : String(text);
  let alpha = 0;
  let upper = 0;
  let bang = false;
  let question = false;
  let hash = 0;
  let words = 0;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (isAsciiAlpha(ch)) {
      alpha += 1;
      if (isAsciiUpper(ch)) upper += 1;
    }
    if (ch === "!") bang = true;
    if (ch === "#") hash += 1;
  }

  const trimmed = value.trim();
  if (trimmed.endsWith("?")) question = true;

  const tokens = trimmed === "" ? [] : trimmed.split(/\s+/);
  words = tokens.length;

  return { alpha, upper, bang, question, hash, words };
}

/** Largest number of replies inside any sliding 60-minute window. */
function maxInWindow(stamps) {
  let best = 0;
  for (let i = 0; i < stamps.length; i++) {
    let count = 0;
    const start = stamps[i];
    const end = start + WINDOW_SECONDS;
    for (let j = 0; j < stamps.length; j++) {
      if (stamps[j] >= start && stamps[j] <= end) count += 1;
    }
    if (count > best) best = count;
  }
  return best;
}

/**
 * @param {Reply[]} replies
 * @returns {{replyCount:number,distinctTargets:number,targetConcentration:number,repeatParentRatio:number,capsRatio:number,exclamationRatio:number,rhetoricalQuestionRatio:number,hashtagDensity:number,lexiconHits:number|null,likesPerReply:number,burstRatio:number,langSupported:boolean}}
 */
export function computeFeatures(replies) {
  const list = Array.isArray(replies) ? replies : [];
  const replyCount = list.length;

  let alpha = 0;
  let upper = 0;
  let exclamationReplies = 0;
  let questionReplies = 0;
  let hashCount = 0;
  let wordCount = 0;
  let likes = 0;
  const texts = [];
  const targets = new Map();
  const parents = new Map();
  const stamps = [];
  let langSupported = true;

  for (const reply of list) {
    const text = typeof reply.text === "string" ? reply.text : "";
    texts.push(text);
    const stats = textStats(text);
    alpha += stats.alpha;
    upper += stats.upper;
    if (stats.bang) exclamationReplies += 1;
    if (stats.question) questionReplies += 1;
    hashCount += stats.hash;
    wordCount += stats.words;

    if (reply.lang !== "tr" && !SUPPORTED_LANGS.has(reply.lang)) {
      langSupported = false;
    }
    if (typeof reply.likes === "number") likes += reply.likes;

    const target = reply.targetScreenName;
    if (target != null) {
      targets.set(target, (targets.get(target) ?? 0) + 1);
    }

    const parent = reply.parentStatusId;
    if (parent != null) {
      parents.set(parent, (parents.get(parent) ?? 0) + 1);
    }

    if (
      typeof reply.createdAt === "number" && Number.isFinite(reply.createdAt)
    ) {
      stamps.push(reply.createdAt);
    }
  }

  // The lexicon runs only when every reply is TR/EN; otherwise it is skipped
  // entirely (lexiconHits: null).
  let lexiconHits = 0;
  if (langSupported) {
    for (const text of texts) lexiconHits += countLexiconHits(text);
  } else {
    lexiconHits = null;
  }

  let targetTotal = 0;
  let targetBest = 0;
  for (const count of targets.values()) {
    targetTotal += count;
    if (count > targetBest) targetBest = count;
  }
  const targetConcentration = targetTotal === 0 ? 0 : targetBest / targetTotal;

  // Parentless replies never enter the denominator. Only parents that receive
  // more than one reply count as a repeat.
  let parentTotal = 0;
  let repeated = 0;
  for (const count of parents.values()) {
    parentTotal += count;
    if (count > 1) repeated += count;
  }
  const repeatParentRatio = parentTotal === 0 ? 0 : repeated / parentTotal;

  const capsRatio = alpha === 0 ? 0 : upper / alpha;
  const exclamationRatio = replyCount === 0
    ? 0
    : exclamationReplies / replyCount;
  const rhetoricalQuestionRatio = replyCount === 0
    ? 0
    : questionReplies / replyCount;
  const hashtagDensity = wordCount === 0 ? 0 : hashCount / wordCount;
  const likesPerReply = replyCount === 0 ? 0 : likes / replyCount;

  stamps.sort((a, b) => a - b);
  const burstRatio = stamps.length === 0
    ? 0
    : maxInWindow(stamps) / stamps.length;

  return {
    replyCount,
    distinctTargets: targets.size,
    targetConcentration,
    repeatParentRatio,
    capsRatio,
    exclamationRatio,
    rhetoricalQuestionRatio,
    hashtagDensity,
    lexiconHits,
    likesPerReply,
    burstRatio,
    langSupported,
  };
}
