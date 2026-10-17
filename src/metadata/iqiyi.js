import { config } from "../config.js";
import { fetchJson } from "../http.js";

export function extractVid(sourceUrl) {
  return /\/v_([0-9a-zA-Z]+)\.html/.exec(sourceUrl)?.[1] ?? null;
}

export function extractTvid(playlist) {
  return /[?&](?:qd_)?tvid=(\d+)/.exec(playlist)?.[1] ?? null;
}

export const iqiyiAdapter = {
  name: "iqiyi",

  match(sourceUrl) {
    try {
      const host = new URL(sourceUrl).hostname.toLowerCase();
      return host === "iqiyi.com" || host.endsWith(".iqiyi.com");
    } catch {
      return false;
    }
  },

  async enrich(sourceUrl, playUrl, { playlist } = {}) {
    const tvid = extractTvid(playlist || "");
    const vid = extractVid(sourceUrl);
    if (!tvid || !vid) return { title: null, cover: null };

    const metadata = await fetchJson(
      `${config.metadataIqiyiUrl}?tvid=${encodeURIComponent(tvid)}&vid=${encodeURIComponent(vid)}`,
      {
        accept: "application/json",
        timeoutMs: config.metadataTimeoutMs,
      },
    );

    if (String(metadata?.code) !== "A00000" || !metadata.data) {
      return { title: null, cover: null };
    }

    const title =
      typeof metadata.data.vn === "string" ? metadata.data.vn.trim() : "";
    const cover =
      typeof metadata.data.vpic === "string"
        ? metadata.data.vpic.replace(/^http:\/\//i, "https://")
        : "";

    return { title: title || null, cover: cover || null };
  },
};
