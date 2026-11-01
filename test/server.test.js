import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/errors.js";
import { HTTP_CHANNELS, resolveHttpChannel } from "../src/providers/http.js";
import { createChannelHealth } from "../src/channels/health.js";
import { createChannelRegistry } from "../src/channels/registry.js";
import { createServer } from "../src/server.js";
import { createSseParser } from "../public/resolve-stream.js";

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
    // 追加一轮解析的最小间隔：测试里不限流，需要验证限流的用例自己覆盖。
    refreshMinMs: 0,
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 只放行 jx-browser：备用嗅探入口是另一个渠道，不参与需要精确计数或计时的用例。
const jxOnly = (fn) => async (...args) => {
  const options = args[2] || {};
  if (options.provider && options.provider !== "jx-browser") {
    throw new AppError("PARSE_FAILED", 502, "not used in this test");
  }
  return fn(...args);
};

// 读完一次解析事件流（服务端发出 end 后关闭连接），并记下每个事件到达的时间。
async function readResolve(base, url, { refresh = false, after = "", headers = {} } = {}) {
  const startedAt = Date.now();
  const query = new URLSearchParams({ url });
  if (refresh) query.set("refresh", "1");
  if (after) query.set("after", after);
  const response = await fetch(`${base}/api/resolve?${query}`, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    return { response, error: (await response.json()).error, events: [], lines: [], diagnostics: [] };
  }
  const events = [];
  let text = "";
  const parser = createSseParser((event) => events.push({ ...event, at: Date.now() - startedAt }));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    text += chunk;
    parser.push(chunk);
  }
  const of = (type) => events.filter((event) => event.type === type).map((event) => event.data);
  return {
    response,
    text,
    events,
    session: of("session")[0],
    lines: of("line"),
    diagnostics: of("diagnostic"),
    meta: of("meta")[0],
    done: of("done").at(-1),
    failed: of("failed").at(-1),
    ended: events.some((event) => event.type === "end"),
    // 最近一个带编号的事件：下一次接续或追加一轮时作为游标。
    cursor: events.filter((event) => event.id).at(-1)?.id ?? "",
  };
}

const typesOf = (result) => result.events.map((event) => event.type);

test("GET /api/resolve streams the session, a line, metadata and an end marker", async (t) => {
  const { base } = await start(t);
  const result = await readResolve(base, IQIYI);
  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get("content-type"), /^text\/event-stream/);
  assert.equal(result.response.headers.get("x-accel-buffering"), "no", "提示反向代理不要缓冲");
  assert.equal(result.response.headers.get("cache-control"), "no-store, no-transform");

  const order = typesOf(result).filter((type) => ["session", "line", "meta", "done", "end"].includes(type));
  assert.deepEqual(order, ["session", "line", "meta", "done", "end"], "标题补发完才收尾，不会被流结束截断");
  assert.ok(result.session.danmaku.endpoint.startsWith("/api/danmaku?url="));
  assert.equal(result.session.sourceUrl, IQIYI);
  assert.equal(result.lines.length, 1);
  const [line] = result.lines;
  assert.equal(line.type, "m3u8");
  assert.equal(line.provider, "test");
  assert.equal(line.verified, true);
  assert.equal(line.snapshot, false);
  assert.equal(line.playUrl, "https://media.example/video.m3u8", "普通线路直接给原始地址");
  assert.equal(line.host, "media.example");
  assert.match(line.id, /^[A-Za-z0-9]+\.L1$/);
  assert.equal(result.meta.title, "测试视频");
  assert.equal(result.done.lines, 1);
  assert.ok(!result.text.includes("泽御云"));
  assert.ok(!result.text.includes("singleUse"));
});

test("GET /api/resolve supports mp4 results", async (t) => {
  const { base } = await start(t, {
    resolve: async () => fakeResult({ playUrl: "https://media.example/video.mp4", type: "mp4" }),
    validate: async () => ({ playlist: null }),
  });
  const result = await readResolve(base, SAMPLE);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].type, "mp4");
  assert.equal(result.lines[0].segmentHost, "media.example", "mp4 没有分片，分片域名就是文件所在域名");
  assert.equal(result.session.sourceUrl, SAMPLE);
});

