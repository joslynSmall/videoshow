# videoshow

一个平台中性的视频解析 HTTP 服务。粘贴视频页链接，服务端解析出可播放的 `m3u8` 或 `mp4`，浏览器用 Artplayer 播放；支持从 dmku 获取只读弹幕。没有广告脚本，也不使用上游返回的推广标题。

## 功能

- 接受任意 `http(s)` 视频页链接，不做平台域名白名单
- 支持 `m3u8` 与 `mp4`，按类型校验播放地址
- 多源并发解析：线路一通过校验和测速就通过事件流推给浏览器，第一条到达即可起播；卡顿或起播失败时自动换到下一条线路
- HTTP 解析渠道默认启用：LX、789 页面入口、冰豆、麒麟；LX/麒麟适配播放器配置接口，789 页面入口复用内置上游，冰豆通过无头 Chrome 回退取 MP4
- 搜索渠道二选一：`API 渠道` 只查聚合接口，`视频网站` 直接查各站搜索；选择保存在浏览器本地
- jx-browser 按媒体后缀识别 `m3u8`/`mp4`，B 站等 MP4 源不会被误当成 HLS 播放清单
- 短时效线路快照：LX/麒麟的清单地址几秒就过期，服务端在有效期内读取一次并固化成快照，由本站提供给播放器
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

- LX、麒麟可取得 HLS 地址，属于短时效线路：服务端立即读取清单并做成快照（见下），分片仍由浏览器直连。
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

LX/麒麟的清单地址是**短时效**的：实测可以反复读取，但生成约 6～8 秒后就 404（分片地址则能活到几分钟之后）。
而解析本身要几秒到十几秒，如果把清单地址原样交给浏览器，线路到手时已经是死的。因此服务端在解析到地址后
**立刻读一次清单**，把它改写成绝对地址并存为**清单快照**，快照线路的 `playUrl` 指向本站的
`/api/snapshot`；之后它和其他线路一样做流校验、测速和排序。快照只存在进程内存里，随解析会话（`CACHE_TTL_MS`）一起过期。
冰豆返回的是直接 MP4，没有清单可取，只能作为未经服务端校验的线路（`verified: false`）交给浏览器首次读取。

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

### `GET /api/resolve?url=<encoded-video-url>`

解析是一个**事件流**（`text/event-stream`）：每条线路通过校验和测速就立刻推送，不等其他渠道。
同一个视频页面的并发请求、以及会话有效期（`CACHE_TTL_MS`）内后来的请求共享同一个**解析会话**：
后来者先回放已有事件，再接收新事件，不会重复解析。

```bash
curl -N 'http://127.0.0.1:3000/api/resolve?url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1JP41167xK'
```

```text
id: 7f3a9c1e2b04:1
event: session
data: {"sourceUrl":"https://www.bilibili.com/video/BV1JP41167xK","pageHost":"www.bilibili.com","danmaku":{"provider":"dmku","endpoint":"/api/danmaku?url=..."}}

id: 7f3a9c1e2b04:4
event: line
data: {"id":"7f3a9c1e2b04.L1","provider":"jx-browser","type":"mp4","playUrl":"https://...","host":"cdn.example","segmentHost":"cdn.example","snapshot":false,"shortLived":false,"verified":true,"available":true,"ttfbMs":88,"speedKBps":2483,"score":1318,"key":"bb50c7abae96806b","round":1}

event: end
data: {}
```

| 事件 | 含义 |
|---|---|
| `session` | 会话开始，带弹幕接口地址 |
| `round` | 一轮解析开始 |
| `diagnostic` | 某个渠道的结果：`benchmarked`、`snapshot`、`unverified`、`duplicate`、`rejected`、`benchmark-rejected`、`fallback-skipped`、`cooldown`、`empty`，含耗时、错误码和原因 |
| `line` | 一条可用线路。`id` 全局唯一（带会话编号）；`playUrl` 是原始地址，快照线路则是 `/api/snapshot?...` |
| `meta` | 标题和封面，晚于第一条线路，不阻塞起播；只有可选的爱奇艺适配器会填充，上游返回的广告标题永远不会被透传 |
| `done` | 这一轮结束，带 `lines`（累计）和 `newLines`（本轮新增） |
| `failed` | 这一轮结束且会话里一条线路都没有：`STREAM_INVALID` / `PARSE_FAILED`；失败不会被缓存，下一位观众会重新解析 |
| `end` | 本次响应结束的明确标记；没有收到 `end` 就断开说明需要重连 |

