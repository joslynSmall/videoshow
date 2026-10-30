import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createChannelHealth, createDayKey } from "../src/channels/health.js";

// 固定用 UTC 时区，避免测试结果随运行机器的时区变化。
const at = (day, hour = 12) => Date.UTC(2026, 9, day, hour);

function clockHealth(options = {}) {
  const clock = { now: at(1) };
  const health = createChannelHealth({ now: () => clock.now, timeZone: "UTC", ...options });
  const day = (n, hour) => { clock.now = at(n, hour); };
  const record = (id, ok, times = 1) => { for (let i = 0; i < times; i += 1) health.record(id, ok); };
  return { health, clock, day, record };
}

test("createDayKey follows the requested time zone for natural days", () => {
  const instant = Date.UTC(2026, 9, 30, 20, 0);
  assert.equal(createDayKey("UTC")(instant), "2026-10-30");
  assert.equal(createDayKey("Asia/Shanghai")(instant), "2026-10-31", "北京时间已经过了零点");
  assert.equal(createDayKey("America/Los_Angeles")(instant), "2026-10-30");
});

test("a channel is removed after three unavailable natural days, not before", () => {
  const { health, day, record } = clockHealth();
  for (const n of [1, 2]) {
    day(n);
    record("lx", false, 3);
    record("good", true, 3);
  }
  day(3, 9);
  record("lx", false);
  assert.equal(health.isRemoved("lx"), false, "只有 2 个已结束的不可用日，当天不下结论");
  assert.deepEqual(health.status("lx").unavailableDays, ["2026-10-01", "2026-10-02"]);

  day(3);
  record("lx", false, 2);
  record("good", true, 3);
  assert.equal(health.isRemoved("lx"), false, "第 3 天还没结束");

  // 跨天后的第一次记账就会结算：lx 已有 3 个结束的不可用日，good 每天都成功过。
  day(4);
  record("good", true);
  assert.equal(health.isRemoved("lx"), true);
  assert.equal(health.isRemoved("good"), false);
  assert.equal(health.status("lx").removed.reason, "累计 3 个自然日不可用");
  assert.deepEqual(health.evaluate(), [], "已摘除的不会重复上报");
});

test("unavailable days accumulate without needing to be consecutive", () => {
  const { health, day, record } = clockHealth();
  for (const [n, lxOk] of [[1, false], [2, true], [3, false], [4, true], [5, false]]) {
    day(n);
    record("lx", lxOk, 3);
    record("good", true, 3);
  }
  day(6);
  record("good", true);
  health.evaluate();
  assert.equal(health.isRemoved("lx"), true, "第 1、3、5 天不可用，累计 3 天");
  assert.deepEqual(health.status("lx").removed.unavailableDays, ["2026-10-01", "2026-10-03", "2026-10-05"]);
});

test("a day with at least one success is a usable day", () => {
  const { health, day, record } = clockHealth();
  for (const n of [1, 2, 3, 4]) {
    day(n);
    record("flaky", false, 9);
    record("flaky", true, 1);
    record("good", true, 3);
  }
  day(5);
  record("good", true);
  health.evaluate();
  assert.equal(health.isRemoved("flaky"), false);
  assert.deepEqual(health.status("flaky").unavailableDays, []);
});

test("days with too few attempts are not judged", () => {
  const { health, day, record } = clockHealth({ minAttempts: 3 });
  for (const n of [1, 2, 3]) {
    day(n);
    record("rare", false, 2);
    record("good", true, 3);
  }
  day(4);
  record("good", true);
  health.evaluate();
  assert.equal(health.isRemoved("rare"), false, "每天只试了 2 次，样本太少");
});

test("a day when every channel failed is an outage, not the channel's fault", () => {
  const { health, day, record } = clockHealth();
  for (const n of [1, 2, 3]) {
    day(n);
    record("lx", false, 4);
    record("qilin", false, 4);
    record("jx-browser", false, 4);
  }
  day(4);
  record("lx", false);
  health.evaluate();
  assert.equal(health.isRemoved("lx"), false);
  assert.equal(health.isRemoved("qilin"), false);
  assert.deepEqual(health.status("lx").unavailableDays, [], "整体故障的日子不计入");
});

