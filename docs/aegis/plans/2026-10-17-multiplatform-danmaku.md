# 多平台视频解析与弹幕播放器实施计划

- Date: `2026-10-17`
- Status: `ready for execution`
- Source spec: `docs/aegis/specs/2026-10-17-multiplatform-danmaku-design.md`
- Workspace: `/home/joslyn/code/github_me/videoshow`

## Goal

Turn `videoshow` into a platform-neutral video parse service:

- accept any `http(s)` video page URL; no platform allowlist
- support `m3u8` and `mp4` streams with type-aware validation
- replace the native video player with Artplayer plus the official danmaku plugin
- add a read-only `GET /api/danmaku?url=...` backed by dmku
- keep the core free of iQiyi-only branches, fields, copy, and tests

## Architecture

```text
GET /api/parse
  -> provider.normalizeVideoUrl
  -> provider.resolveStream (upstream player page + api.php + AES)
  -> stream.normalizeType / validateStream / extractExpiry
  -> metadata.enrichMetadata (optional adapters; iQiyi is one adapter)
  -> JSON { playUrl, type, title, cover, expiresAt, danmaku.endpoint }

GET /api/danmaku
  -> provider.normalizeVideoUrl
  -> danmaku.fetchDmkuDanmaku
  -> danmaku.normalizeDmkuResponse
  -> JSON { provider, count, items, cached }

Browser
  -> Artplayer + hls.js + artplayer-plugin-danmuku
  -> async fetch /api/danmaku
```

## Tech Stack

- Node.js 22, native `http`, global `fetch`, `node:crypto`
- No runtime npm dependencies
- Artplayer 5.4.0 and `artplayer-plugin-danmuku` 5.3.0, vendored UMD builds
- hls.js 1.7.3 (already vendored)
- `node:test` for unit and server tests

## Baseline / Authority Refs

- `docs/aegis/specs/2026-10-17-multiplatform-danmaku-design.md` (approved)
- `docs/aegis/baseline/2026-10-17-initial-baseline.md`
- `docs/aegis/BASELINE-GOVERNANCE.md`
- `README.md` (current usage; to be updated)
- User decision: reuse dmku; do not design the system as iQiyi-only

## Compatibility Boundary

- `/api/parse` keeps `sourceUrl`, `playUrl`, `type`, `title`, `cover`,
  `expiresAt`, `provider`, `cached`.
- `type` may now be `mp4`; clients must branch by type.
- `title` and `cover` may be `null` for platforms without an adapter.
- `danmaku` is a new additive object on `/api/parse`.
- `/api/danmaku` is a new endpoint.
- `/api/health` is unchanged.
- No persistent schema, database, or video proxy.

## TDD Route

```text
TDD Route:
- Mode: off
- Decision: skipped
- Strict authority: not applicable
- Strict signals: none; the user did not request strict TDD
- Light eligibility: not applicable
- TDD-fit exception: none
- Test posture: post-change regression
- Reason: the user requested a design-driven implementation, not strict TDD
- Verification: npm test, RUN_LIVE_TESTS=1 npm test, browser checks
```

## Plan Basis

- Approved design spec plus measured evidence:
  - iQiyi sample -> m3u8 and 1463 valid dmku items
  - Bilibili sample -> mp4 and 0 valid dmku items
- The current service is iQiyi-only and m3u8-only; both are intentional defects
  for this change.

## BaselineUsageDraft

```text
BaselineUsageDraft:
- Required baseline refs: approved design spec, initial baseline snapshot
- Delivered context refs: none beyond the current thread
- Acknowledged before plan refs: both required refs read
- Cited in plan refs: spec sections 3-9; baseline sections 4-6
- Missing refs: none
- Decision: continue
```

## Requirement Ready Check

```text
Requirement Ready Check:
- Requirement source refs: user confirmation + approved design spec
- Goals and scope refs: spec sections 2-3
- User / scenario refs: local/self-hosted browser user
- Requirement item refs: generic URL, m3u8/mp4, Artplayer, dmku API
- Acceptance / verification criteria refs: spec section 8
- Open blocker questions: none
- Decision: ready
```

## Files

Create:

- `src/stream.js`
- `src/danmaku.js`
- `src/metadata/iqiyi.js`
- `test/stream.test.js`
- `test/danmaku.test.js`
- `public/vendor/artplayer.js`
- `public/vendor/artplayer-plugin-danmuku.js`
- `public/vendor/artplayer.LICENSE`
- `public/vendor/artplayer-plugin-danmuku.LICENSE`
- `docs/aegis/plans/2026-10-17-multiplatform-danmaku.md` (this file)

Modify:

- `src/config.js`
- `src/http.js`
- `src/provider.js`
- `src/metadata.js` (becomes the adapter dispatcher; iQiyi logic moves out)
- `src/server.js`
- `public/index.html`
- `public/app.js`
- `public/styles.css`
- `test/provider.test.js`
- `test/server.test.js`
- `test/live.test.js`
- `README.md`
- `package.json`
- `docs/aegis/INDEX.md`

Retire:

- `normalizeIqiyiUrl` and the iQiyi host allowlist
- m3u8-only `inspectStream`
- native `<video>` + hls.js player code
- iQiyi-only page copy and placeholder
- iQiyi-only CSP image host

## Change Necessity

```text
Change Necessity:
- User-visible need: parse any video site; full player; danmaku
- No-change / non-code option: documentation alone cannot change parsing,
  validation, player, or danmaku behavior
- Why code change is necessary: API contract and player implementation change
- Minimum change boundary: provider/stream/metadata/danmaku/server/public
- Decision: code-change
```

## Existence Check

```text
Existence Check:
- Proposed new surface: /api/danmaku + src/danmaku.js
- Existing owner / reuse candidate: external dmku endpoint
- Why existing surface is insufficient: parse API has no danmaku; direct
  browser use would lack filtering, sorting, caching, and error handling
- Creation proof: Artplayer plugin needs a stable async data function; the
  userscript's JSON.parse repair is not available in this page
- Entropy / retirement impact: thin module; remove or swap if dmku dies
- Decision: add-with-proof
```

```text
Existence Check:
- Proposed new surface: src/metadata/iqiyi.js adapter directory
- Existing owner / reuse candidate: current src/metadata.js
- Why existing surface is insufficient: current file mixes m3u8 validation and
  iQiyi metadata; stream validation moves out
- Creation proof: adapter boundary keeps iQiyi logic optional and isolated
- Entropy / retirement impact: src/metadata.js remains the dispatcher; no
  duplicate owner
- Decision: reuse-existing dispatcher + add one adapter
```

```text
Existence Check:
- Proposed new surface: Artplayer + plugin vendor files
- Existing owner / reuse candidate: native video + hls.js
- Why existing surface is insufficient: no danmaku UI and no mp4 handling
- Creation proof: official MIT plugin, async danmaku, full controls
- Entropy / retirement impact: replace native player; hls.js is reused
- Decision: add-with-proof
```

## Architecture Integrity Lens

- Invariant: core parse/player/danmaku must remain platform-neutral.
- Canonical owner: `src/provider.js` for upstream parse; `src/stream.js` for
  type validation; `src/danmaku.js` for dmku normalization; `src/metadata.js`
  for adapter dispatch; `src/server.js` for HTTP/cache; `public/app.js` for
  player lifecycle.
