import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectDataset,
  parseAccountsJsonl,
  splitDataset,
} from "../../scripts/collect-calibration.mjs";

function makeReplies(count = 10) {
  return Array.from({ length: count }, (_, i) => ({
    id: `r-${i}`,
    text: `reply ${i}`,
  }));
}

test("collect: produces rows for valid accounts", async () => {
  const lines = [
    {
      handle: "alice",
      label: "ragebait",
      label2: null,
      annotator2: null,
      topic: "politics",
      note: "n",
    },
    {
      handle: "bob",
      label: "normal",
      label2: "normal",
      annotator2: "ann2",
      topic: "culture-war",
      note: "n",
    },
  ];
  const replies = makeReplies(10);
  const deps = {
    fetchReplies: () => Promise.resolve({ ok: true, replies }),
    computeFeatures: (r) => ({ replyCount: r.length, capsRatio: 0.1 }),
    delayMs: 0,
  };
  const rows = await collectDataset(lines, deps);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].handle, "alice");
  assert.equal(rows[0].label, "ragebait");
  assert.equal(rows[0].features.replyCount, 10);
  assert.equal(rows[1].label2, "normal");
  assert.equal(rows[1].annotator2, "ann2");
  assert.ok(Array.isArray(rows[0].replySample));
});

test("collect: skips accounts with fewer than 5 replies", async () => {
  const lines = [{
    handle: "sparse",
    label: "normal",
    label2: null,
    annotator2: null,
    topic: "other",
    note: "",
  }];
  const deps = {
    fetchReplies: () => Promise.resolve({ ok: true, replies: makeReplies(3) }),
    computeFeatures: (r) => ({ replyCount: r.length }),
    delayMs: 0,
  };
  const rows = await collectDataset(lines, deps);
  assert.equal(rows.length, 0);
});

test("collect: skips failed fetch", async () => {
  const lines = [{
    handle: "nope",
    label: "normal",
    label2: null,
    annotator2: null,
    topic: "other",
    note: "",
  }];
  const deps = {
    fetchReplies: () => Promise.resolve({ ok: false, replies: [] }),
    computeFeatures: (r) => ({ replyCount: r.length }),
    delayMs: 0,
  };
  const rows = await collectDataset(lines, deps);
  assert.equal(rows.length, 0);
});

test("collect: malformed account line skipped via parseAccountsJsonl", () => {
  const text = [
    '{"handle":"alice","label":"normal","label2":null,"annotator2":null,"topic":"other","note":""}',
    "{not json",
    '{"handle":"bob","label":"ragebait","label2":null,"annotator2":null,"topic":"politics","note":""}',
  ].join("\n");
  const parsed = parseAccountsJsonl(text);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].handle, "alice");
  assert.equal(parsed[1].handle, "bob");
});

test("collect: replySample trimmed to 400 chars and 12 replies", async () => {
  const long = "x".repeat(500);
  const replies = Array.from({ length: 20 }, () => ({ text: long }));
  const lines = [{
    handle: "a",
    label: "normal",
    label2: null,
    annotator2: null,
    topic: "other",
    note: "",
  }];
  const deps = {
    fetchReplies: () => Promise.resolve({ ok: true, replies }),
    computeFeatures: (r) => ({ replyCount: r.length }),
    delayMs: 0,
  };
  const rows = await collectDataset(lines, deps);
  assert.equal(rows[0].replySample.length, 12);
  assert.equal(rows[0].replySample[0].length, 400);
});

test("collect: writes dataset + tune + heldout when outDir given", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cal-"));
  try {
    const lines = [
      {
        handle: "a",
        label: "ragebait",
        label2: null,
        annotator2: null,
        topic: "politics",
        note: "",
      },
      {
        handle: "b",
        label: "normal",
        label2: null,
        annotator2: null,
        topic: "politics",
        note: "",
      },
      {
        handle: "c",
        label: "ragebait",
        label2: null,
        annotator2: null,
        topic: "culture-war",
        note: "",
      },
      {
        handle: "d",
        label: "normal",
        label2: null,
        annotator2: null,
        topic: "culture-war",
        note: "",
      },
    ];
    const deps = {
      fetchReplies: () =>
        Promise.resolve({ ok: true, replies: makeReplies(10) }),
      computeFeatures: (r) => ({ replyCount: r.length }),
      delayMs: 0,
      outDir: dir,
    };
    await collectDataset(lines, deps);
    const dataset = readFileSync(join(dir, "dataset.jsonl"), "utf8");
    const tune = readFileSync(join(dir, "dataset-tune.jsonl"), "utf8");
    const held = readFileSync(join(dir, "dataset-heldout.jsonl"), "utf8");
    assert.ok(dataset.trim().split("\n").length >= 4);
    assert.ok(tune.length > 0);
    assert.ok(held.length > 0);
    // total preserved
    const tuneN = tune.trim() ? tune.trim().split("\n").length : 0;
    const heldN = held.trim() ? held.trim().split("\n").length : 0;
    assert.equal(tuneN + heldN, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collect: idempotent (byte-identical on re-run)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cal-"));
  try {
    const lines = [
      {
        handle: "a",
        label: "ragebait",
        label2: null,
        annotator2: null,
        topic: "politics",
        note: "",
      },
      {
        handle: "b",
        label: "normal",
        label2: null,
        annotator2: null,
        topic: "politics",
        note: "",
      },
    ];
    const deps = {
      fetchReplies: () =>
        Promise.resolve({ ok: true, replies: makeReplies(10) }),
      computeFeatures: (r) => ({ replyCount: r.length }),
      delayMs: 0,
      outDir: dir,
    };
    await collectDataset(lines, deps);
    const first = readFileSync(join(dir, "dataset.jsonl"), "utf8");
    await collectDataset(lines, deps);
    const second = readFileSync(join(dir, "dataset.jsonl"), "utf8");
    assert.equal(first, second);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("split: preserves label/topic ratios roughly", () => {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push({ handle: `r${i}`, label: "ragebait", topic: "politics" });
  }
  for (let i = 0; i < 10; i++) {
    rows.push({ handle: `n${i}`, label: "normal", topic: "politics" });
  }
  const { tune, heldout } = splitDataset(rows, 42);
  assert.equal(tune.length + heldout.length, 20);
  const tuneRage = tune.filter((r) => r.label === "ragebait").length;
  assert.ok(tuneRage >= 6 && tuneRage <= 8);
});

test("split: null label2 handled (carried through)", async () => {
  const lines = [{
    handle: "a",
    label: "normal",
    label2: null,
    annotator2: null,
    topic: "other",
    note: "",
  }];
  const deps = {
    fetchReplies: () => Promise.resolve({ ok: true, replies: makeReplies(10) }),
    computeFeatures: (r) => ({ replyCount: r.length }),
    delayMs: 0,
  };
  const rows = await collectDataset(lines, deps);
  assert.equal(rows[0].label2, null);
});
