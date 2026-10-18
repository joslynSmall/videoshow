import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/errors.js";
import { createServer } from "../src/server.js";

const SAMPLE = "https://www.bilibili.com/video/BV1JP41167xK";
const IQIYI = "https://www.iqiyi.com/v_19rronibdc.html";
const silentLogger = { info() {}, warn() {}, error() {} };

function fakeResult(overrides = {}) {
  return {
    sourceUrl: SAMPLE,
    playUrl: "https://media.example/video.m3u8",
    type: "m3u8",
    expiresAtMs: Date.now() + 10 * 60 * 1000,
    provider: "test",
    ...overrides,
  };
}

async function start(t, overrides = {}) {
  const server = createServer({
    resolve: async () => fakeResult(),
    resolveBrowser: null,
    validate: async () => ({ playlist: "#EXTM3U" }),
    enrich: async () => ({ title: "测试视频", cover: null }),
    fetchDanmaku: async () => ({
      provider: "dmku",
      count: 1,
      items: [{ time: 1, mode: 0, color: "#FFFFFF", text: "弹幕" }],
    }),
    logger: silentLogger,
    ...overrides,
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

async function getJson(url, options) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(5000),
  });
  return { response, body: await response.json() };
}

test("GET /api/parse returns an m3u8 payload with danmaku endpoint", async (t) => {
  const { base } = await start(t);
  const { response, body } = await getJson(
    `${base}/api/parse?url=${encodeURIComponent(IQIYI)}`,
  );
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.type, "m3u8");
  assert.equal(body.data.title, "测试视频");
  assert.equal(body.data.cached, false);
  assert.ok(body.data.danmaku.endpoint.startsWith("/api/danmaku?url="));
  assert.ok(!JSON.stringify(body).includes("泽御云"));
});

test("GET /api/parse supports mp4 results", async (t) => {
  const { base } = await start(t, {
    resolve: async () =>
      fakeResult({
        playUrl: "https://media.example/video.mp4",
        type: "mp4",
      }),
    validate: async () => ({ playlist: null }),
  });
  const { response, body } = await getJson(
    `${base}/api/parse?url=${encodeURIComponent(SAMPLE)}`,
  );
  assert.equal(response.status, 200);
  assert.equal(body.data.type, "mp4");
  assert.equal(body.data.sourceUrl, SAMPLE);
});

test("GET /api/parse races multiple providers and selects the faster stream", async (t) => {
  const { base } = await start(t, {
    resolve: async () => ({
      sourceUrl: SAMPLE,
      playUrl: "https://slow.com/video.m3u8",
      type: "m3u8",
      provider: "789jiexi",
    }),
    resolveBrowser: async () => ({
      sourceUrl: SAMPLE,
      playUrl: "https://fast.com/video.m3u8",
      type: "m3u8",
      provider: "jx-browser",
    }),
    race: async (candidates) => ({
      winner:
        candidates.find((c) => c.provider === "jx-browser") || candidates[0],
      ranked: [
        { provider: "jx-browser", speedKBps: 3500, ttfbMs: 80, selected: true },
        { provider: "789jiexi", speedKBps: 110, ttfbMs: 2500, selected: false },
      ],
    }),
  });

  const { response, body } = await getJson(
    `${base}/api/parse?url=${encodeURIComponent(SAMPLE)}`,
  );
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.provider, "jx-browser");
  assert.equal(body.data.candidates.length, 2);
  assert.equal(body.data.candidates[0].provider, "jx-browser");
  assert.equal(body.data.candidates[0].selected, true);
});

test("parse cache returns cached true and calls resolve once", async (t) => {
  let calls = 0;
  let clock = 1_000_000;
  const { base } = await start(t, {
    resolve: async () => {
      calls += 1;
      return fakeResult({ expiresAtMs: clock + 60 * 60 * 1000 });
    },
    validate: async () => ({ playlist: "#EXTM3U" }),
    enrich: async () => ({ title: null, cover: null }),
    now: () => clock,
    cacheTtlMs: 60_000,
  });
  const url = `${base}/api/parse?url=${encodeURIComponent(IQIYI)}`;
  const first = await getJson(url);
  const second = await getJson(url);
  assert.equal(calls, 1);
  assert.equal(first.body.data.cached, false);
  assert.equal(second.body.data.cached, true);
  clock += 61_000;
  const third = await getJson(url);
  assert.equal(calls, 2);
  assert.equal(third.body.data.cached, false);
});