// 核心回归：qilin/lx 的清单地址几秒就过期，而解析要 9～17 秒，线路到客户端时已经是死的。
// 现在服务端在有效期内读一次清单做成快照，由本站提供给播放器。
test("a short-lived m3u8 line is snapshotted at once and served from this site", async (t) => {
  const channel = HTTP_CHANNELS.find((item) => item.id === "qilin");
  const media = "https://cdn.example/qilin/index.m3u8?token=t1";
  const playlist = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXTINF:10,",
    "seg1.ts",
    "#EXTINF:10,",
    "https://seg.example/seg2.ts?e=tok",
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
  let requests = 0;
  const validated = [];
  const raced = [];
  const { base } = await start(t, {
    httpChannels: [channel],
    resolve: async () => { throw new AppError("PARSE_FAILED", 502, "no upstream"); },
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
      return { playlist };
    },
    race: async (candidates) => {
      raced.push(candidates[0]);
      const [candidate] = candidates;
      return {
        winner: candidate,
        ranked: [{
          provider: candidate.provider,
          playUrl: candidate.playUrl,
          type: candidate.type,
          speedKBps: 900,
          ttfbMs: 12,
          score: 800,
          available: true,
        }],
      };
    },
  });

  const result = await readResolve(base, SAMPLE);
  assert.equal(requests, 2);
  assert.deepEqual(validated, [media], "清单只读一次，就在有效期内");
  assert.equal(raced[0].stream.playlist, playlist, "测速复用同一份清单，不再请求第二次");
  assert.equal(raced[0].playUrl, media);

  assert.equal(result.lines.length, 1);
  const [line] = result.lines;
  assert.equal(line.provider, "qilin");
  assert.equal(line.snapshot, true);
  assert.equal(line.shortLived, true);
  assert.equal(line.verified, true, "快照线路同样经过流校验和测速");
  assert.equal(line.host, "cdn.example", "保留原始域名供日志使用");
  assert.equal(line.segmentHost, "cdn.example");
  assert.equal(line.score, 800);
  assert.equal("expiresAtMs" in line, false, "有效期由解析会话决定，不再估一个几分钟的假期限");
  assert.match(line.playUrl, /^\/api\/snapshot\?s=[A-Za-z0-9]+&l=L1$/);
  const status = result.diagnostics.find((item) => item.provider === "qilin");
  assert.equal(status.status, "snapshot");

  const snapshot = await fetch(`${base}${line.playUrl}`, { signal: AbortSignal.timeout(5000) });
  assert.equal(snapshot.status, 200);
  assert.match(snapshot.headers.get("content-type"), /mpegurl/);
  assert.equal(snapshot.headers.get("cache-control"), "no-store");
  const text = await snapshot.text();
  assert.match(text, /^https:\/\/cdn\.example\/qilin\/seg1\.ts$/m, "相对分片地址改写成绝对地址");
  assert.match(text, /^https:\/\/seg\.example\/seg2\.ts\?e=tok$/m);
  assert.ok(!JSON.stringify(result.events).includes("synthetic-page-value"));
});

test("a short-lived line that is not a playlist cannot be snapshotted and is passed on unverified", async (t) => {
  const bingdou = HTTP_CHANNELS.find((item) => item.id === "bingdou");
  const validated = [];
  const raced = [];
  const { base } = await start(t, {
    resolve: async () => { throw new AppError("PARSE_FAILED", 502, "no upstream"); },
    httpChannels: [bingdou],
    resolveBingdou: async () => ({ playUrl: "https://media.example/bingdou.mp4", type: "mp4" }),
    resolveHttp: (channel, sourceUrl, options) => resolveHttpChannel(channel, sourceUrl, {
      ...options,
      request: async () => ({ text: '<iframe src="https://jiexi.bot.cd/?url=demo"></iframe>' }),
    }),
    validate: async (url) => { validated.push(url); return { playlist: null }; },
    race: async (candidates) => { raced.push(candidates); return { winner: null, ranked: [] }; },
  });
  const result = await readResolve(base, SAMPLE);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].provider, "bingdou");
  assert.equal(result.lines[0].verified, false);
  assert.equal(result.lines[0].snapshot, false);
  assert.equal(result.lines[0].shortLived, true);
  assert.equal(result.lines[0].playUrl, "https://media.example/bingdou.mp4");
  assert.deepEqual(validated, [], "没有清单可取，服务端不预读");
  assert.deepEqual(raced, []);
  assert.equal(result.diagnostics.find((item) => item.provider === "bingdou").status, "unverified");
});

