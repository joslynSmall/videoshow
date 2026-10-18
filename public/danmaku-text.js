function decodeAttr(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function httpsImageUrl(raw) {
  if (typeof raw !== "string") return "";
  let value = decodeAttr(raw).trim();
  if (!value) return "";
  if (value.startsWith("//")) value = `https:${value}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" || url.username || url.password) return "";
  return url.href;
}

function srcFromImgTag(tag) {
  const match = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  return httpsImageUrl(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

export function splitDanmakuText(input) {
  const text = typeof input === "string" ? input : "";
  const parts = [];
  const pattern = /<img\b[^>]*>|\[img\]([\s\S]*?)\[\/img\]/gi;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(last, match.index);
    if (before) parts.push({ type: "text", value: before });
    const src = match[1] == null ? srcFromImgTag(match[0]) : httpsImageUrl(match[1].trim());
    if (src) parts.push({ type: "image", src });
    last = match.index + match[0].length;
  }
  const rest = text.slice(last);
  if (rest) parts.push({ type: "text", value: rest });
  return parts;
}