- 每个事件带 `id: <会话编号>:<序号>`。断线重连时带 `Last-Event-ID` 请求头或 `after=<事件编号>` 参数，服务端只回放之后的事件；游标属于别的会话时从头回放。
- `refresh=1`：线路都用完的观众要求在**原会话上追加一轮**解析。两轮之间至少间隔 `PARSE_REFRESH_MIN_MS`，
  被限流时只回放已有事件并 `end`，客户端据此知道没有新线路。会话里一条线路都没有时，后来的观众也会触发新一轮（同样受间隔限制）。
- **去重**：同一个播放列表域名上分片列表完全相同的线路只保留先到的（分片地址里的令牌不参与比较）；
  分片相同但播放列表域名不同的线路不算重复。去重在会话内跨轮次生效；某条线路测速失败会释放它的指纹，让内容相同的后到线路还有机会重测。
- `line.score` 以吞吐为主、首字节为辅：`speedKBps / (1 + ttfbSeconds)`；`unmeasured: true` 表示内容校验通过但测速没跑完。
  测速确认不可用的线路只出现在 `diagnostic` 里，不会作为 `line` 推送。
- 连接每 `STREAM_HEARTBEAT_MS` 发一次 `: ping` 注释，并带 `X-Accel-Buffering: no` 提示反向代理不要缓冲。

### `GET /api/snapshot?s=<会话编号>&l=<线路编号>`

返回短时效线路的清单快照（`application/vnd.apple.mpegurl`，`no-store`），分片和 KEY/MAP 地址均已改写为绝对地址。
只服务解析会话里已存在的快照，不接受任何外部传入的地址；会话过期后返回 `404 SNAPSHOT_EXPIRED`。

### 卡顿判定与自动换线

前端每 500ms 采样一次播放状态，判定逻辑集中在 `public/stall-monitor.js`（纯函数，有单元测试）：

| 层 | 判定 | 动作 |
|---|---|---|
| 起播失败 | 连续 10 秒没有任何数据进展（清单、分片都没有动静）；有数据在下载时最多放宽到 20 秒。暂停时只看元数据，播放时看能否连续播放 | 换线 |
| 硬卡死 | 播放中连续断流 5 秒 | 换线；断流满 3 秒时先自救一次（降一档清晰度、让 HLS 重新拉分片） |
| 慢性卡顿 | 60 秒窗口内卡顿 ≥3 次（单次 ≥1 秒），或 ≥2 次且卡顿占比 ≥15% | 换线，且换线后 30 秒内不因此再换 |

暂停、拖动进度条（含之后 3 秒宽限）、断网、播放结束都不算线路卡顿。
换线只在起播失败或卡顿时发生：正常播放时不会因为后到了更好的线路而切换。
换线的下一条线路来自客户端的**线路簿**（`public/line-book.js`）：已校验的、得分高的优先，失败过一次的域名排在其他域名之后。
线路簿里没有可用线路、但解析还在进行时，先等后到的线路（最多 30 秒）；仍然没有，就在原解析会话上追加一轮（每次换线最多一轮）。
新线路连续 12 秒没有下载进展（有进展时最多 24 秒）、或加载中出现 HLS 致命错误，都立即视为本次尝试失败。

### 拼接广告过滤

部分聚合解析渠道会把广告分片夹在两个 `#EXT-X-DISCONTINUITY` 之间拼进播放列表（例如腾讯视频 7:24 处插入 6 个来自 `askutrc5ss.com`、共约 18 秒的分片）。前端在 hls.js 拿到播放列表后、解析之前把这类块去掉，逻辑集中在 `public/ad-filter.js`（纯函数，有单元测试）。判定刻意保守，一个块要同时满足：

