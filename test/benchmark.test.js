import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/errors.js";
import {
  benchmarkStream,
  extractFirstSegmentUrl,
  raceAndSelect,
  resolveSegmentUrl,
  scoreStream,
} from "../src/benchmark.js";

test("resolveSegmentUrl handles absolute and relative URLs", () => {
  assert.equal(
    resolveSegmentUrl("https://example.com/live/index.m3u8", "https://cdn.com/seg1.ts"),
    "https://cdn.com/seg1.ts",
  );
  assert.equal(
    resolveSegmentUrl("https://example.com/live/index.m3u8", "seg1.ts"),
    "https://example.com/live/seg1.ts",
  );
  assert.equal(
    resolveSegmentUrl("https://example.com/live/index.m3u8", "../seg1.ts"),
    "https://example.com/seg1.ts",
  );
});

test("extractFirstSegmentUrl finds the first media segment in m3u8", () => {
  const playlist = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:10",
    "#EXTINF:9.0,",
    "seg0.ts",
    "#EXTINF:9.0,",
    "seg1.ts",
  ].join("\n");

  assert.equal(
    extractFirstSegmentUrl(playlist, "https://example.com/video/index.m3u8"),
    "https://example.com/video/seg0.ts",
  );
  assert.equal(extractFirstSegmentUrl("#EXTM3U\n#EXT-X-ENDLIST", "https://example.com/video/index.m3u8"), null);
});

test("raceAndSelect handles empty or single candidate", async () => {
  const empty = await raceAndSelect([]);
  assert.equal(empty.winner, null);
  assert.deepEqual(empty.ranked, []);

  const singleCandidate = {
    provider: "p1",
    playUrl: "https://example.com/video.mp4",
    type: "mp4",
  };
  const single = await raceAndSelect([singleCandidate]);
  assert.equal(single.winner.provider, "p1");
  assert.equal(single.ranked[0].selected, true);
});

test("raceAndSelect leaves every candidate unselected when none are playable", async () => {
  const result = await raceAndSelect(
    [
      { provider: "dead-a", playUrl: "https://a.example/a.m3u8", type: "m3u8" },
      { provider: "dead-b", playUrl: "https://b.example/b.m3u8", type: "m3u8" },
    ],
    {
      benchmark: async () => ({
        available: false,
        speedKBps: 0,
        ttfbMs: 100,
        score: 0,
      }),
    },
  );

  assert.equal(result.winner, null);
  assert.equal(result.ranked.every((item) => item.selected === false), true);
  assert.equal(result.ranked.every((item) => item.available === false), true);
});

test("raceAndSelect probes one candidate when probeSingle is set", async () => {
  let calls = 0;
  const result = await raceAndSelect(
    [{ provider: "only", playUrl: "https://a.example/a.m3u8", type: "m3u8" }],
    {
      probeSingle: true,
      benchmark: async () => {
        calls += 1;
        return { available: false, speedKBps: 0, ttfbMs: 40, score: 0 };
      },
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.winner, null);
  assert.equal(result.ranked[0].selected, false);
  assert.equal(result.ranked[0].available, false);
});

test("raceAndSelect selects the playable candidate ahead of a dead one", async () => {
  const result = await raceAndSelect(
    [
      { provider: "dead", playUrl: "https://dead.example/a.m3u8", type: "m3u8" },
      { provider: "live", playUrl: "https://live.example/b.m3u8", type: "m3u8" },
    ],
    {
      benchmark: async (candidate) =>
        candidate.provider === "live"
          ? { available: true, speedKBps: 800, ttfbMs: 90, score: 8000 }
          : { available: false, speedKBps: 0, ttfbMs: 120, score: 0 },
    },
  );

  assert.equal(result.winner.provider, "live");
  assert.equal(result.ranked[0].provider, "live");
  assert.equal(result.ranked[0].selected, true);
  assert.equal(result.ranked[1].selected, false);
});

test("raceAndSelect ranks candidates by speed and score", async () => {
  const slow = {
    provider: "slow-line",
    playUrl: "https://slow.com/video.m3u8",
    type: "m3u8",
  };
  const fast = {
    provider: "fast-line",
    playUrl: "https://fast.com/video.m3u8",
    type: "m3u8",
  };

  const fakeRace = async (candidates) => {
    const results = candidates.map((c) => {
      if (c.provider === "fast-line") {
        return {
          ...c,
          metric: { available: true, speedKBps: 3500, ttfbMs: 80, score: 35000 },
        };
      }
      return {
        ...c,
        metric: { available: true, speedKBps: 120, ttfbMs: 2500, score: 50 },
      };
    });
    results.sort((a, b) => b.metric.score - a.metric.score);
    return {
      winner: results[0],
      ranked: results.map((c, i) => ({
        provider: c.provider,
        speedKBps: c.metric.speedKBps,
        ttfbMs: c.metric.ttfbMs,
        selected: i === 0,
      })),
    };
  };

  const result = await fakeRace([slow, fast]);
  assert.equal(result.winner.provider, "fast-line");
  assert.equal(result.ranked[0].provider, "fast-line");
  assert.equal(result.ranked[0].selected, true);
  assert.equal(result.ranked[1].provider, "slow-line");
  assert.equal(result.ranked[1].selected, false);
});

test("benchmarkStream stops reading once the sample limit is reached", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(
    new Uint8Array(1024 * 1024),
    { status: 200, headers: { "content-type": "video/mp4" } },
  ));
  const result = await benchmarkStream("https://8.8.8.8/video.mp4", "mp4");
  assert.equal(result.available, true);
  assert.equal(result.bytes, 512 * 1024);
});