test("snapshots are served only for known lines and only while the session lives", async (t) => {
  const clock = { now: 1_000_000 };
  const channel = HTTP_CHANNELS.find((item) => item.id === "qilin");
  const { base } = await start(t, {
    now: () => clock.now,
    cacheTtlMs: 60_000,
    httpChannels: [channel],
    resolve: async () => { throw new AppError("PARSE_FAILED", 502, "no upstream"); },
    resolveHttp: async () => ({
      sourceUrl: SAMPLE,
      playUrl: "https://cdn.example/s.m3u8",
      type: "m3u8",
      provider: "qilin",
      shortLived: true,
    }),
    validate: async () => ({ playlist: "#EXTM3U\n#EXTINF:1,\nseg.ts\n" }),
  });
  const result = await readResolve(base, SAMPLE);
  const { playUrl } = result.lines[0];
  const sessionId = new URL(playUrl, base).searchParams.get("s");

  const head = await fetch(`${base}${playUrl}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  for (const query of [
    `s=${sessionId}&l=L9`,
    "s=unknownsession&l=L1",
    `s=${sessionId}`,
    `s=${sessionId}&l=${encodeURIComponent("../L1")}`,
    "",
  ]) {
    const response = await fetch(`${base}/api/snapshot?${query}`);
    assert.equal(response.status, 404, query);
    assert.equal((await response.json()).error.code, "SNAPSHOT_EXPIRED");
  }

  const post = await fetch(`${base}${playUrl}`, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");

  clock.now += 61_000;
  const expired = await fetch(`${base}${playUrl}`);
  assert.equal(expired.status, 404, "会话过期后快照一起失效");
});

test("resolve diagnostics expose per-channel status and timing", async (t) => {
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
  const result = await readResolve(base, SAMPLE);
  const builtIn = result.diagnostics.find((item) => item.provider === "jiexi789");
  assert.equal(builtIn.status, "benchmarked");
  assert.ok(builtIn.ms >= 0);
  const qilin = result.diagnostics.find((item) => item.provider === "qilin");
  assert.equal(qilin.status, "snapshot");
  assert.equal(qilin.shortLived, true);
  assert.equal(qilin.playHost, "cdn.example");
  const failed = result.diagnostics.find((item) => item.provider === "jiexi789-page");
  assert.equal(failed.status, "rejected");
  assert.equal(failed.detail.upstreamCode, 404);
  assert.equal(result.lines.some((item) => item.provider === "jiexi789-page"), false);
});

test("verified HTTP channel lines still pass validation and racing", async (t) => {
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
      const [candidate] = candidates;
      return {
        winner: candidate,
        ranked: [{
          provider: candidate.provider,
          playUrl: candidate.playUrl,
          type: candidate.type,
          speedKBps: 200,
          ttfbMs: 10,
          score: 2000,
          available: true,
        }],
      };
    },
  });
  const result = await readResolve(base, SAMPLE);
  assert.deepEqual(result.lines.map((item) => item.provider).sort(), ["jiexi789-page", "test"]);
  assert.equal(validated, 2);
  assert.equal(raced, 2);
});

// 线路一通过校验和测速就推给观众，不再等其他渠道。
test("lines stream in as each channel finishes instead of waiting for the slow ones", async (t) => {
  const { base } = await start(t, {
    resolve: async () => fakeResult({ provider: "primary", playUrl: "https://media.example/primary.m3u8" }),
    resolveBrowser: jxOnly(async () => {
      await sleep(400);
      return fakeResult({ provider: "jx-browser", playUrl: "https://media.example/browser.m3u8" });
    }),
  });
  const result = await readResolve(base, SAMPLE);
  const lines = result.events.filter((event) => event.type === "line");
  assert.deepEqual(lines.map((event) => event.data.provider), ["primary", "jx-browser"]);
  assert.ok(lines[0].at < 300, `第一条线路不该等慢渠道，实际 ${lines[0].at}ms`);
  assert.ok(lines[1].at >= 350, `慢渠道的线路晚到，实际 ${lines[1].at}ms`);
  const done = result.events.find((event) => event.type === "done");
  assert.ok(done.at >= lines[1].at, "全部渠道结束才发 done");
});

test("metadata never delays the first line and is sent before the round ends", async (t) => {
  const slow = await start(t, {
    enrich: async () => {
      await sleep(300);
      return { title: "慢标题", cover: "https://img.example/c.jpg" };
    },
  });
  const result = await readResolve(slow.base, SAMPLE);
  const line = result.events.find((event) => event.type === "line");
  const meta = result.events.find((event) => event.type === "meta");
  const done = result.events.find((event) => event.type === "done");
  assert.ok(line.at < 250, `起播不等标题，实际 ${line.at}ms`);
  assert.ok(meta.at >= 280);
  assert.equal(meta.data.title, "慢标题");
  assert.ok(done.at >= meta.at);

  const broken = await start(t, { enrich: async () => { throw new Error("metadata offline"); } });
  const fallback = await readResolve(broken.base, SAMPLE);
  assert.equal(fallback.lines.length, 1, "标题失败不影响线路");
  assert.deepEqual(fallback.meta, { title: null, cover: null });
});

test("every viewer of a page joins the same session and replays what already arrived", async (t) => {
  let calls = 0;
  const { base } = await start(t, {
    resolve: async () => {
      calls += 1;
      await sleep(150);
      return fakeResult({ provider: "primary", playUrl: "https://media.example/primary.m3u8" });
    },
  });
  const [early, late] = await Promise.all([
    readResolve(base, SAMPLE),
    (async () => {
      await sleep(40);
      return readResolve(base, SAMPLE);
    })(),
  ]);
  assert.equal(calls, 1, "同一页面的并发请求只解析一次");
  assert.equal(early.lines.length, 1);
  assert.deepEqual(late.lines, early.lines, "后来的观众先回放已有事件，再接收新事件");
  assert.ok(late.ended);

  const after = await readResolve(base, SAMPLE);
  assert.equal(calls, 1, "解析结束后再来的观众也直接回放");
  assert.deepEqual(after.lines, early.lines);
});

test("a viewer can resume from a cursor and only receives later events", async (t) => {
  const { base } = await start(t);
  const full = await readResolve(base, SAMPLE);
  const ids = full.events.filter((event) => event.id).map((event) => event.id);
  assert.ok(ids.length >= 5);

  const byParam = await readResolve(base, SAMPLE, { after: ids[2] });
  assert.deepEqual(byParam.events.filter((event) => event.id).map((event) => event.id), ids.slice(3));
  assert.ok(byParam.ended);

  // EventSource 自动重连时带的是 Last-Event-ID 请求头。
  const byHeader = await readResolve(base, SAMPLE, { headers: { "last-event-id": ids[2] } });
  assert.deepEqual(byHeader.events.filter((event) => event.id).map((event) => event.id), ids.slice(3));

  const foreign = await readResolve(base, SAMPLE, { after: "othersession:99" });
  assert.equal(foreign.events.filter((event) => event.id).length, ids.length, "游标属于别的会话时从头回放");
});

test("a further round appends new lines to the same session when a viewer runs out", async (t) => {
  let calls = 0;
  const { base } = await start(t, {
    resolve: async () => fakeResult({ provider: "primary", playUrl: `https://media.example/v${++calls}.m3u8` }),
    validate: async (url) => ({
      playlist: `#EXTM3U\n#EXTINF:1,\nhttps://seg.example/${url.split("/").pop()}.ts\n`,
    }),
  });
  const first = await readResolve(base, SAMPLE);
  assert.equal(first.lines.length, 1);
  assert.equal(first.lines[0].round, 1);

  const replay = await readResolve(base, SAMPLE);
  assert.equal(calls, 1, "不要求追加时不会重新解析");
  assert.equal(replay.lines.length, 1);

  const refreshed = await readResolve(base, SAMPLE, { refresh: true, after: first.cursor });
  assert.equal(calls, 2);
  assert.equal(refreshed.lines.length, 1, "只收到追加这一轮的新线路");
  assert.equal(refreshed.lines[0].round, 2);
  assert.equal(refreshed.done.round, 2);
  assert.equal(refreshed.done.newLines, 1);
  assert.equal(refreshed.lines[0].id.split(".")[0], first.lines[0].id.split(".")[0], "仍是同一个会话");

  const all = await readResolve(base, SAMPLE);
  assert.equal(all.lines.length, 2, "后来的观众能看到两轮的全部线路");
});

