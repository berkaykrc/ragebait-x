import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkAndConsumeQuota,
  extractQuotaIdentity,
  getQuotaKey,
  MAX_QUOTA_IDENTITY_LENGTH,
} from "../src/quota.js";

function createFakeKV() {
  const store = new Map();
  return {
    get(key) {
      return Promise.resolve(store.has(key) ? store.get(key) : null);
    },
    put(key, value) {
      store.set(key, String(value));
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

// Policy: X-Install-Token is a forgeable quota identifier (quota accounting /
// abuse resistance only), NOT authentication. X-Install-Signature is
// RESERVED for a future server-issued credential flow and is not honored
// today, even when INSTALL_TOKEN_SECRET is configured: the public extension
// cannot safely hold a shared secret, so the secret must never gate this
// path (see the security model comment in worker/src/quota.js).

function requestWithHeaders(headers) {
  return new Request("https://api.test/analyze", { headers });
}

test("quota: extractQuotaIdentity reads the header token", () => {
  const req = requestWithHeaders({ "X-Install-Token": "tok-abc" });
  assert.equal(extractQuotaIdentity(req, undefined), "tok-abc");
});

test("quota: extractQuotaIdentity falls back to the documented body field", () => {
  const req = requestWithHeaders({});
  assert.equal(
    extractQuotaIdentity(req, { state: {}, installToken: "tok-xyz" }),
    "tok-xyz",
  );
});

test("quota: missing token -> null (bounded install_token_required upstream)", () => {
  const req = requestWithHeaders({});
  assert.equal(extractQuotaIdentity(req, {}), null);
  assert.equal(extractQuotaIdentity(req, { installToken: "" }), null);
  assert.equal(extractQuotaIdentity(req, { installToken: "   " }), null);
});

test("quota: oversized or unprintable tokens are rejected (KV key hygiene)", () => {
  const longToken = "t".repeat(MAX_QUOTA_IDENTITY_LENGTH + 1);
  const reqLong = requestWithHeaders({ "X-Install-Token": longToken });
  assert.equal(extractQuotaIdentity(reqLong, undefined), null);

  const maxLength = "t".repeat(MAX_QUOTA_IDENTITY_LENGTH);
  const reqMax = requestWithHeaders({ "X-Install-Token": maxLength });
  assert.equal(extractQuotaIdentity(reqMax, undefined), maxLength);

  const reqSpace = requestWithHeaders({ "X-Install-Token": "tok abc" });
  assert.equal(extractQuotaIdentity(reqSpace, undefined), null);

  const ctrl = String.fromCharCode(0x01) + "tok";
  const reqCtrl = requestWithHeaders({ "X-Install-Token": ctrl });
  assert.equal(extractQuotaIdentity(reqCtrl, undefined), null);
});

test("quota: arbitrary token is accepted as identity and X-Install-Signature is ignored (no client HMAC authentication)", () => {
  const req = requestWithHeaders({
    "X-Install-Token": "forged-arbitrary-token",
    // Signature present-but-bogus: deliberately not verified. INSTALL_TOKEN_
    // SECRET, when configured, is a server-side secret for future identity
    // derivation; it must never gate this path (see router test with
    // INSTALL_TOKEN_SECRET configured).
    "X-Install-Signature": "deadbeef-not-a-real-signature",
  });

  assert.equal(extractQuotaIdentity(req, undefined), "forged-arbitrary-token");
});
