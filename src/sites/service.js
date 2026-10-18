import { AppError } from "../errors.js";
import { config } from "../config.js";
import { fetchJson } from "../http.js";
import { siteIdForPage } from "./contract.js";

function requestContext(options) {
  return {
    fetchJsonFn: options.fetchJsonFn || fetchJson,
    fetchTextFn: options.fetchTextFn,
    renderPage: options.renderPage,
    timeoutMs: options.timeoutMs || config.searchTimeoutMs,
  };
}

export async function searchSites(adapters, keyword, options = {}) {
  const kw = typeof keyword === "string" ? keyword.trim() : "";
  if (!kw) throw new AppError("INVALID_KEYWORD", 400, "搜索关键词不能为空");
  const ctx = requestContext(options);
  const buckets = new Map(adapters.map((adapter) => [adapter.id, []]));
  const seen = new Set();
  const push = (siteId, item) => {
    if (!siteId || !buckets.has(siteId) || !item?.pageUrl || seen.has(`${siteId}:${item.pageUrl}`)) return;
    seen.add(`${siteId}:${item.pageUrl}`);
    buckets.get(siteId).push(item);
  };

  await Promise.all(
    adapters.map(async (adapter) => {
      try {
        const items = await adapter.search(kw, ctx);
        for (const item of items || []) {
          push(siteIdForPage(item.pageUrl) || adapter.id, item);
        }
      } catch {
        // 单个网站失败时留下其他网站的结果。
      }
    }),
  );

  return adapters
    .map((adapter) => {
      const items = buckets.get(adapter.id) || [];
      return items.length ? { id: adapter.id, name: adapter.name, items } : null;
    })
    .filter(Boolean);
}

export async function loadPageEpisodes(adapters, pageUrl, options = {}) {
  const siteId = siteIdForPage(pageUrl);
  const adapter = adapters.find((item) => item.id === siteId);
  if (!adapter) return [];
  try {
    const episodes = await adapter.loadEpisodes(pageUrl, requestContext(options));
    return Array.isArray(episodes) ? episodes : [];
  } catch {
    return [];
  }
}