test("further rounds are rate limited so upstreams cannot be hammered", async (t) => {
  let calls = 0;
  const { base } = await start(t, {
    now: () => 1_000_000,
    refreshMinMs: 60_000,
    resolve: async () => fakeResult({ provider: "primary", playUrl: `https://media.example/v${++calls}.m3u8` }),
  });
  const first = await readResolve(base, SAMPLE);
  const refreshed = await readResolve(base, SAMPLE, { refresh: true, after: first.cursor });
  assert.equal(calls, 1, "间隔内的追加请求不会再跑一轮");
  assert.equal(refreshed.lines.length, 0);
  assert.ok(refreshed.ended, "被限流时也正常收尾，客户端据此知道没有新线路");
});

test("a session that found no line is retried by the next viewer", async (t) => {
  let calls = 0;
  const { base } = await start(t, {
    resolve: async () => {
      calls += 1;
      if (calls === 1) throw new AppError("PARSE_FAILED", 502, "no upstream");
      return fakeResult();
    },
  });
  const first = await readResolve(base, SAMPLE);
  assert.equal(first.lines.length, 0);
  assert.equal(first.failed.code, "PARSE_FAILED");
  assert.equal(first.failed.message, "所有解析线路均未能解析该视频");
  assert.ok(first.ended);

  const second = await readResolve(base, SAMPLE);
  assert.equal(calls, 2, "失败不会被当作结果缓存");
  assert.equal(second.lines.length, 1);
});

test("an expired session is replaced and resolves again", async (t) => {
  const clock = { now: 1_000_000 };
  let calls = 0;
  const { base } = await start(t, {
    now: () => clock.now,
    cacheTtlMs: 60_000,
    resolve: async () => {
      calls += 1;
      return fakeResult({ playUrl: `https://media.example/v${calls}.m3u8` });
    },
  });
  const first = await readResolve(base, IQIYI);
  clock.now += 61_000;
  const second = await readResolve(base, IQIYI);
  assert.equal(calls, 2);
  assert.notEqual(second.lines[0].id.split(".")[0], first.lines[0].id.split(".")[0]);
});

test("the stream sends heartbeats while a slow channel is still working", async (t) => {
  const { base } = await start(t, {
    heartbeatMs: 20,
    resolve: async () => {
      await sleep(200);
      return fakeResult();
    },
  });
  const result = await readResolve(base, SAMPLE);
  assert.match(result.text, /^: ping$/m);
  assert.equal(result.lines.length, 1);
});

test("a round fails with a reason when nothing could be played", async (t) => {
  const invalid = await start(t, {
    validate: async () => { throw new AppError("STREAM_INVALID", 502, "invalid"); },
  });
  const first = await readResolve(invalid.base, SAMPLE);
  assert.equal(first.lines.length, 0);
  assert.equal(first.failed.code, "STREAM_INVALID");
  assert.equal(first.failed.message, "所有解析线路均未返回可播放媒体");
  assert.equal(first.done, undefined);

  const stalled = await start(t, { race: async () => ({ winner: null, ranked: [] }) });
  const second = await readResolve(stalled.base, SAMPLE);
  assert.equal(second.failed.code, "STREAM_INVALID");
  assert.equal(second.failed.message, "播放线路测速均未通过");
});

