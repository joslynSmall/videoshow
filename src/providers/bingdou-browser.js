import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "../errors.js";

const CHROME_PATH = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const PLAYER_ENDPOINT = "https://jiexi.bot.cd/jx/?url=";
const FINAL_HOST = "123.129.229.14:4433";

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("websocket connection failed"));
  });
}

function rpc(ws) {
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  ws.addEventListener("close", () => {
    for (const { reject } of pending.values()) reject(new Error("websocket closed"));
    pending.clear();
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function waitForDevTools(dataDir, timeoutMs) {
  const portFile = path.join(dataDir, "DevToolsActivePort");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(portFile)) {
      const lines = fs.readFileSync(portFile, "utf8").trim().split("\n")
        .map((line) => line.trim()).filter(Boolean);
      if (lines.length >= 2) return { port: lines[0], pathPart: lines[1] };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new AppError("BROWSER_ERROR", 502, "无法启动无头浏览器");
}

async function evaluate(pageSend, expression) {
  const result = await pageSend("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result?.result?.value;
}

async function waitForValue(pageSend, expression, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await evaluate(pageSend, expression).catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

export async function resolveBingdouWithBrowser(sourceUrl, { timeoutMs = 30000 } = {}) {
  if (!fs.existsSync(CHROME_PATH)) {
    throw new AppError("BROWSER_UNAVAILABLE", 503, "无头 Chrome 未安装");
  }

  const dataDir = path.join(
    "/tmp",
    "vs-bingdou-" + Date.now() + "-" + Math.random().toString(36).slice(2),
  );
  fs.mkdirSync(dataDir, { recursive: true });
  const chrome = spawn(CHROME_PATH, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
    "--ignore-certificate-errors",
    "--user-data-dir=" + dataDir,
    "--remote-debugging-port=0",
    "about:blank",
  ], { stdio: "ignore" });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { chrome.kill("SIGKILL"); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  };

  let browserWs;
  let pageWs;
  try {
    const { port, pathPart } = await waitForDevTools(dataDir, 10000);
    browserWs = await openWebSocket(`ws://127.0.0.1:${port}${pathPart}`);
    const browserSend = rpc(browserWs);
    const { targetId } = await browserSend("Target.createTarget", { url: "about:blank" });
    pageWs = await openWebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
    const pageSend = rpc(pageWs);

    await pageSend("Page.enable");
    await pageSend("Runtime.enable");
    await pageSend("Network.enable");
    await pageSend("Page.navigate", {
      url: PLAYER_ENDPOINT + encodeURIComponent(sourceUrl),
    });

    const frameUrl = await waitForValue(
      pageSend,
      `[...document.querySelectorAll("iframe")]
        .map((frame) => frame.src)
        .find((src) => {
          try { return new URL(src).host === ${JSON.stringify(FINAL_HOST)}; }
          catch { return false; }
        }) || ""`,
      timeoutMs,
    );
    if (!frameUrl) {
      throw new AppError("PARSE_FAILED", 502, "冰豆未生成播放器入口");
    }

    await evaluate(pageSend, `location.href = ${JSON.stringify(frameUrl)}`);
    const started = Date.now();
    let video = null;
    while (Date.now() - started < timeoutMs) {
      video = await evaluate(pageSend, `(() => {
        const video = document.querySelector("video");
        if (!video) return null;
        video.muted = true;
        if (video.paused) video.play().catch(() => {});
        return {
          src: video.currentSrc || video.src || "",
          readyState: video.readyState,
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
          error: video.error ? { code: video.error.code, message: video.error.message } : null,
        };
      })()`).catch(() => null);
      if (video?.src && Number.isFinite(video.duration) && video.duration > 0 &&
          video.readyState >= 2 && !video.error) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (!video?.src || !Number.isFinite(video.duration) || video.duration <= 0) {
      throw new AppError("PARSE_FAILED", 502, "冰豆播放器未返回可用媒体");
    }
    return {
      playUrl: video.src,
      type: "mp4",
      width: video.width,
      height: video.height,
      duration: video.duration,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("BROWSER_ERROR", 502, "冰豆浏览器解析失败", { cause: err });
  } finally {
    try { pageWs?.close(); } catch {}
    try { browserWs?.close(); } catch {}
    cleanup();
  }
}
