import { isIP } from "node:net";
import { createHttpChannel, HTTP_PARSERS } from "../providers/http.js";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_CHANNELS = 32;
const FETCH_TIMEOUT_MS = 5000;
const RETRY_AFTER_FAILURE_MS = 60_000;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const INTERNAL_SUFFIX = /(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/;

function parserNameOf(channel) {
  if (channel.parser) return channel.parser;
  return Object.entries(HTTP_PARSERS).find(([, fn]) => fn && fn === channel.resolveResponse)?.[0] || "generic";
}

// 外部配置里的地址会被服务端当作请求目标，所以只接受：https、无凭据、默认端口、
// 非 IP 字面量、非内网域名，并且是 "…url=" 这种拼接前缀形式（和内置渠道一致）。
export function validateChannelEndpoint(raw) {
  if (typeof raw !== "string" || raw.length > 512) return "endpoint 无效";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "endpoint 不是合法地址";
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "https:") return "endpoint 必须是 https";
  if (url.username || url.password) return "endpoint 不能带凭据";
  if (url.port && url.port !== "443") return "endpoint 只能使用默认端口";
  if (!host || isIP(host) || !host.includes(".") || INTERNAL_SUFFIX.test(host)) return "endpoint 不能指向 IP 或内网域名";
  if (!raw.endsWith("=")) return "endpoint 必须以 = 结尾，用于拼接视频地址";
  return "";
}

// 把外部配置整理成标准条目；非法条目被丢弃并给出原因，不影响其他条目。
export function parseRemoteChannels(payload) {
  const list = Array.isArray(payload) ? payload : payload?.channels;
  if (!Array.isArray(list)) throw new Error("配置缺少 channels 数组");
  const accepted = [];
  const rejected = [];
  for (const raw of list.slice(0, MAX_CHANNELS)) {
    const id = typeof raw?.id === "string" ? raw.id.trim().toLowerCase() : "";
    if (!ID_PATTERN.test(id)) {
      rejected.push({ id: String(raw?.id ?? ""), reason: "id 无效" });
      continue;
    }
    if (accepted.some((item) => item.id === id)) {
      rejected.push({ id, reason: "id 重复" });
      continue;
    }
    const entry = { id, enabled: raw.enabled !== false };
    if (raw.revision !== undefined) {
      if (!Number.isInteger(raw.revision) || raw.revision < 0) {
        rejected.push({ id, reason: "revision 必须是非负整数" });
        continue;
      }
      entry.revision = raw.revision;
    }
    if (raw.name !== undefined) {
      if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 40) {
        rejected.push({ id, reason: "name 无效" });
        continue;
      }
      entry.name = raw.name.trim();
    }
    if (raw.type !== undefined) {
      if (raw.type !== "browser" && raw.type !== "http-api") {
        rejected.push({ id, reason: "type 必须是 browser 或 http-api" });
        continue;
      }
      entry.type = raw.type;
    }
    if (raw.parser !== undefined) {
      if (typeof raw.parser !== "string" || !Object.hasOwn(HTTP_PARSERS, raw.parser)) {
        rejected.push({ id, reason: "parser 未知" });
        continue;
      }
      entry.parser = raw.parser;
    }
    if (raw.endpoint !== undefined) {
      const problem = validateChannelEndpoint(raw.endpoint);
      if (problem) {
        rejected.push({ id, reason: problem });
        continue;
      }
      entry.endpoint = raw.endpoint;
    }
    for (const flag of ["singleUse", "fallback", "deleted"]) {
      if (raw[flag] !== undefined) entry[flag] = raw[flag] === true;
    }
    accepted.push(entry);
  }
  return { accepted, rejected };
}

async function readBoundedJson(response) {
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_CONFIG_BYTES) throw new Error("配置过大");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(text);
}

