import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LINUX_CHROME = "/usr/bin/google-chrome";

// Windows 上 Chrome 通常装在 Program Files 或当前用户目录；Edge 是 Chromium 内核且系统自带，作为兜底。
function windowsCandidates(env) {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean);
  return [
    ...roots.map((root) => path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe")),
    ...roots.map((root) => path.win32.join(root, "Microsoft", "Edge", "Application", "msedge.exe")),
  ];
}

// CHROME_BIN 优先；否则按平台探测已安装的浏览器，都不存在时返回默认路径，
// 由调用方的存在性检查报 BROWSER_UNAVAILABLE。
export function chromeBin({
  env = process.env,
  platform = process.platform,
  exists = fs.existsSync,
} = {}) {
  if (env.CHROME_BIN) return env.CHROME_BIN;
  if (platform !== "win32") return LINUX_CHROME;
  const candidates = windowsCandidates(env);
  return candidates.find((candidate) => exists(candidate)) || candidates[0] || LINUX_CHROME;
}

const PROXY_PROTOCOLS = new Set(["http:", "https:", "socks:", "socks4:", "socks5:"]);

// Windows/macOS 上的 Chrome 不读取 HTTP(S)_PROXY 环境变量（Linux 的会），
// 只能走系统代理设置；在只有环境变量代理的机器上，无头浏览器会直连而失败。
// CHROME_PROXY 显式指定时在所有平台生效；否则非 Linux 平台沿用环境变量里的代理。
// 凭据不能写进 --proxy-server，这里只保留协议和主机端口。
export function chromeProxyArgs({ env = process.env, platform = process.platform } = {}) {
  const explicit = env.CHROME_PROXY;
  const raw = explicit || (platform === "linux"
    ? ""
    : env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy ||
      env.ALL_PROXY || env.all_proxy);
  if (!raw) return [];
  let proxy;
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    if (!PROXY_PROTOCOLS.has(url.protocol) || !url.host) return [];
    proxy = `${url.protocol}//${url.host}`;
  } catch {
    return [];
  }
  const bypass = String(env.NO_PROXY || env.no_proxy || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .join(";");
  return [`--proxy-server=${proxy}`, ...(bypass ? [`--proxy-bypass-list=${bypass}`] : [])];
}

// Chrome 的 user-data-dir 必须落在系统临时目录；
// 写死 /tmp 在 Windows 上会变成当前盘符根下的 \tmp，Chrome 无法在其中生成 DevToolsActivePort。
export function chromeDataDir(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// Chrome 退出后仍会短暂占用 profile 目录（POSIX 的 SingletonLock，Windows 的文件句柄），
// 目录删太快会失败并残留。用异步退避重试，避免阻塞事件循环影响其它并发请求；
// 重试到一半仍删不掉就强杀进程。
export async function removeChromeDir(dataDir, child, { attempts = 100, delayMs = 100 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fs.promises.rm(dataDir, { recursive: true, force: true });
      return true;
    } catch {
      if (i === 4) killChrome(child, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  killChrome(child, "SIGKILL");
  try {
    await fs.promises.rm(dataDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// Windows 不支持 POSIX 信号，kill() 只会强杀主进程，渲染、GPU 子进程会继续占用 profile 目录，
// 所以改用 taskkill /T 结束整个进程树。异步触发，不阻塞事件循环。
export function killChrome(
  child,
  signal = "SIGTERM",
  { platform = process.platform, spawnFn = spawn } = {},
) {
  if (!child) return;
  if (platform === "win32" && child.pid) {
    const killer = spawnFn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => {
      try { child.kill(signal); } catch {}
    });
    return;
  }
  try { child.kill(signal); } catch {}
}
