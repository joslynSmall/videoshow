import { splitDanmakuText } from "/danmaku-text.js";

window.renderArtDanmaku = function renderArtDanmaku(item) {
  const el = item?.$ref;
  if (!el) return;
  const parts = splitDanmakuText(item.text);
  if (!parts.some((part) => part.type === "image")) {
    el.textContent = item.text || "";
    return;
  }
  el.replaceChildren();
  for (const part of parts) {
    if (part.type === "text") {
      if (part.value) el.append(document.createTextNode(part.value));
      continue;
    }
    const img = document.createElement("img");
    img.alt = "";
    img.draggable = false;
    img.referrerPolicy = "no-referrer";
    img.src = part.src;
    img.style.cssText = "height:1.4em;width:1.4em;object-fit:contain;vertical-align:middle;";
    el.append(img);
  }
};

(() => {
  const form = document.querySelector("#parse-form");
  const input = document.querySelector("#url-input");
  const clearInputBtn = document.querySelector("#clear-input-button");
  const submit = document.querySelector("#submit-button");
  const status = document.querySelector("#status");
  const result = document.querySelector("#result");
  const player = document.querySelector("#player");
  const videoTitle = document.querySelector("#video-title");
  const expiry = document.querySelector("#expiry");

  // 新增界面元素
  const historyToggleBtn = document.querySelector("#history-toggle-button");
  const historyModal = document.querySelector("#history-modal");
  const closeHistoryBtn = document.querySelector("#close-history-button");
  const clearHistoryBtn = document.querySelector("#clear-history-button");
  const historyList = document.querySelector("#history-list");

  const searchHistory = document.querySelector("#search-history");
  const searchHistoryList = document.querySelector("#search-history-list");
  const clearSearchHistoryBtn = document.querySelector("#clear-search-history");

  const searchSection = document.querySelector("#search-section");
  const searchGrid = document.querySelector("#search-grid");
  const searchCount = document.querySelector("#search-count");
  const siteSearchModal = document.querySelector("#site-search-modal");
  const siteSearchTabs = document.querySelector("#site-search-tabs");
  const siteSearchList = document.querySelector("#site-search-list");
  const closeSiteSearchBtn = document.querySelector("#close-site-search");

  const episodesBar = document.querySelector("#episodes-bar");
  const platformBar = document.querySelector("#platform-bar");
  const episodesScroll = document.querySelector("#episodes-scroll");
  const currentEpisodeText = document.querySelector("#current-episode-text");
  const allEpisodesBtn = document.querySelector("#all-episodes-button");
  const episodesModal = document.querySelector("#episodes-modal");
  const closeEpisodesBtn = document.querySelector("#close-episodes-button");
  const episodesGrid = document.querySelector("#episodes-grid");
  const episodesModalTitle = document.querySelector("#episodes-modal-title");

  let art = null;
  let currentMedia = null; // 当前播放的完整上下文信息
  let progressSaveTimer = 0;
  let stallTimer = 0;
  let switchingLine = false;

  function clearStallTimer() {
    if (!stallTimer) return;
    window.clearTimeout(stallTimer);
    stallTimer = 0;
  }

  /* =========================================================================
     1. 播放历史与断点持久化 Store
     ========================================================================= */
  const HISTORY_KEY = "videoshow_playback_history_v1";
  const SEARCH_HISTORY_KEY = "videoshow_search_history_v1";
  const MAX_HISTORY_ITEMS = 50;
  const MAX_SEARCH_HISTORY = 16;

  const HistoryStore = {
    getAll() {
      try {
        const raw = localStorage.getItem(HISTORY_KEY);
        if (!raw) return [];
        const list = JSON.parse(raw);
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    },
    get(id) {
      if (!id) return null;
      return this.getAll().find((item) => item.id === id) || null;
    },
    save(item) {
      if (!item?.id) return;
      try {
        let list = this.getAll();
        const now = Date.now();
        const existingIndex = list.findIndex((x) => x.id === item.id);
        const previous = existingIndex >= 0 ? list[existingIndex] : null;
        const progress = { ...(previous?.progress || {}) };
        if (previous && !previous.progress && Number.isFinite(previous.currentTime)) {
          progress[progressKey(previous)] = {
            currentTime: previous.currentTime || 0,
            duration: previous.duration || 0,
          };
        }
        const currentTime = Math.floor(item.currentTime || 0);
        const duration = Math.floor(item.duration || 0);
        progress[progressKey(item)] = { currentTime, duration };
        const record = {
          id: item.id,
          title: item.title || "未知视频",
          cover: item.cover || "",
          sourceUrl: item.sourceUrl || "",
          playUrl: item.playUrl || "",
          type: item.type || "m3u8",
          episodeName: item.episodeName || "",
          episodeIndex: typeof item.episodeIndex === "number" ? item.episodeIndex : 0,
          currentTime,
          duration,
          episodes: Array.isArray(item.episodes) ? item.episodes : [],
          progress,
          updatedAt: now,
        };

        if (existingIndex >= 0) {
          list[existingIndex] = { ...list[existingIndex], ...record, updatedAt: now };
        } else {
          list.unshift(record);
        }

        list.sort((a, b) => b.updatedAt - a.updatedAt);
        if (list.length > MAX_HISTORY_ITEMS) {
          list = list.slice(0, MAX_HISTORY_ITEMS);
        }
        localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
      } catch (err) {
        console.warn("保存播放历史失败", err);
      }
    },
    clear() {
      try {
        localStorage.removeItem(HISTORY_KEY);
      } catch {}
    },
  };

  const SearchHistory = {
    getAll() {
      try {
        const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
        if (!raw) return [];
        const list = JSON.parse(raw);
        return Array.isArray(list) ? list.filter((item) => typeof item === "string" && item.trim()) : [];
      } catch {
        return [];
      }
    },
    save(query) {
      const value = typeof query === "string" ? query.trim() : "";
      if (!value) return;
      try {
        const list = this.getAll().filter((item) => item !== value);
        list.unshift(value);
        localStorage.setItem(
          SEARCH_HISTORY_KEY,
          JSON.stringify(list.slice(0, MAX_SEARCH_HISTORY)),
        );
      } catch (err) {
        console.warn("保存搜索历史失败", err);
      }
    },
    remove(query) {
      try {
        const list = this.getAll().filter((item) => item !== query);
        localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(list));
      } catch {}
    },
    clear() {
      try {
        localStorage.removeItem(SEARCH_HISTORY_KEY);
      } catch {}
    },
  };

  function progressKey(item) {
    const index = typeof item?.episodeIndex === "number" ? item.episodeIndex : 0;
    const episode = Array.isArray(item?.episodes) ? item.episodes[index] : null;
    return episode?.pageUrl || `index:${index}`;
  }

  function resumeTimeFor(record, item) {
    if (!record) return 0;
    const slot = record.progress?.[progressKey(item)]
      || (!record.progress && record.episodeIndex === (item.episodeIndex ?? 0)
        ? { currentTime: record.currentTime || 0, duration: record.duration || 0 }
        : null);
    if (!slot) return 0;
    if (slot.currentTime > 5 && slot.duration - slot.currentTime > 10) return slot.currentTime;
    return 0;
  }

  function renderSearchHistory() {
    if (!searchHistory || !searchHistoryList) return;
    const keyword = input.value.trim().toLowerCase();
    const items = SearchHistory.getAll().filter((item) =>
      keyword ? item.toLowerCase().includes(keyword) : true,
    );
    searchHistoryList.innerHTML = "";
    if (!items.length) {
      searchHistory.hidden = true;
      return;
    }
    for (const query of items) {
      const row = document.createElement("div");
      row.className = "search-history-item";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "search-history-query";
      button.textContent = query;
      button.title = query;
      button.addEventListener("click", () => {
        input.value = query;
        if (clearInputBtn) clearInputBtn.hidden = false;
        searchHistory.hidden = true;
        form.requestSubmit();
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "search-history-remove";
      remove.setAttribute("aria-label", `删除 ${query}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        SearchHistory.remove(query);
        renderSearchHistory();
        input.focus();
      });

      row.append(button, remove);
      searchHistoryList.appendChild(row);
    }
    searchHistory.hidden = false;
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "00:00";
    const sec = Math.floor(seconds);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (h > 0) {
      return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

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

  async function recoverDirectUrl(url) {
    const response = await fetch(url, { cache: "no-store" });
    const text = (await response.text()).replace(/^\uFEFF/, "").trim();
    if (!text || text.startsWith("#EXTM3U")) return null;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return null;
    }
    const next = payload?.url;
    if (typeof next !== "string" || !/^https?:\/\//i.test(next)) return null;
    return {
      playUrl: next,
      type: /\.m3u8(\?|$)/i.test(next) ? "m3u8" : "mp4",
    };
  }

  function playM3u8(video, url, artInstance, onFatal, onAttached) {
    const tried = new Set();
    const retry = { maxNumRetry: 2, retryDelayMs: 300, maxRetryDelayMs: 1000 };
    const startHls = (source) => {
      onAttached?.();
      if (!window.Hls?.isSupported()) {
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = source;
          return;
        }
        onFatal?.();
        return;
      }

      const BaseLoader = window.Hls.DefaultConfig?.loader;
      const loader = BaseLoader
        ? class MediaLoader extends BaseLoader {
            constructor(config) {
              super(config);
              this.loaderOptions = config;
              this.fallback = null;
            }

            load(context, config, callbacks) {
              const original = context?.url;
              let crossOrigin = false;
              try {
                crossOrigin =
                  typeof original === "string" &&
                  /^https?:\/\//i.test(original) &&
                  new URL(original).origin !== location.origin;
              } catch {
                crossOrigin = false;
              }
              if (!crossOrigin) {
                super.load(context, config, callbacks);
                return;
              }

              // 浏览器到源站通常是通的。先直连，超时或失败再交给本站中转。
              let settled = false;
              const useProxy = () => {
                if (settled) return;
                settled = true;
                try {
                  this.abortInternal();
                } catch {
                  // 直连已经结束时忽略。
                }
                context.url = `${location.origin}/api/media?url=${encodeURIComponent(original)}`;
                const next = new BaseLoader(this.loaderOptions);
                this.fallback = next;
                next.load(context, config, callbacks);
              };
              const policy = config?.loadPolicy;
              const directConfig = policy
                ? {
                    ...config,
                    timeout: 4000,
                    loadPolicy: {
                      ...policy,
                      maxTimeToFirstByteMs: 4000,
                      maxLoadTimeMs: 8000,
                      timeoutRetry: { maxNumRetry: 0, retryDelayMs: 0, maxRetryDelayMs: 0 },
                      errorRetry: { maxNumRetry: 0, retryDelayMs: 0, maxRetryDelayMs: 0 },
                    },
                  }
                : config;
              super.load(context, directConfig, {
                onSuccess: (...args) => {
                  settled = true;
                  callbacks.onSuccess?.(...args);
                },
                onProgress: (...args) => callbacks.onProgress?.(...args),
                onError: () => useProxy(),
                onTimeout: () => useProxy(),
              });
            }

            abort() {
              this.fallback?.abort();
              super.abort();
            }

            destroy() {
              this.fallback?.destroy();
              super.destroy();
            }
          }
        : undefined;
      const hls = new window.Hls({
        enableWorker: false,
        ...(loader ? { loader } : {}),
        fragLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 8000,
            maxLoadTimeMs: 20000,
            timeoutRetry: retry,
            errorRetry: retry,
          },
        },
      });
      hls.loadSource(source);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.ERROR, (_event, detail) => {
        if (!detail?.fatal) return;
        hls.destroy();
        if (tried.has(source)) {
          onFatal?.();
          return;
        }
        tried.add(source);
        recoverDirectUrl(source)
          .then((recovered) => {
            if (recovered && recovered.playUrl !== source) {
              useRecovered(recovered);
              return;
            }
            onFatal?.();
          })
          .catch(() => onFatal?.());
      });
      artInstance.once("destroy", () => hls.destroy());
    };

    const useRecovered = (recovered) => {
      reportPlayback("playback.recover", {
        fromHost: hostOf(url),
        toHost: hostOf(recovered.playUrl),
      });
      setStatus("正在重新连接，请稍候…", "loading");
      if (recovered.type === "mp4") {
        onAttached?.();
        video.src = recovered.playUrl;
        return;
      }
      startHls(recovered.playUrl);
    };

    recoverDirectUrl(url)
      .then((recovered) => {
        if (recovered && recovered.playUrl !== url) {
          useRecovered(recovered);
          return;
        }
        startHls(url);
      })
      .catch(() => startHls(url));
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

  function cleanBaseTitle(title) {
    if (!title) return "视频";
    return title.replace(/(\s+第\d+集|\s+全集|\s+正片)+/gi, "").trim() || title;
  }

  async function pickFasterSource(candidates) {
    try {
      const response = await fetch("/api/race", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ candidates }),
      });
      const payload = await response.json();
      const selected = payload?.data?.selected;
      if (response.ok && selected?.playUrl && selected.available !== false) return selected;
    } catch (err) {
      console.warn("重新测速失败", err);
    }
    return candidates.find((item) => item.playUrl && item.available !== false) || null;
  }

  async function switchToSmootherSource(data) {
    if (switchingLine) return;
    const video = player.querySelector("video");
    const continueAt = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const failed = new Set(Array.isArray(data.failedPlayUrls) ? data.failedPlayUrls : []);
    if (data.playUrl) failed.add(data.playUrl);
    const pool = (data.candidates || []).filter((item) => item.playUrl && !failed.has(item.playUrl));
    if (!pool.length) {
      reportPlayback("playback.failed", {
        playHost: hostOf(data.playUrl),
        episode: data.episodeName || "",
        reason: "no-alternative",
      });
      setStatus("暂时播不了，请稍后再试。", "error");
      return;
    }
    switchingLine = true;
    clearStallTimer();
    setStatus("播放不够流畅，正在更换线路…", "loading");
    try {
      const chosen = await pickFasterSource(pool);
      if (!chosen?.playUrl) {
        reportPlayback("playback.failed", {
          playHost: hostOf(data.playUrl),
          episode: data.episodeName || "",
          reason: "race-empty",
        });
        setStatus("暂时播不了，请稍后再试。", "error");
        return;
      }
      reportPlayback("playback.switch", {
        fromHost: hostOf(data.playUrl),
        toHost: hostOf(chosen.playUrl),
        episode: data.episodeName || "",
        continueAt,
      });
      showResult({
        ...data,
        playUrl: chosen.playUrl,
        type: chosen.type || (/\.mp4(\?|$)/i.test(chosen.playUrl) ? "mp4" : "m3u8"),
        continueAt,
        failedPlayUrls: [...failed],
        candidates: (data.candidates || []).map((item) => ({
          ...item,
          selected: item.playUrl === chosen.playUrl,
        })),
      });
    } finally {
      switchingLine = false;
    }
  }

  function hostOf(value) {
    try {
      return new URL(value).host;
    } catch {
      return "";
    }
  }

  function reportPlayback(event, fields) {
    fetch("/api/client-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, ...fields }),
    }).catch(() => {});
  }

  function showResult(data) {
    clearStallTimer();
    const baseTitle = data.baseTitle || currentMedia?.baseTitle || cleanBaseTitle(data.title);
    const displayTitle = data.episodeName ? `${baseTitle} ${data.episodeName}` : (data.title || baseTitle);

    videoTitle.textContent = displayTitle;
    expiry.textContent = formatExpiry(data.expiresAt);
    document.title = `${displayTitle} · videoshow`;
    reportPlayback("playback.start", {
      pageHost: hostOf(data.sourceUrl),
      playHost: hostOf(data.playUrl),
      provider: data.provider || "",
      episode: data.episodeName || "",
    });

    result.hidden = false;
    destroyPlayer();

    if (!window.Artplayer || !window.artplayerPluginDanmuku) {
      setStatus("播放器资源加载失败，请刷新页面。", "error");
      return;
    }

    const catalogPlayback = Boolean(data.episodeName) || Array.isArray(data.episodes);
    // 记录当前媒体上下文，固化 baseTitle 避免切集累加
    currentMedia = {
      id: catalogPlayback && currentMedia?.id ? currentMedia.id : (data.sourceUrl || data.playUrl),
      cat: catalogPlayback ? currentMedia?.cat : undefined,
      titleId: catalogPlayback ? currentMedia?.titleId : undefined,
      baseTitle,
      title: displayTitle,
      cover: data.cover || (catalogPlayback ? currentMedia?.cover : "") || "",
      sourceUrl: data.sourceUrl || input.value.trim(),
      playUrl: data.playUrl,
      type: data.type,
      episodeName: data.episodeName || "",
      episodeIndex: typeof data.episodeIndex === "number" ? data.episodeIndex : 0,
      platforms: catalogPlayback ? (currentMedia?.platforms || []) : [],
      platformId: catalogPlayback ? (currentMedia?.platformId || "") : "",
      episodes: Array.isArray(data.episodes) ? data.episodes : (catalogPlayback ? (currentMedia?.episodes || []) : []),
    };

    // 手动换线时沿用当前进度；否则只恢复这一集自己的进度。
    const savedRecord = HistoryStore.get(currentMedia.id);
    const resumeTime = Number.isFinite(data.continueAt)
      ? data.continueAt
      : resumeTimeFor(savedRecord, currentMedia);

    const danmakuEndpoint = data.danmaku?.endpoint || "";
    let playbackFailed = false;
    let sourceAttached = false;
    const failPlayback = () => {
      if (!sourceAttached || playbackFailed) return;
      playbackFailed = true;
      clearStallTimer();
      switchToSmootherSource(data);
    };

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
      customType: {
        m3u8: (video, url, artInstance) =>
          playM3u8(video, url, artInstance, failPlayback, () => {
            sourceAttached = true;
          }),
      },
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

    art.on("video:playing", () => {
      clearStallTimer();
      if (status.classList.contains("loading")) setStatus("", "");
    });
    art.on("video:waiting", () => {
      clearStallTimer();
      stallTimer = window.setTimeout(() => {
        const current = player.querySelector("video");
        if (!current || current.paused || current.readyState >= 3) return;
        failPlayback();
      }, 8000);
    });
    art.on("destroy", clearStallTimer);

    art.on("ready", () => {
      if (resumeTime > 0) {
        art.currentTime = resumeTime;
        art.notice.show = `已自动恢复至上次进度 ${formatTime(resumeTime)}`;
      }
    });

    // 节流保存播放进度
    art.on("video:timeupdate", () => {
      const now = Date.now();
      if (now - progressSaveTimer < 3000) return;
      progressSaveTimer = now;
      if (art && currentMedia && art.duration > 0) {
        HistoryStore.save({
          ...currentMedia,
          currentTime: art.currentTime,
          duration: art.duration,
        });
      }
    });

    art.on("video:pause", () => {
      if (art && currentMedia && art.duration > 0) {
        HistoryStore.save({
          ...currentMedia,
          currentTime: art.currentTime,
          duration: art.duration,
        });
      }
    });

    art.on("artplayerPluginDanmuku:loaded", (items) => {
      if (!items?.length) setStatus("本视频暂无弹幕。", "");
    });
    art.on("artplayerPluginDanmuku:error", () => {
      setStatus("弹幕加载失败，播放不受影响。", "error");
    });
    art.on("video:error", () => {
      failPlayback();
    });

    // 渲染选集栏
    renderEpisodes(currentMedia.episodes, currentMedia.episodeIndex);

    centerPlayer();
  }

  function scrollBehavior() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  }

  function centerPlayer() {
    player?.scrollIntoView({
      behavior: scrollBehavior(),
      block: "center",
      inline: "nearest",
    });
  }

  function placeActiveEpisode(activeIndex) {
    const capsule = episodesScroll?.children[activeIndex];
    if (!capsule) return;
    const left = capsule.offsetLeft - episodesScroll.clientWidth * 0.36 + capsule.offsetWidth / 2;
    episodesScroll.scrollTo({
      left: Math.max(0, left),
      behavior: scrollBehavior(),
    });
  }

  /* =========================================================================
     2. 选集渲染与切集切换
     ========================================================================= */
  function renderPlatforms(platforms, activeId) {
    if (!platformBar) return;
    platformBar.innerHTML = "";
    if (!Array.isArray(platforms) || platforms.length < 2) {
      platformBar.hidden = true;
      return;
    }
    platformBar.hidden = false;
    for (const platform of platforms) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "episode-btn" + (platform.id === activeId ? " is-active" : "");
      button.textContent = platform.name || platform.id;
      button.addEventListener("click", () => switchPlatform(platform));
      platformBar.appendChild(button);
    }
  }

  async function switchPlatform(platform) {
    if (!platform || !currentMedia || platform.id === currentMedia.platformId) return;
    if (!Array.isArray(platform.episodes) || !platform.episodes.length) {
      setStatus(`${platform.name || "该平台"}暂时没有可解析的分集页面。`, "error");
      return;
    }
    const nextIndex = Math.min(currentMedia.episodeIndex || 0, platform.episodes.length - 1);
    currentMedia.platformId = platform.id;
    currentMedia.episodes = platform.episodes;
    await selectEpisode(platform.episodes[nextIndex], nextIndex);
  }

  function renderEpisodes(episodes, activeIndex = 0) {
    const platforms = currentMedia?.platforms || [];
    const showEpisodes = Array.isArray(episodes) && episodes.length > 1;
    const showPlatforms = platforms.length > 1;
    if (!showEpisodes && !showPlatforms) {
      episodesBar.hidden = true;
      return;
    }

    episodesBar.hidden = false;
    renderPlatforms(platforms, currentMedia?.platformId);
    currentEpisodeText.textContent = episodes[activeIndex]?.name || `第 ${activeIndex + 1} 集`;
    if (!showEpisodes) {
      episodesScroll.innerHTML = "";
      episodesGrid.innerHTML = "";
      if (allEpisodesBtn) allEpisodesBtn.hidden = true;
      return;
    }
    if (allEpisodesBtn) allEpisodesBtn.hidden = false;
    episodesScroll.innerHTML = "";
    episodesGrid.innerHTML = "";
    episodesModalTitle.textContent = `${currentMedia?.title || "剧集"} · 全集列表`;

    episodes.forEach((ep, idx) => {
      // 1. 横向滚动胶囊按钮
      const capsule = document.createElement("button");
      capsule.type = "button";
      capsule.className = "episode-btn" + (idx === activeIndex ? " is-active" : "");
      capsule.textContent = ep.name || `${idx + 1}`;
      capsule.addEventListener("click", () => selectEpisode(ep, idx));
      episodesScroll.appendChild(capsule);

      // 2. 全集弹窗网格按钮
      const gridBtn = document.createElement("button");
      gridBtn.type = "button";
      gridBtn.className = "episode-btn" + (idx === activeIndex ? " is-active" : "");
      gridBtn.textContent = ep.name || `${idx + 1}`;
      gridBtn.addEventListener("click", () => {
        episodesModal.hidden = true;
        selectEpisode(ep, idx);
      });
      episodesGrid.appendChild(gridBtn);
    });

    requestAnimationFrame(() => placeActiveEpisode(activeIndex));
  }

  async function selectEpisode(episode, index) {
    const pageUrl = episode?.pageUrl;
    if (!pageUrl) {
      setStatus("这一集没有可解析的平台页面，请重新搜索。", "error");
      return;
    }
    setStatus(`正在解析${episode.name || "该集"}…`, "loading");
    setLoading(true);

    try {
      const data = await parse(pageUrl);
      const base = currentMedia?.baseTitle || cleanBaseTitle(currentMedia?.title);
      showResult({
        ...data,
        baseTitle: base,
        cover: data.cover || currentMedia?.cover || "",
        episodeName: episode.name,
        episodeIndex: index,
        episodes: currentMedia?.episodes,
      });
      setStatus("解析成功。", "");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "解析失败，请稍后重试。", "error");
    } finally {
      setLoading(false);
    }
  }

  /* =========================================================================
     3. 播放历史渲染与恢复
     ========================================================================= */
  function renderHistory() {
    const list = HistoryStore.getAll();
    historyList.innerHTML = "";

    if (!list.length) {
      historyList.innerHTML = '<div class="history-empty">暂无播放历史记录</div>';
      return;
    }

    list.forEach((item) => {
      const el = document.createElement("div");
      el.className = "history-item";
      const progressPercent = item.duration > 0 ? Math.min(100, Math.round((item.currentTime / item.duration) * 100)) : 0;

      el.innerHTML = `
        <div class="history-meta">
          <div class="history-title">${item.title}</div>
          <div class="history-details">
            ${item.episodeName ? `<span class="history-episode">${item.episodeName}</span>` : ""}
            <span>进度 ${formatTime(item.currentTime)} / ${formatTime(item.duration)} (${progressPercent}%)</span>
          </div>
        </div>
        <button type="button" class="ghost-button mini-button">继续播放</button>
      `;

      el.addEventListener("click", () => {
        historyModal.hidden = true;
        // 恢复播放该条记录
        if (item.episodes?.some((episode) => episode.pageUrl)) {
          currentMedia = {
            id: item.id,
            cat: item.cat,
            titleId: item.titleId,
            baseTitle: item.baseTitle || item.title,
            title: item.baseTitle || item.title,
            cover: item.cover,
            platforms: item.platforms || [],
            platformId: item.platformId || "",
            episodes: item.episodes,
          };
          selectEpisode(item.episodes[item.episodeIndex || 0], item.episodeIndex || 0);
        } else if (item.cat && item.titleId) {
          openTitle({ cat: item.cat, id: item.titleId, title: item.baseTitle || item.title, cover: item.cover }, item.episodeIndex || 0);
        } else if (item.sourceUrl) {
          input.value = item.sourceUrl;
          form.requestSubmit();
        } else if (item.playUrl) {
          showResult(item);
        }
      });

      historyList.appendChild(el);
    });
  }

  /* =========================================================================
     4. 双轨网络请求：搜索与单集解析
     ========================================================================= */
  function isUrl(str) {
    return /^https?:\/\//i.test(str.trim());
  }

  async function search(keyword) {
    const response = await fetch(`/api/search?kw=${encodeURIComponent(keyword)}`, {
      headers: { accept: "application/json" },
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      console.warn("search response was not JSON", err);
    }
    if (!response.ok || !payload || payload.ok !== true) {
      throw new Error(payload?.error?.message || "搜索请求失败");
    }
    return payload.data?.items || [];
  }

  async function searchSites(keyword) {
    const response = await fetch(`/api/site-search?kw=${encodeURIComponent(keyword)}`, {
      headers: { accept: "application/json" },
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      console.warn("site search response was not JSON", err);
    }
    if (!response.ok || !payload || payload.ok !== true) return [];
    return Array.isArray(payload.data?.sites) ? payload.data.sites : [];
  }

  async function loadEpisodes(pageUrl) {
    const response = await fetch(`/api/episodes?url=${encodeURIComponent(pageUrl)}`, {
      headers: { accept: "application/json" },
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      console.warn("episodes response was not JSON", err);
    }
    if (!response.ok || !payload?.ok || !Array.isArray(payload.data?.episodes)) return [];
    return payload.data.episodes;
  }

  function samePage(left, right) {
    try {
      const a = new URL(left);
      const b = new URL(right);
      return a.host === b.host && a.pathname === b.pathname;
    } catch {
      return false;
    }
  }

  async function withEpisodes(pageUrl, data, fallback = []) {
    let episodes = Array.isArray(fallback) && fallback.length > 1 ? fallback : [];
    if (episodes.length < 2) episodes = await loadEpisodes(pageUrl);
    if (episodes.length < 2) return data;
    const episodeIndex = Math.max(0, episodes.findIndex((episode) => samePage(episode.pageUrl, pageUrl)));
    return {
      ...data,
      episodes,
      episodeIndex,
      episodeName: episodes[episodeIndex]?.name || data.episodeName || "",
    };
  }

  function closeSiteSearch() {
    if (siteSearchModal) siteSearchModal.hidden = true;
  }

  function renderSiteResults(site) {
    if (!siteSearchList) return;
    siteSearchList.replaceChildren();
    for (const item of site?.items || []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "site-result";
      const img = document.createElement("img");
      img.alt = "";
      img.src = item.cover || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 54 72'%3E%3Crect width='54' height='72' fill='%23171b18'/%3E%3C/svg%3E";
      const copy = document.createElement("div");
      const title = document.createElement("h4");
      title.textContent = item.title || "未命名";
      const meta = document.createElement("p");
      meta.textContent = [item.remarks, item.desc].filter(Boolean).join(" · ");
      copy.append(title, meta);
      button.append(img, copy);
      button.addEventListener("click", () => {
        playSiteItem(item);
      });
      siteSearchList.append(button);
    }
  }

  async function playSiteItem(item) {
    const episodes = Array.isArray(item?.episodes) ? item.episodes : [];
    const pageUrl = episodes[0]?.pageUrl || item?.pageUrl;
    if (!pageUrl) return;
    closeSiteSearch();
    input.value = pageUrl;
    if (clearInputBtn) clearInputBtn.hidden = false;
    currentMedia = {
      id: item.pageUrl || pageUrl,
      baseTitle: item.title,
      title: item.title,
      cover: item.cover || "",
      sourceUrl: pageUrl,
      episodeName: episodes[0]?.name || "",
      episodeIndex: 0,
      platforms: [],
      platformId: "",
      episodes,
    };
    setLoading(true);
    setStatus("正在解析视频链接，请稍候…", "loading");
    searchSection.hidden = true;
    try {
      const data = await withEpisodes(pageUrl, await parse(pageUrl), episodes);
      const episodeIndex = data.episodeIndex || 0;
      showResult({
        ...data,
        title: item.title,
        baseTitle: item.title,
        cover: item.cover || data.cover || "",
        episodeName: data.episodeName || episodes[episodeIndex]?.name || "",
        episodeIndex,
        episodes: data.episodes,
      });
      setStatus("解析成功。", "");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "解析失败，请稍后重试。", "error");
    } finally {
      setLoading(false);
    }
  }

  function openSiteSearch(sites) {
    if (!siteSearchModal || !siteSearchTabs || !sites.length) return;
    siteSearchTabs.replaceChildren();
    sites.forEach((site, index) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `site-tab${index === 0 ? " is-active" : ""}`;
      tab.textContent = site.name;
      tab.addEventListener("click", () => {
        for (const node of siteSearchTabs.querySelectorAll(".site-tab")) {
          node.classList.toggle("is-active", node === tab);
        }
        renderSiteResults(site);
      });
      siteSearchTabs.append(tab);
    });
    renderSiteResults(sites[0]);
    siteSearchModal.hidden = false;
  }

  async function loadTitle(cat, id) {
    const response = await fetch(
      `/api/title?cat=${encodeURIComponent(cat)}&id=${encodeURIComponent(id)}`,
      { headers: { accept: "application/json" } },
    );
    let payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      console.warn("title response was not JSON", err);
    }
    if (!response.ok || !payload || payload.ok !== true) {
      throw new Error(payload?.error?.message || "剧目信息加载失败");
    }
    return payload.data;
  }

  function preferredPlatform(platforms) {
    const rank = ["qiyi", "qq", "youku", "imgo", "mgtv", "bilibili", "bilibili1"];
    const list = Array.isArray(platforms) ? platforms : [];
    for (const id of rank) {
      const found = list.find((item) => item.id === id && item.episodes?.length);
      if (found) return found;
    }
    return list.find((item) => item.episodes?.length) || null;
  }

  async function openTitle(item, episodeIndex) {
    setStatus(`正在读取《${item.title || "该剧"}》的播放平台…`, "loading");
    setLoading(true);
    try {
      const detail = await loadTitle(item.cat, item.id);
      const platform = preferredPlatform(detail?.platforms);
      if (!platform) {
        setStatus("这部剧暂时没有可用的平台页面。", "error");
        return;
      }
      const episodes = platform.episodes;
      const history = HistoryStore.get(`media_${detail.cat}_${detail.id}`);
      const savedIndex = typeof episodeIndex === "number"
        ? episodeIndex
        : (typeof history?.episodeIndex === "number" ? history.episodeIndex : 0);
      const targetIndex = Math.min(Math.max(savedIndex, 0), episodes.length - 1);
      currentMedia = {
        id: `media_${detail.cat}_${detail.id}`,
        cat: detail.cat,
        titleId: detail.id,
        baseTitle: detail.title || item.title,
        title: detail.title || item.title,
        cover: detail.cover || item.cover || "",
        platforms: detail.platforms,
        platformId: platform.id,
        episodes,
      };
      await selectEpisode(episodes[targetIndex], targetIndex);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "剧目信息加载失败", "error");
    } finally {
      setLoading(false);
    }
  }

  function renderSearchResults(items) {
    searchGrid.innerHTML = "";
    if (!items.length) {
      searchCount.textContent = "未找到相关影视资源";
      searchSection.hidden = false;
      return;
    }

    searchCount.textContent = `找到 ${items.length} 部相关作品`;
    searchSection.hidden = false;

    items.forEach((item) => {
      const card = document.createElement("div");
      card.className = "search-card";
      card.innerHTML = `
        <img class="search-card-poster" src="${item.cover || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 72 96'%3E%3Crect width='72' height='96' fill='%23171b18'/%3E%3C/svg%3E"}" alt="${item.title}" loading="lazy" />
        <div class="search-card-info">
          <div>
            <h4 class="search-card-title" title="${item.title}">${item.title}</h4>
            <div class="search-card-remarks">${item.remarks || (item.platforms?.map((platform) => platform.name).join(" / ") || "点击查看播放平台")}</div>
          </div>
          <p class="search-card-desc">${item.desc || "点击展开选集并播放"}</p>
        </div>
      `;

      card.addEventListener("click", () => {
        openTitle(item);
      });

      searchGrid.appendChild(card);
    });

    searchSection.scrollIntoView({ behavior: "smooth", block: "start" });
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

  /* =========================================================================
     5. 表单提交与事件监听
     ========================================================================= */
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = input.value.trim();

    if (!query) {
      setStatus("请输入剧名或视频链接。", "error");
      input.focus();
      return;
    }

    SearchHistory.save(query);
    if (searchHistory) searchHistory.hidden = true;
    setLoading(true);

    if (isUrl(query)) {
      // 轨道 A：直接 URL 单集解析
      setStatus("正在解析视频链接，请稍候…", "loading");
      searchSection.hidden = true;
      try {
        const data = await withEpisodes(query, await parse(query));
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
    } else {
      // 轨道 B：剧名搜索与选集聚合
      setStatus(`正在搜索《${query}》，请稍候…`, "loading");
      try {
        const items = await search(query);
        renderSearchResults(items);
        if (items.length) {
          setStatus("搜索完成，请选择剧目观看。", "");
        } else {
          setStatus("目录没有结果，正在查找视频网站…", "loading");
          const sites = await searchSites(query);
          if (sites.length) {
            openSiteSearch(sites);
            setStatus("目录没有这部，请从视频网站的结果里选择。", "");
          } else {
            setStatus("未找到相关影视资源。", "");
          }
        }
      } catch (err) {
        setStatus(
          err instanceof Error ? err.message : "搜索失败，请稍后重试。",
          "error",
        );
      } finally {
        setLoading(false);
      }
    }
  });

  // 输入框清空按钮控制
  input.addEventListener("input", () => {
    if (clearInputBtn) {
      clearInputBtn.hidden = !input.value.trim();
    }
    if (document.activeElement === input) renderSearchHistory();
  });

  input.addEventListener("focus", () => {
    renderSearchHistory();
  });

  input.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (!searchHistory?.contains(document.activeElement)) {
        if (searchHistory) searchHistory.hidden = true;
      }
    }, 120);
  });

  searchHistory?.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });

  clearSearchHistoryBtn?.addEventListener("click", () => {
    SearchHistory.clear();
    renderSearchHistory();
  });

  if (clearInputBtn) {
    clearInputBtn.addEventListener("click", () => {
      input.value = "";
      clearInputBtn.hidden = true;
      input.focus();
    });
  }

  // 历史记录弹窗事件
  if (historyToggleBtn) {
    historyToggleBtn.addEventListener("click", () => {
      renderHistory();
      historyModal.hidden = false;
    });
  }

  if (closeHistoryBtn) {
    closeHistoryBtn.addEventListener("click", () => {
      historyModal.hidden = true;
    });
  }

  closeSiteSearchBtn?.addEventListener("click", closeSiteSearch);
  siteSearchModal?.addEventListener("click", (event) => {
    if (event.target === siteSearchModal) closeSiteSearch();
  });

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener("click", () => {
      if (confirm("确定要清空全部播放历史记录吗？")) {
        HistoryStore.clear();
        renderHistory();
        setStatus("播放历史已清空。", "");
      }
    });
  }

  // 全集选集弹窗事件
  if (allEpisodesBtn) {
    allEpisodesBtn.addEventListener("click", () => {
      episodesModal.hidden = false;
    });
  }

  if (closeEpisodesBtn) {
    closeEpisodesBtn.addEventListener("click", () => {
      episodesModal.hidden = true;
    });
  }

  // 点击遮罩关闭弹窗
  window.addEventListener("click", (e) => {
    if (e.target === historyModal) historyModal.hidden = true;
    if (e.target === episodesModal) episodesModal.hidden = true;
  });

  const initialUrl = new URLSearchParams(window.location.search).get("url");
  if (initialUrl) {
    input.value = initialUrl;
    if (clearInputBtn) clearInputBtn.hidden = false;
    form.requestSubmit();
  }

  // 返回顶部浮动按钮逻辑
  const backToTopBtn = document.querySelector("#back-to-top");
  if (backToTopBtn) {
    window.addEventListener(
      "scroll",
      () => {
        backToTopBtn.hidden = window.scrollY < 300;
      },
      { passive: true },
    );
    backToTopBtn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }
})();