test("GET /api/danmaku returns normalized items and caches", async (t) => {
  let calls = 0;
  const { base } = await start(t, {
    fetchDanmaku: async () => {
      calls += 1;
      return {
        provider: "dmku",
        count: 1,
        items: [{ time: 1, mode: 0, color: "#FFFFFF", text: "弹幕" }],
      };
    },
  });
  const url = `${base}/api/danmaku?url=${encodeURIComponent(IQIYI)}`;
  const first = await getJson(url);
  const second = await getJson(url);
  assert.equal(first.response.status, 200);
  assert.equal(first.body.data.count, 1);
  assert.equal(first.body.data.items[0].text, "弹幕");
  assert.equal(first.body.data.cached, false);
  assert.equal(second.body.data.cached, true);
  assert.equal(calls, 1);
});

test("GET /api/danmaku returns an empty collection", async (t) => {
  const { base } = await start(t, {
    fetchDanmaku: async () => ({ provider: "dmku", count: 0, items: [] }),
  });
  const { response, body } = await getJson(
    `${base}/api/danmaku?url=${encodeURIComponent(SAMPLE)}`,
  );
  assert.equal(response.status, 200);
  assert.equal(body.data.count, 0);
  assert.deepEqual(body.data.items, []);
});

test("GET /api/danmaku surfaces upstream failure", async (t) => {
  const { base } = await start(t, {
    fetchDanmaku: async () => {
      throw new AppError("DANMAKU_UPSTREAM_ERROR", 502, "弹幕服务暂不可用");
    },
  });
  const { response, body } = await getJson(
    `${base}/api/danmaku?url=${encodeURIComponent(IQIYI)}`,
  );
  assert.equal(response.status, 502);
  assert.equal(body.error.code, "DANMAKU_UPSTREAM_ERROR");
});

test("GET /api/parse rejects missing and non-http URLs", async (t) => {
  const { base } = await start(t);
  const missing = await getJson(`${base}/api/parse`);
  assert.equal(missing.response.status, 400);
  assert.equal(missing.body.error.code, "INVALID_URL");
  const ftp = await getJson(
    `${base}/api/parse?url=${encodeURIComponent("ftp://example.com/video")}`,
  );
  assert.equal(ftp.response.status, 400);
  assert.equal(ftp.body.error.code, "INVALID_URL");
});

