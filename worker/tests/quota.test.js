import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import {
  ANALYZE_ERRORS,
  checkAndConsumeQuota,
  checkAndConsumeQuotaAtomic,
  checkAndConsumeQuotaLegacyCounter,
  consumeQuotaForCounterKey,
  deriveQuotaNamespace,
  extractQuotaIdentity,
  getGlobalQuotaKey,
  getQuotaKey,
  getQuotaKeyV2,
  MAX_QUOTA_IDENTITY_LENGTH,
  parseQuotaControls,
  X_ACCOUNT_ID_PATTERN,
} from "../src/quota.js";

function createFakeKV() {
  const store = new Map();
  return {
    get(key, options) {
      if (!store.has(key)) return Promise.resolve(null);
      const raw = store.get(key);
      if (options?.type === "json") {
        try {
          return Promise.resolve(JSON.parse(raw));
        } catch {
          return Promise.resolve(null);
        }
      }
      return Promise.resolve(raw);
    },
    put(key, value) {
      store.set(key, typeof value === "string" ? value : JSON.stringify(value));
      return Promise.resolve();
    },
    _store: store,
  };
}

test("quota: getQuotaKey formats as quota:{installToken}:{YYYY-MM-DD}", () => {
  const date = new Date("2026-10-27T12:00:00Z");
  const key = getQuotaKey("tok-abc", date);
  assert.equal(key, "quota:tok-abc:2026-10-27");
});

test("quota: getQuotaKeyV2 formats as quota:v2:{digest}:{YYYY-MM-DD}", () => {
  const date = new Date("2026-10-27T12:00:00Z");
  const key = getQuotaKeyV2("d".repeat(64), date);
  assert.equal(key, `quota:v2:${"d".repeat(64)}:2026-10-27`);
});

test("quota: getGlobalQuotaKey formats the daily global ceiling key", () => {
  const date = new Date("2026-10-27T12:00:00Z");
  assert.equal(
    getGlobalQuotaKey(date),
    "quota:global:model-calls:2026-10-27",
  );
});

test("quota: allows calls within dailyLimit and exhausts on limit", async () => {
  const kv = createFakeKV();
  const date = new Date("2026-10-27T10:00:00Z");

  const r1 = await checkAndConsumeQuota(kv, "tok-1", 2, date);
  assert.equal(r1.allowed, true);
  assert.equal(r1.remaining, 1);

  const r2 = await checkAndConsumeQuota(kv, "tok-1", 2, date);
  assert.equal(r2.allowed, true);
  assert.equal(r2.remaining, 0);

  const r3 = await checkAndConsumeQuota(kv, "tok-1", 2, date);
  assert.equal(r3.allowed, false);
  assert.equal(r3.remaining, 0);
});

test("quota: different day resets quota bucket", async () => {
  const kv = createFakeKV();
  const day1 = new Date("2026-10-27T10:00:00Z");
  const day2 = new Date("2026-10-28T10:00:00Z");

  await checkAndConsumeQuota(kv, "tok-1", 1, day1);
  const exhausted = await checkAndConsumeQuota(kv, "tok-1", 1, day1);
  assert.equal(exhausted.allowed, false);

  const nextDay = await checkAndConsumeQuota(kv, "tok-1", 1, day2);
  assert.equal(nextDay.allowed, true);
  assert.equal(nextDay.remaining, 0);
});

test("quota: two distinct install tokens get independent buckets", async () => {
  const kv = createFakeKV();
  const date = new Date("2026-10-27T10:00:00Z");

  await checkAndConsumeQuota(kv, "tok-user-A", 1, date);
  const aExhausted = await checkAndConsumeQuota(kv, "tok-user-A", 1, date);
  assert.equal(aExhausted.allowed, false);

  // User B is fresh
  const bFresh = await checkAndConsumeQuota(kv, "tok-user-B", 1, date);
  assert.equal(bFresh.allowed, true);
});

test("quota: checkAndConsumeQuota throws when the store is unusable", async () => {
  await assert.rejects(() => checkAndConsumeQuota(null, "tok-1", 2));
  await assert.rejects(() =>
    checkAndConsumeQuota({ put() {}, get: undefined }, "tok-1", 2)
  );
});