test("benchmark diagnostics carry the reason instead of a bare failure", async (t) => {
  const failed = await start(t, {
    race: async (candidates) => ({
      winner: null,
      ranked: candidates.map((item) => ({ provider: item.provider, available: false, status: 403, selected: false })),
    }),
  });
  const rejected = await readResolve(failed.base, SAMPLE);
  assert.equal(rejected.lines.length, 0, "测速确认不可用的线路不推给观众");
  const rejection = rejected.diagnostics.find((item) => item.status === "benchmark-rejected");
  assert.match(rejection.message, /HTTP 403/);

  // 测速没跑完但内容校验通过：保留为未测速的可用线路，并说明原因。
  const unmeasured = await start(t, {
    race: async (candidates) => ({
      winner: candidates[0],
      ranked: candidates.map((item) => ({
        provider: item.provider,
        playUrl: item.playUrl,
        type: item.type,
        available: true,
        unmeasured: true,
        error: "This operation was aborted",
        speedKBps: 0,
        ttfbMs: null,
        score: 0,
      })),
    }),
  });
  const result = await readResolve(unmeasured.base, SAMPLE);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].verified, true);
  assert.equal(result.lines[0].unmeasured, true);
  assert.equal(result.lines[0].available, true);
  const diag = result.diagnostics[0];
  assert.equal(diag.status, "benchmarked");
  assert.equal(diag.unmeasured, true);
  assert.match(diag.message, /测速未完成.*aborted/);
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
      await sleep(5);
      active -= 1;
      return fakeResult();
    },
    resolveHttp: async (channel) => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(5);
      active -= 1;
      if (channel.id === "jiexi789-page") throw new AppError("PARSE_FAILED", 502, "not supported");
      return fakeResult({
        provider: channel.id,
        playUrl: `https://media.example/${channel.id}.mp4`,
        type: "mp4",
      });
    },
  });
  const result = await readResolve(base, SAMPLE);
  assert.ok(peak <= channels.length + 1);
  assert.equal(result.lines.length, 3);
  assert.equal(result.lines.some((item) => item.provider === "jiexi789-page"), false);
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
    const result = await readResolve(base, source);
    assert.equal(result.response.status, 200);
    assert.equal(result.lines.length, 1, "其他渠道照常出线路");
  }
  assert.equal(calls, 1);
});

// 同一个播放列表域名上分片列表相同的两条线路，前一条失败后后一条几乎必然同样失败：只保留先到的。
test("lines with the same content on the same playlist host are emitted once", async (t) => {
  const { base } = await start(t, {
    resolve: async () => { throw new AppError("PARSE_FAILED", 502, "no upstream"); },
    httpChannels: ["lx", "qilin"].map((id) => HTTP_CHANNELS.find((item) => item.id === id)),
    resolveHttp: async (channel) => ({
      sourceUrl: SAMPLE,
      playUrl: `https://png.example/${channel.id}.m3u8?t=${channel.id}`,
      type: "m3u8",
      provider: channel.id,
      shortLived: true,
    }),
    validate: async (url) => ({
      // 两条线路的分片相同，只是令牌不同。
      playlist: `#EXTM3U\n#EXTINF:1,\nhttps://seg.example/a.ts?e=${url.includes("lx") ? 1 : 2}\n`,
    }),
  });
  const result = await readResolve(base, SAMPLE);
  assert.equal(result.lines.length, 1);
  const duplicates = result.diagnostics.filter((item) => item.status === "duplicate");
  assert.equal(duplicates.length, 1);
  assert.notEqual(duplicates[0].provider, result.lines[0].provider);
});

// 分片相同但播放列表域名不同的线路不是重复：线上正是靠换一个播放列表域名才恢复了播放。
test("the same segments behind a different playlist host are a different line", async (t) => {
  const { base } = await start(t, {
    resolve: async () => { throw new AppError("PARSE_FAILED", 502, "no upstream"); },
    resolveBrowser: jxOnly(async () => fakeResult({ provider: "jx-browser", playUrl: "https://edge-a.example/x.m3u8" })),
    httpChannels: [HTTP_CHANNELS.find((item) => item.id === "jiexi789-page")],
    resolveHttp: async () => fakeResult({ provider: "jiexi789-page", playUrl: "https://edge-b.example/x.m3u8" }),
    validate: async () => ({ playlist: "#EXTM3U\n#EXTINF:1,\nhttps://omts.example/same.ts\n" }),
  });
  const result = await readResolve(base, SAMPLE);
  assert.deepEqual(result.lines.map((item) => item.host).sort(), ["edge-a.example", "edge-b.example"]);
  assert.equal(result.lines.every((item) => item.segmentHost === "omts.example"), true);
});

