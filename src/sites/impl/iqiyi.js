import { defineSite, siteIdForPage } from "../contract.js";
import { httpsPage, plainText, uniqueItems } from "./shared.js";

function asHttps(raw) {
  return typeof raw === "string" && raw.startsWith("http://") ? `https://${raw.slice("http://".length)}` : raw;
}

function fieldText(value) {
  if (value && typeof value === "object") return plainText(value.value ?? value.name ?? "");
  return plainText(value);
}

function officialPage(raw) {
  let pageUrl = httpsPage(asHttps(raw));
  if (!pageUrl) return "";
  const url = new URL(pageUrl);
  if (url.pathname.endsWith("/redirect.html") || url.pathname.endsWith("/search_redirect.html")) {
    return officialPage(url.searchParams.get("url") || "");
  }
  return siteIdForPage(pageUrl) ? pageUrl : "";
}

function iqiyiEpisodes(videos) {
  if (!Array.isArray(videos)) return [];
  const episodes = [];
  const seen = new Set();
  for (const video of videos) {
    const pageUrl = officialPage(video?.pageUrl || video?.playUrl);
    if (!pageUrl || seen.has(pageUrl) || pageUrl.includes("immersiveShort")) continue;
    seen.add(pageUrl);
    const number = plainText(video?.number);
    const subtitle = plainText(video?.subtitle);
    const name = /^\d+$/.test(number)
      ? (subtitle ? `第${number}集 ${subtitle}` : `第${number}集`)
      : (subtitle || plainText(video?.title));
    if (!name) continue;
    episodes.push({ name, pageUrl });
  }
  return episodes;
}

export function mapIqiyiSearch(payload) {
  const templates = payload?.data?.templates;
  if (!Array.isArray(templates)) return [];
  const items = [];
  for (const template of templates) {
    const album = template?.albumInfo;
    const pageUrl = officialPage(album?.pageUrl);
    const title = plainText(album?.title);
    if (!pageUrl || !title) continue;
    if (album?.playMode === 1 || pageUrl.includes("immersiveShort")) continue;
    const channel = plainText(String(album?.channel || "").split(",")[0]);
    const year = fieldText(album?.year).match(/\d{4}/)?.[0] || "";
    const episodes = iqiyiEpisodes(album?.videos);
    items.push({
      title,
      pageUrl: episodes[0]?.pageUrl || pageUrl,
      siteId: siteIdForPage(pageUrl),
      cover: typeof album?.img === "string" ? album.img : "",
      remarks: [channel, year].filter(Boolean).join(" · "),
      desc: plainText(album?.introduction || album?.brief || ""),
      ...(episodes.length > 1 ? { episodes } : {}),
    });
  }
  return uniqueItems(items);
}

export function iqiyiTvId(pageUrl) {
  const slug = String(pageUrl || "").match(/\/[vwp]_([0-9a-z]+)\.html/i)?.[1];
  if (!slug) return "";
  const mask = (0x75706971676c).toString(2).split("").reverse();
  const bits = Number.parseInt(slug, 36).toString(2).split("").reverse();
  const mixed = [];
  for (let index = 0; index < Math.max(bits.length, mask.length); index += 1) {
    const left = bits[index] ? Number(bits[index]) : 0;
    const right = mask[index] ? Number(mask[index]) : 0;
    mixed.push(String(left ^ right));
  }
  let id = Number.parseInt(mixed.reverse().join(""), 2);
  if (!Number.isFinite(id)) return "";
  if (id < 900000) id = 100 * (id + 900000);
  return String(id);
}

export function mapIqiyiAvlist(payload) {
  const rows = payload?.data?.epsodelist;
  if (!Array.isArray(rows)) return [];
  const episodes = [];
  const seen = new Set();
  for (const row of rows) {
    const pageUrl = officialPage(row?.playUrl);
    if (!pageUrl || seen.has(pageUrl)) continue;
    seen.add(pageUrl);
    const order = plainText(row?.order);
    const subtitle = plainText(row?.subtitle);
    const name = /^\d+$/.test(order)
      ? (subtitle ? `第${order}集 ${subtitle}` : `第${order}集`)
      : (subtitle || plainText(row?.shortTitle || row?.name));
    if (!name) continue;
    episodes.push({ name, pageUrl });
  }
  return episodes;
}

export async function loadIqiyiEpisodes(pageUrl, options = {}) {
  const tvId = iqiyiTvId(pageUrl);
  if (!tvId) return [];
  const info = await options.fetchJsonFn(
    `https://pcw-api.iqiyi.com/video/video/playervideoinfo?tvid=${encodeURIComponent(tvId)}`,
    {
      timeoutMs: options.timeoutMs,
      accept: "application/json",
      headers: { referer: "https://www.iqiyi.com/" },
    },
  );
  const albumId = info?.data?.albumId;
  if (!albumId) return [];
  const list = await options.fetchJsonFn(
    `https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=${encodeURIComponent(albumId)}&page=1&size=200`,
    {
      timeoutMs: options.timeoutMs,
      accept: "application/json",
      headers: { referer: "https://www.iqiyi.com/" },
    },
  );
  return mapIqiyiAvlist(list);
}

export async function searchIqiyi(keyword, options = {}) {
  const url = new URL("https://mesh.if.iqiyi.com/portal/lw/search/homePageV3");
  url.searchParams.set("key", keyword);
  url.searchParams.set("pageNum", "1");
  url.searchParams.set("pageSize", "12");
  url.searchParams.set("mode", "1");
  const payload = await options.fetchJsonFn(url.toString(), {
    timeoutMs: options.timeoutMs,
    accept: "application/json",
    headers: { referer: "https://www.iqiyi.com/" },
  });
  return mapIqiyiSearch(payload);
}

export const iqiyi = defineSite("qiyi", {
  search: searchIqiyi,
  loadEpisodes: loadIqiyiEpisodes,
});
