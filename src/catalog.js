import { config } from "./config.js";
import { AppError } from "./errors.js";
import { fetchJson } from "./http.js";

const PAGE_SIZE = 200;

const SITE_LABELS = {
  qiyi: "爱奇艺",
  qq: "腾讯视频",
  youku: "优酷",
  imgo: "芒果TV",
  mgtv: "芒果TV",
  bilibili: "哔哩哔哩",
  bilibili1: "哔哩哔哩",
  m1905: "1905电影网",
  leshi: "乐视",
  sohu: "搜狐视频",
  pptv: "PPTV",
};

const SITE_RANK = ["qiyi", "qq", "youku", "imgo", "mgtv", "bilibili", "bilibili1"];

export function siteLabel(siteId) {
  return SITE_LABELS[siteId] || siteId;
}

export function sortSiteIds(siteIds) {
  return [...siteIds].sort((a, b) => {
    const rankA = SITE_RANK.indexOf(a);
    const rankB = SITE_RANK.indexOf(b);
    const left = rankA === -1 ? SITE_RANK.length : rankA;
    const right = rankB === -1 ? SITE_RANK.length : rankB;
    if (left !== right) return left - right;
    return String(a).localeCompare(String(b));
  });
}

export function acceptPageUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let value = raw.trim();
  if (value.startsWith("//")) value = `https:${value}`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (host === "360kan.com" || host.endsWith(".360kan.com")) return null;
  return parsed.toString();
}

function episodeName(item, index) {
  const period = typeof item?.period === "string" ? item.period.trim() : "";
  const name = typeof item?.name === "string" ? item.name.trim() : "";
  if (period && name) return `${period} ${name}`;
  const raw = item?.playlink_num ?? item?.sort ?? name;
  const text = raw === undefined || raw === null ? "" : String(raw).trim();
  if (/^\d+$/.test(text)) return `第${text}集`;
  if (text) return text;
  return `第${index + 1}集`;
}

export function episodesFromList(list) {
  if (!Array.isArray(list)) return [];
  const episodes = [];
  const seen = new Set();
  for (const item of list) {
    const pageUrl = acceptPageUrl(item?.url || item?.default_url || "");
    if (!pageUrl || seen.has(pageUrl)) continue;
    seen.add(pageUrl);
    episodes.push({ name: episodeName(item, episodes.length), pageUrl });
  }
  return episodes;
}

function siteIdsFromSearchRow(row) {
  const ids = new Set();
  if (row?.seriesSite) ids.add(String(row.seriesSite));
  if (row?.playlinks && typeof row.playlinks === "object") {
    for (const key of Object.keys(row.playlinks)) ids.add(String(key));
  }
  return sortSiteIds([...ids]);
}

export function mapSearchPayload(payload) {
  const rows = payload?.data?.longData?.rows;
  if (!Array.isArray(rows)) return [];
  const items = [];
  for (const row of rows) {
    const title = typeof row?.titleTxt === "string" ? row.titleTxt.trim() : "";
    if (!title || !row?.en_id || row?.cat_id === undefined || row?.cat_id === null) {
      continue;
    }
    const platforms = siteIdsFromSearchRow(row).map((id) => ({
      id,
      name: siteLabel(id),
    }));
    const remarks = [row.cat_name, row.year, platforms.map((item) => item.name).join(" / ")]
      .filter(Boolean)
      .join(" · ");
    items.push({
      id: String(row.en_id),
      cat: String(row.cat_id),
      title,
      cover: row.cover || "",
      year: row.year ? String(row.year) : "",
      remarks,
      desc: String(row.description || "")
        .replace(/<[^>]+>/g, "")
        .trim(),
      platforms,
    });
  }
  return items;
}

function catalogFailure(err) {
  if (err instanceof AppError && err.status < 500) throw err;
  throw new AppError("CATALOG_UPSTREAM_ERROR", 502, "影视目录暂时不可用", {
    cause: err,
  });
}

function detailSites(data) {
  if (Array.isArray(data?.playlink_sites) && data.playlink_sites.length) {
    return data.playlink_sites.map(String);
  }
  return [
    ...new Set([
      ...Object.keys(data?.allepidetail || {}),
      ...Object.keys(data?.playlinksdetail || {}),
      ...Object.keys(data?.allupinfo || {}),
    ]),
  ];
}

