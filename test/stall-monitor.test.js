import assert from "node:assert/strict";
import test from "node:test";
import { createStallMonitor, STALL_DEFAULTS } from "../public/stall-monitor.js";

const TICK = STALL_DEFAULTS.tickMs;

// 模拟时钟 + 播放器：play 表示正常推进，stall 表示缓冲耗尽（时间不动、readyState=2）。
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

test("mid-play stall: soft recovery at 3s, switch only at 5s", () => {
  const h = harness();
  h.play(5);
  const stall = h.stall(6);
  // 真实代码在 switch 后会停掉采样，这里只看第一次 switch 之前的序列。
  const sequence = actions(stall).slice(0, 2);
  assert.deepEqual(sequence, ["recover", "switch"]);
  assert.equal(stall.find((item) => item.action === "recover").stalledMs >= 3000, true);
  assert.equal(firstSwitch(stall).reason, "hard");
  assert.equal(firstSwitch(stall).stalledMs >= 5000, true);
});

test("a stall shorter than 3s does nothing", () => {
  const h = harness();
  h.play(5);
  assert.deepEqual(actions(h.stall(2.5)), []);
  assert.deepEqual(actions(h.play(10)), []);
});

test("chronic: three 1.5s stalls within a minute switch line", () => {
  const h = harness();
  h.play(5);
  const decisions = [];
  for (let i = 0; i < 3; i += 1) {
    decisions.push(...h.stall(1.5), ...h.play(15));
  }
  const decision = firstSwitch(decisions);
  assert.equal(decision?.reason, "chronic");
  assert.equal(decision.count >= 3, true, "间隔够长时按次数规则触发");
});

test("chronic: two long-ish stalls that eat 15% of the window switch line", () => {
  const h = harness();
  h.play(5);
  const decisions = [...h.stall(2.5), ...h.play(6), ...h.stall(2.5), ...h.play(8)];
  const decision = firstSwitch(decisions);
  assert.equal(decision?.reason, "chronic");
  assert.equal(decision.stalledMs / decision.observedMs >= 0.15, true);
});

test("chronic: a single stall never triggers the ratio rule", () => {
  const h = harness();
  h.play(5);
  assert.deepEqual(actions([...h.stall(2.5), ...h.play(10)]), []);
});

test("chronic stalls older than the window are forgotten", () => {
  const h = harness();
  h.play(5);
  h.stall(1.5);
  h.play(30);
  h.stall(1.5);
  h.play(35);
  assert.deepEqual(actions(h.stall(1.5)), [], "前两次已滑出 60 秒窗口，只剩一次");
});

test("cooldown after a switch blocks chronic switching but not hard stalls or startup failure", () => {
  const h = harness();
  h.play(5);
  h.monitor.reset(h.clock.now, { switched: true });
  h.play(5);
  const chronic = [];
  for (let i = 0; i < 3; i += 1) chronic.push(...h.stall(1.5), ...h.play(3));
  assert.deepEqual(actions(chronic), [], "冷却内不因慢性卡顿换线");
  assert.equal(firstSwitch(h.stall(6))?.reason, "hard", "硬卡死不受冷却限制");

  const dead = harness();
  dead.monitor.reset(dead.clock.now, { switched: true });
  assert.equal(firstSwitch(dead.run(dead.seconds(11), { readyState: 0 }))?.reason, "startup");
});

test("chronic switching works again after the cooldown", () => {
  const h = harness();
  h.monitor.reset(h.clock.now, { switched: true });
  h.play(35);
  const decisions = [];
  for (let i = 0; i < 3; i += 1) decisions.push(...h.stall(1.5), ...h.play(4));
  assert.equal(firstSwitch(decisions)?.reason, "chronic");
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
  h.monitor.reset(h.clock.now, { switched: true });
  assert.deepEqual(actions(h.run(h.seconds(9), { readyState: 0 })), []);
  assert.equal(firstSwitch(h.run(h.seconds(2), { readyState: 0 }))?.reason, "startup");
});