- Responsibility overlap: iQiyi metadata moves out of `src/metadata.js` into
  `src/metadata/iqiyi.js`; no m3u8 validation remains in metadata.
- Higher-level simplification: dmku is a data provider, not a player feature;
  keep it server-side.
- Retirement/falsifier: if dmku disappears, remove `src/danmaku.js` and the
  parse `danmaku` field; playback remains unaffected.
- Verdict: proceed.

## Plan Pressure Test

```text
Plan Pressure Test:
- Owner / contract / retirement: stream validation leaves metadata; native
  player retires; API fields additive
- Architecture integrity / higher-level path: no new backend service; dmku and
  Artplayer are external/vendor surfaces
- Verification scope: unit, server, live, browser
- Task executability: sequential, shared files, inline execution
- Pressure result: proceed
```

## Complexity Budget

```text
Complexity Budget:
- Artifact class: small Node service + browser player
- Target files / artifacts: 4 new backend modules, 3 frontend files, vendor assets
- Current pressure: medium; metadata.js mixes two concerns
- Projected post-change pressure: medium, with clearer module boundaries
- Budget result: at-risk
- Planned governance: extract stream and danmaku modules; keep server thin;
  keep metadata dispatch in the existing file
```

```text
Plan-Time Complexity Check:
- Target files: src/provider.js, src/server.js, src/metadata.js, public/app.js
- Existing size / shape signals: server is the largest backend file; app.js
  already has form/status/player logic
- Owner fit: stream and danmaku are distinct concerns; metadata is an adapter
  boundary
- Add-in-place risk: adding type validation to metadata would keep the old
  coupling
- Better file boundary: new src/stream.js and src/danmaku.js; metadata adapter
  in src/metadata/iqiyi.js
- Recommendation: extract helper + add owner file
```

## Execution Readiness View

```text
Execution Readiness View:
- Intent Lock: platform-neutral parse, Artplayer + official danmaku plugin,
  dmku read-only
- Scope Fence: no danmaku sending, no danmu_api, no flv, no extra metadata
  adapters, no video proxy
- Baseline Lock: approved spec + initial baseline
- Approved Behavior: any http(s) URL; m3u8/mp4; /api/danmaku; generic UI
- Owner / Contract Constraints: see Architecture Integrity Lens
- Compatibility Boundary: existing parse fields preserved; type may be mp4;
  title/cover nullable; danmaku additive
- Retirement Boundary: iQiyi allowlist, m3u8-only metadata validation, native
  player
- Task Batches: vendor -> backend -> frontend -> tests -> docs
- Test Obligations: unit, server, live opt-in, browser
- Review Gates: spec approved; plan self-review; final verification
- Drift / Rewind Rules: if Artplayer assets are unavailable or dmku fails,
  return to plan/spec; do not fall back to iQiyi-only behavior
- Evidence Required Before Completion: test output, live parse output, browser
  checks, no ad-domain grep
- Advisory Boundary: method-pack execution guidance only; not completion
  authority
```

## Tasks

### Task 1: Vendor Artplayer and danmaku plugin

**Files**
- Create `public/vendor/artplayer.js`
- Create `public/vendor/artplayer-plugin-danmuku.js`
- Create `public/vendor/artplayer.LICENSE`
- Create `public/vendor/artplayer-plugin-danmuku.LICENSE`
- Update `public/vendor/README.md`

**Why**: the player replacement uses vendored UMD builds so the page has no
CDN dependency.

**Change Necessity**: the current page has no Artplayer or danmaku plugin; the
vendor files are required to render the new player.

**Steps**

1. Download the pinned UMD builds:

```bash
cd /home/joslyn/code/github_me/videoshow
curl -sSL 'https://cdn.jsdelivr.net/npm/artplayer@5.4.0/dist/artplayer.js' -o public/vendor/artplayer.js
curl -sSL 'https://cdn.jsdelivr.net/npm/artplayer-plugin-danmuku@5.3.0/dist/artplayer-plugin-danmuku.js' -o public/vendor/artplayer-plugin-danmuku.js
```

Expected: both files start with the version/license banner and expose
`Artplayer` / `artplayerPluginDanmuku` UMD globals.

2. Add MIT license files. Use the standard MIT text with the copyright line
   `Copyright (c) 2017-2026 Harvey Zhao` for both packages, because both
   package headers state MIT and no LICENSE file is shipped in the npm dist.

3. Update `public/vendor/README.md` with versions, source URLs, and license
   names.

**Verification**:

```bash
node -e "const fs=require('fs'); for (const f of ['public/vendor/artplayer.js','public/vendor/artplayer-plugin-danmuku.js']) { const s=fs.readFileSync(f,'utf8'); if (!s.includes('MIT License')) throw new Error(f); } console.log('vendor banners ok')"
ls -lh public/vendor/
```

### Task 2: Generic config, HTTP probe, provider, and stream validation

**Files**
- Modify `src/config.js`
- Modify `src/http.js`
- Modify `src/provider.js`
- Create `src/stream.js`
- Modify `test/provider.test.js`
- Create `test/stream.test.js`

**Why**: remove the iQiyi allowlist and make validation type-aware.

**Change Necessity**: current `resolveStream` and `inspectStream` reject
non-iQiyi URLs and mp4 streams; this task fixes the core parse path.

**Steps**

1. Replace `src/config.js` with the generic configuration:

```js
import path from "node:path";
import { fileURLToPath } from "node:url";

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: intEnv("PORT", 3000),
  upstreamBase: (process.env.UPSTREAM_BASE || "https://api-api.789jiexi.net").replace(/\/+$/, ""),
  aesKey: process.env.UPSTREAM_AES_KEY || "ARTPLAYERliUlanG",
  aesIv: process.env.UPSTREAM_AES_IV || "ArtplayerliUlanG",
  metadataIqiyiUrl:
    process.env.METADATA_IQIYI_URL ||
    "https://pcw-api.iqiyi.com/video/video/playervideoinfo",
  danmakuBaseUrl:
    process.env.DANMAKU_BASE_URL || "https://jx.1ljx.com/dan/@lirose_tv/",
  requestTimeoutMs: intEnv("REQUEST_TIMEOUT_MS", 15000),
  metadataTimeoutMs: intEnv("METADATA_TIMEOUT_MS", 5000),
  danmakuTimeoutMs: intEnv("DANMAKU_TIMEOUT_MS", 10000),
  streamTimeoutMs: intEnv("STREAM_TIMEOUT_MS", 10000),
  cacheTtlMs: intEnv("CACHE_TTL_MS", 300000),
  cacheMaxEntries: intEnv("CACHE_MAX_ENTRIES", 200),
  publicDir: path.join(projectRoot, "public"),
};

for (const [name, value] of [
  ["UPSTREAM_BASE", config.upstreamBase],
  ["METADATA_IQIYI_URL", config.metadataIqiyiUrl],
  ["DANMAKU_BASE_URL", config.danmakuBaseUrl],
]) {
  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

if (Buffer.byteLength(config.aesKey) !== 16 || Buffer.byteLength(config.aesIv) !== 16) {
  throw new Error("UPSTREAM_AES_KEY and UPSTREAM_AES_IV must each be 16 bytes");
}
```