async function fetchDetail(cat, id, params, options) {
  const url = new URL(options.detailUrl);
  url.searchParams.set("cat", String(cat));
  url.searchParams.set("id", String(id));
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return options.fetchJsonFn(url.toString(), {
    timeoutMs: options.timeoutMs,
    accept: "application/json",
  });
}

async function episodesForSite(cat, id, site, data, options) {
  const total = Number(data?.allupinfo?.[site]);
  let list = Array.isArray(data?.allepidetail?.[site]) ? [...data.allepidetail[site]] : [];
  if (Number.isFinite(total) && total > list.length) {
    const merged = [];
    for (let start = 1; start <= total; start += PAGE_SIZE) {
      const end = Math.min(total, start + PAGE_SIZE - 1);
      const page = await fetchDetail(cat, id, { start, end, site }, options);
      const pageData = page?.data || {};
      const chunk = pageData?.allepidetail?.[site];
      if (Array.isArray(chunk) && chunk.length) {
        merged.push(...chunk);
      } else if (Array.isArray(pageData?.defaultepisode)) {
        merged.push(...pageData.defaultepisode);
      }
    }
    if (merged.length) list = merged;
  }
  if (!list.length && Array.isArray(data?.defaultepisode)) {
    list = data.defaultepisode;
  }
  const episodes = episodesFromList(list);
  if (episodes.length) return episodes;
  const pageUrl = acceptPageUrl(data?.playlinksdetail?.[site]?.default_url || "");
  return pageUrl ? [{ name: "正片", pageUrl }] : [];
}

export async function searchCatalog(keyword, options = {}) {
  const kw = typeof keyword === "string" ? keyword.trim() : "";
  if (!kw) {
    throw new AppError("INVALID_KEYWORD", 400, "搜索关键词不能为空");
  }
  const {
    searchUrl = config.catalogSearchUrl,
    timeoutMs = config.searchTimeoutMs,
    fetchJsonFn = fetchJson,
  } = options;
  const url = new URL(searchUrl);
  url.searchParams.set("force_v", "1");
  url.searchParams.set("kw", kw);
  url.searchParams.set("from", "");
  url.searchParams.set("pageno", "1");
  url.searchParams.set("v_ap", "1");
  url.searchParams.set("tab", "all");
  try {
    const payload = await fetchJsonFn(url.toString(), {
      timeoutMs,
      accept: "application/json",
    });
    return mapSearchPayload(payload);
  } catch (err) {
    catalogFailure(err);
  }
}

export async function loadCatalogTitle(cat, id, options = {}) {
  const catId = typeof cat === "string" ? cat.trim() : "";
  const titleId = typeof id === "string" ? id.trim() : "";
  if (!catId || !titleId) {
    throw new AppError("INVALID_TITLE", 400, "缺少剧目编号");
  }
  const {
    detailUrl = config.catalogDetailUrl,
    timeoutMs = config.searchTimeoutMs,
    fetchJsonFn = fetchJson,
  } = options;
  const requestOptions = { detailUrl, timeoutMs, fetchJsonFn };
  let payload;
  try {
    payload = await fetchDetail(catId, titleId, {}, requestOptions);
  } catch (err) {
    catalogFailure(err);
  }
  const data = payload?.data;
  if (!data || typeof data !== "object") {
    throw new AppError("CATALOG_UPSTREAM_ERROR", 502, "影视目录暂时不可用");
  }
  const platforms = [];
  try {
    for (const siteId of sortSiteIds(detailSites(data))) {
      const episodes = await episodesForSite(catId, titleId, siteId, data, requestOptions);
      if (!episodes.length) continue;
      platforms.push({ id: siteId, name: siteLabel(siteId), episodes });
    }
  } catch (err) {
    catalogFailure(err);
  }
  return {
    id: titleId,
    cat: catId,
    title: typeof data.title === "string" ? data.title.trim() : "",
    cover: data.cdncover || data.cover || "",
    desc: String(data.description || "")
      .replace(/<[^>]+>/g, "")
      .trim(),
    platforms,
  };
}