test("a fallback channel runs only when no verified line exists", async (t) => {
  const bingdou = HTTP_CHANNELS.find((item) => item.id === "bingdou");
  const run = async (primaryResolve, extra = {}) => {
    let browserCalls = 0;
    const { base } = await start(t, {
      resolve: primaryResolve,
      httpChannels: [bingdou, ...(extra.channels || [])],
      resolveBingdou: async () => {
        browserCalls += 1;
        return { playUrl: "https://media.example/bingdou.mp4", type: "mp4" };
      },
      resolveHttp: (channel, sourceUrl, options) => resolveHttpChannel(channel, sourceUrl, {
        ...options,
        request: extra.request || (async () => ({ text: '<iframe src="https://jiexi.bot.cd/?url=demo"></iframe>' })),
      }),
    });
    return { result: await readResolve(base, SAMPLE), browserCalls };
  };

  const primaryOk = await run(async () => fakeResult());
  assert.deepEqual(primaryOk.result.lines.map((item) => item.provider), ["test"]);
  assert.equal(primaryOk.browserCalls, 0);
  assert.equal(
    primaryOk.result.diagnostics.find((item) => item.provider === "bingdou").status,
    "fallback-skipped",
  );

  const primaryFailed = await run(async () => {
    throw new AppError("PARSE_FAILED", 502, "no upstream");
  });
  assert.deepEqual(primaryFailed.result.lines.map((item) => item.provider), ["bingdou"]);
  assert.equal(primaryFailed.browserCalls, 1);
});

test("a snapshot line counts as a verified line, so the fallback channel stays idle", async (t) => {
  const qilin = HTTP_CHANNELS.find((item) => item.id === "qilin");
  const bingdou = HTTP_CHANNELS.find((item) => item.id === "bingdou");
  let browserCalls = 0;
  const { base } = await start(t, {
    resolve: async () => { throw new AppError("PARSE_FAILED", 502, "no upstream"); },
    httpChannels: [qilin, bingdou],
    resolveBingdou: async () => {
      browserCalls += 1;
      return { playUrl: "https://media.example/bingdou.mp4", type: "mp4" };
    },
    resolveHttp: async (channel) => channel.id === "qilin"
      ? { sourceUrl: SAMPLE, playUrl: "https://media.example/qilin.m3u8", type: "m3u8", provider: "qilin", shortLived: true }
      : { sourceUrl: SAMPLE, playUrl: "https://media.example/bingdou.mp4", type: "mp4", provider: "bingdou", shortLived: true },
    validate: async () => ({ playlist: "#EXTM3U\n#EXTINF:1,\nseg.ts\n" }),
  });
  const result = await readResolve(base, SAMPLE);
  assert.deepEqual(result.lines.map((item) => item.provider), ["qilin"]);
  assert.equal(browserCalls, 0);
});

// 渠道健康：连续几个自然日都没有可用结果的渠道会被摘除，之后不再参与解析。
test("resolve records outcomes by natural day and drops a channel after three dead days", async (t) => {
  const clock = { now: Date.UTC(2026, 9, 1, 12) };
  const health = createChannelHealth({ now: () => clock.now, timeZone: "UTC" });
  const registry = createChannelRegistry({
    builtins: [{ id: "lx", name: "LX解析", endpoint: "https://jx.example.com/?url=", shortLived: true }],
    health,
    now: () => clock.now,
  });
  const calls = [];
  const { base } = await start(t, {
    channelRegistry: registry,
    now: () => clock.now,
    resolve: async () => fakeResult({ provider: "primary", playUrl: "https://media.example/primary.m3u8" }),
    resolveHttp: async (channel) => {
      calls.push(channel.id);
      return null;
    },
  });
  // 每次都要求追加一轮，让渠道真的再跑一遍；游标让结果只包含这一轮的事件。
  let cursor = "";
  const resolveAgain = async () => {
    const result = await readResolve(base, SAMPLE, { refresh: true, after: cursor });
    cursor = result.cursor || cursor;
    return result;
  };

  for (const day of [1, 2, 3]) {
    clock.now = Date.UTC(2026, 9, day, 12);
    cursor = "";
    for (let i = 0; i < 3; i += 1) {
      const result = await resolveAgain();
      const lx = result.diagnostics.find((item) => item.provider === "lx");
      assert.equal(lx.status, "empty", "无结果");
    }
  }
  assert.equal(calls.length, 9);
  assert.equal(health.isRemoved("lx"), false, "第 3 天还没结束");

  clock.now = Date.UTC(2026, 9, 4, 8);
  cursor = "";
  const afterDay = await resolveAgain();
  assert.equal(afterDay.response.status, 200);
  assert.equal(health.isRemoved("lx"), true, "跨天后第一次解析完成就结算");

  const before = calls.length;
  const next = await resolveAgain();
  assert.equal(calls.length, before, "已摘除的渠道不再被调用");
  assert.equal(next.diagnostics.some((item) => item.provider === "lx"), false);
  assert.equal(next.diagnostics.some((item) => item.provider === "jiexi789"), true);

  const status = await getJson(`${base}/api/channels`);
  const lx = status.body.data.channels.find((item) => item.id === "lx");
  assert.equal(lx.state, "removed");
  assert.equal(lx.reason, "连续 3 个自然日不可用");
  const primary = status.body.data.channels.find((item) => item.id === "jiexi789");
  assert.equal(primary.state, "active");
  assert.equal(status.body.data.remote.configured, false);
  assert.equal(JSON.stringify(status.body).includes("jx.example.com"), false, "不暴露渠道地址");
});

