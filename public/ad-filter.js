// 拼接广告过滤：聚合解析站会把广告分片夹在两个 #EXT-X-DISCONTINUITY 之间，
// 分片来自和正片不同的域名。这里只做播放列表文本的纯函数处理，不碰任何网络。
// 判定刻意保守：宁可漏掉广告，也不能切掉正片。

export const AD_FILTER_DEFAULTS = Object.freeze({
  // 单个广告块的最长时长（秒）。更长的外域块更可能是正片的另一段，不动它。
  maxBlockSeconds: 120,
  // 最多移除的广告块数；超过说明列表形态不像“插广告”，整份不动。
  maxBlocks: 5,
  // 移除的总时长占整片的上限；超过同样整份不动。
  maxShare: 0.1,
  // 占时长最多的域名族至少要占多少，才认为它是正片。
  minDominantShare: 0.5,
});

const DISCONTINUITY = "#EXT-X-DISCONTINUITY";
const UNSAFE_TAG = /^#EXT-X-(KEY|MAP|BYTERANGE)\b/i;
const SECOND_LEVEL = /\.(com|net|org|gov|edu|co|ac)\.[a-z]{2}$/i;

// 域名族：同一站点的不同子域（omts.tc.qq.com / apd.tc.qq.com）算同一族，
// 避免把正片自己的多 CDN 节点误判成广告。
export function hostFamily(host) {
  const parts = String(host || "").toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(SECOND_LEVEL.test(parts.join(".")) ? -3 : -2).join(".");
}

function familyOf(uri, baseUrl) {
  try {
    return hostFamily(new URL(uri, baseUrl).hostname);
  } catch {
    return "";
  }
}

function parsePlaylist(lines) {
  const header = [];
  const segments = [];
  const tail = [];
  let started = false;
  let pending = [];
  let discontinuity = false;
  let duration = 0;
  for (const line of lines) {
    const tag = line.trim();
    if (!tag) continue;
    if (!started) {
      if (tag.startsWith("#EXTINF:") || tag === DISCONTINUITY) started = true;
      else {
        header.push(line);
        continue;
      }
    }
    if (tag === DISCONTINUITY) {
      discontinuity = true;
    } else if (tag === "#EXT-X-ENDLIST") {
      tail.push(line);
    } else if (tag.startsWith("#")) {
      if (tag.startsWith("#EXTINF:")) duration = Number.parseFloat(tag.slice(8)) || 0;
      pending.push(line);
    } else {
      segments.push({
        lines: [...pending, line],
        uri: tag,
        discontinuity,
        duration,
        unsafe: pending.some((entry) => UNSAFE_TAG.test(entry.trim())),
      });
      pending = [];
      discontinuity = false;
      duration = 0;
    }
  }
  tail.unshift(...pending);
  return { header, segments, tail };
}

function splitBlocks(segments, baseUrl) {
  const blocks = [];
  for (const [index, segment] of segments.entries()) {
    if (index === 0 || segment.discontinuity) blocks.push({ segments: [], seconds: 0, start: 0 });
    const block = blocks[blocks.length - 1];
    segment.family = familyOf(segment.uri, baseUrl);
    block.segments.push(segment);
    block.seconds += segment.duration;
  }
  let elapsed = 0;
  for (const block of blocks) {
    block.start = elapsed;
    elapsed += block.seconds;
    const byFamily = new Map();
    for (const segment of block.segments) {
      byFamily.set(segment.family, (byFamily.get(segment.family) || 0) + segment.duration);
    }
    block.family = [...byFamily].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    block.unsafe = block.segments.some((segment) => segment.unsafe);
  }
  return blocks;
}

// 返回 { text, removed }。没有可移除的广告时，text 与入参完全相同（同一个字符串）。
// removed: [{ family, seconds, segments, at }]，at 是该块在原列表里的起始秒数。
export function stripAdBlocks(text, baseUrl, overrides = {}) {
  const options = { ...AD_FILTER_DEFAULTS, ...overrides };
  const unchanged = { text, removed: [] };
  if (typeof text !== "string" || !text.startsWith("#EXTM3U")) return unchanged;
  // 主列表、直播/滑动窗口列表都不处理：只有完整点播列表才有稳定的“正片/广告”划分。
  if (/#EXT-X-STREAM-INF/.test(text) || !/#EXT-X-ENDLIST/.test(text) || !/#EXTINF:/.test(text)) {
    return unchanged;
  }

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const { header, segments, tail } = parsePlaylist(text.split(/\r?\n/));
  if (!segments.length) return unchanged;

  const blocks = splitBlocks(segments, baseUrl);
  if (blocks.length < 2) return unchanged;

  const total = blocks.reduce((sum, block) => sum + block.seconds, 0);
  const byFamily = new Map();
  for (const block of blocks) {
    for (const segment of block.segments) {
      byFamily.set(segment.family, (byFamily.get(segment.family) || 0) + segment.duration);
    }
  }
  const [dominant, dominantSeconds] = [...byFamily].sort((a, b) => b[1] - a[1])[0];
  if (!dominant || total <= 0 || dominantSeconds / total < options.minDominantShare) return unchanged;

  const ads = blocks.filter(
    (block) =>
      block.family !== dominant &&
      block.seconds <= options.maxBlockSeconds &&
      !block.unsafe,
  );
  if (!ads.length) return unchanged;
  const adSeconds = ads.reduce((sum, block) => sum + block.seconds, 0);
  if (ads.length > options.maxBlocks || adSeconds > total * options.maxShare) return unchanged;

  const drop = new Set(ads.flatMap((block) => block.segments));
  const out = [...header];
  let kept = 0;
  for (const segment of segments) {
    if (drop.has(segment)) continue;
    // 保留广告之后正片开头的 DISCONTINUITY；整份列表的第一个分片前不需要。
    if (segment.discontinuity && kept > 0) out.push(DISCONTINUITY);
    out.push(...segment.lines);
    kept += 1;
  }
  out.push(...tail);

  return {
    text: out.join(eol) + eol,
    removed: ads.map((block) => ({
      family: block.family,
      seconds: Number(block.seconds.toFixed(2)),
      segments: block.segments.length,
      at: Number(block.start.toFixed(2)),
    })),
  };
}
