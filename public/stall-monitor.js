// 播放卡顿判定：纯状态机，不碰 DOM 和计时器，由调用方定时采样后传入 tick。
//
// 仅保留明确可靠的双重判定：
//   1. 起播失败：新线路一直没有数据，超过 startupTimeoutMs；
//   2. 播放硬卡死：播放中连续断流超过 hardStallMs。
export const STALL_DEFAULTS = Object.freeze({
  tickMs: 500,
  startupTimeoutMs: 10_000,
  hardStallMs: 5_000,
  advanceEpsilon: 0.05,
  maxTickGapMs: 2_000,
  seekGraceMs: 3_000,
});

const NONE = Object.freeze({ action: "none" });

export function createStallMonitor(overrides = {}) {
  const cfg = { ...STALL_DEFAULTS, ...overrides };
  let state;

  function reset() {
    state = {
      played: false,
      blockedSince: null,
      lastTime: null,
      lastTickAt: null,
      stallStartAt: null,
      graceUntil: 0,
    };
  }

  function startupTick(sample, now, dt, advanced, online) {
    if (!online) {
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

  function playingTick(sample, now, _dt, advanced, online) {
    const active =
      online && !sample.paused && !sample.ended && !sample.seeking && now >= state.graceUntil;
    const stalledNow = active && sample.readyState < 3 && !advanced;

    if (!active) {
      state.stallStartAt = null;
      return NONE;
    }
    if (!stalledNow) {
      state.stallStartAt = null;
      return NONE;
    }

    if (state.stallStartAt === null) state.stallStartAt = now;
    const stalledMs = now - state.stallStartAt;
    if (stalledMs >= cfg.hardStallMs) {
      state.stallStartAt = null;
      return { action: "switch", reason: "hard", stalledMs };
    }
    return NONE;
  }

  function tick(sample, now) {
    const dt =
      state.lastTickAt === null ? 0 : Math.min(Math.max(now - state.lastTickAt, 0), cfg.maxTickGapMs);
    const advanced =
      state.lastTime !== null && Math.abs(sample.currentTime - state.lastTime) >= cfg.advanceEpsilon;
    state.lastTickAt = now;
    state.lastTime = sample.currentTime;
    if (sample.seeking) state.graceUntil = now + cfg.seekGraceMs;
    const online = sample.online !== false;
    return state.played
      ? playingTick(sample, now, dt, advanced, online)
      : startupTick(sample, now, dt, advanced, online);
  }

  reset(0);
  return { tickMs: cfg.tickMs, reset, tick };
}
