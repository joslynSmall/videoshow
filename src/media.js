import { AppError } from "./errors.js";
import { USER_AGENT } from "./http.js";

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
  return parsed;
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
  const expected = Number(response.headers.get("content-length"));
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
      const response = await fetchFn(target, {
        headers,
        redirect: "follow",
        signal: controller.signal,
      });
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