test("quota: legacy KV counter is best effort — concurrent misses overrun the limit (pinned race, use the serialized backend for a hard limit)", async () => {
  // Deterministic race: both readers block until the other has also read,
  // then both count from the same stale value. This pins the documented
  // limitation: the read/put counter is NOT a hard limit. Production must
  // bind env.QUOTA_COUNTER (serialized backend) or rely on the edge/WAF
  // limits; local code makes no claim of proving either.
  let readers = 0;
  let releaseReaders;
  const gate = new Promise((resolve) => {
    releaseReaders = resolve;
  });
  const synchronizedKV = {
    async get() {
      readers += 1;
      if (readers === 2) releaseReaders();
      return await gate.then(() => null);
    },
    put(_key, value) {
      // Both writes land "1" from the same stale read.
      synchronizedKV.lastWrite = value;
    },
  };

  const results = await Promise.all([
    checkAndConsumeQuotaLegacyCounter(synchronizedKV, "quota:t:2026-10-27", 1),
    checkAndConsumeQuotaLegacyCounter(synchronizedKV, "quota:t:2026-10-27", 1),
  ]);

  assert.deepEqual(
    results.map((r) => r.allowed),
    [true, true],
    "two concurrent misses can both pass a limit of 1 — documented best-effort",
  );
});

// ---- Serialization requirement: the atomic backend (hard limit) ----
//
// The contract: `incr(key)` returns the post-increment count and MUST be
// serialized per key (a Durable Object instance gives this). The fakes below
// emulate that serialization honestly — the test trusts the contract, it does
// not re-prove the platform.

