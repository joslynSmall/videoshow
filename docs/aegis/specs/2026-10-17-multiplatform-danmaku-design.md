# 多平台视频解析与弹幕播放器设计

- Date: `2026-10-17`
- Status: `proposed`
- Approval: design direction confirmed by the user; spec review pending
- Scope: `videoshow` Node.js HTTP service and browser player

## 1. Context and Evidence

Current state:

- The service accepts only `iqiyi.com` URLs.
- `/api/parse` returns an m3u8 URL, optional iQiyi title/cover, and no danmaku.
- The player is a native `<video>` element with hls.js; it has no danmaku UI.
- The upstream parser is `api-api.789jiexi.net`.

Measured evidence:

- The iQiyi sample resolves to an m3u8 stream and 1463 valid dmku danmaku.
- The Bilibili sample resolves to an mp4 stream, proving the upstream is not
  iQiyi-only.
- The dmku endpoint `https://jx.1ljx.com/dan/@lirose_tv/?url=<encoded>` is
  CORS-open and returns a compact `danmuku` array with empty placeholders.
- For the Bilibili sample, dmku returned 51 entries but zero valid items; the
  empty-danmaku state is a real outcome to design for.
- Artplayer's official `artplayer-plugin-danmuku` accepts an array, XML, or an
  async function, and supports mode/color/opacity/speed settings.

User decisions:

- Accept any `http(s)` video page URL; do not add a platform allowlist.
- Reuse the dmku danmaku source in read-only mode.
- Do not design the system as an iQiyi-only product.

## 2. Goals and Non-goals

### 2.1 Goals

- G1: Parse any `http(s)` video page URL through the existing upstream parser.
- G2: Support both `m3u8` and `mp4` play URLs, with type-aware validation.
- G3: Replace the native player with Artplayer plus the official danmaku plugin.
- G4: Add `GET /api/danmaku?url=...`, normalize dmku data, and cache it.
- G5: Keep the service ad-free and keep all copy, fields, errors, and tests
  platform-neutral.

### 2.2 Non-goals

- Danmaku sending or persistence.
- A `danmu_api` sidecar or additional danmaku providers.
- Additional metadata adapters in the first iteration.
- FLV support in the first iteration.
- Video proxying or media re-hosting.
- User accounts, auth, or rate limiting in the first iteration.

## 3. Platform-Neutral Constraint

This is a first-class design constraint, not a documentation note.

- `src/provider.js` has no platform host check; it validates only `http/https`,
  non-empty input, and length.
- `src/stream.js`, `src/danmaku.js`, `src/server.js`, and the player have no
  iQiyi branches.
- Metadata is optional and adapter-based:
  - `src/metadata/index.js` dispatches by host and returns `{ title: null,
    cover: null }` when no adapter matches or the adapter fails.
  - `src/metadata/iqiyi.js` is one optional adapter, not a core dependency.
- API fields are generic: no `iqiyi` property, no iQiyi-only error code, and no
  iQiyi-only response branch.
- Config names are scoped: the iQiyi adapter may use
  `METADATA_IQIYI_URL`; the core uses generic names such as
  `DANMAKU_BASE_URL`.
- CSP does not hardcode `*.iqiyipic.com`; the page permits HTTPS images
  generically (`img-src 'self' data: https:`).
- UI copy, placeholder, and errors are generic; examples may mention multiple
  platforms but no platform is the implied default.
- Tests and acceptance use iQiyi (m3u8) and Bilibili (mp4) as equal fixtures.
- dmku is a generic URL-based danmaku provider. Its current iQiyi coverage is a
  data fact, not an architectural assumption.

## 4. Architecture

