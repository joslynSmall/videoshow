import { createDecipheriv } from "node:crypto";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { fetchJson, fetchText } from "./http.js";
import { log } from "./log.js";

export function normalizeVideoUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new AppError("INVALID_URL", 400, "缺少 url 参数");
  }

  let value = raw.trim();
  if (value.length > 2048) {
    throw new AppError("INVALID_URL", 400, "链接过长");
  }
  if (value.startsWith("//")) {
    value = `https:${value}`;
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `https://${value}`;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError("INVALID_URL", 400, "链接格式不正确");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppError("INVALID_URL", 400, "只支持 http/https 链接");
  }

  parsed.hash = "";
  return parsed.toString();
}

export function extractConfig(html) {
  if (typeof html !== "string" || !html) {
    throw new AppError("UPSTREAM_ERROR", 502, "解析页内容无效");
  }

  const start = html.indexOf("var config");
  const end = start >= 0 ? html.indexOf("};", start) : -1;
  const block = start >= 0 && end > start ? html.slice(start, end + 2) : html;

  const pick = (name) => {
    const doubleQuoted = new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`).exec(block);
    if (doubleQuoted) return doubleQuoted[1];
    const singleQuoted = new RegExp(`'${name}'\\s*:\\s*'([^']+)'`).exec(block);
    return singleQuoted?.[1];
  };

  const time = pick("time");
  const key = pick("key");
  if (!time || !key) {
    throw new AppError("UPSTREAM_ERROR", 502, "解析页缺少取流参数");
  }
  return { time, key };
}

export function decryptPlayUrl(ciphertext, key = config.aesKey, iv = config.aesIv) {
  if (typeof ciphertext !== "string" || !ciphertext.trim()) {
    throw new AppError("PARSE_FAILED", 502, "上游未返回播放地址");
  }

  const keyBytes = Buffer.from(key, "utf8");
  const ivBytes = Buffer.from(iv, "utf8");
  if (keyBytes.length !== 16 || ivBytes.length !== 16) {
    throw new AppError("CONFIG_ERROR", 500, "AES 密钥必须是 16 字节");
  }

  try {
    const decipher = createDecipheriv("aes-128-cbc", keyBytes, ivBytes);
    const plain = Buffer.concat([
      decipher.update(Buffer.from(ciphertext.trim(), "base64")),
      decipher.final(),
    ])
      .toString("utf8")
      .trim();

    const parsed = new URL(plain);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unexpected protocol");
    }
    return plain;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("PARSE_FAILED", 502, "播放地址解密失败", { cause: err });
  }
}

function upstreamFailure(err) {
  if (err instanceof AppError && err.code === "UPSTREAM_TIMEOUT") {
    return new AppError("UPSTREAM_TIMEOUT", 504, "解析服务响应超时，请稍后重试", {
      cause: err,
    });
  }
  return new AppError("UPSTREAM_ERROR", 502, "解析服务暂不可用，请稍后重试", {
    cause: err,
  });
}

export async function resolveStream(rawUrl) {
  const sourceUrl = normalizeVideoUrl(rawUrl);

  const playerUrl = `${config.upstreamBase}/jiexi.php?url=${encodeURIComponent(sourceUrl)}`;
  let playerHtml;
  try {
    playerHtml = await fetchText(playerUrl, {
      accept: "text/html,application/xhtml+xml",
    });
  } catch (err) {
    throw upstreamFailure(err);
  }

  const { time, key } = extractConfig(playerHtml);

  let payload;
  try {
    payload = await fetchJson(`${config.upstreamBase}/api.php`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: sourceUrl, time, key }),
      accept: "application/json",
    });
  } catch (err) {
    throw upstreamFailure(err);
  }

  if (
    Number(payload?.code) !== 200 ||
    typeof payload?.url !== "string" ||
    !payload.url
  ) {
    // 上游响应的 title 是广告文案，只记录状态码，绝不下传。
    log.warn("provider.parse_failed", { code: payload?.code });
    throw new AppError("PARSE_FAILED", 502, "上游解析失败，请稍后重试");
  }

  const playUrl = decryptPlayUrl(payload.url);
  const expirySeconds = Number(payload.expire_time);
  const expiresInSeconds = Number(payload.expires_in);
  const expiresAtMs =
    Number.isFinite(expirySeconds) && expirySeconds > 0
      ? expirySeconds * 1000
      : Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
        ? Date.now() + expiresInSeconds * 1000
        : null;

  return {
    sourceUrl,
    playUrl,
    type: typeof payload.type === "string" && payload.type ? payload.type : "m3u8",
    expiresAtMs,
    provider: "jiexi789",
  };
}
