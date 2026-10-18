import { config } from "./config.js";
import { AppError } from "./errors.js";
import { fetchPublicMedia } from "./media.js";

async function readPlaylist(url, { timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchPublicMedia(url, { signal: controller.signal });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new AppError("STREAM_INVALID", 502, "播放清单不可访问");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) throw new AppError("STREAM_INVALID", 502, "播放清单过大");
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
  } finally {
    clearTimeout(timer);
  }
}

async function probeMedia(url, { method, headers, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchPublicMedia(url, {
      method, headers, signal: controller.signal,
    });
    const result = {
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      contentRange: response.headers.get("content-range") || "",
    };
    await response.body?.cancel?.().catch(() => {});
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeType(type, playUrl) {
  const raw = String(type || "").trim().toLowerCase();
  if (raw === "m3u8" || raw === "hls") return "m3u8";
  if (raw === "mp4") return "mp4";
  if (/\.m3u8(\?|$)/i.test(playUrl)) return "m3u8";
  if (/\.mp4(\?|$)/i.test(playUrl)) return "mp4";
  throw new AppError("UNSUPPORTED_STREAM_TYPE", 502, "暂不支持该视频格式");
}

export function extractExpiry(playUrl) {
  if (typeof playUrl !== "string") return null;
  let parsed;
  try {
    parsed = new URL(playUrl);
  } catch {
    return null;
  }
  for (const key of ["deadline", "expire", "expires"]) {
    const value = Number(parsed.searchParams.get(key));
    if (Number.isFinite(value) && value > 0) return value * 1000;
  }
  return null;
}

export async function validateStream(
  playUrl,
  type,
  { textFetcher = readPlaylist, prober = probeMedia } = {},
) {
  if (type === "m3u8") {
    const playlist = await textFetcher(playUrl, {
      accept: "application/vnd.apple.mpegurl,application/x-mpegURL,*/*",
      timeoutMs: config.streamTimeoutMs,
    });
    const normalized = playlist.replace(/^\uFEFF/, "").trimStart();
    if (!normalized.startsWith("#EXTM3U")) {
      throw new AppError("STREAM_INVALID", 502, "播放清单无效，请重新解析");
    }
    return { playlist: normalized };
  }

  let probe = await prober(playUrl, {
    method: "HEAD",
    timeoutMs: config.streamTimeoutMs,
  });
  if (probe.status >= 400 || !/^(video\/mp4|application\/octet-stream)\b/i.test(probe.contentType || "")) {
    probe = await prober(playUrl, {
      method: "GET",
      headers: { range: "bytes=0-0" },
      timeoutMs: config.streamTimeoutMs,
    });
  }
  if (probe.status >= 400 ||
      (!/^(video\/mp4|application\/octet-stream)\b/i.test(probe.contentType || "") &&
       !(probe.status === 206 && /^bytes \d+-\d+\/\d+/i.test(probe.contentRange || "")))) {
    throw new AppError("STREAM_INVALID", 502, "播放地址不可用，请重新解析");
  }
  return { playlist: null };
}
