import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "../errors.js";
import { log } from "../log.js";

const CHROME_PATH = process.env.CHROME_BIN || "/usr/bin/google-chrome";

export function inferPlaybackType(playUrl) {
  return /\.mp4(\?|$)/i.test(playUrl) ? "mp4" : "m3u8";
}

// 重试窗口：jx-browser 依赖上游解析站 jx.1ljx.com 的边缘节点，
// 偶发 ECONNRESET（TLS 握手前连接被重置）。这类瞬时抖动重试一次成功率很高。
// 只重试“页面加载/提取失败”（PARSE_FAILED）；
// BROWSER_UNAVAILABLE（Chrome 未安装）与 BROWSER_ERROR（DevTools 端口起不来）是本地环境问题，重试无意义。
const BROWSER_RETRY_ATTEMPTS = 2;
const BROWSER_RETRY_DELAY_MS = 800;

// 导出以便测试：哪些错误值得重试。
export function isRetryableBrowserError(err) {
  return err?.code === "PARSE_FAILED";
}

export async function resolveWithBrowser(sourceUrl, timeoutMs = 15000) {
  if (!fs.existsSync(CHROME_PATH)) {
    throw new AppError("BROWSER_UNAVAILABLE", 503, "无头 Chrome 未安装");
  }
  let lastError = null;
  for (let attempt = 1; attempt <= BROWSER_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await resolveOnce(sourceUrl, timeoutMs);
    } catch (err) {
      lastError = err;
      if (!isRetryableBrowserError(err) || attempt === BROWSER_RETRY_ATTEMPTS) throw err;
      log.warn("browser.resolve.retry", {
        provider: "jx-browser",
        attempt,
        code: err?.code,
        message: err?.message,
      });
      await new Promise((r) => setTimeout(r, BROWSER_RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

async function resolveOnce(sourceUrl, timeoutMs) {
  const dataDir = path.join("/tmp", "vs-chrome-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(dataDir, { recursive: true });

  const chrome = spawn(CHROME_PATH, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "--mute-audio",
    "--user-data-dir=" + dataDir,
    "--remote-debugging-port=0",
  ], { stdio: "ignore" });

  let cleaned = false;
  // Chrome 收到 SIGTERM 后需要一点时间关闭 profile，目录删太快会因 SingletonLock
  // 等文件仍被占用而失败，残留 /tmp/vs-chrome-* 目录。
  // 用异步退避重试，避免 Atomics.wait 阻塞事件循环影响其它并发请求。
  const removeDirSoon = async () => {
    for (let i = 0; i < 15; i += 1) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
        return true;
      } catch {
        if (i === 4) { try { chrome.kill("SIGKILL"); } catch {} }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    try { chrome.kill("SIGKILL"); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    return false;
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { chrome.kill("SIGTERM"); } catch {}
    // 不等待目录删除：解析结果已经拿到，残留目录由 removeDirSoon 异步清理。
    void removeDirSoon();
  };

  const activePortFile = path.join(dataDir, "DevToolsActivePort");
  let port = null;
  let pathPart = null;

  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(activePortFile)) {
      try {
        const text = fs.readFileSync(activePortFile, "utf8").trim();
        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
        if (lines.length >= 2) {
          port = lines[0];
          pathPart = lines[1];
          break;
        }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!port || !pathPart) {
    cleanup();
    throw new AppError("BROWSER_ERROR", 502, "无法启动无头浏览器 DevTools 端口");
  }

  let browserWs = null;
  let pageWs = null;

  try {
    browserWs = new WebSocket("ws://127.0.0.1:" + port + pathPart);
    let id = 1;
    const send = (ws, method, params = {}) => {
      const curId = id++;
      return new Promise((resolve, reject) => {
        const handler = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.id === curId) {
            ws.removeEventListener("message", handler);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          }
        };
        ws.addEventListener("message", handler);
        ws.send(JSON.stringify({ id: curId, method, params }));
      });
    };

    await new Promise((resolve, reject) => {
      browserWs.onopen = resolve;
      browserWs.onerror = reject;
    });

    const { targetId } = await send(browserWs, "Target.createTarget", { url: "about:blank" });
    pageWs = new WebSocket("ws://127.0.0.1:" + port + "/devtools/page/" + targetId);

    await new Promise((resolve, reject) => {
      pageWs.onopen = resolve;
      pageWs.onerror = reject;
    });

    await send(pageWs, "Page.enable");
    await send(pageWs, "Network.enable");

    await send(pageWs, "Network.setBlockedURLs", {
      urls: [
        "*pagead2*",
        "*hm.baidu.com*",
        "*adbyunion*",
        "*f3531.top*",
        "*trafficmanager.net*",
      ],
    });

    let playUrl = null;

    const acceptMediaUrl = (raw) => {
      if (typeof raw !== "string" || !/^https?:\/\//i.test(raw)) return "";
      if (/54188\.sb|_player\/play/i.test(raw)) return "";
      if (!/\.(m3u8|mp4)(\?|$)/i.test(raw)) return "";
      return raw;
    };

    pageWs.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === "Network.requestWillBeSent") {
        const found = acceptMediaUrl(msg.params?.request?.url || "");
        if (!found) return;
        if (/sviptq\.com.+\.m3u8/i.test(found) || !playUrl) playUrl = found;
      }
    });

    const jxPlayerUrl = "https://jx.1ljx.com/_player/?tk=&url=" + encodeURIComponent(sourceUrl);
    await send(pageWs, "Page.navigate", { url: jxPlayerUrl });

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (playUrl && /sviptq\.com/i.test(playUrl)) {
        break;
      }
      try {
        const evalRes = await send(pageWs, "Runtime.evaluate", {
          expression: "window.FFSir?.dp?.options?.video?.url || ''",
          returnByValue: true,
        });
        const val = acceptMediaUrl(evalRes?.result?.value);
        if (val && !playUrl) playUrl = val;
      } catch {}

      if (playUrl && Date.now() - start > 5000) {
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    if (!playUrl) {
      throw new AppError("PARSE_FAILED", 502, "无头浏览器未能提取到可用播放地址");
    }

    return {
      sourceUrl,
      playUrl,
      type: inferPlaybackType(playUrl),
      expiresAtMs: Date.now() + 3600 * 1000,
      provider: "jx-browser",
    };
  } finally {
    try { pageWs?.close(); } catch {}
    try { browserWs?.close(); } catch {}
    cleanup();
  }
}