test("POST /api/parse returns method not allowed", async (t) => {
  const { base } = await start(t);
  const response = await fetch(`${base}/api/parse`, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json();
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
  assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
});

test("GET /api/health reports service status", async (t) => {
  const { base } = await start(t);
  const { response, body } = await getJson(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, "videoshow");
});

test("GET / serves a generic ad-free player", async (t) => {
  const { base } = await start(t);
  const response = await fetch(`${base}/`, {
    signal: AbortSignal.timeout(5000),
  });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(html, /videoshow/);
  assert.doesNotMatch(html, /爱奇艺|iqiyi/i);
  assert.doesNotMatch(html, /f3531\.top|trafficmanager|zeyuyun/i);
  assert.match(
    response.headers.get("content-security-policy"),
    /style-src 'self' 'unsafe-inline'/,
  );
  assert.match(
    response.headers.get("content-security-policy"),
    /img-src 'self' data: https:/,
  );
});

test("player vendor assets are served", async (t) => {
  const { base } = await start(t);
  for (const asset of [
    "/vendor/hls.min.js",
    "/vendor/artplayer.js",
    "/vendor/artplayer-plugin-danmuku.js",
  ]) {
    const response = await fetch(`${base}${asset}`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /javascript/);
    assert.ok((await response.text()).length > 1000);
  }
});

test("unknown API and static paths return 404", async (t) => {
  const { base } = await start(t);
  const apiResponse = await fetch(`${base}/api/nope`, {
    signal: AbortSignal.timeout(5000),
  });
  const apiBody = await apiResponse.json();
  assert.equal(apiResponse.status, 404);
  assert.equal(apiBody.error.code, "NOT_FOUND");
  const staticResponse = await fetch(`${base}/nope`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(staticResponse.status, 404);
});

test("GET /api/search validates keyword and returns items", async (t) => {
  const { base } = await start(t, {
    search: async (kw) => [
      {
        id: "abc",
        cat: "2",
        title: kw,
        cover: "https://img.example/cover.jpg",
        remarks: "电视剧 · 爱奇艺",
        desc: "测试简介",
        platforms: [{ id: "qiyi", name: "爱奇艺" }],
      },
    ],
  });

  const missingResponse = await fetch(`${base}/api/search`, {
    signal: AbortSignal.timeout(5000),
  });
  const missingBody = await missingResponse.json();
  assert.equal(missingResponse.status, 400);
  assert.equal(missingBody.ok, false);
  assert.equal(missingBody.error.code, "INVALID_KEYWORD");

  const { response, body } = await getJson(
    `${base}/api/search?kw=${encodeURIComponent("狂飙")}`,
  );
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.items.length, 1);
  assert.equal(body.data.items[0].title, "狂飙");
  assert.equal(body.data.items[0].platforms[0].name, "爱奇艺");

  const methodNotAllowed = await fetch(`${base}/api/search`, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(methodNotAllowed.status, 405);
});

test("GET /api/title returns platform episode pages", async (t) => {
  const { base } = await start(t, {
    loadTitle: async (cat, id) => {
      if (!String(cat).trim() || !String(id).trim()) {
        throw new AppError("INVALID_TITLE", 400, "缺少剧目编号");
      }
      return {
      id,
      cat,
      title: "狂飙",
      platforms: [
        {
          id: "qiyi",
          name: "爱奇艺",
          episodes: [{ name: "第1集", pageUrl: "https://www.iqiyi.com/v_1.html" }],
        },
      ],
    };
    },
  });

  const missing = await fetch(`${base}/api/title?cat=2`, {
    signal: AbortSignal.timeout(5000),
  });
  const missingBody = await missing.json();
  assert.equal(missing.status, 400);
  assert.equal(missingBody.error.code, "INVALID_TITLE");

  const { response, body } = await getJson(`${base}/api/title?cat=2&id=abc`);
  assert.equal(response.status, 200);
  assert.equal(body.data.platforms[0].episodes[0].pageUrl, "https://www.iqiyi.com/v_1.html");
});

test("/api/race benchmarks multiple candidate streams and returns ranked results", async (t) => {
  const { base } = await start(t, {
    race: async (candidates) => {
      const ranked = candidates.map((c, idx) => {
        const available = c.provider !== "失效源";
        return {
          ...c,
          speedKBps: idx === 0 ? 3000 : 1500,
          ttfbMs: idx === 0 ? 100 : 200,
          available,
          selected: available && idx === 0,
        };
      });
      return { winner: ranked.find((item) => item.selected) || null, ranked };
    },
  });

  const emptyResponse = await fetch(`${base}/api/race`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ candidates: [] }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(emptyResponse.status, 400);

  const raceResponse = await fetch(`${base}/api/race`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      candidates: [
        { provider: "源1", playUrl: "https://media1.example/1.m3u8", type: "m3u8" },
        { provider: "源2", playUrl: "https://media2.example/2.m3u8", type: "m3u8" },
      ],
    }),
    signal: AbortSignal.timeout(5000),
  });
  const raceBody = await raceResponse.json();
  assert.equal(raceResponse.status, 200);
  assert.equal(raceBody.ok, true);
  assert.equal(raceBody.data.selected.provider, "源1");
  assert.equal(raceBody.data.candidates.length, 2);

  const deadResponse = await fetch(`${base}/api/race`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      candidates: [
        { provider: "失效源", playUrl: "https://dead.example/1.m3u8", type: "m3u8" },
      ],
    }),
    signal: AbortSignal.timeout(5000),
  });
  const deadBody = await deadResponse.json();
  assert.equal(deadResponse.status, 200);
  assert.equal(deadBody.data.selected, null);

  const getRaceResponse = await fetch(
    `${base}/api/race?sources=${encodeURIComponent(
      JSON.stringify([
        { provider: "源1", playUrl: "https://media1.example/1.m3u8", type: "m3u8" },
      ]),
    )}`,
    { signal: AbortSignal.timeout(5000) },
  );
  assert.equal(getRaceResponse.status, 200);
});


