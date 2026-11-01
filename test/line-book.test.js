import assert from "node:assert/strict";
import test from "node:test";
import { classifyFailure, createLineBook, STRIKE_LIMIT } from "../public/line-book.js";

let counter = 0;
function line(overrides = {}) {
  counter += 1;
  return {
    id: `L${counter}`,
    provider: "p",
    type: "m3u8",
    playUrl: `https://play${counter}.example/index.m3u8`,
    host: `play${counter}.example`,
    segmentHost: `seg${counter}.example`,
    snapshot: false,
    verified: true,
    score: 100,
    ttfbMs: 100,
    ...overrides,
  };
}

test("a line is accepted once and ignored when replayed", () => {
  const book = createLineBook();
  const a = line();
  assert.equal(book.add(a), true);
  assert.equal(book.add({ ...a }), false);
  assert.equal(book.add({ id: "x" }), false, "没有播放地址的不收");
  assert.equal(book.size, 1);
});

test("the first line to arrive is the first one offered", () => {
  const book = createLineBook();
  const a = line();
  book.add(a);
  assert.equal(book.next(), a);
});

test("among usable lines, verified and higher-scoring ones come first, then arrival order", () => {
  const book = createLineBook();
  const slow = line({ score: 50 });
  const unverified = line({ verified: false, score: 900 });
  const fast = line({ score: 300 });
  const tie = line({ score: 300 });
  [slow, unverified, fast, tie].forEach((item) => book.add(item));
  const order = [];
  for (let next = book.next(); next; next = book.next()) {
    order.push(next);
    book.fail(next, { kind: "stall" });
  }
  assert.deepEqual(order, [fast, tie, slow, unverified]);
});

test("a manifest that answers 404 only excludes that one line", () => {
  const book = createLineBook();
  const a = line({ host: "shared.example" });
  const b = line({ host: "shared.example" });
  book.add(a);
  book.add(b);
  assert.deepEqual(book.fail(a, { kind: "manifest", status: 404 }), []);
  assert.equal(book.strikes("shared.example"), 0);
  assert.equal(book.next(), b, "同域名的另一条线路不受牵连");
});

test("a manifest host that cannot be reached is excluded after two network failures, not one timeout", () => {
  const timeout = classifyFailure(line(), { kind: "manifest", status: 0, timeout: true });
  assert.equal(timeout.strikes[0].weight, 1);
  const network = classifyFailure(line(), { kind: "manifest", status: 0 });
  assert.equal(network.strikes[0].weight, STRIKE_LIMIT);

  const book = createLineBook();
  const a = line({ host: "dead.example" });
  const sibling = line({ host: "dead.example" });
  const other = line({ host: "alive.example" });
  [a, sibling, other].forEach((item) => book.add(item));
  book.fail(a, { kind: "manifest", status: 0 });
  assert.equal(book.next(), other, "共用域名的线路一起排除");
  book.fail(other, { kind: "stall" });
  assert.equal(book.next(), null);
});

test("gateway errors from our relay count as the host being unreachable", () => {
  for (const status of [502, 503, 504]) {
    assert.equal(classifyFailure(line(), { kind: "manifest", status }).strikes.length, 1, String(status));
  }
  for (const status of [400, 403, 404, 410, 500]) {
    assert.equal(classifyFailure(line(), { kind: "manifest", status }).strikes.length, 0, String(status));
  }
});

test("a snapshot is served by us, so its original host is never blamed for a manifest failure", () => {
  const snapshot = line({ snapshot: true, host: "png.example" });
  assert.deepEqual(classifyFailure(snapshot, { kind: "manifest", status: 0 }).strikes, []);
});

test("a segment host that cannot be reached excludes every line that depends on it", () => {
  const book = createLineBook();
  const a = line({ segmentHost: "cdn.example" });
  const b = line({ segmentHost: "cdn.example", snapshot: true });
  const c = line({ segmentHost: "other.example" });
  [a, b, c].forEach((item) => book.add(item));
  const charged = book.fail(a, { kind: "fragment", status: 0, host: "cdn.example" });
  assert.deepEqual(charged, [{ host: "cdn.example", weight: STRIKE_LIMIT }]);
  assert.equal(book.next(), c);
});

test("a segment that answers an HTTP error only excludes its own line", () => {
  assert.deepEqual(classifyFailure(line(), { kind: "fragment", status: 403, host: "cdn.example" }).strikes, []);
});

test("a startup failure with the playlist already loaded only casts weak suspicion on the segment host", () => {
  const book = createLineBook();
  const a = line({ segmentHost: "cdn.example", score: 500 });
  const b = line({ segmentHost: "cdn.example", score: 400 });
  const c = line({ segmentHost: "other.example", score: 100 });
  [a, b, c].forEach((item) => book.add(item));
  book.fail(a, { kind: "startup", manifestLoaded: true });
  assert.equal(book.strikes("cdn.example"), 1);
  assert.equal(book.next(), c, "失败过一次的域名排在其他域名之后，但没有被排除");
  book.fail(c, { kind: "stall" });
  assert.equal(book.next(), b, "没有别的选择时仍可退回重试");
  book.fail(b, { kind: "startup", manifestLoaded: true });
  assert.equal(book.next(), null, "第二次失败后该域名被排除");
});

test("a startup failure before the playlist loaded blames no host", () => {
  assert.deepEqual(classifyFailure(line(), { kind: "startup", manifestLoaded: false }).strikes, []);
});

test("expired lines are skipped", () => {
  let nowMs = 1_000;
  const book = createLineBook({ now: () => nowMs });
  const expiring = line({ expiresAtMs: 2_000 });
  const durable = line();
  book.add(expiring);
  book.add(durable);
  assert.equal(book.next(), expiring);
  nowMs = 2_001;
  assert.equal(book.next(), durable);
});

test("hasUsable reflects the remaining lines", () => {
  const book = createLineBook();
  assert.equal(book.hasUsable(), false);
  const a = line();
  book.add(a);
  assert.equal(book.hasUsable(), true);
  book.fail(a, { kind: "media" });
  assert.equal(book.hasUsable(), false);
  assert.equal(book.isFailed(a), true);
});
