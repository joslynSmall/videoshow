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
import { createChannelHealth } from "./channels/health.js";
import { createChannelRegistry } from "./channels/registry.js";
import { lookupPublicMediaDns } from "./media-network.js";
import { extractExpiry, normalizeType, validateStream } from "./stream.js";

const RECORDED_SUCCESS = new Set(["single-use", "benchmarked", "duplicate"]);
const LOCAL_ENV_ERRORS = new Set(["BROWSER_UNAVAILABLE", "BROWSER_ERROR"]);

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
    "/ad-filter.js",
    {
      file: "ad-filter.js",
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
    "/stall-monitor.js",
    {
      file: "stall-monitor.js",
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

// 等待主渠道：全部结束，或已有可用的已验证线路后再多等 graceMs
// （让同样快的线路一起参与择优），其余渠道转后台继续，不再拖住响应。
function waitForPrimary(tasks, graceMs, isGood) {
  return new Promise((resolve) => {
    let remaining = tasks.length;
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    if (!remaining) {
      resolve();
      return;
    }
    for (const task of tasks) {
      task.then((result) => {
        remaining -= 1;
        if (remaining === 0) {
          done();
          return;
        }
        if (result && isGood(result) && timer === null) timer = setTimeout(done, graceMs);
      });
    }
  });
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
  parseGraceMs = config.parseGraceMs,
  probeHost = (host, options) => lookupPublicMediaDns.probe(host, options),
  channelRegistry = null,
} = {}) {
  const registry = channelRegistry ?? createChannelRegistry({ builtins: httpChannels });
  const parseCache = new Map();
  const danmakuCache = new Map();
  const providerCooldowns = new Map();

  async function hostHealth(playUrl) {
    const host = hostOf(playUrl);
    if (!host) return "unknown";
    // 探测只发 DNS 查询，最多等 2 秒；拿不到结论就当作未知。共享的查询不会被某一个调用方打断。
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve("unknown"), 2000); });
    try {
      return (await Promise.race([probeHost(host), timeout])) || "unknown";
    } catch {
      return "unknown";
    } finally {
      clearTimeout(timer);
    }
  }

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
    if (cacheMaxEntries <= 0 || cacheTtlMs <= 0) return null;
    const current = now();
    const expiry = Math.min(
      current + cacheTtlMs,
      Number.isFinite(expiresAtMs) ? expiresAtMs : Infinity,
    );
    if (expiry <= current) return null;

    if (cache.size >= cacheMaxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const entry = { data, candidates, expiresAt: expiry };
    cache.set(key, entry);
    return entry;
  }

  async function handleParse(res, requestUrl) {
    const sourceUrl = normalizeVideoUrl(requestUrl.searchParams.get("url"));
    // force=1 用于换线后的重新解析：必须绕过缓存重新走解析，
    // 否则拿回同一批已过期的单次链接，刷新签名地址的兜底逻辑会完全失效。
    const force = requestUrl.searchParams.get("force") === "1";
    const cached = force ? null : getCached(parseCache, sourceUrl);
    if (cached) {
      sendJson(res, 200, { ok: true, data: { ...cached.data, cached: true } });
      return;
    }

    registry.ensureFresh();
    // 被健康账本摘除或被外部配置停用的渠道不再参与解析。
    const resolvers = [];
    if (registry.isActive("jiexi789")) {
      // kind 用于日志区分渠道实现方式，由服务端定义，前端不做硬编码推断。
      resolvers.push({ id: "jiexi789", kind: "api", run: () => resolve(sourceUrl) });
    }
    if (config.enableBrowserProvider && resolveBrowser && registry.isActive("jx-browser")) {
      resolvers.push({
        id: "jx-browser",
        kind: "browser",
        run: () => resolveBrowser(sourceUrl, config.requestTimeoutMs),
      });
    }
    if (config.enableBrowserProvider && resolveBrowser) {
      for (const b of registry.browserChannels()) {
        resolvers.push({
          id: b.id,
          kind: "browser",
          run: () => resolveBrowser(sourceUrl, config.requestTimeoutMs, {
            endpoint: b.endpoint,
            provider: b.id,
          }),
        });
      }
    }
    for (const channel of registry.httpChannels()) {
      resolvers.push({
        id: channel.id,
        kind: "http-api",
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
    const parseStartedAt = performance.now();
    const runOne = async (item) => {
      const startedAt = performance.now();
      const diagnostic = { provider: item.id, kind: item.kind };
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
          // 单次链接不能预先请求（会消耗签名），但可以只查 DNS：域名已经不存在就不必等起播超时。
          if ((await hostHealth(result.playUrl)) === "dead") {
            finish("rejected", {
              code: "HOST_UNREACHABLE",
              message: "媒体域名已失效（公共 DNS 返回 NXDOMAIN）",
              playHost: hostOf(result.playUrl),
            });
            logger.warn("stream.rejected", {
              provider: item.id,
              message: "媒体域名已失效",
              detail: { host: hostOf(result.playUrl) },
            });
            return null;
          }
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
              kind: item.kind,
              playUrl: candidate.playUrl,
              type: candidate.type,
              // 单次签名链接必须带上过期时间，前端日志和 /api/race 都依赖它。
              ...(Number.isFinite(candidate.expiresAtMs)
                ? { expiresAtMs: candidate.expiresAtMs }
                : {}),
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
        const reason = single?.error || (single?.status ? `HTTP ${single.status}` : "");
        const rejectedMessage = reason ? `测速未通过：${reason}` : "测速未通过";
        finish("benchmark-rejected", {
          type: candidate.type,
          available: false,
          verified: true,
          singleUse: false,
          ttfbMs: null,
          speedKBps: 0,
          message: rejectedMessage,
        });
        logger.warn("benchmark.rejected", { provider: candidate.provider, message: rejectedMessage });
        return {
          candidate,
          ranked: {
            provider: candidate.provider,
            kind: item.kind,
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
        ...(single.unmeasured
          ? { unmeasured: true, message: `测速未完成，按未测速处理：${single.error}` }
          : {}),
      });
      return {
        candidate: raceResult.winner,
        ranked: { ...single, provider: candidate.provider, kind: item.kind, verified: true, singleUse: false },
      };
    };
    const settled = new Set();
    // 渠道成败记入健康账本。成功 = 产出了可用线路（含未测速、单次链接、与其他渠道重复的地址）；
    // 失败 = 无结果、被拒、域名失效、测速硬失败。冷却跳过和本机环境问题（没装 Chrome、
    // DevTools 起不来）不是渠道的责任，不计入。
    const recordOutcome = (item) => {
      const last = diagnostics.findLast((entry) => entry.provider === item.id);
      if (!last || last.status === "cooldown") return;
      if (last.status === "rejected" && LOCAL_ENV_ERRORS.has(last.code)) return;
      registry.record(item.id, RECORDED_SUCCESS.has(last.status));
    };
    const runTracked = async (item) => {
      try {
        const result = await runOne(item);
        recordOutcome(item);
        return result;
      } catch (err) {
        logger.warn("resolver.crashed", { provider: item.id, message: err?.message });
        registry.record(item.id, false);
        return null;
      } finally {
        settled.add(item.id);
      }
    };
    const runResolvers = async (list) => (await Promise.all(list.map(runTracked))).filter(Boolean);

    const primary = resolvers.filter((item) => !item.fallback);
    const fallback = resolvers.filter((item) => item.fallback);
    const measured = [];
    const lateResults = [];
    let responded = false;
    let lateSink = null;
    const isGood = (result) => result.ranked.available && result.ranked.verified;
    const primaryTasks = primary.map((item) => runTracked(item).then((result) => {
      if (!result) return null;
      if (!responded) measured.push(result);
      else if (lateSink) lateSink(result);
      else lateResults.push(result);
      return result;
    }));
    await waitForPrimary(primaryTasks, parseGraceMs, isGood);
    responded = true;
    const pendingPrimary = primary.filter((item) => !settled.has(item.id));
    const hasVerifiedAvailable = measured.some(isGood);
    if (fallback.length) {
      if (hasVerifiedAvailable) {
        for (const item of fallback) {
          diagnostics.push({
            provider: item.id,
            kind: item.kind,
            status: "fallback-skipped",
            ms: 0,
            message: "已有可用已验证线路",
          });
        }
      } else {
        measured.push(...(await runResolvers(fallback)));
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
      // expiresAtMs 必须随候选一起缓存：/api/race 的过期过滤读的就是这个字段，
      // 之前只存在于 candidate 上，缓存里的 ranked 全部为 undefined，
      // 导致 singleUse 候选要么被永久保留，要么被错误排除。
      ...(Number.isFinite(item.candidate?.expiresAtMs)
        ? { expiresAtMs: item.candidate.expiresAtMs }
        : {}),
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

    // 仍在后台的渠道在响应里标记为 background，跑完后只补进缓存的备用线路，不再改写已发出的响应。
    const responseDiagnostics = [
      ...diagnostics,
      ...pendingPrimary.map((item) => ({
        provider: item.id,
        kind: item.kind,
        status: "background",
        ms: Math.round(performance.now() - parseStartedAt),
        message: "已有可用线路，仍在后台解析，完成后补入备用线路",
      })),
    ];

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
      diagnostics: responseDiagnostics,
      cached: false,
      danmaku: {
        provider: "dmku",
        endpoint: `/api/danmaku?url=${encodeURIComponent(selectedResult.sourceUrl)}`,
      },
    };

    const stored = storeCached(parseCache, sourceUrl, data, expiresAtMs,
      measured.map((item) => {
        const { stream: _stream, metric: _metric, ...candidate } = item.candidate;
        return candidate;
      }));
    // 后台完成的渠道补进同一条缓存：换线（/api/race）时才能用上它们。
    // 缓存条目已被强制重新解析替换或过期时丢弃，避免把旧结果混进新的候选。
    const attachLate = (result) => {
      const { stream: _stream, metric: _metric, ...candidate } = result.candidate;
      if (!stored || parseCache.get(sourceUrl) !== stored) {
        logger.info("parse.late_dropped", { provider: result.ranked.provider });
        return;
      }
      stored.candidates.push(candidate);
      stored.data.candidates.push({
        ...result.ranked,
        ...(Number.isFinite(candidate.expiresAtMs) ? { expiresAtMs: candidate.expiresAtMs } : {}),
        selected: false,
      });
      logger.info("parse.late_candidate", {
        pageHost: hostOf(sourceUrl),
        provider: result.ranked.provider,
        playHost: hostOf(result.ranked.playUrl),
        available: result.ranked.available,
        verified: result.ranked.verified,
      });
    };
    lateSink = attachLate;
    for (const result of lateResults.splice(0)) attachLate(result);
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
      diagnostics: responseDiagnostics.map(({ provider, status, ms }) => ({
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
    // 域名级别的失败信息：avoidHosts 失败过 1 次，换线时让其他域名的候选优先；
    // blockedHosts 已连续失败，直接排除。两者都来自客户端，只当作不可信的字符串列表使用。
    const hostList = (value, label) => {
      const list = Array.isArray(value) ? value : [];
      if (list.length > 20 || list.some((item) => typeof item !== "string" || item.length > 255)) {
        throw new AppError("BAD_REQUEST", 400, label);
      }
      return new Set(list.map((item) => item.toLowerCase()));
    };
    const avoidHosts = hostList(body.avoidHosts, "无效的待避开域名列表");
    const blockedHosts = hostList(body.blockedHosts, "无效的已失败域名列表");
    const hostBlocked = (item) => blockedHosts.has(hostOf(item.playUrl).toLowerCase());
    const allCandidates = entry.candidates;
    const filtered = {
      total: allCandidates.length,
      excluded: allCandidates.filter((item) => excluded.includes(item.playUrl)).length,
      expired: allCandidates.filter((item) =>
        Number.isFinite(item.expiresAtMs) && item.expiresAtMs <= now()).length,
      hostBlocked: allCandidates.filter(hostBlocked).length,
      remaining: 0,
    };
    const candidates = allCandidates.filter((item) =>
      !excluded.includes(item.playUrl) &&
      !hostBlocked(item) &&
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
        // race 的 ranked 由 benchmark 生成，不含 kind；回填缓存候选上的渠道类型。
        ranked = ranked.map((item) => {
          const source = verifiedCandidates.find((c) => c.provider === item.provider);
          return { ...item, kind: source?.kind };
        });
      } catch (err) {
        logger.warn("race.failed", { message: err?.message });
      }
    }
    const singleUseRanked = singleUseCandidates.map((item) => ({
      provider: item.provider,
      kind: item.kind,
      playUrl: item.playUrl,
      type: item.type,
      ...(Number.isFinite(item.expiresAtMs) ? { expiresAtMs: item.expiresAtMs } : {}),
      speedKBps: 0,
      ttfbMs: null,
      score: 0,
      available: true,
      selected: false,
      verified: false,
      singleUse: true,
    }));
    // 选择顺序：未失败过域名的已验证线路 > 未失败过域名的单次链接 >
    // 失败过域名的已验证线路 > 失败过域名的单次链接；同档内保持原有的测速排名。
    const tierOf = (item) =>
      (avoidHosts.has(hostOf(item.playUrl).toLowerCase()) ? 2 : 0) + (item.singleUse ? 1 : 0);
    let picked = null;
    for (const item of [...ranked.filter((c) => c.available !== false), ...singleUseRanked]) {
      if (!picked || tierOf(item) < tierOf(picked)) picked = item;
    }
    const mark = (list) => list.map((item) => ({ ...item, selected: item === picked }));
    const finalRanked = mark(ranked);
    const finalSingleUse = mark(singleUseRanked);
    const selected = [...finalRanked, ...finalSingleUse].find((item) => item.selected) ?? null;
    sendJson(res, 200, {
      ok: true,
      data: { selected, candidates: [...finalRanked, ...finalSingleUse], filtered },
    });
  }

  async function handleChannels(req, res) {
    if (req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        data: registry.status(["jiexi789", "jx-browser"]),
      });
      return;
    }
    if (req.method === "POST") {
      const raw = await readRequestBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new AppError("BAD_REQUEST", 400, "无效的 JSON 请求体");
      }
      const result = registry.applyRemote(body);
      registry.flush();
      logger.info("channels.updated", {
        accepted: result.accepted.length,
        rejected: result.rejected.length,
      });
      sendJson(res, 200, {
        ok: true,
        data: {
          accepted: result.accepted,
          rejected: result.rejected,
          status: registry.status(["jiexi789", "jx-browser"]),
        },
      });
      return;
    }
    sendMethodNotAllowed(res, "GET, POST");
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

      if (requestUrl.pathname === "/api/dev/auth") {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res, "POST");
          return;
        }
        const raw = await readRequestBody(req);
        let body;
        try { body = JSON.parse(raw); } catch { throw new AppError("BAD_REQUEST", 400, "无效的 JSON"); }
        const password = typeof body?.password === "string" ? body.password.trim() : "";
        if (password === (config.devPassword || "adminysdev")) {
          sendJson(res, 200, { ok: true });
        } else {
          sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "密码错误" } });
        }
        return;
      }

      if (requestUrl.pathname === "/api/channels/sync") {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res, "POST");
          return;
        }
        const refreshed = await registry.refresh();
        registry.flush();
        sendJson(res, 200, {
          ok: true,
          data: {
            refreshed,
            status: registry.status(["jiexi789", "jx-browser"]),
          },
        });
        return;
      }

      if (requestUrl.pathname === "/api/channels") {
        await handleChannels(req, res);
        return;
      }

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

export function createProductionRegistry() {
  const health = createChannelHealth({
    file: config.channelStateFile,
    timeZone: config.channelTimezone,
    deadDays: config.channelDeadDays,
    minAttempts: config.channelMinDailyAttempts,
    logger: log,
  });
  health.evaluate();
  return createChannelRegistry({
    builtins: enabledHttpChannels(config.httpProviderIds),
    health,
    remoteUrl: config.channelConfigUrl,
    refreshMs: config.channelConfigRefreshMs,
    logger: log,
  });
}

export function start() {
  const channelRegistry = createProductionRegistry();
  channelRegistry.refresh();
  const server = createServer({ channelRegistry });

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
    channelRegistry.flush();
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
