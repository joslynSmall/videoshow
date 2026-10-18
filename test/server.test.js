import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/errors.js";
import { HTTP_CHANNELS, resolveHttpChannel } from "../src/providers/http.js";
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
    httpChannels: [],
    validate: async () => ({ playlist: "#EXTM3U" }),
    guardMedia: async () => {},
    race: async (candidates) => ({
      winner: candidates[0] || null,
      ranked: candidates.map((item, index) => ({
        provider: item.provider,
        playUrl: item.playUrl,
        type: item.type,
        available: true,
        selected: index === 0,
      })),
    }),
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

test("qilin API success becomes a single-use fallback without server media reads", async (t) => {
  const channel = HTTP_CHANNELS.find((item) => item.id === "qilin");
  const media = "https://cdn.example/qilin.m3u8";
  let requests = 0;
  const validated = [];
  const raced = [];
  const { base } = await start(t, {
    httpChannels: [channel],
    resolveHttp: (entry, sourceUrl, options) => resolveHttpChannel(entry, sourceUrl, {
      ...options,
      request: async () => ({
        text: ++requests === 1
          ? '<script>const playerConfig = { apiToken: "synthetic-page-value" };</script>'
          : JSON.stringify({ code: 200, url: media, type: "m3u8" }),
      }),
    }),
    validate: async (url) => {
      validated.push(url);
      return { playlist: "#EXTM3U" };
    },
    race: async (candidates) => {
      raced.push(...candidates.map((item) => item.provider));
      const candidate = candidates[0];
      return {
        winner: candidate,
        ranked: [{
          provider: candidate.provider,
          playUrl: candidate.playUrl,
          type: candidate.type,
          speedKBps: 1000,
          ttfbMs: 100,
          score: 10000,
          available: true,
          selected: true,
        }],
      };
    },
  });

  const { response, body } = await getJson(`${base}/api/parse?url=${encodeURIComponent(SAMPLE)}`);
  assert.equal(response.status, 200);
  assert.equal(body.data.provider, "test");
  assert.equal(requests, 2);
  assert.equal(validated.includes(media), false);
  assert.deepEqual(raced, ["test"]);
  const qilin = body.data.candidates.find((item) => item.provider === "qilin");
  assert.equal(qilin.singleUse, true);
  assert.equal(qilin.available, true);
  assert.equal(qilin.verified, false);
  assert.ok(!JSON.stringify(body).includes("synthetic-page-value"));
});

test("parse diagnostics expose per-channel status and timing", async (t) => {
  const channel = HTTP_CHANNELS.find((item) => item.id === "qilin");
  const pageChannel = HTTP_CHANNELS.find((item) => item.id === "jiexi789-page");
  const media = "https://cdn.example/diagnostics.m3u8";
  let requests = 0;
  const { base } = await start(t, {
    httpChannels: [channel, pageChannel],
    resolveHttp: (entry, sourceUrl, options) => {
      if (entry.id === "jiexi789-page") {
        throw new AppError("PARSE_FAILED", 502, "上游解析失败，请稍后重试", {
          detail: { upstreamCode: 404 },
        });
      }
      return resolveHttpChannel(entry, sourceUrl, {
        ...options,
        request: async () => ({
          text: ++requests === 1
            ? '<script>const playerConfig = { apiToken: "synthetic" };</script>'
            : JSON.stringify({ code: 200, url: media, type: "m3u8" }),
        }),
      });
    },
  });
  const { response, body } = await getJson(`${base}/api/parse?url=${encodeURIComponent(SAMPLE)}`);
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.data.diagnostics));
  const builtIn = body.data.diagnostics.find((item) => item.provider === "jiexi789");
  assert.equal(builtIn.status, "benchmarked");
  assert.ok(builtIn.ms >= 0);
  const qilin = body.data.diagnostics.find((item) => item.provider === "qilin");
  assert.equal(qilin.status, "single-use");
  assert.equal(qilin.singleUse, true);
  assert.equal(qilin.playHost, "cdn.example");
  assert.ok(qilin.ms >= 0);
  const failed = body.data.diagnostics.find((item) => item.provider === "jiexi789-page");
  assert.equal(failed.status, "rejected");
  assert.equal(failed.detail.upstreamCode, 404);
});

