import { loadPageEpisodes as loadWith, searchSites as searchWith } from "./service.js";
import { bilibili } from "./impl/bilibili.js";
import { iqiyi } from "./impl/iqiyi.js";
import { mgtv } from "./impl/mgtv.js";
import { qq } from "./impl/qq.js";
import { youku } from "./impl/youku.js";

const sites = [iqiyi, qq, youku, mgtv, bilibili];

export function searchSites(keyword, options) {
  return searchWith(sites, keyword, options);
}

export function loadPageEpisodes(pageUrl, options) {
  return loadWith(sites, pageUrl, options);
}
