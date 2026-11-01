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
import { createSessionStore, formatSseEvent, parseCursor } from "./parse-session.js";
import { absolutizePlaylist, lineKey, segmentHosts } from "./playlist.js";
import { extractExpiry, normalizeType, validateStream } from "./stream.js";

const RECORDED_SUCCESS = new Set(["snapshot", "benchmarked", "unverified", "duplicate"]);
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
    "/line-book.js",
    {
      file: "line-book.js",
      type: "text/javascript; charset=utf-8",
      cache: "no-cache",
    },
  ],
  [
    "/resolve-stream.js",
    {
      file: "resolve-stream.js",
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
  refreshMinMs = config.parseRefreshMinMs,
  heartbeatMs = config.streamHeartbeatMs,
  channelRegistry = null,
} = {}) {
  const registry = channelRegistry ?? createChannelRegistry({
    builtins: httpChannels,
    builtinBrowsers: builtinBrowserChannels(),
  });
  const sessions = createSessionStore({ ttlMs: cacheTtlMs, maxSessions: cacheMaxEntries, now });
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

  function buildResolvers(sourceUrl) {
    registry.ensureFresh();
    // 被外部配置停用的渠道不再参与解析。被健康账本摘除的渠道平时也不参与，
    // 只在到了试探时间时放回这一轮跑一次（probe），产出可用线路就自动复活。
    const resolvers = [];
    // 内置渠道的在用判断：在用直接加入；被摘除则看是否轮到试探。
    const admit = (id) => {
      if (registry.isActive(id)) return { probe: false };
      if (registry.isRemoved(id) && registry.claimProbe(id)) return { probe: true };
      return null;
    };
    const jiexi = admit("jiexi789");
    if (jiexi) {
      // kind 用于日志区分渠道实现方式，由服务端定义，前端不做硬编码推断。
      resolvers.push({ id: "jiexi789", kind: "api", probe: jiexi.probe, run: () => resolve(sourceUrl) });
    }
    const jxBrowser = config.enableBrowserProvider && resolveBrowser ? admit("jx-browser") : null;
    if (jxBrowser) {
      resolvers.push({
        id: "jx-browser",
        kind: "browser",
        probe: jxBrowser.probe,
        run: () => resolveBrowser(sourceUrl, config.requestTimeoutMs),
      });
    }
    if (config.enableBrowserProvider && resolveBrowser) {
      // 内置与外部配置的 browser 渠道统一调度；两者都带 endpoint，
      // jx-browser 走 jx.1ljx.com（产出 png.ruyijx.com），
      // 备用入口走 bfq.txnp.cn（产出 vv.iisfu.top），不同 CDN 可互为备份。
      const browsers = [
        ...registry.browserChannels().map((b) => ({ b, probe: false })),
        ...registry.removedBrowserChannels().filter((b) => registry.claimProbe(b.id)).map((b) => ({ b, probe: true })),
      ];
      for (const { b, probe } of browsers) {
        resolvers.push({
          id: b.id,
          kind: "browser",
          probe,
          run: () => resolveBrowser(sourceUrl, config.requestTimeoutMs, {
            endpoint: b.endpoint,
            provider: b.id,
          }),
        });
      }
    }
    const httpEntries = [
      ...registry.httpChannels().map((channel) => ({ channel, probe: false })),
      ...registry.removedHttpChannels().filter((channel) => registry.claimProbe(channel.id)).map((channel) => ({ channel, probe: true })),
    ];
    for (const { channel, probe } of httpEntries) {
      resolvers.push({
        id: channel.id,
        kind: "http-api",
        // 试探必须真的跑一次才有结论，不能被“已有可用线路”跳过，所以不走备用队列。
        fallback: !probe && channel.fallback === true,
        probe,
        run: () => resolveHttp(channel, sourceUrl, {
          timeoutMs: config.httpProviderTimeoutMs,
          resolveBrowserPage: resolveBingdou,
        }),
      });
    }
    return resolvers;
  }

  // 标题和封面不阻塞起播：第一条线路出来后单独补发一个 meta 事件。
  function emitMeta(session, candidate) {
    return Promise.resolve()
      .then(() => enrich(candidate.sourceUrl ?? session.sourceUrl, candidate.playUrl, candidate.stream))
      .catch(() => null)
      .then((info) => {
        session.emit("meta", { title: info?.title ?? null, cover: info?.cover ?? null });
      });
  }

  // 一轮解析：所有渠道并发，线路一通过校验和测速就作为 line 事件推给观众，不等其他渠道。
  async function runRound(session) {
    // running 必须在第一个 await 之前置位，调用方依赖它判断是否有一轮正在进行。
    session.running = true;
    session.rounds += 1;
    session.lastRoundAt = now();
    const round = session.rounds;
    const sourceUrl = session.sourceUrl;
    const startedAt = performance.now();
    const linesBefore = session.lineCount;
    const diagnostics = [];
    let resolvedCount = 0;
    let validatedCount = 0;
    let hasVerifiedLine = false;

    const emitDiagnostic = (diagnostic) => {
      diagnostics.push(diagnostic);
      session.emit("diagnostic", { round, ...diagnostic });
    };

    const emitLine = (candidate, item, fields) => {
      const localId = session.nextLineId();
      // 线路编号带上会话编号：会话过期重建后，客户端手上的新旧线路不会重号。
      const id = `${session.id}.${localId}`;
      const host = hostOf(candidate.playUrl);
      const snapshotText = fields.snapshotText ?? null;
      let playUrl = candidate.playUrl;
      if (snapshotText) {
        session.setSnapshot(localId, snapshotText);
        playUrl = `/api/snapshot?s=${encodeURIComponent(session.id)}&l=${encodeURIComponent(localId)}`;
      }
      const playlist = candidate.stream?.playlist;
      const segmentHost = candidate.type === "m3u8" && typeof playlist === "string"
        ? (segmentHosts(playlist, candidate.playUrl, 1)[0] ?? host)
        : host;
      const expiresAtMs = Number.isFinite(candidate.expiresAtMs)
        ? candidate.expiresAtMs
        : extractExpiry(candidate.playUrl);
      const line = {
        id,
        provider: candidate.provider,
        kind: item.kind,
        type: candidate.type,
        playUrl,
        host,
        segmentHost,
        snapshot: Boolean(snapshotText),
        shortLived: candidate.shortLived === true,
        verified: fields.verified,
        available: true,
        ttfbMs: fields.ttfbMs ?? null,
        speedKBps: fields.speedKBps ?? 0,
        score: fields.score ?? 0,
        ...(fields.unmeasured ? { unmeasured: true } : {}),
        key: fields.key,
        ...(Number.isFinite(expiresAtMs) ? { expiresAtMs } : {}),
        round,
      };
      session.emit("line", line);
      if (line.verified) hasVerifiedLine = true;
      logger.info("resolve.line", {
        pageHost: hostOf(sourceUrl),
        provider: line.provider,
        playHost: line.host,
        segmentHost: line.segmentHost,
        snapshot: line.snapshot,
        verified: line.verified,
        ttfbMs: line.ttfbMs,
        score: line.score,
        round,
      });
      if (!session.metaRequested) {
        session.metaRequested = true;
        session.metaPromise = emitMeta(session, candidate);
      }
      return line;
    };

    const runOne = async (item) => {
      const itemStartedAt = performance.now();
      const diagnostic = { provider: item.id, kind: item.kind };
      const finish = (status, extra = {}) => {
        emitDiagnostic({
          ...diagnostic,
          status,
          ms: Math.round(performance.now() - itemStartedAt),
          ...extra,
        });
      };
      if ((providerCooldowns.get(item.id) || 0) > now()) {
        finish("cooldown");
        return null;
      }
      let candidate;
      let key = null;
      let snapshotText = null;
      try {
        const result = await item.run();
        providerCooldowns.delete(item.id);
        if (!result) {
          finish("empty");
          return null;
        }
        diagnostic.playHost = hostOf(result.playUrl);
        if (session.seenUrls.has(result.playUrl)) {
          finish("duplicate");
          return null;
        }
        session.seenUrls.add(result.playUrl);
        resolvedCount += 1;
        const type = normalizeType(result.type, result.playUrl);
        if (result.shortLived && type !== "m3u8") {
          // 没有清单可取（例如直接给出 mp4 的短时效链接）：无法做快照，服务端也不预读，
          // 作为未经校验的线路交给浏览器首次读取。
          candidate = { ...result, type, stream: { playlist: null } };
          finish("unverified", { type, available: true, verified: false });
          return emitLine(candidate, item, { verified: false, key: candidate.playUrl });
        }
        await guardMedia(result.playUrl);
        // 短时效线路的清单地址只有几秒有效期，这是它唯一可读的时机：读到的文本固化成快照。
        const stream = await validate(result.playUrl, type);
        validatedCount += 1;
        candidate = { ...result, type, stream };
        if (type === "m3u8" && typeof stream?.playlist === "string") {
          key = lineKey(hostOf(result.playUrl), stream.playlist, result.playUrl);
          if (result.shortLived) snapshotText = absolutizePlaylist(stream.playlist, result.playUrl);
        }
        if (key) {
          if (session.seenKeys.has(key)) {
            finish("duplicate");
            return null;
          }
          session.seenKeys.add(key);
        }
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
          message: rejectedMessage,
        });
        logger.warn("benchmark.rejected", { provider: candidate.provider, message: rejectedMessage });
        // 指纹只代表“已经产出或正在测的内容”：这条没能产出线路，就释放它，
        // 内容相同的后到线路还有机会重测（这次失败可能只是临时的）。
        if (key) session.seenKeys.delete(key);
        return null;
      }
      finish(snapshotText ? "snapshot" : "benchmarked", {
        type: candidate.type,
        available: single.available,
        verified: true,
        shortLived: candidate.shortLived === true,
        ttfbMs: single.ttfbMs,
        speedKBps: single.speedKBps,
        score: single.score,
        ...(single.unmeasured
          ? { unmeasured: true, message: `测速未完成，按未测速处理：${single.error}` }
          : {}),
      });
      return emitLine(candidate, item, {
        verified: true,
        key: key ?? candidate.playUrl,
        snapshotText,
        ttfbMs: single.ttfbMs,
        speedKBps: single.speedKBps,
        score: single.score,
        unmeasured: single.unmeasured === true,
      });
    };

    // 渠道成败记入健康账本。成功 = 产出了可用线路（含未测速、快照、与其他渠道重复的地址）；
    // 失败 = 无结果、被拒、测速硬失败。冷却跳过和本机环境问题（没装 Chrome、
    // DevTools 起不来）不是渠道的责任，不计入。
    const recordOutcome = (item) => {
      const last = diagnostics.findLast((entry) => entry.provider === item.id);
      if (!last || last.status === "cooldown") return;
      if (last.status === "rejected" && LOCAL_ENV_ERRORS.has(last.code)) return;
      const ok = RECORDED_SUCCESS.has(last.status);
      if (item.probe) registry.recordProbe(item.id, ok);
      else registry.record(item.id, ok);
    };
    const runTracked = async (item) => {
      try {
        const line = await runOne(item);
        recordOutcome(item);
        return line;
      } catch (err) {
        logger.warn("resolver.crashed", { provider: item.id, message: err?.message });
        if (item.probe) registry.recordProbe(item.id, false);
        else registry.record(item.id, false);
        return null;
      }
    };

    session.emit("round", { round });
    try {
      const resolvers = buildResolvers(sourceUrl);
      const primary = resolvers.filter((item) => !item.fallback);
      const fallback = resolvers.filter((item) => item.fallback);
      await Promise.all(primary.map(runTracked));
      if (fallback.length) {
        if (hasVerifiedLine) {
          for (const item of fallback) {
            emitDiagnostic({
              provider: item.id,
              kind: item.kind,
              status: "fallback-skipped",
              ms: 0,
              message: "已有可用已验证线路",
            });
          }
        } else {
          await Promise.all(fallback.map(runTracked));
        }
      }
      // 标题补发完再收尾：事件流在 done 之后就关闭，晚到的 meta 会被截断。
      await session.metaPromise;
      const ms = Math.round(performance.now() - startedAt);
      logger.info("resolve.round", {
        pageHost: hostOf(sourceUrl),
        round,
        newLines: session.lineCount - linesBefore,
        lines: session.lineCount,
        ms,
      });
      if (session.lineCount === 0) {
        const [code, message] = validatedCount
          ? ["STREAM_INVALID", "播放线路测速均未通过"]
          : resolvedCount
            ? ["STREAM_INVALID", "所有解析线路均未返回可播放媒体"]
            : ["PARSE_FAILED", "所有解析线路均未能解析该视频"];
        session.running = false;
        session.emit("failed", { round, code, message });
      } else {
        session.running = false;
        session.emit("done", { round, lines: session.lineCount, newLines: session.lineCount - linesBefore, ms });
      }
    } catch (err) {
      logger.error("resolve.crashed", { pageHost: hostOf(sourceUrl), message: err?.message });
      session.running = false;
      session.emit("failed", { round, code: "INTERNAL", message: "服务内部错误" });
    }
  }

  // 找到或新建这个页面的解析会话。线路全部用完的观众请求追加一轮（refresh），
  // 会话里一条线路都没有时，后来的观众也会触发新一轮；两种情况都受最小间隔限制。
  function acquireSession(sourceUrl, { refresh }) {
    let session = sessions.get(sourceUrl);
    if (!session) {
      session = sessions.create(sourceUrl);
      session.emit("session", {
        sourceUrl,
        pageHost: hostOf(sourceUrl),
        danmaku: {
          provider: "dmku",
          endpoint: `/api/danmaku?url=${encodeURIComponent(sourceUrl)}`,
        },
      });
      void runRound(session);
      return session;
    }
    const wantsRound = refresh || session.lineCount === 0;
    if (!session.running && wantsRound && now() - session.lastRoundAt >= refreshMinMs) {
      void runRound(session);
    }
    return session;
  }

  async function handleResolve(req, res, requestUrl) {
    const sourceUrl = normalizeVideoUrl(requestUrl.searchParams.get("url"));
    const refresh = requestUrl.searchParams.get("refresh") === "1";
    const session = acquireSession(sourceUrl, { refresh });
    // EventSource 重连会自带 Last-Event-ID；客户端自己重连时用 after 参数。
    const cursor = parseCursor(req.headers["last-event-id"] || requestUrl.searchParams.get("after"));
    const afterSeq = cursor && cursor.sessionId === session.id ? cursor.seq : 0;

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      // 提示 nginx 之类的反向代理不要缓冲，否则线路要等缓冲区写满才到客户端。
      "x-accel-buffering": "no",
    });
    const write = (chunk) => {
      if (!res.writableEnded && !res.destroyed) res.write(chunk);
    };
    write("retry: 2000\n\n");
    for (const event of session.replay(afterSeq)) write(formatSseEvent(event));

    const finish = () => {
      if (res.writableEnded || res.destroyed) return;
      // 明确的结束标记：客户端据此区分“解析已结束”和“连接中途断开需要重连”。
      write(formatSseEvent({ type: "end", data: {} }));
      res.end();
    };
    if (!session.running) {
      finish();
      return;
    }
    const heartbeat = setInterval(() => write(": ping\n\n"), heartbeatMs);
    const unsubscribe = session.subscribe((event) => {
      write(formatSseEvent(event));
      if (event.type === "done" || event.type === "failed") {
        cleanup();
        finish();
      }
    });
    function cleanup() {
      clearInterval(heartbeat);
      unsubscribe();
    }
    res.once("close", cleanup);
  }

  async function handleSnapshot(req, res, requestUrl) {
    const sessionId = requestUrl.searchParams.get("s") || "";
    const lineId = requestUrl.searchParams.get("l") || "";
    const text = /^[A-Za-z0-9]{1,32}$/.test(sessionId) && /^L\d{1,6}$/.test(lineId)
      ? sessions.getById(sessionId)?.snapshot(lineId)
      : null;
    if (typeof text !== "string") {
      throw new AppError("SNAPSHOT_EXPIRED", 404, "线路快照已过期，请重新解析");
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
      "content-length": Buffer.byteLength(text),
      "cache-control": "no-store",
    });
    if (req.method === "HEAD") res.end();
    else res.end(text);
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

  function verifyDevPassword(req, body) {
    const headerPwd = typeof req.headers["x-dev-password"] === "string"
      ? req.headers["x-dev-password"].trim()
      : "";
    const bodyPwd = typeof body?.password === "string" ? body.password.trim() : "";
    const provided = headerPwd || bodyPwd;
    return provided === (config.devPassword || "adminysdev");
  }

  async function handleChannels(req, res) {
    if (req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        data: registry.status(["jiexi789", "jx-browser", "jx-browser-txnp"]),
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
      if (!verifyDevPassword(req, body)) {
        sendJson(res, 401, {
          ok: false,
          error: { code: "UNAUTHORIZED", message: "未授权：需要管理员密码" },
        });
        return;
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
          status: registry.status(["jiexi789", "jx-browser", "jx-browser-txnp"]),
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
        if (!verifyDevPassword(req)) {
          sendJson(res, 401, {
            ok: false,
            error: { code: "UNAUTHORIZED", message: "未授权：需要管理员密码" },
          });
          return;
        }
        const refreshed = await registry.refresh();
        registry.flush();
        sendJson(res, 200, {
          ok: true,
          data: {
            refreshed,
            status: registry.status(["jiexi789", "jx-browser", "jx-browser-txnp"]),
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

      if (requestUrl.pathname === "/api/resolve") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res, "GET");
          return;
        }
        await handleResolve(req, res, requestUrl);
        return;
      }

      if (requestUrl.pathname === "/api/snapshot") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendMethodNotAllowed(res, "GET, HEAD");
          return;
        }
        await handleSnapshot(req, res, requestUrl);
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

// 内置无头嗅探渠道。jx-browser 的解析站与其产出的 CDN
// （jx.1ljx.com → png.ruyijx.com）会整体性间歇失效，而 qilin/lx
// 也共用同一个 png.ruyijx.com，多个渠道一起挂时无处可换。
// txnp 走另一套 CDN（bfq.txnp.cn → vv.iisfu.top），两者互为备份。
export function builtinBrowserChannels() {
  if (!config.enableBrowserProvider) return [];
  return [{
    id: "jx-browser-txnp",
    name: "TXNP嗅探源",
    endpoint: config.browserTxnpEndpoint,
  }];
}

export function createProductionRegistry() {
  const health = createChannelHealth({
    file: config.channelStateFile,
    timeZone: config.channelTimezone,
    deadDays: config.channelDeadDays,
    minAttempts: config.channelMinDailyAttempts,
    probeIntervalMs: config.channelProbeMinutes * 60_000,
    logger: log,
  });
  health.evaluate();
  return createChannelRegistry({
    builtins: enabledHttpChannels(config.httpProviderIds),
    builtinBrowsers: builtinBrowserChannels(),
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
