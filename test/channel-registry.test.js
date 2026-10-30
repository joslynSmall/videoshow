import assert from "node:assert/strict";
import test from "node:test";
import { createChannelHealth } from "../src/channels/health.js";
import {
  createChannelRegistry,
  parseRemoteChannels,
  validateChannelEndpoint,
} from "../src/channels/registry.js";
import { createHttpChannel, HTTP_CHANNELS, resolveHttpChannel } from "../src/providers/http.js";

const at = (day, hour = 12) => Date.UTC(2026, 9, day, hour);
const remoteOf = (body, status = 200) => async () => Response.json(body, { status });
const ids = (registry) => registry.httpChannels().map((channel) => channel.id);

test("endpoint validation only allows public https prefixes", () => {
  assert.equal(validateChannelEndpoint("https://jx.example.com/index.php?url="), "");
  for (const bad of [
    "http://jx.example.com/?url=",
    "https://user:pw@jx.example.com/?url=",
    "https://jx.example.com:8443/?url=",
    "https://127.0.0.1/?url=",
    "https://[::1]/?url=",
    "https://localhost/?url=",
    "https://printer.local/?url=",
    "https://intranet/?url=",
    "https://jx.example.com/play",
    "ftp://jx.example.com/?url=",
    "not a url",
    `https://jx.example.com/?${"a".repeat(600)}=`,
    42,
  ]) {
    assert.notEqual(validateChannelEndpoint(bad), "", String(bad));
  }
});

test("remote entries are normalised and bad ones are dropped individually", () => {
  const { accepted, rejected } = parseRemoteChannels({
    channels: [
      { id: "LX", endpoint: "https://jx.example.com/?url=", name: " 新名字 ", revision: 2, singleUse: true },
      { id: "bad id" },
      { id: "dup", endpoint: "https://a.example.com/?url=" },
      { id: "dup", endpoint: "https://b.example.com/?url=" },
      { id: "evil", endpoint: "https://127.0.0.1/?url=" },
      { id: "parser", parser: "does-not-exist" },
      { id: "rev", revision: -1 },
      { id: "off", enabled: false },
    ],
  });
  assert.deepEqual(accepted.map((item) => item.id), ["lx", "dup", "off"]);
  assert.equal(accepted[0].name, "新名字");
  assert.equal(accepted[0].revision, 2);
  assert.equal(accepted[0].singleUse, true);
  assert.equal(accepted[2].enabled, false);
  assert.deepEqual(rejected.map((item) => item.id), ["bad id", "dup", "evil", "parser", "rev"]);
  assert.throws(() => parseRemoteChannels({ nope: [] }), /channels/);
  assert.equal(parseRemoteChannels([{ id: "a", endpoint: "https://a.example.com/?url=" }]).accepted.length, 1);
});

test("without a remote config the registry serves the built-in channels", () => {
  const registry = createChannelRegistry({ builtins: HTTP_CHANNELS });
  assert.deepEqual(ids(registry), HTTP_CHANNELS.map((channel) => channel.id));
  assert.equal(registry.isActive("jx-browser"), true);
  assert.equal(registry.ensureFresh(), undefined);
});

test("remote config overrides addresses, adds channels and disables others", async () => {
  const registry = createChannelRegistry({
    builtins: HTTP_CHANNELS,
    remoteUrl: "https://config.example.com/channels.json",
    fetchFn: remoteOf({
      channels: [
        { id: "lx", endpoint: "https://new-lx.example.com/index.php?url=" },
        { id: "extra", name: "新增渠道", endpoint: "https://extra.example.com/?url=" },
        { id: "qilin", enabled: false },
        { id: "jx-browser", enabled: false },
      ],
    }),
  });
  assert.equal(await registry.refresh(), true);
  const byId = Object.fromEntries(registry.httpChannels().map((channel) => [channel.id, channel]));
  assert.equal(byId.lx.endpoint, "https://new-lx.example.com/index.php?url=");
  assert.equal(byId.lx.resolveResponse, HTTP_CHANNELS.find((item) => item.id === "lx").resolveResponse, "沿用原解析器");
  assert.equal(byId.lx.singleUse, true);
  assert.equal(byId.extra.name, "新增渠道");
  assert.equal(byId.extra.parser, "generic");
  assert.equal(byId.qilin, undefined);
  assert.equal(byId.bingdou.endpoint, HTTP_CHANNELS.find((item) => item.id === "bingdou").endpoint, "未提到的保持原样");
  assert.equal(registry.isActive("jx-browser"), false, "没有地址的内置渠道也能被外部配置停用");
  assert.equal(registry.isActive("jiexi789"), true);
  assert.equal(registry.status().channels.find((item) => item.id === "qilin").state, "disabled");
});

