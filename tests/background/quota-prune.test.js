import { test } from "node:test";
import assert from "node:assert/strict";

import { pruneOldDailyStats } from "../../src/background/quota-local.js";

test("pruneOldDailyStats removes stats: keys older than retentionDays", async () => {
  const map = new Map([
    ["stats:2026-10-01", 10], // 37 days old
    ["stats:2026-10-25", 50], // 13 days old
    ["stats:2026-10-31", 12], // 7 days old (at cutoff boundary)
    ["stats:2026-11-05", 25], // 2 days old
    ["stats:2026-11-07", 5], // today
    ["ragebait_install_token", "abc123token"],
    ["settings", { mode: "heuristic" }],
  ]);

  const storage = {
    keys() {
      return Promise.resolve(Array.from(map.keys()));
    },
    remove(keys) {
      for (const k of keys) {
        map.delete(k);
      }
      return Promise.resolve();
    },
  };

  const fixedNow = new Date("2026-11-07T12:00:00Z").getTime();
  const pruned = await pruneOldDailyStats(storage, fixedNow, 7);

  assert.deepEqual(pruned.sort(), [
    "stats:2026-10-01",
    "stats:2026-10-25",
    "stats:2026-10-31", // exactly retentionDays old: pruned, keeps 7 dates
  ]);

  assert.equal(map.has("stats:2026-10-01"), false);
  assert.equal(map.has("stats:2026-10-25"), false);
  assert.equal(map.has("stats:2026-10-31"), false);
  assert.equal(map.has("stats:2026-11-05"), true);
  assert.equal(map.has("stats:2026-11-07"), true);
  assert.equal(map.has("ragebait_install_token"), true);
  assert.equal(map.has("settings"), true);
});

test("pruneOldDailyStats works with keys() and delete fallback", async () => {
  const store = {
    "stats:2026-09-01": 2,
    "stats:2026-11-07": 3,
  };

  const storage = {
    keys() {
      return Promise.resolve(Object.keys(store));
    },
    delete(key) {
      delete store[key];
      return Promise.resolve();
    },
  };

  const fixedNow = new Date("2026-11-07T12:00:00Z").getTime();
  const pruned = await pruneOldDailyStats(storage, fixedNow, 7);

  assert.deepEqual(pruned, ["stats:2026-09-01"]);
  assert.equal(store["stats:2026-09-01"], undefined);
  assert.equal(store["stats:2026-11-07"], 3);
});

test("pruneOldDailyStats gracefully handles missing storage methods", async () => {
  // Minimal get/set storage fake with no removal/enumeration support
  const storage = {
    get() {
      return Promise.resolve(null);
    },
    set() {
      return Promise.resolve();
    },
  };

  const pruned = await pruneOldDailyStats(storage, Date.now());
  assert.deepEqual(pruned, []);
});

test("pruneOldDailyStats handles null storage", async () => {
  const pruned = await pruneOldDailyStats(null, Date.now());
  assert.deepEqual(pruned, []);
});

test("pruneOldDailyStats rejects NaN retentionDays without throwing", async () => {
  const storage = {
    keys() {
      return Promise.resolve(["stats:2020-01-01"]);
    },
    remove() {
      return Promise.resolve();
    },
  };
  const pruned = await pruneOldDailyStats(storage, Date.now(), NaN);
  assert.deepEqual(pruned, []);
});

test("pruneOldDailyStats rejects negative retentionDays without throwing", async () => {
  const storage = {
    keys() {
      return Promise.resolve(["stats:2020-01-01"]);
    },
    remove() {
      return Promise.resolve();
    },
  };
  const pruned = await pruneOldDailyStats(storage, Date.now(), -1);
  assert.deepEqual(pruned, []);
});

test("pruneOldDailyStats rejects retentionDays=0 without wiping today", async () => {
  const storage = {
    keys() {
      return Promise.resolve(["stats:2020-01-01", "stats:2099-01-01"]);
    },
    remove() {
      throw new Error("must not remove");
    },
  };
  const pruned = await pruneOldDailyStats(storage, Date.now(), 0);
  assert.deepEqual(pruned, []);
});

test("pruneOldDailyStats survives an invalid clock (dayKey throw path)", async () => {
  const storage = {
    keys() {
      return Promise.resolve(["stats:2020-01-01"]);
    },
    remove() {
      return Promise.resolve();
    },
  };
  const pruned = await pruneOldDailyStats(storage, () => NaN, 7);
  assert.deepEqual(pruned, []);
});
