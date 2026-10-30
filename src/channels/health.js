import fs from "node:fs";
import path from "node:path";

const KEEP_DAYS = 30;
const SAVE_DELAY_MS = 2000;

// 自然日：按指定时区（默认服务器本地时区）取 YYYY-MM-DD，字符串可直接比较先后。
export function createDayKey(timeZone = "") {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (ms) => formatter.format(new Date(ms));
}

function emptyState() {
  return { version: 1, channels: {} };
}

function sanitize(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.channels !== "object" || !raw.channels) {
    return emptyState();
  }
  const state = emptyState();
  for (const [id, channel] of Object.entries(raw.channels)) {
    if (!channel || typeof channel !== "object") continue;
    const days = {};
    for (const [day, bucket] of Object.entries(channel.days || {})) {
      const attempts = Number(bucket?.attempts);
      const successes = Number(bucket?.successes);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(attempts) && Number.isFinite(successes)) {
        days[day] = { attempts, successes };
      }
    }
    state.channels[id] = {
      days,
      ...(typeof channel.endpoint === "string" ? { endpoint: channel.endpoint } : {}),
      ...(Number.isInteger(channel.revision) ? { revision: channel.revision } : {}),
      ...(channel.removed && typeof channel.removed === "object" ? { removed: channel.removed } : {}),
    };
  }
  return state;
}

// 渠道健康账本：按自然天累计"可用/不可用"，累计够天数就把渠道摘除。
//
// 一个自然日算"不可用"需同时满足：
//   1. 这一天已经结束（当天的数据不下结论）；
//   2. 当天至少尝试了 minAttempts 次（流量太小没有说服力）；
//   3. 当天一次可用结果都没有；
//   4. 当天至少有一个别的渠道成功过。否则说明是整体故障（断网、代理挂了、DNS 异常），不能怪渠道。
// 不可用的天数累计（不要求连续）达到 deadDays 就摘除，保留最近 keepDays 个自然日的记录。
export function createChannelHealth({
  file = "",
  now = Date.now,
  timeZone = "",
  deadDays = 3,
  minAttempts = 3,
  keepDays = KEEP_DAYS,
  logger = { info() {}, warn() {} },
} = {}) {
  const dayKey = createDayKey(timeZone);
  let state = load();
  let dirty = false;
  let timer = null;
  let saveFailed = false;
  let lastEvaluatedDay = "";

  function load() {
    if (!file) return emptyState();
    try {
      return sanitize(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") {
        logger.warn("channel.state_load_failed", { message: err?.message });
      }
      return emptyState();
    }
  }

  function save() {
    timer = null;
    if (!dirty || !file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(state));
      fs.renameSync(temp, file);
      dirty = false;
      saveFailed = false;
    } catch (err) {
      // 只读文件系统（例如 Serverless）时退化为内存统计，只告警一次。
      if (!saveFailed) logger.warn("channel.state_save_failed", { message: err?.message });
      saveFailed = true;
    }
  }

  function markDirty() {
    dirty = true;
    if (!file || timer) return;
    timer = setTimeout(save, SAVE_DELAY_MS);
    timer.unref?.();
  }

  function channel(id) {
    state.channels[id] ??= { days: {} };
    return state.channels[id];
  }

  function prune(entry, today) {
    const oldest = dayKey(now() - keepDays * 86_400_000);
    for (const day of Object.keys(entry.days)) {
      if (day < oldest || day > today) delete entry.days[day];
    }
  }

  function wholeOutage(day) {
    return !Object.values(state.channels).some((entry) => (entry.days[day]?.successes || 0) > 0);
  }

  function unavailableDays(id) {
    const today = dayKey(now());
    const days = state.channels[id]?.days || {};
    return Object.entries(days)
      .filter(([day, bucket]) =>
        day < today && bucket.attempts >= minAttempts && bucket.successes === 0 && !wholeOutage(day))
      .map(([day]) => day)
      .sort();
  }

  // 返回本次新摘除的渠道。
  function evaluate() {
    const today = dayKey(now());
    lastEvaluatedDay = today;
    const removedNow = [];
    for (const [id, entry] of Object.entries(state.channels)) {
      if (entry.removed) continue;
      const days = unavailableDays(id);
      if (days.length < deadDays) continue;
      entry.removed = {
        at: new Date(now()).toISOString(),
        day: today,
        endpoint: entry.endpoint || "",
        reason: `累计 ${days.length} 个自然日不可用`,
        unavailableDays: days,
      };
      removedNow.push({ id, ...entry.removed });
      logger.warn("channel.removed", { provider: id, unavailableDays: days.join(",") });
    }
    if (removedNow.length) markDirty();
    return removedNow;
  }

  return {
    record(id, ok) {
      const entry = channel(id);
      if (entry.removed) return;
      const today = dayKey(now());
      const bucket = (entry.days[today] ??= { attempts: 0, successes: 0 });
      bucket.attempts += 1;
      if (ok) bucket.successes += 1;
      prune(entry, today);
      markDirty();
      if (lastEvaluatedDay !== today) evaluate();
    },
    evaluate,
    isRemoved(id) {
      return Boolean(state.channels[id]?.removed);
    },
    // 记录渠道当前使用的地址，摘除时一并保存；之后地址变了就视为换了一个新渠道。
    setEndpoint(id, endpoint) {
      const entry = channel(id);
      if (entry.endpoint === endpoint) return;
      entry.endpoint = endpoint;
      markDirty();
    },
    // 摘除后的复活：外部配置给了新地址，或把 revision 调大。复活后重新累计。
    revive(id, { endpoint = "", revision = 0 } = {}) {
      const entry = state.channels[id];
      if (!entry?.removed) {
        if (entry && revision > (entry.revision || 0)) {
          entry.revision = revision;
          markDirty();
        }
        return false;
      }
      const moved = Boolean(endpoint) && entry.removed.endpoint && entry.removed.endpoint !== endpoint;
      const bumped = revision > (entry.revision || 0);
      if (!moved && !bumped) return false;
      state.channels[id] = { days: {}, ...(endpoint ? { endpoint } : {}), ...(revision ? { revision } : {}) };
      logger.info("channel.revived", { provider: id, reason: moved ? "endpoint_changed" : "revision_bumped" });
      markDirty();
      return true;
    },
    status(id) {
      const entry = state.channels[id];
      const today = dayKey(now());
      const days = Object.entries(entry?.days || {});
      const lastSuccessDay = days.filter(([, bucket]) => bucket.successes > 0).map(([day]) => day).sort().pop() || "";
      return {
        removed: entry?.removed || null,
        unavailableDays: unavailableDays(id),
        lastSuccessDay,
        today: entry?.days?.[today] || { attempts: 0, successes: 0 },
      };
    },
    ids() {
      return Object.keys(state.channels);
    },
    flush() {
      if (timer) clearTimeout(timer);
      save();
    },
    dayKey,
  };
}
