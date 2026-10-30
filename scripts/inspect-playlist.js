// 分析 HLS 播放列表的结构，用来判断广告是怎么插进来的。
// 用法：
//   node scripts/inspect-playlist.js <视频页或 m3u8 地址> [--at 460] [--out playlist.m3u8]
//   node scripts/inspect-playlist.js --file playlist.m3u8 [--at 460]
// 视频页地址会先走 jx-browser 解析；m3u8 地址则直接请求（和服务端取播放列表的方式一致）。
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveWithBrowser } from "../src/providers/jx-browser.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function parseArgs(argv) {
  const args = { at: 460, input: "", file: "", out: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--at") args.at = Number(argv[++i]);
    else if (argv[i] === "--file") args.file = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (!args.input) args.input = argv[i];
  }
  return args;
}

async function fetchPlaylist(url) {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, redirect: "follow" });
  const text = await res.text();
  if (!text.trimStart().startsWith("#EXTM3U")) {
    throw new Error(`不是 m3u8：HTTP ${res.status} 最终地址 ${new URL(res.url).host}，开头：${text.slice(0, 80).replace(/\s+/g, " ")}`);
  }
  return { text, finalUrl: res.url };
}

// 把 URL 归一成“形状”：数字换成 #，去掉查询串，用来发现某一段分片的命名规律是否突变。
export function segmentShape(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const dir = u.pathname.replace(/[^/]*$/, "").replace(/\d+/g, "#").replace(/[0-9a-f]{16,}/gi, "H");
    const file = u.pathname.split("/").pop().replace(/[0-9a-f]{16,}/gi, "H").replace(/\d+/g, "#");
    return `${u.host}${dir}${file}`;
  } catch {
    return rawUrl.replace(/\d+/g, "#");
  }
}

export function parseMediaPlaylist(text, baseUrl = "http://x/") {
  const segments = [];
  let pending = { duration: 0, discontinuity: false, tags: [] };
  let elapsed = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      pending.duration = Number.parseFloat(line.slice(8)) || 0;
    } else if (line === "#EXT-X-DISCONTINUITY") {
      pending.discontinuity = true;
    } else if (/^#EXT-X-(CUE|DATERANGE|SCTE35|SPLICEPOINT|ASSET|AD|PROGRAM-DATE-TIME|KEY|MAP|BYTERANGE)/i.test(line)) {
      pending.tags.push(line.length > 120 ? `${line.slice(0, 120)}…` : line);
    } else if (!line.startsWith("#")) {
      let url = line;
      try { url = new URL(line, baseUrl).href; } catch {}
      segments.push({ index: segments.length, start: elapsed, ...pending, url, shape: segmentShape(url) });
      elapsed += pending.duration;
      pending = { duration: 0, discontinuity: false, tags: [] };
    }
  }
  return { segments, total: elapsed };
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function describe(segments, total, at) {
  const lines = [];
  lines.push(`分片 ${segments.length} 个，总时长 ${fmt(total)}`);

  const discs = segments.filter((s) => s.discontinuity);
  lines.push(`\n#EXT-X-DISCONTINUITY：${discs.length} 处`);
  for (const s of discs) lines.push(`  第 ${s.index} 片，位于 ${fmt(s.start)}`);

  const tagged = segments.filter((s) => s.tags.length);
  const tagKinds = new Map();
  for (const s of tagged) for (const t of s.tags) {
    const k = t.split(/[:,]/)[0];
    tagKinds.set(k, (tagKinds.get(k) || 0) + 1);
  }
  lines.push(`\n其他标记：${tagKinds.size ? [...tagKinds].map(([k, n]) => `${k}×${n}`).join("，") : "无"}`);
  for (const s of tagged.filter((t) => !/^#EXT-X-(KEY|MAP|PROGRAM-DATE-TIME)/i.test(t.tags[0])).slice(0, 12)) {
    lines.push(`  ${fmt(s.start)} 第 ${s.index} 片：${s.tags.join(" | ")}`);
  }

  lines.push("\n分片地址的“形状”分段（形状变化的位置最可疑）：");
  let runStart = 0;
  for (let i = 1; i <= segments.length; i += 1) {
    if (i === segments.length || segments[i].shape !== segments[runStart].shape) {
      const run = segments.slice(runStart, i);
      const dur = run.reduce((a, s) => a + s.duration, 0);
      lines.push(`  ${fmt(run[0].start)}–${fmt(run[0].start + dur)}  ${run.length} 片  ${segments[runStart].shape}`);
      runStart = i;
    }
  }

  const durations = new Map();
  for (const s of segments) {
    const k = s.duration.toFixed(1);
    durations.set(k, (durations.get(k) || 0) + 1);
  }
  const common = [...durations].sort((a, b) => b[1] - a[1]).slice(0, 5);
  lines.push(`\n分片时长分布（时长×数量）：${common.map(([d, n]) => `${d}s×${n}`).join("，")}`);

  const center = segments.findIndex((s) => s.start + s.duration > at);
  if (center >= 0) {
    lines.push(`\n${fmt(at)} 前后的分片：`);
    for (const s of segments.slice(Math.max(0, center - 6), center + 7)) {
      lines.push(`  #${s.index} ${fmt(s.start)} ${s.duration.toFixed(2)}s${s.discontinuity ? " [DISCONTINUITY]" : ""} ${s.url.replace(/(auth_key|sign|token)=[^&]*/gi, "$1=***").slice(0, 150)}`);
    }
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let text = "";
  let baseUrl = "http://x/";
  if (args.file) {
    text = fs.readFileSync(args.file, "utf8");
  } else if (args.input) {
    let target = args.input;
    if (!/\.m3u8(\?|$)/i.test(target)) {
      console.log("解析视频页…");
      target = (await resolveWithBrowser(target, 60000)).playUrl;
    }
    const first = await fetchPlaylist(target);
    text = first.text;
    baseUrl = first.finalUrl;
    // 主列表：选带宽最高的一路继续取。
    if (/#EXT-X-STREAM-INF/.test(text)) {
      const lines = text.split(/\r?\n/);
      let best = { bw: -1, url: "" };
      lines.forEach((l, i) => {
        if (!l.startsWith("#EXT-X-STREAM-INF")) return;
        const bw = Number(/BANDWIDTH=(\d+)/.exec(l)?.[1] || 0);
        const next = lines.slice(i + 1).find((x) => x.trim() && !x.startsWith("#"));
        if (next && bw > best.bw) best = { bw, url: new URL(next.trim(), baseUrl).href };
      });
      console.log(`主列表，选用带宽 ${best.bw} 的一路`);
      const media = await fetchPlaylist(best.url);
      text = media.text;
      baseUrl = media.finalUrl;
    }
  } else {
    console.error("用法：node scripts/inspect-playlist.js <视频页或 m3u8 地址> [--at 秒] [--out 文件] | --file 文件");
    process.exit(2);
  }
  if (args.out) fs.writeFileSync(args.out, text);
  const { segments, total } = parseMediaPlaylist(text, baseUrl);
  console.log(describe(segments, total, args.at));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("失败：", err?.message || err);
    process.exit(1);
  });
}