test("a failed refresh keeps the last good config and retries later", async () => {
  const clock = { now: at(1) };
  let mode = "ok";
  const registry = createChannelRegistry({
    builtins: HTTP_CHANNELS,
    remoteUrl: "https://config.example.com/channels.json",
    refreshMs: 600_000,
    now: () => clock.now,
    fetchFn: async () => {
      if (mode === "throw") throw new TypeError("fetch failed");
      if (mode === "status") return new Response("no", { status: 503 });
      if (mode === "huge") return new Response("x".repeat(70 * 1024));
      if (mode === "html") return new Response("<html>");
      return Response.json({ channels: [{ id: "extra", endpoint: "https://extra.example.com/?url=" }] });
    },
  });
  assert.equal(await registry.refresh(), true);
  assert.ok(ids(registry).includes("extra"));
  for (const bad of ["throw", "status", "huge", "html"]) {
    mode = bad;
    assert.equal(await registry.refresh(), false, bad);
    assert.ok(ids(registry).includes("extra"), `${bad}: 沿用上次成功的配置`);
    assert.equal(registry.status().remote.ok, false);
  }
  mode = "ok";
  assert.equal(await registry.refresh(), true);
  assert.equal(registry.status().remote.ok, true);
});

test("ensureFresh refreshes in the background and respects the interval and backoff", async () => {
  const clock = { now: at(1) };
  let calls = 0;
  let fail = false;
  const registry = createChannelRegistry({
    builtins: HTTP_CHANNELS,
    remoteUrl: "https://config.example.com/channels.json",
    refreshMs: 600_000,
    now: () => clock.now,
    fetchFn: async () => {
      calls += 1;
      if (fail) throw new TypeError("fetch failed");
      return Response.json({ channels: [] });
    },
  });
  registry.ensureFresh();
  registry.ensureFresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, "同时只有一个刷新在进行");
  registry.ensureFresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, "没到刷新间隔不重复拉取");
  clock.now += 600_001;
  fail = true;
  registry.ensureFresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 2);
  clock.now += 30_000;
  registry.ensureFresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 2, "失败后 1 分钟内不重试");
  clock.now += 31_000;
  registry.ensureFresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 3);
});

test("channels built from remote config are the only extra ones resolveHttpChannel will request", async () => {
  const spoofed = { id: "spoof", name: "x", endpoint: "https://evil.example.com/?url=" };
  await assert.rejects(resolveHttpChannel(spoofed, "https://v.qq.com/x/a.html"), { code: "CONFIG_ERROR" });

  const channel = createHttpChannel({ id: "extra", name: "新增", endpoint: "https://extra.example.com/?url=" });
  const requested = [];
  const result = await resolveHttpChannel(channel, "https://v.qq.com/x/a.html", {
    request: async (url) => {
      requested.push(url);
      return { text: '<video src="https://cdn.example.com/a.m3u8"></video>' };
    },
  });
  assert.deepEqual(requested, ["https://extra.example.com/?url=https%3A%2F%2Fv.qq.com%2Fx%2Fa.html"]);
  assert.equal(result.playUrl, "https://cdn.example.com/a.m3u8");
  assert.equal(result.provider, "extra");
  assert.throws(() => createHttpChannel({ id: "x", name: "x", endpoint: "https://x.example.com/?url=", parser: "nope" }));
});

test("removed channels leave the registry and come back when the config gives a new address", async () => {
  const clock = { now: at(1) };
  const health = createChannelHealth({ now: () => clock.now, timeZone: "UTC", deadDays: 1 });
  let endpoint = "https://jx.lxyy.club/index.php?url=";
  const registry = createChannelRegistry({
    builtins: HTTP_CHANNELS,
    health,
    remoteUrl: "https://config.example.com/channels.json",
    now: () => clock.now,
    fetchFn: async () => Response.json({ channels: [{ id: "lx", endpoint }] }),
  });
  await registry.refresh();
  assert.ok(ids(registry).includes("lx"));

  for (let i = 0; i < 3; i += 1) {
    registry.record("lx", false);
    registry.record("qilin", true);
  }
  clock.now = at(2);
  registry.record("qilin", true);
  assert.equal(ids(registry).includes("lx"), false, "摘除后不再参与解析");
  const removed = registry.status().channels.find((item) => item.id === "lx");
  assert.equal(removed.state, "removed");
  assert.match(removed.reason, /累计 1 个自然日不可用/);
  assert.equal(JSON.stringify(registry.status()).includes("jx.lxyy.club"), false, "状态里不暴露渠道地址");

  await registry.refresh();
  assert.equal(ids(registry).includes("lx"), false, "地址没变，配置刷新不会让它复活");

  endpoint = "https://jx-new.example.com/index.php?url=";
  await registry.refresh();
  assert.equal(ids(registry).includes("lx"), true, "给了新地址就重新启用");
  assert.equal(registry.httpChannels().find((item) => item.id === "lx").endpoint, endpoint);
});
