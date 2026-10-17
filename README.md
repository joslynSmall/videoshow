# videoshow

一个平台中性的视频解析 HTTP 服务。粘贴视频页链接，服务端解析出可播放的 `m3u8` 或 `mp4`，浏览器用 Artplayer 播放；支持从 dmku 获取只读弹幕。没有广告脚本，也不使用上游返回的推广标题。

## 功能

- 接受任意 `http(s)` 视频页链接，不做平台域名白名单
- 支持 `m3u8` 与 `mp4`，按类型校验播放地址
- 多源并发竞速与自动测速选源：并发提取 789 与 jx 线路，真实测量分片吞吐与延迟，自动优选最高速源，UI 支持一键切源
- Artplayer + 官方 `artplayer-plugin-danmuku`，支持弹幕显示/隐藏、字号、速度、透明度
- 新增 `GET /api/danmaku?url=...`，代理 dmku、清洗脏数据并按时间排序
- 可选的爱奇艺元数据适配器：能取到真实标题/封面；其他平台返回 `null`
- 无广告注入，不加载第三方广告/统计脚本
- 视频分片仍由源站 CDN 直连，不做服务端视频中转
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
    "candidates": [
      {
        "provider": "jx-browser",
        "speedKBps": 2483,
        "ttfbMs": 88,
        "available": true,
        "selected": true
      },
      {
        "provider": "jiexi789",
        "speedKBps": 263,
        "ttfbMs": 1159,
        "available": true,
        "selected": false
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
  │    └─ src/providers/jx-browser.js (无头 Chrome 自动化提取腾讯/官方 CDN)
  ├─ src/benchmark.js       并发测试分片真实吞吐 (KB/s) 与 TTFB，自动择优
  ├─ src/stream.js          按 type 校验：m3u8 查 #EXTM3U；mp4 用 HEAD/Range
  ├─ src/metadata.js        可选元数据适配器调度
  └─ GET /api/danmaku
       └─ src/danmaku.js    dmku → 过滤/排序/映射
  ▼
public/app.js + Artplayer + hls.js + artplayer-plugin-danmuku
  ├─ 自动加载测速胜出的最快播放源，流畅秒开
  ├─ 界面渲染测速标签，支持用户手动一键切换其他线路
  └─ 弹幕异步加载；失败不影响播放
```

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
| `ENABLE_BROWSER_PROVIDER` | `true` | 是否启用无头浏览器提取器（获取官方 CDN 极速源） |
| `CHROME_BIN` | `/usr/bin/google-chrome` | 无头浏览器可执行文件路径 |
| `BENCHMARK_TIMEOUT_MS` | `3000` | 候选流分片测速超时时间（毫秒） |
| `REQUEST_TIMEOUT_MS` | `15000` | 上游请求超时 |
| `METADATA_TIMEOUT_MS` | `5000` | 元数据请求超时 |
| `DANMAKU_TIMEOUT_MS` | `10000` | 弹幕请求超时 |
| `STREAM_TIMEOUT_MS` | `10000` | 播放地址校验超时 |
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
│   │   └── jx-browser.js       无头 Chrome 官方 CDN 高速流提取器
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
