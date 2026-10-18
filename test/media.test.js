import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/errors.js";
import { assertMediaUrl } from "../src/media.js";

test("assertMediaUrl accepts http(s) media addresses", () => {
  assert.equal(assertMediaUrl("https://cdn.example/a.ts").hostname, "cdn.example");
  assert.equal(assertMediaUrl("http://cdn.example/a.m3u8").protocol, "http:");
});

test("assertMediaUrl rejects empty and non-http addresses", () => {
  assert.throws(() => assertMediaUrl(""), AppError);
  assert.throws(() => assertMediaUrl("file:///tmp/a.ts"), AppError);
  assert.throws(() => assertMediaUrl("not a url"), AppError);
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
