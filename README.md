# videoshow

一个平台中性的视频解析 HTTP 服务。粘贴视频页链接，服务端解析出可播放的 `m3u8` 或 `mp4`，浏览器用 Artplayer 播放；支持从 dmku 获取只读弹幕。没有广告脚本，也不使用上游返回的推广标题。

## 功能

- 接受任意 `http(s)` 视频页链接，不做平台域名白名单
- 支持 `m3u8` 与 `mp4`，按类型校验播放地址
- 多源并发竞速与自动测速选源：验证媒体后测量分片吞吐与延迟；卡顿时在已验证的线路间自动换源
- HTTP 解析渠道默认启用：LX、789 页面入口、冰豆、麒麟；LX/麒麟适配播放器配置接口，789 页面入口复用内置上游，冰豆通过无头 Chrome 回退取 MP4
- jx-browser 按媒体后缀识别 `m3u8`/`mp4`，B 站等 MP4 源不会被误当成 HLS 播放清单
- 单次签名链接不预读：LX/麒麟返回的媒体地址标记 `singleUse`，由浏览器首次读取，避免服务端校验/测速耗尽签名
- Artplayer + 官方 `artplayer-plugin-danmuku`，支持弹幕显示/隐藏、字号、速度、透明度
- 选集栏提供“自动下一集”开关，播放结束后续播下一集，偏好保存在浏览器本地
- 播放器倍速覆盖 `0.5x`–`3.0x`，其中 `1.0x`–`2.0x` 按 `0.1` 递增；弹幕默认字号为 `20`
- 全集弹层长标题自动换行，避免横向溢出
- 新增 `GET /api/danmaku?url=...`，代理 dmku、清洗脏数据并按时间排序
- 可选的爱奇艺元数据适配器：能取到真实标题/封面；其他平台返回 `null`
- 无广告注入，不加载第三方广告/统计脚本
- 播放器优先直连源站；浏览器直连失败时，现有 `/api/media` 可有限地中转分片
- 零运行时依赖，Node.js 22 原生 `http` + `fetch`

## 快速开始

要求 Node.js >= 20。

```bash
cd /home/joslyn/code/github_me/videoshow
npm start
```

打开 <http://127.0.0.1:3000>，粘贴视频页链接。示例：

```text
https://www.iqiyi.com/v_19rronibdc.html
https://www.bilibili.com/video/BV1JP41167xK
```

内置 `jiexi789` 与四个 HTTP 渠道默认启用，无需额外配置。使用腾讯视频样例地址
`https://v.qq.com/x/cover/mzc0020098xcllx/e4102s0t1jg.html` 实测：

- LX、麒麟可取得 HLS 地址；服务端不预读该地址，返回 `singleUse: true`，由浏览器首次读取。
  无头 Chrome 实测播放到 1920×1080，清单与分片请求均成功。
- 789 页面入口最终指向与内置 `jiexi789` 相同的上游；两者返回相同媒体地址时按 URL 去重。
- 冰豆入口进入 `jiexi.bot.cd/jx/` 的 WASM 播放器；无头 Chrome 执行页面后取得 ByteDance CDN 的
  直接 MP4（1920×1080，`video/mp4`，Range 206），作为回退渠道。最终页面标题可能显示“404”，
  但播放器实际可用；该渠道需要 `ENABLE_BROWSER_PROVIDER` 和可用的 Chrome。
- 冰豆是回退渠道：只有其他渠道都没有可用候选时才会启动无头 Chrome，避免每次解析都拉起浏览器。

`HTTP_PROVIDER_IDS` 未设置时启用全部渠道；显式设置为空字符串可全部关闭；也可以逗号分隔选择
`lx`、`jiexi789-page`、`bingdou`、`qilin`。`HTTP_PROVIDER_TIMEOUT_MS` 默认 12000 毫秒，
是每个 HTTP 渠道从入口到返回媒体地址的总预算；冰豆的浏览器回退使用独立的 30 秒上限。
四个入口共用有界 HTTP 请求流程，每次响应不超过 256 KiB。

LX、麒麟适配器只读取公开页面中的 `playerConfig.apiToken` 字符串字面量，再请求同站
`api/resolve.php`；不执行页面脚本、不携带浏览器 Cookie、不缓存或输出令牌，也不跟随接口重定向。
789 页面入口只跟随 `*.789jiexi.com` / `*.789jiexi.net` 的 iframe 链路，并复用内置上游取流逻辑。
第三方响应格式可能变化。