2. Add `probeUrl` to `src/http.js` without changing `fetchText`/`fetchJson`:

```js
export async function probeUrl(url, options = {}) {
  const { method = "HEAD", headers = {}, timeoutMs = config.requestTimeoutMs } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, ...headers },
    });
    const result = {
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      finalUrl: response.url,
    };
    if (method !== "HEAD" && response.body) {
      await response.body.cancel().catch(() => {});
    }
    return result;
  } catch (err) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      throw new AppError("UPSTREAM_TIMEOUT", 504, "远端请求超时", { cause: err });
    }
    throw new AppError("UPSTREAM_ERROR", 502, "远端请求失败", { cause: err });
  } finally {
    clearTimeout(timer);
  }
}
```

3. Replace `normalizeIqiyiUrl` with `normalizeVideoUrl` in
   `src/provider.js`:

```js
export function normalizeVideoUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new AppError("INVALID_URL", 400, "缺少 url 参数");
  }

  let value = raw.trim();
  if (value.length > 2048) {
    throw new AppError("INVALID_URL", 400, "链接过长");
  }
  if (value.startsWith("//")) {
    value = `https:${value}`;
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `https://${value}`;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError("INVALID_URL", 400, "链接格式不正确");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppError("INVALID_URL", 400, "只支持 http/https 链接");
  }

  parsed.hash = "";
  return parsed.toString();
}
```

4. In `resolveStream`, use `normalizeVideoUrl` and treat zero/absent expiry as
   unknown:

```js
const expirySeconds = Number(payload.expire_time);
const expiresInSeconds = Number(payload.expires_in);
const expiresAtMs =
  Number.isFinite(expirySeconds) && expirySeconds > 0
    ? expirySeconds * 1000
    : Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
      ? Date.now() + expiresInSeconds * 1000
      : null;
```

5. Create `src/stream.js`:

```js
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { fetchText, probeUrl } from "./http.js";

export function normalizeType(type, playUrl) {
  const raw = String(type || "").trim().toLowerCase();
  if (raw === "m3u8" || raw === "hls") return "m3u8";
  if (raw === "mp4") return "mp4";
  if (/\.m3u8(\?|$)/i.test(playUrl)) return "m3u8";
  if (/\.mp4(\?|$)/i.test(playUrl)) return "mp4";
  throw new AppError("UNSUPPORTED_STREAM_TYPE", 502, "暂不支持该视频格式");
}

export function extractExpiry(playUrl) {
  if (typeof playUrl !== "string") return null;
  let parsed;
  try {
    parsed = new URL(playUrl);
  } catch {
    return null;
  }
  for (const key of ["deadline", "expire", "expires"]) {
    const value = Number(parsed.searchParams.get(key));
    if (Number.isFinite(value) && value > 0) return value * 1000;
  }
  return null;
}

export async function validateStream(
  playUrl,
  type,
  { textFetcher = fetchText, prober = probeUrl } = {},
) {
  if (type === "m3u8") {
    const playlist = await textFetcher(playUrl, {
      accept: "application/vnd.apple.mpegurl,application/x-mpegURL,*/*",
      timeoutMs: config.streamTimeoutMs,
    });
    const normalized = playlist.replace(/^\uFEFF/, "").trimStart();
    if (!normalized.startsWith("#EXTM3U")) {
      throw new AppError("STREAM_INVALID", 502, "播放清单无效，请重新解析");
    }
    return { playlist: normalized };
  }

  let probe = await prober(playUrl, {
    method: "HEAD",
    timeoutMs: config.streamTimeoutMs,
  });
  if (probe.status >= 400) {
    probe = await prober(playUrl, {
      method: "GET",
      headers: { range: "bytes=0-0" },
      timeoutMs: config.streamTimeoutMs,
    });
  }
  if (probe.status >= 400) {
    throw new AppError("STREAM_INVALID", 502, "播放地址不可用，请重新解析");
  }
  return { playlist: null };
}
```

6. Update `test/provider.test.js` imports and URL tests:

```js
import { decryptPlayUrl, extractConfig, normalizeVideoUrl } from "../src/provider.js";
import { extractTvid, extractVid } from "../src/metadata/iqiyi.js";

test("normalizeVideoUrl accepts arbitrary http(s) video URLs", () => {
  assert.equal(
    normalizeVideoUrl("www.iqiyi.com/v_19rronibdc.html"),
    "https://www.iqiyi.com/v_19rronibdc.html",
  );
  assert.equal(
    normalizeVideoUrl("https://www.bilibili.com/video/BV1JP41167xK"),
    "https://www.bilibili.com/video/BV1JP41167xK",
  );
  assert.equal(
    normalizeVideoUrl("https://v.youku.com/v_show/id_X.html"),
    "https://v.youku.com/v_show/id_X.html",
  );
});

test("normalizeVideoUrl rejects missing and non-http URLs", () => {
  assert.throws(() => normalizeVideoUrl(""), (err) => err.code === "INVALID_URL");
  assert.throws(
    () => normalizeVideoUrl("ftp://example.com/video"),
    (err) => err.code === "INVALID_URL",
  );
});
```

Keep the existing `extractConfig`, `decryptPlayUrl`, `extractTvid`, and
`extractVid` tests; change only the import paths and URL expectations.

7. Create `test/stream.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { extractExpiry, normalizeType, validateStream } from "../src/stream.js";

test("normalizeType recognizes m3u8 and mp4", () => {
  assert.equal(normalizeType("m3u8", "https://example.com/a.m3u8"), "m3u8");
  assert.equal(normalizeType("mp4", "https://example.com/a.mp4"), "mp4");
  assert.equal(normalizeType("", "https://example.com/a.m3u8?x=1"), "m3u8");
  assert.equal(normalizeType("", "https://example.com/a.mp4?x=1"), "mp4");
});

test("normalizeType rejects unsupported formats", () => {
  assert.throws(
    () => normalizeType("flv", "https://example.com/a.flv"),
    (err) => err.code === "UNSUPPORTED_STREAM_TYPE",
  );
});

test("extractExpiry reads deadline and ignore invalid values", () => {
  assert.equal(
    extractExpiry("https://example.com/a.mp4?deadline=1792258009"),
    1792258009000,
  );
  assert.equal(extractExpiry("https://example.com/a.mp4?deadline=0"), null);
  assert.equal(extractExpiry("https://example.com/a.mp4"), null);
});