function createSerializedCounterBackend() {
  const counts = new Map();
  return {
    async incr(key) {
      // Extra await tick: even when callers fire requests concurrently, the
      // contract guarantees each counts from a distinct, serialized state.
      await Promise.resolve();
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    _counts: counts,
  };
}

test("quota: atomic backend allows exactly dailyLimit and denies the rest", async () => {
  const backend = createSerializedCounterBackend();
  const key = getQuotaKeyV2("d".repeat(64), new Date("2026-10-27T10:00:00Z"));

  const r1 = await checkAndConsumeQuotaAtomic(backend, key, 2);
  assert.equal(r1.allowed, true);
  assert.equal(r1.remaining, 1);

  const r2 = await checkAndConsumeQuotaAtomic(backend, key, 2);
  assert.equal(r2.allowed, true);
  assert.equal(r2.remaining, 0);

  const r3 = await checkAndConsumeQuotaAtomic(backend, key, 2);
  assert.equal(r3.allowed, false);
  assert.equal(r3.remaining, 0);
  assert.equal(
    backend._counts.get(key),
    3,
    "denial still recorded a unit so the limit stays closed",
  );
});

test("quota: atomic backend conserves units under concurrent misses (250 calls, limit 200 -> exactly 200 allowed)", async () => {
  const backend = createSerializedCounterBackend();
  const key = "quota:v2:test-concurrency:2026-10-27";

  const results = await Promise.all(
    Array.from(
      { length: 250 },
      () => checkAndConsumeQuotaAtomic(backend, key, 200),
    ),
  );

  const allowed = results.filter((r) => r.allowed).length;
  const denied = results.filter((r) => !r.allowed).length;
  assert.equal(allowed, 200);
  assert.equal(denied, 50);
  assert.equal(backend._counts.get(key), 250);

  // No two serialized calls can share a post-increment count; the count
  // check above (200 + 50 = 250) is the conservation proof.
});

test("quota: atomic backend throws when unusable (router fails closed)", async () => {
  await assert.rejects(() =>
    checkAndConsumeQuotaAtomic(null, "quota:v2:x:2026-10-27", 200)
  );
  await assert.rejects(() =>
    checkAndConsumeQuotaAtomic(
      { incr: undefined },
      "quota:v2:x:2026-10-27",
      200,
    )
  );
  await assert.rejects(() =>
    checkAndConsumeQuotaAtomic(
      {
        incr() {
          return Promise.reject(new Error("DO unavailable"));
        },
      },
      "quota:v2:x:2026-10-27",
      200,
    )
  );
});

test("quota: consumeQuotaForCounterKey routes to the atomic backend when bound, else to the legacy counter", async () => {
  const kv = createFakeKV();
  const backend = createSerializedCounterBackend();
  const key = "quota:v2:route-test:2026-10-27";

  const viaAtomic = await consumeQuotaForCounterKey(kv, backend, key, 5);
  assert.equal(viaAtomic.allowed, true);
  assert.deepEqual(
    Array.from(kv._store.keys()).filter((k) => k === key),
    [],
    "atomic path does not write the legacy store",
  );

  const viaLegacy = await consumeQuotaForCounterKey(kv, null, key, 5);
  assert.equal(viaLegacy.allowed, true);
  assert.equal(kv._store.get(key), "1");
});

// ---- Policy tests ----
// Quota identity (either kind) is a forgeable, self-reported identifier —
// quota accounting / abuse resistance only, NOT authentication.
// X-Install-Signature is RESERVED for a future server-issued credential flow
// and is not honored today, even when INSTALL_TOKEN_SECRET is configured: the
// public extension cannot safely hold a shared secret, so the secret must
// never gate this path (see the security model comment in worker/src/quota.js
// and the router tests that set INSTALL_TOKEN_SECRET).

function requestWithHeaders(headers) {
  return new Request("https://api.test/analyze", { headers });
}

test("quota: extractQuotaIdentity reads the header install token", () => {
  const req = requestWithHeaders({ "X-Install-Token": "tok-abc" });
  assert.deepEqual(extractQuotaIdentity(req, undefined), {
    kind: "install",
    value: "tok-abc",
  });
});

test("quota: extractQuotaIdentity falls back to the documented body field", () => {
  const req = requestWithHeaders({});
  assert.deepEqual(
    extractQuotaIdentity(req, { state: {}, installToken: "tok-xyz" }),
    { kind: "install", value: "tok-xyz" },
  );
  // Documented precedence: header wins over body.
  const both = requestWithHeaders({ "X-Install-Token": "tok-header" });
  assert.deepEqual(
    extractQuotaIdentity(both, { installToken: "tok-body" }),
    { kind: "install", value: "tok-header" },
  );
});

test("quota: missing identity -> null (bounded install_token_required upstream)", () => {
  const req = requestWithHeaders({});
  assert.equal(extractQuotaIdentity(req, {}), null);
  assert.equal(extractQuotaIdentity(req, { installToken: "" }), null);
  assert.equal(extractQuotaIdentity(req, { installToken: "   " }), null);
});

test("quota: oversized or unprintable install tokens are rejected (KV key hygiene)", () => {
  const longToken = "t".repeat(MAX_QUOTA_IDENTITY_LENGTH + 1);
  const reqLong = requestWithHeaders({ "X-Install-Token": longToken });
  assert.equal(extractQuotaIdentity(reqLong, undefined), null);

  const maxLength = "t".repeat(MAX_QUOTA_IDENTITY_LENGTH);
  const reqMax = requestWithHeaders({ "X-Install-Token": maxLength });
  assert.deepEqual(extractQuotaIdentity(reqMax, undefined), {
    kind: "install",
    value: maxLength,
  });

  const reqSpace = requestWithHeaders({ "X-Install-Token": "tok abc" });
  assert.equal(extractQuotaIdentity(reqSpace, undefined), null);

  const ctrl = String.fromCharCode(0x01) + "tok";
  const reqCtrl = requestWithHeaders({ "X-Install-Token": ctrl });
  assert.equal(extractQuotaIdentity(reqCtrl, undefined), null);
});

test("quota: arbitrary install token is accepted and X-Install-Signature is ignored (no client HMAC authentication)", () => {
  const req = requestWithHeaders({
    "X-Install-Token": "forged-arbitrary-token",
    // Signature present-but-bogus: deliberately not verified. INSTALL_TOKEN_
    // SECRET, when configured, is a server-side secret for namespace
    // derivation; it must never gate this path (see router test with
    // INSTALL_TOKEN_SECRET configured).
    "X-Install-Signature": "deadbeef-not-a-real-signature",
  });

  assert.deepEqual(extractQuotaIdentity(req, undefined), {
    kind: "install",
    value: "forged-arbitrary-token",
  });
});

// ---- X-account namespace candidate (X-Quota-Identity) ----

test("quota: valid numeric X-Quota-Identity selects the x-account kind", () => {
  const req = requestWithHeaders({ "X-Quota-Identity": "123456789012345678" });
  assert.deepEqual(extractQuotaIdentity(req, undefined), {
    kind: "x-account",
    value: "123456789012345678",
  });
});

test("quota: X-Quota-Identity takes precedence over the install token", () => {
  const req = requestWithHeaders({
    "X-Quota-Identity": "42",
    "X-Install-Token": "tok-also-present",
  });
  assert.deepEqual(extractQuotaIdentity(req, undefined), {
    kind: "x-account",
    value: "42",
  });
});

test("quota: malformed X-Quota-Identity falls back to the install token instead of blocking (no analysis DoS from a bad candidate)", () => {
  const fallbacks = [
    "abc", // non-numeric
    "12 3", // inner whitespace
    "0123", // leading zero (not the canonical decimal form)
    "-42", // sign
    " ".repeat(MAX_QUOTA_IDENTITY_LENGTH + 1), // oversized
  ];
  // Note: leading/trailing whitespace (" 123") is trimmed by the header
  // framing itself before extraction, so a spacing attack merely selects the
  // (valid) canonical value; it cannot bypass the numeric check.
  for (const bad of fallbacks) {
    const req = requestWithHeaders({
      "X-Quota-Identity": bad,
      "X-Install-Token": "tok-fallback",
    });
    assert.deepEqual(extractQuotaIdentity(req, undefined), {
      kind: "install",
      value: "tok-fallback",
    });
  }
});

test("quota: X_ACCOUNT_ID_PATTERN bounds viewer IDs to positive 64-bit-range decimals without leading zeros", () => {
  assert.ok(X_ACCOUNT_ID_PATTERN.test("1"));
  assert.ok(X_ACCOUNT_ID_PATTERN.test("999999999999999999"));
  assert.equal(X_ACCOUNT_ID_PATTERN.test("0"), false);
  assert.equal(
    X_ACCOUNT_ID_PATTERN.test("10000000000000000000"),
    false,
    "20 digits is out of range",
  );
  assert.equal(X_ACCOUNT_ID_PATTERN.test("007"), false);
});

// ---- HMAC namespace derivation ----

test("quota: same X ID derives the same namespace after reinstall (stability, not verification)", async () => {
  const secret = "server-only-secret-for-quota-namespace";
  // A reinstall changes the install token but the same logged-in viewer
  // yields the same candidate -> the Worker bucket survives.
  const a1 = await deriveQuotaNamespace("x-account:1234567890", secret);
  const a2 = await deriveQuotaNamespace("x-account:1234567890", secret);
  assert.equal(a1, a2);
  assert.match(a1, /^[0-9a-f]{64}$/);
});

test("quota: different X IDs and account switches derive different namespaces", async () => {
  const secret = "server-only-secret-for-quota-namespace";
  const a = await deriveQuotaNamespace("x-account:111111111", secret);
  const b = await deriveQuotaNamespace("x-account:222222222", secret);
  assert.notEqual(a, b);
});

test("quota: kinds are domain-separated — equal material can never collide across kinds", async () => {
  const secret = "server-only-secret-for-quota-namespace";
  // An attacker self-generating install token "123" must not merge into the
  // x-account-123 bucket (or vice versa).
  const xNamespace = await deriveQuotaNamespace("x-account:123", secret);
  const installNamespace = await deriveQuotaNamespace("install:123", secret);
  assert.notEqual(xNamespace, installNamespace);
});

test("quota: derivation requires non-empty material and secret (missing secret must fail loudly, never fabricate a weak digest)", async () => {
  const secret = "server-only-secret-for-quota-namespace";
  await assert.rejects(() => deriveQuotaNamespace("", secret));
  await assert.rejects(() => deriveQuotaNamespace("x-account:1", ""));
  await assert.rejects(() => deriveQuotaNamespace("x-account:1", undefined));
});

// ---- Operator quota controls ----

test("quota: parseQuotaControls reads the kill switch flag", () => {
  assert.equal(parseQuotaControls({ QUOTA_KILL_SWITCH: "1" }).killSwitch, true);
  assert.equal(
    parseQuotaControls({ QUOTA_KILL_SWITCH: "true" }).killSwitch,
    true,
  );
  assert.equal(
    parseQuotaControls({ QUOTA_KILL_SWITCH: "ON" }).killSwitch,
    true,
  );
  assert.equal(
    parseQuotaControls({ QUOTA_KILL_SWITCH: "1 " }).killSwitch,
    true,
  );
  assert.equal(
    parseQuotaControls({ QUOTA_KILL_SWITCH: "yeeee" }).killSwitch,
    false,
  );
  assert.equal(
    parseQuotaControls({ QUOTA_KILL_SWITCH: "" }).killSwitch,
    false,
  );
  assert.equal(parseQuotaControls({}).killSwitch, false);
  assert.equal(parseQuotaControls(null).killSwitch, false);
  // Unknown non-string values are not truthy switches.
  assert.equal(
    parseQuotaControls({ QUOTA_KILL_SWITCH: true }).killSwitch,
    false,
    "the kill switch accepts the documented truthy flags only",
  );
});

test("quota: parseQuotaControls reads the global daily ceiling and disables it when unset or unparseable", () => {
  assert.equal(
    parseQuotaControls({ GLOBAL_DAILY_MODEL_CEILING: "2500" })
      .globalDailyCeiling,
    2500,
  );
  assert.equal(
    parseQuotaControls({ GLOBAL_DAILY_MODEL_CEILING: 3000 })
      .globalDailyCeiling,
    3000,
  );
  assert.equal(
    parseQuotaControls({ GLOBAL_DAILY_MODEL_CEILING: "abc" })
      .globalDailyCeiling,
    null,
  );
  assert.equal(
    parseQuotaControls({ GLOBAL_DAILY_MODEL_CEILING: "-5" })
      .globalDailyCeiling,
    null,
  );
  assert.equal(parseQuotaControls({}).globalDailyCeiling, null);
});

test("quota: ANALYZE_ERRORS keeps the bounded 503/400 contract machine readable", () => {
  assert.deepEqual(ANALYZE_ERRORS.install_token_required, { status: 400 });
  assert.deepEqual(ANALYZE_ERRORS.model_calls_paused, { status: 503 });
  assert.deepEqual(ANALYZE_ERRORS.quota_unavailable, { status: 503 });
});

// ---- Router-level behavior (worker.fetch) ----

const VALID_STATE = {
  handle: "alice",
  features: { replyCount: 10, langSupported: true },
  replySample: ["hi"],
};

const SECRET = "server-only-secret-for-quota-namespace-tests";

function mockModelFetch(counter) {
  return () => {
    counter.calls += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          answers: { is_provocative: { noul: 0.9 } },
          model: "clef",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };
}

function analyzeRequest({ headers, state = VALID_STATE, installToken }) {
  return new Request("https://api.test/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(installToken ? { state, installToken } : { state }),
  });
}