```text
Browser
  │  GET /api/parse?url=...
  ▼
src/server.js
  ├─ src/provider.js      any http(s) URL → upstream player page → api.php → AES decrypt
  ├─ src/stream.js        type-aware validation and expiry extraction
  ├─ src/metadata/        optional adapters; iQiyi adapter; null for unknown
  └─ GET /api/danmaku
       └─ src/danmaku.js  dmku → filter/sort/map → normalized items
  ▼
public/app.js + Artplayer + hls.js + artplayer-plugin-danmuku
  ├─ type=m3u8 → hls.js custom type
  ├─ type=mp4  → native Artplayer playback
  └─ danmaku async from /api/danmaku; failures do not block playback
```

### 4.1 Module Responsibilities

- `src/provider.js`
  - `normalizeVideoUrl(raw)`: http/https, non-empty, max length; no host list.
  - Existing upstream config extraction and AES decrypt remain.
  - Return `{ sourceUrl, playUrl, type, expiresAtMs, provider }`.
- `src/stream.js`
  - `normalizeType(type, playUrl)`: `m3u8` or `mp4`; unknown types return a
    clear unsupported error.
  - `validateStream(playUrl, type)`: m3u8 GET and `#EXTM3U`; mp4 HEAD or Range
    GET and 200/206; no full media download.
  - `extractExpiry(playUrl)`: parse `deadline`/`expire` when upstream expiry is
    absent or zero.
- `src/metadata/index.js`
  - `enrichMetadata(sourceUrl, playUrl)`: iterate adapters; return null fields
    when none match or an adapter fails.
- `src/metadata/iqiyi.js`
  - Optional iQiyi adapter using the existing tvid/vid lookup.
- `src/danmaku.js`
  - `fetchDmkuDanmaku(sourceUrl)`: GET `DANMAKU_BASE_URL?url=<encoded>`.
  - `normalizeDmkuResponse(json)`: filter empty/invalid entries, map modes and
    colors, sort by time.
  - Return `{ provider: "dmku", count, items }`.
- `src/server.js`
  - Routes, parse cache, danmaku cache, static assets, error translation.
- `public/app.js`
  - Artplayer lifecycle, type-aware playback, async danmaku, UI states.

### 4.2 Expiry and Cache

- Use `expire_time` or a positive `expires_in` when available.
- Treat `expires_in: 0` as unknown, not expired.
- Fall back to `deadline` or `expire` query parameters in the play URL.
- If no expiry is found, `expiresAt` is `null`.
- Parse cache: 5 minutes, never beyond the stream expiry.
- Danmaku cache: 5 minutes, keyed by normalized source URL.

## 5. API Contract

### 5.1 `GET /api/parse?url=<encoded>`

```json
{
  "ok": true,
  "data": {
    "sourceUrl": "https://www.bilibili.com/video/BV...",
    "playUrl": "https://...",
    "type": "m3u8 | mp4",
    "title": "真实标题或 null",
    "cover": "封面或 null",
    "expiresAt": "ISO 时间或 null",
    "provider": "jiexi789",
    "cached": false,
    "danmaku": {
      "provider": "dmku",
      "endpoint": "/api/danmaku?url=<encoded sourceUrl>"
    }
  }
}
```

- `title` and `cover` are nullable and platform-neutral.
- The upstream advertisement `title` is never returned.
- `danmaku` is additive; older clients may ignore it.

### 5.2 `GET /api/danmaku?url=<encoded>`

```json
{
  "ok": true,
  "data": {
    "provider": "dmku",
    "count": 1463,
    "cached": false,
    "items": [
      { "time": 1, "mode": 0, "color": "#ffffff", "text": "弹幕文本" }
    ]
  }
}
```

- `mode`: 0 = scrolling, 1 = top, 2 = bottom.
- dmku returns no valid items: HTTP 200, `count: 0`, `items: []`; the UI shows
  "本视频暂无弹幕".
- dmku request fails: HTTP 502 with `DANMAKU_UPSTREAM_ERROR`; the player keeps
  playing and shows a non-blocking warning.
- Cache: 5 minutes by default.

