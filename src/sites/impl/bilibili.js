import { defineSite } from "../contract.js";
import { httpsPage, plainText, uniqueItems } from "./shared.js";

export function mapBilibiliSearch(payload) {
  if (payload?.code !== 0) return [];
  const rows = payload?.data?.result;
  if (!Array.isArray(rows)) return [];
  return uniqueItems(
    rows.map((row) => ({
      title: plainText(row?.title),
      pageUrl: httpsPage(row?.url, "bilibili.com"),
      cover: typeof row?.cover === "string" ? row.cover : "",
      remarks: [plainText(row?.season_type_name), plainText(row?.styles)].filter(Boolean).join(" · "),
      desc: plainText(row?.desc || row?.evaluate),
    })),
  );
}

export function bilibiliSeasonQuery(pageUrl) {
  const season = String(pageUrl || "").match(/\/ss(\d+)/i)?.[1];
  if (season) return { season_id: season };
  const episode = String(pageUrl || "").match(/\/ep(\d+)/i)?.[1];
  if (episode) return { ep_id: episode };
  return null;
}

export function mapBilibiliSeason(payload) {
  const rows = payload?.result?.episodes;
  if (!Array.isArray(rows)) return [];
  const episodes = [];
  const seen = new Set();
  for (const row of rows) {
    const pageUrl = httpsPage(row?.share_url || row?.link, "bilibili.com");
    if (!pageUrl || seen.has(pageUrl)) continue;
    seen.add(pageUrl);
    const number = plainText(row?.title);
    const subtitle = plainText(row?.long_title);
    const name = /^\d+$/.test(number)
      ? (subtitle ? `第${number}集 ${subtitle}` : `第${number}集`)
      : (subtitle || number);
    if (!name) continue;
    episodes.push({ name, pageUrl });
  }
  return episodes;
}

export async function loadBilibiliEpisodes(pageUrl, options = {}) {
  const query = bilibiliSeasonQuery(pageUrl);
  if (!query) return [];
  const url = new URL("https://api.bilibili.com/pgc/view/web/season");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const payload = await options.fetchJsonFn(url.toString(), {
    timeoutMs: options.timeoutMs,
    accept: "application/json",
    headers: { referer: "https://www.bilibili.com/" },
  });
  return mapBilibiliSeason(payload);
}

export async function searchBilibili(keyword, options = {}) {
  const url = new URL("https://api.bilibili.com/x/web-interface/search/type");
  url.searchParams.set("search_type", "media_bangumi");
  url.searchParams.set("keyword", keyword);
  const payload = await options.fetchJsonFn(url.toString(), {
    timeoutMs: options.timeoutMs,
    accept: "application/json",
    headers: { referer: "https://search.bilibili.com/" },
  });
  return mapBilibiliSearch(payload);
}

export const bilibili = defineSite("bilibili", {
  search: searchBilibili,
  loadEpisodes: loadBilibiliEpisodes,
});
