import { randomBytes } from "node:crypto";
import { AppError } from "../errors.js";
import { assertMediaUrl } from "../media.js";
import { normalizeType } from "../stream.js";
import { resolvePlayerConfigResponse } from "./player-config.js";

const DATA_CODE = /\bdata-code\s*=\s*"([^"]*)"/i;
const DIRECT_MEDIA = /\.(m3u8|mp4)(\?|$)/i;

function json(text, message) {
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("UPSTREAM_ERROR", 502, message);
  }
}

export async function resolveLxResponse(response, { request, pageUrl, sourceUrl }) {
  if (response?.redirectUrl || typeof response?.text !== "string") {
    throw new AppError("PARSE_FAILED", 502, "LX 解析页面无效");
  }
  if (typeof sourceUrl !== "string" || !sourceUrl) {
    throw new AppError("PARSE_FAILED", 502, "LX 解析缺少视频地址");
  }

  const code = DATA_CODE.exec(response.text)?.[1] || "";
  const publicUrl = new URL("public.php", pageUrl).toString();
  const publicResponse = await request(publicUrl, {
    method: "POST",
    accept: "application/json",
    headers: { "content-type": "application/json", referer: pageUrl },
    body: JSON.stringify({
      url: sourceUrl,
      code,
      browser: randomBytes(16).toString("hex"),
      interface: "",
      excluded: [],
      caller: pageUrl,
    }),
  });
  const payload = json(publicResponse?.text, "LX 解析接口响应无效");
  if (publicResponse?.redirectUrl || !payload?.success ||
      typeof payload?.url !== "string" || !payload.url) {
    throw new AppError("PARSE_FAILED", 502, "LX 解析未返回播放页");
  }

  const playerUrl = new URL(payload.url, pageUrl).toString();
  if (DIRECT_MEDIA.test(playerUrl)) {
    return {
      playUrl: assertMediaUrl(playerUrl).toString(),
      type: normalizeType(payload.type, playerUrl),
    };
  }

  const playerResponse = await request(playerUrl, {
    accept: "text/html,application/xhtml+xml",
    headers: { referer: pageUrl },
  });
  return resolvePlayerConfigResponse(playerResponse, { request, pageUrl: playerUrl });
}