test("validateStream accepts a valid m3u8 playlist", async () => {
  const result = await validateStream("https://example.com/a.m3u8", "m3u8", {
    textFetcher: async () => "#EXTM3U\n#EXTINF:1,\nhttps://example.com/a.ts\n",
  });
  assert.match(result.playlist, /^#EXTM3U/);
});

test("validateStream rejects an invalid m3u8 playlist", async () => {
  await assert.rejects(
    () =>
      validateStream("https://example.com/a.m3u8", "m3u8", {
        textFetcher: async () => "not a playlist",
      }),
    (err) => err.code === "STREAM_INVALID",
  );
});

test("validateStream accepts mp4 via HEAD", async () => {
  const result = await validateStream("https://example.com/a.mp4", "mp4", {
    prober: async () => ({ status: 200, contentType: "video/mp4" }),
  });
  assert.equal(result.playlist, null);
});

test("validateStream falls back to a range GET", async () => {
  const methods = [];
  const result = await validateStream("https://example.com/a.mp4", "mp4", {
    prober: async (_url, options) => {
      methods.push(options.method);
      return methods.length === 1 ? { status: 405 } : { status: 206 };
    },
  });
  assert.deepEqual(methods, ["HEAD", "GET"]);
  assert.equal(result.playlist, null);
});

test("validateStream rejects an unavailable mp4", async () => {
  await assert.rejects(
    () =>
      validateStream("https://example.com/a.mp4", "mp4", {
        prober: async () => ({ status: 404 }),
      }),
    (err) => err.code === "STREAM_INVALID",
  );
});
```

**Verification**:

```bash
cd /home/joslyn/code/github_me/videoshow
node --check src/config.js src/http.js src/provider.js src/stream.js
node --test test/provider.test.js test/stream.test.js
```

### Task 3: Metadata adapter boundary

**Files**
- Modify `src/metadata.js`
- Create `src/metadata/iqiyi.js`
- Modify `test/provider.test.js` imports (already covered in Task 2)

**Why**: move iQiyi-specific lookup out of the core m3u8 validation path.

**Steps**

1. Replace `src/metadata.js` with the dispatcher:

```js
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
```

2. Create `src/metadata/iqiyi.js`:

```js
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
```

**Verification**:

```bash
cd /home/joslyn/code/github_me/videoshow
node --check src/metadata.js src/metadata/iqiyi.js
node --test test/provider.test.js
```

### Task 4: Danmaku module

**Files**
- Create `src/danmaku.js`
- Create `test/danmaku.test.js`

**Why**: normalize dmku's compact, dirty `danmuku` format into Artplayer's
danmaku shape.

**Steps**

1. Create `src/danmaku.js`:

```js
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { fetchText } from "./http.js";

export function normalizeColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value)
    ? value.toUpperCase()
    : "#FFFFFF";
}

export function normalizeDmkuResponse(payload) {
  const raw = Array.isArray(payload?.danmuku) ? payload.danmuku : [];

  const items = raw
    .filter(
      (item) =>
        Array.isArray(item) &&
        typeof item[0] === "number" &&
        Number.isFinite(item[0]) &&
        typeof item[4] === "string" &&
        item[4].trim() !== "",
    )
    .map((item) => ({
      time: item[0],
      mode: item[1] === "top" ? 1 : item[1] === "bottom" ? 2 : 0,
      color: normalizeColor(item[2]),
      text: item[4].trim(),
    }))
    .sort((a, b) => a.time - b.time);

  return { provider: "dmku", count: items.length, items };
}

export async function fetchDmkuDanmaku(sourceUrl) {
  const endpoint = new URL(config.danmakuBaseUrl);
  endpoint.searchParams.set("url", sourceUrl);

  let text;
  try {
    text = await fetchText(endpoint.toString(), {
      accept: "application/json",
      timeoutMs: config.danmakuTimeoutMs,
    });
  } catch (err) {
    throw new AppError("DANMAKU_UPSTREAM_ERROR", 502, "弹幕服务暂不可用，请稍后重试", {
      cause: err,
    });
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    throw new AppError("DANMAKU_UPSTREAM_ERROR", 502, "弹幕服务返回异常", {
      cause: err,
    });
  }

  return normalizeDmkuResponse(payload);
}
```

2. Create `test/danmaku.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDmkuResponse } from "../src/danmaku.js";

test("normalizeDmkuResponse filters dirty items and maps modes", () => {
  const result = normalizeDmkuResponse({
    code: 23,
    danmuku: [
      [2, "right", "#ffffff", "", ""],
      [],
      [5, "top", "#FF0000", "", "顶部弹幕"],
      ["bad", "right", "#fff", "", "invalid time"],
      [1, "right", "#fff", "", "   "],
      [3, "bottom", "#00ff00", "", "底部弹幕"],
      [1, "right", "not-a-color", "", "普通弹幕"],
    ],
  });

  assert.equal(result.provider, "dmku");
  assert.equal(result.count, 3);
  assert.deepEqual(
    result.items.map((item) => item.text),
    ["普通弹幕", "底部弹幕", "顶部弹幕"],
  );
  assert.equal(result.items[0].mode, 0);
  assert.equal(result.items[0].color, "#FFFFFF");
  assert.equal(result.items[1].mode, 2);
  assert.equal(result.items[2].mode, 1);
  assert.equal(result.items[2].color, "#FF0000");
});

test("normalizeDmkuResponse returns an empty collection for no data", () => {
  assert.deepEqual(normalizeDmkuResponse({}), {
    provider: "dmku",
    count: 0,
    items: [],
  });
});
```

**Verification**:

```bash
cd /home/joslyn/code/github_me/videoshow
node --check src/danmaku.js
node --test test/danmaku.test.js
```

### Task 5: Server routes, caches, static assets, CSP

**Files**
- Modify `src/server.js`
- Modify `test/server.test.js`

**Why**: expose the generic parse and danmaku contracts and serve Artplayer.

**Steps**

1. Replace `src/server.js` with the version that:
   - imports `normalizeVideoUrl`, `resolveStream`, `validateStream`,
     `normalizeType`, `extractExpiry`, `enrichMetadata`, `fetchDmkuDanmaku`
   - injects `resolve`, `validate`, `enrich`, `fetchDanmaku`, `logger`, `now`
   - keeps `parseCache` and adds `danmakuCache`
   - adds `/api/danmaku`
   - adds `/vendor/artplayer.js` and
     `/vendor/artplayer-plugin-danmuku.js` to `STATIC_FILES`
   - sets CSP `style-src 'self' 'unsafe-inline'` and `img-src 'self' data: https:`
   - preserves `/api/health`, 405/404 behavior, and static HEAD handling

   The complete file is provided in Appendix A.

2. Update `test/server.test.js`:
   - fake `resolve` returns m3u8 or mp4 results
   - fake `validate` returns `{ playlist: "#EXTM3U" }` or `{ playlist: null }`
   - fake `enrich` returns `{ title: "测试视频", cover: null }`
   - fake `fetchDanmaku` returns one item
   - test `/api/parse` for both types and the `danmaku.endpoint`
   - test `/api/danmaku` success, empty, error, and cache
   - test generic URL acceptance and non-http rejection
   - test home page has no iQiyi-only copy and no ad domains
   - test Artplayer/plugin/hls vendor files

**Verification**:

```bash
cd /home/joslyn/code/github_me/videoshow
node --check src/server.js
node --test test/server.test.js
```

### Task 6: Artplayer frontend

**Files**
- Modify `public/index.html`
- Modify `public/app.js`
- Modify `public/styles.css`

**Why**: the native player has no danmaku and no mp4 support.

**Steps**

1. Replace `public/index.html` with the version in Appendix B:
   - generic meta/title/description/placeholder/error copy
   - Artplayer container `#player`
   - scripts: hls.js, Artplayer, danmaku plugin, app.js
   - no separate Artplayer CSS (the UMD injects styles)

