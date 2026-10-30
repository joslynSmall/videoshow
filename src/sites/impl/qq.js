import { defineSite } from "../contract.js";
import { httpsPage, plainText, uniqueItems } from "./shared.js";

function coverPage(raw) {
  const pageUrl = httpsPage(raw, "v.qq.com");
  if (!pageUrl) return "";
  const path = new URL(pageUrl).pathname;
  if (!path.startsWith("/x/cover/")) return "";
  return pageUrl;
}

export function mapQqSearch(payload) {
  const list = payload?.data?.normalList?.itemList;
  if (!Array.isArray(list)) return [];
  const items = [];
  for (const entry of list) {
    const info = entry?.videoInfo;
    const title = plainText(info?.title);
    if (!title) continue;
    const sites = Array.isArray(info?.playSites) ? info.playSites : [];
    const episodes = [];
    const seen = new Set();
    for (const site of sites) {
      const rows = Array.isArray(site?.episodeInfoList) ? site.episodeInfoList : [];
      for (const episode of rows) {
        const episodePage = coverPage(episode?.url);
        if (!episodePage || seen.has(episodePage)) continue;
        seen.add(episodePage);
        episodes.push({
          name: plainText(episode?.title) || `第${episodes.length + 1}集`,
          pageUrl: episodePage,
        });
      }
      if (episodes.length) break;
    }
    const pageUrl = episodes[0]?.pageUrl || "";
    if (!pageUrl) continue;
    items.push({
      title,
      pageUrl,
      ...(episodes.length > 1 ? { episodes } : {}),
      cover: "",
      remarks: [plainText(info?.typeName), info?.year ? String(info.year) : ""]
        .filter((part) => part && part !== "0")
        .join(" · "),
      desc: plainText(info?.descrip),
    });
  }
  return uniqueItems(items);
}

export function qqCoverId(pageUrl) {
  return String(pageUrl || "").match(/\/x\/cover\/([0-9a-z]+)/i)?.[1] || "";
}

const QQ_PAGE_DATA_URL =
  "https://pbaccess.video.qq.com/trpc.universal_backend_service.page_server_rpc.PageServer/GetPageData?video_appid=3000010&vplatform=2&vversion_name=8.2.96";
const QQ_MAX_TABS = 20;

function qqEpisodeModule(payload) {
  const groups = payload?.data?.module_list_datas;
  if (!Array.isArray(groups)) return null;
  for (const group of groups) {
    for (const module of Array.isArray(group?.module_datas) ? group.module_datas : []) {
      if (module?.module_params?.desk_module_type === "episode_list") return module;
    }
  }
  return null;
}

export function qqEpisodeRows(payload) {
  const items = qqEpisodeModule(payload)?.item_data_lists?.item_datas;
  if (!Array.isArray(items)) return [];
  return items.map((item) => item?.item_params).filter(Boolean);
}

export function qqEpisodeTabs(payload) {
  try {
    const tabs = JSON.parse(qqEpisodeModule(payload)?.module_params?.tabs || "[]");
    return Array.isArray(tabs) ? tabs.filter((tab) => !tab?.selected && tab?.page_context) : [];
  } catch {
    return [];
  }
}

// 只有标题为纯数字的才是正片；预告、彩蛋、番外、海报的标题都是文字。
export function mapQqEpisodes(cid, rows) {
  if (!cid || !Array.isArray(rows)) return [];
  const episodes = [];
  const seen = new Set();
  for (const row of rows) {
    const number = plainText(row?.title);
    const vid = plainText(row?.vid);
    if (!/^\d+$/.test(number) || !vid) continue;
    const pageUrl = coverPage(`https://v.qq.com/x/cover/${cid}/${vid}.html`);
    if (!pageUrl || seen.has(pageUrl)) continue;
    seen.add(pageUrl);
    episodes.push({ name: `第${number}集`, pageUrl });
  }
  return episodes;
}

function fetchQqEpisodePage(cid, options, params = {}) {
  return options.fetchJsonFn(QQ_PAGE_DATA_URL, {
    method: "POST",
    timeoutMs: options.timeoutMs,
    accept: "application/json",
    headers: {
      "content-type": "application/json",
      origin: "https://v.qq.com",
      referer: "https://v.qq.com/",
    },
    body: JSON.stringify({
      page_params: {
        req_from: "web_vsite",
        page_id: "vsite_episode_list",
        page_type: "detail_operation",
        id_type: "1",
        page_size: "100",
        cid,
        vid: "",
        lid: "0",
        page_num: "0",
        page_context: `cid=${cid}&detail_page_type=1&req_from=web_vsite&req_from_second_type=&req_type=0`,
        detail_page_type: "1",
        ...params,
      },
      has_cache: 1,
    }),
  });
}

export async function loadQqEpisodes(pageUrl, options = {}) {
  const cid = qqCoverId(pageUrl);
  if (!cid) return [];
  const first = await fetchQqEpisodePage(cid, options);
  const rest = await Promise.all(
    qqEpisodeTabs(first)
      .slice(0, QQ_MAX_TABS)
      .map((tab) =>
        fetchQqEpisodePage(cid, options, { page_context: tab.page_context, page_num: "1", page_size: "30" }),
      ),
  );
  return mapQqEpisodes(cid, [first, ...rest].flatMap(qqEpisodeRows));
}

export async function searchQq(keyword, options = {}) {
  const payload = await options.fetchJsonFn(
    "https://pbaccess.video.qq.com/trpc.videosearch.mobile_search.MultiTerminalSearch/MbSearch?vversion_platform=2",
    {
      method: "POST",
      timeoutMs: options.timeoutMs,
      accept: "application/json",
      headers: {
        "content-type": "application/json",
        origin: "https://v.qq.com",
        referer: "https://v.qq.com/",
      },
      body: JSON.stringify({
        version: "26022601",
        clientType: 1,
        filterValue: "",
        uuid: "videoshow",
        retry: 0,
        pagenum: 0,
        pagesize: 12,
        queryFrom: 0,
        query: keyword,
        isneedQc: true,
        searchDatakey: "",
        transInfo: "",
        featureList: ["DEFAULT_FEFEATURE", "PC_WANT_EPISODE_V2", "PC_WANT_EPISODE"],
      }),
    },
  );
  return mapQqSearch(payload);
}

export const qq = defineSite("qq", {
  search: searchQq,
  loadEpisodes: loadQqEpisodes,
});
