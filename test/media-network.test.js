import assert from "node:assert/strict";
import http from "node:http";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { config } from "../src/config.js";
import { assertPublicMediaUrl, fetchPublicMedia, resolveMediaAddresses } from "../src/media.js";
import { createPublicDnsResolver, DNS_ENDPOINTS, requestPinnedMedia } from "../src/media-network.js";

const dnsAnswer = (address = "8.8.8.8", ttl = 5) => ({
  Status: 0, Answer: [{ type: 1, data: address, TTL: ttl }],
});

test("public DNS uses a fixed endpoint, bounds the request, and honors cache TTL", async () => {
  let clock = 1000;
  let calls = 0;
  const resolver = createPublicDnsResolver({
    endpoints: ["https://dns.google/resolve"],
    now: () => clock,
    fetchFn: async (raw, options) => {
      calls += 1;
      const url = new URL(raw);
      assert.equal(url.origin + url.pathname, "https://dns.google/resolve");
      assert.deepEqual([...url.searchParams], [["name", "media.example"], ["type", "A"]]);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(dnsAnswer());
    },
  });
  assert.deepEqual(await resolver("media.example"), [{ address: "8.8.8.8", family: 4 }]);
  await resolver("media.example");
  assert.equal(calls, 1);
  clock += 5001;
  await resolver("media.example");
  assert.equal(calls, 2);
});

test("public DNS rejects malformed, empty, failed, and oversized replies", async () => {
  for (const response of [
    () => Response.json({ Status: 3 }),
    () => Response.json({ Status: 0, Answer: [] }),
    () => Response.json(dnsAnswer("not-an-ip")),
    () => new Response("{"),
    () => new Response("x".repeat(16 * 1024 + 1)),
    () => new Response("error", { status: 503 }),
  ]) {
    const resolver = createPublicDnsResolver({
      endpoints: ["https://dns.google/resolve"],
      fetchFn: async () => response(),
    });
    await assert.rejects(resolver("media.example"));
  }
});

test("auto mode falls back to public DNS only for blocked system answers", async (t) => {
  const previous = config.mediaDnsMode;
  config.mediaDnsMode = "auto";
  t.after(() => { config.mediaDnsMode = previous; });
  let publicCalls = 0;
  const publicResolver = async () => {
    publicCalls += 1;
    return [{ address: "8.8.8.8", family: 4 }];
  };

  const publicAnswer = await resolveMediaAddresses("media.example", {
    systemResolver: async () => [{ address: "8.8.4.4", family: 4 }],
    publicResolver,
  });
  assert.deepEqual(publicAnswer, [{ address: "8.8.4.4", family: 4 }]);
  assert.equal(publicCalls, 0);

  const fallback = await resolveMediaAddresses("fake.example", {
    systemResolver: async () => [{ address: "198.18.1.216", family: 4 }],
    publicResolver,
  });
  assert.deepEqual(fallback, [{ address: "8.8.8.8", family: 4 }]);
  assert.equal(publicCalls, 1);
});

test("auto mode keeps system answers when public DNS fails", async (t) => {
  const previous = config.mediaDnsMode;
  config.mediaDnsMode = "auto";
  t.after(() => { config.mediaDnsMode = previous; });
  const addresses = await resolveMediaAddresses("fake.example", {
    systemResolver: async () => [{ address: "198.18.1.216", family: 4 }],
    publicResolver: async () => { throw new Error("offline"); },
  });
  assert.deepEqual(addresses, [{ address: "198.18.1.216", family: 4 }]);
});

test("public mode still rejects private, fake, and mixed DNS answers before opening media", async (t) => {
  const previous = config.mediaDnsMode;
  config.mediaDnsMode = "public";
  t.after(() => { config.mediaDnsMode = previous; });
  for (const address of ["10.0.0.1", "198.18.1.2"]) {
    let queries = 0;
    const mock = t.mock.method(globalThis, "fetch", async () => {
      queries += 1;
      return Response.json(dnsAnswer(address, 0));
    });
    await assert.rejects(fetchPublicMedia(`https://${address.replaceAll(".", "-")}.example/a.m3u8`),
      { code: "BAD_REQUEST" });
    assert.equal(queries, DNS_ENDPOINTS.length, "每个固定端点各查询一次，之后不再发起任何媒体请求");
    mock.mock.restore();
  }
  await assert.rejects(assertPublicMediaUrl("https://media.example/a.m3u8", async () => [
    { address: "8.8.8.8", family: 4 }, { address: "192.168.0.1", family: 4 },
  ]), { code: "BAD_REQUEST" });
});