const QUOTA_ENV = {
  CLOUDFLARE_ACCOUNT_ID: "acct-test",
  CLOUDFLARE_API_TOKEN: "k",
};

test("router: same X-account identity shares one bucket across reinstall and keeps the raw X ID out of KV", async () => {
  const counter = { calls: 0 };
  const kv = createFakeKV();
  const secret = SECRET;

  const baseHeaders = {
    "X-Install-Token": "tok-install",
    "X-Quota-Identity": "123456789012345678",
  };
  const req = analyzeRequest({
    headers: baseHeaders,
  });
  const res = await worker.fetch(
    req,
    { CACHE_KV: kv, ...QUOTA_ENV, INSTALL_TOKEN_SECRET: secret },
    null,
    mockModelFetch(counter),
  );
  assert.equal(res.status, 200);
  assert.equal(counter.calls, 1);
  assert.equal(
    kv._store.get(`quota:tok-install:${today()}`),
    undefined,
    "secret-configured install keys must not stay raw",
  );

  // "Reinstall": a different install token, same logged-in viewer -> the SAME
  // derived bucket is continued (200 -> 199).
  const reinstallReq = analyzeRequest({
    headers: {
      "X-Install-Token": "tok-after-reinstall",
      "X-Quota-Identity": "123456789012345678",
    },
    state: { ...VALID_STATE, handle: "reinstall_bob" },
  });
  const res2 = await worker.fetch(
    reinstallReq,
    { CACHE_KV: kv, ...QUOTA_ENV, INSTALL_TOKEN_SECRET: secret },
    null,
    mockModelFetch(counter),
  );
  assert.equal(res2.status, 200);
  assert.equal(counter.calls, 2);
  assert.equal(res2.headers.get("x-quota-remaining"), "198");
  assert.equal(
    Array.from(kv._store.keys()).filter((k) => k.startsWith("quota:v2:"))
      .length,
    1,
    "reinstalls share one v2 namespace",
  );

  // Never persist the raw X ID in any quota key.
  const rawIdOccurrences = Array.from(kv._store.keys()).filter((k) =>
    k.includes("123456789012345678")
  );
  assert.deepEqual(rawIdOccurrences, []);
});

