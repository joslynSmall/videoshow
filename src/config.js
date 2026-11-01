import path from "node:path";
import { fileURLToPath } from "node:url";

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: intEnv("PORT", 3000),
  upstreamBase: (process.env.UPSTREAM_BASE || "https://api-api.789jiexi.net").replace(/\/+$/, ""),
  aesKey: process.env.UPSTREAM_AES_KEY || "ARTPLAYERliUlanG",
  aesIv: process.env.UPSTREAM_AES_IV || "ArtplayerliUlanG",
  metadataIqiyiUrl:
    process.env.METADATA_IQIYI_URL ||
    "https://pcw-api.iqiyi.com/video/video/playervideoinfo",
  danmakuBaseUrl:
    process.env.DANMAKU_BASE_URL || "https://jx.1ljx.com/dan/@lirose_tv/",
  enableBrowserProvider: process.env.VERCEL
    ? process.env.ENABLE_BROWSER_PROVIDER === "true"
    : process.env.ENABLE_BROWSER_PROVIDER !== "false",
  // 备用无头嗅探入口，产出与 jx-browser 不同的 CDN，用于互为备份。
  browserTxnpEndpoint: process.env.BROWSER_TXNP_ENDPOINT || "https://bfq.txnp.cn/player?url=",
  httpProviderIds: process.env.HTTP_PROVIDER_IDS === undefined
    ? null
    : process.env.HTTP_PROVIDER_IDS
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  httpProviderTimeoutMs: intEnv("HTTP_PROVIDER_TIMEOUT_MS", 12000),
  // 同一个解析会话两轮解析之间的最小间隔：客户端线路耗尽后会请求追加一轮，
  // 多位观众同时请求、或同一位观众反复请求，都不能让上游被连续打满。
  parseRefreshMinMs: intEnv("PARSE_REFRESH_MIN_MS", 15000),
  // 事件流的心跳间隔，避免反向代理把长时间没有数据的连接当作空闲连接断开。
  streamHeartbeatMs: intEnv("STREAM_HEARTBEAT_MS", 15000),
  channelConfigUrl: process.env.CHANNEL_CONFIG_URL || "",
  channelConfigRefreshMs: intEnv("CHANNEL_CONFIG_REFRESH_MS", 600000),
  devPassword: process.env.DEV_PASSWORD || "adminysdev",
  // 渠道健康账本的落盘位置；Serverless 环境文件系统不可持久，默认只用内存。设为空字符串可关闭落盘。
  channelStateFile: process.env.CHANNEL_STATE_FILE !== undefined
    ? process.env.CHANNEL_STATE_FILE
    : process.env.VERCEL
      ? ""
      : path.join(projectRoot, "data", "channel-state.json"),
  channelDeadDays: intEnv("CHANNEL_DEAD_DAYS", 3),
  channelMinDailyAttempts: intEnv("CHANNEL_MIN_DAILY_ATTEMPTS", 3),
  // 被摘除的渠道每隔多少分钟放回一轮解析里试探一次，成功就自动复活；0 表示不试探。
  channelProbeMinutes: intEnv("CHANNEL_PROBE_MINUTES", 360),
  channelTimezone: process.env.CHANNEL_TIMEZONE || "",
  benchmarkTimeoutMs: intEnv("BENCHMARK_TIMEOUT_MS", 3000),
  requestTimeoutMs: intEnv("REQUEST_TIMEOUT_MS", 15000),
  metadataTimeoutMs: intEnv("METADATA_TIMEOUT_MS", 5000),
  danmakuTimeoutMs: intEnv("DANMAKU_TIMEOUT_MS", 10000),
  streamTimeoutMs: intEnv("STREAM_TIMEOUT_MS", 10000),
  mediaDnsMode: process.env.MEDIA_DNS_MODE || "auto",
  searchTimeoutMs: intEnv("SEARCH_TIMEOUT_MS", 8000),
  catalogSearchUrl:
    process.env.CATALOG_SEARCH_URL || "https://api.so.360kan.com/index",
  catalogDetailUrl:
    process.env.CATALOG_DETAIL_URL || "https://api.web.360kan.com/v1/detail",
  cacheTtlMs: intEnv("CACHE_TTL_MS", 300000),
  cacheMaxEntries: intEnv("CACHE_MAX_ENTRIES", 200),
  publicDir: path.join(projectRoot, "public"),
};

if (config.channelConfigUrl) {
  let url;
  try {
    url = new URL(config.channelConfigUrl);
  } catch {
    throw new Error("CHANNEL_CONFIG_URL must be a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("CHANNEL_CONFIG_URL must use https");
}

if (config.channelTimezone) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: config.channelTimezone });
  } catch {
    throw new Error("CHANNEL_TIMEZONE must be a valid IANA time zone");
  }
}

if (!["system", "public", "auto"].includes(config.mediaDnsMode)) {
  throw new Error("MEDIA_DNS_MODE must be system, public, or auto");
}

for (const [name, value] of [
  ["UPSTREAM_BASE", config.upstreamBase],
  ["METADATA_IQIYI_URL", config.metadataIqiyiUrl],
  ["DANMAKU_BASE_URL", config.danmakuBaseUrl],
  ["CATALOG_SEARCH_URL", config.catalogSearchUrl],
  ["CATALOG_DETAIL_URL", config.catalogDetailUrl],
]) {
  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

if (
  Buffer.byteLength(config.aesKey) !== 16 ||
  Buffer.byteLength(config.aesIv) !== 16
) {
  throw new Error("UPSTREAM_AES_KEY and UPSTREAM_AES_IV must each be 16 bytes");
}
