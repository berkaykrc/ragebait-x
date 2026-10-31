import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkAndConsumeQuota,
  getQuotaKey,
  signInstallToken,
  verifyInstallToken,
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

test("quota: verifyInstallToken verifies valid HMAC signature and rejects invalid", async () => {
  const secret = "super-secret-key-123";
  const date = "2026-10-27";
  const token = "install-token-abc";

  const validSig = await signInstallToken(token, secret, date);

  const reqValid = new Request("https://api.test/analyze", {
    headers: {
      "X-Install-Token": token,
      "X-Install-Signature": validSig,
    },
  });

  const validResult = await verifyInstallToken(reqValid, {
    INSTALL_TOKEN_SECRET: secret,
  }, date);
  assert.equal(validResult, true);

  const reqInvalid = new Request("https://api.test/analyze", {
    headers: {
      "X-Install-Token": token,
      "X-Install-Signature": "invalid-hex-signature-12345",
    },
  });

  const invalidResult = await verifyInstallToken(reqInvalid, {
    INSTALL_TOKEN_SECRET: secret,
  }, date);
  assert.equal(invalidResult, false);
});