function today() {
  return new Date().toISOString().slice(0, 10);
}

test("router: switching the logged-in X account switches the quota namespace", async () => {
  const counter = { calls: 0 };
  const kv = createFakeKV();

  const res1 = await worker.fetch(
    analyzeRequest({
      headers: { "X-Quota-Identity": "111111111" },
      state: { ...VALID_STATE, handle: "switch_first" },
    }),
    { CACHE_KV: kv, ...QUOTA_ENV, INSTALL_TOKEN_SECRET: SECRET },
    null,
    mockModelFetch(counter),
  );
  const res2 = await worker.fetch(
    analyzeRequest({
      headers: { "X-Quota-Identity": "222222222" },
      state: { ...VALID_STATE, handle: "switch_second" },
    }),
    { CACHE_KV: kv, ...QUOTA_ENV, INSTALL_TOKEN_SECRET: SECRET },
    null,
    mockModelFetch(counter),
  );

  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);
  assert.equal(counter.calls, 2);
  // Two distinct identities -> two fresh v2 buckets (remaining 199 each).
  assert.equal(res1.headers.get("x-quota-remaining"), "199");
  assert.equal(res2.headers.get("x-quota-remaining"), "199");
});

test("router: forged X-account identity is accepted and SHARES the claimed bucket (documented tolerance, not authentication)", async () => {
  const counter = { calls: 0 };
  const kv = createFakeKV();

  const env = { CACHE_KV: kv, ...QUOTA_ENV, INSTALL_TOKEN_SECRET: SECRET };

  // Legitimate owner consumes one unit.
  await worker.fetch(
    analyzeRequest({ headers: { "X-Quota-Identity": "777777777" } }),
    env,
    null,
    mockModelFetch(counter),
  );
  // A different "caller" (different install token) forges the same public ID:
  // accepted, and it falls into the same bucket -> remaining continues down.
  const forger = await worker.fetch(
    analyzeRequest({
      headers: {
        "X-Install-Token": "tok-forged-sender",
        "X-Quota-Identity": "777777777",
      },
      state: { ...VALID_STATE, handle: "forged_bob" },
    }),
    env,
    null,
    mockModelFetch(counter),
  );

  assert.equal(forger.status, 200);
  assert.equal(counter.calls, 2);
  assert.equal(forger.headers.get("x-quota-remaining"), "198");
});

