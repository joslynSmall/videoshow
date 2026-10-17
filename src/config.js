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
  enableBrowserProvider: process.env.ENABLE_BROWSER_PROVIDER !== "false",
  chromeBin: process.env.CHROME_BIN || "/usr/bin/google-chrome",
  benchmarkTimeoutMs: intEnv("BENCHMARK_TIMEOUT_MS", 3000),
  requestTimeoutMs: intEnv("REQUEST_TIMEOUT_MS", 15000),
  metadataTimeoutMs: intEnv("METADATA_TIMEOUT_MS", 5000),
  danmakuTimeoutMs: intEnv("DANMAKU_TIMEOUT_MS", 10000),
  streamTimeoutMs: intEnv("STREAM_TIMEOUT_MS", 10000),
  cacheTtlMs: intEnv("CACHE_TTL_MS", 300000),
  cacheMaxEntries: intEnv("CACHE_MAX_ENTRIES", 200),
  publicDir: path.join(projectRoot, "public"),
};

for (const [name, value] of [
  ["UPSTREAM_BASE", config.upstreamBase],
  ["METADATA_IQIYI_URL", config.metadataIqiyiUrl],
  ["DANMAKU_BASE_URL", config.danmakuBaseUrl],
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
