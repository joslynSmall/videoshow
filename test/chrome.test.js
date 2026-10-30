import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromeBin, chromeDataDir, chromeProxyArgs, killChrome, removeChromeDir } from "../src/providers/chrome.js";

const WIN_ENV = {
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
};
const WIN_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

test("chromeBin prefers CHROME_BIN on every platform", () => {
  assert.equal(chromeBin({ env: { CHROME_BIN: "D:\\chrome.exe" }, platform: "win32" }), "D:\\chrome.exe");
  assert.equal(chromeBin({ env: { CHROME_BIN: "/opt/chrome" }, platform: "linux" }), "/opt/chrome");
});

test("chromeBin keeps the Linux default outside Windows", () => {
  assert.equal(chromeBin({ env: {}, platform: "linux" }), "/usr/bin/google-chrome");
  assert.equal(chromeBin({ env: WIN_ENV, platform: "darwin" }), "/usr/bin/google-chrome");
});

test("chromeBin finds an installed Chrome on Windows", () => {
  const installed = new Set(["C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"]);
  assert.equal(
    chromeBin({ env: WIN_ENV, platform: "win32", exists: (file) => installed.has(file) }),
    "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
  );
});

test("chromeBin falls back to Edge, then to the first Chrome path on Windows", () => {
  const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  assert.equal(chromeBin({ env: WIN_ENV, platform: "win32", exists: (file) => file === edge }), edge);
  assert.equal(chromeBin({ env: WIN_ENV, platform: "win32", exists: () => false }), WIN_CHROME);
  assert.equal(chromeBin({ env: {}, platform: "win32", exists: () => false }), "/usr/bin/google-chrome");
});

test("chromeDataDir lives in the system temp directory and is unique", () => {
  const first = chromeDataDir("vs-chrome");
  const second = chromeDataDir("vs-chrome");
  assert.equal(path.dirname(first), os.tmpdir());
  assert.match(path.basename(first), /^vs-chrome-\d+-[a-z0-9]+$/);
  assert.notEqual(first, second);
});

test("removeChromeDir deletes the profile directory and tolerates a missing one", async () => {
  const dir = chromeDataDir("vs-chrome-test");
  fs.mkdirSync(path.join(dir, "Default"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Default", "Preferences"), "{}");
  assert.equal(await removeChromeDir(dir, null), true);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(await removeChromeDir(dir, null), true);
});

test("killChrome ends the whole process tree with taskkill on Windows", () => {
  const calls = [];
  const killer = new EventEmitter();
  const child = { pid: 4242, kill: () => calls.push("child.kill") };
  killChrome(child, "SIGKILL", {
    platform: "win32",
    spawnFn: (command, args, options) => {
      calls.push({ command, args, windowsHide: options.windowsHide });
      return killer;
    },
  });
  assert.deepEqual(calls, [{ command: "taskkill", args: ["/pid", "4242", "/T", "/F"], windowsHide: true }]);
  killer.emit("error", new Error("ENOENT"));
  assert.equal(calls.at(-1), "child.kill", "taskkill 不可用时退回 child.kill");
});

test("killChrome sends the requested signal outside Windows and tolerates missing children", () => {
  const signals = [];
  killChrome({ pid: 1, kill: (signal) => signals.push(signal) }, "SIGTERM", { platform: "linux" });
  killChrome({ pid: 1, kill: (signal) => signals.push(signal) }, "SIGKILL", { platform: "linux" });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.doesNotThrow(() => killChrome(null));
  assert.doesNotThrow(() =>
    killChrome({ pid: 1, kill: () => { throw new Error("already gone"); } }, "SIGKILL", { platform: "linux" }),
  );
});

test("chromeProxyArgs reuses env proxies only where Chrome ignores them", () => {
  const env = { HTTPS_PROXY: "http://192.168.77.1:17897", NO_PROXY: "localhost, 127.0.0.1 ,::1" };
  assert.deepEqual(chromeProxyArgs({ env, platform: "win32" }), [
    "--proxy-server=http://192.168.77.1:17897",
    "--proxy-bypass-list=localhost;127.0.0.1;::1",
  ]);
  assert.deepEqual(chromeProxyArgs({ env, platform: "darwin" }).length, 2);
  assert.deepEqual(chromeProxyArgs({ env, platform: "linux" }), [], "Linux 的 Chrome 自己会读环境变量");
  assert.deepEqual(chromeProxyArgs({ env: {}, platform: "win32" }), []);
});

test("chromeProxyArgs honours CHROME_PROXY on every platform and sanitises the value", () => {
  assert.deepEqual(chromeProxyArgs({ env: { CHROME_PROXY: "socks5://10.0.0.2:1080" }, platform: "linux" }), [
    "--proxy-server=socks5://10.0.0.2:1080",
  ]);
  assert.deepEqual(chromeProxyArgs({ env: { CHROME_PROXY: "10.0.0.2:8080" }, platform: "win32" }), [
    "--proxy-server=http://10.0.0.2:8080",
  ]);
  assert.deepEqual(
    chromeProxyArgs({ env: { HTTPS_PROXY: "http://user:secret@proxy.example:3128" }, platform: "win32" }),
    ["--proxy-server=http://proxy.example:3128"],
    "凭据不能出现在浏览器命令行参数里",
  );
  assert.deepEqual(chromeProxyArgs({ env: { HTTPS_PROXY: "ftp://proxy.example:21" }, platform: "win32" }), []);
  assert.deepEqual(chromeProxyArgs({ env: { HTTPS_PROXY: "not a url ::" }, platform: "win32" }), []);
});