- 夹在 DISCONTINUITY 之间，且域名族（`omts.tc.qq.com` 与 `apd.tc.qq.com` 都算 `qq.com`）不同于占时长最多的那一族；
- 时长不超过 120 秒，块内没有 `KEY` / `MAP` / `BYTERANGE`；
- 整份列表是完整点播列表（有 `#EXT-X-ENDLIST`，不是主列表）。

候选块超过 5 个，或合计超过总时长 10%，整份列表都不动。移除后会在页面开发日志写一条"广告片段已移除"，含块数、秒数、位置和广告域名。出现误判时，在浏览器控制台执行 `localStorage.setItem("videoshow.adFilter", "off")` 即可关闭。

只对 hls.js 播放有效；Safari 原生 HLS 路径拿不到播放列表，无法过滤。

### 渠道健康与外部配置

**自动摘除**：每次解析都会把各渠道的结果按自然日记入账本（落盘，重启不丢）。一个自然日算"不可用"，需同时满足：

1. 这一天已经结束（当天不下结论）；
2. 当天至少尝试了 `CHANNEL_MIN_DAILY_ATTEMPTS` 次；
3. 当天没有一次可用结果；
4. 当天至少有另一个渠道成功过。否则是断网、代理故障这类整体问题，不怪渠道。

**连续**不可用的天数达到 `CHANNEL_DEAD_DAYS` 就摘除：按时间顺序看已结束的日子，任何一个有可用结果的日子都会把计数清零；样本不足的日子和整体故障的日子不下结论（既不计数也不清零）。只保留最近 30 个自然日的记录。
"可用"指产出了可用线路（含未测速、快照线路、与其他渠道地址重复）；没装 Chrome、DevTools 起不来这类本机问题不计入。
摘除后该渠道不再被调用，`GET /api/channels` 可查看每个渠道的状态、今日尝试/成功次数和摘除原因（不含渠道地址）。

**自动复活（试探）**：被摘除的渠道每隔 `CHANNEL_PROBE_MINUTES` 分钟（默认 360）会被放回某一轮解析里跑一次。产出了可用线路就立即复活并重新累计，线路照常推给观众；失败则继续等下一个间隔，不进入当天统计。同一时刻只会有一个解析会话领到试探，间隔和失败次数落盘，重启不重置。设为 `0` 关闭试探。

**手动复活**：外部配置给了**新的 endpoint**，或把 `revision` 调大，也会重新启用并重新累计；地址不变的重复配置不会让它复活。被外部配置停用（`enabled: false`）的渠道不参与试探。

`GET /api/channels` 对被摘除的渠道会额外给出 `nextProbeAt`（下次试探时间）和 `probeFailures`（试探失败次数）。

**外部配置**（`CHANNEL_CONFIG_URL`）返回：

```json
{
  "channels": [
    { "id": "lx", "endpoint": "https://jx.example.com/index.php?url=", "revision": 1 },
    { "id": "extra", "name": "新增渠道", "endpoint": "https://extra.example.com/?url=", "parser": "generic", "shortLived": false },
    { "id": "qilin", "enabled": false }
  ]
}
```

- 同 `id` 的内置渠道可改 `name`、`endpoint`、`parser`、`shortLived`（旧名 `singleUse` 仍被接受）、`fallback`，没写的字段保持原样；新渠道必须有 `endpoint`。
- `parser` 取值：`lx`、`jiexi789-page`、`bingdou`、`qilin`、`generic`（默认；按页面里的媒体地址或重定向提取）。
- `enabled: false` 停用渠道，包括 `jiexi789`、`jx-browser`；条目不在配置里则恢复内置行为。
- `endpoint` 会被服务端当作请求目标，所以只接受：https、无账号密码、默认端口、非 IP、非内网域名、以 `=` 结尾（用于拼接视频地址）。
  不合法的条目会被单独丢弃并记入日志和 `/api/channels`，不影响其他条目；配置体最大 64KB、最多 32 个渠道。

