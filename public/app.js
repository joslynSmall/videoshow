import { stripAdBlocks } from "/ad-filter.js";
import { splitDanmakuText } from "/danmaku-text.js";
import { createLineBook } from "/line-book.js";
import { readResolveStream } from "/resolve-stream.js";
import { createStallMonitor } from "/stall-monitor.js";

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

  const loadingOverlay = document.querySelector("#loading-overlay");
  const loadingText = document.querySelector("#loading-text");
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
  // 播放器上的快进/快退按钮步长，与 Artplayer 默认键盘 SEEK_STEP(5s) 区分开。
  const SEEK_BUTTON_STEP = 10;
  const autoplayNextInput = document.querySelector("#autoplay-next");
  const autoplayToggle = autoplayNextInput?.closest(".autoplay-toggle");
  const AUTOPLAY_NEXT_KEY = "videoshow_autoplay_next_v1";

  let art = null;
  let currentMedia = null; // 当前播放的完整上下文信息
  let progressSaveTimer = 0;
  let stallTimer = 0;
  let switchingLine = false;
  // 当前播放器的看门狗重启函数：换线成功后对新线路重新计时（起播阶段重新开始）。
  let resumeWatchdog = null;
  // 换线中新线路出现致命错误时，用它让本次尝试立即失败并进入下一个候选，否则会一直等下去。
  let rejectSwitch = null;
  // 新线路连续这么久没有任何数据进展（清单、分片都没有动静）就视为本次换线失败；
  // 有数据在下载时放宽到上限，慢但健康的线路不会被误杀。
  const SWITCH_IDLE_MS = 12000;
  const SWITCH_MAX_MS = 24000;
  // 一直没有线路到达时，这么久之后提示用户仍在继续尝试（不终止解析）。
  const SLOW_RESOLVE_HINT_MS = 30000;
  // 换线时解析仍在进行，最多等这么久新线路。
  const LATE_LINE_WAIT_MS = 30000;
  // 当前解析会话：线路簿、事件流游标、标题等；换集或重新解析时关闭。
  let activeSession = null;

  const devModal = document.querySelector("#dev-modal");
  const devConsoleToggle = document.querySelector("#dev-console-toggle");
  const closeDevModalBtn = document.querySelector("#close-dev-modal");
  const devAuthGate = document.querySelector("#dev-auth-gate");
  const devAuthForm = document.querySelector("#dev-auth-form");
  const devPasswordInput = document.querySelector("#dev-password-input");
  const devAuthError = document.querySelector("#dev-auth-error");
  const devConsoleBody = document.querySelector("#dev-console-body");

  const devTabPlayback = document.querySelector("#dev-tab-playback");
  const devTabHealth = document.querySelector("#dev-tab-health");
  const devTabManage = document.querySelector("#dev-tab-manage");
  const devPanelPlayback = document.querySelector("#dev-panel-playback");
  const devPanelHealth = document.querySelector("#dev-panel-health");
  const devPanelManage = document.querySelector("#dev-panel-manage");

  const devRefreshHealthBtn = document.querySelector("#dev-refresh-health");
  const devSyncRemoteBtn = document.querySelector("#dev-sync-remote");
  const devHealthSummary = document.querySelector("#dev-health-summary");
  const devHealthList = document.querySelector("#dev-health-list");

  const devChannelAddForm = document.querySelector("#dev-channel-add-form");
  const devChannelItems = document.querySelector("#dev-channel-items");
  const channelFormTip = document.querySelector("#channel-form-tip");

  const DEV_AUTH_SESSION_KEY = "videoshow_dev_authed_v1";
  const DEV_AUTH_PWD_KEY = "videoshow_dev_pwd_v1";
  const DEFAULT_DEV_PASSWORD = "adminysdev";

  function getDevPassword() {
    try {
      return sessionStorage.getItem(DEV_AUTH_PWD_KEY) || DEFAULT_DEV_PASSWORD;
    } catch {
      return DEFAULT_DEV_PASSWORD;
    }
  }

  function escapeHtml(raw) {
    return String(raw ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

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

  function formatReason(line) {
    if (!line) return "首选可用";
    const parts = [];
    if (line.snapshot) parts.push("短时效线路，已取得清单快照");
    if (line.verified === false) parts.push("服务端未校验");
    if (typeof line.ttfbMs === "number" && Number.isFinite(line.ttfbMs)) {
      parts.push(`首包 ${Math.round(line.ttfbMs)}ms`);
    } else if (line.unmeasured) {
      parts.push("测速未完成");
    }
    return parts.length ? `最先到达的可用线路（${parts.join("，")}）` : "最先到达的可用线路";
  }

  function devlogSelection(data) {
    const line = data.line;
    const provider = line?.provider || data.provider || "未知";
    const host = line?.host || hostOf(data.playUrl);
    devlog("已选择线路", `【${provider}】(主机: ${host || "-"} | 原因: ${formatReason(line)})`, "info");
  }

  if (devlogClear) {
    devlogClear.addEventListener("click", () => {
      devlogEntries.length = 0;
      renderDevlog();
    });
  }

  /* =========================================================================
     Channel Console (控制台、密码鉴权、Tab 切换与渠道维护)
     ========================================================================= */
  let devConsoleAuthed = false;
  try {
    devConsoleAuthed = sessionStorage.getItem(DEV_AUTH_SESSION_KEY) === "1";
  } catch {}

  function openDevConsole() {
    if (!devModal) return;
    devModal.hidden = false;
    if (devConsoleAuthed) {
      devAuthGate.hidden = true;
      devConsoleBody.hidden = false;
      renderHealthTab();
      renderManageTab();
    } else {
      devAuthGate.hidden = false;
      devConsoleBody.hidden = true;
      devPasswordInput.value = "";
      devAuthError.hidden = true;
      setTimeout(() => devPasswordInput.focus(), 50);
    }
  }

  function closeDevConsole() {
    if (devModal) devModal.hidden = true;
  }

  devConsoleToggle?.addEventListener("click", openDevConsole);
  closeDevModalBtn?.addEventListener("click", closeDevConsole);
  devModal?.addEventListener("click", (e) => {
    if (e.target === devModal) closeDevConsole();
  });

  devAuthForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pwd = devPasswordInput.value.trim();
    // 双重校验：优先走后端验证，若离线/服务异常则本地校验兜底
    let verified = false;
    try {
      const res = await fetch("/api/dev/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: pwd })
      });
      const data = await res.json();
      verified = res.ok && data?.ok === true;
    } catch {
      verified = pwd === DEFAULT_DEV_PASSWORD;
    }

    if (verified) {
      devConsoleAuthed = true;
      try {
        sessionStorage.setItem(DEV_AUTH_SESSION_KEY, "1");
        sessionStorage.setItem(DEV_AUTH_PWD_KEY, pwd);
      } catch {}
      devAuthError.hidden = true;
      devAuthGate.hidden = true;
      devConsoleBody.hidden = false;
      renderHealthTab();
      renderManageTab();
    } else {
      devAuthError.hidden = false;
      devPasswordInput.select();
    }
  });

  function switchDevTab(activeTab) {
    const tabs = [
      { tab: devTabPlayback, panel: devPanelPlayback },
      { tab: devTabHealth, panel: devPanelHealth },
      { tab: devTabManage, panel: devPanelManage },
    ];
    for (const item of tabs) {
      const match = item.tab === activeTab;
      item.tab?.classList.toggle("is-active", match);
      if (item.panel) item.panel.hidden = !match;
    }
    if (activeTab === devTabHealth) renderHealthTab();
    if (activeTab === devTabManage) renderManageTab();
  }

  devTabPlayback?.addEventListener("click", () => switchDevTab(devTabPlayback));
  devTabHealth?.addEventListener("click", () => switchDevTab(devTabHealth));
  devTabManage?.addEventListener("click", () => switchDevTab(devTabManage));

  async function fetchChannelsStatus() {
    const res = await fetch("/api/channels");
    const json = await res.json();
    return json?.data || { channels: [] };
  }

  async function renderHealthTab() {
    if (!devHealthList || !devHealthSummary) return;
    devHealthList.innerHTML = '<p class="status loading">正在加载渠道健康账本…</p>';
    try {
      const data = await fetchChannelsStatus();
      const channels = data.channels || [];
      const activeCount = channels.filter(c => c.state === "active").length;
      const removedCount = channels.filter(c => c.state === "removed").length;
      const totalAttempts = channels.reduce((sum, c) => sum + (c.today?.attempts || 0), 0);
      const totalSuccesses = channels.reduce((sum, c) => sum + (c.today?.successes || 0), 0);

      devHealthSummary.innerHTML = `
        <div class="health-stat-card">
          <div class="health-stat-label">活跃渠道数</div>
          <div class="health-stat-value">${activeCount} <span style="font-size:12px;color:var(--muted)">/ ${channels.length}</span></div>
        </div>
        <div class="health-stat-card">
          <div class="health-stat-label">今日总调用 / 成功</div>
          <div class="health-stat-value">${totalAttempts} <span style="font-size:12px;color:var(--accent)">/ ${totalSuccesses}</span></div>
        </div>
        <div class="health-stat-card">
          <div class="health-stat-label">已熔断清理渠道</div>
          <div class="health-stat-value" style="color:var(--danger)">${removedCount}</div>
        </div>
      `;

      if (!channels.length) {
        devHealthList.innerHTML = '<p class="status">暂无任何渠道记录</p>';
        return;
      }

      devHealthList.innerHTML = channels.map(c => {
        const stateClass = c.state === "active" ? "is-active" : c.state === "removed" ? "is-removed" : "is-disabled";
        const stateText = c.state === "active" ? "正常运行" : c.state === "removed" ? "已熔断剔除" : "已停用";
        const unavailDays = (c.unavailableDays || []).join(", ") || "无";
        return `
          <div class="channel-item-row">
            <div class="channel-item-main">
              <div class="channel-item-title">
                <span>${escapeHtml(c.name)}</span>
                <span class="channel-type-badge">${escapeHtml(c.id)}</span>
                <span class="channel-state-badge ${stateClass}">${stateText}</span>
              </div>
              <div class="channel-item-endpoint">
                今日调用: ${c.today?.attempts || 0}次 (成功 ${c.today?.successes || 0}次) · 不可用自然日: ${escapeHtml(unavailDays)} ${c.reason ? `· 原因: ${escapeHtml(c.reason)}` : ""}
              </div>
            </div>
          </div>
        `;
      }).join("");
    } catch (err) {
      devHealthList.innerHTML = `<p class="status error">加载失败: ${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`;
    }
  }

  devRefreshHealthBtn?.addEventListener("click", renderHealthTab);

  devSyncRemoteBtn?.addEventListener("click", async () => {
    devSyncRemoteBtn.disabled = true;
    devSyncRemoteBtn.textContent = "同步中…";
    try {
      const res = await fetch("/api/channels/sync", {
        method: "POST",
        headers: { "x-dev-password": getDevPassword() },
      });
      const json = await res.json();
      if (!json?.ok) throw new Error(json?.error?.message || "同步失败");
      await renderHealthTab();
      await renderManageTab();
      alert(json.data?.refreshed ? "源头已成功同步并更新渠道！" : "源头同步完成（无配置地址或已是最新）");
    } catch (err) {
      alert(`同步失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      devSyncRemoteBtn.disabled = false;
      devSyncRemoteBtn.textContent = "手动同步源头";
    }
  });

  async function renderManageTab() {
    if (!devChannelItems) return;
    devChannelItems.innerHTML = '<p class="status loading">正在加载渠道配置…</p>';
    try {
      const data = await fetchChannelsStatus();
      const channels = data.channels || [];
      if (!channels.length) {
        devChannelItems.innerHTML = '<p class="status">暂无渠道配置</p>';
        return;
      }
      devChannelItems.innerHTML = channels.map(c => {
        const stateClass = c.state === "active" ? "is-active" : c.state === "removed" ? "is-removed" : "is-disabled";
        const stateText = c.state === "active" ? "启用中" : c.state === "removed" ? "已熔断" : "已停用";
        const safeId = escapeHtml(c.id);
        return `
          <div class="channel-item-row" data-channel-id="${safeId}">
            <div class="channel-item-main">
              <div class="channel-item-title">
                <span>${escapeHtml(c.name)}</span>
                <span class="channel-type-badge">${safeId}</span>
                <span class="channel-state-badge ${stateClass}">${stateText}</span>
              </div>
            </div>
            <div class="channel-item-actions" style="display:flex;gap:6px;">
              ${c.state === "active"
                ? `<button type="button" class="ghost-button mini-button danger-ghost channel-disable-btn" data-id="${safeId}">禁用</button>`
                : `<button type="button" class="ghost-button mini-button channel-enable-btn" data-id="${safeId}">启用</button>`
              }
              ${c.custom
                ? `<button type="button" class="ghost-button mini-button danger-ghost channel-delete-btn" data-id="${safeId}">删除</button>`
                : ""
              }
            </div>
          </div>
        `;
      }).join("");

      devChannelItems.querySelectorAll(".channel-disable-btn").forEach(btn => {
        btn.addEventListener("click", () => toggleChannel(btn.dataset.id, false));
      });
      devChannelItems.querySelectorAll(".channel-enable-btn").forEach(btn => {
        btn.addEventListener("click", () => toggleChannel(btn.dataset.id, true));
      });
      devChannelItems.querySelectorAll(".channel-delete-btn").forEach(btn => {
        btn.addEventListener("click", () => deleteChannel(btn.dataset.id));
      });
    } catch (err) {
      devChannelItems.innerHTML = `<p class="status error">加载失败: ${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`;
    }
  }

  async function toggleChannel(channelId, enable) {
    try {
      const res = await fetch("/api/channels", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dev-password": getDevPassword(),
        },
        body: JSON.stringify({
          channels: [{ id: channelId, enabled: enable }]
        })
      });
      const json = await res.json();
      if (!json?.ok) throw new Error(json?.error?.message || "操作失败");
      renderManageTab();
      renderHealthTab();
    } catch (err) {
      alert(`更新渠道状态失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function deleteChannel(channelId) {
    try {
      const res = await fetch("/api/channels", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dev-password": getDevPassword(),
        },
        body: JSON.stringify({
          channels: [{ id: channelId, deleted: true }]
        })
      });
      const json = await res.json();
      if (!json?.ok) throw new Error(json?.error?.message || "删除失败");
      renderManageTab();
      renderHealthTab();
    } catch (err) {
      alert(`删除渠道失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  devChannelAddForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.querySelector("#new-channel-id")?.value.trim().toLowerCase();
    const name = document.querySelector("#new-channel-name")?.value.trim();
    const type = document.querySelector("#new-channel-type")?.value;
    const endpoint = document.querySelector("#new-channel-endpoint")?.value.trim();

    channelFormTip.textContent = "正在提交…";
    channelFormTip.className = "channel-form-tip";

    try {
      const res = await fetch("/api/channels", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dev-password": getDevPassword(),
        },
        body: JSON.stringify({
          channels: [{ id, name, type, endpoint, enabled: true }]
        })
      });
      const json = await res.json();
      if (!json?.ok || json?.data?.rejected?.length) {
        const reason = json?.data?.rejected?.[0]?.reason || json?.error?.message || "添加失败";
        throw new Error(reason);
      }
      channelFormTip.textContent = "添加成功！";
      channelFormTip.className = "channel-form-tip is-success";
      devChannelAddForm.reset();
      renderManageTab();
      renderHealthTab();
    } catch (err) {
      channelFormTip.textContent = `失败: ${err instanceof Error ? err.message : String(err)}`;
      channelFormTip.className = "channel-form-tip is-error";
    }
  });

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
    // 同一个句柄既可能是 timeout（换线前的守卫）也可能是 interval（播放看门狗），两种都要清。
    window.clearTimeout(stallTimer);
    window.clearInterval(stallTimer);
    stallTimer = 0;
  }

  // 播放器上的快进/快退按钮。手机上没有物理键盘，默认的方向键快进不可用，
  // 所以在控制区追加两个可点按钮，每次跳转 SEEK_BUTTON_STEP 秒。
  // 使用与 Artplayer 控制栏一致的 SVG 图标与样式。
  function seekButton(name, step, label, svgPaths, index) {
    return {
      name,
      position: "right",
      index,
      tooltip: label,
      html: `<i class="art-icon art-icon-${name}" style="display:flex;align-items:center;justify-content:center;width:100%;height:100%"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">${svgPaths}</svg></i>`,
      click: () => {
        if (!art || switchingLine) return;
        const duration = Number(art.duration);
        const current = Number(art.currentTime) || 0;
        // 跳转目标夹在 [0, duration]，避免快退到负值或快进越过片尾。
        const target = Math.min(
          Number.isFinite(duration) && duration > 0 ? duration : Infinity,
          Math.max(0, current + step),
        );
        art.currentTime = target;
        art.notice.show = `${label} ${formatTime(Math.abs(target - current))}`;
        devlog("快进快退", { action: label, from: Math.round(current), to: Math.round(target) }, "info");
      },
    };
  }

  // 弹幕插件的渲染循环门控在 art.playing 上，而 Artplayer 的 playing 定义要求
  // readyState > 2（HAVE_FUTURE_DATA）。缓冲一耗尽，art.playing 变为 false，
  // 插件立即停止推进与渲染，屏幕上最后一条弹幕也会一起消失。
  // 这里接管 art.playing：只要用户确实想看（已播放过且未暂停未结束）就视为正在播放，
  // 让画面卡顿时弹幕保持静止显示，而不是整层不见。
  function keepDanmakuVisibleDuringStall(instance) {
    if (!instance) return;
    let startedPlaying = false;
    instance.on("video:playing", () => {
      startedPlaying = true;
    });
    // Artplayer 把 playing 定义为不可配置的 getter（defineProperty 会抛
    // "Cannot redefine property"），所以不能直接覆盖；改为拦截原型链上的读取。
    const proto = Object.getPrototypeOf(instance);
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, "playing");
    if (!descriptor || typeof descriptor.get !== "function") return;
    Object.defineProperty(proto, "playing", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        const value = descriptor.get.call(this);
        if (value) return true;
        // 原判定为 false 时再判断是否只是卡顿：用户确实想看且没暂停，就仍然算正在播放。
        const video = this.template?.$video;
        if (!video) return false;
        if (video.paused || video.ended) return false;
        return startedPlaying || video.currentTime > 0;
      },
    });
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

  function setLoading(loading, message = "") {
    submit.disabled = loading;
    submit.textContent = loading ? "解析中…" : "解析";
    form.setAttribute("aria-busy", String(loading));
    if (loadingOverlay) {
      if (loading) {
        if (loadingText && message) loadingText.textContent = message;
        loadingOverlay.hidden = false;
      } else {
        loadingOverlay.hidden = true;
      }
    }
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
      art.destroy(false);
      art = null;
    }
  }

  // 出现误判时可在控制台执行 localStorage.setItem("videoshow.adFilter", "off") 关闭。
  function adFilterEnabled() {
    try {
      return localStorage.getItem("videoshow.adFilter") !== "off";
    } catch {
      return true;
    }
  }

  function filterPlaylistResponse(response, playlistUrl) {
    if (typeof response?.data !== "string") return response;
    try {
      const { text, removed } = stripAdBlocks(response.data, playlistUrl);
      if (!removed.length) return response;
      devlog("广告片段已移除", {
        blocks: removed.length,
        seconds: removed.reduce((sum, item) => sum + item.seconds, 0).toFixed(1),
        at: removed.map((item) => formatTime(item.at)).join(","),
        host: removed.map((item) => item.family).join(","),
        playHost: hostOf(playlistUrl),
      }, "warn");
      return { ...response, data: text };
    } catch {
      return response;
    }
  }

  // hls.js 的错误详情整理成换线记账用的证据，分级规则见 line-book.js 的 classifyFailure。
  function hlsEvidence(detail) {
    const text = String(detail?.details || "");
    const timeout = /TimeOut/i.test(text);
    const status = Number.isFinite(detail?.response?.code) ? detail.response.code : 0;
    if (/manifestLoad|levelLoad|playlistLoad/i.test(text)) {
      return { kind: "manifest", status, timeout };
    }
    if (/fragLoad/i.test(text)) {
      return {
        kind: "fragment",
        status,
        timeout,
        host: hostOf(detail?.frag?.url || detail?.response?.url || detail?.url),
      };
    }
    return { kind: "media" };
  }

  function playM3u8(video, url, artInstance, onFatal, onAttached) {
    const retry = { maxNumRetry: 2, retryDelayMs: 300, maxRetryDelayMs: 1000 };
    artInstance.activeHlsUrl = url;
    artInstance.hls?.destroy();
    artInstance.hls = null;
    // 下载进展计数：看门狗据此区分“一直没有数据”和“慢但在下载”。
    artInstance.loadCounter = 0;
    artInstance.manifestLoaded = false;
    onAttached?.();
    if (!window.Hls?.isSupported()) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
        return;
      }
      onFatal?.("fatal", { kind: "media" });
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

          load(context, config, rawCallbacks) {
            const original = context?.url;
            const progress = () => {
              artInstance.loadCounter = (artInstance.loadCounter || 0) + 1;
            };
            const tracked = {
              ...rawCallbacks,
              onProgress: (...args) => {
                progress();
                rawCallbacks.onProgress?.(...args);
              },
              onSuccess: (...args) => {
                progress();
                rawCallbacks.onSuccess?.(...args);
              },
            };
            // 播放列表在交给 hls.js 之前先去掉拼接广告；分片响应不是文本，原样放行。
            const callbacks = adFilterEnabled()
              ? {
                  ...tracked,
                  onSuccess: (response, ...rest) =>
                    tracked.onSuccess?.(filterPlaylistResponse(response, original), ...rest),
                }
              : tracked;
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
    // 播放列表是起播的前提：域名不通时尽快报错，交给换线逻辑，而不是等 hls.js 默认的长超时与重试。
    const playlistPolicy = {
      default: {
        maxTimeToFirstByteMs: 6000,
        maxLoadTimeMs: 10000,
        timeoutRetry: { maxNumRetry: 0, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: { maxNumRetry: 1, retryDelayMs: 300, maxRetryDelayMs: 1000 },
      },
    };
    const hls = new window.Hls({
      enableWorker: false,
      manifestLoadPolicy: playlistPolicy,
      playlistLoadPolicy: playlistPolicy,
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
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      artInstance.manifestLoaded = true;
    });
    hls.on(window.Hls.Events.ERROR, (_event, detail) => {
      if (artInstance.hls !== hls || artInstance.activeHlsUrl !== url) return;
      if (!detail?.fatal) {
        if (detail?.type === "networkError") {
          devlog("HLS 网络错误", {
            details: detail.details,
            status: detail.response?.code ?? 0,
            host: playHostOf(url),
          }, "warn");
        }
        return;
      }
      const evidence = hlsEvidence(detail);
      devlog("HLS 致命错误", {
        type: detail.type,
        details: detail.details,
        status: evidence.status ?? 0,
        host: playHostOf(url),
        ...(evidence.host ? { segmentHost: evidence.host } : {}),
      }, "error");
      hls.destroy();
      artInstance.hls = null;
      // 播放列表（manifest/level）都取不到记为 unreachable，其余记为 fatal；
      // 具体该排除这条线路还是整个域名，由 evidence 决定。
      onFatal?.(evidence.kind === "manifest" ? "unreachable" : "fatal", evidence);
    });
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

  /* =========================================================================
     解析会话：读取 /api/resolve 事件流，线路陆续到达线路簿，第一条到达即可起播
     ========================================================================= */
  // 快照线路的 playUrl 是本站路径，播放器需要绝对地址；日志里要显示的是线路原始域名。
  const lineHosts = new Map();

  function playHostOf(url) {
    return lineHosts.get(url) || hostOf(url);
  }

  function normalizeLine(raw) {
    const playUrl = typeof raw.playUrl === "string" && raw.playUrl.startsWith("/")
      ? `${location.origin}${raw.playUrl}`
      : raw.playUrl;
    const line = { ...raw, playUrl };
    if (line.host) lineHosts.set(playUrl, line.host);
    return line;
  }

  function closeSession() {
    if (!activeSession) return;
    activeSession.closed = true;
    activeSession.controller.abort();
    activeSession.refreshController?.abort();
    activeSession = null;
  }

  function buildSessionData(session, line) {
    return {
      sourceUrl: session.url,
      playUrl: line.playUrl,
      type: line.type,
      provider: line.provider,
      line,
      session,
      title: session.meta?.title ?? null,
      cover: session.meta?.cover ?? null,
      expiresAt: Number.isFinite(line.expiresAtMs) ? new Date(line.expiresAtMs).toISOString() : null,
      danmaku: session.danmaku,
    };
  }

  // 一次事件的处理，初次解析和追加一轮共用。
  function handleSessionEvent(session, event) {
    session.cursor = event.id || session.cursor;
    const data = event.data || {};
    switch (event.type) {
      case "session":
        session.danmaku = data.danmaku || null;
        break;
      case "line": {
        const line = normalizeLine(data);
        if (!session.book.add(line)) break;
        devlog("收到线路", {
          provider: line.provider,
          host: line.host,
          segmentHost: line.segmentHost,
          snapshot: line.snapshot ? "yes" : "no",
          verified: line.verified ? "yes" : "no",
          ttfbMs: Number.isFinite(line.ttfbMs) ? Math.round(line.ttfbMs) : "-",
          round: line.round,
        }, "info");
        session.onLine?.(line);
        break;
      }
      case "meta":
        session.meta = data;
        session.onMeta?.(data);
        break;
      case "diagnostic":
        devlog("渠道诊断", {
          provider: data.provider,
          status: data.status,
          ms: data.ms,
          ...(data.playHost ? { host: data.playHost } : {}),
          ...(data.code ? { code: data.code } : {}),
          ...(data.message ? { message: data.message } : {}),
        }, data.status === "rejected" || data.status === "benchmark-rejected" ? "warn" : "info");
        break;
      case "round":
        devlog("解析轮次", { round: data.round }, "info");
        break;
      case "done":
        devlog("解析完成", { round: data.round, lines: data.lines, newLines: data.newLines, ms: data.ms }, "info");
        break;
      case "failed":
        session.failure = data;
        devlog("解析失败", { code: data.code, message: data.message }, "error");
        break;
      default:
        break;
    }
  }

  // 打开解析会话。第一条线路到达就返回可起播的 data，事件流继续在后台接收其余线路；
  // 全部渠道都失败才抛出错误。onSlow 在长时间没有线路时调用，只提示，不终止解析。
  function openSession(url, { onSlow } = {}) {
    closeSession();
    const controller = new AbortController();
    const session = {
      url,
      controller,
      book: createLineBook(),
      cursor: "",
      ended: false,
      failure: null,
      meta: null,
      danmaku: null,
      refreshing: null,
      refreshController: null,
      waiters: new Set(),
      onLine: null,
      onMeta: null,
      closed: false,
    };
    activeSession = session;
    devlog("解析请求", { host: hostOf(url) }, "info");
    return new Promise((resolve, reject) => {
      let settled = false;
      const slowTimer = window.setTimeout(() => {
        if (settled || session.closed) return;
        devlog("解析较慢", "30 秒内没有可用线路，继续等待…", "warn");
        onSlow?.();
      }, SLOW_RESOLVE_HINT_MS);
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(slowTimer);
        fn(value);
      };
      session.onLine = (line) => {
        for (const wake of [...session.waiters]) wake();
        if (!settled) settle(resolve, buildSessionData(session, line));
      };
      readResolveStream({
        url,
        signal: controller.signal,
        onEvent: (event) => handleSessionEvent(session, event),
      })
        .then((outcome) => {
          session.ended = true;
          for (const wake of [...session.waiters]) wake();
          // 被新的解析取代（换集、重新提交）：调用方的加载状态已经由新请求接管，
          // 这个旧请求既不成功也不报错，保持挂起即可。
          if (outcome?.aborted) return;
          settle(reject, new Error(session.failure?.message || "解析失败，请稍后重试。"));
        })
        .catch((err) => {
          session.ended = true;
          for (const wake of [...session.waiters]) wake();
          devlog("解析连接中断", err instanceof Error ? err.message : String(err), "error");
          settle(reject, err instanceof Error ? err : new Error("解析失败，请稍后重试。"));
        });
    });
  }

  function resolveLines(url) {
    return openSession(url, {
      onSlow: () => {
        if (loadingText) loadingText.textContent = "暂未找到可用线路，仍在继续尝试，请稍候…";
      },
    });
  }

  // 等待会话里出现新线路或解析结束，最多等 timeoutMs。
  function waitForSessionActivity(session, timeoutMs) {
    return new Promise((resolve) => {
      let timer = 0;
      const wake = () => {
        window.clearTimeout(timer);
        session.waiters.delete(wake);
        resolve();
      };
      timer = window.setTimeout(wake, timeoutMs);
      session.waiters.add(wake);
    });
  }

  // 在原会话上追加一轮解析：服务端对同一页面的追加有最小间隔，被限流时不会产出新线路。
  function refreshSession(session) {
    if (session.refreshing) return session.refreshing;
    const controller = new AbortController();
    session.refreshController = controller;
    session.ended = false;
    session.failure = null;
    session.refreshing = readResolveStream({
      url: session.url,
      refresh: true,
      after: session.cursor,
      signal: controller.signal,
      onEvent: (event) => {
        handleSessionEvent(session, event);
        if (event.type === "line") for (const wake of [...session.waiters]) wake();
      },
    })
      .catch((err) => {
        devlog("追加解析失败", err instanceof Error ? err.message : String(err), "error");
      })
      .finally(() => {
        session.ended = true;
        session.refreshing = null;
        session.refreshController = null;
        for (const wake of [...session.waiters]) wake();
      });
    return session.refreshing;
  }

  // 选出下一条线路：线路簿里没有可用的但解析仍在进行时，先等后到的线路；
  // 仍然没有，再在原会话上追加一轮（每次换线最多一轮）。
  async function pickNextLine(session, state) {
    let chosen = session.book.next();
    if (!chosen && !session.ended) {
      devlog("等待后台线路", "解析仍在进行，等待新线路…", "warn");
      await waitForSessionActivity(session, LATE_LINE_WAIT_MS);
      chosen = session.book.next();
    }
    if (!chosen && !state.refreshed && !session.closed) {
      state.refreshed = true;
      devlog("候选已耗尽", "请求在原解析会话上追加一轮…", "warn");
      await refreshSession(session);
      chosen = session.book.next();
    }
    return chosen;
  }

  // 新线路要出数据才算换线成功：连续 SWITCH_IDLE_MS 没有下载进展，或总计超过 SWITCH_MAX_MS 就判失败。
  function watchSwitchProgress(instance) {
    let poll = 0;
    const promise = new Promise((_, reject) => {
      const startedAt = Date.now();
      let last = instance.loadCounter || 0;
      let idleSince = startedAt;
      poll = window.setInterval(() => {
        const current = instance.loadCounter || 0;
        const now = Date.now();
        if (current !== last) {
          last = current;
          idleSince = now;
        }
        if (now - idleSince >= SWITCH_IDLE_MS || now - startedAt >= SWITCH_MAX_MS) {
          reject(Object.assign(
            new Error(`新线路 ${Math.round((now - idleSince) / 1000)} 秒内没有加载出数据`),
            { evidence: { kind: "startup", manifestLoaded: instance.manifestLoaded === true } },
          ));
        }
      }, 500);
    });
    return { promise, stop: () => window.clearInterval(poll) };
  }

  async function switchToSmootherSource(data, reason = "", evidence = null) {
    if (switchingLine || !art) {
      devlog("换线跳过", switchingLine ? "已有换线进行中" : "播放器不存在", "warn");
      return;
    }
    const instance = art;
    const session = data.session;
    const continueAt = Number.isFinite(instance.currentTime) ? instance.currentTime : 0;
    if (!session?.book) {
      setStatus("暂时播不了，请稍后再试。", "error");
      return;
    }
    // 失败只按证据的范围记账：线路级问题只排除这一条，域名级问题才累计到域名。
    const defaultKind = reason === "startup" ? "startup" : reason === "hard" ? "stall" : "media";
    const charged = session.book.fail(data.line, {
      ...(evidence || { kind: defaultKind }),
      manifestLoaded: instance.manifestLoaded === true,
    });
    switchingLine = true;
    clearStallTimer();
    setStatus("播放不够流畅，正在更换线路…", "loading");
    devlog("触发换线", {
      reason: reason || "-",
      from: data.provider || "-",
      fromHost: data.line?.host || hostOf(data.playUrl),
      continueAt: Math.round(continueAt),
      evidence: evidence?.kind || defaultKind,
      ...(charged.length ? { hostStrikes: charged.map((item) => `${item.host}+${item.weight}`).join(",") } : {}),
    }, "warn");

    const state = { refreshed: false };
    try {
      while (true) {
        const chosen = await pickNextLine(session, state);
        if (art !== instance) return;

        if (!chosen?.playUrl) {
          devlog("切源结束", "所有可用备选线路均已尝试完毕", "warn");
          break;
        }

        const fromProvider = data.provider || "未知";
        const toProvider = chosen.provider || "未知";
        const toHost = chosen.host || hostOf(chosen.playUrl);
        const switchReasonText =
          reason === "startup" ? "原源起播超时" :
          reason === "hard" ? "原源播放连续断流(>5s)" :
          reason === "unreachable" ? "原源播放列表无法访问" : (reason || "播放异常");

        devlog("切换线路", `【${fromProvider} -> ${toProvider}】(新主机: ${toHost || "-"} | 原因: ${switchReasonText})`, "warn");

        let watcher = null;
        try {
          instance.activeHlsUrl = null;
          instance.hls?.destroy();
          instance.hls = null;
          instance.type = chosen.type;
          watcher = watchSwitchProgress(instance);
          await Promise.race([
            instance.switchQuality(chosen.playUrl),
            new Promise((_, reject) => { rejectSwitch = reject; }),
            watcher.promise,
          ]);
          if (art !== instance) return;
          reportPlayback("playback.switch", {
            fromHost: data.line?.host || hostOf(data.playUrl),
            toHost,
            episode: data.episodeName || "",
            continueAt,
          });
          devlog("换线成功", `【已切至: ${toProvider}】(继续播放位置: ${Math.round(continueAt)}s)`, "info");
          data.playUrl = chosen.playUrl;
          data.type = chosen.type;
          data.provider = chosen.provider;
          data.line = chosen;
          if (currentMedia) {
            currentMedia.playUrl = chosen.playUrl;
            currentMedia.type = chosen.type;
          }
          const activeVideo = player.querySelector("video");
          setStatus(activeVideo?.paused ? "线路已切换，请点击播放继续。" : "", "");
          resumeWatchdog?.();
          return;
        } catch (err) {
          const failure = err?.evidence || { kind: "startup", manifestLoaded: instance.manifestLoaded === true };
          const failureCharged = session.book.fail(chosen, failure);
          devlog("换线失败", {
            provider: toProvider,
            host: toHost,
            message: err instanceof Error ? err.message : String(err),
            evidence: failure.kind,
            ...(failureCharged.length
              ? { hostStrikes: failureCharged.map((item) => `${item.host}+${item.weight}`).join(",") }
              : {}),
          }, "error");
          console.warn("线路切换失败", err);
        } finally {
          watcher?.stop();
          rejectSwitch = null;
        }
      }
      reportPlayback("playback.failed", {
        playHost: data.line?.host || hostOf(data.playUrl),
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

  // 已缓冲到的最远位置（秒），没有缓冲时为 0。
  function bufferedEnd(video) {
    try {
      const ranges = video.buffered;
      return ranges.length ? ranges.end(ranges.length - 1) : 0;
    } catch {
      return 0;
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
    devlogSelection(data);
    const baseTitle = data.baseTitle || currentMedia?.baseTitle || cleanBaseTitle(data.title);
    const displayTitle = data.episodeName ? `${baseTitle} ${data.episodeName}` : (data.title || baseTitle);

    videoTitle.textContent = displayTitle;
    expiry.textContent = formatExpiry(data.expiresAt);
    document.title = `${displayTitle} · videoshow`;
    reportPlayback("playback.start", {
      pageHost: hostOf(data.sourceUrl),
      playHost: data.line?.host || hostOf(data.playUrl),
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

    // 标题和封面不阻塞起播：事件流里的 meta 事件可能晚于第一条线路，到达后再补。
    const applyMeta = (meta) => {
      if (!meta || currentMedia?.sourceUrl !== data.sourceUrl) return;
      // 目录播放自带标题，不被页面标题覆盖。
      if (meta.title && !data.episodeName && !data.baseTitle) {
        currentMedia.baseTitle = cleanBaseTitle(meta.title);
        currentMedia.title = meta.title;
        videoTitle.textContent = meta.title;
        document.title = `${meta.title} · videoshow`;
      }
      if (meta.cover && !currentMedia.cover) currentMedia.cover = meta.cover;
    };
    if (data.session) {
      data.session.onMeta = applyMeta;
      if (data.session.meta) applyMeta(data.session.meta);
    }

    // 手动换线时沿用当前进度；否则只恢复这一集自己的进度。
    const savedRecord = HistoryStore.get(currentMedia.id);
    const resumeTime = Number.isFinite(data.continueAt)
      ? data.continueAt
      : resumeTimeFor(savedRecord, currentMedia);

    const danmakuEndpoint = data.danmaku?.endpoint || "";
    let playbackFailed = false;
    let sourceAttached = data.type !== "m3u8";
    const failPlayback = (force = false, reason = "", evidence = null) => {
      if (playbackFailed) {
        // 已在换线：说明是新线路也出了致命错误，立即结束本次尝试，由换线循环换下一个候选。
        if (switchingLine) {
          rejectSwitch?.(Object.assign(new Error("新线路播放失败"), { evidence }));
        }
        return;
      }
      if (!sourceAttached && !force) return;
      playbackFailed = true;
      clearStallTimer();
      switchToSmootherSource(data, reason, evidence);
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
      controls: [
        seekButton(
          "seek-back",
          -SEEK_BUTTON_STEP,
          "快退10秒",
          '<path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/>',
          11,
        ),
        seekButton(
          "seek-forward",
          SEEK_BUTTON_STEP,
          "快进10秒",
          '<path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/>',
          12,
        ),
      ],
      autoSize: false,
      theme: "#c6f36b",
      customType: {
        m3u8: (video, url, artInstance) =>
          playM3u8(video, url, artInstance, (reason, evidence) => failPlayback(true, reason, evidence), () => {
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

    // 播放卡顿看门狗：每 tickMs 采样一次，判定全部交给 stall-monitor，这里只负责采样和执行动作。
    //
    //   起播失败（10 秒没数据）、硬卡死（播放中断流 5 秒）、慢性卡顿（60 秒内卡 3 次或占比 ≥15%）才会换线；
    //   断流 3 秒时先自救一次（降一档清晰度并让 HLS 重新拉分片），不直接换线；
    //   暂停、拖动进度条、断网都不算线路卡顿；换线后 30 秒内不因慢性卡顿再换，避免来回切。
    //
    // 不监听 waiting 事件：真实卡顿时它会高频重复派发，事件驱动要么漏判要么反复重置计时。
    const monitor = createStallMonitor();
    const activeArt = art;
    const stopWatchdog = () => {
      if (stallTimer) {
        window.clearInterval(stallTimer);
        stallTimer = 0;
      }
    };
    const armWatchdog = () => {
      if (stallTimer || playbackFailed) return;
      stallTimer = window.setInterval(() => {
        if (playbackFailed || switchingLine || art !== activeArt) return;
        const current = player.querySelector("video");
        if (!current) return;
        const decision = monitor.tick({
          paused: current.paused,
          seeking: current.seeking,
          ended: current.ended,
          readyState: current.readyState,
          currentTime: current.currentTime,
          online: navigator.onLine !== false,
          // 下载进展：hls.js 的清单/分片回调计数 + 已缓冲时长，用来区分“没有数据”和“慢但在下载”。
          loaded: (activeArt.loadCounter || 0) + Math.round(bufferedEnd(current) * 10),
        }, Date.now());
        if (decision.action !== "switch") return;
        devlog("卡顿超时", {
          reason: decision.reason,
          currentTime: Math.round(current.currentTime * 10) / 10,
          readyState: current.readyState,
          paused: current.paused,
          stalledSeconds: Math.round((decision.stalledMs ?? decision.blockedMs ?? 0) / 100) / 10,
        }, "warn");
        stopWatchdog();
        failPlayback(true, decision.reason);
      }, monitor.tickMs);
    };
    resumeWatchdog = () => {
      playbackFailed = false;
      monitor.reset();
      armWatchdog();
    };
    monitor.reset();
    armWatchdog();
    // 弹幕在卡顿时消失的修复：
    // 弹幕插件的渲染循环门控在 art.playing 上，而 Artplayer 的 playing 定义要求
    // readyState > 2（HAVE_FUTURE_DATA）。缓冲一耗尽，art.playing 立刻变 false，
    // 插件就停止推进和渲染，画面上最后一条弹幕也会消失。
    // 这里的判定改成"用户是否想看"：只要没暂停、没结束、确实播放过，就继续渲染，
    // 画面停在某一帧时弹幕保持静止，而不是整层消失。
    keepDanmakuVisibleDuringStall(activeArt);
    art.on("video:playing", () => {
      playbackFailed = false;
      armWatchdog();
      if (status.classList.contains("loading")) setStatus("", "");
    });
    art.on("destroy", () => {
      stopWatchdog();
      activeArt.hls?.destroy();
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
      failPlayback(true);
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
    const msg = `正在解析${episode.name || "该集"}…`;
    // 解析进度由 loading 遮罩层承载，状态栏只负责清空旧提示
    setStatus("", "");
    setLoading(true, msg);

    try {
      const data = await resolveLines(pageUrl);
      const base = currentMedia?.baseTitle || cleanBaseTitle(currentMedia?.title);
      showResult({
        ...data,
        baseTitle: base,
        cover: data.cover || currentMedia?.cover || "",
        episodeName: episode.name,
        episodeIndex: index,
        episodes: currentMedia?.episodes,
      });
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

  // 选集列表和线路并行获取：第一条线路一到就能起播，不必先等选集。
  // 选集列表失败不影响播放，只是不显示选集栏。dataPromise 失败则整体失败。
  async function withEpisodes(pageUrl, dataPromise, fallback = []) {
    const known = Array.isArray(fallback) && fallback.length > 1 ? fallback : [];
    const episodesPromise = known.length ? Promise.resolve(known) : loadEpisodes(pageUrl).catch(() => []);
    const [data, episodes] = await Promise.all([dataPromise, episodesPromise]);
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
    const msg = "正在解析视频链接，请稍候…";
    setLoading(true, msg);
    setStatus("", "");
    searchSection.hidden = true;
    try {
      const data = await withEpisodes(pageUrl, resolveLines(pageUrl), episodes);
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
    const msg = `正在读取《${item.title || "该剧"}》的播放平台…`;
    setStatus("", "");
    setLoading(true, msg);
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
    if (isUrl(query)) {
      // 轨道 A：直接 URL 单集解析
      const msg = "正在解析视频链接，请稍候…";
      setStatus("", "");
      setLoading(true, msg);
      searchSection.hidden = true;
      try {
        const data = await withEpisodes(query, resolveLines(query));
        showResult(data);
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
        const msg = `正在通过视频网站搜索《${query}》，请稍候…`;
        setStatus("", "");
        setLoading(true, msg);
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

      const msg = `正在通过 API 渠道搜索《${query}》，请稍候…`;
      setStatus("", "");
      setLoading(true, msg);
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