LX/麒麟的媒体地址带临时签名，重复读取次数有限（联调中观察到约两次成功、之后 404）；
冰豆返回的 ByteDance MP4 也是带 `x-expires`/`x-signature` 的临时地址。
因此服务端不执行 `validateStream` 或分片测速，而是把地址标记为 `singleUse: true`、`verified: false`
交给浏览器；已验证线路存在时优先选择已验证线路，单次链接作为备用。`/api/race` 也不会预读这些地址。
如果上游恢复为可重复读取，仍可继续使用；只是无法在服务端提前测速。

本机系统 DNS 将部分媒体域名解析为 `198.18.x.x`（Fake-IP）。`MEDIA_DNS_MODE` 默认 `auto`：
先使用系统解析；若答案包含私网或 Fake-IP，再通过固定 Google DoH 查询公网 IPv4，检查全部答案后
将连接固定到已校验的地址，保留原始 Host 和 TLS 证书验证。`public` 强制使用 DoH，`system` 禁用回退。
每次重定向仍须重新检查目标；私网、环回及 Fake-IP 地址仍被拒绝。DoH 查询最多 5 秒、响应不超过
16 KiB，缓存遵守 TTL、最长 30 秒、最多 128 个域名。`auto` 需要能够访问 `https://dns.google/resolve`；
无法访问时会保留系统答案，随后仍按媒体安全检查拒绝 Fake-IP。公网 DNS 无法修复上游媒体本身的 404。

需要强制公网 DNS 或只启用单个渠道时：

```bash
MEDIA_DNS_MODE=public HTTP_PROVIDER_IDS=qilin \
  HTTP_PROVIDER_TIMEOUT_MS=15000 BENCHMARK_TIMEOUT_MS=10000 \
  ENABLE_BROWSER_PROVIDER=false npm start
```

也可以直接带参数自动解析：

```text
http://127.0.0.1:3000/?url=https%3A%2F%2Fwww.iqiyi.com%2Fv_19rronibdc.html
```

默认只监听 `127.0.0.1`。需要局域网访问时：

```bash
HOST=0.0.0.0 PORT=3000 npm start
```

## HTTP API

### `GET /api/parse?url=<encoded-video-url>`

```bash
curl -s 'http://127.0.0.1:3000/api/parse?url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1JP41167xK'
```

```json
{
  "ok": true,
  "data": {
    "sourceUrl": "https://www.bilibili.com/video/BV1JP41167xK",
    "playUrl": "https://...",
    "type": "mp4",
    "title": null,
    "cover": null,
    "expiresAt": "2026-10-17T17:26:49.000Z",
    "provider": "jx-browser",
    "singleUse": false,
    "verified": true,
    "candidates": [
      {
        "provider": "jx-browser",
        "speedKBps": 2483,
        "ttfbMs": 88,
        "available": true,
        "selected": true,
        "verified": true,
        "singleUse": false
      },
      {
        "provider": "jiexi789",
        "speedKBps": 263,
        "ttfbMs": 1159,
        "available": true,
        "selected": false,
        "verified": true,
        "singleUse": false
      }
    ],
    "cached": false,
    "danmaku": {
      "provider": "dmku",
      "endpoint": "/api/danmaku?url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1JP41167xK"
    }
  }
}
```

- `type` 可能是 `m3u8` 或 `mp4`。
- `title`/`cover` 可能为 `null`；目前只有可选的爱奇艺适配器会填充。
- 上游返回的广告 `title` 永远不会被透传。
- `danmaku.endpoint` 是相对地址，前端直接请求。
- `singleUse`/`verified`：选中地址是否为单次签名链接，以及是否经过服务端媒体校验。
  `singleUse: true` 表示服务端没有预读该地址，浏览器应只读取一次。
- `playUrl` 优先为验证和测速均通过的选中地址；没有已验证线路时才返回单次链接。
  `candidates` 中测速失败的地址标记为 `available: false`、`selected: false`，客户端不能将其作为可用备用。
  单次链接候选标记为 `singleUse: true`、`verified: false`、`available: true`，可作为换线备用。
  全部线路不可用时返回 `502`。

### `POST /api/race`

换线重测仅接受已解析页面的服务端缓存候选：

```json
{ "sourceUrl": "https://www.iqiyi.com/v_demo.html", "failedPlayUrls": ["https://cdn.example/video.m3u8"] }
```

返回的 `data.selected` 为剩余线路的最佳可用候选，或 `null`。
`data.filtered` 给出候选过滤情况：`total`、`excluded`、`expired`、`remaining`。
无剩余候选时客户端会重新解析一次，以刷新单次签名地址。
已验证候选会重新测速；单次链接候选直接返回，不发起媒体请求，避免消耗签名。
缓存过期返回 `409 PARSE_EXPIRED`，客户端重新调用 `/api/parse`。
原来提交任意 `candidates` 地址的 POST 和 `sources` GET 不再支持。

### `GET /api/danmaku?url=<encoded-video-url>`

