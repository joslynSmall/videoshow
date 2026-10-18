import { fetchText } from "./http.js";

const DEFAULT_BENCHMARK_TIMEOUT_MS = 4000;

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

export async function benchmarkStream(playUrl, type, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_BENCHMARK_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let targetProbeUrl = playUrl;

    if (type === "m3u8") {
      const playlist = await fetchText(playUrl, {
        accept: "application/vnd.apple.mpegurl,application/x-mpegURL,*/*",
        timeoutMs,
      });
      const firstSeg = extractFirstSegmentUrl(playlist, playUrl);
      if (firstSeg) {
        targetProbeUrl = firstSeg;
      }
    }

    const t0 = performance.now();
    const response = await fetch(targetProbeUrl, {
      method: "GET",
      headers: {
        range: "bytes=0-524287",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    const ttfb = performance.now();
    const ttfbMs = Math.round(ttfb - t0);

    if (!response.ok && response.status !== 206) {
      return {
        available: false,
        status: response.status,
        ttfbMs,
        speedKBps: 0,
        score: 0,
      };
    }

    const buf = await response.arrayBuffer();
    const tEnd = performance.now();
    const totalMs = Math.max(1, tEnd - t0);
    const bytes = buf.byteLength;
    const speedKBps = Math.round(bytes / 1024 / (totalMs / 1000));
    const score = Math.round(speedKBps / Math.max(0.05, ttfbMs / 1000));

    return {
      available: true,
      status: response.status,
      bytes,
      ttfbMs,
      speedKBps,
      score,
    };
  } catch (err) {
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
      : (candidate) => benchmarkStream(candidate.playUrl, candidate.type, options);

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
    available: c.metric.available,
    selected: winner !== null && c === winner,
  }));

  return {
    winner,
    ranked: formattedRanked,
  };
}