test("verified HTTP channel candidates still pass validation and racing", async (t) => {
  const channel = HTTP_CHANNELS.find((item) => item.id === "jiexi789-page");
  let validated = 0;
  let raced = 0;
  const { base } = await start(t, {
    httpChannels: [channel],
    resolveHttp: async () => fakeResult({
      provider: "jiexi789-page",
      playUrl: "https://media.example/jiexi789-page.mp4",
      type: "mp4",
    }),
    validate: async () => {
      validated += 1;
      return { playlist: "#EXTM3U" };
    },
    race: async (candidates) => {
      raced += 1;
      const candidate = candidates[0];
      return {
        winner: candidate,
        ranked: [{
          provider: candidate.provider,
          playUrl: candidate.playUrl,
          type: candidate.type,
          speedKBps: candidate.provider === "jiexi789-page" ? 200 : 100,
          ttfbMs: 10,
          score: candidate.provider === "jiexi789-page" ? 2000 : 1000,
          available: true,
          selected: true,
        }],
      };
    },
  });

  const { response, body } = await getJson(`${base}/api/parse?url=${encodeURIComponent(SAMPLE)}`);
  assert.equal(response.status, 200);
  assert.equal(body.data.provider, "jiexi789-page");
  assert.ok(validated >= 2);
  assert.equal(raced, 2);
});

test("single-use candidates are returned by parse and /api/race without media reads", async (t) => {
  let raced = 0;
  const { base } = await start(t, {
    resolve: async () => { throw new AppError("PARSE_FAILED", 502, "no upstream"); },
    httpChannels: [HTTP_CHANNELS.find((item) => item.id === "qilin")],
    resolveHttp: async () => ({
      sourceUrl: SAMPLE,
      playUrl: "https://media.example/single-use.m3u8",
      type: "m3u8",
      provider: "qilin",
      singleUse: true,
      expiresAtMs: Date.now() + 60_000,
    }),
    race: async () => {
      raced += 1;
      return { winner: null, ranked: [] };
    },
  });

  const parse = await getJson(`${base}/api/parse?url=${encodeURIComponent(SAMPLE)}`);
  assert.equal(parse.response.status, 200);
  assert.equal(parse.body.data.provider, "qilin");
  assert.equal(parse.body.data.singleUse, true);

  const race = await getJson(`${base}/api/race`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceUrl: SAMPLE }),
  });
  assert.equal(race.response.status, 200);
  assert.equal(race.body.data.selected.provider, "qilin");
  assert.equal(race.body.data.selected.singleUse, true);
  assert.deepEqual(race.body.data.filtered, {
    total: 1,
    excluded: 0,
    expired: 0,
    remaining: 1,
  });
  assert.equal(raced, 0);

  const exhausted = await getJson(`${base}/api/race`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceUrl: SAMPLE,
      failedPlayUrls: ["https://media.example/single-use.m3u8"],
    }),
  });
  assert.equal(exhausted.response.status, 200);
  assert.equal(exhausted.body.data.selected, null);
  assert.deepEqual(exhausted.body.data.filtered, {
    total: 1,
    excluded: 1,
    expired: 0,
    remaining: 0,
  });
});

