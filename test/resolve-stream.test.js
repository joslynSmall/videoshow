import assert from "node:assert/strict";
import test from "node:test";
import { createSseParser, readResolveStream } from "../public/resolve-stream.js";

const encoder = new TextEncoder();

function sse(id, type, data) {
  return `${id ? `id: ${id}\n` : ""}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

// 用字符串片段构造一个流式响应；chunks 可以在任意位置切开事件。
function streamResponse(chunks, { status = 200 } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

test("the parser handles events split across chunks, CRLF and heartbeat comments", () => {
  const events = [];
  const parser = createSseParser((event) => events.push(event));
  parser.push(": ping\n\nretry: 2000\n\nid: s:1\nevent: li");
  parser.push('ne\ndata: {"a":1}\r\n\r\n');
  parser.push('event: done\ndata: {"b":\ndata: 2}\n\n');
  assert.deepEqual(events, [
    { id: "s:1", type: "line", data: { a: 1 } },
    { id: "", type: "done", data: { b: 2 } },
  ]);
});

test("the parser skips events whose data is not JSON", () => {
  const events = [];
  createSseParser((event) => events.push(event)).push("event: x\ndata: nope\n\nevent: y\ndata: {}\n\n");
  assert.deepEqual(events.map((event) => event.type), ["y"]);
});

test("a stream that ends with an end event is complete", async () => {
  const events = [];
  const urls = [];
  const outcome = await readResolveStream({
    url: "https://v.example/p.html",
    onEvent: (event) => events.push(event.type),
    fetchFn: async (url) => {
      urls.push(url);
      return streamResponse([sse("s:1", "session", {}), sse("s:2", "line", { id: "s.L1" }), "event: end\ndata: {}\n\n"]);
    },
  });
  assert.deepEqual(outcome, { ended: true });
  assert.deepEqual(events, ["session", "line"], "end 只是结束标记，不当作业务事件");
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0], "http://x").searchParams.get("url"), "https://v.example/p.html");
});

test("a dropped connection reconnects from the last event and handles each event once", async () => {
  const events = [];
  const urls = [];
  let call = 0;
  const outcome = await readResolveStream({
    url: "https://v.example/p.html",
    sleep: async () => {},
    onEvent: (event) => events.push(event.id),
    fetchFn: async (url) => {
      urls.push(new URL(url, "http://x").searchParams.get("after"));
      call += 1;
      if (call === 1) return streamResponse([sse("s:1", "session", {}), sse("s:2", "line", {})]); // 没有 end：中途断开
      // 服务端回放游标之后的事件；这里故意把已处理的 s:2 再发一遍。
      return streamResponse([sse("s:2", "line", {}), sse("s:3", "done", {}), "event: end\ndata: {}\n\n"]);
    },
  });
  assert.deepEqual(outcome, { ended: true });
  assert.deepEqual(events, ["s:1", "s:2", "s:3"]);
  assert.deepEqual(urls, [null, "s:2"], "重连带上最近一个事件编号");
});

// 回归：线路耗尽后的“追加一轮”请求带着游标（只想收到追加之后的事件），
// 曾因为“有游标就不发 refresh”而根本没有触发服务端追加。
test("a further round is requested on the first connection even when resuming from a cursor", async () => {
  const queries = [];
  let call = 0;
  await readResolveStream({
    url: "https://v.example/p.html",
    refresh: true,
    after: "s:5",
    sleep: async () => {},
    fetchFn: async (url) => {
      queries.push(new URL(url, "http://x").searchParams);
      call += 1;
      return call === 1
        ? streamResponse([sse("s:6", "round", {})])
        : streamResponse([sse("s:7", "done", {}), "event: end\ndata: {}\n\n"]);
    },
  });
  assert.equal(queries[0].get("refresh"), "1", "第一个请求要求追加一轮");
  assert.equal(queries[0].get("after"), "s:5", "同时只接收游标之后的事件");
  assert.equal(queries[1].get("refresh"), null, "中途断开后的重连只是接续，不再要求追加");
  assert.equal(queries[1].get("after"), "s:6");
});

test("refresh is sent when starting without a cursor", async () => {
  let seen = null;
  await readResolveStream({
    url: "https://v.example/p.html",
    refresh: true,
    fetchFn: async (url) => {
      seen = new URL(url, "http://x").searchParams;
      return streamResponse(["event: end\ndata: {}\n\n"]);
    },
  });
  assert.equal(seen.get("refresh"), "1");
});

test("giving up after too many consecutive reconnects", async () => {
  let calls = 0;
  await assert.rejects(
    readResolveStream({
      url: "https://v.example/p.html",
      maxReconnects: 2,
      sleep: async () => {},
      fetchFn: async () => {
        calls += 1;
        throw new TypeError("fetch failed");
      },
    }),
    /解析连接中断/,
  );
  assert.equal(calls, 3);
});

test("progress resets the reconnect budget", async () => {
  let call = 0;
  const outcome = await readResolveStream({
    url: "https://v.example/p.html",
    maxReconnects: 1,
    sleep: async () => {},
    fetchFn: async () => {
      call += 1;
      if (call <= 3) return streamResponse([sse(`s:${call}`, "line", {})]);
      return streamResponse(["event: end\ndata: {}\n\n"]);
    },
  });
  assert.deepEqual(outcome, { ended: true });
  assert.equal(call, 4);
});

test("an HTTP error is reported with the server's code and is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    readResolveStream({
      url: "ftp://nope",
      sleep: async () => {},
      fetchFn: async () => {
        calls += 1;
        return new Response(JSON.stringify({ ok: false, error: { code: "INVALID_URL", message: "无效地址" } }), { status: 400 });
      },
    }),
    (err) => err.status === 400 && err.code === "INVALID_URL" && err.message === "无效地址",
  );
  assert.equal(calls, 1);
});

test("aborting stops without an error", async () => {
  const controller = new AbortController();
  const outcome = await readResolveStream({
    url: "https://v.example/p.html",
    signal: controller.signal,
    fetchFn: async (_url, options) => {
      controller.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      assert.equal(options.signal, controller.signal);
      throw error;
    },
  });
  assert.deepEqual(outcome, { aborted: true });
});