```bash
curl -s 'http://127.0.0.1:3000/api/danmaku?url=https%3A%2F%2Fwww.iqiyi.com%2Fv_19rronibdc.html'
```

```json
{
  "ok": true,
  "data": {
    "provider": "dmku",
    "count": 1453,
    "cached": false,
    "items": [
      { "time": 1, "mode": 0, "color": "#FFFFFF", "text": "弹幕文本" }
    ]
  }
}
```

- `mode`：0 滚动、1 顶部、2 底部。
- 无有效弹幕时返回 `200`、`count: 0`、`items: []`；页面显示“本视频暂无弹幕”。
- dmku 请求失败时返回 `502` 和 `DANMAKU_UPSTREAM_ERROR`；播放不受影响。

### `GET /api/health`

```json
{ "ok": true, "service": "videoshow", "uptime": 12 }
```

错误响应：

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_URL | PARSE_FAILED | UPSTREAM_ERROR | STREAM_INVALID | UNSUPPORTED_STREAM_TYPE | DANMAKU_UPSTREAM_ERROR",
    "message": "用户可读的错误信息"
  }
}
```

## 实现结构

```text
浏览器
  │  GET /api/parse?url=...
  ▼
src/server.js
  ├─ 并发提取候选流：
  │    ├─ src/provider.js           (789jiexi 纯 HTTP 上游)
  │    ├─ src/providers/jx-browser.js (无头 Chrome 自动化提取腾讯/官方 CDN)
  │    └─ src/providers/http.js + player-config.js + lx.js + jiexi789-page.js
  │       + bingdou.js + bingdou-browser.js
  │         (HTTP 入口、LX/麒麟播放器配置适配、789 页面链路、冰豆浏览器回退)
  ├─ src/media-network.js   公网 DNS、地址固定、超时与取消
  ├─ src/benchmark.js       并发测试分片真实吞吐 (KB/s) 与 TTFB，自动择优
  ├─ src/stream.js          按 type 校验：m3u8 查 #EXTM3U；mp4 用 HEAD/Range
  ├─ src/metadata.js        可选元数据适配器调度
  └─ GET /api/danmaku
       └─ src/danmaku.js    dmku → 过滤/排序/映射
  ▼
public/app.js + Artplayer + hls.js + artplayer-plugin-danmuku
  ├─ 自动加载测速胜出的最快播放源，流畅秒开
  ├─ 界面渲染测速标签，支持用户手动一键切换其他线路
  ├─ 选集栏自动下一集开关；全集弹层长标题自动换行
  └─ 弹幕异步加载；失败不影响播放
```

## 页面开发日志

页面左下角有一个默认折叠的 `DEV` 面板，仅用于开发排查，不参与播放布局：

- 解析请求/响应，以及每个渠道的诊断状态（`benchmarked`、`single-use`、`rejected`、`fallback-skipped` 等）、
  总耗时 `ms`、`ttfbMs`、`speedKBps`、`score` 和错误信息。
- 渠道延迟排行：已验证渠道按 `TTFB` 升序，单次链接/失败渠道按解析耗时排序；
  失败项会显示 `code` 与上游 `detail`（例如 `upstreamCode=404`）。
- 初始选择依据：可用优先 > 已验证优先 > `score` 高 > `TTFB` 低；没有已验证线路时使用 `singleUse` 签名地址。
- 播放卡顿触发、`/api/race` 请求与候选、换线 `from → to`、切换成功/失败，以及 HLS 网络/致命错误。
- 日志只保存在当前页面内存，最多 200 条，刷新清空，不会写入服务端。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `3000` | 监听端口 |
| `UPSTREAM_BASE` | `https://api-api.789jiexi.net` | 上游解析服务根地址 |
| `UPSTREAM_AES_KEY` | `ARTPLAYERliUlanG` | 上游播放地址 AES key，16 字节 |
| `UPSTREAM_AES_IV` | `ArtplayerliUlanG` | 上游播放地址 AES iv，16 字节 |
| `METADATA_IQIYI_URL` | `https://pcw-api.iqiyi.com/video/video/playervideoinfo` | 可选爱奇艺元数据接口 |
| `DANMAKU_BASE_URL` | `https://jx.1ljx.com/dan/@lirose_tv/` | dmku 弹幕接口 |
| `ENABLE_BROWSER_PROVIDER` | `true` | 是否启用无头浏览器提取器；冰豆回退渠道也依赖此开关 |
| `HTTP_PROVIDER_IDS` | 全部 | 逗号分隔的渠道 ID；未设置时启用全部，空字符串表示全部关闭 |
| `HTTP_PROVIDER_TIMEOUT_MS` | `12000` | 每个 HTTP 渠道从入口到媒体地址的总超时（毫秒） |
| `CHROME_BIN` | `/usr/bin/google-chrome` | 无头浏览器可执行文件路径 |
| `BENCHMARK_TIMEOUT_MS` | `3000` | 候选流分片测速超时时间（毫秒） |
| `REQUEST_TIMEOUT_MS` | `15000` | 上游请求超时 |
| `METADATA_TIMEOUT_MS` | `5000` | 元数据请求超时 |
| `DANMAKU_TIMEOUT_MS` | `10000` | 弹幕请求超时 |
| `STREAM_TIMEOUT_MS` | `10000` | 播放地址校验超时 |
| `MEDIA_DNS_MODE` | `auto` | 服务端媒体 DNS：`auto` 系统解析并在 Fake-IP/私网答案时回退公网 DoH；`public` 强制 DoH；`system` 禁用回退 |
| `CACHE_TTL_MS` | `300000` | 解析/弹幕缓存时间 |
| `CACHE_MAX_ENTRIES` | `200` | 缓存条目上限 |

