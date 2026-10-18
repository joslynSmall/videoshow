import { AppError } from "./errors.js";
import { USER_AGENT } from "./http.js";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { config } from "./config.js";
import { lookupPublicMediaDns, requestPinnedMedia } from "./media-network.js";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128], ["::1", 128],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) blocked.addSubnet(address, prefix, "ipv6");

function isBlocked(address) {
  const family = isIP(address);
  return !family || address.toLowerCase().startsWith("::ffff:") ||
    blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

export function assertMediaUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new AppError("BAD_REQUEST", 400, "缺少媒体地址");
  }
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new AppError("BAD_REQUEST", 400, "媒体地址格式不正确");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppError("BAD_REQUEST", 400, "只支持 http/https 媒体地址");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (parsed.username || parsed.password || !host ||
      host === "localhost" || host.endsWith(".localhost") ||
      (isIP(host) && isBlocked(host))) {
    throw new AppError("BAD_REQUEST", 400, "媒体地址不可访问");
  }
  return parsed;
}

export async function resolveMediaAddresses(
  host,
  {
    signal,
    systemResolver = (name) => lookup(name, { all: true }),
    publicResolver = lookupPublicMediaDns,
  } = {},
) {
  if (config.mediaDnsMode === "public") {
    return publicResolver(host, { signal });
  }
  const addresses = await systemResolver(host);
  const fakeOrPrivate = Array.isArray(addresses) &&
    addresses.some((entry) => isBlocked(entry.address));
  if (config.mediaDnsMode !== "auto" || !fakeOrPrivate) return addresses;
  try {
    return await publicResolver(host, { signal });
  } catch {
    return addresses;
  }
}

export async function assertPublicMediaUrl(raw, resolver = resolveMediaAddresses) {
  const target = assertMediaUrl(raw);
  const host = target.hostname.replace(/^\[|\]$/g, "");
  if (!isIP(host)) {
    let addresses;
    try {
      addresses = await resolver(host, { all: true });
    } catch (err) {
      throw new AppError("BAD_REQUEST", 400, "媒体地址无法解析", { cause: err });
    }
    if (!Array.isArray(addresses) || !addresses.length ||
        addresses.some((entry) => isBlocked(entry.address))) {
      throw new AppError("BAD_REQUEST", 400, "媒体地址不可访问", {
        detail: {
          host,
          addresses: Array.isArray(addresses)
            ? addresses.map((entry) => entry.address).slice(0, 6)
            : [],
        },
      });
    }
  }
  return target;
}

export async function fetchPublicMedia(rawUrl, options = {}, fetchFn = fetch, guard = assertPublicMediaUrl) {
  let next = assertMediaUrl(rawUrl);
  for (let hop = 0; hop < 4; hop += 1) {
    let response;
    const host = next.hostname.replace(/^\[|\]$/g, "");
    if (config.mediaDnsMode !== "system" && fetchFn === fetch && !isIP(host)) {
      const addresses = await resolveMediaAddresses(host, { signal: options.signal });
      await guard(next.toString(), async () => addresses);
      response = await requestPinnedMedia(next, options, addresses);
    } else {
      await guard(next.toString());
      response = await fetchFn(next, { ...options, redirect: "manual" });
    }
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    await response.body?.cancel?.().catch(() => {});
    if (!location || hop === 3) {
      throw new AppError("UPSTREAM_ERROR", 502, "媒体地址跳转过多");
    }
    next = assertMediaUrl(new URL(location, next).toString());
  }
}

const DEFAULT_ATTEMPTS = 2;
const DEFAULT_TTFB_MS = 3000;
const DEFAULT_IDLE_MS = 1500;
const DEFAULT_TOTAL_MS = 8000;
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;

function readOrIdle(reader, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("media idle")), timeoutMs);
    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result.done ? null : result.value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function readBody(response, idleMs, totalMs) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  const started = Date.now();
  try {
    while (true) {
      const budget = totalMs - (Date.now() - started);
      if (budget <= 0) throw new Error("media body timeout");
      const value = await readOrIdle(reader, Math.min(idleMs, budget));
      if (!value) break;
      received += value.byteLength;
      if (received > MAX_MEDIA_BYTES) throw new Error("media too large");
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  const lengthHeader = response.headers.get("content-length");
  const expected = lengthHeader === null ? NaN : Number(lengthHeader);
  if (Number.isFinite(expected) && expected !== received) {
    throw new Error("media short body");
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function responseWithBody(response, body) {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.set("content-length", String(body.byteLength));
  return new Response(body, { status: response.status, headers });
}

export async function openMedia(rawUrl, requestHeaders = {}, fetchFn = fetch, options = {}) {
  const target = assertMediaUrl(rawUrl);
  const guard = options.guard || (fetchFn === fetch ? assertPublicMediaUrl : async () => {});
  const headers = {
    "user-agent": USER_AGENT,
    accept: "*/*",
  };
  if (typeof requestHeaders.range === "string" && requestHeaders.range) {
    headers.range = requestHeaders.range;
  }
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const ttfbMs = options.ttfbMs ?? DEFAULT_TTFB_MS;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const totalMs = options.totalMs ?? DEFAULT_TOTAL_MS;
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ttfbMs);
    try {
      const response = await fetchPublicMedia(target.toString(), {
        headers,
        signal: controller.signal,
      }, fetchFn, guard);
      clearTimeout(timer);
      if (response.status >= 400 && response.status < 500) return response;
      if (response.status >= 500) {
        lastError = new Error(`upstream status ${response.status}`);
        await response.body?.cancel?.().catch(() => {});
        continue;
      }
      const body = await readBody(response, idleMs, totalMs);
      return responseWithBody(response, body);
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }
  }

  throw new AppError("UPSTREAM_ERROR", 502, "媒体分片请求失败", { cause: lastError });
}
