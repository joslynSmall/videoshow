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

    const sourcesBar = document.querySelector("#sources-bar");
    if (sourcesBar) {
      sourcesBar.innerHTML = "";
      if (Array.isArray(data.candidates) && data.candidates.length > 1) {
        for (const c of data.candidates) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "source-tag" + (c.selected ? " active" : "");
          let speedStr = "测速超时";
          if (c.speedKBps > 0) {
            speedStr =
              c.speedKBps >= 1024
                ? (c.speedKBps / 1024).toFixed(1) + " MB/s"
                : c.speedKBps + " KB/s";
          }
          const ttfbStr =
            c.ttfbMs && Number.isFinite(c.ttfbMs) ? c.ttfbMs + "ms" : "";
          btn.textContent =
            (c.selected ? "★ 最快源: " : "") +
            c.provider +
            " (" +
            speedStr +
            (ttfbStr ? ", " + ttfbStr : "") +
            ")";
          if (!c.selected && c.playUrl) {
            btn.addEventListener("click", () => {
              showResult({
                ...data,
                playUrl: c.playUrl,
                type: c.type,
                provider: c.provider,
                candidates: data.candidates.map((x) => ({
                  ...x,
                  selected: x.provider === c.provider,
                })),
              });
            });
          }
          sourcesBar.appendChild(btn);
        }
      }
    }

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
