import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "../errors.js";
import { log } from "../log.js";

const CHROME_PATH = process.env.CHROME_BIN || "/usr/bin/google-chrome";

export function inferPlaybackType(playUrl) {
  return /\.mp4(\?|$)/i.test(playUrl) ? "mp4" : "m3u8";
}

export async function resolveWithBrowser(sourceUrl, timeoutMs = 15000) {
  if (!fs.existsSync(CHROME_PATH)) {
    throw new AppError("BROWSER_UNAVAILABLE", 503, "无头 Chrome 未安装");
  }

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
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { chrome.kill("SIGKILL"); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
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
