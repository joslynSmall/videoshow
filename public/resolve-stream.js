// 解析事件流客户端：读取 /api/resolve 的 SSE，连接中途断开时带着游标自动重连并回放。
// 不依赖 DOM，fetch 可注入，由 test/resolve-stream.test.js 覆盖。

// 增量解析 SSE 文本。事件之间以空行分隔；以 ":" 开头的行是心跳注释，直接忽略。
export function createSseParser(onEvent) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      buffer = buffer.replace(/\r\n/g, "\n");
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let id = "";
        let type = "message";
        const data = [];
        for (const line of block.split("\n")) {
          if (!line || line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "id") id = value;
          else if (field === "event") type = value;
          else if (field === "data") data.push(value);
        }
        if (!data.length) continue;
        let payload;
        try {
          payload = JSON.parse(data.join("\n"));
        } catch {
          continue;
        }
        onEvent({ id, type, data: payload });
      }
    },
  };
}

function httpError(status, body) {
  const error = new Error(body?.error?.message || `解析失败（HTTP ${status}）`);
  error.status = status;
  error.code = body?.error?.code || "";
  return error;
}

// 读完一次解析。服务端发出 end 事件才算正常结束；其间断开就用最近一个事件编号重连，
// 服务端回放漏掉的事件，所以每个事件都按编号只处理一次。
// 正常结束返回 { ended: true }；被 signal 中止返回 { aborted: true }；重连次数用尽或服务端报错则抛出。
export async function readResolveStream({
  url,
  refresh = false,
  after = "",
  onEvent,
  signal,
  fetchFn = (...args) => fetch(...args),
  maxReconnects = 3,
  retryDelayMs = 500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let cursor = after;
  let attempt = 0;
  let firstRequest = true;
  const handled = new Set();
  while (true) {
    if (signal?.aborted) return { aborted: true };
    const query = new URLSearchParams({ url });
    // 追加一轮只在这次调用的第一个请求里要求：之后的重连只是接续同一轮，再带上会让服务端重复追加。
    // 追加请求本身通常也带着游标（只想收到追加之后的事件），所以不能用“有没有游标”来判断。
    if (refresh && firstRequest) query.set("refresh", "1");
    if (cursor) query.set("after", cursor);
    firstRequest = false;
    let ended = false;
    try {
      const response = await fetchFn(`/api/resolve?${query}`, {
        headers: { accept: "text/event-stream" },
        signal,
      });
      if (!response.ok) {
        let body = null;
        try {
          body = await response.json();
        } catch {
          // 响应不是 JSON 时只报状态码。
        }
        throw httpError(response.status, body);
      }
      const parser = createSseParser((event) => {
        if (event.type === "end") {
          ended = true;
          return;
        }
        if (event.id) {
          if (handled.has(event.id)) return;
          handled.add(event.id);
          cursor = event.id;
        }
        attempt = 0;
        onEvent?.(event);
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
    } catch (err) {
      if (signal?.aborted || err?.name === "AbortError") return { aborted: true };
      if (err?.status) throw err;
      // 网络错误：落到下面的重连逻辑。
    }
    if (ended) return { ended: true };
    if (signal?.aborted) return { aborted: true };
    attempt += 1;
    if (attempt > maxReconnects) throw new Error("解析连接中断，请稍后重试。");
    await sleep(retryDelayMs * attempt);
  }
}
