import { config } from "./config.js";
import { AppError } from "./errors.js";
import { fetchText } from "./http.js";

export function normalizeColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value)
    ? value.toUpperCase()
    : "#FFFFFF";
}

export function normalizeDmkuResponse(payload) {
  const raw = Array.isArray(payload?.danmuku) ? payload.danmuku : [];

  const items = raw
    .filter(
      (item) =>
        Array.isArray(item) &&
        typeof item[0] === "number" &&
        Number.isFinite(item[0]) &&
        typeof item[4] === "string" &&
        item[4].trim() !== "",
    )
    .map((item) => ({
      time: item[0],
      mode: item[1] === "top" ? 1 : item[1] === "bottom" ? 2 : 0,
      color: normalizeColor(item[2]),
      text: item[4].trim(),
    }))
    .sort((a, b) => a.time - b.time);

  return { provider: "dmku", count: items.length, items };
}

export async function fetchDmkuDanmaku(sourceUrl) {
  const endpoint = new URL(config.danmakuBaseUrl);
  endpoint.searchParams.set("url", sourceUrl);

  let text;
  try {
    text = await fetchText(endpoint.toString(), {
      accept: "application/json",
      timeoutMs: config.danmakuTimeoutMs,
    });
  } catch (err) {
    throw new AppError("DANMAKU_UPSTREAM_ERROR", 502, "弹幕服务暂不可用，请稍后重试", {
      cause: err,
    });
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    throw new AppError("DANMAKU_UPSTREAM_ERROR", 502, "弹幕服务返回异常", {
      cause: err,
    });
  }

  return normalizeDmkuResponse(payload);
}