### 5.3 Error Envelope

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_URL | PARSE_FAILED | UPSTREAM_ERROR | STREAM_INVALID | UNSUPPORTED_STREAM_TYPE | DANMAKU_UPSTREAM_ERROR",
    "message": "用户可读的错误信息"
  }
}
```

- Error messages contain no platform allowlist language and no upstream ad
  copy.
- Unsupported stream types produce a clear error, not a 500.

## 6. Player and UI

- Replace the `<video>` element with an Artplayer container.
- Vendor Artplayer, `artplayer-plugin-danmuku`, and hls.js with their licenses.
- Artplayer configuration:
  - `url: playUrl`, `type: data.type`
  - `customType.m3u8` uses hls.js
  - `poster: data.cover`, `title: data.title || "视频"`
  - Enable `setting`, `playbackRate`, `aspectRatio`, `fullscreen`, `pip`,
    `hotkey`, and `autoSize`.
  - `plugins: [artplayerPluginDanmuku({ danmuku: async () => fetch(endpoint),
    emitter: false })]`
- Destroy the previous Artplayer instance before creating a new one.
- Danmaku states:
  - Loading: non-blocking "弹幕加载中".
  - Empty: "本视频暂无弹幕".
  - Error: "弹幕加载失败，播放不受影响".
- The emitter is disabled; danmaku is read-only.
- Page copy:
  - Title and description use "视频解析", not a single-platform label.
  - Input placeholder uses a generic `https://...` example; supporting copy may
    mention multiple platforms as examples.
  - Error text uses "视频链接".
- CSP:
  - Scripts remain same-origin.
  - `img-src 'self' data: https:` supports adapter covers without a platform
    host list.
  - `style-src 'self' 'unsafe-inline'` is the planned rule because
    Artplayer/plugin inject style elements; `script-src 'self'` remains
    restricted. Tightening to `'self'` is allowed only if the player renders
    correctly without inline styles.

## 7. Failure, Security, and Compatibility

- Upstream errors: return 502; log only status codes, never ad copy.
- Unsupported type: return `UNSUPPORTED_STREAM_TYPE`; the UI explains the
  supported formats.
- dmku errors: isolated to `/api/danmaku`; parse and playback continue.
- URL validation: only `http/https`, non-empty, and length; no platform
  allowlist.
- Fixed external hosts:
  - upstream parser base URL
  - optional metadata adapter URL
  - dmku base URL
- The server does not fetch arbitrary source pages; it only passes the URL to
  the fixed upstream/dmku services and fetches fixed metadata APIs.
- No ad scripts, no ad title relay, no third-party analytics.
- Compatibility:
  - `/api/parse` keeps existing fields.
  - `type` may now be `mp4`; clients must branch by type.
  - `title`/`cover` may be `null`.
  - `danmaku` is additive.
  - `/api/health` is unchanged.
  - No persistent data or migration.

## 8. Testing and Acceptance

Unit tests:

- URL normalization accepts iQiyi, Bilibili, Youku, and arbitrary http(s)
  hosts; rejects empty and non-http(s).
- dmku normalization filters empty arrays, missing text, and non-numeric time;
  maps `top`/`bottom`/`right`; sorts by time.
- Expiry extraction handles positive `expires_in`, zero `expires_in` plus a
  `deadline` query parameter, and no expiry.
- Stream validation dispatches m3u8 and mp4 correctly with a fake transport.

Server tests:

- `/api/parse` returns m3u8 and mp4 shapes with a fake resolver.
- `/api/danmaku` returns normalized items and a cached second response.
- dmku empty/error paths.
- Unsupported URL and unsupported stream type errors.
- Home page contains no ad domains and no iQiyi-only copy.

Live tests (opt-in):

- iQiyi sample: m3u8, playable, danmaku count > 0.
- Bilibili sample: mp4, playable, danmaku count 0 with the empty state.
- Assert the upstream advertisement title is absent.

Browser checks:

- Artplayer renders and plays m3u8 and mp4.
- Controls and danmaku toggle are present.
- Empty/error danmaku states do not block playback.
- Desktop and mobile widths, light/dark if applicable.

