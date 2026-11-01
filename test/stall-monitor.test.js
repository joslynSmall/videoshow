import assert from "node:assert/strict";
import test from "node:test";
import { createStallMonitor, STALL_DEFAULTS } from "../public/stall-monitor.js";

const TICK = STALL_DEFAULTS.tickMs;

function harness(overrides) {
  const monitor = createStallMonitor(overrides);
  const clock = { now: 1_000, time: 0 };
  monitor.reset(clock.now);
  const run = (ticks, patch = {}, { advance = false } = {}) => {
    const decisions = [];
    for (let i = 0; i < ticks; i += 1) {
      clock.now += TICK;
      if (advance) clock.time += TICK / 1000;
      const decision = monitor.tick(
        {
          paused: false,
          seeking: false,
          ended: false,
          readyState: 4,
          currentTime: clock.time,
          online: true,
          ...patch,
        },
        clock.now,
      );
      decisions.push(decision);
    }
    return decisions;
  };
  const seconds = (value) => Math.round((value * 1000) / TICK);
  return {
    monitor,
    clock,
    play: (sec) => run(seconds(sec), {}, { advance: true }),
    stall: (sec) => run(seconds(sec), { readyState: 2 }),
    run,
    seconds,
  };
}

const actions = (decisions) => decisions.map((item) => item.action).filter((action) => action !== "none");
const firstSwitch = (decisions) => decisions.find((item) => item.action === "switch");

test("normal playback never triggers anything", () => {
  const h = harness();
  assert.deepEqual(actions(h.play(120)), []);
});

test("startup: no metadata for 10s while paused switches line (autoplay blocked and source dead)", () => {
  const h = harness();
  const early = h.run(h.seconds(9), { paused: true, readyState: 0 });
  assert.deepEqual(actions(early), []);
  const late = h.run(h.seconds(2), { paused: true, readyState: 0 });
  assert.equal(firstSwitch(late)?.reason, "startup");
});

test("startup: a paused player with metadata loaded is not a failure", () => {
  const h = harness();
  assert.deepEqual(actions(h.run(h.seconds(60), { paused: true, readyState: 1 })), []);
});

test("startup: playing but never gets enough data for 10s switches line", () => {
  const h = harness();
  assert.deepEqual(actions(h.run(h.seconds(9), { readyState: 0 })), []);
  assert.equal(firstSwitch(h.run(h.seconds(2), { readyState: 0 }))?.reason, "startup");
});

test("startup clock restarts when data arrives, and pauses while offline", () => {
  const h = harness();
  h.run(h.seconds(8), { readyState: 0 });
  h.run(h.seconds(1), { readyState: 4 });
  assert.deepEqual(actions(h.run(h.seconds(8), { readyState: 0 })), [], "有数据后重新计时");

  const offline = harness();
  offline.run(offline.seconds(60), { readyState: 0, online: false });
  assert.deepEqual(actions(offline.run(offline.seconds(8), { readyState: 0 })), [], "断网不计入起播时间");
});

test("mid-play stall: hard stall triggers switch at 5s", () => {
  const h = harness();
  h.play(5);
  const stall = h.stall(6);
  assert.deepEqual(actions(stall), ["switch"]);
  assert.equal(firstSwitch(stall).reason, "hard");
  assert.equal(firstSwitch(stall).stalledMs >= 5000, true);
});

test("a stall shorter than 5s does not switch", () => {
  const h = harness();
  h.play(5);
  assert.deepEqual(actions(h.stall(4.5)), []);
  assert.deepEqual(actions(h.play(10)), []);
});

test("pausing or dragging the progress bar is not a stall", () => {
  const h = harness();
  h.play(5);
  assert.deepEqual(actions(h.run(h.seconds(20), { paused: true, readyState: 2 })), []);
  h.play(2);
  assert.deepEqual(actions(h.run(h.seconds(20), { seeking: true, readyState: 1 })), []);
});

test("buffering right after a seek gets a grace period", () => {
  const h = harness();
  h.play(5);
  h.run(1, { seeking: true, readyState: 1 });
  assert.deepEqual(actions(h.stall(2.5)), [], "宽限期内的缓冲不计卡顿");
});

test("a stall while offline is discarded", () => {
  const h = harness();
  h.play(5);
  assert.deepEqual(actions(h.run(h.seconds(30), { readyState: 2, online: false })), []);
  assert.deepEqual(actions(h.play(10)), []);
});

test("an ended video is not a stall", () => {
  const h = harness();
  h.play(5);
  assert.deepEqual(actions(h.run(h.seconds(20), { ended: true, readyState: 2 })), []);
});

test("reset returns to the startup phase for the new line", () => {
  const h = harness();
  h.play(5);
  h.monitor.reset(h.clock.now);
  assert.deepEqual(actions(h.run(h.seconds(9), { readyState: 0 })), []);
  assert.equal(firstSwitch(h.run(h.seconds(2), { readyState: 0 }))?.reason, "startup");
});

// 起播失败看的是“有没有数据进展”，不是“有没有起播”：慢但在下载的线路不该被误杀。
test("startup: a line that keeps downloading survives past the idle window up to the hard ceiling", () => {
  const h = harness();
  let loaded = 0;
  const decisions = [];
  for (let i = 0; i < h.seconds(30); i += 1) {
    decisions.push(...h.run(1, { readyState: 0, loaded: (loaded += 1) }));
  }
  const decision = firstSwitch(decisions);
  assert.equal(decision?.reason, "startup");
  assert.ok(decision.blockedMs >= STALL_DEFAULTS.startupMaxMs, "到了上限才判失败");
  assert.ok(decision.blockedMs < STALL_DEFAULTS.startupMaxMs + 2 * TICK);
  assert.equal(
    decisions.indexOf(decision) < h.seconds(STALL_DEFAULTS.startupTimeoutMs / 1000 + 5),
    false,
    "有进展时不会在 10 秒空闲窗口处被判失败",
  );
});

test("startup: downloading that stalls is judged by the idle window, not the ceiling", () => {
  const h = harness();
  let loaded = 0;
  for (let i = 0; i < h.seconds(5); i += 1) h.run(1, { readyState: 0, loaded: (loaded += 1) });
  assert.deepEqual(actions(h.run(h.seconds(9), { readyState: 0, loaded })), []);
  const decision = firstSwitch(h.run(h.seconds(2), { readyState: 0, loaded }));
  assert.equal(decision?.reason, "startup");
  assert.ok(decision.idleMs >= STALL_DEFAULTS.startupTimeoutMs);
});

test("startup: without a progress signal the idle window equals the blocked time", () => {
  const h = harness();
  assert.deepEqual(actions(h.run(h.seconds(9), { readyState: 0 })), []);
  const decision = firstSwitch(h.run(h.seconds(2), { readyState: 0 }));
  assert.equal(decision?.reason, "startup");
  assert.equal(decision.idleMs, decision.blockedMs);
});