// 渠道注册表：内置渠道 + 外部配置（可改地址、增删渠道），再减去已被健康账本摘除的渠道。
// 外部配置拉取失败时沿用上一次成功的结果，从没成功过就只用内置渠道。
export function createChannelRegistry({
  builtins = [],
  builtinBrowsers = [],
  health = null,
  remoteUrl = "",
  refreshMs = 600_000,
  fetchFn = (...args) => fetch(...args),
  now = Date.now,
  logger = { info() {}, warn() {} },
} = {}) {
  const base = new Map(builtins.map((channel) => [channel.id, channel]));
  const baseBrowsers = new Map(builtinBrowsers.map((channel) => [channel.id, channel]));
  const savedOverrides = health?.overrides?.() ?? [];
  const initialEntries = savedOverrides.length
    ? parseRemoteChannels(savedOverrides).accepted.filter((item) => !item.deleted)
    : [];
  const remote = {
    fetchedAt: 0,
    nextAttemptAt: 0,
    ok: null,
    error: "",
    total: initialEntries.length,
    rejected: [],
    entries: initialEntries,
  };
  let active = [...base.values()];
  let browserChannels = [...baseBrowsers.values()];
  let inflight = null;

  function rebuild() {
    const channels = new Map(base);
    const browsers = new Map([...baseBrowsers.values()].map((b) => [b.id, { ...b }]));
    const disabled = new Set();
    for (const entry of remote.entries) {
      if (!entry.enabled) {
        disabled.add(entry.id);
        continue;
      }
      const builtinBrowser = baseBrowsers.get(entry.id);
      if (entry.type === "browser" || builtinBrowser) {
        const endpoint = entry.endpoint ?? builtinBrowser?.endpoint;
        if (!endpoint) {
          logger.warn("channel.config_skipped", { provider: entry.id, message: "新渠道必须提供 endpoint" });
          continue;
        }
        browsers.set(entry.id, {
          id: entry.id,
          name: entry.name ?? builtinBrowser?.name ?? entry.id,
          endpoint,
        });
        continue;
      }
      const builtin = base.get(entry.id);
      if (!builtin && !entry.endpoint && (entry.id === "jiexi789" || entry.id === "jx-browser")) {
        continue;
      }
      const spec = {
        id: entry.id,
        name: entry.name ?? builtin?.name ?? entry.id,
        endpoint: entry.endpoint ?? builtin?.endpoint,
        parser: entry.parser ?? (builtin ? parserNameOf(builtin) : "generic"),
        singleUse: entry.singleUse ?? builtin?.singleUse === true,
        fallback: entry.fallback ?? builtin?.fallback === true,
      };
      if (!spec.endpoint) {
        logger.warn("channel.config_skipped", { provider: entry.id, message: "新渠道必须提供 endpoint" });
        continue;
      }
      const unchanged = builtin && spec.endpoint === builtin.endpoint && spec.name === builtin.name &&
        spec.parser === parserNameOf(builtin) && spec.singleUse === (builtin.singleUse === true) &&
        spec.fallback === (builtin.fallback === true);
      channels.set(entry.id, unchanged ? builtin : createHttpChannel(spec));
    }
    for (const id of disabled) {
      channels.delete(id);
      browsers.delete(id);
    }
    for (const channel of channels.values()) health?.setEndpoint(channel.id, channel.endpoint);
    for (const browser of browsers.values()) health?.setEndpoint(browser.id, browser.endpoint);
    for (const entry of remote.entries) {
      if (entry.enabled && (channels.has(entry.id) || browsers.has(entry.id))) {
        const ep = channels.get(entry.id)?.endpoint || browsers.get(entry.id)?.endpoint;
        health?.revive(entry.id, { endpoint: ep, revision: entry.revision ?? 0 });
      }
    }
    active = [...channels.values()];
    browserChannels = [...browsers.values()];
    remote.disabled = disabled;
  }

  async function refresh() {
    if (!remoteUrl) return false;
    try {
      const response = await fetchFn(remoteUrl, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const { accepted, rejected } = parseRemoteChannels(await readBoundedJson(response));
      remote.entries = accepted;
      remote.rejected = rejected;
      remote.total = accepted.length;
      remote.ok = true;
      remote.error = "";
      remote.fetchedAt = now();
      remote.nextAttemptAt = now() + refreshMs;
      rebuild();
      logger.info("channel.config_loaded", { count: accepted.length, rejected: rejected.length });
      for (const item of rejected) logger.warn("channel.config_rejected", { provider: item.id, message: item.reason });
      return true;
    } catch (err) {
      remote.ok = false;
      remote.error = err?.message || "拉取失败";
      remote.nextAttemptAt = now() + Math.min(refreshMs, RETRY_AFTER_FAILURE_MS);
      logger.warn("channel.config_failed", { message: remote.error });
      return false;
    }
  }

  rebuild();

  return {
    httpChannels() {
      return active.filter((channel) => !health?.isRemoved(channel.id));
    },
    browserChannels() {
      return browserChannels.filter((b) => !health?.isRemoved(b.id) && !remote.disabled?.has(b.id));
    },
    // jiexi789 / jx-browser 这类内置渠道，以及外部配置的各种渠道，都受健康账本约束。
    isActive(id) {
      return !health?.isRemoved(id) && !remote.disabled?.has(id);
    },
    record(id, ok) {
      health?.record(id, ok);
    },
    refresh,
    // 不阻塞调用方：过期了就在后台刷新。
    ensureFresh() {
      if (!remoteUrl || inflight || now() < remote.nextAttemptAt) return;
      inflight = refresh().finally(() => { inflight = null; });
    },
    flush() {
      health?.flush();
    },
    applyRemote(payload) {
      const { accepted, rejected } = parseRemoteChannels(payload);
      const byId = new Map(remote.entries.map((item) => [item.id, item]));
      for (const patch of accepted) {
        if (patch.deleted) {
          byId.delete(patch.id);
          if (!base.has(patch.id) && !baseBrowsers.has(patch.id)) {
            health?.forget?.(patch.id);
          }
          continue;
        }
        const prev = byId.get(patch.id);
        byId.set(patch.id, prev ? { ...prev, ...patch } : patch);
      }
      remote.entries = [...byId.values()];
      remote.rejected = rejected;
      remote.total = remote.entries.length;
      remote.ok = true;
      remote.error = "";
      remote.fetchedAt = now();
      health?.setOverrides?.(remote.entries);
      rebuild();
      return { accepted, rejected };
    },
    status(extraIds = []) {
      const ids = [...new Set([
        ...active.map((channel) => channel.id),
        ...browserChannels.map((b) => b.id),
        ...(remote.disabled ?? []),
        ...(health?.ids() ?? []),
        ...extraIds,
      ])];
      const channels = ids.map((id) => {
        const channel =
          active.find((item) => item.id === id) ??
          browserChannels.find((b) => b.id === id) ??
          base.get(id) ??
          baseBrowsers.get(id) ??
          remote.entries.find((e) => e.id === id);
        const detail = health?.status(id);
        const disabled = Boolean(remote.disabled?.has(id));
        const custom = !base.has(id) && !baseBrowsers.has(id) && !extraIds.includes(id);
        return {
          id,
          name: channel?.name || id,
          state: detail?.removed ? "removed" : disabled ? "disabled" : "active",
          custom,
          unavailableDays: detail?.unavailableDays ?? [],
          lastSuccessDay: detail?.lastSuccessDay || null,
          today: detail?.today ?? { attempts: 0, successes: 0 },
          ...(detail?.removed ? { removedAt: detail.removed.at, reason: detail.removed.reason } : {}),
        };
      });
      return {
        channels,
        remote: {
          configured: Boolean(remoteUrl),
          ok: remote.ok,
          fetchedAt: remote.fetchedAt ? new Date(remote.fetchedAt).toISOString() : null,
          channels: remote.total,
          rejected: remote.rejected,
          ...(remote.ok === false ? { error: remote.error } : {}),
        },
      };
    },
  };
}
