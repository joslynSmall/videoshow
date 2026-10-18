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

export async function openMedia(rawUrl, requestHeaders = {}, fetchFn = fetch) {
  const target = assertMediaUrl(rawUrl);
  const headers = {
    "user-agent": USER_AGENT,
    accept: "*/*",
  };
  if (typeof requestHeaders.range === "string" && requestHeaders.range) {
    headers.range = requestHeaders.range;
  }
  let response;
  try {
    response = await fetchFn(target, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new AppError("UPSTREAM_ERROR", 502, "媒体分片请求失败", { cause: err });
  }
  return response;
}