test("router: install-token-only rotation stays supported under the secret (derived namespace)", async () => {
  const counter = { calls: 0 };
  const kv = createFakeKV();
  const env = { CACHE_KV: kv, ...QUOTA_ENV, INSTALL_TOKEN_SECRET: SECRET };

  const resA = await worker.fetch(
    analyzeRequest({ headers: { "X-Install-Token": "tok-rot-v2-A" } }),
    env,
    null,
    mockModelFetch(counter),
  );
  const resB = await worker.fetch(
    analyzeRequest({
      headers: { "X-Install-Token": "tok-rot-v2-B" },
      state: { ...VALID_STATE, handle: "rot_bob" },
    }),
    env,
    null,
    mockModelFetch(counter),
  );

  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);
  assert.equal(counter.calls, 2);
  // Rotation gets a fresh derived bucket: remaining resets to 199.
  assert.equal(resA.headers.get("x-quota-remaining"), "199");
  assert.equal(resB.headers.get("x-quota-remaining"), "199");
  // Raw token persisting into KV keys must not happen once the secret is set.
  const rawKeyed = Array.from(kv._store.keys()).filter((k) =>
    k.startsWith("quota:tok-rot-v2")
  );
  assert.deepEqual(rawKeyed, []);
});

test("router: legacy no-secret install token path keys KV with the raw token (temporary migration, no PII)", async () => {
  const counter = { calls: 0 };
  const kv = createFakeKV();

  const res = await worker.fetch(
    analyzeRequest({ headers: { "X-Install-Token": "tok-legacy" } }),
    { CACHE_KV: kv, ...QUOTA_ENV },
    null,
    mockModelFetch(counter),
  );

  assert.equal(res.status, 200);
  assert.equal(counter.calls, 1);
  assert.equal(kv._store.get(`quota:tok-legacy:${today()}`), "1");
});

test("router: X-Quota-Identity without INSTALL_TOKEN_SECRET fails closed 503 (no silent weaker-identity downgrade)", async () => {
  const counter = { calls: 0 };
  const kv = createFakeKV();

  const res = await worker.fetch(
    analyzeRequest({ headers: { "X-Quota-Identity": "123456789" } }),
    { CACHE_KV: kv, ...QUOTA_ENV },
    null,
    mockModelFetch(counter),
  );

  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "quota_unavailable" });
  assert.equal(res.headers.get("Retry-After"), "60");
  assert.equal(counter.calls, 0);
});

test("router: malformed X-Quota-Identity falls back to the install token instead of blocking", async () => {
  const counter = { calls: 0 };
  const kv = createFakeKV();

  const res = await worker.fetch(
    analyzeRequest({
      headers: {
        "X-Quota-Identity": "not-a-number",
        "X-Install-Token": "tok-malformed-fallback",
      },
    }),
    { CACHE_KV: kv, ...QUOTA_ENV },
    null,
    mockModelFetch(counter),
  );

  assert.equal(res.status, 200);
  assert.equal(counter.calls, 1);
  // The fallback consumed the INSTALL-token bucket, not a fake one.
  assert.equal(kv._store.get(`quota:tok-malformed-fallback:${today()}`), "1");
});