示例：

```bash
PORT=8080 DANMAKU_BASE_URL='https://your-dmku.example/' npm start
```

## 测试

离线单元/接口测试：

```bash
npm test
```

覆盖 LX/麒麟播放器配置提取、同站接口、令牌脱敏、789 页面链路校验、冰豆浏览器回退与懒执行、
单次链接不预读、逐候选择优、媒体校验与测速失败隔离，以及系统 DNS/Fake-IP 自动回退和公网 DNS 的
TTL/大小约束、私网拒绝、连接固定、重定向、压缩、连接取消和缺失响应长度。
离线测试通过不等于上游可持续播放。

真实上游联调（iQiyi + Bilibili + dmku）：

```bash
RUN_LIVE_TESTS=1 npm test
```

联调会验证：

- iQiyi：m3u8、真实标题、dmku 弹幕数量 > 0
- Bilibili：mp4、播放地址可用、dmku 弹幕数量为 0（当前 dmku 覆盖限制）

## 目录

```text
videoshow/
├── src/
│   ├── server.js               HTTP 路由、多源调度、缓存、静态资源
│   ├── benchmark.js            候选流分片真实测速与竞速排名
│   ├── provider.js             789jiexi 纯 HTTP 上游取流
│   ├── providers/
│   │   ├── http.js             可插拔 HTTP 渠道注册与有界请求
│   │   ├── player-config.js    LX/麒麟公开页面配置与同站接口适配
│   │   ├── lx.js               LX 公共入口与播放页解析
│   │   ├── jiexi789-page.js    789 页面入口链路校验与上游复用
│   │   ├── bingdou.js          冰豆入口校验与浏览器取流调度
│   │   ├── bingdou-browser.js  冰豆 WASM 播放器的无头 Chrome 取流
│   │   ├── qilin.js            麒麟适配兼容导出
│   │   └── jx-browser.js       无头 Chrome 官方 CDN 高速流提取器
│   ├── media-network.js        可选公网 DNS 与固定地址的媒体传输
│   ├── stream.js               类型识别、播放地址校验、过期时间提取
│   ├── metadata.js             可选元数据适配器调度
│   ├── metadata/iqiyi.js       爱奇艺元数据适配器（可选）
│   ├── danmaku.js              dmku 弹幕获取与标准化
│   ├── http.js                 带超时的 fetch/probe 封装
│   ├── config.js               环境变量配置
│   ├── errors.js               统一业务错误
│   └── log.js                  结构化日志
├── public/
│   ├── index.html         Artplayer 播放页
│   ├── app.js             表单、解析请求、Artplayer/弹幕
│   ├── styles.css         深色单页样式
│   └── vendor/            hls.js、Artplayer、弹幕插件及许可证
├── test/
└── docs/aegis/            规格、计划与基线
```

## 说明与边界

- 支持格式：`m3u8`、`mp4`；其他格式会返回明确的“不支持该格式”错误。
- 解析能力依赖上游服务，实际支持站点范围由上游决定；本项目不做平台白名单。
- 弹幕来源为 dmku；当前对 iQiyi 有数据，对 Bilibili 实测为空。UI 会显示“暂无弹幕”，不影响播放。
- 弹幕为只读，不提供发送/持久化。
- 爱奇艺元数据是可选适配器；其他平台的 `title`/`cover` 目前为 `null`，不影响解析。
- 不使用视频代理；m3u8/TS/mp4 由源站 CDN 直接提供。
- Artplayer 5.4.0、artplayer-plugin-danmuku 5.3.0 为 MIT；hls.js 1.7.3 为 Apache-2.0，许可证见 `public/vendor/`。
- 本项目仅用于学习与个人用途。请遵守各视频平台的服务条款与版权规定，仅解析你有权访问的内容。
