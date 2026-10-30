// 播放卡顿判定：纯状态机，不碰 DOM 和计时器，由调用方定时采样后传入 tick。
//
// 三层判定，只有"起播失败"和"硬卡死"是确定的坏线路，"慢性卡顿"则要克制：
//   1. 起播失败：新线路一直没有数据（暂停时只看元数据，播放时看能否连续播放），超过 startupTimeoutMs；
//   2. 硬卡死：播放中连续断流超过 hardStallMs；
//   3. 慢性卡顿：滑动窗口内卡顿次数或卡顿占比过高。受换线冷却约束，避免在几条同样差的线路间来回切。
// 断流到 softRecoverMs 时先给一次"自救"机会（让 HLS 重新加载分片、降清晰度），不直接换线。
export const STALL_DEFAULTS = Object.freeze({
  tickMs: 500,
  startupTimeoutMs: 10_000,
  softRecoverMs: 3_000,
  hardStallMs: 5_000,
  advanceEpsilon: 0.05,
  maxTickGapMs: 2_000,
  seekGraceMs: 3_000,
  windowMs: 60_000,
  chronicMinStallMs: 1_000,
  chronicCount: 3,
  chronicRatio: 0.15,
  chronicRatioMinCount: 2,
  chronicMinObservedMs: 20_000,
  cooldownMs: 30_000,
});

const NONE = Object.freeze({ action: "none" });

export function createStallMonitor(overrides = {}) {
  const cfg = { ...STALL_DEFAULTS, ...overrides };
  let lastSwitchAt = -Infinity;
  let state;

  // 新线路（含换线后）从起播阶段重新开始；switched=true 时记录换线时刻用于冷却。
  function reset(now, { switched = false } = {}) {
    if (switched) lastSwitchAt = now;
    state = {
      played: false,
      blockedSince: null,
      lastTime: null,
      lastTickAt: null,
      stallStartAt: null,
      softDone: false,
      graceUntil: 0,
      stalls: [],
      samples: [],
    };
  }

  function startupTick(sample, now, dt, advanced, online) {
    if (!online) {
      // 断网期间暂停起播计时，不能怪线路。
      if (state.blockedSince !== null) state.blockedSince += dt;
      return NONE;
    }
    if (sample.seeking) {
      state.blockedSince = null;
      return NONE;
    }
    if (!sample.paused && advanced) {
      state.played = true;
      state.blockedSince = null;
      return NONE;
    }
    // 暂停时（例如自动播放被拦截）只要元数据没到就算没起播；播放时要能连续播放才算起播成功。
    const blocked = sample.paused ? sample.readyState < 1 : sample.readyState < 3;
    if (!blocked) {
      state.blockedSince = null;
      return NONE;
    }
    if (state.blockedSince === null) state.blockedSince = now;
    const blockedMs = now - state.blockedSince;
    if (blockedMs >= cfg.startupTimeoutMs) {
      return { action: "switch", reason: "startup", blockedMs };
    }
    return NONE;
  }

  function chronicCheck(now, ongoingMs) {
    if (now - lastSwitchAt < cfg.cooldownMs) return null;
    const since = now - cfg.windowMs;
    const recent = state.stalls.filter((item) => item.at >= since);
    const ongoing = ongoingMs >= cfg.chronicMinStallMs ? ongoingMs : 0;
    const count = recent.length + (ongoing ? 1 : 0);
    const stalledMs = recent.reduce((total, item) => total + item.ms, 0) + ongoing;
    const observedMs = state.samples
      .filter((item) => item.at >= since && item.active)
      .reduce((total, item) => total + item.dt, 0);
    if (count >= cfg.chronicCount) {
      return { action: "switch", reason: "chronic", count, stalledMs, observedMs };
    }
    if (
      count >= cfg.chronicRatioMinCount &&
      observedMs >= cfg.chronicMinObservedMs &&
      stalledMs / observedMs >= cfg.chronicRatio
    ) {
      return { action: "switch", reason: "chronic", count, stalledMs, observedMs };
    }
    return null;
  }

  function playingTick(sample, now, dt, advanced, online) {
    const active =
      online && !sample.paused && !sample.ended && !sample.seeking && now >= state.graceUntil;
    const stalledNow = active && sample.readyState < 3 && !advanced;

    state.samples.push({ at: now, dt, active });
    const since = now - cfg.windowMs;
    state.samples = state.samples.filter((item) => item.at >= since);
    state.stalls = state.stalls.filter((item) => item.at >= since);

    if (!active) {
      // 暂停、拖动、断网引起的中断不是线路的问题，直接丢弃进行中的卡顿。
      state.stallStartAt = null;
      state.softDone = false;
      return NONE;
    }
    if (!stalledNow) {
      if (state.stallStartAt !== null) {
        const ms = now - state.stallStartAt;
        if (ms >= cfg.chronicMinStallMs) state.stalls.push({ at: now, ms });
        state.stallStartAt = null;
        state.softDone = false;
      }
      return chronicCheck(now, 0) || NONE;
    }

    if (state.stallStartAt === null) state.stallStartAt = now;
    const stalledMs = now - state.stallStartAt;
    if (stalledMs >= cfg.hardStallMs) return { action: "switch", reason: "hard", stalledMs };
    const chronic = chronicCheck(now, stalledMs);
    if (chronic) return chronic;
    if (stalledMs >= cfg.softRecoverMs && !state.softDone) {
      state.softDone = true;
      return { action: "recover", reason: "stall", stalledMs };
    }
    return NONE;
  }

  // sample: { paused, seeking, ended, readyState, currentTime, online }
  function tick(sample, now) {
    const dt =
      state.lastTickAt === null ? 0 : Math.min(Math.max(now - state.lastTickAt, 0), cfg.maxTickGapMs);
    const advanced =
      state.lastTime !== null && Math.abs(sample.currentTime - state.lastTime) >= cfg.advanceEpsilon;
    state.lastTickAt = now;
    state.lastTime = sample.currentTime;
    // 拖动进度条后缓冲数据需要时间，给一段宽限，不把它算作线路卡顿。
    if (sample.seeking) state.graceUntil = now + cfg.seekGraceMs;
    const online = sample.online !== false;
    return state.played
      ? playingTick(sample, now, dt, advanced, online)
      : startupTick(sample, now, dt, advanced, online);
  }

  reset(0);
  return { tickMs: cfg.tickMs, reset, tick };
}