test("router: kill switch stops model misses, preserves cached responses, consumes no quota", async () => {
  const counter = { calls: 0 };
  const kv = createFakeKV();

  // Seed a cached analysis for alice (cache-first must keep working).
  const cachedData = {
    answers: { is_provocative: { noul: 0.1 } },
    model: "clef",
  };
  const { buildCacheKey } = await import("../src/cache.js");
  const { canonicalModelState } = await import("../src/analyze.js");
  await kv.put(
    await buildCacheKey(canonicalModelState(VALID_STATE), "h1", "f1"),
    JSON.stringify(cachedData),
  );

  const env = {
    CACHE_KV: kv,
    ...QUOTA_ENV,
    QUOTA_KILL_SWITCH: "1",
  };

  const cachedRes = await worker.fetch(
    analyzeRequest({ headers: { "X-Install-Token": "tok-ks-cached" } }),
    env,
    null,
    mockModelFetch(counter),
  );
  assert.equal(cachedRes.status, 200);
  assert.deepEqual(await cachedRes.json(), cachedData);

  // A miss is refused (bounded error), no model call, no quota consumed.
  const missState = { ...VALID_STATE, handle: "bob" };
  const missRes = await worker.fetch(
    analyzeRequest({
      headers: { "X-Install-Token": "tok-ks-miss" },
      state: missState,
    }),
    env,
    null,
    mockModelFetch(counter),
  );
  assert.equal(missRes.status, 503);
  assert.deepEqual(await missRes.json(), { error: "model_calls_paused" });
  assert.equal(missRes.headers.get("Retry-After"), "60");
  assert.equal(
    counter.calls,
    0,
    "the cached response never called the model; the paused miss is refused before the model",
  );
  const quotaKeys = Array.from(kv._store.keys()).filter((k) =>
    k.startsWith("quota:tok-ks")
  );
  assert.deepEqual(quotaKeys, []);
});

test("router: global daily model-call ceiling counts misses across identities; once exhausted all misses get model_calls_paused", async () => {
  const counter = { calls: 0 };
  const kv = createFakeKV();
  const env = {
    CACHE_KV: kv,
    ...QUOTA_ENV,
    GLOBAL_DAILY_MODEL_CEILING: "2",
  };

  // Two distinct handles (no cache interference) exhaust the ceiling.
  const r1 = await worker.fetch(
    analyzeRequest({
      headers: { "X-Install-Token": "tok-ceiling-1" },
      state: { ...VALID_STATE, handle: "ceiling_a" },
    }),
    env,
    null,
    mockModelFetch(counter),
  );
  const r2 = await worker.fetch(
    analyzeRequest({
      headers: { "X-Install-Token": "tok-ceiling-2" },
      state: { ...VALID_STATE, handle: "ceiling_b" },
    }),
    env,
    null,
    mockModelFetch(counter),
  );
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(counter.calls, 2);
  assert.deepEqual(
    Array.from(kv._store.keys()).filter((k) =>
      k.startsWith("quota:global:model-calls")
    ).length,
    1,
  );

  // Third miss (different identity AND handle) is refused globally.
  const r3 = await worker.fetch(
    analyzeRequest({
      headers: { "X-Install-Token": "tok-ceiling-3" },
      state: { ...VALID_STATE, handle: "ceiling_c" },
    }),
    env,
    null,
    mockModelFetch(counter),
  );
  assert.equal(r3.status, 503);
  assert.deepEqual(await r3.json(), { error: "model_calls_paused" });
  assert.equal(counter.calls, 2, "ceiling refusal makes no model call");
});

test("router: serialized QUOTA_COUNTER wiring enforces the quota contract through /analyze", async () => {
  const counter = { calls: 0 };
  const kv = createFakeKV();

  // A real serialized DO-like backend (own state).
  const doBackend = createSerializedCounterBackend();
  const env = {
    CACHE_KV: kv,
    ...QUOTA_ENV,
    INSTALL_TOKEN_SECRET: SECRET,
    QUOTA_COUNTER: doBackend,
  };

  for (let i = 0; i < 5; i++) {
    const res = await worker.fetch(
      analyzeRequest({
        headers: { "X-Install-Token": `tok-do-${i}` },
        state: { ...VALID_STATE, handle: `do_target_${i}` },
      }),
      env,
      null,
      mockModelFetch(counter),
    );
    assert.equal(res.status, 200);
    // Different install tokens -> each starts its own fresh derived bucket.
    assert.equal(res.headers.get("x-quota-remaining"), "199");
  }
  assert.equal(
    Array.from(kv._store.keys()).filter((k) => k.startsWith("quota:v2:"))
      .length,
    0,
  );
});

