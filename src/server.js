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
import { loadCatalogTitle, searchCatalog } from "./catalog.js";
import { openMedia } from "./media.js";
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
  validate = validateStream,
  enrich = enrichMetadata,
  fetchDanmaku = fetchDmkuDanmaku,
  search = searchCatalog,
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

  function getCached(cache, key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      cache.delete(key);
      return null;
    }
    return entry;
  }

  function storeCached(cache, key, data, expiresAtMs) {
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
    cache.set(key, { data, expiresAt: expiry });
  }

  async function handleParse(res, requestUrl) {
    const sourceUrl = normalizeVideoUrl(requestUrl.searchParams.get("url"));
    const cached = getCached(parseCache, sourceUrl);
    if (cached) {
      sendJson(res, 200, { ok: true, data: { ...cached.data, cached: true } });
      return;
    }

    const candidatePromises = [
      resolve(sourceUrl).catch((err) => {
        logger.warn("resolve.789_failed", { message: err?.message });
        return null;
      }),
    ];

    if (config.enableBrowserProvider && resolveBrowser) {
      candidatePromises.push(
        resolveBrowser(sourceUrl, config.requestTimeoutMs).catch((err) => {
          logger.warn("resolve.browser_failed", { message: err?.message });
          return null;
        }),
      );
    }

    const resolvedCandidates = (await Promise.all(candidatePromises)).filter(
      Boolean,
    );
    if (resolvedCandidates.length === 0) {
      throw new AppError("PARSE_FAILED", 502, "所有解析线路均未能解析该视频");
    }

    const normalizedCandidates = resolvedCandidates.map((c) => ({
      ...c,
      type: normalizeType(c.type, c.playUrl),
    }));

    const { winner, ranked } = await race(normalizedCandidates, {
      timeoutMs: config.benchmarkTimeoutMs,
    });

    const selectedResult = winner || normalizedCandidates[0];
    const stream =
      (await validate(selectedResult.playUrl, selectedResult.type).catch(
        () => ({}),
      )) ?? {};
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
      candidates: ranked,
      cached: false,
      danmaku: {
        provider: "dmku",
        endpoint: `/api/danmaku?url=${encodeURIComponent(selectedResult.sourceUrl)}`,
      },
    };

    storeCached(parseCache, sourceUrl, data, expiresAtMs);
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

  async function handleRace(req, res, requestUrl) {
    let candidates = [];
    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        const parsed = JSON.parse(raw);
        candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
      } catch {
        throw new AppError("BAD_REQUEST", 400, "无效的 JSON 请求体");
      }
    } else if (req.method === "GET") {
      const sourcesParam = requestUrl.searchParams.get("sources");
      if (sourcesParam) {
        try {
          candidates = JSON.parse(sourcesParam);
        } catch {
          throw new AppError("BAD_REQUEST", 400, "无效的 sources 参数");
        }
      }
    } else {
      sendMethodNotAllowed(res, "GET, POST");
      return;
    }

    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new AppError("BAD_REQUEST", 400, "缺少候选流地址列表");
    }

    const raceResult = await race(candidates, {
      probeSingle: true,
      timeoutMs: config.benchmarkTimeoutMs,
    });
    const ranked = raceResult?.ranked ?? [];
    const selected =
      ranked.find((c) => c.selected && c.available !== false) ?? null;
    sendJson(res, 200, { ok: true, data: { selected, candidates: ranked } });
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