Acceptance criteria:

- A1: iQiyi URL returns m3u8 and danmaku > 0.
- A2: Bilibili URL returns mp4 and an explicit empty-danmaku state.
- A3: an arbitrary unsupported URL returns a clear error, not a 500.
- A4: no ad domains or ad title in page/API/log output.
- A5: Artplayer controls and danmaku settings are usable.
- A6: core files, copy, and tests contain no iQiyi-only branches or allowlist.

## 9. Existence Check and Complexity

Existence check:

- New `/api/danmaku` and `src/danmaku.js`: the parse API has no danmaku; direct
  browser access to dmku would lack normalization, caching, and error handling.
  Add with proof. Retire or replace if dmku becomes unavailable.
- Artplayer: the native player has no danmaku and no mp4 support; Artplayer
  plus its official plugin is the smallest proven replacement. Reuse the
  existing hls.js. No new backend service.
- Metadata adapters: the existing iQiyi logic moves behind an optional adapter;
  no new external service and no core dependency.

Complexity:

- New files: `src/stream.js`, `src/danmaku.js`, `src/metadata/index.js`,
  `src/metadata/iqiyi.js`.
- Modified files: `src/provider.js`, `src/config.js`, `src/server.js`,
  `public/index.html`, `public/app.js`, `public/styles.css`, tests, README.
  `src/metadata.js` is replaced by `src/metadata/index.js` and
  `src/metadata/iqiyi.js`.
- Vendor additions: Artplayer and `artplayer-plugin-danmuku`.
- Assessment: moderate, within a small service; at-risk but manageable.
  Keep `server.js` as routing/caching orchestration and extract stream/danmaku
  logic into dedicated modules.

Prior art and reuse:

- Artplayer plus its official plugin (MIT) reuses a maintained player and
  danmaku renderer instead of building a custom overlay.
- dmku reuses the danmaku source already used by the user's userscript.
- No `danmu_api` sidecar is added; that is the user's decision.

ADR signal and baseline alignment:

- Durable surfaces: player ownership, the new `/api/danmaku` contract, and the
  third-party dmku dependency.
- No ADR is created from an unexecuted design. After implementation, record an
  ADR if the dmku dependency and the player/API contract remain stable.
- Product baseline: this spec's goals, non-goals, and acceptance criteria.
- Architecture baseline: provider, stream, metadata, danmaku, server, and
  player owners described above.
- Result: aligned; scope: both.

## 10. Risks and Accepted Trade-offs

- dmku is a third-party service; availability and coverage can change.
- Bilibili danmaku is empty with the chosen dmku source; v1 accepts this and
  shows "暂无弹幕".
- Artplayer/plugin style injection requires a CSP style relaxation; this is
  accepted in the design. Script execution remains same-origin.
- Vendored player assets increase page weight.
- Upstream parse coverage varies by site; unsupported sites must fail clearly.
- Terms-of-service and copyright risk remain the operator's responsibility.

## 11. Implementation Outline

The detailed implementation plan will be produced by `writing-plans`.

1. Generic URL normalization and provider changes.
2. Type-aware stream validation and expiry extraction.
3. Optional metadata adapter boundary; retain iQiyi as one adapter.
4. dmku danmaku module and `/api/danmaku` route.
5. Artplayer player replacement and danmaku plugin integration.
6. Tests, live checks, browser QA, and documentation updates.

## 12. Decision

- Approved direction: platform-neutral parsing, Artplayer plus the official
  danmaku plugin, dmku read-only danmaku, `m3u8`/`mp4` support.
- The system is not designed as an iQiyi-only product; iQiyi is one platform
  example and one optional metadata adapter.
- Spec review is the remaining gate before `writing-plans`.

## References

- Artplayer danmaku plugin: https://artplayer.org/document/plugin/danmuku
- dmku endpoint: https://jx.1ljx.com/dan/@lirose_tv/?url=<encoded>
- Upstream parser: https://api-api.789jiexi.net