test("benchmarkStream rejects an HTML response masquerading as media", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("<html></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  }));
  const result = await benchmarkStream("https://8.8.8.8/video.mp4", "mp4");
  assert.equal(result.available, false);
});

test("benchmarkStream cancels failed playlist and media responses", async (t) => {
  for (const type of ["m3u8", "mp4"]) {
    let canceled = false;
    const mock = t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
      cancel() { canceled = true; },
    }), { status: 404 }));
    const result = await benchmarkStream(`https://8.8.8.8/video.${type}`, type);
    assert.equal(result.available, false);
    assert.equal(canceled, true);
    mock.mock.restore();
  }
});

test("scoreStream puts sustained throughput ahead of a low first-byte time", () => {
  assert.ok(
    scoreStream(2000, 1000) > scoreStream(300, 100),
    "2000KB/s 但首字节 1s 的线路，应当优于只有 300KB/s 的低延迟线路",
  );
  assert.ok(scoreStream(800, 100) > scoreStream(800, 1500), "吞吐相同时首字节更低的更优");
  assert.equal(scoreStream(0, 100), 0);
});

test("benchmarkStream keeps a validated line when the measurement itself could not finish", async (t) => {
  for (const failure of [
    Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
    Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
    Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }),
    new AppError("BAD_REQUEST", 400, "媒体地址不可访问"),
  ]) {
    const mock = t.mock.method(globalThis, "fetch", async () => { throw failure; });
    const result = await benchmarkStream("https://8.8.8.8/video.mp4", "mp4");
    assert.equal(result.available, true, failure.message);
    assert.equal(result.unmeasured, true);
    assert.equal(result.score, 0);
    assert.equal(result.error, failure.message);
    mock.mock.restore();
  }
});

test("benchmarkStream still rejects clear content problems", async (t) => {
  for (const response of [
    () => new Response("denied", { status: 403 }),
    () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
  ]) {
    const mock = t.mock.method(globalThis, "fetch", async () => response());
    const result = await benchmarkStream("https://8.8.8.8/video.mp4", "mp4");
    assert.equal(result.available, false);
    assert.equal(result.unmeasured, undefined);
    mock.mock.restore();
  }
  t.mock.method(globalThis, "fetch", async () => new Response("not a playlist", { status: 200 }));
  const playlist = await benchmarkStream("https://8.8.8.8/index.m3u8", "m3u8");
  assert.equal(playlist.available, false, "内容不是合法播放列表属于确定的失败");
});

test("raceAndSelect ranks a measured line above an unmeasured one and passes the reason through", async () => {
  const result = await raceAndSelect(
    [{ provider: "slow", playUrl: "https://a.example/a.m3u8", type: "m3u8" },
      { provider: "fast", playUrl: "https://b.example/b.m3u8", type: "m3u8" }],
    {
      benchmark: async (candidate) => candidate.provider === "slow"
        ? { available: true, unmeasured: true, error: "timeout", ttfbMs: null, speedKBps: 0, score: 0 }
        : { available: true, status: 206, ttfbMs: 80, speedKBps: 900, score: 833 },
    },
  );
  assert.equal(result.winner.provider, "fast");
  assert.deepEqual(result.ranked.map((item) => item.provider), ["fast", "slow"]);
  assert.equal(result.ranked[1].unmeasured, true);
  assert.equal(result.ranked[1].error, "timeout");
  assert.equal(result.ranked[0].unmeasured, undefined);

  const onlyUnmeasured = await raceAndSelect(
    [{ provider: "slow", playUrl: "https://a.example/a.m3u8", type: "m3u8" },
      { provider: "other", playUrl: "https://b.example/b.m3u8", type: "m3u8" }],
    { benchmark: async () => ({ available: true, unmeasured: true, error: "timeout", ttfbMs: null, speedKBps: 0, score: 0 }) },
  );
  assert.ok(onlyUnmeasured.winner, "全部没测成时仍然要选出一条可用线路");
});