2. Replace `public/app.js` with the version in Appendix C:
   - Artplayer lifecycle
   - `customType.m3u8` with hls.js
   - async `/api/danmaku`
   - danmaku loaded/empty/error states
   - generic parse/error copy

3. Update `public/styles.css`:
   - keep the existing shell/form/result styles
   - replace `#player` video rules with:
     ```css
     .player-wrap {
       aspect-ratio: 16 / 9;
       background: #000;
     }

     .player {
       width: 100%;
       height: 100%;
     }
     ```
   - ensure `.result` overflow hidden and the player fills the card

**Verification**:

```bash
cd /home/joslyn/code/github_me/videoshow
node --check public/app.js
curl -s http://127.0.0.1:3000/ | grep -E 'Artplayer|artplayer-plugin-danmuku|id="player"'
```

### Task 7: Update tests and live checks

**Files**
- Modify `test/live.test.js`
- Verify all tests

**Steps**

1. Replace `test/live.test.js` with opt-in checks for:
   - iQiyi: m3u8, valid playlist, real title not containing the ad marker,
     dmku count > 0
   - Bilibili: mp4, valid stream, dmku count 0 (accepted limitation)

2. Run the full offline suite:

```bash
cd /home/joslyn/code/github_me/videoshow
npm test
```

3. Run the live suite:

```bash
cd /home/joslyn/code/github_me/videoshow
RUN_LIVE_TESTS=1 npm test
```

### Task 8: Documentation

**Files**
- Modify `README.md`
- Modify `package.json`
- Modify `docs/aegis/INDEX.md`

**Steps**

1. Update `package.json` description to remove "iQiyi".
2. Rewrite README sections:
   - multi-platform scope, supported types `m3u8`/`mp4`
   - `/api/parse` and `/api/danmaku` examples
   - Artplayer + official danmaku plugin
   - dmku source and Bilibili empty-danmaku limitation
   - environment variables, including `DANMAKU_BASE_URL` and
     `METADATA_IQIYI_URL`
   - no iQiyi-only copy outside the optional adapter/example
3. Append the plan to `docs/aegis/INDEX.md`.

## Risks

- dmku is third-party; availability and coverage can change.
- Bilibili danmaku is empty with dmku; accepted and surfaced in the UI.
- Artplayer/plugin inject styles; CSP allows inline styles but keeps scripts
  same-origin.
- Vendored assets add about 190 KB.
- Upstream parse coverage varies; unsupported sites must fail clearly.
- No git repository: no commits are possible; each task is gated by commands.

## Retirement

- Remove `normalizeIqiyiUrl` and the host allowlist.
- Remove m3u8-only `inspectStream`; metadata now consumes the validated
  playlist.
- Remove native `<video>` + hls-only player code.
- Remove iQiyi-only page copy and placeholder.
- Remove the iQiyi-only CSP image host.
- Keep `src/metadata.js` as the dispatcher; iQiyi logic lives in
  `src/metadata/iqiyi.js`.
- No old fallback is retained.

## Execution Route

```text
Execution Route:
- Decision: inline
- Evidence: sequential shared-file tasks; backend contracts feed the frontend;
  no independent parallel tracks justify subagent overhead
- Fallback: none
- User confirmation required: no — the spec is approved and no destructive or
  external boundary is crossed
```

## Verification Summary

```bash
cd /home/joslyn/code/github_me/videoshow
node --check src/*.js src/metadata/*.js public/app.js test/*.js
npm test
RUN_LIVE_TESTS=1 npm test
curl -s http://127.0.0.1:3000/api/health
curl -s 'http://127.0.0.1:3000/api/parse?url=https%3A%2F%2Fwww.iqiyi.com%2Fv_19rronibdc.html'
curl -s 'http://127.0.0.1:3000/api/parse?url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1JP41167xK'
curl -s 'http://127.0.0.1:3000/api/danmaku?url=https%3A%2F%2Fwww.iqiyi.com%2Fv_19rronibdc.html'
grep -R "f3531\\.top\\|trafficmanager\\|zeyuyun" public src || true
```

Browser checks:

- open the iQiyi sample: Artplayer plays m3u8, danmaku count > 0
- open the Bilibili sample: Artplayer plays mp4, "暂无弹幕" state
- verify fullscreen, playback rate, and danmaku toggle

## Appendix A: `src/server.js`

