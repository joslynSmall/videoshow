import { fetchText } from "../../http.js";
import { defineSite } from "../contract.js";
import { httpsPage, plainText, uniqueItems } from "./shared.js";

function findShowUrl(node) {
  if (!node || typeof node !== "object") return "";
  const values = Array.isArray(node) ? node : Object.values(node);
  for (const value of values) {
    if (typeof value === "string") {
      const pageUrl = httpsPage(value, "youku.com");
      if (pageUrl && pageUrl.includes("/v_show/")) return pageUrl;
      continue;
    }
    const nested = findShowUrl(value);
    if (nested) return nested;
  }
  return "";
}

export function mapYoukuSearch(payload) {
  const items = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (!Array.isArray(node) && typeof node.tempTitle === "string") {
      const pageUrl = findShowUrl(node.action) || findShowUrl(node);
      const title = plainText(node.tempTitle);
      if (pageUrl && title && node.sourceName !== "腾讯") {
        items.push({
          title,
          pageUrl,
          cover: httpsPage(node.thumbUrl, "ykimg.com"),
          remarks: plainText(node.feature),
          desc: plainText(node.desc),
        });
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(payload);
  return uniqueItems(items);
}

export function youkuShowId(html) {
  return String(html || "").match(/showId"\s*:\s*"([0-9a-f]{8,})"/i)?.[1] || "";
}

export function mapYoukuEpisodes(payload) {
  const rows = payload?.videos;
  if (!Array.isArray(rows)) return [];
  const episodes = [];
  const seen = new Set();
  for (const row of rows) {
    const pageUrl = httpsPage(row?.link, "youku.com");
    if (!pageUrl || seen.has(pageUrl)) continue;
    seen.add(pageUrl);
    const seq = plainText(row?.seq || row?.stage);
    const title = plainText(row?.title);
    const name = /^\d+$/.test(seq) ? (title ? `第${seq}集 ${title}` : `第${seq}集`) : title;
    if (!name) continue;
    episodes.push({ name, pageUrl });
  }
  return episodes;
}

export async function loadYoukuEpisodes(pageUrl, options = {}) {
  if (!httpsPage(pageUrl, "youku.com")) return [];
  const fetchTextFn = options.fetchTextFn || fetchText;
  const html = await fetchTextFn(pageUrl, {
    timeoutMs: options.timeoutMs,
    accept: "text/html",
    headers: { referer: "https://www.youku.com/" },
  });
  const showId = youkuShowId(html);
  if (!showId) return [];
  const episodes = [];
  const seen = new Set();
  for (let page = 1; page <= 8; page += 1) {
    const payload = await options.fetchJsonFn(
      `https://openapi.youku.com/v2/shows/videos.json?client_id=53e6cc67237fc59a&show_id=${encodeURIComponent(showId)}&page=${page}&count=20`,
      {
        timeoutMs: options.timeoutMs,
        accept: "application/json",
        headers: { referer: "https://www.youku.com/" },
      },
    );
    const batch = mapYoukuEpisodes(payload);
    for (const episode of batch) {
      if (seen.has(episode.pageUrl)) continue;
      seen.add(episode.pageUrl);
      episodes.push(episode);
    }
    const total = Number(payload?.total);
    if (!batch.length || (Number.isFinite(total) && episodes.length >= total)) break;
  }
  return episodes;
}

export async function searchYouku(keyword, options = {}) {
  const url = new URL("https://search.youku.com/api/search");
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("pg", "1");
  url.searchParams.set("pz", "8");
  const payload = await options.fetchJsonFn(url.toString(), {
    timeoutMs: options.timeoutMs,
    accept: "application/json",
    headers: { referer: "https://www.youku.com/" },
  });
  return mapYoukuSearch(payload);
}

export const youku = defineSite("youku", {
  search: searchYouku,
  loadEpisodes: loadYoukuEpisodes,
});
