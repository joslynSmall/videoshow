import { iqiyiAdapter } from "./metadata/iqiyi.js";
import { log } from "./log.js";

const adapters = [iqiyiAdapter];

export async function enrichMetadata(sourceUrl, playUrl, context = {}) {
  for (const adapter of adapters) {
    if (!adapter.match(sourceUrl)) continue;
    try {
      return await adapter.enrich(sourceUrl, playUrl, context);
    } catch (err) {
      log.warn("metadata.lookup_failed", {
        provider: adapter.name,
        code: err?.code ?? "UNKNOWN",
      });
      return { title: null, cover: null };
    }
  }
  return { title: null, cover: null };
}
