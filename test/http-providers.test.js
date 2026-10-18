import assert from "node:assert/strict";
import test from "node:test";
import {
  HTTP_CHANNELS,
  enabledHttpChannels,
  extractHttpPlayUrl,
  resolveHttpChannel,
} from "../src/providers/http.js";

const SOURCE = "https://www.iqiyi.com/v_demo.html?from=a&v=1";
const MEDIA = "https://cdn.example/video.m3u8";

test("all configured HTTP entrances are enabled by default and can be filtered", () => {
  assert.equal(HTTP_CHANNELS.length, 4);
  assert.deepEqual(
    enabledHttpChannels(null).map((item) => item.id),
    HTTP_CHANNELS.map((item) => item.id),
  );
  assert.deepEqual(enabledHttpChannels([]), []);
  assert.deepEqual(enabledHttpChannels(["qilin", "lx"]).map((item) => item.id), ["lx", "qilin"]);
  assert.throws(() => enabledHttpChannels(["qige"]), /Unknown HTTP channel/);
  assert.throws(() => enabledHttpChannels(["txnq"]), /Unknown HTTP channel/);
  assert.throws(() => enabledHttpChannels(["unknown"]), /Unknown HTTP channel/);
});

test("bingdou verifies the entry iframe and delegates to the browser resolver", async () => {
  const channel = HTTP_CHANNELS.find((item) => item.id === "bingdou");
  let browserCalls = 0;
  const result = await resolveHttpChannel(channel, SOURCE, {
    request: async (url) => {
      assert.equal(url, `${channel.endpoint}${encodeURIComponent(SOURCE)}`);
      return { text: '<iframe src="https://jiexi.bot.cd/?url=demo"></iframe>' };
    },
    resolveBrowserPage: async (sourceUrl, options) => {
      browserCalls += 1;
      assert.equal(sourceUrl, SOURCE);
      assert.equal(options.timeoutMs, 30000);
      return { playUrl: MEDIA, type: "mp4" };
    },
  });
  assert.equal(result.playUrl, MEDIA);
  assert.equal(result.provider, "bingdou");
  assert.equal(result.type, "mp4");
  assert.equal(result.singleUse, true);
  assert.ok(result.expiresAtMs > Date.now());
  assert.equal(browserCalls, 1);
});

test("single-use expiry honors x-expires when present", async () => {
  const channel = HTTP_CHANNELS.find((item) => item.id === "bingdou");
  const expires = Math.floor(Date.now() / 1000) + 600;
  const media = `https://cdn.example/video.mp4?x-expires=${expires}`;
  const result = await resolveHttpChannel(channel, SOURCE, {
    request: async () => ({
      text: '<iframe src="https://jiexi.bot.cd/?url=demo"></iframe>',
    }),
    resolveBrowserPage: async () => ({ playUrl: media, type: "mp4" }),
  });
  assert.ok(result.expiresAtMs > Date.now() + 500_000);
  assert.ok(result.expiresAtMs <= expires * 1000);
});

// 回归：主线路 fragLoadTimeOut 可能要 40-50 秒才触发，备用单次链接的本地寿命
// 必须长于这个窗口，否则换线时全部候选已过期（曾用 45 秒兼口，必然来不及）。
test("single-use links without x-expires survive a main-line stall", async () => {
  const channel = HTTP_CHANNELS.find((item) => item.id === "bingdou");
  const result = await resolveHttpChannel(channel, SOURCE, {
    request: async () => ({
      text: '<iframe src="https://jiexi.bot.cd/?url=demo"></iframe>',
    }),
    resolveBrowserPage: async () => ({ playUrl: "https://cdn.example/video.mp4", type: "mp4" }),
  });
  assert.ok(result.singleUse);
  // 至少覆盖 4 分钟，保证晚于主线路崩溃时间。
  assert.ok(
    result.expiresAtMs >= Date.now() + 240_000,
    `expected at least 240s of headroom, got ${Math.round((result.expiresAtMs - Date.now()) / 1000)}s`,
  );
});

// 上游声明的 x-expires 很短时，也不能短到“刚解析就死”。
test("single-use links clamp a too-short upstream expiry to a usable window", async () => {
  const channel = HTTP_CHANNELS.find((item) => item.id === "bingdou");
  const expires = Math.floor(Date.now() / 1000) + 20;
  const result = await resolveHttpChannel(channel, SOURCE, {
    request: async () => ({
      text: '<iframe src="https://jiexi.bot.cd/?url=demo"></iframe>',
    }),
    resolveBrowserPage: async () => ({
      playUrl: `https://cdn.example/video.mp4?x-expires=${expires}`,
      type: "mp4",
    }),
  });
  assert.ok(
    result.expiresAtMs >= Date.now() + 240_000,
    "a 20s upstream expiry must still be clamped up to the failover window",
  );
});

