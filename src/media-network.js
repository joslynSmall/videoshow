import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { pipeline, Readable } from "node:stream";
import { createUnzip, createBrotliDecompress } from "node:zlib";
import { AppError } from "./errors.js";
import { USER_AGENT } from "./http.js";

// 固定的公共 DoH 端点（不接受外部输入）。并行查询、谁先返回有效答案用谁：
// 单一端点在部分网络（例如 dns.google）经常不可达，会让 Fake-IP 环境下的公共 DNS 回退整体失效。
export const DNS_ENDPOINTS = Object.freeze([
  "https://dns.alidns.com/resolve",
  "https://doh.pub/dns-query",
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/resolve",
]);
const MAX_DNS_BYTES = 16 * 1024;
const DNS_QUERY_TIMEOUT_MS = 3000;
const HEALTH_TTL_MS = 60_000;

async function readDnsBody(response) {
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
  return text;
}

export function createPublicDnsResolver({
  fetchFn = (...args) => fetch(...args),
  now = Date.now,
  endpoints = DNS_ENDPOINTS,
  queryTimeoutMs = DNS_QUERY_TIMEOUT_MS,
} = {}) {
  const cache = new Map();
  const health = new Map();

  // 向单个端点查询，结果归为 ok / nxdomain / nodata；网络或格式错误直接抛出。
  async function ask(endpoint, hostname, signal) {
    const url = new URL(endpoint);
    url.searchParams.set("name", hostname);
    url.searchParams.set("type", "A");
    const timeout = AbortSignal.timeout(queryTimeoutMs);
    const response = await fetchFn(url, {
      headers: { accept: "application/dns-json" },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new AppError("UPSTREAM_ERROR", 502, "公网 DNS 查询失败");
    }
    let payload;
    try {
      payload = JSON.parse(await readDnsBody(response));
    } catch {
      throw new AppError("UPSTREAM_ERROR", 502, "公网 DNS 响应无效");
    }
    if (payload?.Status === 3) return { state: "nxdomain" };
    const answers = Array.isArray(payload?.Answer)
      ? payload.Answer.filter((entry) => entry.type === 1)
      : [];
    if (payload?.Status !== 0 || !answers.length || answers.some((entry) => isIP(entry.data) !== 4)) {
      return { state: "nodata" };
    }
    const addresses = answers.map((entry) => ({ address: entry.data, family: 4 }));
    const ttlMs = Math.min(30, ...answers.map((entry) => Math.max(0, Number(entry.TTL) || 0))) * 1000;
    return { state: "ok", addresses, ttlMs };
  }

  const resolver = async (hostname, { signal } = {}) => {
    const cached = cache.get(hostname);
    if (cached?.expiresAt > now()) return cached.addresses;
    cache.delete(hostname);
    const attempts = endpoints.map((endpoint) =>
      ask(endpoint, hostname, signal).then((outcome) => {
        if (outcome.state !== "ok") throw Object.assign(new Error(outcome.state), { dnsState: outcome.state });
        return outcome;
      }));
    let outcome;
    try {
      outcome = await Promise.any(attempts);
    } catch (aggregate) {
      const answered = aggregate.errors?.some((err) => err?.dnsState);
      throw answered
        ? new AppError("UPSTREAM_ERROR", 502, "媒体域名没有有效的公网 IPv4 解析")
        : new AppError("UPSTREAM_ERROR", 502, "公网 DNS 查询失败");
    }
    if (outcome.ttlMs > 0) {
      if (cache.size >= 128) cache.delete(cache.keys().next().value);
      cache.set(hostname, { addresses: outcome.addresses, expiresAt: now() + outcome.ttlMs });
    }
    return outcome.addresses;
  };

  // 域名是否还存在：alive 有解析；dead 有端点明确返回 NXDOMAIN 且没有任何端点能解析；unknown 无法判断。
  // 只发 DNS 查询，不会请求媒体地址，所以不会消耗单次签名链接。
  // 同一个域名的并发探测共享一次查询：多个渠道指向同一个 CDN 域名时，必须得到一致的结论。
  const probing = new Map();
  resolver.probe = (hostname, options = {}) => {
    if (isIP(hostname)) return Promise.resolve("alive");
    const known = health.get(hostname);
    if (known?.expiresAt > now()) return Promise.resolve(known.state);
    const running = probing.get(hostname);
    if (running) return running;
    const task = probeOnce(hostname, options).finally(() => probing.delete(hostname));
    probing.set(hostname, task);
    return task;
  };

  async function probeOnce(hostname, { signal } = {}) {
    const state = await new Promise((resolve) => {
      let pending = endpoints.length;
      let nxdomains = 0;
      if (!pending) resolve("unknown");
      for (const endpoint of endpoints) {
        ask(endpoint, hostname, signal).then(
          (outcome) => ({ state: outcome.state }),
          () => ({ state: "error" }),
        ).then((outcome) => {
          pending -= 1;
          if (outcome.state === "ok") resolve("alive");
          else if (outcome.state === "nxdomain") nxdomains += 1;
          // 两个独立解析器都说域名不存在就足够下结论，不必等慢的端点。
          if (nxdomains >= 2) resolve("dead");
          if (pending === 0) resolve(nxdomains ? "dead" : "unknown");
        });
      }
    });
    if (state !== "unknown") {
      if (health.size >= 128) health.delete(health.keys().next().value);
      health.set(hostname, { state, expiresAt: now() + HEALTH_TTL_MS });
    }
    return state;
  }
  return resolver;
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