// 回归：单次签名候选的过期时间必须随候选进入缓存。
// 之前 expiresAtMs 只挂在 candidate 上，缓存里的 ranked 全是 undefined，
// /api/race 的过期过滤因此失效，表现为“刚解析完就全部过期”。
test("single-use candidates carry expiresAtMs into parse and race", async (t) => {
  const expiresAtMs = Date.now() + 240_000;
  const { base } = await start(t, {
    resolve: async () => { throw new AppError("PARSE_FAILED", 502, "no upstream"); },
    httpChannels: [HTTP_CHANNELS.find((item) => item.id === "qilin")],
    resolveHttp: async () => ({
      sourceUrl: SAMPLE,
      playUrl: "https://media.example/single-use.m3u8",
      type: "m3u8",
      provider: "qilin",
      singleUse: true,
      expiresAtMs,
    }),
    race: async () => ({ winner: null, ranked: [] }),
  });

  const parse = await getJson(`${base}/api/parse?url=${encodeURIComponent(SAMPLE)}`);
  assert.equal(parse.response.status, 200);
  const candidate = parse.body.data.candidates.find((item) => item.singleUse);
  assert.ok(candidate, "single-use candidate should be present");
  assert.equal(candidate.expiresAtMs, expiresAtMs, "parse response must expose expiresAtMs");

  const race = await getJson(`${base}/api/race`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceUrl: SAMPLE }),
  });
  assert.equal(race.body.data.selected.provider, "qilin");
  assert.equal(race.body.data.filtered.expired, 0, "a fresh link must not be counted as expired");
  assert.equal(race.body.data.filtered.remaining, 1);
});

// 回归：换线后“重新解析以刷新单次签名地址”必须真的重新解析。
// 之前 parse() 命中缓存直接返回旧数据，过期候选永远刷不新。
test("/api/parse?force=1 bypasses the cache to refresh expiring links", async (t) => {
  let calls = 0;
  const { base } = await start(t, {
    resolve: async () => {
      calls += 1;
      return fakeResult({ playUrl: `https://media.example/video-${calls}.m3u8` });
    },
  });

  const first = await getJson(`${base}/api/parse?url=${encodeURIComponent(SAMPLE)}`);
  assert.equal(first.response.status, 200);
  assert.equal(first.body.data.cached, false);
  assert.equal(calls, 1);

  const cached = await getJson(`${base}/api/parse?url=${encodeURIComponent(SAMPLE)}`);
  assert.equal(cached.body.data.cached, true, "second call should hit the cache");
  assert.equal(calls, 1, "cached parse must not call the resolver again");

  const forced = await getJson(`${base}/api/parse?url=${encodeURIComponent(SAMPLE)}&force=1`);
  assert.equal(forced.response.status, 200);
  assert.equal(forced.body.data.cached, false, "force=1 must bypass the cache");
  assert.equal(calls, 2, "force=1 must re-run the resolver");
});

test("bingdou runs only when primary channels have no available candidate", async (t) => {
  const bingdou = HTTP_CHANNELS.find((item) => item.id === "bingdou");
  const run = async (primaryResolve) => {
    let browserCalls = 0;
    const { base } = await start(t, {
      resolve: primaryResolve,
      httpChannels: [bingdou],
      resolveBingdou: async () => {
        browserCalls += 1;
        return { playUrl: "https://media.example/bingdou.mp4", type: "mp4" };
      },
      resolveHttp: (channel, sourceUrl, options) => resolveHttpChannel(channel, sourceUrl, {
        ...options,
        request: async () => ({ text: '<iframe src="https://jiexi.bot.cd/?url=demo"></iframe>' }),
      }),
    });
    const { response, body } = await getJson(`${base}/api/parse?url=${encodeURIComponent(SAMPLE)}`);
    return { response, body, browserCalls };
  };

  const primaryOk = await run(async () => fakeResult());
  assert.equal(primaryOk.response.status, 200);
  assert.equal(primaryOk.body.data.provider, "test");
  assert.equal(primaryOk.browserCalls, 0);

  const primaryFailed = await run(async () => {
    throw new AppError("PARSE_FAILED", 502, "no upstream");
  });
  assert.equal(primaryFailed.response.status, 200);
  assert.equal(primaryFailed.body.data.provider, "bingdou");
  assert.equal(primaryFailed.body.data.singleUse, true);
  assert.equal(primaryFailed.browserCalls, 1);
});