### 线路筛选与失败判定

- **测速没跑完 ≠ 不可用**：已通过内容校验的线路，如果测速因超时、网络错误或服务端 DNS 校验被拦而没测成，
  保留为"未测速"（`unmeasured: true`，诊断里写明原因），排在已测速线路之后；
  只有 HTTP 错误码、返回 HTML、播放列表无效这类明确的内容问题才判为不可用。
- **失败按证据分级记账**（`public/line-book.js` 的 `classifyFailure`，有单元测试）：
  - 清单返回 HTTP 4xx/5xx（链接过期、没有权限）、起播超时、卡顿、媒体解码错误：**只排除这一条线路**；
  - 清单或分片所在域名连不上（浏览器网络错误计 2 次，超时计 1 次；经本站中转时的 502/503/504 同属此类）：**按域名累计**，达到 2 次该域名上的线路都不再尝试，失败 1 次的域名排在其他域名之后；
  - 快照线路的清单由本站提供，清单失败不牵连它的原始域名；
  - 起播失败但清单已读到：对分片域名只记 1 次（证据不足）。
  失败只影响当前观众：不改共享会话的线路排序，也不计入渠道健康账本。

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
  │  GET /api/resolve?url=...   (SSE：线路陆续到达，可 refresh / 断线续传)
  ▼
src/server.js            解析会话（src/parse-session.js）：事件日志、回放、清单快照、去重
  ├─ 并发提取候选流：
  │    ├─ src/provider.js           (789jiexi 纯 HTTP 上游)
  │    ├─ src/providers/jx-browser.js (无头 Chrome 自动化提取腾讯/官方 CDN)
  │    └─ src/providers/http.js + player-config.js + lx.js + jiexi789-page.js
  │       + bingdou.js + bingdou-browser.js
  │         (HTTP 入口、LX/麒麟播放器配置适配、789 页面链路、冰豆浏览器回退)
  ├─ src/media-network.js   公网 DNS、地址固定、超时与取消
  ├─ src/benchmark.js       并发测试分片真实吞吐 (KB/s) 与 TTFB，自动择优
  ├─ src/stream.js          按 type 校验：m3u8 查 #EXTM3U；mp4 用 HEAD/Range
  ├─ src/playlist.js        清单快照改写成绝对地址、线路内容指纹
  ├─ src/metadata.js        可选元数据适配器调度
  └─ GET /api/danmaku
       └─ src/danmaku.js    dmku → 过滤/排序/映射
  ▼
public/app.js + Artplayer + hls.js + artplayer-plugin-danmuku
  ├─ resolve-stream.js 读取事件流（断线续传），line-book.js 管理线路与失败记账
  ├─ 第一条线路到达即起播；起播失败或卡顿时自动换线（没有手动切线入口）
  ├─ 选集栏自动下一集开关；全集弹层长标题自动换行
  └─ 弹幕异步加载；失败不影响播放
