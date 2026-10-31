import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const MIN_REPLIES = 5;
const REPLY_SAMPLE_COUNT = 12;
const REPLY_SAMPLE_MAX_CHARS = 400;
const TUNE_FRACTION = 0.7;
const DEFAULT_SEED = 42;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mulberry32 deterministic PRNG.
function makeRng(seed) {
  let t = seed >>> 0;
  return function rng() {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseAccountsJsonl(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && typeof obj.handle === "string") {
        out.push({
          handle: obj.handle,
          label: obj.label ?? null,
          label2: obj.label2 ?? null,
          annotator2: obj.annotator2 ?? null,
          topic: obj.topic ?? null,
          note: obj.note ?? "",
        });
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function trimReplyText(rep) {
  const text = typeof rep === "string" ? rep : (rep?.text ?? "");
  return String(text).slice(0, REPLY_SAMPLE_MAX_CHARS);
}

export async function collectDataset(accountLines, deps = {}) {
  const fetchReplies = deps.fetchReplies;
  const computeFeatures = deps.computeFeatures;
  const delayMs = deps.delayMs ?? 0;
  const log = deps.log ?? ((m) => console.warn(m));
  const rows = [];

  const lines = Array.isArray(accountLines) ? accountLines : [];
  for (let i = 0; i < lines.length; i++) {
    const acc = lines[i];
    if (!acc || typeof acc !== "object" || typeof acc.handle !== "string") {
      continue;
    }

    let result;
    try {
      result = await fetchReplies(acc.handle, deps);
    } catch (err) {
      log(`skip ${acc.handle}: fetch error ${err?.message ?? err}`);
      if (delayMs > 0 && i < lines.length - 1) await sleep(delayMs);
      continue;
    }

    const replies = result?.replies ?? [];
    if (
      !result?.ok || !Array.isArray(replies) || replies.length < MIN_REPLIES
    ) {
      log(`skip ${acc.handle}: fewer than ${MIN_REPLIES} replies`);
      if (delayMs > 0 && i < lines.length - 1) await sleep(delayMs);
      continue;
    }

    let features;
    try {
      features = computeFeatures(replies);
    } catch (err) {
      log(`skip ${acc.handle}: feature error ${err?.message ?? err}`);
      if (delayMs > 0 && i < lines.length - 1) await sleep(delayMs);
      continue;
    }

    const replySample = replies
      .slice(0, REPLY_SAMPLE_COUNT)
      .map(trimReplyText);

    rows.push({
      handle: acc.handle,
      label: acc.label,
      label2: acc.label2 ?? null,
      annotator2: acc.annotator2 ?? null,
      topic: acc.topic,
      features,
      replySample,
    });

    if (delayMs > 0 && i < lines.length - 1) await sleep(delayMs);
  }

  if (deps.outDir) {
    mkdirSync(deps.outDir, { recursive: true });
    const datasetPath = join(deps.outDir, "dataset.jsonl");
    const tunePath = join(deps.outDir, "dataset-tune.jsonl");
    const heldPath = join(deps.outDir, "dataset-heldout.jsonl");
    writeFileSync(
      datasetPath,
      rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
      "utf8",
    );
    const { tune, heldout } = splitDataset(rows, deps.seed ?? DEFAULT_SEED);
    writeFileSync(
      tunePath,
      tune.map((r) => JSON.stringify(r)).join("\n") + (tune.length ? "\n" : ""),
      "utf8",
    );
    writeFileSync(
      heldPath,
      heldout.map((r) => JSON.stringify(r)).join("\n") +
        (heldout.length ? "\n" : ""),
      "utf8",
    );
  }

  return rows;
}

export function splitDataset(rows, seed = DEFAULT_SEED) {
  const rng = makeRng(seed);
  // group by label|topic
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.label}|${r.topic}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const tune = [];
  const heldout = [];
  for (const [, group] of groups) {
    const shuffled = group.slice();
    // Fisher-Yates
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const n = shuffled.length;
    if (n === 1) {
      if (rng() < TUNE_FRACTION) tune.push(shuffled[0]);
      else heldout.push(shuffled[0]);
      continue;
    }
    const cut = Math.max(1, Math.floor(n * TUNE_FRACTION));
    tune.push(...shuffled.slice(0, cut));
    heldout.push(...shuffled.slice(cut));
  }
  return { tune, heldout };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const accountsPath = process.argv[2] || "data/labeled/accounts.jsonl";
  const outDir = process.argv[3] || "data/labeled";
  let text = "";
  try {
    text = readFileSync(accountsPath, "utf8");
  } catch {
    text = "";
  }
  const lines = parseAccountsJsonl(text);
  // dynamic import of features/fxtwitter not wired; use injected? CLI uses fetchReplies from adapter.
  // For CLI, import fetchReplies dynamically.
  const { fetchReplies } = await import("../src/data/fxtwitter.js");
  const { computeFeatures } = await import("../src/analysis/features.js");
  const fetcher = (handle) => fetchReplies(handle, {});
  const rows = await collectDataset(lines, {
    fetchReplies: fetcher,
    computeFeatures,
    delayMs: 500,
    outDir,
    log: (m) => console.warn(m),
  });
  console.log(`collected ${rows.length} accounts -> ${outDir}`);
}
