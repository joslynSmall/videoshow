import { config } from "./config.js";
import { AppError } from "./errors.js";

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export async function fetchText(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    accept,
    timeoutMs = config.requestTimeoutMs,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      body,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        ...(accept ? { accept } : {}),
        ...headers,
      },
    });

    if (!response.ok) {
      throw new AppError("UPSTREAM_ERROR", 502, `远端返回 HTTP ${response.status}`);
    }

    return await response.text();
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      throw new AppError("UPSTREAM_TIMEOUT", 504, "远端请求超时", { cause: err });
    }
    throw new AppError("UPSTREAM_ERROR", 502, "远端请求失败", { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, options) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new AppError("UPSTREAM_ERROR", 502, "远端返回了非 JSON 响应", {
      cause: err,
    });
  }
}

export async function probeUrl(url, options = {}) {
  const {
    method = "HEAD",
    headers = {},
    timeoutMs = config.requestTimeoutMs,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        ...headers,
      },
    });

    const result = {
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      finalUrl: response.url,
    };

    if (method !== "HEAD" && response.body) {
      await response.body.cancel().catch(() => {});
    }

    return result;
  } catch (err) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      throw new AppError("UPSTREAM_TIMEOUT", 504, "远端请求超时", { cause: err });
    }
    throw new AppError("UPSTREAM_ERROR", 502, "远端请求失败", { cause: err });
  } finally {
    clearTimeout(timer);
  }
}