async function localServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

// 仅传输层测试固定到本地测试服务器；生产调用会先检查所有地址。
const LOCAL = [{ address: "127.0.0.1", family: 4 }];

test("pinned transport connects to the supplied address and preserves Host, Range, and body", async (t) => {
  const port = await localServer(t, (req, res) => {
    assert.equal(req.headers.host, `unresolvable.invalid:${port}`);
    assert.equal(req.headers.range, "bytes=0-3");
    assert.equal(req.headers["accept-encoding"], "identity");
    assert.match(req.headers["user-agent"], /^Mozilla\/5\.0/);
    res.writeHead(206, { "content-type": "video/MP2T", "content-range": "bytes 0-3/4" });
    res.end(Buffer.from([0x47, 1, 2, 3]));
  });
  const response = await requestPinnedMedia(new URL(`http://unresolvable.invalid:${port}/segment.ts`), {
    headers: { range: "bytes=0-3" },
  }, LOCAL);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-3/4");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0x47, 1, 2, 3]);
});

test("pinned transport handles HEAD and leaves redirects to the caller", async (t) => {
  const port = await localServer(t, (_req, res) => {
    res.writeHead(302, { location: "http://127.0.0.1/private" });
    res.end();
  });
  const response = await requestPinnedMedia(new URL(`http://unresolvable.invalid:${port}/video.mp4`),
    { method: "HEAD" }, LOCAL);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "http://127.0.0.1/private");
  assert.equal(response.body, null);
});

test("pinned transport decompresses a playlist without retaining the compressed length", async (t) => {
  const playlist = "#EXTM3U\n#EXTINF:4,\nsegment.ts\n";
  const compressed = gzipSync(playlist);
  const port = await localServer(t, (_req, res) => {
    res.writeHead(200, { "content-encoding": "gzip", "content-length": compressed.length });
    res.end(compressed);
  });
  const response = await requestPinnedMedia(new URL(`http://unresolvable.invalid:${port}/a.m3u8`), {}, LOCAL);
  assert.equal(await response.text(), playlist);
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("content-length"), null);
});

test("pinned transport supports cancellation before response headers", async (t) => {
  const port = await localServer(t, () => {});
  const controller = new AbortController();
  const request = requestPinnedMedia(new URL(`http://unresolvable.invalid:${port}/slow`),
    { signal: controller.signal }, LOCAL);
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
});

test("canceling a pinned response body closes the source connection", async (t) => {
  let connectionClosed;
  const closed = new Promise((resolve) => { connectionClosed = resolve; });
  const port = await localServer(t, (_req, res) => {
    res.on("close", connectionClosed);
    res.writeHead(200, { "content-type": "video/MP2T" });
    res.write(Buffer.alloc(1024, 0x47));
  });
  const response = await requestPinnedMedia(new URL(`http://unresolvable.invalid:${port}/segment.ts`),
    {}, LOCAL);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await Promise.race([
    closed,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("source connection remained open")), 1000);
      closed.then(() => clearTimeout(timer));
    }),
  ]);
});

test("aborting a pinned request after headers rejects an unfinished body", async (t) => {
  const port = await localServer(t, (_req, res) => {
    res.writeHead(200);
    res.write("partial");
  });
  const controller = new AbortController();
  const response = await requestPinnedMedia(new URL(`http://unresolvable.invalid:${port}/segment.ts`),
    { signal: controller.signal }, LOCAL);
  const body = response.text();
  controller.abort();
  await assert.rejects(body);
});

test("auto mode falls back to public DNS when the system resolver fails outright", async (t) => {
  const previous = config.mediaDnsMode;
  config.mediaDnsMode = "auto";
  t.after(() => { config.mediaDnsMode = previous; });
  const failure = Object.assign(new Error("getaddrinfo ENOTFOUND media.example"), { code: "ENOTFOUND" });
  const systemResolver = async () => { throw failure; };

  const addresses = await resolveMediaAddresses("media.example", {
    systemResolver,
    publicResolver: async () => [{ address: "8.8.4.4", family: 4 }],
  });
  assert.deepEqual(addresses, [{ address: "8.8.4.4", family: 4 }]);

  await assert.rejects(
    resolveMediaAddresses("media.example", {
      systemResolver,
      publicResolver: async () => { throw new Error("doh offline"); },
    }),
    (err) => err === failure,
    "两边都失败时保留系统解析的原始错误",
  );
});