// 被摘除的渠道每隔一段时间放回一轮解析里试探一次：失败继续等，成功就自动复活。
test("a removed channel is probed once per interval and revived by a successful probe", async (t) => {
  const clock = { now: Date.UTC(2026, 9, 1, 12) };
  const health = createChannelHealth({
    now: () => clock.now,
    timeZone: "UTC",
    deadDays: 1,
    probeIntervalMs: 3_600_000,
  });
  const registry = createChannelRegistry({
    builtins: [{ id: "lx", name: "LX解析", endpoint: "https://jx.example.com/?url=", shortLived: true }],
    health,
    now: () => clock.now,
  });
  let lxWorks = false;
  const calls = [];
  const { base } = await start(t, {
    channelRegistry: registry,
    now: () => clock.now,
    resolve: async () => fakeResult({ provider: "primary", playUrl: "https://media.example/primary.m3u8" }),
    resolveHttp: async (channel) => {
      calls.push(channel.id);
      return lxWorks
        ? { sourceUrl: SAMPLE, playUrl: "https://media.example/lx.m3u8", type: "m3u8", provider: "lx", shortLived: true }
        : null;
    },
    validate: async (url) => ({ playlist: "#EXTM3U\n#EXTINF:1,\n" + (url.includes("lx") ? "lx" : "primary") + "-seg.ts\n" }),
  });
  let cursor = "";
  const resolveAgain = async () => {
    const result = await readResolve(base, SAMPLE, { refresh: true, after: cursor });
    cursor = result.cursor || cursor;
    return result;
  };

  for (let i = 0; i < 3; i += 1) await resolveAgain();
  clock.now = Date.UTC(2026, 9, 2, 8);
  cursor = "";
  await resolveAgain();
  assert.equal(health.isRemoved("lx"), true, "第 1 天 3 次都没有结果，跨天后被摘除");

  const removedAt = calls.length;
  const early = await resolveAgain();
  assert.equal(calls.length, removedAt, "没到试探时间，不调用");
  assert.equal(early.diagnostics.some((item) => item.provider === "lx"), false);

  clock.now += 3_600_000;
  const attemptsBefore = health.status("lx").today.attempts;
  const failedProbe = await resolveAgain();
  assert.equal(calls.length, removedAt + 1, "到了试探时间，放回这一轮跑一次");
  assert.equal(failedProbe.diagnostics.find((item) => item.provider === "lx").status, "empty");
  assert.equal(health.isRemoved("lx"), true, "试探失败仍然是摘除状态");
  assert.equal(health.status("lx").removed.probeFailures, 1);
  assert.equal(health.status("lx").today.attempts, attemptsBefore, "试探不进入当天统计");

  await resolveAgain();
  assert.equal(calls.length, removedAt + 1, "失败后要等下一个间隔，不会每轮都试");

  clock.now += 3_600_000;
  lxWorks = true;
  const revived = await resolveAgain();
  assert.equal(health.isRemoved("lx"), false, "试探拿到可用线路，自动复活");
  assert.ok(revived.lines.some((item) => item.provider === "lx"), "试探产出的线路照常推给观众");

  const status = await getJson(`${base}/api/channels`);
  assert.equal(status.body.data.channels.find((item) => item.id === "lx").state, "active");

  const before = calls.length;
  await resolveAgain();
  assert.equal(calls.length, before + 1, "复活后作为普通渠道每轮调用");
});

