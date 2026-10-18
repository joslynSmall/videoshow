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

export function mapQqEpisodeIds(cid, videoIds) {
  if (!cid || !Array.isArray(videoIds)) return [];
  const episodes = [];
  const seen = new Set();
  for (const vid of videoIds) {
    const pageUrl = coverPage(`https://v.qq.com/x/cover/${cid}/${vid}.html`);
    if (!pageUrl || seen.has(pageUrl)) continue;
    seen.add(pageUrl);
    episodes.push({ name: `第${episodes.length + 1}集`, pageUrl });
  }
  return episodes;
}

export async function loadQqEpisodes(pageUrl, options = {}) {
  const cid = qqCoverId(pageUrl);
  if (!cid) return [];
  const payload = await options.fetchJsonFn(
    `https://node.video.qq.com/x/api/float_vinfo2?cid=${encodeURIComponent(cid)}`,
    {
      timeoutMs: options.timeoutMs,
      accept: "application/json",
      headers: { referer: "https://v.qq.com/" },
    },
  );
  return mapQqEpisodeIds(cid, payload?.c?.video_ids);
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