```

## 页面开发日志

页面左下角有一个默认折叠的 `DEV` 面板，仅用于开发排查，不参与播放布局：

- 解析会话事件（解析轮次、收到的线路、解析完成/失败），以及每个渠道的诊断状态（`benchmarked`、`snapshot`、`duplicate`、`rejected`、`fallback-skipped` 等）、
  总耗时 `ms`、`ttfbMs`、`speedKBps`、`score` 和错误信息。
- 渠道延迟排行：已验证渠道按 `TTFB` 升序，快照线路/失败渠道按解析耗时排序；
  失败项会显示 `code` 与上游 `detail`（例如 `upstreamCode=404`）。
- 初始选择依据：最先到达的可用线路；换线时按域名失败情况 > 已验证 > `score` 高 > `TTFB` 低选下一条。
- 播放卡顿触发、换线时累计的失败证据与域名失败、等待后台线路、追加一轮解析、换线 `from → to`、切换成功/失败，以及 HLS 网络/致命错误。
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
| `PARSE_REFRESH_MIN_MS` | `15000` | 同一个解析会话两轮解析之间的最小间隔：线路用完的观众请求追加一轮时，间隔内不会再跑一轮，避免上游被连续打满 |
| `STREAM_HEARTBEAT_MS` | `15000` | 解析事件流的心跳间隔，避免反向代理把长时间没有数据的连接当作空闲连接断开 |
| `CHANNEL_CONFIG_URL` | 空 | 渠道外部配置接口（必须 https，返回 JSON，格式见下）；为空则只用内置渠道 |
| `CHANNEL_CONFIG_REFRESH_MS` | `600000` | 外部配置的刷新间隔；拉取失败后 1 分钟重试，期间沿用上一次成功的配置 |
| `CHANNEL_STATE_FILE` | `data/channel-state.json` | 渠道健康账本的落盘位置；Vercel 等只读环境默认只用内存；设为空字符串可关闭落盘 |
| `CHANNEL_DEAD_DAYS` | `3` | 连续多少个自然日不可用后摘除渠道 |
| `CHANNEL_PROBE_MINUTES` | `360` | 被摘除的渠道每隔多少分钟试探一次，成功就自动复活；`0` 关闭 |
| `CHANNEL_MIN_DAILY_ATTEMPTS` | `3` | 一个自然日至少尝试多少次才下结论，流量太小的日子不计入 |
| `CHANNEL_TIMEZONE` | 服务器本地时区 | 划分"自然日"的时区，例如 `Asia/Shanghai` |
| `CHROME_BIN` | Linux：`/usr/bin/google-chrome`；Windows：自动探测 `Program Files`、`Program Files (x86)`、`%LOCALAPPDATA%` 下的 Chrome，找不到时用 Edge | 无头浏览器可执行文件路径 |
| `CHROME_PROXY` | 空 | 无头浏览器使用的代理，如 `http://127.0.0.1:7890` 或 `socks5://host:1080`；未设置时，Windows/macOS 沿用 `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`（这两个平台的 Chrome 不读环境变量），Linux 的 Chrome 自己会读 |
| `BENCHMARK_TIMEOUT_MS` | `3000` | 候选流分片测速超时时间（毫秒） |
| `REQUEST_TIMEOUT_MS` | `15000` | 上游请求超时 |
| `METADATA_TIMEOUT_MS` | `5000` | 元数据请求超时 |
| `DANMAKU_TIMEOUT_MS` | `10000` | 弹幕请求超时 |
| `STREAM_TIMEOUT_MS` | `10000` | 播放地址校验超时 |
| `MEDIA_DNS_MODE` | `auto` | 服务端媒体 DNS：`auto` 系统解析并在 Fake-IP/私网答案时回退公网 DoH；`public` 强制 DoH；`system` 禁用回退；`auto` 在系统 DNS 直接报错时同样回退。公共 DNS 并行查询阿里、DNSPod、Cloudflare、Google 四个固定 DoH 端点，谁先返回有效答案用谁 |
| `CACHE_TTL_MS` | `300000` | 解析会话（含清单快照）和弹幕缓存的有效期 |
| `CACHE_MAX_ENTRIES` | `200` | 解析会话和弹幕缓存的条目上限 |

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
清单快照、解析会话（共享/回放/追加/限流/断线续传）、线路簿的失败分级、媒体校验与测速失败隔离，以及系统 DNS/Fake-IP 自动回退和公网 DNS 的
TTL/大小约束、私网拒绝、连接固定、重定向、压缩、连接取消和缺失响应长度。
离线测试通过不等于上游可持续播放。

真实上游联调（iQiyi + Bilibili + dmku）：

```bash
npm run test:live
```

该命令会自行设置 `RUN_LIVE_TESTS=1`，Windows 的 cmd、PowerShell 与 Linux/macOS 通用。

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
│   ├── ad-filter.js       播放列表拼接广告过滤（纯函数）
│   ├── stall-monitor.js   卡顿判定状态机（纯函数）
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