```js
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { fetchDmkuDanmaku } from "./danmaku.js";
import { AppError } from "./errors.js";
import { log } from "./log.js";
import { enrichMetadata } from "./metadata.js";
import { normalizeVideoUrl, resolveStream } from "./provider.js";
import { extractExpiry, normalizeType, validateStream } from "./stream.js";

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8", cache: "no-cache" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8", cache: "no-cache" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8", cache: "no-cache" }],
  ["/vendor/hls.min.js", { file: "vendor/hls.min.js", type: "text/javascript; charset=utf-8", cache: "public, max-age=31536000, immutable" }],
  ["/vendor/artplayer.js", { file: "vendor/artplayer.js", type: "text/javascript; charset=utf-8", cache: "public, max-age=31536000, immutable" }],
  ["/vendor/artplayer-plugin-danmuku.js", { file: "vendor/artplayer-plugin-danmuku.js", type: "text/javascript; charset=utf-8", cache: "public, max-age=31536000, immutable" }],
]);

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "media-src 'self' https: blob:",
  "connect-src 'self' https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  if (res.req?.method === "HEAD") res.end();
  else res.end(body);
}

function sendMethodNotAllowed(res, allow) {
  sendJson(
    res,
    405,
    { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "请求方法不支持" } },
    { allow },
  );
}

function sendError(res, err, logger) {
  if (res.headersSent) {
    res.destroy();
    return;
  }

  const status = Number.isInteger(err?.status) ? err.status : 500;
  const code = typeof err?.code === "string" ? err.code : "INTERNAL";
  const expose = err instanceof AppError ? err.expose : false;
  const message = expose ? err.message : "服务内部错误";

  if (status >= 500) {
    logger.error("http.error", {
      status,
      code,
      message: err?.message,
      stack: err?.stack,
    });
  } else {
    logger.warn("http.error", { status, code, message: err?.message });
  }

  sendJson(res, status, { ok: false, error: { code, message } });
}

async function sendStatic(req, res, entry, logger) {
  const filePath = path.join(config.publicDir, entry.file);
  let data;

  try {
    data = await readFile(filePath);
  } catch (err) {
    logger.error("static.read_failed", {
      file: entry.file,
      message: err?.message,
    });
    sendJson(res, 500, {
      ok: false,
      error: { code: "INTERNAL", message: "静态资源缺失" },
    });
    return;
  }

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": entry.type,
    "content-length": data.length,
    "cache-control": entry.cache,
    ...(entry.file === "index.html"
      ? { "content-security-policy": HTML_CSP }
      : {}),
  });

  if (req.method === "HEAD") res.end();
  else res.end(data);
}

export function createServer({
  resolve = resolveStream,
  validate = validateStream,
  enrich = enrichMetadata,
  fetchDanmaku = fetchDmkuDanmaku,
  logger = log,
  now = Date.now,
  cacheTtlMs = config.cacheTtlMs,
  cacheMaxEntries = config.cacheMaxEntries,
} = {}) {
  const parseCache = new Map();
  const danmakuCache = new Map();

  function getCached(cache, key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      cache.delete(key);
      return null;
    }
    return entry;
  }

  function storeCached(cache, key, data, expiresAtMs) {
    if (cacheMaxEntries <= 0 || cacheTtlMs <= 0) return;
    const current = now();
    const expiry = Math.min(
      current + cacheTtlMs,
      Number.isFinite(expiresAtMs) ? expiresAtMs : Infinity,
    );
    if (expiry <= current) return;

    if (cache.size >= cacheMaxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { data, expiresAt: expiry });
  }

  async function handleParse(res, requestUrl) {
    const sourceUrl = normalizeVideoUrl(requestUrl.searchParams.get("url"));
    const cached = getCached(parseCache, sourceUrl);
    if (cached) {
      sendJson(res, 200, { ok: true, data: { ...cached.data, cached: true } });
      return;
    }

    const result = await resolve(sourceUrl);
    const type = normalizeType(result.type, result.playUrl);
    const stream = (await validate(result.playUrl, type)) ?? {};
    const info = (await enrich(result.sourceUrl, result.playUrl, stream)) ?? {};
    const expiresAtMs = Number.isFinite(result.expiresAtMs)
      ? result.expiresAtMs
      : extractExpiry(result.playUrl);

    const data = {
      sourceUrl: result.sourceUrl,
      playUrl: result.playUrl,
      type,
      title: info.title ?? null,
      cover: info.cover ?? null,
      expiresAt: Number.isFinite(expiresAtMs)
        ? new Date(expiresAtMs).toISOString()
        : null,
      provider: result.provider,
      cached: false,
      danmaku: {
        provider: "dmku",
        endpoint: `/api/danmaku?url=${encodeURIComponent(result.sourceUrl)}`,
      },
    };

    storeCached(parseCache, sourceUrl, data, expiresAtMs);
    sendJson(res, 200, { ok: true, data });
  }

  async function handleDanmaku(res, requestUrl) {
    const sourceUrl = normalizeVideoUrl(requestUrl.searchParams.get("url"));
    const cached = getCached(danmakuCache, sourceUrl);
    if (cached) {
      sendJson(res, 200, { ok: true, data: { ...cached.data, cached: true } });
      return;
    }

    const result = await fetchDanmaku(sourceUrl);
    const data = {
      provider: result.provider,
      count: result.count,
      items: result.items,
      cached: false,
    };
    storeCached(danmakuCache, sourceUrl, data, now() + cacheTtlMs);
    sendJson(res, 200, { ok: true, data });
  }

  return http.createServer(async (req, res) => {
    const startedAt = Date.now();
    res.on("finish", () => {
      logger.info("http.request", {
        method: req.method,
        path: (req.url || "/").split("?")[0],
        status: res.statusCode,
        ms: Date.now() - startedAt,
      });
    });

    try {
      const requestUrl = new URL(req.url || "/", "http://localhost");

      if (requestUrl.pathname === "/api/health") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res, "GET");
          return;
        }
        sendJson(res, 200, {
          ok: true,
          service: "videoshow",
          uptime: Math.round(process.uptime()),
        });
        return;
      }

      if (requestUrl.pathname === "/api/parse") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res, "GET");
          return;
        }
        await handleParse(res, requestUrl);
        return;
      }

      if (requestUrl.pathname === "/api/danmaku") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res, "GET");
          return;
        }
        await handleDanmaku(res, requestUrl);
        return;
      }

      if (requestUrl.pathname.startsWith("/api/")) {
        sendJson(res, 404, {
          ok: false,
          error: { code: "NOT_FOUND", message: "接口不存在" },
        });
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        sendMethodNotAllowed(res, "GET, HEAD");
        return;
      }

      if (requestUrl.pathname === "/favicon.ico") {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }

      const entry = STATIC_FILES.get(requestUrl.pathname);
      if (!entry) {
        res.writeHead(404, {
          ...SECURITY_HEADERS,
          "content-type": "text/plain; charset=utf-8",
        });
        res.end("Not Found");
        return;
      }

      await sendStatic(req, res, entry, logger);
    } catch (err) {
      sendError(res, err, logger);
    }
  });
}

export function start() {
  const server = createServer();

  server.on("error", (err) => {
    log.error("server.error", { message: err?.message });
    process.exitCode = 1;
  });

  server.listen(config.port, config.host, () => {
    const address = server.address();
    const host =
      address && typeof address === "object" ? address.address : config.host;
    const port =
      address && typeof address === "object" ? address.port : config.port;
    log.info(`videoshow listening on http://${host}:${port}`);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("server.shutdown", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  return server;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) start();
```

## Appendix B: `public/index.html`

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="description" content="多平台视频解析与弹幕播放服务">
  <title>videoshow · 视频解析</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23c6f36b'/%3E%3Cpath d='M12 9v14l11-7z' fill='%230b0d0c'/%3E%3C/svg%3E">
  <link rel="stylesheet" href="/styles.css">
  <script defer src="/vendor/hls.min.js"></script>
  <script defer src="/vendor/artplayer.js"></script>
  <script defer src="/vendor/artplayer-plugin-danmuku.js"></script>
  <script defer src="/app.js"></script>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="videoshow 首页">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
            <title>videoshow</title>
            <path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor"/>
          </svg>
        </span>
        <span class="brand-name">videoshow</span>
      </a>
      <span class="badge">无广告</span>
    </header>

    <main>
      <section class="hero">
        <p class="eyebrow">Node.js · Video Parse</p>
        <h1>粘贴链接，<br>直接播放。</h1>
        <p class="lede">服务端解析视频页链接，返回可播放的 m3u8 或 mp4。没有广告脚本，没有标题劫持；实际支持范围由解析服务决定。</p>
      </section>

      <form id="parse-form" class="parse-form" action="/" method="get" novalidate>
        <label class="sr-only" for="url-input">视频链接</label>
        <div class="input-row">
          <input id="url-input" name="url" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://..." required>
          <button id="submit-button" type="submit">解析</button>
        </div>
      </form>

      <p id="status" class="status" role="status" aria-live="polite"></p>

      <section id="result" class="result" hidden>
        <div class="player-wrap">
          <div id="player" class="player"></div>
        </div>
        <div class="result-body">
          <div class="result-copy">
            <h2 id="video-title">视频</h2>
            <p id="source-url" class="source-url"></p>
          </div>
          <div class="result-actions">
            <span id="expiry" class="expiry"></span>
            <button id="copy-button" type="button" class="ghost-button" disabled>复制 m3u8</button>
          </div>
        </div>
      </section>
    </main>

    <footer class="footer">
      <p>服务端只做解析与地址校验，视频分片由源站 CDN 直接提供。</p>
      <p>请仅解析你有权访问的内容。</p>
    </footer>
  </div>

  <noscript>
    <p class="noscript">需要启用 JavaScript 才能解析和播放。</p>
  </noscript>
</body>
</html>
```

## Appendix C: `public/app.js`

