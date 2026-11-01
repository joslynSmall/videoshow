import assert from "node:assert/strict";
import test from "node:test";
import { absolutizePlaylist, lineKey, segmentHosts, segmentUrls } from "../src/playlist.js";

const BASE = "https://cdn.example/path/index.m3u8?token=abc";

const PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
  '#EXT-X-MAP:URI="init.mp4"',
  "#EXTINF:10,",
  "seg1.ts",
  "#EXTINF:10,",
  "https://other.example/seg2.ts?e=xyz",
  "#EXT-X-ENDLIST",
  "",
].join("\n");

test("absolutizePlaylist resolves segment lines and URI attributes against the playlist address", () => {
  const out = absolutizePlaylist(PLAYLIST, BASE);
  assert.match(out, /URI="https:\/\/cdn\.example\/path\/key\.bin"/);
  assert.match(out, /URI="https:\/\/cdn\.example\/path\/init\.mp4"/);
  assert.match(out, /^https:\/\/cdn\.example\/path\/seg1\.ts$/m);
  assert.match(out, /^https:\/\/other\.example\/seg2\.ts\?e=xyz$/m, "已是绝对地址的分片原样保留");
  assert.match(out, /^#EXTINF:10,$/m, "标签行本身不变");
  assert.ok(out.endsWith("\n"));
});

test("absolutizePlaylist keeps the original line endings", () => {
  const out = absolutizePlaylist("#EXTM3U\r\n#EXTINF:5,\r\na.ts\r\n", BASE);
  assert.equal(out, "#EXTM3U\r\n#EXTINF:5,\r\nhttps://cdn.example/path/a.ts\r\n");
});

test("segmentUrls and segmentHosts list segments, most frequent host first", () => {
  const text = "#EXTM3U\n#EXTINF:1,\na.ts\n#EXTINF:1,\nhttps://b.example/x.ts\n#EXTINF:1,\nhttps://b.example/y.ts\n";
  assert.equal(segmentUrls(text, BASE).length, 3);
  assert.deepEqual(segmentHosts(text, BASE), ["b.example", "cdn.example"]);
  assert.deepEqual(segmentHosts(text, BASE, 1), ["b.example"]);
});

test("lineKey ignores segment tokens but not the playlist host or the segment list", () => {
  const a = "#EXTM3U\n#EXTINF:1,\nhttps://seg.example/a.ts?e=111\n#EXTINF:1,\nhttps://seg.example/b.ts?e=111\n";
  const sameWithNewTokens = a.replaceAll("e=111", "e=222");
  const key = lineKey("png.example", a, BASE);
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.equal(lineKey("png.example", sameWithNewTokens, BASE), key, "令牌不同、内容相同");
  assert.notEqual(
    lineKey("other.example", a, BASE),
    key,
    "分片相同但播放列表域名不同不算重复：域名不通时换个域名读同样的分片正是有效的恢复手段",
  );
  assert.notEqual(
    lineKey("png.example", a.replace("b.ts", "c.ts"), BASE),
    key,
    "分片列表不同就是不同的线路",
  );
});

test("lineKey returns null when the playlist has no segments", () => {
  assert.equal(lineKey("png.example", "#EXTM3U\n", BASE), null);
});