test("bingdou rejects untrusted iframe hosts before launching a browser", async () => {
  const channel = HTTP_CHANNELS.find((item) => item.id === "bingdou");
  let browserCalls = 0;
  await assert.rejects(
    resolveHttpChannel(channel, SOURCE, {
      request: async () => ({ text: '<iframe src="https://evil.example/"></iframe>' }),
      resolveBrowserPage: async () => { browserCalls += 1; },
    }),
    { code: "PARSE_FAILED" },
  );
  assert.equal(browserCalls, 0);
});

test("extractor accepts structured JSON, embedded player config, and a direct video tag", () => {
  assert.equal(extractHttpPlayUrl(JSON.stringify({ url: MEDIA })), MEDIA);
  assert.equal(
    extractHttpPlayUrl(`var player_aaaa={"encrypt":1,"url":"${Buffer.from(MEDIA).toString("base64")}"};`),
    MEDIA,
  );
  assert.equal(extractHttpPlayUrl(`<video controls src="${MEDIA}"></video>`), MEDIA);
  assert.equal(extractHttpPlayUrl('{"url":"javascript:alert(1)"}'), "");
  assert.equal(extractHttpPlayUrl("<script>eval('location.href=evil')</script>"), "");
});

test("LX follows public.php into the shared player config resolver", async () => {
  const channel = HTTP_CHANNELS.find((item) => item.id === "lx");
  const calls = [];
  const playerPage = `https://player.example/?url=${encodeURIComponent(SOURCE)}`;
  const request = async (url, _timeoutMs, options = {}) => {
    calls.push({ url, options });
    if (calls.length === 1) return { text: '<div data-code="qq"></div>' };
    if (calls.length === 2) {
      return { text: JSON.stringify({ success: true, url: playerPage, format: "web" }) };
    }
    if (calls.length === 3) {
      return { text: '<script>const playerConfig = { apiToken: "synthetic-token" };</script>' };
    }
    return { text: JSON.stringify({ code: 200, url: MEDIA, type: "m3u8" }) };
  };

  const result = await resolveHttpChannel(channel, SOURCE, { request });
  assert.equal(result.playUrl, MEDIA);
  assert.equal(result.provider, "lx");
  assert.equal(result.singleUse, true);
  assert.ok(result.expiresAtMs > Date.now());
  assert.equal(calls.length, 4);
  assert.equal(calls[1].url, "https://jx.lxyy.club/public.php");
  assert.equal(calls[1].options.method, "POST");
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.url, SOURCE);
  assert.equal(body.code, "qq");
  assert.match(body.browser, /^[a-f0-9]{32}$/);
  assert.equal(calls[2].url, playerPage);
  const api = new URL(calls[3].url);
  assert.equal(api.origin + api.pathname, "https://player.example/api/resolve.php");
  assert.deepEqual([...api.searchParams], [["token", "synthetic-token"]]);
});

test("789 page entry verifies the iframe chain and reuses the upstream resolver", async () => {
  const channel = HTTP_CHANNELS.find((item) => item.id === "jiexi789-page");
  const calls = [];
  let upstreamUrl = "";
  const request = async (url) => {
    calls.push(url);
    if (calls.length === 1) {
      return { text: '<iframe src="https://jiexi.789jiexi.net:4433/?url=demo"></iframe>' };
    }
    return { text: '<iframe src="https://api-api.789jiexi.net/jiexi.php?url=demo"></iframe>' };
  };

  const result = await resolveHttpChannel(channel, SOURCE, {
    request,
    resolveUpstream: async (url) => {
      upstreamUrl = url;
      return { sourceUrl: url, playUrl: MEDIA, type: "m3u8", provider: "jiexi789" };
    },
  });
  assert.equal(result.provider, "jiexi789-page");
  assert.equal(result.playUrl, MEDIA);
  assert.equal(upstreamUrl, SOURCE);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], `${channel.endpoint}${encodeURIComponent(SOURCE)}`);
  assert.match(calls[1], /^https:\/\/jiexi\.789jiexi\.net:4433\//);
});

test("789 page entry rejects iframe targets outside the provider domain", async () => {
  const channel = HTTP_CHANNELS.find((item) => item.id === "jiexi789-page");
  let upstreamCalls = 0;
  await assert.rejects(
    resolveHttpChannel(channel, SOURCE, {
      request: async () => ({ text: '<iframe src="https://evil.example/"></iframe>' }),
      resolveUpstream: async () => { upstreamCalls += 1; },
    }),
    { code: "PARSE_FAILED" },
  );
  assert.equal(upstreamCalls, 0);
});

test("HTML without a verifiable media URL does not become a candidate", async () => {
  const channel = HTTP_CHANNELS.find((item) => item.id === "bingdou");
  await assert.rejects(
    resolveHttpChannel(channel, SOURCE, { request: async () => ({ text: "<iframe src='https://other.example'></iframe>" }) }),
    { code: "PARSE_FAILED" },
  );
  await assert.rejects(
    resolveHttpChannel(channel, SOURCE, { request: async () => { throw new Error("timeout"); } }),
    { code: "UPSTREAM_ERROR" },
  );
});
