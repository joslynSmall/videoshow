(() => {
  const form = document.querySelector("#parse-form");
  const input = document.querySelector("#url-input");
  const clearInputBtn = document.querySelector("#clear-input-button");
  const submit = document.querySelector("#submit-button");
  const status = document.querySelector("#status");
  const result = document.querySelector("#result");
  const player = document.querySelector("#player");
  const videoTitle = document.querySelector("#video-title");
  const sourceUrl = document.querySelector("#source-url");
  const expiry = document.querySelector("#expiry");
  const copyButton = document.querySelector("#copy-button");

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
  let lastPlayUrl = "";
  let currentMedia = null; // 当前播放的完整上下文信息
  let progressSaveTimer = 0;

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
        const record = {
          id: item.id,
          title: item.title || "未知视频",
          cover: item.cover || "",
          sourceUrl: item.sourceUrl || "",
          playUrl: item.playUrl || "",
          type: item.type || "m3u8",
          episodeName: item.episodeName || "",
          episodeIndex: typeof item.episodeIndex === "number" ? item.episodeIndex : 0,
          currentTime: Math.floor(item.currentTime || 0),
          duration: Math.floor(item.duration || 0),
          episodes: Array.isArray(item.episodes) ? item.episodes : [],
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

  function cleanBaseTitle(title) {
    if (!title) return "视频";
    return title.replace(/(\s+第\d+集|\s+全集|\s+正片)+/gi, "").trim() || title;
  }

  function showResult(data) {
    lastPlayUrl = data.playUrl;
    const baseTitle = data.baseTitle || currentMedia?.baseTitle || cleanBaseTitle(data.title);
    const displayTitle = data.episodeName ? `${baseTitle} ${data.episodeName}` : (data.title || baseTitle);

    videoTitle.textContent = displayTitle;
    sourceUrl.textContent = data.sourceUrl || input.value.trim();
    expiry.textContent = formatExpiry(data.expiresAt);
    copyButton.disabled = false;
    document.title = `${displayTitle} · videoshow`;

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

    // 检查历史断点
    const savedRecord = HistoryStore.get(currentMedia.id);
    const resumeTime = (savedRecord && savedRecord.currentTime > 5 && (savedRecord.duration - savedRecord.currentTime > 10))
      ? savedRecord.currentTime
      : 0;

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
      setStatus("视频加载失败，可能已过期，请重新解析。", "error");
    });

    // 渲染选集栏
    renderEpisodes(currentMedia.episodes, currentMedia.episodeIndex);

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
          if (c.available === false) {
            btn.disabled = true;
          } else if (!c.selected && c.playUrl) {
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
        const data = await parse(query);
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
        setStatus(items.length ? "搜索完成，请选择剧目观看。" : "未找到相关影视资源。", "");
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