test("bingdou still runs when only single-use primaries are available", async (t) => {
  const qilin = HTTP_CHANNELS.find((item) => item.id === "qilin");
  const bingdou = HTTP_CHANNELS.find((item) => item.id === "bingdou");
  let browserCalls = 0;
  let qilinRequests = 0;
  const { base } = await start(t, {
    resolve: async () => { throw new AppError("PARSE_FAILED", 502, "no upstream"); },
    httpChannels: [qilin, bingdou],
    resolveBingdou: async () => {
      browserCalls += 1;
      return { playUrl: "https://media.example/bingdou.mp4", type: "mp4" };
    },
    resolveHttp: (channel, sourceUrl, options) => {
      if (channel.id === "bingdou") {
        return resolveHttpChannel(channel, sourceUrl, {
          ...options,
          request: async () => ({
            text: '<iframe src="https://jiexi.bot.cd/?url=demo"></iframe>',
          }),
        });
      }
      return resolveHttpChannel(channel, sourceUrl, {
        ...options,
        request: async () => ({
          text: ++qilinRequests === 1
            ? '<script>const playerConfig = { apiToken: "synthetic" };</script>'
            : JSON.stringify({ code: 200, url: "https://media.example/qilin.m3u8", type: "m3u8" }),
        }),
      });
    },
  });
  const { response, body } = await getJson(`${base}/api/parse?url=${encodeURIComponent(SAMPLE)}`);
  assert.equal(response.status, 200);
  assert.equal(browserCalls, 1);
  const providers = body.data.candidates.map((item) => item.provider);
  assert.ok(providers.includes("qilin"));
  assert.ok(providers.includes("bingdou"));
  assert.equal(
    body.data.diagnostics.some((item) => item.provider === "bingdou" && item.status === "single-use"),
    true,
  );
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
    race: async (candidates) => {
      const candidate = candidates[0];
      const fast = candidate.provider === "jx-browser";
      return {
        winner: candidate,
        ranked: [{
          provider: candidate.provider,
          playUrl: candidate.playUrl,
          type: candidate.type,
          speedKBps: fast ? 3500 : 110,
          ttfbMs: fast ? 80 : 2500,
          score: fast ? 43750 : 44,
          available: true,
          selected: true,
        }],
      };
    },
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

test("GET /api/media relays a parsed stream and rejects a missing url", async (t) => {
  const missingServer = await start(t);
  const missing = await fetch(`${missingServer.base}/api/media`);
  const missingBody = await missing.json();
  assert.equal(missing.status, 400);
  assert.equal(missingBody.error.code, "BAD_REQUEST");

  const { base } = await start(t, {
    openMediaFn: async () =>
      new Response("#EXTM3U\n", {
        status: 200,
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      }),
  });
  const response = await fetch(`${base}/api/media?url=${encodeURIComponent("https://cdn.example/a.m3u8")}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /mpegurl/);
  assert.equal(await response.text(), "#EXTM3U\n");
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

test("GET /api/site-search returns only sites that have pages", async (t) => {
  const { base } = await start(t, {
    searchSitesFn: async () => [
      {
        id: "qq",
        name: "腾讯视频",
        items: [{ title: "繁花", pageUrl: "https://v.qq.com/x/cover/abc.html", cover: "", remarks: "", desc: "" }],
      },
    ],
  });
  const { response, body } = await getJson(
    `${base}/api/site-search?kw=${encodeURIComponent("繁花")}`,
  );
  assert.equal(response.status, 200);
  assert.equal(body.data.sites[0].id, "qq");
  assert.equal(body.data.sites[0].items[0].title, "繁花");
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

test("/api/race only benchmarks verified candidates from a prior parse", async (t) => {
  const { base } = await start(t, {
    resolveBrowser: async () => fakeResult({
      provider: "backup",
      playUrl: "https://media.example/backup.mp4",
      type: "mp4",
    }),
    resolve: async () => fakeResult({ provider: "primary" }),
    race: async (candidates) => {
      const ranked = candidates.map((c, idx) => {
        return {
          ...c,
          speedKBps: idx === 0 ? 3000 : 1500,
          ttfbMs: idx === 0 ? 100 : 200,
          available: true,
          selected: idx === 0,
        };
      });
      return { winner: ranked[0] || null, ranked };
    },
  });

  const untrustedResponse = await fetch(`${base}/api/race`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      candidates: [{ provider: "arbitrary", playUrl: "http://127.0.0.1/private" }],
    }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(untrustedResponse.status, 400);

  const parse = await getJson(`${base}/api/parse?url=${encodeURIComponent(SAMPLE)}`);
  assert.equal(parse.response.status, 200);
  const raceResponse = await fetch(`${base}/api/race`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceUrl: SAMPLE, failedPlayUrls: ["https://media.example/video.m3u8"] }),
    signal: AbortSignal.timeout(5000),
  });
  const raceBody = await raceResponse.json();
  assert.equal(raceResponse.status, 200);
  assert.equal(raceBody.ok, true);
  assert.equal(raceBody.data.selected.provider, "backup");
  assert.equal(raceBody.data.candidates.length, 1);

  const exhaustedResponse = await fetch(`${base}/api/race`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceUrl: SAMPLE,
      failedPlayUrls: ["https://media.example/video.m3u8", "https://media.example/backup.mp4"],
    }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(exhaustedResponse.status, 200);
  assert.equal((await exhaustedResponse.json()).data.selected, null);

  const getRaceResponse = await fetch(`${base}/api/race?sources=%5B%5D`);
  assert.equal(getRaceResponse.status, 405);
});

test("parse rejects candidates when validation or benchmarking fails", async (t) => {
  const invalid = await start(t, {
    validate: async () => { throw new AppError("STREAM_INVALID", 502, "invalid"); },
  });
  const first = await getJson(`${invalid.base}/api/parse?url=${encodeURIComponent(SAMPLE)}`);
  assert.equal(first.response.status, 502);
  assert.equal(first.body.error.code, "STREAM_INVALID");

  const stalled = await start(t, {
    race: async () => ({ winner: null, ranked: [] }),
  });
  const second = await getJson(`${stalled.base}/api/parse?url=${encodeURIComponent(SAMPLE)}`);
  assert.equal(second.response.status, 502);
  assert.equal(second.body.error.code, "STREAM_INVALID");
});

test("HTTP channel failures are isolated and resolution stays bounded", async (t) => {
  let active = 0;
  let peak = 0;
  const channels = HTTP_CHANNELS.filter((item) => !item.fallback);
  const { base } = await start(t, {
    httpChannels: channels,
    resolve: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return fakeResult();
    },
    resolveHttp: async (channel) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (channel.id === "jiexi789-page") throw new AppError("PARSE_FAILED", 502, "not supported");
      return fakeResult({
        provider: channel.id,
        playUrl: `https://media.example/${channel.id}.mp4`,
        type: "mp4",
      });
    },
  });
  const { response, body } = await getJson(`${base}/api/parse?url=${encodeURIComponent(SAMPLE)}`);
  assert.equal(response.status, 200);
  assert.ok(peak <= channels.length + 1);
  assert.equal(body.data.candidates.length, 3);
  assert.equal(body.data.candidates.some((item) => item.provider === "jiexi789-page"), false);
});

test("an upstream failure briefly cools down only that channel", async (t) => {
  let calls = 0;
  const { base } = await start(t, {
    httpChannels: [HTTP_CHANNELS[0]],
    resolveHttp: async () => {
      calls += 1;
      throw new AppError("UPSTREAM_ERROR", 502, "offline");
    },
  });
  for (const source of [SAMPLE, IQIYI]) {
    const { response } = await getJson(`${base}/api/parse?url=${encodeURIComponent(source)}`);
    assert.equal(response.status, 200);
  }
  assert.equal(calls, 1);
});


