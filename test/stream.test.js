import assert from "node:assert/strict";
import test from "node:test";
import { extractExpiry, normalizeType, validateStream } from "../src/stream.js";

test("normalizeType recognizes m3u8 and mp4", () => {
  assert.equal(normalizeType("m3u8", "https://example.com/a.m3u8"), "m3u8");
  assert.equal(normalizeType("mp4", "https://example.com/a.mp4"), "mp4");
  assert.equal(normalizeType("", "https://example.com/a.m3u8?x=1"), "m3u8");
  assert.equal(normalizeType("", "https://example.com/a.mp4?x=1"), "mp4");
});

test("normalizeType rejects unsupported formats", () => {
  assert.throws(
    () => normalizeType("flv", "https://example.com/a.flv"),
    (err) => err.code === "UNSUPPORTED_STREAM_TYPE",
  );
});

test("extractExpiry reads deadline and ignores invalid values", () => {
  assert.equal(
    extractExpiry("https://example.com/a.mp4?deadline=1792258009"),
    1792258009000,
  );
  assert.equal(extractExpiry("https://example.com/a.mp4?deadline=0"), null);
  assert.equal(extractExpiry("https://example.com/a.mp4"), null);
});

test("validateStream accepts a valid m3u8 playlist", async () => {
  const result = await validateStream("https://example.com/a.m3u8", "m3u8", {
    textFetcher: async () => "#EXTM3U\n#EXTINF:1,\nhttps://example.com/a.ts\n",
  });
  assert.match(result.playlist, /^#EXTM3U/);
});

test("validateStream rejects an invalid m3u8 playlist", async () => {
  await assert.rejects(
    () =>
      validateStream("https://example.com/a.m3u8", "m3u8", {
        textFetcher: async () => "not a playlist",
      }),
    (err) => err.code === "STREAM_INVALID",
  );
});

test("validateStream accepts mp4 via HEAD", async () => {
  const result = await validateStream("https://example.com/a.mp4", "mp4", {
    prober: async () => ({ status: 200, contentType: "video/mp4" }),
  });
  assert.equal(result.playlist, null);
});

test("validateStream falls back to a range GET", async () => {
  const methods = [];
  const result = await validateStream("https://example.com/a.mp4", "mp4", {
    prober: async (_url, options) => {
      methods.push(options.method);
      return methods.length === 1 ? { status: 405 } : { status: 206 };
    },
  });
  assert.deepEqual(methods, ["HEAD", "GET"]);
  assert.equal(result.playlist, null);
});

test("validateStream rejects an unavailable mp4", async () => {
  await assert.rejects(
    () =>
      validateStream("https://example.com/a.mp4", "mp4", {
        prober: async () => ({ status: 404 }),
      }),
    (err) => err.code === "STREAM_INVALID",
  );
});
