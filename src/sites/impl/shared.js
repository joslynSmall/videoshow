export function plainText(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function httpsPage(raw, hostSuffix) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  let value = raw.trim();
  if (value.startsWith("//")) value = `https:${value}`;
  if (value.startsWith("http://")) value = `https://${value.slice("http://".length)}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (url.protocol !== "https:") return "";
  const host = url.hostname.toLowerCase();
  if (hostSuffix && host !== hostSuffix && !host.endsWith(`.${hostSuffix}`)) return "";
  url.hash = "";
  return url.toString();
}

export function uniqueItems(items, limit = 12) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item?.title || !item?.pageUrl || seen.has(item.pageUrl)) continue;
    seen.add(item.pageUrl);
    result.push({
      title: item.title,
      pageUrl: item.pageUrl,
      cover: item.cover || "",
      remarks: item.remarks || "",
      desc: item.desc || "",
      ...(item.siteId ? { siteId: item.siteId } : {}),
      ...(Array.isArray(item.episodes) && item.episodes.length ? { episodes: item.episodes } : {}),
    });
    if (result.length >= limit) break;
  }
  return result;
}
