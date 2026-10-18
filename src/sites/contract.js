// 站点端口：业务只依赖这里的身份和两个能力，具体网站放在 impl。
const SITES = [
  { id: "qiyi", name: "爱奇艺", suffixes: ["iqiyi.com"] },
  { id: "qq", name: "腾讯视频", suffixes: ["v.qq.com"] },
  { id: "youku", name: "优酷", suffixes: ["youku.com"] },
  { id: "mgtv", name: "芒果TV", suffixes: ["mgtv.com"] },
  { id: "bilibili", name: "哔哩哔哩", suffixes: ["bilibili.com"] },
];

function hostOf(pageUrl) {
  try {
    return new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function matches(host, suffix) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

export function siteIdForPage(pageUrl) {
  const host = hostOf(pageUrl);
  if (!host) return "";
  return SITES.find((site) => site.suffixes.some((suffix) => matches(host, suffix)))?.id || "";
}

export function defineSite(id, behavior) {
  const meta = SITES.find((site) => site.id === id);
  if (!meta) throw new Error(`未知站点 ${id}`);
  if (typeof behavior?.search !== "function" || typeof behavior?.loadEpisodes !== "function") {
    throw new Error(`站点 ${id} 必须实现 search 和 loadEpisodes`);
  }
  return {
    id: meta.id,
    name: meta.name,
    owns(pageUrl) {
      return siteIdForPage(pageUrl) === meta.id;
    },
    search(keyword, ctx) {
      return behavior.search(keyword, ctx);
    },
    loadEpisodes(pageUrl, ctx) {
      return behavior.loadEpisodes(pageUrl, ctx);
    },
  };
}