```js
(() => {
  const form = document.querySelector("#parse-form");
  const input = document.querySelector("#url-input");
  const submit = document.querySelector("#submit-button");
  const status = document.querySelector("#status");
  const result = document.querySelector("#result");
  const player = document.querySelector("#player");
  const videoTitle = document.querySelector("#video-title");
  const sourceUrl = document.querySelector("#source-url");
  const expiry = document.querySelector("#expiry");
  const copyButton = document.querySelector("#copy-button");

  let art = null;
  let lastPlayUrl = "";

  function setStatus(message, kind = "") {
    status.textContent = message;
    status.className = kind ? `status ${kind}` : "status";
  }

  function setLoading(loading) {
    submit.disabled = loading;
    submit.textContent = loading ? "解析中…" : "解析";
    form.setAttribute("aria-busy", String(loading));
  }

  function formatExpiry(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const formatted = new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
    return `有效期至 ${formatted}`;
  }

  function destroyPlayer() {
    if (art) {
      art.destroy();
      art = null;
    }
  }

  function playM3u8(video, url, artInstance) {
    if (!window.Hls?.isSupported()) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
        return;
      }
      throw new Error("当前浏览器不支持 HLS 播放");
    }

    const hls = new window.Hls({ enableWorker: true });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.ERROR, (_event, detail) => {
      if (detail?.fatal) {
        setStatus("视频流加载失败，可能已过期，请重新解析。", "error");
        hls.destroy();
      }
    });
    artInstance.once("destroy", () => hls.destroy());
  }

  async function loadDanmaku(endpoint) {
    if (!endpoint) return [];
    const response = await fetch(endpoint, {
      headers: { accept: "application/json" },
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      console.warn("danmaku response was not JSON", err);
    }
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error?.message || "弹幕加载失败");
    }
    return payload.data.items || [];
  }

  function showResult(data) {
    lastPlayUrl = data.playUrl;
    videoTitle.textContent = data.title || "视频";
    sourceUrl.textContent = data.sourceUrl || input.value.trim();
    expiry.textContent = formatExpiry(data.expiresAt);
    copyButton.disabled = false;
    document.title = data.title
      ? `${data.title} · videoshow`
      : "videoshow · 视频解析";

    result.hidden = false;
    destroyPlayer();

    if (!window.Artplayer || !window.artplayerPluginDanmuku) {
      setStatus("播放器资源加载失败，请刷新页面。", "error");
      return;
    }

    const danmakuEndpoint = data.danmaku?.endpoint || "";

    art = new window.Artplayer({
      container: player,
      url: data.playUrl,
      type: data.type,
      poster: data.cover || "",
      title: data.title || "视频",
      autoplay: true,
      setting: true,
      playbackRate: true,
      aspectRatio: true,
      fullscreen: true,
      pip: true,
      hotkey: true,
      autoSize: false,
      theme: "#c6f36b",
      customType: { m3u8: playM3u8 },
      plugins: [
        window.artplayerPluginDanmuku({
          danmuku: () => loadDanmaku(danmakuEndpoint),
          emitter: false,
          theme: "dark",
          fontSize: 25,
          speed: 5,
          opacity: 1,
          antiOverlap: true,
        }),
      ],
    });

    art.on("artplayerPluginDanmuku:loaded", (items) => {
      if (!items?.length) setStatus("本视频暂无弹幕。", "");
    });
    art.on("artplayerPluginDanmuku:error", () => {
      setStatus("弹幕加载失败，播放不受影响。", "error");
    });
    art.on("video:error", () => {
      setStatus("视频加载失败，可能已过期，请重新解析。", "error");
    });

    result.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "start",
    });
  }

  async function parse(url) {
    const response = await fetch(`/api/parse?url=${encodeURIComponent(url)}`, {
      headers: { accept: "application/json" },
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      console.warn("parse response was not JSON", err);
    }

    if (!response.ok || !payload || payload.ok !== true) {
      const message =
        payload?.error?.message || `解析失败（HTTP ${response.status}）`;
      throw new Error(message);
    }

    return payload.data;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = input.value.trim();

    if (!url) {
      setStatus("请输入视频链接。", "error");
      input.focus();
      return;
    }

    setLoading(true);
    setStatus("正在解析，请稍候…", "loading");

    try {
      const data = await parse(url);
      showResult(data);
      setStatus("解析成功。", "");
    } catch (err) {
      setStatus(
        err instanceof Error ? err.message : "解析失败，请稍后重试。",
        "error",
      );
    } finally {
      setLoading(false);
    }
  });

  copyButton.addEventListener("click", async () => {
    if (!lastPlayUrl) return;
    try {
      await navigator.clipboard.writeText(lastPlayUrl);
      setStatus("播放地址已复制。", "");
    } catch {
      setStatus("复制失败，请检查浏览器权限。", "error");
    }
  });

  const initialUrl = new URLSearchParams(window.location.search).get("url");
  if (initialUrl) {
    input.value = initialUrl;
    form.requestSubmit();
  }
})();
```

## Appendix D: `src/config.js` and `src/http.js`

The full config is in Task 2. Add `probeUrl` to `src/http.js` exactly as
shown in Task 2. Keep the existing `fetchText`, `fetchJson`, `USER_AGENT`,
error wrapping, and timeout handling.

## Appendix E: `test/live.test.js`

```js
import test from "node:test";
import assert from "node:assert/strict";
import { fetchDmkuDanmaku } from "../src/danmaku.js";
import { enrichMetadata } from "../src/metadata.js";
import { resolveStream } from "../src/provider.js";
import { normalizeType, validateStream } from "../src/stream.js";

const live = process.env.RUN_LIVE_TESTS === "1";

test(
  "live iQiyi m3u8 and danmaku",
  { skip: !live, timeout: 90_000 },
  async () => {
    const result = await resolveStream("https://www.iqiyi.com/v_19rronibdc.html");
    const type = normalizeType(result.type, result.playUrl);
    assert.equal(type, "m3u8");
    const stream = await validateStream(result.playUrl, type);
    const info = await enrichMetadata(result.sourceUrl, result.playUrl, stream);
    assert.ok(info.title);
    assert.doesNotMatch(info.title, /泽御云|zeyuyun|官网/i);
    const danmaku = await fetchDmkuDanmaku(result.sourceUrl);
    assert.ok(danmaku.count > 0);
  },
);

test(
  "live Bilibili mp4 and empty dmku",
  { skip: !live, timeout: 90_000 },
  async () => {
    const result = await resolveStream("https://www.bilibili.com/video/BV1JP41167xK");
    const type = normalizeType(result.type, result.playUrl);
    assert.equal(type, "mp4");
    await validateStream(result.playUrl, type);
    const danmaku = await fetchDmkuDanmaku(result.sourceUrl);
    assert.equal(danmaku.count, 0);
  },
);
```

## Appendix F: `test/server.test.js`

