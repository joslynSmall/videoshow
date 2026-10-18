import assert from "node:assert/strict";
import http from "node:http";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { config } from "../src/config.js";
import { assertPublicMediaUrl, fetchPublicMedia, resolveMediaAddresses } from "../src/media.js";
import { createPublicDnsResolver, requestPinnedMedia } from "../src/media-network.js";

const dnsAnswer = (address = "8.8.8.8", ttl = 5) => ({
  Status: 0, Answer: [{ type: 1, data: address, TTL: ttl }],
});

test("public DNS uses a fixed endpoint, bounds the request, and honors cache TTL", async () => {
  let clock = 1000;
  let calls = 0;
  const resolver = createPublicDnsResolver({
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
    const resolver = createPublicDnsResolver({ fetchFn: async () => response() });
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
    assert.equal(queries, 1);
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
