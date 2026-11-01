import { createHash } from "node:crypto";

// 播放列表文本的纯函数处理，不碰网络。清单快照和线路去重都建立在它之上。

const URI_ATTRIBUTE = /URI="([^"]*)"/gi;

function absolute(uri, baseUrl) {
  try {
    return new URL(uri.trim(), baseUrl).toString();
  } catch {
    return uri;
  }
}

function isUriLine(line) {
  const tag = line.trim();
  return Boolean(tag) && !tag.startsWith("#");
}

// 把播放列表里的相对地址（分片行，以及 KEY / MAP 等标签里的 URI 属性）改写成绝对地址。
// 快照由本站提供，相对地址会被浏览器解析到本站，必须在存入前改写。
export function absolutizePlaylist(text, baseUrl) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      if (line.trim().startsWith("#")) {
        return line.replace(URI_ATTRIBUTE, (_match, uri) => `URI="${absolute(uri, baseUrl)}"`);
      }
      return absolute(line, baseUrl);
    })
    .join(eol);
}

export function segmentUrls(text, baseUrl) {
  return text
    .split(/\r?\n/)
    .filter(isUriLine)
    .map((line) => absolute(line, baseUrl));
}

// 分片所在的域名，按出现次数从多到少排列。
export function segmentHosts(text, baseUrl, limit = 3) {
  const counts = new Map();
  for (const url of segmentUrls(text, baseUrl)) {
    try {
      const host = new URL(url).host;
      counts.set(host, (counts.get(host) || 0) + 1);
    } catch {
      // 无法解析的地址不计入。
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([host]) => host);
}

// 内容指纹：播放列表所在域名 + 分片列表（忽略查询串里的令牌）。
// 同一域名上分片列表完全相同的两条线路，前一条失败后，后一条几乎必然同样失败，只保留先到的。
// 分片相同但播放列表域名不同的线路不算重复：域名不通时，换一个域名读同样的分片正是有效的恢复手段。
// 没有分片行（例如只有头部的清单）时返回 null，调用方应退回按地址去重。
export function lineKey(playlistHost, text, baseUrl) {
  const urls = segmentUrls(text, baseUrl);
  if (!urls.length) return null;
  const stable = urls.map((url) => {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return url;
    }
  });
  return createHash("sha1")
    .update(`${playlistHost}\n${stable.join("\n")}`)
    .digest("hex")
    .slice(0, 16);
}