test("the removal threshold is configurable", () => {
  const { health, day, record } = clockHealth({ deadDays: 1 });
  day(1);
  record("lx", false, 3);
  record("good", true, 3);
  day(2);
  record("good", true);
  health.evaluate();
  assert.equal(health.isRemoved("lx"), true);
});

test("a removed channel stops collecting statistics", () => {
  const { health, day, record } = clockHealth({ deadDays: 1 });
  day(1);
  record("lx", false, 3);
  record("good", true, 3);
  day(2);
  record("good", true);
  health.evaluate();
  assert.equal(health.isRemoved("lx"), true);
  record("lx", true, 5);
  assert.equal(health.status("lx").today.attempts, 0);
});

test("history older than the retention window is dropped", () => {
  const { health, day, record } = clockHealth({ keepDays: 5 });
  day(1);
  record("lx", false, 3);
  record("good", true, 3);
  day(20);
  record("lx", true);
  assert.deepEqual(health.status("lx").unavailableDays, []);
});

test("a removed channel is revived by a new endpoint or a higher revision, not by the same config", () => {
  const { health, day, record } = clockHealth({ deadDays: 1 });
  health.setEndpoint("lx", "https://old.example/?url=");
  day(1);
  record("lx", false, 3);
  record("good", true, 3);
  day(2);
  record("good", true);
  health.evaluate();
  assert.equal(health.status("lx").removed.endpoint, "https://old.example/?url=");

  assert.equal(health.revive("lx", { endpoint: "https://old.example/?url=", revision: 0 }), false);
  assert.equal(health.isRemoved("lx"), true);
  assert.equal(health.revive("lx", { endpoint: "https://new.example/?url=" }), true);
  assert.equal(health.isRemoved("lx"), false);
  assert.deepEqual(health.status("lx").unavailableDays, [], "复活后重新累计");

  // 没有地址概念的渠道只能靠 revision 复活。
  day(2);
  record("jx-browser", false, 3);
  day(3);
  record("good", true);
  health.evaluate();
  assert.equal(health.isRemoved("jx-browser"), true);
  assert.equal(health.revive("jx-browser", { revision: 0 }), false);
  assert.equal(health.revive("jx-browser", { revision: 1 }), true);
  assert.equal(health.revive("jx-browser", { revision: 1 }), false, "同一个 revision 不会重复复活");
});

test("state survives a restart and a corrupt file starts clean", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-health-"));
  const file = path.join(dir, "nested", "state.json");
  try {
    const first = clockHealth({ file, deadDays: 1 });
    first.health.setEndpoint("lx", "https://old.example/?url=");
    first.day(1);
    first.record("lx", false, 3);
    first.record("good", true, 3);
    first.day(2);
    first.record("good", true);
    first.health.evaluate();
    first.health.flush();
    assert.ok(fs.existsSync(file));
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"], "临时文件不能残留");

    const second = clockHealth({ file, deadDays: 1 });
    assert.equal(second.health.isRemoved("lx"), true, "重启后摘除状态仍在");
    assert.equal(second.health.status("lx").removed.endpoint, "https://old.example/?url=");

    fs.writeFileSync(file, "{ not json");
    const third = clockHealth({ file });
    assert.deepEqual(third.health.ids(), []);
    fs.writeFileSync(file, JSON.stringify({ channels: { lx: { days: { bad: { attempts: "x" } } }, x: 1 } }));
    assert.deepEqual(clockHealth({ file }).health.status("lx").unavailableDays, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unwritable state location degrades to memory without throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-health-"));
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x");
  const warnings = [];
  try {
    const { health, record } = clockHealth({
      file: path.join(blocker, "state.json"),
      logger: { info() {}, warn: (event) => warnings.push(event) },
    });
    record("lx", true);
    assert.doesNotThrow(() => health.flush());
    assert.doesNotThrow(() => health.flush());
    assert.deepEqual(warnings, ["channel.state_save_failed"], "只告警一次");
    assert.equal(health.status("lx").today.attempts, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
