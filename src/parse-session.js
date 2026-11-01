import { randomUUID } from "node:crypto";

// 解析会话：同一个视频页面的一次共享解析。线路陆续产出，每个事件按序号追加到会话里；
// 观众接入时先回放已有事件，再接收新事件。会话和清单快照只放在进程内存里。

export function formatSseEvent({ id, type, data }) {
  const lines = [];
  if (id) lines.push(`id: ${id}`);
  lines.push(`event: ${type}`, `data: ${JSON.stringify(data ?? {})}`);
  return `${lines.join("\n")}\n\n`;
}

// 事件编号形如 "<会话编号>:<序号>"。
export function parseCursor(value) {
  if (typeof value !== "string") return null;
  const match = /^([A-Za-z0-9]{1,32}):(\d{1,9})$/.exec(value.trim());
  return match ? { sessionId: match[1], seq: Number(match[2]) } : null;
}

class ParseSession {
  constructor({ id, sourceUrl, createdAt, expiresAt }) {
    this.id = id;
    this.sourceUrl = sourceUrl;
    this.createdAt = createdAt;
    this.expiresAt = expiresAt;
    this.events = [];
    this.listeners = new Set();
    this.snapshots = new Map();
    // 会话级去重：同一内容的线路只产出一次，后续解析轮次也一样。
    this.seenUrls = new Set();
    this.seenKeys = new Set();
    this.lineCount = 0;
    this.rounds = 0;
    this.running = false;
    this.lastRoundAt = 0;
    this.metaRequested = false;
    this.metaPromise = null;
  }

  emit(type, data) {
    const seq = this.events.length + 1;
    const event = { seq, id: `${this.id}:${seq}`, type, data };
    this.events.push(event);
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // 单个观众写入失败不能影响其他观众。
      }
    }
    return event;
  }

  replay(afterSeq = 0) {
    return this.events.slice(Math.max(0, afterSeq));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  nextLineId() {
    this.lineCount += 1;
    return `L${this.lineCount}`;
  }

  setSnapshot(lineId, text) {
    this.snapshots.set(lineId, text);
  }

  snapshot(lineId) {
    return this.snapshots.get(lineId) ?? null;
  }
}

export function createSessionStore({
  ttlMs,
  maxSessions = 200,
  now = Date.now,
  createId = () => randomUUID().replaceAll("-", "").slice(0, 12),
} = {}) {
  const bySource = new Map();
  const byId = new Map();

  function drop(session) {
    if (bySource.get(session.sourceUrl) === session) bySource.delete(session.sourceUrl);
    byId.delete(session.id);
  }

  function live(session) {
    if (!session) return null;
    if (session.expiresAt <= now()) {
      drop(session);
      return null;
    }
    return session;
  }

  return {
    get: (sourceUrl) => live(bySource.get(sourceUrl)),
    getById: (id) => live(byId.get(id)),
    create(sourceUrl) {
      for (const session of [...byId.values()]) live(session);
      while (maxSessions > 0 && byId.size >= maxSessions) {
        const oldest = byId.values().next().value;
        if (!oldest) break;
        drop(oldest);
      }
      const createdAt = now();
      const session = new ParseSession({
        id: createId(),
        sourceUrl,
        createdAt,
        expiresAt: createdAt + ttlMs,
      });
      const previous = bySource.get(sourceUrl);
      if (previous) drop(previous);
      bySource.set(sourceUrl, session);
      byId.set(session.id, session);
      return session;
    },
    get size() {
      return byId.size;
    },
  };
}
