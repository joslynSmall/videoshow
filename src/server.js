import { readFile } from "node:fs/promises";
import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { raceAndSelect } from "./benchmark.js";
import { config } from "./config.js";
import { fetchDmkuDanmaku } from "./danmaku.js";
import { AppError } from "./errors.js";
import { log } from "./log.js";
import { enrichMetadata } from "./metadata.js";
import { normalizeVideoUrl, resolveStream } from "./provider.js";
import { resolveWithBrowser } from "./providers/jx-browser.js";
import { resolveBingdouWithBrowser } from "./providers/bingdou-browser.js";
import { enabledHttpChannels, resolveHttpChannel } from "./providers/http.js";
import { loadCatalogTitle, searchCatalog } from "./catalog.js";
import { loadPageEpisodes, searchSites } from "./sites/index.js";
import { assertPublicMediaUrl, openMedia } from "./media.js";
import { extractExpiry, normalizeType, validateStream } from "./stream.js";

const STATIC_FILES = new Map([
  [
    "/",
    {
      file: "index.html",
      type: "text/html; charset=utf-8",
      cache: "no-cache",
    },
  ],
  [
    "/app.js",
    {
      file: "app.js",
      type: "text/javascript; charset=utf-8",
      cache: "no-cache",
    },
  ],
  [
    "/danmaku-text.js",
    {
      file: "danmaku-text.js",
      type: "text/javascript; charset=utf-8",
      cache: "no-cache",
    },
  ],
  [
    "/styles.css",
    {
      file: "styles.css",
      type: "text/css; charset=utf-8",
      cache: "no-cache",
    },
  ],
  [
    "/vendor/hls.min.js",
    {
      file: "vendor/hls.min.js",
      type: "text/javascript; charset=utf-8",
      cache: "public, max-age=31536000, immutable",
    },
  ],
  [
    "/vendor/artplayer.js",
    {
      file: "vendor/artplayer.js",
      type: "text/javascript; charset=utf-8",
      cache: "public, max-age=31536000, immutable",
    },
  ],
  [
    "/vendor/artplayer-plugin-danmuku.js",
    {
      file: "vendor/artplayer-plugin-danmuku.js",
      type: "text/javascript; charset=utf-8",
      cache: "public, max-age=31536000, immutable",
    },
  ],
]);

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "media-src 'self' https: blob:",
  "connect-src 'self' https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function hostOf(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  if (res.req?.method === "HEAD") res.end();
  else res.end(body);
}

function sendMethodNotAllowed(res, allow) {
  sendJson(
    res,
    405,
    {
      ok: false,
      error: { code: "METHOD_NOT_ALLOWED", message: "请求方法不支持" },
    },
    { allow },
  );
}

async function readRequestBody(req, maxBytes = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new AppError("BAD_REQUEST", 400, "请求体过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendError(res, err, logger) {
  if (res.headersSent) {
    res.destroy();
    return;
  }

  const status = Number.isInteger(err?.status) ? err.status : 500;
  const code = typeof err?.code === "string" ? err.code : "INTERNAL";
  const expose = err instanceof AppError ? err.expose : false;
  const message = expose ? err.message : "服务内部错误";

  if (status >= 500) {
    logger.error("http.error", {
      status,
      code,
      message: err?.message,
      stack: err?.stack,
    });
  } else {
    logger.warn("http.error", { status, code, message: err?.message });
  }

  sendJson(res, status, { ok: false, error: { code, message } });
}

async function mapLimited(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  }));
  return results;
}

async function sendStatic(req, res, entry, logger) {
  const filePath = path.join(config.publicDir, entry.file);
  let data;

  try {
    data = await readFile(filePath);
  } catch (err) {
    logger.error("static.read_failed", {
      file: entry.file,
      message: err?.message,
    });
    sendJson(res, 500, {
      ok: false,
      error: { code: "INTERNAL", message: "静态资源缺失" },
    });
    return;
  }

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": entry.type,
    "content-length": data.length,
    "cache-control": entry.cache,
    ...(entry.file === "index.html"
      ? { "content-security-policy": HTML_CSP }
      : {}),
  });

  if (req.method === "HEAD") res.end();
  else res.end(data);
}

