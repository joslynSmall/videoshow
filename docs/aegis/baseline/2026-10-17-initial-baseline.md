# videoshow Initial Baseline

Date: `2026-10-17`
Status: `initial dual-baseline snapshot`

## 1. Purpose

- Record the starting product and architecture truth before the multi-platform
  and danmaku redesign.
- Give later alignment checks a reference for what must be preserved and what
  is intentionally changing.

## 2. Workspace Structure

- `src/`: Node.js HTTP service, upstream provider, metadata, logging, config.
- `public/`: player page, client script, styles, vendored hls.js.
- `test/`: provider and server tests.
- `README.md`: current usage and API documentation.
- `docs/aegis/`: this workspace.

## 3. Current Authority Surfaces

- `README.md` is the current product/API description.
- `package.json` defines the Node.js runtime and scripts.
- `docs/aegis/specs/2026-10-17-multiplatform-danmaku-design.md` is the proposed
  design for the next change.
- No git repository, ADR, or prior baseline exists in this directory.
- Authority gap: no formal product requirements beyond the current thread and
  README.

## 4. Product / Requirement Baseline

### 4.1 Current Truth

- Current service accepts only `iqiyi.com` video URLs.
- Current service returns an m3u8 play URL and optional iQiyi title/cover.
- Current player is a native `<video>` element with hls.js; no danmaku.
- Current API has no danmaku endpoint or danmaku fields.
- External parsing is delegated to `api-api.789jiexi.net`.
- Target state: accept any `http(s)` video page URL; support `m3u8` and `mp4`;
  use Artplayer with the official danmaku plugin; add a read-only dmku danmaku
  API; keep the system platform-agnostic.
- Target users: local/self-hosted users opening the page in a browser.
- Acceptance: iQiyi m3u8 playback plus danmaku; Bilibili mp4 playback with an
  explicit empty-danmaku state; unsupported URLs fail clearly; no ad content.

### 4.2 Non-negotiables

1. Never inject ads or relay the upstream advertisement `title`.
2. The core parse/player/danmaku path must not be iQiyi-specific or use a
   platform allowlist.
3. Existing `/api/parse` fields remain available; new fields are additive.
4. Video segments remain direct from the source CDN; no video proxy.
5. Fixed external hosts for upstream parsing, metadata, and dmku; no arbitrary
   source-page fetch from this server.

### 4.3 Product Non-goals

- Danmaku sending or persistence.
- A `danmu_api` sidecar or additional danmaku providers.
- Additional metadata adapters beyond the optional iQiyi adapter.
- FLV support in the first iteration.
- User accounts, auth, or rate limiting in the first iteration.

## 5. Architecture / Runtime Boundary Baseline

### 5.1 Current Truth

- `src/provider.js`: upstream player-page config, `api.php` POST, AES decrypt,
  iQiyi URL allowlist.
- `src/metadata.js`: m3u8 validation plus iQiyi tvid/vid metadata lookup.
- `src/server.js`: native Node HTTP server, parse cache, static files.
- `public/app.js`: native video element, hls.js only.
- External owners: `api-api.789jiexi.net` (parse), `pcw-api.iqiyi.com`
  (metadata), source CDNs (media).
- Planned owners: generic provider, `src/stream.js`, optional metadata adapter
  registry, `src/danmaku.js`, Artplayer player.

### 5.2 Architecture Non-negotiables

1. Core modules must not branch on iQiyi except inside the optional metadata
   adapter.
2. Stream validation must dispatch by `type`; no m3u8-only assumption.
3. Metadata failure or absence must not block parsing or playback.
4. dmku failure must not block parsing or playback.
5. The browser player and API contracts must stay same-origin and ad-free.

### 5.3 Architecture Non-goals

- No new backend service.
- No database or persistent schema.
- No video proxy or media re-hosting.

## 6. Ownership / Contract Snapshot

- `/api/parse`: owned by `src/server.js`; data from provider, stream, metadata.
- `/api/danmaku`: owned by `src/server.js`; data from `src/danmaku.js`.
- Player: owned by `public/app.js` with Artplayer plus the official plugin.
- Upstream parse: external `jiexi789` service.
- Danmaku data: external dmku endpoint `https://jx.1ljx.com/dan/@lirose_tv/`.

## 7. Current State and Risks

- The service is running locally on port 3000 during development.
- Unit tests pass; live upstream tests are opt-in.
- Known risks: dmku availability and coverage, empty Bilibili danmaku, Artplayer
  CSP/style injection, vendored asset size, upstream coverage variance, and
  third-party terms of service.

## 8. Alignment Use

- Read the Product / Requirement Baseline for scope, copy, and acceptance.
- Read the Architecture / Runtime Boundary Baseline for module ownership,
  contracts, and dependency direction.
- Use both for cross-cutting API/player changes.

## 9. Compatibility Boundary

- `/api/parse` keeps its existing fields; `type` may now be `mp4`, and
  `title`/`cover` may be `null`.
- The new `danmaku` field is additive.
- `/api/health` remains unchanged.
- No persistent data or migration surface exists.
