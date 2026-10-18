import assert from "node:assert/strict";
import test from "node:test";
import { inferPlaybackType } from "../src/providers/jx-browser.js";

test("inferPlaybackType keeps MP4 sources as MP4", () => {
  assert.equal(inferPlaybackType("https://cdn.example/video.mp4?auth=1"), "mp4");
  assert.equal(inferPlaybackType("https://cdn.example/video.m3u8?auth=1"), "m3u8");
  assert.equal(inferPlaybackType("https://cdn.example/stream"), "m3u8");
});
