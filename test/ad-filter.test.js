import assert from "node:assert/strict";
import test from "node:test";
import { hostFamily, stripAdBlocks } from "../public/ad-filter.js";

const BASE = "https://cibn-edge-5g.1ljx.com/cloud/flv/x/index.m3u8";
const CONTENT = "https://omts.tc.qq.com/UBA_token/";
const AD = "https://askutrc5ss.com/20260912/8dpMbXdZ/1000kb/hls/";

function segs(prefix, count, duration, from = 0) {
  return Array.from({ length: count }, (_, i) => `#EXTINF:${duration},\n${prefix}${from + i}.ts`);
}

function playlist(parts, { endlist = true, header = "", eol = "\n" } = {}) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:11", header].filter(Boolean);
  for (const part of parts) lines.push(...(Array.isArray(part) ? part : [part]));
  if (endlist) lines.push("#EXT-X-ENDLIST");
  return lines.join(eol) + eol;
}

const DISC = "#EXT-X-DISCONTINUITY";

// 贴近线上看到的形态：45 片正片 → 6 片外域广告（17.64 秒）→ 239 片正片。
function realistic() {
  const ad = [3.68, 4.16, 3.0, 3.0, 3.0, 0.8].map((d, i) => `#EXTINF:${d},\n${AD}ad${i}.ts`);
  return playlist([segs(CONTENT, 45, 9.9), DISC, ad, DISC, segs(CONTENT, 239, 9.9, 45)]);
}

test("移除夹在 DISCONTINUITY 之间的外域广告块，并报告位置与时长", () => {
  const result = stripAdBlocks(realistic(), BASE);
  assert.equal(result.removed.length, 1);
  assert.deepEqual(result.removed[0], {
    family: "askutrc5ss.com",
    seconds: 17.64,
    segments: 6,
    at: 445.5,
  });
  assert.ok(!result.text.includes("askutrc5ss.com"));
  const lines = result.text.split("\n");
  assert.equal(lines.filter((line) => line.startsWith("#EXTINF")).length, 45 + 239);
  assert.equal(lines.filter((line) => line === DISC).length, 1, "只保留正片接缝处的一个 DISCONTINUITY");
  const seam = lines.indexOf(DISC);
  assert.equal(lines[seam - 1], `${CONTENT}44.ts`);
  assert.equal(lines[seam + 1], "#EXTINF:9.9,");
  assert.equal(lines[seam + 2], `${CONTENT}45.ts`);
  assert.ok(result.text.includes("#EXT-X-ENDLIST"));
  assert.ok(result.text.startsWith("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:11\n"));
});

test("没有外域块时原样返回同一个字符串", () => {
  const text = playlist([segs(CONTENT, 10, 10)]);
  const result = stripAdBlocks(text, BASE);
  assert.equal(result.text, text);
  assert.deepEqual(result.removed, []);
});

test("正片自己的 DISCONTINUITY 与同站不同子域不会被当成广告", () => {
  const sameSite = "https://apd-vlive.tc.qq.com/other/";
  const text = playlist([segs(CONTENT, 40, 10), DISC, segs(sameSite, 4, 10), DISC, segs(CONTENT, 40, 10, 40)]);
  assert.equal(stripAdBlocks(text, BASE).text, text);
});

test("片头广告（第一块）被移除，且结果不以 DISCONTINUITY 开头", () => {
  const text = playlist([segs(AD, 3, 5), DISC, segs(CONTENT, 60, 10)]);
  const result = stripAdBlocks(text, BASE);
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].at, 0);
  assert.ok(!result.text.includes(DISC));
  assert.ok(!result.text.includes("askutrc5ss.com"));
});

test("片尾广告被移除", () => {
  const text = playlist([segs(CONTENT, 60, 10), DISC, segs(AD, 3, 5)]);
  const result = stripAdBlocks(text, BASE);
  assert.equal(result.removed.length, 1);
  assert.ok(!result.text.includes("askutrc5ss.com"));
  assert.ok(result.text.trimEnd().endsWith("#EXT-X-ENDLIST"));
});

