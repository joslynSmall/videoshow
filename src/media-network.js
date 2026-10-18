import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { pipeline, Readable } from "node:stream";
import { createUnzip, createBrotliDecompress } from "node:zlib";
import { AppError } from "./errors.js";
import { USER_AGENT } from "./http.js";

const DNS_ENDPOINT = "https://dns.google/resolve";
const MAX_DNS_BYTES = 16 * 1024;

export function createPublicDnsResolver({ fetchFn = (...args) => fetch(...args), now = Date.now } = {}) {
  const cache = new Map();
  return async (hostname, { signal } = {}) => {
    const cached = cache.get(hostname);
    if (cached?.expiresAt > now()) return cached.addresses;
    cache.delete(hostname);
    const url = new URL(DNS_ENDPOINT);
    url.searchParams.set("name", hostname);
    url.searchParams.set("type", "A");
    const timeout = AbortSignal.timeout(5000);
    const response = await fetchFn(url, {
      headers: { accept: "application/dns-json" },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new AppError("UPSTREAM_ERROR", 502, "公网 DNS 查询失败");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_DNS_BYTES) throw new Error("DNS response too large");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new AppError("UPSTREAM_ERROR", 502, "公网 DNS 响应无效");
    }
    const answers = Array.isArray(payload?.Answer)
      ? payload.Answer.filter((entry) => entry.type === 1)
      : [];
    if (payload?.Status !== 0 || !answers.length || answers.some((entry) => isIP(entry.data) !== 4)) {
      throw new AppError("UPSTREAM_ERROR", 502, "媒体域名没有有效的公网 IPv4 解析");
    }
    const addresses = answers.map((entry) => ({ address: entry.data, family: 4 }));
    const ttlMs = Math.min(30, ...answers.map((entry) => Math.max(0, Number(entry.TTL) || 0))) * 1000;
    if (ttlMs > 0) {
      if (cache.size >= 128) cache.delete(cache.keys().next().value);
      cache.set(hostname, { addresses, expiresAt: now() + ttlMs });
    }
    return addresses;
  };
}

export const lookupPublicMediaDns = createPublicDnsResolver();

// 调用方须先检查全部解析地址；此处将连接固定到其中一个地址，保留原始 Host 和 TLS 主机名。
export function requestPinnedMedia(url, options, addresses) {
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const headers = new Headers(options.headers);
    if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
    headers.set("host", url.host);
    headers.set("accept-encoding", "identity");
    const req = transport.request(url, {
      method: options.method || "GET",
      headers: Object.fromEntries(headers),
      agent: false,
      family: address.family,
      autoSelectFamily: false,
      signal: options.signal || AbortSignal.timeout(10000),
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    }, (res) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== undefined) responseHeaders.append(name, item);
        }
      }
      const status = res.statusCode;
      if (options.method === "HEAD" || [204, 205, 304].includes(status)) {
        res.resume();
        resolve(new Response(null, { status, headers: responseHeaders }));
        return;
      }
      let body = res;
      const encoding = responseHeaders.get("content-encoding")?.toLowerCase();
      if (encoding === "gzip" || encoding === "deflate" || encoding === "br") {
        body = encoding === "br" ? createBrotliDecompress() : createUnzip();
        // pipeline 将取消和读取错误传回源连接，避免清单探测结束后继续下载。
        pipeline(res, body, () => {});
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");
      }
      responseHeaders.delete("transfer-encoding");
      resolve(new Response(Readable.toWeb(body), { status, headers: responseHeaders }));
    });
    req.on("error", reject);
    req.end();
  });
}
