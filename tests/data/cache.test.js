import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createCache,
  STALE_AFTER_FRACTION,
  TTL_BY_STATE,
} from "../../src/data/cache.js";

function makeStorage(seed = {}) {
  const data = { ...seed };
  return {
    get(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    set(key, value) {
      data[key] = value;
    },
    _data: data,
  };
}

function makeAsyncStorage(seed = {}) {
  const data = { ...seed };
  return {
    async get(key) {
      await Promise.resolve();
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    async set(key, value) {
      await Promise.resolve();
      data[key] = value;
    },
    _data: data,
  };
}

function throwingStorage() {
  return {
    get() {
      throw new Error("storage get boom");
    },
    set() {
      throw new Error("storage set boom");
    },
  };
}

const HOUR = 3600e3;
const DAY = 24 * HOUR;

test("cache constants", () => {
  assert.equal(TTL_BY_STATE.result, 7 * 24 * 3600e3);
  assert.equal(TTL_BY_STATE.estimated, 3600e3);
  assert.equal(TTL_BY_STATE.insufficient, 6 * 3600e3);
  assert.equal(TTL_BY_STATE.error, 1800e3);
  assert.equal(TTL_BY_STATE.quota, 0);
  assert.equal(STALE_AFTER_FRACTION, 0.5);
});

test("roundtrip", async () => {
  const storage = makeStorage();
  const now = () => 1000;
  const c = createCache({
    storage,
    now,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  const result = { state: "result", score: 0.42 };
  await c.set("Handle", result);
  const got = await c.get("handle");
  assert.notEqual(got, null);
  assert.deepEqual(got.value, result);
});

test("expired 7d+1s", async () => {
  let t = 0;
  const now = () => t;
  const storage = makeStorage();
  const c = createCache({
    storage,
    now,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  await c.set("h", { state: "result" });
  t = 7 * DAY + 1000;
  assert.equal(await c.get("h"), null);
});

test("diff modelVersion", async () => {
  const storage = makeStorage();
  const now = () => 1;
  const c1 = createCache({
    storage,
    now,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  await c1.set("h", { state: "result" });
  const c2 = createCache({
    storage,
    now,
    modelVersion: "h2",
    featureVersion: "f1",
  });
  assert.equal(await c2.get("h"), null);
});

test("diff featureVersion", async () => {
  const storage = makeStorage();
  const now = () => 1;
  const c1 = createCache({
    storage,
    now,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  await c1.set("h", { state: "result" });
  const c2 = createCache({
    storage,
    now,
    modelVersion: "h1",
    featureVersion: "f2",
  });
  assert.equal(await c2.get("h"), null);
});

test("case variant", async () => {
  const storage = makeStorage();
  const now = () => 1;
  const c = createCache({
    storage,
    now,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  const result = { state: "result", x: 7 };
  await c.set("Foo", result);
  const got = await c.get("foo");
  assert.notEqual(got, null);
  assert.deepEqual(got.value, result);
});

test("corrupt json", async () => {
  const storage = makeStorage();
  const key = "ragebait:v1:h1:f1:h";
  storage.set(key, "{not valid json");
  const c = createCache({
    storage,
    now: () => 1,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  const got = await c.get("h");
  assert.equal(got, null);
});

test("storage throws", async () => {
  const c = createCache({
    storage: throwingStorage(),
    now: () => 1,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  assert.equal(await c.get("h"), null);
});

test("envelope", async () => {
  const storage = makeStorage();
  const now = () => 123;
  const c = createCache({
    storage,
    now,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  const result = { state: "result", n: 5 };
  await c.set("h", result);
  const got = await c.get("h");
  assert.deepEqual(got, {
    value: result,
    fetchedAt: 123,
    ttlMs: TTL_BY_STATE.result,
    stale: false,
  });
});

test("insufficient ttl", async () => {
  {
    let t = 0;
    const now = () => t;
    const storage = makeStorage();
    const c = createCache({
      storage,
      now,
      modelVersion: "h1",
      featureVersion: "f1",
    });
    await c.set("h", { state: "insufficient" });
    t = 5 * HOUR;
    const got = await c.get("h");
    assert.notEqual(got, null);
  }
  {
    let t = 0;
    const now = () => t;
    const storage = makeStorage();
    const c = createCache({
      storage,
      now,
      modelVersion: "h1",
      featureVersion: "f1",
    });
    await c.set("h", { state: "insufficient" });
    t = 6 * HOUR + 1000;
    assert.equal(await c.get("h"), null);
  }
});

test("error ttl", async () => {
  {
    let t = 0;
    const now = () => t;
    const storage = makeStorage();
    const c = createCache({
      storage,
      now,
      modelVersion: "h1",
      featureVersion: "f1",
    });
    await c.set("h", { state: "error" });
    t = 29 * 60 * 1000;
    assert.notEqual(await c.get("h"), null);
  }
  {
    let t = 0;
    const now = () => t;
    const storage = makeStorage();
    const c = createCache({
      storage,
      now,
      modelVersion: "h1",
      featureVersion: "f1",
    });
    await c.set("h", { state: "error" });
    t = 31 * 60 * 1000;
    assert.equal(await c.get("h"), null);
  }
});

test("result aged 8d", async () => {
  let t = 0;
  const now = () => t;
  const storage = makeStorage();
  const c = createCache({
    storage,
    now,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  await c.set("h", { state: "result" });
  t = 8 * DAY;
  assert.equal(await c.get("h"), null);
});

test("quota never written", async () => {
  const storage = makeStorage();
  const calls = [];
  const origSet = storage.set;
  storage.set = (k, v) => {
    calls.push(k);
    return origSet(k, v);
  };
  const c = createCache({
    storage,
    now: () => 1,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  await c.set("h", { state: "quota" });
  assert.equal(calls.length, 0);
  const c2 = createCache({
    storage,
    now: () => 1,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  assert.equal(await c2.get("h"), null);
  assert.equal(await c2.peek("h"), null);
});

test("peek regardless TTL", async () => {
  let t = 0;
  const now = () => t;
  const storage = makeStorage();
  const c = createCache({
    storage,
    now,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  await c.set("h", { state: "result" });
  t = 10 * DAY;
  const env = await c.peek("h");
  assert.notEqual(env, null);
  assert.equal(env.value.state, "result");
  assert.equal(await c.get("h"), null);
});

test("expired entry is physically deleted from storage on get", async () => {
  const storage = makeStorage();
  const removed = [];
  storage.remove = (keys) => {
    for (const key of keys) {
      removed.push(key);
      delete storage._data[key];
    }
  };
  let t = 0;
  const now = () => t;
  const c = createCache({
    storage,
    now,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  await c.set("h", { state: "result" });
  const key = "ragebait:v1:h1:f1:h";
  assert.ok(key in storage._data, "entry written to storage");
  t = 10 * DAY;
  assert.equal(await c.get("h"), null);
  assert.deepEqual(removed, [key]);
  assert.equal(key in storage._data, false);
});

test("corrupt json is physically deleted from storage on get", async () => {
  const storage = makeStorage();
  const key = "ragebait:v1:h1:f1:h";
  storage.set(key, "{not valid json");
  const removed = [];
  storage.remove = (keys) => {
    for (const k of keys) {
      removed.push(k);
      delete storage._data[k];
    }
  };
  const c = createCache({
    storage,
    now: () => 1,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  assert.equal(await c.get("h"), null);
  assert.deepEqual(removed, [key]);
  assert.equal(key in storage._data, false);
});

test("corrupt json is physically deleted from storage on peek", async () => {
  const storage = makeStorage();
  const key = "ragebait:v1:h1:f1:h";
  storage.set(key, "{not valid json");
  const removed = [];
  storage.remove = (keys) => {
    for (const k of keys) {
      removed.push(k);
      delete storage._data[k];
    }
  };
  const c = createCache({
    storage,
    now: () => 1,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  assert.equal(await c.peek("h"), null);
  assert.deepEqual(removed, [key]);
  assert.equal(key in storage._data, false);
});

test("sweep removes expired entries for handles that are never re-hovered", async () => {
  const storage = makeStorage();
  storage.set("settings", "{}");
  let t = 0;
  const now = () => t;
  const c = createCache({
    storage,
    now,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  await c.set("old", { state: "result" });
  const key = "ragebait:v1:h1:f1:old";
  t = 10 * DAY;
  storage.keys = () => Promise.resolve([key, "settings"]);
  storage.remove = (keys) => {
    for (const k of keys) delete storage._data[k];
    return Promise.resolve();
  };
  const removed = await c.sweep();
  assert.deepEqual(removed, [key]);
  assert.equal(key in storage._data, false);
  assert.equal("settings" in storage._data, true);
});

test("sweep removes corrupt entries", async () => {
  const storage = makeStorage();
  const key = "ragebait:v1:h1:f1:bad";
  storage.set(key, "{not valid json");
  storage.keys = () => Promise.resolve([key]);
  storage.remove = (keys) => {
    for (const k of keys) delete storage._data[k];
    return Promise.resolve();
  };
  const c = createCache({
    storage,
    now: () => 1,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  const removed = await c.sweep();
  assert.deepEqual(removed, [key]);
  assert.equal(key in storage._data, false);
});

test("sweep tolerates a throwing storage", async () => {
  const c = createCache({
    storage: throwingStorage(),
    now: () => 1,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  assert.deepEqual(await c.sweep(), []);
});

test("peek async storage", async () => {
  const storage = makeAsyncStorage();
  const c = createCache({
    storage,
    now: () => 5,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  await c.set("h", { state: "estimated" });
  const got = await c.peek("h");
  assert.notEqual(got, null);
  assert.equal(got.value.state, "estimated");
});

test("unknown state", async () => {
  const storage = makeStorage();
  const key = "ragebait:v1:h1:f1:h";
  const env = { value: { state: "mystery" }, fetchedAt: 1, ttlMs: 999 };
  storage.set(key, JSON.stringify(env));
  const c = createCache({
    storage,
    now: () => 2,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  assert.equal(await c.get("h"), null);
  const p = await c.peek("h");
  assert.notEqual(p, null);
  assert.equal(p.value.state, "mystery");
});

test("async storage throws", async () => {
  const storage = {
    async get() {
      await Promise.resolve();
      throw new Error("async boom");
    },
    async set() {
      await Promise.resolve();
      throw new Error("async boom");
    },
  };
  const c = createCache({
    storage,
    now: () => 1,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  assert.equal(await c.get("h"), null);
  assert.equal(await c.peek("h"), null);
});

test("stale flag true", async () => {
  let t = 0;
  const now = () => t;
  const storage = makeStorage();
  const c = createCache({
    storage,
    now,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  await c.set("h", { state: "result" });
  t = 4 * DAY;
  const got = await c.get("h");
  assert.notEqual(got, null);
  assert.equal(got.stale, true);
});

test("front cache memory", async () => {
  const storage = makeStorage();
  const now = () => 10;
  const c = createCache({
    storage,
    now,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  await c.set("h", { state: "result" });
  const key = "ragebait:v1:h1:f1:h";
  storage.set(key, "{bad");
  const got = await c.get("h");
  assert.notEqual(got, null);
  assert.equal(got.value.state, "result");
});

test("async roundtrip", async () => {
  const storage = makeAsyncStorage();
  const c = createCache({
    storage,
    now: () => 7,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  await c.set("h", { state: "estimated" });
  const got = await c.get("h");
  assert.notEqual(got, null);
  assert.equal(got.value.state, "estimated");
  assert.equal(got.fetchedAt, 7);
});

test("peek exact envelope", async () => {
  const storage = makeStorage();
  const c = createCache({
    storage,
    now: () => 1,
    modelVersion: "h1",
    featureVersion: "f1",
  });
  await c.set("h", { state: "result" });
  const p = await c.peek("h");
  assert.deepEqual(p, {
    value: { state: "result" },
    fetchedAt: 1,
    ttlMs: TTL_BY_STATE.result,
  });
});
