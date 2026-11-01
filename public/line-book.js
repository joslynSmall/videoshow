// 线路簿：客户端手上的线路清单，以及换线时“下一条用谁”的全部规则。
// 纯数据结构，不碰 DOM、网络和计时器，由 test/line-book.test.js 覆盖。
//
// 失败只按证据的范围记账：
//   * 清单返回 HTTP 错误（404/403/5xx）、起播超时、卡顿 —— 只说明这一条线路不行，只排除这条线路；
//   * 分片所在域名连不上（网络错误、超时）—— 是域名的问题，同一个域名上的线路都会受影响，按域名累计；
//   * 清单所在域名连不上 —— 同理，但快照线路的清单由本站提供，不记它的原始域名。
// 多个渠道常共用同一个 CDN，域名累计到 STRIKE_LIMIT 就不再尝试，避免在同一个已失效的域名上反复等待。

export const STRIKE_LIMIT = 2;

// 把一次失败整理成要记的账。evidence:
//   { kind: "manifest" | "fragment" | "startup" | "stall" | "media", status?, timeout?, host?, manifestLoaded? }
// 返回 { strikes: [{ host, weight }] }；strikes 为空表示只排除这条线路。
export function classifyFailure(line, evidence = {}) {
  const strikes = [];
  const { kind, status = 0, timeout = false } = evidence;
  // 经本站中转时，上游连不上会表现为 502/503/504，与浏览器直连时的网络错误同属“域名不通”；
  // 其他 4xx/5xx 是对方明确回了内容问题（链接过期、没有权限），只关系到这一条线路。
  const httpError = Number.isFinite(status) && status >= 400 && ![502, 503, 504].includes(status);
  if (kind === "manifest") {
    // 快照由本站提供，清单失败说明快照本身有问题，与原始域名无关。
    if (!httpError && !line.snapshot && line.host) {
      strikes.push({ host: line.host, weight: timeout ? 1 : 2 });
    }
  } else if (kind === "fragment") {
    const host = evidence.host || line.segmentHost;
    if (!httpError && host) strikes.push({ host, weight: timeout ? 1 : 2 });
  } else if (kind === "startup" && evidence.manifestLoaded && line.segmentHost) {
    // 清单已经读到却始终没有数据：分片域名有嫌疑，但证据不足，只记一次。
    strikes.push({ host: line.segmentHost, weight: 1 });
  }
  return { strikes };
}

export function createLineBook({ now = () => Date.now() } = {}) {
  const lines = [];
  const failed = new Set();
  const strikes = new Map();

  const strikeCount = (host) => (host ? strikes.get(host) || 0 : 0);

  function blockedByHost(line) {
    if (strikeCount(line.segmentHost) >= STRIKE_LIMIT) return true;
    return !line.snapshot && strikeCount(line.host) >= STRIKE_LIMIT;
  }

  function usable(line) {
    if (failed.has(line.id)) return false;
    if (Number.isFinite(line.expiresAtMs) && line.expiresAtMs <= now()) return false;
    return !blockedByHost(line);
  }

  // 失败过一次的域名排在其他域名之后；同档内已校验的优先，再按测速得分和首包时间。
  function rank(line, order) {
    const tier = strikeCount(line.segmentHost) > 0 || (!line.snapshot && strikeCount(line.host) > 0) ? 1 : 0;
    const ttfb = Number.isFinite(line.ttfbMs) ? line.ttfbMs : Infinity;
    return [tier, line.verified === false ? 1 : 0, -(line.score || 0), ttfb, order];
  }

  function compare(a, b) {
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  }

  return {
    // 同一个编号的线路只收一次（重连回放会重复投递）。
    add(line) {
      if (!line?.id || !line.playUrl || lines.some((item) => item.id === line.id)) return false;
      lines.push(line);
      return true;
    },
    get lines() {
      return [...lines];
    },
    get size() {
      return lines.length;
    },
    strikes(host) {
      return strikeCount(host);
    },
    // 记一次失败。返回这次实际累计的域名失败（供日志使用）。
    fail(line, evidence) {
      if (!line) return [];
      failed.add(line.id);
      const { strikes: charged } = classifyFailure(line, evidence);
      for (const { host, weight } of charged) strikes.set(host, strikeCount(host) + weight);
      return charged;
    },
    isFailed(line) {
      return failed.has(line.id);
    },
    // 下一条可用线路；没有则返回 null。
    next() {
      const candidates = lines
        .map((line, order) => ({ line, order }))
        .filter(({ line }) => usable(line));
      candidates.sort((a, b) => compare(rank(a.line, a.order), rank(b.line, b.order)));
      return candidates[0]?.line ?? null;
    },
    hasUsable() {
      return lines.some(usable);
    },
  };
}
