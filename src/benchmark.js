import { AppError } from "./errors.js";
import { fetchPublicMedia } from "./media.js";

const DEFAULT_BENCHMARK_TIMEOUT_MS = 4000;
const MAX_SAMPLE_BYTES = 512 * 1024;

async function fetchPlaylist(url, signal) {
  const response = await fetchPublicMedia(url, { signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error("playlist unavailable");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) throw new Error("playlist too large");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function resolveSegmentUrl(m3u8Url, line) {
  const trimmed = line.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return new URL(trimmed, m3u8Url).toString();
}

export function extractFirstSegmentUrl(m3u8Text, m3u8Url) {
  const lines = m3u8Text.split(/\r?\n/).map((l) => l.trim());
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    return resolveSegmentUrl(m3u8Url, line);
  }
  return null;
}

// 服务端测速没跑完不等于播不了：超时、网络错误、服务端 DNS 校验被拦（例如 Fake-IP 环境）
// 都只说明"这次没测成"，浏览器是直接取分片的。只有 HTTP 状态码、内容类型这类明确的内容问题才算不可用。
function isInconclusiveFailure(err) {
  return err?.name === "AbortError" || err?.name === "TimeoutError" ||
    err instanceof AppError || err?.message === "fetch failed";
}

// 吞吐优先：HLS 持续播放要求吞吐大于码率，首字节只影响起播。
// speedKBps 是从发起请求起算的，已经含首字节耗时，这里只做轻微的二次扣分，
// 避免低延迟但吞吐不足的线路压过高吞吐线路。
export function scoreStream(speedKBps, ttfbMs) {
  return Math.round(speedKBps / (1 + ttfbMs / 1000));
}

export async function benchmarkStream(playUrl, type, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_BENCHMARK_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let targetProbeUrl = playUrl;

    if (type === "m3u8") {
      // 调用方已经取到过这份清单时直接复用：短时效线路的清单地址几秒就过期，不能再取第二次。
      let prefetched = typeof options.playlist === "string" ? options.playlist : null;
      for (let depth = 0; depth < 3; depth += 1) {
        const playlist = prefetched ?? await fetchPlaylist(targetProbeUrl, controller.signal);
        prefetched = null;
        if (!playlist.trimStart().startsWith("#EXTM3U")) throw new Error("invalid playlist");
        const first = extractFirstSegmentUrl(playlist, targetProbeUrl);
        if (!first) throw new Error("empty playlist");
        targetProbeUrl = first;
        if (!/\.m3u8(\?|$)/i.test(first)) break;
        if (depth === 2) throw new Error("playlist nesting limit");
      }
    }

    const t0 = performance.now();
    const response = await fetchPublicMedia(targetProbeUrl, {
      method: "GET",
      headers: {
        range: "bytes=0-524287",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      signal: controller.signal,
    });

    const ttfb = performance.now();
    const ttfbMs = Math.round(ttfb - t0);

    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => {});
      return {
        available: false,
        status: response.status,
        ttfbMs,
        speedKBps: 0,
        score: 0,
      };
    }
    if (/^(text\/html|application\/json)/i.test(response.headers.get("content-type") || "")) {
      await response.body?.cancel().catch(() => {});
      return { available: false, status: response.status, ttfbMs, speedKBps: 0, score: 0 };
    }

    if (!response.body) throw new Error("empty response");
    const reader = response.body.getReader();
    let bytes = 0;
    try {
      while (bytes < MAX_SAMPLE_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += Math.min(value.byteLength, MAX_SAMPLE_BYTES - bytes);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const tEnd = performance.now();
    const totalMs = Math.max(1, tEnd - t0);
    const speedKBps = Math.round(bytes / 1024 / (totalMs / 1000));
    const score = scoreStream(speedKBps, ttfbMs);

    return {
      available: true,
      status: response.status,
      bytes,
      ttfbMs,
      speedKBps,
      score,
    };
  } catch (err) {
    if (isInconclusiveFailure(err)) {
      return {
        available: true,
        unmeasured: true,
        error: err.message,
        ttfbMs: null,
        speedKBps: 0,
        score: 0,
      };
    }
    return {
      available: false,
      error: err.message,
      ttfbMs: Infinity,
      speedKBps: 0,
      score: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function raceAndSelect(candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { winner: null, ranked: [] };
  }

  if (candidates.length === 1 && !options.probeSingle) {
    return {
      winner: candidates[0],
      ranked: [{ ...candidates[0], selected: true }],
    };
  }

  const measure =
    typeof options.benchmark === "function"
      ? options.benchmark
      : (candidate) => benchmarkStream(candidate.playUrl, candidate.type, {
          ...options,
          playlist: candidate.stream?.playlist,
        });

  const results = await Promise.allSettled(
    candidates.map(async (c) => {
      const metric = await measure(c);
      return { ...c, metric };
    }),
  );

  const ranked = results
    .map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return {
        ...candidates[i],
        metric: {
          available: false,
          error: r.reason?.message,
          speedKBps: 0,
          ttfbMs: Infinity,
          score: 0,
        },
      };
    })
    .sort((a, b) => {
      if (a.metric.available !== b.metric.available) {
        return a.metric.available ? -1 : 1;
      }
      return b.metric.score - a.metric.score;
    });

  const winner = ranked.find((c) => c.metric.available) || null;
  const formattedRanked = ranked.map((c) => ({
    provider: c.provider,
    playUrl: c.playUrl,
    type: c.type,
    speedKBps: c.metric.speedKBps,
    ttfbMs: c.metric.ttfbMs,
    score: c.metric.score,
    available: c.metric.available,
    selected: winner !== null && c === winner,
    ...(c.metric.unmeasured ? { unmeasured: true } : {}),
    ...(c.metric.error ? { error: c.metric.error } : {}),
    ...(c.metric.status ? { status: c.metric.status } : {}),
  }));

  return {
    winner,
    ranked: formattedRanked,
  };
}
