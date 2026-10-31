import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../../worker/src/index.js";
import { handleScoreRequest } from "../../src/background/index.js";
import { buildLineMarkup } from "../../src/page/render.js";

function makeReplies(count = 10) {
  return Array.from({ length: count }, (_, i) => ({
    id: `r-${i}`,
    text: `Reply ${i}: why are you doing this? #bait`,
    lang: "tr",
    targetScreenName: "target",
    parentStatusId: null,
    likes: 1,
    createdAt: 1000 + i,
  }));
}

function createFakeKV() {
  const store = new Map();
  return {
    get(key, options) {
      if (!store.has(key)) return Promise.resolve(null);
      const raw = store.get(key);
      if (options?.type === "json") return Promise.resolve(JSON.parse(raw));
      return Promise.resolve(raw);
    },
    put(key, value) {
      store.set(key, typeof value === "string" ? value : JSON.stringify(value));
      return Promise.resolve();
    },
    _store: store,
  };
}

test("integration: end-to-end AI layer (Extension + Worker proxy + Model + Cache + Render)", async () => {
  const kv = createFakeKV();
  let upstreamModelCalls = 0;

  // Mock upstream AI model called by the Worker proxy
  const upstreamFetch = (_url) => {
    upstreamModelCalls++;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          answers: {
            is_provocative: { noul: 0.9 },
            is_engagement_bait: { noul: 0.8 },
            targets_group_identity: { noul: 0.2 },
            reply_farms_opponents: { noul: 0.1 },
            intensity: { score: 0.8, legend: "inflammatory" },
          },
          model: "clef",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  // Bridge fetchImpl to route extension proxy calls directly into worker.fetch
  const networkBridge = async (url, options) => {
    const req = new Request(url, options);
    return await worker.fetch(
      req,
      {
        CACHE_KV: kv,
        CLOUDFLARE_ACCOUNT_ID: "acct-test",
        CLEF_API_KEY: "test-clef-key",
      },
      null,
      upstreamFetch,
    );
  };

  const settings = {
    mode: "proxy",
    proxyUrl: "https://api.ragebait-detector.test/analyze",
    proxyEnabled: true,
    consentAccepted: true,
  };
  const config = {
    showNumber: true,
    bandThresholds: { high: 0.75, medium: 0.45 },
    proxyEnabled: true,
  };

  // 1. First hover: Cold run -> Fetches replies -> Worker proxy miss -> Model call -> Composite score
  const res1 = await handleScoreRequest("provo_user", {
    fetchReplies: () => Promise.resolve({ ok: true, replies: makeReplies(10) }),
    fetchImpl: networkBridge,
    settings,
    config,
    installToken: "install-tok-user-1",
    skipCache: true, // skip client cache to test worker
  });

  assert.equal(res1.state, "result");
  assert.equal(res1.band, "medium"); // 0.57 weighted score
  assert.equal(res1.percent, 57);
  assert.equal(res1.model, "clef");
  assert.equal(res1.heuristic, false);
  assert.equal(upstreamModelCalls, 1);

  // Verify hovercard DOM line rendering with calibrated % number
  const html1 = buildLineMarkup(res1);
  assert.match(html1, /RAGEBAIT:/i);
  assert.match(html1, /Medium/i);
  assert.match(html1, /%57/);

  // 2. Second hover: Worker KV cache hit -> Upstream model NOT called again
  const res2 = await handleScoreRequest("provo_user", {
    fetchReplies: () => Promise.resolve({ ok: true, replies: makeReplies(10) }),
    fetchImpl: networkBridge,
    settings,
    config,
    installToken: "install-tok-user-1",
    skipCache: true, // skip client cache
  });

  assert.equal(res2.state, "result");
  assert.equal(res2.percent, 57);
  assert.equal(upstreamModelCalls, 1); // No new model call!

  // 3. Degradation on AI failure (e.g. Worker 502 / network outage) -> Seamless fallback to heuristic
  const failingBridge = () => {
    return Promise.resolve(
      new Response(JSON.stringify({ error: "ai_unavailable" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const res3 = await handleScoreRequest("new_user", {
    fetchReplies: () => Promise.resolve({ ok: true, replies: makeReplies(10) }),
    fetchImpl: failingBridge,
    settings,
    config,
    installToken: "install-tok-user-1",
    skipCache: true,
  });

  assert.equal(res3.state, "result");
  assert.ok(res3.band); // Heuristic band retained
  assert.equal(res3.percent, null); // No raw percent without AI
  assert.equal(res3.heuristic, true);

  const html3 = buildLineMarkup(res3);
  assert.match(html3, /estimated/i);
  assert.doesNotMatch(html3, /%\d+/);
});