export function createServer({
  resolve = resolveStream,
  resolveBrowser = resolveWithBrowser,
  httpChannels = enabledHttpChannels(config.httpProviderIds),
  resolveHttp = resolveHttpChannel,
  resolveBingdou = config.enableBrowserProvider ? resolveBingdouWithBrowser : null,
  validate = validateStream,
  guardMedia = assertPublicMediaUrl,
  enrich = enrichMetadata,
  fetchDanmaku = fetchDmkuDanmaku,
  search = searchCatalog,
  searchSitesFn = searchSites,
  loadEpisodesFn = loadPageEpisodes,
  loadTitle = loadCatalogTitle,
  openMediaFn = openMedia,
  race = raceAndSelect,
  logger = log,
  now = Date.now,
  cacheTtlMs = config.cacheTtlMs,
  cacheMaxEntries = config.cacheMaxEntries,
} = {}) {
  const parseCache = new Map();
  const danmakuCache = new Map();
  const providerCooldowns = new Map();

  function getCached(cache, key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      cache.delete(key);
      return null;
    }
    return entry;
  }

  function storeCached(cache, key, data, expiresAtMs, candidates = []) {
    if (cacheMaxEntries <= 0 || cacheTtlMs <= 0) return;
    const current = now();
    const expiry = Math.min(
      current + cacheTtlMs,
      Number.isFinite(expiresAtMs) ? expiresAtMs : Infinity,
    );
    if (expiry <= current) return;

    if (cache.size >= cacheMaxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { data, candidates, expiresAt: expiry });
  }

  async function handleParse(res, requestUrl) {
    const sourceUrl = normalizeVideoUrl(requestUrl.searchParams.get("url"));
    const cached = getCached(parseCache, sourceUrl);
    if (cached) {
      sendJson(res, 200, { ok: true, data: { ...cached.data, cached: true } });
      return;
    }

    const resolvers = [{ id: "jiexi789", run: () => resolve(sourceUrl) }];
    if (config.enableBrowserProvider && resolveBrowser) {
      resolvers.push({
        id: "jx-browser",
        run: () => resolveBrowser(sourceUrl, config.requestTimeoutMs),
      });
    }
    for (const channel of httpChannels) {
      resolvers.push({
        id: channel.id,
        fallback: channel.fallback === true,
        run: () => resolveHttp(channel, sourceUrl, {
          timeoutMs: config.httpProviderTimeoutMs,
          resolveBrowserPage: resolveBingdou,
        }),
      });
    }
    const seen = new Set();
    const verified = [];
    const diagnostics = [];
    let resolvedCount = 0;
    const runResolvers = (list) => mapLimited(list, list.length, async (item) => {
      const startedAt = performance.now();
      const diagnostic = { provider: item.id };
      const finish = (status, extra = {}) => {
        diagnostics.push({
          ...diagnostic,
          status,
          ms: Math.round(performance.now() - startedAt),
          ...extra,
        });
      };
      if ((providerCooldowns.get(item.id) || 0) > now()) {
        finish("cooldown");
        return null;
      }
      let candidate;
      try {
        const result = await item.run();
        providerCooldowns.delete(item.id);
        if (!result) {
          finish("empty");
          return null;
        }
        diagnostic.playHost = hostOf(result.playUrl);
        if (seen.has(result.playUrl)) {
          finish("duplicate");
          return null;
        }
        seen.add(result.playUrl);
        resolvedCount += 1;
        const type = normalizeType(result.type, result.playUrl);
        if (result.singleUse) {
          candidate = { ...result, type, stream: { playlist: null } };
          verified.push(candidate);
          finish("single-use", {
            type: candidate.type,
            available: true,
            verified: false,
            singleUse: true,
            ttfbMs: null,
            speedKBps: 0,
          });
          return {
            candidate,
            ranked: {
              provider: candidate.provider,
              playUrl: candidate.playUrl,
              type: candidate.type,
              speedKBps: 0,
              ttfbMs: null,
              score: 0,
              available: true,
              selected: false,
              verified: false,
              singleUse: true,
            },
          };
        }
        await guardMedia(result.playUrl);
        const stream = await validate(result.playUrl, type);
        candidate = { ...result, type, stream };
        verified.push(candidate);
      } catch (err) {
        if (["UPSTREAM_ERROR", "UPSTREAM_TIMEOUT", "BROWSER_UNAVAILABLE", "BROWSER_ERROR"].includes(err?.code)) {
          providerCooldowns.set(item.id, now() + 30_000);
        }
        finish("rejected", { code: err?.code, message: err?.message, detail: err?.detail });
        logger.warn("stream.rejected", { provider: item.id, message: err?.message, detail: err?.detail });
        return null;
      }

      let raceResult;
      try {
        raceResult = await race([candidate], {
          probeSingle: true,
          timeoutMs: config.benchmarkTimeoutMs,
        });
      } catch (err) {
        logger.warn("benchmark.rejected", { provider: candidate.provider, message: err?.message });
        raceResult = { winner: null, ranked: [] };
      }
      const single = raceResult?.ranked?.[0];
      if (!raceResult?.winner || !single) {
        finish("benchmark-rejected", {
          type: candidate.type,
          available: false,
          verified: true,
          singleUse: false,
          ttfbMs: null,
          speedKBps: 0,
          message: "测速未通过",
        });
        logger.warn("benchmark.rejected", { provider: candidate.provider, message: "测速未通过" });
        return {
          candidate,
          ranked: {
            provider: candidate.provider,
            playUrl: candidate.playUrl,
            type: candidate.type,
            speedKBps: 0,
            ttfbMs: Infinity,
            available: false,
            selected: false,
            score: 0,
            verified: true,
            singleUse: false,
          },
        };
      }
      finish("benchmarked", {
        type: candidate.type,
        available: single.available,
        verified: true,
        singleUse: false,
        ttfbMs: single.ttfbMs,
        speedKBps: single.speedKBps,
        score: single.score,
      });
      return {
        candidate: raceResult.winner,
        ranked: { ...single, verified: true, singleUse: false },
      };
    }).then((items) => items.filter(Boolean));

    const primary = resolvers.filter((item) => !item.fallback);
    const fallback = resolvers.filter((item) => item.fallback);
    let measured = await runResolvers(primary);
    const hasVerifiedAvailable = measured.some((item) =>
      item.ranked.available && item.ranked.verified);
    if (fallback.length) {
      if (hasVerifiedAvailable) {
        for (const item of fallback) {
          diagnostics.push({
            provider: item.id,
            status: "fallback-skipped",
            ms: 0,
            message: "已有可用已验证线路",
          });
        }
      } else {
        measured = measured.concat(await runResolvers(fallback));
      }
    }
    if (!verified.length) {
      throw new AppError(
        resolvedCount ? "STREAM_INVALID" : "PARSE_FAILED",
        502,
        resolvedCount ? "所有解析线路均未返回可播放媒体" : "所有解析线路均未能解析该视频",
      );
    }
    const available = measured.filter((item) => item.ranked.available);
    if (!available.length) {
      throw new AppError("STREAM_INVALID", 502, "播放线路测速均未通过");
    }
    measured.sort((a, b) =>
      Number(b.ranked.available) - Number(a.ranked.available) ||
      Number(b.ranked.verified) - Number(a.ranked.verified) ||
      (b.ranked.score ?? 0) - (a.ranked.score ?? 0) ||
      (a.ranked.ttfbMs ?? Infinity) - (b.ranked.ttfbMs ?? Infinity));
    const winner = measured.find((item) => item.ranked.available);
    const ranked = measured.map((item) => ({
      ...item.ranked,
      selected: item === winner && item.ranked.available,
    }));
    const selectedResult = winner.candidate;
    const stream = selectedResult.stream;
    const info =
      (await enrich(selectedResult.sourceUrl, selectedResult.playUrl, stream)) ??
      {};
    const expiresAtMs = Number.isFinite(selectedResult.expiresAtMs)
      ? selectedResult.expiresAtMs
      : extractExpiry(selectedResult.playUrl);

    const data = {
      sourceUrl: selectedResult.sourceUrl,
      playUrl: selectedResult.playUrl,
      type: selectedResult.type,
      title: info.title ?? null,
      cover: info.cover ?? null,
      expiresAt: Number.isFinite(expiresAtMs)
        ? new Date(expiresAtMs).toISOString()
        : null,
      provider: selectedResult.provider,
      singleUse: selectedResult.singleUse === true,
      verified: selectedResult.singleUse !== true,
      candidates: ranked,
      diagnostics,
      cached: false,
      danmaku: {
        provider: "dmku",
        endpoint: `/api/danmaku?url=${encodeURIComponent(selectedResult.sourceUrl)}`,
      },
    };

    storeCached(parseCache, sourceUrl, data, expiresAtMs,
      verified.map(({ stream: _stream, ...candidate }) => candidate));
    logger.info("parse.selected", {
      pageHost: hostOf(sourceUrl),
      provider: data.provider,
      type: data.type,
      playHost: hostOf(data.playUrl),
      candidates: (ranked || []).map((item) => ({
        provider: item.provider,
        playHost: hostOf(item.playUrl),
        speedKBps: item.speedKBps,
        ttfbMs: item.ttfbMs,
        available: item.available,
        selected: item.selected,
        verified: item.verified,
        singleUse: item.singleUse,
      })),
      diagnostics: diagnostics.map(({ provider, status, ms }) => ({
        provider,
        status,
        ms,
      })),
    });
    sendJson(res, 200, { ok: true, data });
  }

  async function handleDanmaku(res, requestUrl) {
    const sourceUrl = normalizeVideoUrl(requestUrl.searchParams.get("url"));
    const cached = getCached(danmakuCache, sourceUrl);
    if (cached) {
      sendJson(res, 200, { ok: true, data: { ...cached.data, cached: true } });
      return;
    }

    const result = await fetchDanmaku(sourceUrl);
    const data = {
      provider: result.provider,
      count: result.count,
      items: result.items,
      cached: false,
    };
    storeCached(danmakuCache, sourceUrl, data, now() + cacheTtlMs);
    sendJson(res, 200, { ok: true, data });
  }

  async function handleSearch(res, requestUrl) {
    const kw =
      requestUrl.searchParams.get("kw") ||
      requestUrl.searchParams.get("q") ||
      "";
    if (!kw.trim()) {
      throw new AppError("INVALID_KEYWORD", 400, "缺少搜索关键词");
    }
    const items = await search(kw.trim());
    logger.info("search.completed", {
      keyword: kw.trim().slice(0, 80),
      count: items.length,
    });
    sendJson(res, 200, { ok: true, data: { items } });
  }

  async function handleSiteSearch(res, requestUrl) {
    const kw =
      requestUrl.searchParams.get("kw") ||
      requestUrl.searchParams.get("q") ||
      "";
    if (!kw.trim()) {
      throw new AppError("INVALID_KEYWORD", 400, "缺少搜索关键词");
    }
    const sites = await searchSitesFn(kw.trim());
    logger.info("site_search.completed", {
      keyword: kw.trim().slice(0, 80),
      sites: sites.map((site) => site.id).join(","),
      count: sites.reduce((sum, site) => sum + site.items.length, 0),
    });
    sendJson(res, 200, { ok: true, data: { sites } });
  }

  async function handleEpisodes(res, requestUrl) {
    const pageUrl = requestUrl.searchParams.get("url") || "";
    if (!pageUrl.trim()) {
      throw new AppError("BAD_REQUEST", 400, "缺少视频页面地址");
    }
    const episodes = await loadEpisodesFn(pageUrl.trim());
    logger.info("episodes.loaded", {
      host: hostOf(pageUrl),
      count: episodes.length,
    });
    sendJson(res, 200, { ok: true, data: { episodes } });
  }

  async function handleMedia(req, res, requestUrl) {
    const target = requestUrl.searchParams.get("url") || "";
    const startedAt = Date.now();
    const response = await openMediaFn(target, req.headers);
    const headers = {
      "content-type": response.headers.get("content-type") || "application/octet-stream",
      "cache-control": "no-store",
    };
    for (const name of ["content-length", "content-range", "accept-ranges"]) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(response.status, headers);
    logger.info("media.fetch", {
      host: hostOf(target),
      status: response.status,
      type: response.headers.get("content-type") || "",
      ms: Date.now() - startedAt,
    });
    if (!response.body || req.method === "HEAD") {
      res.end();
      return;
    }
    try {
      await pipeline(Readable.fromWeb(response.body), res);
    } catch (err) {
      logger.warn("media.aborted", {
        host: hostOf(target),
        message: err?.message,
      });
      res.destroy();
    }
  }

  async function handleClientLog(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new AppError("BAD_REQUEST", 400, "无效的 JSON 请求体");
    }
    const event = typeof body?.event === "string" ? body.event : "";
    const allowed = new Set([
      "playback.start",
      "playback.switch",
      "playback.failed",
      "playback.recover",
    ]);
    if (!allowed.has(event)) {
      throw new AppError("BAD_REQUEST", 400, "未知的日志事件");
    }
    const fields = {};
    for (const key of ["pageHost", "playHost", "fromHost", "toHost", "episode", "provider", "reason"]) {
      const value = body[key];
      if (typeof value === "string" && value) fields[key] = value.slice(0, 160);
    }
    if (Number.isFinite(body?.continueAt)) fields.continueAt = Math.round(body.continueAt);
    logger.info(event, fields);
    sendJson(res, 200, { ok: true });
  }

  async function handleTitle(res, requestUrl) {
    const cat = requestUrl.searchParams.get("cat") || "";
    const id = requestUrl.searchParams.get("id") || "";
    const data = await loadTitle(cat, id);
    logger.info("title.loaded", {
      cat,
      id,
      title: data?.title || "",
      platforms: (data?.platforms || []).map((item) => ({
        id: item.id,
        episodes: Array.isArray(item.episodes) ? item.episodes.length : 0,
      })),
    });
    sendJson(res, 200, { ok: true, data });
  }

  async function handleRace(req, res) {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, "POST");
      return;
    }
    const raw = await readRequestBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new AppError("BAD_REQUEST", 400, "无效的 JSON 请求体");
    }
    const sourceUrl = normalizeVideoUrl(body?.sourceUrl);
    const entry = getCached(parseCache, sourceUrl);
    if (!entry) {
      throw new AppError("PARSE_EXPIRED", 409, "播放线路已过期，请重新解析");
    }
    const excluded = Array.isArray(body.failedPlayUrls) ? body.failedPlayUrls : [];
    if (excluded.length > 20 || excluded.some((value) => typeof value !== "string")) {
      throw new AppError("BAD_REQUEST", 400, "无效的失败线路列表");
    }
    const allCandidates = entry.candidates;
    const filtered = {
      total: allCandidates.length,
      excluded: allCandidates.filter((item) => excluded.includes(item.playUrl)).length,
      expired: allCandidates.filter((item) =>
        Number.isFinite(item.expiresAtMs) && item.expiresAtMs <= now()).length,
      remaining: 0,
    };
    const candidates = allCandidates.filter((item) =>
      !excluded.includes(item.playUrl) &&
      (!Number.isFinite(item.expiresAtMs) || item.expiresAtMs > now()));
    filtered.remaining = candidates.length;
    if (!candidates.length) {
      sendJson(res, 200, {
        ok: true,
        data: { selected: null, candidates: [], filtered },
      });
      return;
    }
    const verifiedCandidates = candidates.filter((item) => !item.singleUse);
    const singleUseCandidates = candidates.filter((item) => item.singleUse);
    let ranked = [];
    if (verifiedCandidates.length) {
      try {
        const raceResult = await race(verifiedCandidates, {
          probeSingle: true,
          timeoutMs: config.benchmarkTimeoutMs,
        });
        ranked = raceResult?.ranked ?? [];
      } catch (err) {
        logger.warn("race.failed", { message: err?.message });
      }
    }
    const verifiedSelected =
      ranked.find((c) => c.selected && c.available !== false) ?? null;
    const singleUseRanked = singleUseCandidates.map((item, index) => ({
      provider: item.provider,
      playUrl: item.playUrl,
      type: item.type,
      speedKBps: 0,
      ttfbMs: null,
      score: 0,
      available: true,
      selected: !verifiedSelected && index === 0,
      verified: false,
      singleUse: true,
    }));
    const selected =
      verifiedSelected ?? singleUseRanked.find((item) => item.selected) ?? null;
    sendJson(res, 200, {
      ok: true,
      data: { selected, candidates: [...ranked, ...singleUseRanked], filtered },
    });
  }

  return http.createServer(async (req, res) => {
    const startedAt = Date.now();
    res.on("finish", () => {
      logger.info("http.request", {
        method: req.method,
        path: (req.url || "/").split("?")[0],
        status: res.statusCode,
        ms: Date.now() - startedAt,
      });
    });

    try {
      const requestUrl = new URL(req.url || "/", "http://localhost");

      if (requestUrl.pathname === "/api/health") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res, "GET");
          return;
        }
        sendJson(res, 200, {
          ok: true,
          service: "videoshow",
          uptime: Math.round(process.uptime()),
        });
        return;
      }

      if (requestUrl.pathname === "/api/parse") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res, "GET");
          return;
        }
        await handleParse(res, requestUrl);
        return;
      }

      if (requestUrl.pathname === "/api/danmaku") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res, "GET");
          return;
        }
        await handleDanmaku(res, requestUrl);
        return;
      }

      if (requestUrl.pathname === "/api/search") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res, "GET");
          return;
        }
        await handleSearch(res, requestUrl);
        return;
      }

      if (requestUrl.pathname === "/api/episodes") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res, "GET");
          return;
        }
        await handleEpisodes(res, requestUrl);
        return;
      }

      if (requestUrl.pathname === "/api/site-search") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res, "GET");
          return;
        }
        await handleSiteSearch(res, requestUrl);
        return;
      }

      if (requestUrl.pathname === "/api/title") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res, "GET");
          return;
        }
        await handleTitle(res, requestUrl);
        return;
      }

      if (requestUrl.pathname === "/api/client-log") {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res, "POST");
          return;
        }
        await handleClientLog(req, res);
        return;
      }

      if (requestUrl.pathname === "/api/media") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendMethodNotAllowed(res, "GET, HEAD");
          return;
        }
        await handleMedia(req, res, requestUrl);
        return;
      }

      if (requestUrl.pathname === "/api/race") {
        await handleRace(req, res, requestUrl);
        return;
      }

      if (requestUrl.pathname.startsWith("/api/")) {
        sendJson(res, 404, {
          ok: false,
          error: { code: "NOT_FOUND", message: "接口不存在" },
        });
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        sendMethodNotAllowed(res, "GET, HEAD");
        return;
      }

      if (requestUrl.pathname === "/favicon.ico") {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }

      const entry = STATIC_FILES.get(requestUrl.pathname);
      if (!entry) {
        res.writeHead(404, {
          ...SECURITY_HEADERS,
          "content-type": "text/plain; charset=utf-8",
        });
        res.end("Not Found");
        return;
      }

      await sendStatic(req, res, entry, logger);
    } catch (err) {
      sendError(res, err, logger);
    }
  });
}

export function start() {
  const server = createServer();

  server.on("error", (err) => {
    log.error("server.error", { message: err?.message });
    process.exitCode = 1;
  });

  server.listen(config.port, config.host, () => {
    const address = server.address();
    const host =
      address && typeof address === "object" ? address.address : config.host;
    const port =
      address && typeof address === "object" ? address.port : config.port;
    log.info(`videoshow listening on http://${host}:${port}`);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("server.shutdown", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  return server;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) start();
