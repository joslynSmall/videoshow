import assert from "node:assert/strict";
import test from "node:test";
import {
  benchmarkStream,
  extractFirstSegmentUrl,
  raceAndSelect,
  resolveSegmentUrl,
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
