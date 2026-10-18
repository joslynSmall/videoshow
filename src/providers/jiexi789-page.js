import { AppError } from "../errors.js";

const IFRAME = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i;
const PAGE_HOST = /(^|\.)789jiexi\.(com|net)$/i;
const API_HOST = /^api-api\.789jiexi\.net$/i;

function iframeUrl(text, baseUrl) {
  const src = typeof text === "string" ? IFRAME.exec(text)?.[1] : "";
  if (!src) return null;
  try {
    return new URL(src, baseUrl);
  } catch {
    return null;
  }
}

// 789 页面入口最终指向与内置 789 相同的上游，复用其取流逻辑，仅保留页面链路校验。
export async function resolveJiexi789PageResponse(
  response,
  { request, pageUrl, sourceUrl, resolveUpstream, remainingMs },
) {
  if (response?.redirectUrl || typeof response?.text !== "string") {
    throw new AppError("PARSE_FAILED", 502, "789 页面入口无效");
  }
  const nestedUrl = iframeUrl(response.text, pageUrl);
  if (!nestedUrl || !PAGE_HOST.test(nestedUrl.hostname)) {
    throw new AppError("PARSE_FAILED", 502, "789 页面入口地址无效");
  }

  const nested = await request(nestedUrl.toString(), {
    accept: "text/html,application/xhtml+xml",
    headers: { referer: pageUrl },
  });
  const apiUrl = iframeUrl(nested?.text, nestedUrl);
  if (!apiUrl || !API_HOST.test(apiUrl.hostname)) {
    throw new AppError("PARSE_FAILED", 502, "789 页面上游地址无效");
  }

  const result = await resolveUpstream(sourceUrl, {
    timeoutMs: typeof remainingMs === "function" ? remainingMs() : undefined,
  });
  return { ...result, provider: "jiexi789-page" };
}