```js
import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/errors.js";
import { createServer } from "../src/server.js";

const SAMPLE = "https://www.bilibili.com/video/BV1JP41167xK";
const IQIYI = "https://www.iqiyi.com/v_19rronibdc.html";
const silentLogger = { info() {}, warn() {}, error() {} };

function fakeResult(overrides = {}) {
  return {
    sourceUrl: SAMPLE,
    playUrl: "https://media.example/video.m3u8",
    type: "m3u8",
    expiresAtMs: Date.now() + 10 * 60 * 1000,
    provider: "test",
    ...overrides,
  };
}

async function start(t, overrides = {}) {
  const server = createServer({
    resolve: async () => fakeResult(),
    validate: async () => ({ playlist: "#EXTM3U" }),
    enrich: async () => ({ title: "测试视频", cover: null }),
    fetchDanmaku: async () => ({
      provider: "dmku",
      count: 1,
      items: [{ time: 1, mode: 0, color: "#FFFFFF", text: "弹幕" }],
    }),
    logger: silentLogger,
    ...overrides,
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

async function getJson(url, options) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(5000),
  });
  return { response, body: await response.json() };
}

test("GET /api/parse returns an m3u8 payload with danmaku endpoint", async (t) => {
  const { base } = await start(t);
  const { response, body } = await getJson(
    `${base}/api/parse?url=${encodeURIComponent(IQIYI)}`,
  );
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.type, "m3u8");
  assert.equal(body.data.title, "测试视频");
  assert.equal(body.data.cached, false);
  assert.ok(body.data.danmaku.endpoint.startsWith("/api/danmaku?url="));
  assert.ok(!JSON.stringify(body).includes("泽御云"));
});

test("GET /api/parse supports mp4 results", async (t) => {
  const { base } = await start(t, {
    resolve: async () =>
      fakeResult({
        playUrl: "https://media.example/video.mp4",
        type: "mp4",
      }),
    validate: async () => ({ playlist: null }),
  });
  const { response, body } = await getJson(
    `${base}/api/parse?url=${encodeURIComponent(SAMPLE)}`,
  );
  assert.equal(response.status, 200);
  assert.equal(body.data.type, "mp4");
  assert.equal(body.data.sourceUrl, SAMPLE);
});

test("parse cache returns cached true and calls resolve once", async (t) => {
  let calls = 0;
  let clock = 1_000_000;
  const { base } = await start(t, {
    resolve: async () => {
      calls += 1;
      return fakeResult({ expiresAtMs: clock + 60 * 60 * 1000 });
    },
    validate: async () => ({ playlist: "#EXTM3U" }),
    enrich: async () => ({ title: null, cover: null }),
    now: () => clock,
    cacheTtlMs: 60_000,
  });
  const url = `${base}/api/parse?url=${encodeURIComponent(IQIYI)}`;
  const first = await getJson(url);
  const second = await getJson(url);
  assert.equal(calls, 1);
  assert.equal(first.body.data.cached, false);
  assert.equal(second.body.data.cached, true);
  clock += 61_000;
  const third = await getJson(url);
  assert.equal(calls, 2);
  assert.equal(third.body.data.cached, false);
});

test("GET /api/danmaku returns normalized items and caches", async (t) => {
  let calls = 0;
  const { base } = await start(t, {
    fetchDanmaku: async () => {
      calls += 1;
      return {
        provider: "dmku",
        count: 1,
        items: [{ time: 1, mode: 0, color: "#FFFFFF", text: "弹幕" }],
      };
    },
  });
  const url = `${base}/api/danmaku?url=${encodeURIComponent(IQIYI)}`;
  const first = await getJson(url);
  const second = await getJson(url);
  assert.equal(first.response.status, 200);
  assert.equal(first.body.data.count, 1);
  assert.equal(first.body.data.items[0].text, "弹幕");
  assert.equal(first.body.data.cached, false);
  assert.equal(second.body.data.cached, true);
  assert.equal(calls, 1);
});

test("GET /api/danmaku returns an empty collection", async (t) => {
  const { base } = await start(t, {
    fetchDanmaku: async () => ({ provider: "dmku", count: 0, items: [] }),
  });
  const { response, body } = await getJson(
    `${base}/api/danmaku?url=${encodeURIComponent(SAMPLE)}`,
  );
  assert.equal(response.status, 200);
  assert.equal(body.data.count, 0);
  assert.deepEqual(body.data.items, []);
});

test("GET /api/danmaku surfaces upstream failure", async (t) => {
  const { base } = await start(t, {
    fetchDanmaku: async () => {
      throw new AppError("DANMAKU_UPSTREAM_ERROR", 502, "弹幕服务暂不可用");
    },
  });
  const { response, body } = await getJson(
    `${base}/api/danmaku?url=${encodeURIComponent(IQIYI)}`,
  );
  assert.equal(response.status, 502);
  assert.equal(body.error.code, "DANMAKU_UPSTREAM_ERROR");
});

test("GET /api/parse rejects missing and non-http URLs", async (t) => {
  const { base } = await start(t);
  const missing = await getJson(`${base}/api/parse`);
  assert.equal(missing.response.status, 400);
  assert.equal(missing.body.error.code, "INVALID_URL");
  const ftp = await getJson(
    `${base}/api/parse?url=${encodeURIComponent("ftp://example.com/video")}`,
  );
  assert.equal(ftp.response.status, 400);
  assert.equal(ftp.body.error.code, "INVALID_URL");
});

test("POST /api/parse returns method not allowed", async (t) => {
  const { base } = await start(t);
  const response = await fetch(`${base}/api/parse`, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json();
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
  assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
});

test("GET /api/health reports service status", async (t) => {
  const { base } = await start(t);
  const { response, body } = await getJson(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, "videoshow");
});

test("GET / serves a generic ad-free player", async (t) => {
  const { base } = await start(t);
  const response = await fetch(`${base}/`, {
    signal: AbortSignal.timeout(5000),
  });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(html, /videoshow/);
  assert.doesNotMatch(html, /爱奇艺|iqiyi/i);
  assert.doesNotMatch(html, /f3531\.top|trafficmanager|zeyuyun/i);
  assert.match(
    response.headers.get("content-security-policy"),
    /style-src 'self' 'unsafe-inline'/,
  );
  assert.match(
    response.headers.get("content-security-policy"),
    /img-src 'self' data: https:/,
  );
});

test("player vendor assets are served", async (t) => {
  const { base } = await start(t);
  for (const asset of [
    "/vendor/hls.min.js",
    "/vendor/artplayer.js",
    "/vendor/artplayer-plugin-danmuku.js",
  ]) {
    const response = await fetch(`${base}${asset}`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /javascript/);
    assert.ok((await response.text()).length > 1000);
  }
});

test("unknown API and static paths return 404", async (t) => {
  const { base } = await start(t);
  const apiResponse = await fetch(`${base}/api/nope`, {
    signal: AbortSignal.timeout(5000),
  });
  const apiBody = await apiResponse.json();
  assert.equal(apiResponse.status, 404);
  assert.equal(apiBody.error.code, "NOT_FOUND");
  const staticResponse = await fetch(`${base}/nope`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(staticResponse.status, 404);
});
```

## Appendix G: README outline

Use these sections:

```text
# videoshow
## 功能
## 快速开始
## HTTP API
### GET /api/parse
### GET /api/danmaku
### GET /api/health
## 实现结构
## 配置
## 测试
## 目录
## 说明与边界
```

Required facts:

- any `http(s)` video page URL; no platform allowlist
- supported stream types: m3u8 and mp4
- Artplayer + official danmaku plugin
- dmku read-only; Bilibili danmaku may be empty
- optional iQiyi metadata adapter; unknown platforms return null title/cover
- no ads, no video proxy
- live tests opt-in
