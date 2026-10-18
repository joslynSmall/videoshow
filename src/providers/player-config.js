import { AppError } from "../errors.js";
import { assertMediaUrl } from "../media.js";
import { normalizeType } from "../stream.js";

const PLAYER_CONFIG =
  /\bconst\s+playerConfig\s*=\s*\{([\s\S]*?)<\/script\s*>/i;
const API_TOKEN = /\bapiToken\s*:\s*("(?:[^"\\]|\\.)*")/;

export function extractPlayerToken(text) {
  const config = typeof text === "string" && PLAYER_CONFIG.exec(text);
  const literal = config && API_TOKEN.exec(config[1]);
  if (!literal) return "";
  try {
    const token = JSON.parse(literal[1]);
    return typeof token === "string" ? token.trim() : "";
  } catch {
    return "";
  }
}

// 只读取公开页面中的字符串字面量，不执行第三方脚本；令牌只用于同站接口。
export async function resolvePlayerConfigResponse(response, { request, pageUrl }) {
  if (response?.redirectUrl) {
    throw new AppError("PARSE_FAILED", 502, "解析页面配置无效");
  }
  const token = extractPlayerToken(response?.text);
  if (!token) {
    throw new AppError("PARSE_FAILED", 502, "解析页面配置无效");
  }

  const url = new URL("api/resolve.php", pageUrl);
  url.searchParams.set("token", token);
  const resolved = await request(url.toString(), {
    accept: "application/json",
    headers: { referer: pageUrl },
  });
  let payload;
  try {
    payload = JSON.parse(resolved?.text);
  } catch {
    throw new AppError("UPSTREAM_ERROR", 502, "解析接口响应无效");
  }
  if (resolved?.redirectUrl || payload?.code !== 200) {
    throw new AppError("PARSE_FAILED", 502, "解析未返回可用媒体");
  }
  let playUrl;
  try {
    playUrl = assertMediaUrl(payload.url).toString();
  } catch {
    throw new AppError("PARSE_FAILED", 502, "解析媒体地址无效");
  }
  return { playUrl, type: normalizeType(payload.type, playUrl) };
}
