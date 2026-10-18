import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/errors.js";
import { inferPlaybackType, isRetryableBrowserError } from "../src/providers/jx-browser.js";

test("inferPlaybackType keeps MP4 sources as MP4", () => {
  assert.equal(inferPlaybackType("https://cdn.example/video.mp4?auth=1"), "mp4");
  assert.equal(inferPlaybackType("https://cdn.example/video.m3u8?auth=1"), "m3u8");
  assert.equal(inferPlaybackType("https://cdn.example/stream"), "m3u8");
});

// 上游解析站边缘节点会瞬时重置 TLS 连接（ECONNRESET），
// 表现为页面加载/提取失败；这种要重试，本地环境问题不要重试。
test("browser retry only covers upstream extraction failures", () => {
  assert.equal(
    isRetryableBrowserError(new AppError("PARSE_FAILED", 502, "无头浏览器未能提取到可用播放地址")),
    true,
  );
  assert.equal(
    isRetryableBrowserError(new AppError("BROWSER_UNAVAILABLE", 503, "无头 Chrome 未安装")),
    false,
    "Chrome 未安装时重试没有意义",
  );
  assert.equal(
    isRetryableBrowserError(new AppError("BROWSER_ERROR", 502, "无法启动无头浏览器 DevTools 端口")),
    false,
    "DevTools 端口起不来时重试没有意义",
  );
  assert.equal(isRetryableBrowserError(new Error("boom")), false);
});