test("system mode never falls back and an aborted request does not retry", async (t) => {
  const previous = config.mediaDnsMode;
  t.after(() => { config.mediaDnsMode = previous; });
  const failure = new Error("ENOTFOUND");
  let publicCalls = 0;
  const publicResolver = async () => { publicCalls += 1; return [{ address: "8.8.4.4", family: 4 }]; };

  config.mediaDnsMode = "system";
  await assert.rejects(
    resolveMediaAddresses("media.example", { systemResolver: async () => { throw failure; }, publicResolver }),
    (err) => err === failure,
  );
  config.mediaDnsMode = "auto";
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    resolveMediaAddresses("media.example", {
      signal: controller.signal,
      systemResolver: async () => { throw failure; },
      publicResolver,
    }),
    (err) => err === failure,
  );
  assert.equal(publicCalls, 0);
});

test("public DNS queries every fixed endpoint in parallel and uses the first valid answer", async () => {
  const asked = [];
  const resolver = createPublicDnsResolver({
    fetchFn: async (raw) => {
      const url = new URL(raw);
      asked.push(url.origin + url.pathname);
      // 国内网络下 dns.google 经常不可达：它失败不能拖累其他端点。
      if (url.hostname === "dns.google") throw new TypeError("fetch failed");
      if (url.hostname === "cloudflare-dns.com") await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json(dnsAnswer("1.2.3.4"));
    },
  });
  assert.deepEqual(await resolver("media.example"), [{ address: "1.2.3.4", family: 4 }]);
  assert.deepEqual([...asked].sort(), [...DNS_ENDPOINTS].sort());
  assert.ok(DNS_ENDPOINTS.every((item) => item.startsWith("https://")));
});

test("public DNS reports NXDOMAIN separately from unreachable resolvers", async () => {
  const dead = createPublicDnsResolver({ fetchFn: async () => Response.json({ Status: 3 }) });
  await assert.rejects(dead("gone.example"), /没有有效的公网 IPv4 解析/);
  const offline = createPublicDnsResolver({ fetchFn: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(offline("gone.example"), /公网 DNS 查询失败/);
});

test("probe distinguishes alive, dead and unknown hosts and caches the verdict", async () => {
  let clock = 1000;
  let calls = 0;
  const resolver = createPublicDnsResolver({
    now: () => clock,
    fetchFn: async (raw) => {
      calls += 1;
      const url = new URL(raw);
      const name = url.searchParams.get("name");
      if (name === "alive.example") return Response.json(dnsAnswer("8.8.8.8"));
      if (name === "gone.example") return Response.json({ Status: 3 });
      if (name === "mixed.example") {
        // 一个端点说 NXDOMAIN，其余不可达：仍然判定为已失效。
        if (url.hostname === "dns.alidns.com") return Response.json({ Status: 3 });
        throw new TypeError("fetch failed");
      }
      throw new TypeError("fetch failed");
    },
  });
  assert.equal(await resolver.probe("alive.example"), "alive");
  assert.equal(await resolver.probe("gone.example"), "dead");
  assert.equal(await resolver.probe("mixed.example"), "dead");
  assert.equal(await resolver.probe("silent.example"), "unknown", "所有端点都不可达时不能下结论");
  assert.equal(await resolver.probe("203.0.113.9"), "alive", "IP 字面量不查询");

  const before = calls;
  await resolver.probe("gone.example");
  assert.equal(calls, before, "判定结果缓存 60 秒");
  clock += 61_000;
  await resolver.probe("gone.example");
  assert.ok(calls > before);
});

test("probe returns dead as soon as two resolvers agree without waiting for slow ones", async () => {
  const resolver = createPublicDnsResolver({
    queryTimeoutMs: 5000,
    fetchFn: async (raw) => {
      const url = new URL(raw);
      if (url.hostname === "dns.alidns.com" || url.hostname === "doh.pub") return Response.json({ Status: 3 });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return Response.json({ Status: 3 });
    },
  });
  const startedAt = Date.now();
  assert.equal(await resolver.probe("gone.example"), "dead");
  assert.ok(Date.now() - startedAt < 1000, "不应等待慢端点");
});

test("concurrent probes of the same host share one lookup and one verdict", async () => {
  let calls = 0;
  const resolver = createPublicDnsResolver({
    fetchFn: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return Response.json({ Status: 3 });
    },
  });
  const verdicts = await Promise.all([
    resolver.probe("gone.example"),
    resolver.probe("gone.example", { signal: AbortSignal.timeout(1) }),
    resolver.probe("gone.example"),
  ]);
  assert.deepEqual(verdicts, ["dead", "dead", "dead"]);
  assert.equal(calls, DNS_ENDPOINTS.length, "只查询一轮");
});