test("local environment failures and cooldown skips are not counted against a channel", async (t) => {
  const health = createChannelHealth({ timeZone: "UTC" });
  const registry = createChannelRegistry({
    builtins: [{ id: "bingdou", name: "冰豆", endpoint: "https://bd.example.com/?url=", shortLived: true, fallback: true }],
    health,
  });
  const { base } = await start(t, {
    channelRegistry: registry,
    resolve: async () => { throw new AppError("STREAM_INVALID", 502, "primary down"); },
    resolveHttp: async () => { throw new AppError("BROWSER_UNAVAILABLE", 503, "冰豆渠道需要无头 Chrome"); },
  });
  await readResolve(base, SAMPLE);
  assert.equal(health.status("bingdou").today.attempts, 0, "没装 Chrome 是本机问题，不算渠道失败");
  assert.equal(health.status("jiexi789").today.attempts, 1);
  assert.equal(health.status("jiexi789").today.successes, 0);
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

test("GET /api/resolve rejects missing and non-http URLs", async (t) => {
  const { base } = await start(t);
  const missing = await getJson(`${base}/api/resolve`);
  assert.equal(missing.response.status, 400);
  assert.equal(missing.body.error.code, "INVALID_URL");
  const ftp = await getJson(
    `${base}/api/resolve?url=${encodeURIComponent("ftp://example.com/video")}`,
  );
  assert.equal(ftp.response.status, 400);
  assert.equal(ftp.body.error.code, "INVALID_URL");
});

test("/api/resolve is GET only, and the retired parse and race endpoints are gone", async (t) => {
  const { base } = await start(t);
  const response = await fetch(`${base}/api/resolve`, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json();
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
  assert.equal(body.error.code, "METHOD_NOT_ALLOWED");

  for (const retired of ["/api/parse?url=https%3A%2F%2Fwww.iqiyi.com%2Fv_1.html", "/api/race"]) {
    const gone = await fetch(`${base}${retired}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(gone.status, 404, retired);
    assert.equal((await gone.json()).error.code, "NOT_FOUND");
  }
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

test("front-end script modules are served", async (t) => {
  const { base } = await start(t);
  for (const asset of ["/app.js", "/ad-filter.js", "/danmaku-text.js", "/stall-monitor.js", "/line-book.js", "/resolve-stream.js"]) {
    const response = await fetch(`${base}${asset}`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, asset);
    assert.match(response.headers.get("content-type"), /javascript/);
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

test("POST /api/channels requires dev password and incrementally upserts/deletes channels", async (t) => {
  const { base } = await start(t);

  const unauth = await getJson(`${base}/api/channels`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channels: [] }),
  });
  assert.equal(unauth.response.status, 401);
  assert.equal(unauth.body.ok, false);

  const authHeaders = {
    "content-type": "application/json",
    "x-dev-password": "adminysdev",
  };

  const update = await getJson(`${base}/api/channels`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      channels: [
        {
          id: "custom-browser",
          name: "自定义嗅探源",
          type: "browser",
          endpoint: "https://bfq.example.com/player?url=",
        },
        {
          id: "custom-http",
          name: "自定义HTTP",
          type: "http-api",
          endpoint: "https://http.example.com/?url=",
        },
      ],
    }),
  });

  assert.equal(update.response.status, 200);
  assert.equal(update.body.ok, true);
  assert.equal(update.body.data.accepted.length, 2);
  assert.equal(update.body.data.rejected.length, 0);

  // 单独禁用其中一个渠道，不应冲掉另一个自定义渠道，且保留原名称与配置。
  await getJson(`${base}/api/channels`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      channels: [{ id: "custom-browser", enabled: false }],
    }),
  });

  let status = await getJson(`${base}/api/channels`);
  let foundBrowser = status.body.data.channels.find((c) => c.id === "custom-browser");
  let foundHttp = status.body.data.channels.find((c) => c.id === "custom-http");
  assert.equal(foundBrowser?.state, "disabled");
  assert.equal(foundBrowser?.name, "自定义嗅探源");
  assert.equal(foundHttp?.state, "active", "增量禁用不应影响其他自定义渠道");

  // 再次启用自定义渠道时，即使只传 { id, enabled: true } 也能恢复原有 endpoint 与名称。
  await getJson(`${base}/api/channels`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      channels: [{ id: "custom-browser", enabled: true }],
    }),
  });
  status = await getJson(`${base}/api/channels`);
  foundBrowser = status.body.data.channels.find((c) => c.id === "custom-browser");
  assert.equal(foundBrowser?.state, "active");
  assert.equal(foundBrowser?.name, "自定义嗅探源");
  assert.equal(foundBrowser?.custom, true);

  // 删除自定义渠道后应从列表移除。
  await getJson(`${base}/api/channels`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      channels: [{ id: "custom-browser", deleted: true }],
    }),
  });
  status = await getJson(`${base}/api/channels`);
  assert.equal(status.body.data.channels.some((c) => c.id === "custom-browser"), false);
});


test("a failed benchmark releases the content key so an identical line gets its own chance", async (t) => {
  let benchmarked = 0;
  const { base } = await start(t, {
    resolve: async () => { throw new AppError("PARSE_FAILED", 502, "no upstream"); },
    httpChannels: ["lx", "qilin"].map((id) => HTTP_CHANNELS.find((item) => item.id === id)),
    resolveHttp: async (channel) => {
      // qilin 稍晚到达，此时 lx 的测速已经失败。
      if (channel.id === "qilin") await sleep(80);
      return {
        sourceUrl: SAMPLE,
        playUrl: `https://png.example/${channel.id}.m3u8?t=${channel.id}`,
        type: "m3u8",
        provider: channel.id,
        shortLived: true,
      };
    },
    validate: async () => ({ playlist: "#EXTM3U\n#EXTINF:1,\nhttps://seg.example/a.ts\n" }),
    race: async (candidates) => {
      benchmarked += 1;
      const [candidate] = candidates;
      // 第一次测速失败（临时问题），第二次成功。
      if (benchmarked === 1) return { winner: null, ranked: [{ provider: candidate.provider, available: false, status: 503 }] };
      return {
        winner: candidate,
        ranked: [{ provider: candidate.provider, playUrl: candidate.playUrl, type: candidate.type, available: true, score: 10 }],
      };
    },
  });
  const result = await readResolve(base, SAMPLE);
  assert.equal(benchmarked, 2);
  assert.deepEqual(result.lines.map((item) => item.provider), ["qilin"]);
  assert.equal(result.diagnostics.filter((item) => item.status === "duplicate").length, 0);
});
