import assert from "node:assert/strict";
import test from "node:test";
import { fetchDmkuDanmaku } from "../src/danmaku.js";
import { enrichMetadata } from "../src/metadata.js";
import { resolveStream } from "../src/provider.js";
import { normalizeType, validateStream } from "../src/stream.js";

const live = process.env.RUN_LIVE_TESTS === "1";

test(
  "live iQiyi m3u8 and danmaku",
  { skip: !live, timeout: 90_000 },
  async () => {
    const result = await resolveStream("https://www.iqiyi.com/v_19rronibdc.html");
    const type = normalizeType(result.type, result.playUrl);
    assert.equal(type, "m3u8");
    const stream = await validateStream(result.playUrl, type);
    const info = await enrichMetadata(result.sourceUrl, result.playUrl, stream);
    assert.ok(info.title);
    assert.doesNotMatch(info.title, /泽御云|zeyuyun|官网/i);
    const danmaku = await fetchDmkuDanmaku(result.sourceUrl);
    assert.ok(danmaku.count > 0);
  },
);

test(
  "live Bilibili mp4 and empty dmku",
  { skip: !live, timeout: 90_000 },
  async () => {
    const result = await resolveStream(
      "https://www.bilibili.com/video/BV1JP41167xK",
    );
    const type = normalizeType(result.type, result.playUrl);
    assert.equal(type, "mp4");
    await validateStream(result.playUrl, type);
    const danmaku = await fetchDmkuDanmaku(result.sourceUrl);
    assert.equal(danmaku.count, 0);
  },
);
