import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/errors.js";
import { assertMediaUrl, assertPublicMediaUrl } from "../src/media.js";

test("assertMediaUrl accepts http(s) media addresses", () => {
  assert.equal(assertMediaUrl("https://cdn.example/a.ts").hostname, "cdn.example");
  assert.equal(assertMediaUrl("http://cdn.example/a.m3u8").protocol, "http:");
});

test("assertMediaUrl rejects empty and non-http addresses", () => {
  assert.throws(() => assertMediaUrl(""), AppError);
  assert.throws(() => assertMediaUrl("file:///tmp/a.ts"), AppError);
  assert.throws(() => assertMediaUrl("not a url"), AppError);
  assert.throws(() => assertMediaUrl("http://127.0.0.1/secret"), AppError);
  assert.throws(() => assertMediaUrl("http://[::1]/secret"), AppError);
  assert.throws(() => assertMediaUrl("http://localhost/secret"), AppError);
});

test("assertPublicMediaUrl rejects private DNS answers", async () => {
  await assert.rejects(
    assertPublicMediaUrl("https://cdn.example/a.ts", async () => [{ address: "10.0.1.1" }]),
    AppError,
  );
  await assert.doesNotReject(
    assertPublicMediaUrl("https://cdn.example/a.ts", async () => [{ address: "8.8.8.8" }]),
  );
});

test("openMedia retries a stalled body and returns the next complete response", async () => {
  const { openMedia } = await import("../src/media.js");
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    if (calls === 1) {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "video/MP2T", "content-length": "10" },
      });
    }
    return new Response(new Uint8Array([9, 8, 7, 6]), {
      status: 200,
      headers: { "content-type": "video/MP2T", "content-length": "4" },
    });
  };

  const response = await openMedia(
    "https://cdn.example/a.ts",
    {},
    fetchFn,
    { attempts: 2, ttfbMs: 200, idleMs: 40, totalMs: 200 },
  );
  assert.equal(calls, 2);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), "4");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [9, 8, 7, 6]);
});

test("openMedia does not retry a client error from upstream", async () => {
  const { openMedia } = await import("../src/media.js");
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return new Response("no", { status: 404, headers: { "content-type": "text/plain" } });
  };
  const response = await openMedia("https://cdn.example/missing.ts", {}, fetchFn, {
    attempts: 3,
    ttfbMs: 200,
    idleMs: 40,
    totalMs: 200,
  });
  assert.equal(calls, 1);
  assert.equal(response.status, 404);
});

test("openMedia accepts a complete response without a content-length header", async () => {
  const { openMedia } = await import("../src/media.js");
  const body = "#EXTM3U\n#EXTINF:4,\nsegment.ts\n";
  const response = await openMedia("https://cdn.example/a.m3u8", {}, async () =>
    new Response(body, { headers: { "content-type": "application/vnd.apple.mpegurl" } }),
  { attempts: 1 });
  assert.equal(await response.text(), body);
  assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(body)));
});

test("openMedia still rejects a truncated response with a declared content-length", async () => {
  const { openMedia } = await import("../src/media.js");
  await assert.rejects(openMedia("https://cdn.example/a.ts", {}, async () =>
    new Response(new Uint8Array([1, 2]), { headers: { "content-length": "4" } }),
  { attempts: 1 }), { code: "UPSTREAM_ERROR" });
});

test("openMedia checks redirect destinations before fetching them", async () => {
  let calls = 0;
  await assert.rejects(
    import("../src/media.js").then(({ openMedia }) => openMedia(
      "https://cdn.example/a.ts", {}, async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
      }, { attempts: 1 },
    )),
    AppError,
  );
  assert.equal(calls, 1);
});
