import { AppError } from "../errors.js";
import { USER_AGENT } from "../http.js";
import { resolveJiexiUpstream } from "../provider.js";
import { resolveBingdouResponse } from "./bingdou.js";
import { resolveJiexi789PageResponse } from "./jiexi789-page.js";
import { resolveLxResponse } from "./lx.js";
import { resolvePlayerConfigResponse } from "./player-config.js";

export const HTTP_CHANNELS = Object.freeze([
  {
    id: "lx", name: "LX解析", endpoint: "https://jx.lxyy.club/index.php?url=",
    resolveResponse: resolveLxResponse,
    singleUse: true,
  },
  {
    id: "jiexi789-page", name: "789解析", endpoint: "https://jiexi.789jiexi.com/?url=",
    resolveResponse: resolveJiexi789PageResponse,
  },
  {
    id: "bingdou", name: "冰豆解析", endpoint: "https://bd.jx.cn/?url=",
    resolveResponse: resolveBingdouResponse,
    singleUse: true,
    fallback: true,
  },
  {
    id: "qilin", name: "麒麟解析", endpoint: "https://free.maccms.xyz/?url=",
    resolveResponse: resolvePlayerConfigResponse,
    singleUse: true,
  },
]);

const MAX_RESPONSE_BYTES = 256 * 1024;

function mediaUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function fromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  const encrypted = payload.encrypt;
  let value = payload.playUrl || payload.url || payload.src;
  if (typeof value === "string" && encrypted === 1) {
    try {
      value = Buffer.from(value, "base64").toString("utf8");
    } catch {
      return "";
    }
  } else if (typeof value === "string" && encrypted === 2) {
    try {
      value = decodeURIComponent(value);
    } catch {
      return "";
    }
  }
  return mediaUrl(value) || fromPayload(payload.data);
}

function embeddedObject(text) {
  const start = /(?:var|let|const)\s+(?:player_[\w]+|config)\s*=\s*\{/g.exec(text);
  if (!start) return null;
  const begin = text.indexOf("{", start.index);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = begin; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
    } else if (char === '"') quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(begin, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function extractHttpPlayUrl(text) {
  if (typeof text !== "string" || text.length > MAX_RESPONSE_BYTES) return "";
  try {
    const value = fromPayload(JSON.parse(text));
    if (value) return value;
  } catch {
    // 解析页也可能在脚本中包含 JSON 对象。
  }
  const embedded = fromPayload(embeddedObject(text));
  if (embedded) return embedded;
  const tag = /<(?:video|source)\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/i.exec(text);
  return mediaUrl(tag?.[1]);
}

async function readPage(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept: options.accept || "text/html,application/json",
        ...options.headers,
      },
      body: options.body,
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      return { redirectUrl: mediaUrl(location && new URL(location, url).toString()) };
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
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
        if (size > MAX_RESPONSE_BYTES) throw new Error("response too large");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
    return { text };
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveHttpChannel(channel, sourceUrl, options = {}) {
  if (!HTTP_CHANNELS.includes(channel)) {
    throw new AppError("CONFIG_ERROR", 500, "未注册的解析渠道");
  }
  const deadline = performance.now() + (options.timeoutMs ?? 8000);
  const request = async (url, requestOptions) => {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      throw new AppError("UPSTREAM_TIMEOUT", 504, "解析渠道请求超时");
    }
    try {
      return await (options.request || readPage)(url, remainingMs, requestOptions);
    } catch (err) {
      // 原始异常可能包含带令牌的请求 URL，不向日志或调用方传播。
      if (err?.name === "AbortError" || err?.name === "TimeoutError") {
        throw new AppError("UPSTREAM_TIMEOUT", 504, "解析渠道请求超时");
      }
      throw new AppError("UPSTREAM_ERROR", 502, "解析渠道暂不可用");
    }
  };
  const pageUrl = `${channel.endpoint}${encodeURIComponent(sourceUrl)}`;
  const response = await request(pageUrl);
  const result = channel.resolveResponse
    ? await channel.resolveResponse(response, {
        request,
        pageUrl,
        sourceUrl,
        resolveUpstream: options.resolveUpstream ||
          ((url, { timeoutMs } = {}) => resolveJiexiUpstream(url, { timeoutMs })),
        resolveBrowserPage: options.resolveBrowserPage,
        remainingMs: () => Math.max(0, deadline - performance.now()),
      })
    : { playUrl: mediaUrl(response?.redirectUrl) || extractHttpPlayUrl(response?.text), type: "" };
  const playUrl = mediaUrl(result.playUrl);
  if (!playUrl) throw new AppError("PARSE_FAILED", 502, "解析渠道未返回媒体地址");
  // 单次签名链接的本地有效期估计。
// 实测：主线路 fragLoadTimeOut 可能要 40-50 秒才触发，而原来的 45 秒兼口刚卡在
// 主线路死亡之前，导致备用线路在换线时已全部过期（expired=N，remaining=0）。
// 这里把兼口拉到与解析缓存同量级，并保留“上游声明的 x-expires”优先。
const SINGLE_USE_MIN_TTL_MS = 240_000;
const SINGLE_USE_FALLBACK_TTL_MS = 300_000;

function singleUseExpiry(playUrl) {
  const expires = Number(new URL(playUrl).searchParams.get("x-expires"));
  if (Number.isFinite(expires) && expires > 0) {
    const expiresMs = expires > 1e12 ? expires : expires * 1000;
    // 上游给出的期限优先，但至少保留 SINGLE_USE_MIN_TTL_MS，避免刚解析就过期。
    return Math.max(Date.now() + SINGLE_USE_MIN_TTL_MS, expiresMs - 30_000);
  }
  // 没有 x-expires 时无法得知上游真实寿命，用一个足够覆盖“主线路崩溃+换线”的兼口。
  return Date.now() + SINGLE_USE_FALLBACK_TTL_MS;
}
  const singleUse = channel.singleUse === true;
  let expiresAtMs;
  if (singleUse) expiresAtMs = singleUseExpiry(playUrl);
  return {
    sourceUrl,
    playUrl,
    provider: channel.id,
    type: result.type,
    singleUse,
    ...(singleUse ? { expiresAtMs } : {}),
  };
}

export function enabledHttpChannels(ids) {
  if (ids == null) return [...HTTP_CHANNELS];
  const selected = new Set(ids);
  for (const id of selected) {
    if (!HTTP_CHANNELS.some((channel) => channel.id === id)) {
      throw new Error(`Unknown HTTP channel: ${id}`);
    }
  }
  return HTTP_CHANNELS.filter((channel) => selected.has(channel.id));
}