test("router: broken or rejecting QUOTA_COUNTER binding fails closed 503", async () => {
  const counter = { calls: 0 };
  const kv = createFakeKV();

  const baseEnv = { CACHE_KV: kv, ...QUOTA_ENV, INSTALL_TOKEN_SECRET: SECRET };

  const malformedRes = await worker.fetch(
    analyzeRequest({ headers: { "X-Install-Token": "tok-broken-binding" } }),
    { ...baseEnv, QUOTA_COUNTER: { notIncr: true } },
    null,
    mockModelFetch(counter),
  );
  assert.equal(malformedRes.status, 503);
  assert.deepEqual(await malformedRes.json(), { error: "quota_unavailable" });

  const rejectingRes = await worker.fetch(
    analyzeRequest({ headers: { "X-Install-Token": "tok-rejecting-binding" } }),
    {
      ...baseEnv,
      QUOTA_COUNTER: {
        incr() {
          return Promise.reject(new Error("DO threw"));
        },
      },
    },
    null,
    mockModelFetch(counter),
  );
  assert.equal(rejectingRes.status, 503);
  assert.deepEqual(await rejectingRes.json(), { error: "quota_unavailable" });
  assert.equal(counter.calls, 0);
});

test("router: per-IP limits are NOT implemented in the Worker — quota follows the identity, whatever IP header a test sends (edge owns IP enforcement)", async () => {
  const counter = { calls: 0 };
  const kv = createFakeKV();
  const env = { CACHE_KV: kv, ...QUOTA_ENV };

  // Same identity, "different IPs" (spoofable in tests by definition): the
  // bucket is identical. Enforcing per-IP here would trust a client-spoofable
  // value; that is Cloudflare edge/WAF territory (see quota.js header).
  const ipA = await worker.fetch(
    analyzeRequest({
      headers: {
        "X-Install-Token": "tok-ip",
        "CF-Connecting-IP": "203.0.113.7",
      },
    }),
    env,
    null,
    mockModelFetch(counter),
  );
  const ipB = await worker.fetch(
    analyzeRequest({
      headers: {
        "X-Install-Token": "tok-ip",
        "CF-Connecting-IP": "203.0.113.99",
      },
      state: { ...VALID_STATE, handle: "ip_second" },
    }),
    env,
    null,
    mockModelFetch(counter),
  );
  assert.equal(ipA.status, 200);
  assert.equal(ipB.status, 200);
  assert.equal(counter.calls, 2);
  assert.equal(ipA.headers.get("x-quota-remaining"), "199");
  assert.equal(
    ipB.headers.get("x-quota-remaining"),
    "198",
    "same identity bucket despite different IP headers",
  );

  // Different identities with the same "IP" stay independent buckets.
  const otherId = await worker.fetch(
    analyzeRequest({
      headers: {
        "X-Install-Token": "tok-ip-other",
        "CF-Connecting-IP": "203.0.113.7",
      },
      state: { ...VALID_STATE, handle: "ip_other_handle" },
    }),
    env,
    null,
    mockModelFetch(counter),
  );
  assert.equal(otherId.status, 200);
  assert.equal(otherId.headers.get("x-quota-remaining"), "199");
});

test("router: x-account request under kill switch still preserves cache and stays bounded end to end", async () => {
  const counter = { calls: 0 };
  const kv = createFakeKV();
  const env = {
    CACHE_KV: kv,
    ...QUOTA_ENV,
    INSTALL_TOKEN_SECRET: SECRET,
    QUOTA_KILL_SWITCH: "true",
  };

  // No cache for this handle + x-account identity: paused, no model, no
  // derived bucket consumed (identity resolution happens, then the pause).
  const res = await worker.fetch(
    analyzeRequest({ headers: { "X-Quota-Identity": "424242424" } }),
    env,
    null,
    mockModelFetch(counter),
  );
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "model_calls_paused" });
  assert.equal(counter.calls, 0);
  assert.equal(
    Array.from(kv._store.keys()).filter((k) => k.startsWith("quota:v2:"))
      .length,
    0,
  );
});
