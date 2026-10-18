import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import { HTTP_CHANNELS, resolveHttpChannel } from "../src/providers/http.js";

const CHANNEL = HTTP_CHANNELS.find((channel) => channel.id === "qilin");
const SOURCE = "https://v.qq.com/x/cover/demo/episode.html?from=a&v=1";
const MEDIA = "https://cdn.example/episode.m3u8?expires=2000000000";
// 测试值不来自上游，包含必须转义的查询参数字符。
const PAGE_TOKEN = "test-page-value+/=&";
const PAGE = `<script>const playerConfig = {
  videoUrl: ${JSON.stringify(SOURCE)},
  apiToken: ${JSON.stringify(PAGE_TOKEN)}
};</script>`;

function fixtureRequest(payload, calls = []) {
  return async (url, timeoutMs, options) => {
    calls.push({ url, timeoutMs, options });
    return { text: calls.length === 1 ? PAGE : JSON.stringify(payload) };
  };
}

test("qilin obtains a fresh page value and calls only the fixed same-origin JSON endpoint", async () => {
  const calls = [];
  const result = await resolveHttpChannel(CHANNEL, SOURCE, {
    timeoutMs: 4000,
    request: fixtureRequest({ code: 200, url: MEDIA, type: "m3u8", title: "推广标题" }, calls),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${CHANNEL.endpoint}${encodeURIComponent(SOURCE)}`);
  const api = new URL(calls[1].url);
  assert.equal(api.origin, "https://free.maccms.xyz");
  assert.equal(api.pathname, "/api/resolve.php");
  assert.deepEqual([...api.searchParams], [["token", PAGE_TOKEN]]);
  assert.equal(calls[1].options.accept, "application/json");
  assert.deepEqual(calls[1].options.headers, { referer: calls[0].url });
  assert.ok(calls[1].timeoutMs > 0 && calls[1].timeoutMs <= calls[0].timeoutMs);
  assert.ok(calls[0].timeoutMs <= 4000);
  const { expiresAtMs, ...rest } = result;
  assert.deepEqual(rest, {
    sourceUrl: SOURCE,
    playUrl: MEDIA,
    provider: "qilin",
    type: "m3u8",
    singleUse: true,
  });
  assert.ok(expiresAtMs > Date.now());
  assert.ok(!inspect(result).includes(PAGE_TOKEN));
});

test("qilin supports mp4 and detects HLS when the API type is auto", async () => {
  for (const [url, apiType, type] of [
    ["https://cdn.example/episode.mp4", "mp4", "mp4"],
    [MEDIA, "auto", "m3u8"],
  ]) {
    const result = await resolveHttpChannel(CHANNEL, SOURCE, {
      request: fixtureRequest({ code: 200, url, type: apiType }),
    });
    assert.equal(result.type, type);
  }
});

test("qilin rejects missing, malformed, or redirected page configuration without calling the API", async () => {
  for (const response of [
    { text: "<iframe src='https://elsewhere.example/'></iframe>" },
    { text: '<script>const playerConfig = { apiToken: "" };</script>' },
    { text: '<script>const playerConfig = { apiToken: "\\q" };</script>' },
    { text: `<script>const playerConfig = { apiToken: (() => ${JSON.stringify(PAGE_TOKEN)})() };</script>` },
    { text: PAGE, redirectUrl: "https://elsewhere.example/" },
  ]) {
    let requests = 0;
    await assert.rejects(resolveHttpChannel(CHANNEL, SOURCE, {
      request: async () => { requests += 1; return response; },
    }), { code: "PARSE_FAILED" });
    assert.equal(requests, 1);
  }
});

test("qilin rejects unsuccessful responses, unsafe addresses, and unsupported media", async () => {
  for (const [payload, code] of [
    [{ code: 403, url: MEDIA, msg: PAGE_TOKEN }, "PARSE_FAILED"],
    [{ code: "200", url: MEDIA }, "PARSE_FAILED"],
    [{ code: 200 }, "PARSE_FAILED"],
    [{ code: 200, url: "javascript:alert(1)" }, "PARSE_FAILED"],
    [{ code: 200, url: "http://127.0.0.1/video.m3u8" }, "PARSE_FAILED"],
    [{ code: 200, url: "https://user:password@cdn.example/video.m3u8" }, "PARSE_FAILED"],
    [{ code: 200, url: "https://cdn.example/video.flv", type: "flv" }, "UNSUPPORTED_STREAM_TYPE"],
  ]) {
    await assert.rejects(resolveHttpChannel(CHANNEL, SOURCE, {
      request: fixtureRequest(payload),
    }), (err) => {
      assert.equal(err.code, code);
      assert.ok(!inspect(err).includes(PAGE_TOKEN));
      return true;
    });
  }
});

test("qilin handles non-JSON and redirected API responses without forwarding upstream data", async () => {
  for (const response of [
    { text: `<html>${PAGE_TOKEN}</html>` },
    { redirectUrl: "https://elsewhere.example/" },
    { redirectUrl: "https://elsewhere.example/", text: JSON.stringify({ code: 200, url: MEDIA }) },
  ]) {
    let requests = 0;
    await assert.rejects(resolveHttpChannel(CHANNEL, SOURCE, {
      request: async () => (++requests === 1 ? { text: PAGE } : response),
    }), (err) => {
      assert.ok(["UPSTREAM_ERROR", "PARSE_FAILED"].includes(err.code));
      assert.ok(!inspect(err).includes(PAGE_TOKEN));
      return true;
    });
    assert.equal(requests, 2);
  }
});

test("qilin transport errors do not retain the sensitive request URL", async () => {
  let requests = 0;
  await assert.rejects(resolveHttpChannel(CHANNEL, SOURCE, {
    request: async (url) => {
      if (++requests === 1) return { text: PAGE };
      throw new Error(`Request failed: ${url}`);
    },
  }), (err) => {
    assert.equal(err.code, "UPSTREAM_ERROR");
    assert.equal(err.cause, undefined);
    assert.ok(!inspect(err).includes(encodeURIComponent(PAGE_TOKEN)));
    return true;
  });
});

test("qilin native transport uses bounded anonymous GETs and does not follow API redirects", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return new Response(PAGE);
    return new Response(null, {
      status: 302, headers: { location: "https://elsewhere.example/" },
    });
  });
  await assert.rejects(resolveHttpChannel(CHANNEL, SOURCE), { code: "UPSTREAM_ERROR" });
  assert.equal(calls.length, 2);
  for (const { options } of calls) {
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.headers.authorization, undefined);
  }
});

test("qilin native transport rejects oversized API bodies and maps timeouts", async (t) => {
  for (const scenario of ["oversized", "timeout"]) {
    let requests = 0;
    const mock = t.mock.method(globalThis, "fetch", async () => {
      if (++requests === 1) return new Response(PAGE);
      if (scenario === "timeout") throw new DOMException("Aborted", "AbortError");
      return new Response("x".repeat(256 * 1024 + 1));
    });
    await assert.rejects(resolveHttpChannel(CHANNEL, SOURCE), {
      code: scenario === "timeout" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR",
    });
    assert.equal(requests, 2);
    mock.mock.restore();
  }
});

test("expired HTTP channel budget does not start a network request", async () => {
  let requests = 0;
  await assert.rejects(resolveHttpChannel(CHANNEL, SOURCE, {
    timeoutMs: 0,
    request: async () => { requests += 1; return { text: PAGE }; },
  }), { code: "UPSTREAM_TIMEOUT" });
  assert.equal(requests, 0);
});
