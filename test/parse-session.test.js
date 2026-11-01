import assert from "node:assert/strict";
import test from "node:test";
import { createSessionStore, formatSseEvent, parseCursor } from "../src/parse-session.js";

const PAGE = "https://v.example/page.html";

function store(overrides = {}) {
  const clock = { now: 1_000 };
  let counter = 0;
  const sessions = createSessionStore({
    ttlMs: 60_000,
    maxSessions: 3,
    now: () => clock.now,
    createId: () => `s${++counter}`,
    ...overrides,
  });
  return { sessions, clock };
}

test("a page shares one session until it expires", () => {
  const { sessions, clock } = store();
  const first = sessions.create(PAGE);
  assert.equal(sessions.get(PAGE), first);
  assert.equal(sessions.getById(first.id), first);
  clock.now += 59_999;
  assert.equal(sessions.get(PAGE), first);
  clock.now += 2;
  assert.equal(sessions.get(PAGE), null, "过期后不再共享");
  assert.equal(sessions.getById(first.id), null, "过期会话的快照也随之失效");
});

test("the oldest session is evicted when the store is full", () => {
  const { sessions } = store();
  const created = ["a", "b", "c", "d"].map((name) => sessions.create(`https://v.example/${name}`));
  assert.equal(sessions.size, 3);
  assert.equal(sessions.getById(created[0].id), null);
  assert.equal(sessions.getById(created[3].id), created[3]);
});

test("events are numbered, replayed after a cursor and delivered live", () => {
  const { sessions } = store();
  const session = sessions.create(PAGE);
  const seen = [];
  const unsubscribe = session.subscribe((event) => seen.push(event.id));
  session.emit("line", { id: 1 });
  session.emit("done", {});
  unsubscribe();
  session.emit("round", {});
  assert.deepEqual(seen, ["s1:1", "s1:2"], "取消订阅后不再收到");
  assert.deepEqual(session.replay().map((event) => event.seq), [1, 2, 3]);
  assert.deepEqual(session.replay(2).map((event) => event.type), ["round"]);
});

test("a failing listener cannot break delivery to the others", () => {
  const { sessions } = store();
  const session = sessions.create(PAGE);
  const seen = [];
  session.subscribe(() => { throw new Error("socket closed"); });
  session.subscribe((event) => seen.push(event.type));
  session.emit("line", {});
  assert.deepEqual(seen, ["line"]);
});

test("snapshots live and die with the session", () => {
  const { sessions } = store();
  const session = sessions.create(PAGE);
  assert.equal(session.nextLineId(), "L1");
  assert.equal(session.nextLineId(), "L2");
  session.setSnapshot("L1", "#EXTM3U\n");
  assert.equal(session.snapshot("L1"), "#EXTM3U\n");
  assert.equal(session.snapshot("L2"), null);
});

test("parseCursor accepts only well-formed event ids", () => {
  assert.deepEqual(parseCursor("abc123:42"), { sessionId: "abc123", seq: 42 });
  for (const bad of ["", "abc", "abc:", ":1", "a b:1", "abc:-1", "abc:1:2", null, undefined, 5]) {
    assert.equal(parseCursor(bad), null, String(bad));
  }
});

test("formatSseEvent writes an id only when there is one", () => {
  assert.equal(
    formatSseEvent({ id: "s1:2", type: "line", data: { a: 1 } }),
    'id: s1:2\nevent: line\ndata: {"a":1}\n\n',
  );
  assert.equal(formatSseEvent({ type: "end", data: {} }), "event: end\ndata: {}\n\n");
});