test("多个广告块都移除", () => {
  const text = playlist([
    segs(CONTENT, 30, 10), DISC, segs(AD, 3, 5),
    DISC, segs(CONTENT, 30, 10, 30), DISC, segs(`${AD}b`, 2, 5),
    DISC, segs(CONTENT, 30, 10, 60),
  ]);
  const result = stripAdBlocks(text, BASE);
  assert.equal(result.removed.length, 2);
  assert.equal(result.text.split("\n").filter((line) => line === DISC).length, 2);
});

test("超过时长上限的外域块不动", () => {
  // 130 秒外域块只占约 6%，不会触发占比规则，只能由 120 秒上限拦下。
  const long = playlist([segs(CONTENT, 100, 10), DISC, segs(AD, 13, 10), DISC, segs(CONTENT, 100, 10, 100)]);
  assert.equal(stripAdBlocks(long, BASE).text, long);
  const short = playlist([segs(CONTENT, 100, 10), DISC, segs(AD, 12, 10), DISC, segs(CONTENT, 100, 10, 100)]);
  assert.equal(stripAdBlocks(short, BASE).removed.length, 1);
});

test("外域块带 KEY/MAP/BYTERANGE 时不动，切掉会破坏后面的分片", () => {
  for (const tag of ['#EXT-X-KEY:METHOD=AES-128,URI="k"', '#EXT-X-MAP:URI="init.mp4"', "#EXT-X-BYTERANGE:100@0"]) {
    const ad = [DISC, tag, ...segs(AD, 3, 5)];
    const text = playlist([segs(CONTENT, 60, 10), ad, DISC, segs(CONTENT, 60, 10, 60)]);
    assert.equal(stripAdBlocks(text, BASE).text, text, tag);
  }
});

test("移除量超过总时长 10% 时整份不动", () => {
  const text = playlist([segs(CONTENT, 10, 10), DISC, segs(AD, 4, 10), DISC, segs(CONTENT, 10, 10, 10)]);
  assert.equal(stripAdBlocks(text, BASE).text, text);
});

test("外域块过多时整份不动", () => {
  const parts = [];
  for (let i = 0; i < 7; i += 1) {
    parts.push(...[segs(CONTENT, 40, 10, i * 40), DISC, segs(`${AD}${i}/`, 1, 5), DISC]);
  }
  parts.push(segs(CONTENT, 40, 10, 400));
  const text = playlist(parts);
  assert.equal(stripAdBlocks(text, BASE).text, text);
});

test("没有明确占多数的域名族时不动", () => {
  const text = playlist([segs(CONTENT, 5, 10), DISC, segs(AD, 5, 10), DISC, segs("https://third.example.net/", 5, 10)]);
  assert.equal(stripAdBlocks(text, BASE).text, text);
});

test("主列表、直播列表（无 ENDLIST）、非 m3u8 都不处理", () => {
  const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttps://askutrc5ss.com/a.m3u8\n";
  assert.equal(stripAdBlocks(master, BASE).text, master);
  const live = playlist([segs(CONTENT, 40, 10), DISC, segs(AD, 3, 5), DISC, segs(CONTENT, 40, 10, 40)], { endlist: false });
  assert.equal(stripAdBlocks(live, BASE).text, live);
  assert.equal(stripAdBlocks("<html></html>", BASE).text, "<html></html>");
  assert.equal(stripAdBlocks(undefined, BASE).text, undefined);
});

test("相对路径分片按播放列表地址归属，不会被当成外域", () => {
  const text = playlist([
    segs("seg", 40, 10), DISC, segs("seg", 3, 5, 40), DISC, segs("seg", 40, 10, 43),
  ]);
  assert.equal(stripAdBlocks(text, BASE).text, text);
});

test("保留 CRLF 换行", () => {
  const text = playlist([segs(CONTENT, 60, 10), DISC, segs(AD, 3, 5), DISC, segs(CONTENT, 60, 10, 60)], { eol: "\r\n" });
  const result = stripAdBlocks(text, BASE);
  assert.equal(result.removed.length, 1);
  assert.ok(result.text.includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(result.text));
});

test("hostFamily：二级域与带国别的二级后缀", () => {
  assert.equal(hostFamily("omts.tc.qq.com"), "qq.com");
  assert.equal(hostFamily("a.b.example.com.cn"), "example.com.cn");
  assert.equal(hostFamily("askutrc5ss.com"), "askutrc5ss.com");
  assert.equal(hostFamily("localhost"), "localhost");
  assert.equal(hostFamily(""), "");
});
