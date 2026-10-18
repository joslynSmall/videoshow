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
  const searchChannelSelect = document.querySelector("#search-channel");
  const SEARCH_CHANNEL_KEY = "videoshow_search_channel_v1";
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
  const PLAYBACK_RATES = [0.5, 0.8, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.5, 3];
  const autoplayNextInput = document.querySelector("#autoplay-next");
  const autoplayToggle = autoplayNextInput?.closest(".autoplay-toggle");
  const AUTOPLAY_NEXT_KEY = "videoshow_autoplay_next_v1";

  let art = null;
  let currentMedia = null; // 当前播放的完整上下文信息
  let progressSaveTimer = 0;
  let stallTimer = 0;
  let switchingLine = false;

  const devlogEl = document.querySelector("#devlog");
  const devlogList = document.querySelector("#devlog-list");
  const devlogCount = document.querySelector("#devlog-count");
  const devlogClear = document.querySelector("#devlog-clear");
  const DEVLOG_LIMIT = 200;
  const devlogEntries = [];

  function devlogValue(value) {
    if (value === null || value === undefined || value === "") return "-";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "-";
    if (typeof value === "boolean") return value ? "yes" : "no";
    if (Array.isArray(value)) return value.map(devlogValue).join(",");
    if (typeof value === "object") {
      return Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => `${key}=${devlogValue(item)}`)
        .join(" ");
    }
    return String(value);
  }

  function renderDevlog() {
    if (!devlogList) return;
    const fragment = document.createDocumentFragment();
    for (const entry of devlogEntries) {
      const item = document.createElement("li");
      item.className = `devlog-item${entry.level === "warn" ? " is-warn" : entry.level === "error" ? " is-error" : ""}`;
      const time = document.createElement("span");
      time.className = "t";
      time.textContent = entry.time;
      const event = document.createElement("span");
      event.className = "e";
      event.textContent = entry.event;
      const detail = document.createElement("span");
      detail.className = "d";
      detail.textContent = entry.detail ? ` ${entry.detail}` : "";
      item.append(time, event, detail);
      fragment.append(item);
    }
    devlogList.replaceChildren(fragment);
    if (devlogCount) {
      devlogCount.textContent = String(devlogEntries.length);
      devlogCount.hidden = devlogEntries.length === 0;
    }
    if (devlogEl?.open) {
      const panel = devlogEl.querySelector(".devlog-panel");
      if (panel) panel.scrollTop = panel.scrollHeight;
    }
  }

  function devlog(event, detail = "", level = "info") {
    devlogEntries.push({
      time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      event,
      detail: typeof detail === "string" ? detail : devlogValue(detail),
      level,
    });
    if (devlogEntries.length > DEVLOG_LIMIT) devlogEntries.shift();
    renderDevlog();
  }

  function devlogCandidates(label, candidates) {
    for (const item of candidates || []) {
      devlog(label, {
        provider: item.provider,
        available: item.available,
        verified: item.verified,
        singleUse: item.singleUse,
        ttfbMs: item.ttfbMs ?? "-",
        speedKBps: item.speedKBps ?? "-",
        score: item.score ?? "-",
        selected: item.selected,
        host: hostOf(item.playUrl),
      }, item.available === false ? "warn" : "info");
    }
  }

  function devlogLatencyRanking(data) {
    const candidates = new Map((data.candidates || []).map((item) => [item.provider, item]));
    const rows = (data.diagnostics || []).map((item) => {
      const candidate = candidates.get(item.provider);
      return {
        provider: item.provider,
        status: item.status,
        resolveMs: item.ms,
        ttfbMs: item.ttfbMs ?? candidate?.ttfbMs ?? null,
        speedKBps: item.speedKBps ?? candidate?.speedKBps ?? null,
        score: item.score ?? candidate?.score ?? null,
        selected: candidate?.selected === true,
        code: item.code,
        message: item.message,
        detail: item.detail,
      };
    });
    if (!rows.length) return;
    const group = (item) => {
      if (item.status === "benchmarked") return 0;
      if (item.status === "single-use") return 1;
      if (item.status === "rejected" || item.status === "benchmark-rejected") return 2;
      return 3;
    };
    rows.sort((a, b) =>
      group(a) - group(b) ||
      (group(a) === 0
        ? (a.ttfbMs ?? Infinity) - (b.ttfbMs ?? Infinity) ||
          (b.speedKBps ?? 0) - (a.speedKBps ?? 0)
        : (a.resolveMs ?? Infinity) - (b.resolveMs ?? Infinity)));
    const lines = rows.map((item, index) => {
      const parts = [
        `${index + 1}. ${item.provider}`,
        `status=${item.status}`,
        `解析耗时=${item.resolveMs ?? "-"}ms`,
      ];
      if (item.status === "benchmarked") {
        parts.push(
          `TTFB=${item.ttfbMs ?? "-"}ms`,
          `速度=${item.speedKBps ?? "-"}KB/s`,
          `score=${item.score ?? "-"}`,
        );
      } else if (item.status === "single-use") {
        parts.push("TTFB=未测速", "速度=未测速");
      } else if (item.code || item.message) {
        parts.push(`error=${[item.code, item.message].filter(Boolean).join(":")}`);
        if (item.detail) parts.push(`detail=${devlogValue(item.detail)}`);
      }
      if (item.selected) parts.push("selected");
      return parts.join(" ");
    });
    devlog(
      "渠道延迟排行",
      "\n排序：已验证按 TTFB 升序，单次链接/失败按解析耗时\n" + lines.join("\n"),
      "info",
    );
  }

  if (devlogClear) {
    devlogClear.addEventListener("click", () => {
      devlogEntries.length = 0;
      renderDevlog();
    });
  }

  devlog("初始化", "选择规则：可用优先 > 已验证优先 > score 高 > TTFB 低；冰豆仅在无可用主线路时回退");

  if (autoplayNextInput) {
    try {
      autoplayNextInput.checked = localStorage.getItem(AUTOPLAY_NEXT_KEY) !== "0";
    } catch {
      autoplayNextInput.checked = true;
    }
    autoplayNextInput.addEventListener("change", () => {
      try {
        localStorage.setItem(AUTOPLAY_NEXT_KEY, autoplayNextInput.checked ? "1" : "0");
      } catch {}
      devlog("自动下一集", { enabled: autoplayNextInput.checked }, "info");
    });
  }

  if (searchChannelSelect) {
    try {
      searchChannelSelect.value = localStorage.getItem(SEARCH_CHANNEL_KEY) === "sites" ? "sites" : "api";
    } catch {
      searchChannelSelect.value = "api";
    }
    searchChannelSelect.addEventListener("change", () => {
      const channel = searchChannelSelect.value === "sites" ? "sites" : "api";
      try {
        localStorage.setItem(SEARCH_CHANNEL_KEY, channel);
      } catch {}
      devlog("搜索渠道", { channel: channel === "sites" ? "视频网站" : "API 渠道" }, "info");
    });
  }

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
    artInstance.activeHlsUrl = url;
    artInstance.hls?.destroy();
    artInstance.hls = null;
    const startHls = (source) => {
      if (artInstance.activeHlsUrl !== url) return;
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
      artInstance.hls = hls;
      hls.loadSource(source);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.ERROR, (_event, detail) => {
        if (artInstance.hls !== hls || artInstance.activeHlsUrl !== url) return;
        if (!detail?.fatal) {
          if (detail?.type === "networkError") {
            devlog("HLS 网络错误", {
              details: detail.details,
              host: hostOf(url),
            }, "warn");
          }
          return;
        }
        devlog("HLS 致命错误", {
          type: detail.type,
          details: detail.details,
          host: hostOf(url),
        }, "error");
        hls.destroy();
        artInstance.hls = null;
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
    };

    const useRecovered = (recovered) => {
      if (artInstance.activeHlsUrl !== url) return;
      devlog("HLS 自动恢复", {
        fromHost: hostOf(url),
        toHost: hostOf(recovered.playUrl),
        provider: recovered.provider || "-",
      }, "warn");
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

  async function pickFasterSource(sourceUrl, failedPlayUrls, refreshed = false) {
    devlog("重新测速", { excluded: failedPlayUrls.length, refreshed }, "info");
    try {
      const response = await fetch("/api/race", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ sourceUrl, failedPlayUrls }),
      });
      const payload = await response.json();
      const candidates = payload?.data?.candidates || [];
      const selected = payload?.data?.selected;
      devlog("race 响应", {
        status: response.status,
        selected: selected?.provider || "none",
        host: hostOf(selected?.playUrl),
        available: candidates.filter((item) => item.available !== false).length,
        total: candidates.length,
        filtered: payload?.data?.filtered,
      }, selected ? "info" : "warn");
      devlogCandidates("race 候选", candidates);
      const raceRanked = [...candidates].sort((a, b) =>
        Number(b.available !== false) - Number(a.available !== false) ||
        (b.score ?? 0) - (a.score ?? 0) ||
        (a.ttfbMs ?? Infinity) - (b.ttfbMs ?? Infinity));
      if (raceRanked.length) {
        devlog("race 排行", "\n" + raceRanked.map((item, index) => {
          const flags = [item.selected ? "selected" : "", item.singleUse ? "singleUse" : ""]
            .filter(Boolean).join(" ");
          return `${index + 1}. ${item.provider} TTFB=${item.ttfbMs ?? "-"}ms 速度=${item.speedKBps ?? "-"}KB/s score=${item.score ?? "-"}${flags ? ` ${flags}` : ""}`;
        }).join("\n"), "info");
      }
      if (response.status === 409 && !refreshed) {
        devlog("race 缓存过期", "重新解析后重试", "warn");
        await parse(sourceUrl);
        return pickFasterSource(sourceUrl, failedPlayUrls, true);
      }
      if (response.ok && selected?.playUrl && selected.available !== false) return selected;
      if (response.ok && !selected && !refreshed) {
        devlog("race 无候选", "重新解析以刷新单次签名地址", "warn");
        try {
          await parse(sourceUrl);
        } catch (err) {
          devlog("重新解析失败", err instanceof Error ? err.message : String(err), "error");
          return null;
        }
        return pickFasterSource(sourceUrl, failedPlayUrls, true);
      }
      devlog("race 无可用候选", {
        status: response.status,
        filtered: payload?.data?.filtered,
      }, "warn");
    } catch (err) {
      devlog("race 失败", err instanceof Error ? err.message : String(err), "error");
      console.warn("重新测速失败", err);
    }
    return null;
  }

  async function switchToSmootherSource(data) {
    if (switchingLine || !art) {
      devlog("换线跳过", switchingLine ? "已有换线进行中" : "播放器不存在", "warn");
      return;
    }
    const instance = art;
    const continueAt = Number.isFinite(instance.currentTime) ? instance.currentTime : 0;
    const failed = new Set(Array.isArray(data.failedPlayUrls) ? data.failedPlayUrls : []);
    if (data.playUrl) failed.add(data.playUrl);
    switchingLine = true;
    clearStallTimer();
    setStatus("播放不够流畅，正在更换线路…", "loading");
    devlog("触发换线", {
      from: data.provider || "-",
      fromHost: hostOf(data.playUrl),
      continueAt: Math.round(continueAt),
      failed: failed.size,
    }, "warn");
    try {
      for (let attempts = 0; attempts < 8; attempts += 1) {
        devlog("换线尝试", { attempt: attempts + 1, excluded: failed.size }, "info");
        const chosen = await pickFasterSource(data.sourceUrl, [...failed]);
        if (art !== instance) {
          devlog("换线中止", "播放器已重建", "warn");
          return;
        }
        if (!chosen?.playUrl || failed.has(chosen.playUrl)) {
          devlog("换线结束", chosen?.playUrl ? "候选已被标记失败" : "没有可用候选", "warn");
          break;
        }
        devlog("切换线路", {
          from: data.provider || "-",
          to: chosen.provider || "-",
          fromHost: hostOf(data.playUrl),
          toHost: hostOf(chosen.playUrl),
          type: chosen.type,
          singleUse: chosen.singleUse === true,
          ttfbMs: chosen.ttfbMs ?? "-",
          speedKBps: chosen.speedKBps ?? "-",
        }, "warn");
        failed.add(chosen.playUrl);
        try {
          instance.activeHlsUrl = null;
          instance.hls?.destroy();
          instance.hls = null;
          instance.type = chosen.type;
          await instance.switchQuality(chosen.playUrl);
          if (art !== instance) return;
          reportPlayback("playback.switch", {
            fromHost: hostOf(data.playUrl),
            toHost: hostOf(chosen.playUrl),
            episode: data.episodeName || "",
            continueAt,
          });
          devlog("换线成功", {
            provider: chosen.provider || "-",
            host: hostOf(chosen.playUrl),
            at: Math.round(continueAt),
          }, "info");
          data.playUrl = chosen.playUrl;
          data.type = chosen.type;
          data.failedPlayUrls = [...failed].filter((url) => url !== chosen.playUrl);
          if (currentMedia) {
            currentMedia.playUrl = chosen.playUrl;
            currentMedia.type = chosen.type;
          }
          setStatus("", "");
          return;
        } catch (err) {
          devlog("换线失败", err instanceof Error ? err.message : String(err), "error");
          console.warn("线路切换失败", err);
        }
      }
      reportPlayback("playback.failed", {
        playHost: hostOf(data.playUrl),
        episode: data.episodeName || "",
        reason: "no-alternative",
      });
      devlog("换线结束", "没有可用备用线路", "error");
      setStatus("暂时播不了，请稍后再试。", "error");
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
    devlog("播放事件", { event, ...fields }, event === "playback.failed" ? "error" : "info");
    fetch("/api/client-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, ...fields }),
    }).catch(() => {});
  }

  function showResult(data) {
    clearStallTimer();
    devlog("解析结果", {
      provider: data.provider || "-",
      type: data.type || "-",
      host: hostOf(data.playUrl),
      singleUse: data.singleUse === true,
      verified: data.verified !== false,
      cached: data.cached === true,
    }, data.singleUse ? "warn" : "info");
    for (const item of data.diagnostics || []) {
      devlog("渠道诊断", {
        provider: item.provider,
        status: item.status,
        ms: item.ms,
        code: item.code,
        message: item.message,
        detail: item.detail,
        ttfbMs: item.ttfbMs ?? "-",
        speedKBps: item.speedKBps ?? "-",
        host: item.playHost,
      }, item.status === "rejected" || item.status === "benchmark-rejected" ? "warn" : "info");
    }
    devlogLatencyRanking(data);
    devlogCandidates("候选线路", data.candidates);
    const selectedCandidate = (data.candidates || []).find((item) => item.selected);
    if (selectedCandidate) {
      devlog("选择依据", {
        rule: data.singleUse
          ? "无已验证线路，使用单次签名链接"
          : "可用优先 > 已验证优先 > score 高 > TTFB 低",
        provider: selectedCandidate.provider,
        ttfbMs: selectedCandidate.ttfbMs ?? "-",
        speedKBps: selectedCandidate.speedKBps ?? "-",
        score: selectedCandidate.score ?? "-",
      }, "info");
    }
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
    let sourceAttached = data.type !== "m3u8";
    const failPlayback = () => {
      if (!sourceAttached || playbackFailed) return;
      playbackFailed = true;
      clearStallTimer();
      switchToSmootherSource(data);
    };

    window.Artplayer.PLAYBACK_RATE = PLAYBACK_RATES;
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
          fontSize: 20,
          speed: 5,
          opacity: 1,
          antiOverlap: true,
        }),
      ],
    });

    art.on("video:playing", () => {
      playbackFailed = false;
      clearStallTimer();
      if (status.classList.contains("loading")) setStatus("", "");
    });
    art.on("video:waiting", () => {
      clearStallTimer();
      stallTimer = window.setTimeout(() => {
        const current = player.querySelector("video");
        if (!current || current.paused || current.readyState >= 3) {
          devlog("卡顿恢复", {
            currentTime: Math.round(current?.currentTime || 0),
            readyState: current?.readyState ?? "-",
          }, "info");
          return;
        }
        devlog("卡顿超时", {
          currentTime: Math.round(current.currentTime),
          readyState: current.readyState,
          paused: current.paused,
        }, "warn");
        failPlayback();
      }, 8000);
    });
    art.on("destroy", clearStallTimer);
    const activeArt = art;
    art.on("destroy", () => activeArt.hls?.destroy());

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

    art.on("video:ended", () => {
      if (art !== activeArt) return;
      if (currentMedia && Number.isFinite(art.duration) && art.duration > 0) {
        HistoryStore.save({
          ...currentMedia,
          currentTime: art.currentTime,
          duration: art.duration,
        });
      }
      playNextEpisode();
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
    if (autoplayToggle) autoplayToggle.hidden = !showEpisodes;
    renderPlatforms(platforms, currentMedia?.platformId);
    currentEpisodeText.textContent = episodes?.[activeIndex]?.name || `第 ${activeIndex + 1} 集`;
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
      const gridLabel = document.createElement("span");
      gridLabel.className = "episode-btn-label";
      gridLabel.textContent = ep.name || `${idx + 1}`;
      gridBtn.appendChild(gridLabel);
      gridBtn.addEventListener("click", () => {
        episodesModal.hidden = true;
        selectEpisode(ep, idx);
      });
      episodesGrid.appendChild(gridBtn);
    });

    requestAnimationFrame(() => placeActiveEpisode(activeIndex));
  }

  let autoNextPending = false;

  function playNextEpisode() {
    if (!autoplayNextInput?.checked || autoNextPending || switchingLine) return;
    const episodes = currentMedia?.episodes;
    const index = currentMedia?.episodeIndex;
    if (!Array.isArray(episodes) || !Number.isInteger(index)) return;
    const next = episodes[index + 1];
    if (!next?.pageUrl) return;

    autoNextPending = true;
    devlog("自动下一集", {
      from: currentMedia.episodeName || `第 ${index + 1} 集`,
      to: next.name || `第 ${index + 2} 集`,
    }, "info");
    setStatus(`播放结束，正在自动播放${next.name || "下一集"}…`, "loading");
    selectEpisode(next, index + 1)
      .catch((err) => {
        setStatus(err instanceof Error ? err.message : "解析失败，请稍后重试。", "error");
      })
      .finally(() => {
        autoNextPending = false;
      });
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
    devlog("解析请求", { host: hostOf(url) }, "info");
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
      devlog("解析失败", {
        status: response.status,
        code: payload?.error?.code,
        message,
      }, "error");
      throw new Error(message);
    }

    devlog("解析响应", {
      status: response.status,
      provider: payload?.data?.provider,
      candidates: payload?.data?.candidates?.length || 0,
      diagnostics: payload?.data?.diagnostics?.length || 0,
    }, "info");
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
      // 轨道 B：按搜索渠道二选一
      const channel = searchChannelSelect?.value === "sites" ? "sites" : "api";
      searchSection.hidden = true;
      searchGrid.innerHTML = "";

      if (channel === "sites") {
        setStatus(`正在通过视频网站搜索《${query}》，请稍候…`, "loading");
        try {
          const sites = await searchSites(query);
          if (sites.length) {
            openSiteSearch(sites);
            setStatus("视频网站搜索完成，请选择结果。", "");
          } else {
            setStatus("视频网站未找到相关资源。", "");
          }
        } catch (err) {
          setStatus(
            err instanceof Error ? err.message : "视频网站搜索失败，请稍后重试。",
            "error",
          );
        } finally {
          setLoading(false);
        }
        return;
      }

      setStatus(`正在通过 API 渠道搜索《${query}》，请稍候…`, "loading");
      try {
        const items = await search(query);
        renderSearchResults(items);
        if (items.length) {
          setStatus("搜索完成，请选择剧目观看。", "");
        } else {
          setStatus("API 渠道未找到相关作品，可切换到“视频网站”再试。", "");
        }
      } catch (err) {
        setStatus(
          err instanceof Error ? err.message : "API 渠道搜索失败，请稍后重试。",
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
