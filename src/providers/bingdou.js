import { AppError } from "../errors.js";

const IFRAME = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i;
const PLAYER_URL = "https://jiexi.bot.cd/?url=";
const PLAYER_HOST = /(^|\.)jiexi\.bot\.cd$/i;

export async function resolveBingdouResponse(
  response,
  { pageUrl, sourceUrl, resolveBrowserPage },
) {
  if (response?.redirectUrl || typeof response?.text !== "string") {
    throw new AppError("PARSE_FAILED", 502, "冰豆解析页面无效");
  }
  const src = IFRAME.exec(response.text)?.[1];
  let playerUrl;
  try {
    playerUrl = src
      ? new URL(src, pageUrl)
      : response.text.includes(PLAYER_URL)
        ? new URL(PLAYER_URL + encodeURIComponent(sourceUrl))
        : null;
  } catch {
    throw new AppError("PARSE_FAILED", 502, "冰豆播放器入口无效");
  }
  if (!playerUrl || !PLAYER_HOST.test(playerUrl.hostname)) {
    throw new AppError("PARSE_FAILED", 502, "冰豆播放器地址无效");
  }
  if (typeof resolveBrowserPage !== "function") {
    throw new AppError("BROWSER_UNAVAILABLE", 503, "冰豆渠道需要无头 Chrome");
  }

  const result = await resolveBrowserPage(sourceUrl, { timeoutMs: 30000 });
  if (!result?.playUrl) {
    throw new AppError("PARSE_FAILED", 502, "冰豆未返回媒体地址");
  }
  return { playUrl: result.playUrl, type: result.type || "mp4" };
}
