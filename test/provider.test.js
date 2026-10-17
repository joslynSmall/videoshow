import assert from "node:assert/strict";
import test from "node:test";
import { extractTvid, extractVid } from "../src/metadata/iqiyi.js";
import {
  decryptPlayUrl,
  extractConfig,
  normalizeVideoUrl,
} from "../src/provider.js";

const CIPHER =
  "tib3zYklUyDhymRxlWZYp+EWVB/gCkTvDVviMGscT52q57165itWger+/iciR8lGL++V5JQgk2Y3PlVBa1dhPe5KKivIfkF0P48+PDLykI7w/dCqVxt4sBBzHp7TVLHrjV8lh/9NmADonTsN6HPIQdEvGTk/W7NxVhe/vQP/nqx1yJ3g1rzqD7/AuTPtjis3";

const PLAIN =
  "https://ssl.data.m3u8cache.com/m3u8.php?f=b546f0d1a8219ad6aa18fc4f24055fba.m3u8&expire=1792262317&sign=0abdea32318d6758166c16feb7e11770";

const CONFIG_HTML = `<script>
var config = {
  "url": "https://www.iqiyi.com/v_19rronibdc.html",
  "title": "",
  "time": "1792248062",
  "key": "ff72a6b9ae24774857811edcc970a726",
  "vkey": "823a46bd4334f58d0d4a5a204e40ef55"
};
stray.start()
</script>`;

test("extractConfig reads the time and key from the player page", () => {
  assert.deepEqual(extractConfig(CONFIG_HTML), {
    time: "1792248062",
    key: "ff72a6b9ae24774857811edcc970a726",
  });
});

test("extractConfig rejects a page without stream parameters", () => {
  assert.throws(
    () => extractConfig('<script>var config = { "time": "1" };</script>'),
    (err) => err.code === "UPSTREAM_ERROR",
  );
});

test("decryptPlayUrl decrypts a known upstream address", () => {
  assert.equal(decryptPlayUrl(CIPHER), PLAIN);
});

test("decryptPlayUrl rejects invalid key lengths", () => {
  assert.throws(
    () => decryptPlayUrl(CIPHER, "short", "short"),
    (err) => err.code === "CONFIG_ERROR",
  );
});

test("normalizeVideoUrl accepts arbitrary http(s) video URLs", () => {
  assert.equal(
    normalizeVideoUrl("www.iqiyi.com/v_19rronibdc.html"),
    "https://www.iqiyi.com/v_19rronibdc.html",
  );
  assert.equal(
    normalizeVideoUrl("https://www.bilibili.com/video/BV1JP41167xK"),
    "https://www.bilibili.com/video/BV1JP41167xK",
  );
  assert.equal(
    normalizeVideoUrl("https://v.youku.com/v_show/id_X.html"),
    "https://v.youku.com/v_show/id_X.html",
  );
});

test("normalizeVideoUrl rejects missing and non-http URLs", () => {
  assert.throws(
    () => normalizeVideoUrl(""),
    (err) => err.code === "INVALID_URL",
  );
  assert.throws(
    () => normalizeVideoUrl("ftp://example.com/video"),
    (err) => err.code === "INVALID_URL",
  );
});

test("extractTvid and extractVid identify iQiyi metadata", () => {
  const playlist = [
    "#EXTM3U",
    "#EXTINF:9,",
    "https://pcw-data.video.iqiyi.com/videos/vts/x.ts?start=0&end=1&qd_tvid=380581500&qd_vip=1",
    "#EXT-X-ENDLIST",
  ].join("\n");

  assert.equal(extractTvid(playlist), "380581500");
  assert.equal(
    extractVid("https://www.iqiyi.com/v_19rronibdc.html"),
    "19rronibdc",
  );
  assert.equal(extractTvid("#EXTM3U"), null);
  assert.equal(
    extractVid("https://www.iqiyi.com/a_19rronibdc.html"),
    null,
  );
});
