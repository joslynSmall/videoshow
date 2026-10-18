import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fetchText } from "../../http.js";
import { defineSite } from "../contract.js";
import { httpsPage, plainText, uniqueItems } from "./shared.js";

function pageFrom(row) {
  const candidates = [row?.url, row?.jumpUrl, row?.playUrl, row?.videoUrl];
  for (const candidate of candidates) {
    const pageUrl = httpsPage(candidate, "mgtv.com");
    if (pageUrl) return pageUrl;
  }
  const videoId = row?.videoId || row?.partId || row?.playPartId;
  if (videoId) return `https://www.mgtv.com/b/${videoId}.html`;
  return "";
}

export function mapMgtvSearch(payload) {
  if (payload?.data?.forbidden === 1) return [];
  const groups = [payload?.data?.listItems, payload?.data?.contents, payload?.data?.hitDocs];
  const items = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const row of group) {
      const title = plainText(row?.title || row?.name);
      const pageUrl = pageFrom(row);
      if (!title || !pageUrl) continue;
      items.push({
        title,
        pageUrl,
        cover: typeof row?.img === "string" ? row.img : "",
        remarks: plainText(row?.updateInfo || row?.rightCorner?.text || ""),
        desc: plainText(row?.desc || row?.story),
      });
    }
  }
  return uniqueItems(items);
}

function decodeHtml(value) {
  return plainText(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function mapMgtvPage(html) {
  const text = String(html || "");
  const items = [];
  const seen = new Set();
  for (const block of text.split("m-search-serial").slice(1)) {
    const href = block.match(/href="(\/\/www\.mgtv\.com\/b\/(\d+)\/\d+\.html)/);
    if (!href || seen.has(href[2])) continue;
    const titles = [...block.matchAll(/title="([^"]+)"/g)]
      .map((match) => decodeHtml(match[1]))
      .filter(Boolean);
    const title = titles[0];
    const pageUrl = httpsPage(`https:${href[1]}`, "mgtv.com");
    if (!title || !pageUrl) continue;
    seen.add(href[2]);
    const cover = block.match(/<img[^>]+src="(https:[^"]+)"/)?.[1] || "";
    const year = block.match(/class="year">(\d{4})</)?.[1] || "";
    const kind = plainText(block.match(/class="hover-item"[^>]*>\s*([^<]+)</)?.[1] || "");
    items.push({
      title,
      pageUrl: pageUrl.split("?")[0],
      cover,
      remarks: [kind, year].filter(Boolean).join(" · "),
      desc: "",
    });
  }
  return uniqueItems(items);
}

function chromeBin() {
  const bin = process.env.CHROME_BIN || "/usr/bin/google-chrome";
  return fs.existsSync(bin) ? bin : "";
}

export function renderMgtvSearchPage(url, timeoutMs = 12000) {
  const bin = chromeBin();
  if (!bin) return Promise.resolve("");
  return new Promise((resolve) => {
    const child = spawn(
      bin,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--virtual-time-budget=8000",
        `--timeout=${Math.max(8000, timeoutMs)}`,
        "--dump-dom",
        url,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const chunks = [];
    let settled = false;
    const finish = (html) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(html);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(Buffer.concat(chunks).toString("utf8"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => finish(""));
    child.on("close", () => finish(Buffer.concat(chunks).toString("utf8")));
  });
}

async function searchMgtvPage(keyword, options) {
  const url = `https://so.mgtv.com/so?k=${encodeURIComponent(keyword)}`;
  const fetchTextFn = options.fetchTextFn || fetchText;
  try {
    const html = await fetchTextFn(url, {
      timeoutMs: options.timeoutMs,
      accept: "text/html",
      headers: { referer: "https://www.mgtv.com/" },
    });
    const items = mapMgtvPage(html);
    if (items.length) return items;
  } catch {
    // 静态页没有结果时再渲染页面。
  }
  const renderPage = options.renderPage || renderMgtvSearchPage;
  try {
    return mapMgtvPage(await renderPage(url, Math.max(options.timeoutMs || 0, 15000)));
  } catch {
    return [];
  }
}

export function mgtvVideoId(pageUrl) {
  return String(pageUrl || "").match(/\/b\/\d+\/(\d+)\.html/i)?.[1] || "";
}

function mgtvEpisodeName(row) {
  const index = plainText(row?.t1);
  const label = plainText(row?.t4);
  if (/^\d+$/.test(index)) return `第${index}集`;
  if (index) return index;
  return label;
}

export function mapMgtvEpisodes(payload) {
  const rows = payload?.data?.list;
  if (!Array.isArray(rows)) return [];
  const episodes = [];
  const seen = new Set();
  for (const row of rows) {
    const raw = typeof row?.url === "string" ? row.url : "";
    const absolute = raw.startsWith("/") ? `https://www.mgtv.com${raw}` : raw;
    const pageUrl = httpsPage(absolute, "mgtv.com").split("?")[0];
    if (!pageUrl || seen.has(pageUrl)) continue;
    seen.add(pageUrl);
    const name = mgtvEpisodeName(row);
    if (!name) continue;
    episodes.push({ name, pageUrl });
  }
  return episodes;
}

export async function loadMgtvEpisodes(pageUrl, options = {}) {
  const videoId = mgtvVideoId(pageUrl);
  if (!videoId) return [];
  const episodes = [];
  const seen = new Set();
  for (let page = 1; page <= 8; page += 1) {
    const payload = await options.fetchJsonFn(
      `https://pcweb.api.mgtv.com/episode/list?video_id=${encodeURIComponent(videoId)}&page=${page}&size=30`,
      {
        timeoutMs: options.timeoutMs,
        accept: "application/json",
        headers: { referer: "https://www.mgtv.com/" },
      },
    );
    const batch = mapMgtvEpisodes(payload);
    for (const episode of batch) {
      if (seen.has(episode.pageUrl)) continue;
      seen.add(episode.pageUrl);
      episodes.push(episode);
    }
    const totalPage = Number(payload?.data?.total_page) || 1;
    if (!batch.length || page >= totalPage) break;
  }
  return episodes;
}

export async function searchMgtv(keyword, options = {}) {
  const deviceId = "cf03b959-6945-4cb6-bcb3-88762459354d";
  const timestamp = String(Date.now());
  const seqId = createHash("md5").update(`${deviceId}.${timestamp}`).digest("hex");
  const url = new URL("https://mobileso.bz.mgtv.com/aphone/search/rebirth/v2");
  url.searchParams.set("q", keyword);
  url.searchParams.set("pn", "1");
  url.searchParams.set("pc", "10");
  url.searchParams.set("seqId", seqId);
  url.searchParams.set("deviceId", deviceId);
  url.searchParams.set("timestamp", timestamp);
  url.searchParams.set("allowedRC", "1");
  try {
    const payload = await options.fetchJsonFn(url.toString(), {
      timeoutMs: options.timeoutMs,
      accept: "application/json",
      headers: { referer: "https://www.mgtv.com/" },
    });
    const items = mapMgtvSearch(payload);
    if (items.length) return items;
  } catch {
    // 接口不可用时改抓搜索页。
  }
  return searchMgtvPage(keyword, options);
}

export const mgtv = defineSite("mgtv", {
  search: searchMgtv,
  loadEpisodes: loadMgtvEpisodes,
});
