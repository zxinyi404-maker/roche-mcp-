/*
 * Roche 智能联网助手 v5.0
 * 重新设计版本 - 清爽界面 + 完整功能
 * 功能：搜索、缓存、历史记录、自定义引擎
 */

(function () {
  "use strict";

  const PLUGIN_ID = "roche-auto-web";
  const VERSION = "5.0.0";
  const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24小时

  // 全局状态
  let state = {
    proxyUrl: "https://jbcjkfcfnsak-xinchajian.hf.space",
    searchHistory: [],
    searchCache: {},
    customEngines: [],
  };

  // ============================================================
  // 工具函数
  // ============================================================

  async function loadState(roche) {
    try {
      const stored = await roche.storage.get(`${PLUGIN_ID}:state`);
      if (stored) {
        state = { ...state, ...stored };
      }
    } catch (e) {
      console.error("[加载状态失败]", e);
    }
  }

  async function saveState(roche) {
    try {
      await roche.storage.set(`${PLUGIN_ID}:state`, state);
    } catch (e) {
      console.error("[保存状态失败]", e);
    }
  }

  // 获取缓存
  function getCache(key) {
    const cached = state.searchCache[key];
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      return cached.data;
    }
    return null;
  }

  // 设置缓存
  function setCache(key, data) {
    state.searchCache[key] = {
      data,
      timestamp: Date.now(),
    };

    // 清理过期缓存
    Object.keys(state.searchCache).forEach((k) => {
      if (Date.now() - state.searchCache[k].timestamp > CACHE_DURATION) {
        delete state.searchCache[k];
      }
    });
  }

  // 添加历史记录
  function addHistory(query, engine) {
    state.searchHistory.unshift({
      query,
      engine,
      timestamp: Date.now(),
    });
    if (state.searchHistory.length > 50) {
      state.searchHistory = state.searchHistory.slice(0, 50);
    }
  }

  // ============================================================
  // 搜索引擎
  // ============================================================

  async function searchDuckDuckGo(query) {
    const cacheKey = `ddg_${query}`;
    const cached = getCache(cacheKey);
    if (cached) {
      return { results: cached, fromCache: true };
    }

    const url = `${state.proxyUrl}/api/search/duckduckgo?q=${encodeURIComponent(query)}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`搜索失败: ${response.status}`);
    }

    const data = await response.json();

    if (!data.results || data.results.length === 0) {
      throw new Error("未找到结果");
    }

    setCache(cacheKey, data.results);
    return { results: data.results, fromCache: false };
  }

  async function searchCustomEngine(engine, query) {
    const cacheKey = `custom_${engine.id}_${query}`;
    const cached = getCache(cacheKey);
    if (cached) {
      return { ...cached, fromCache: true };
    }

    const searchUrl = engine.url.replace("{query}", encodeURIComponent(query));
    const proxyUrl = `${state.proxyUrl}/api/proxy`;

    const response = await fetch(proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: searchUrl,
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0" },
      }),
    });

    if (!response.ok) {
      throw new Error(`请求失败: ${response.status}`);
    }

    const text = await response.text();
    const result = {
      engineName: engine.name,
      url: searchUrl,
      content: text.substring(0, 5000),
    };

    setCache(cacheKey, result);
    return { ...result, fromCache: false };
  }

  // ============================================================
  // UI 组件
  // ============================================================

  function createSearchUI(container, roche) {
    container.innerHTML = `
      <div class="search-container">
        <div class="header">
          <h1>🔍 智能搜索</h1>
          <p>快速搜索互联网内容</p>
        </div>

        <div class="content">
          <!-- 搜索框 -->
          <div class="search-box">
            <select id="engine-select" class="engine-select">
              <option value="duckduckgo">🦆 DuckDuckGo</option>
            </select>
            <input type="text" id="search-input" placeholder="输入搜索关键词..." class="search-input" />
            <button id="search-btn" class="btn-primary">搜索</button>
          </div>

          <!-- 加载状态 -->
          <div id="loading" class="loading" style="display: none;">
            <div class="spinner"></div>
            <p>搜索中...</p>
          </div>

          <!-- 搜索结果 -->
          <div id="results-section" class="results-section" style="display: none;">
            <div class="results-header">
              <h3>搜索结果</h3>
              <button id="copy-btn" class="btn-secondary">📋 复制</button>
            </div>
            <div id="results-content" class="results-content"></div>
          </div>

          <!-- 搜索历史 -->
          <div class="history-section">
            <div class="section-header">
              <h3>📜 搜索历史</h3>
              <button id="clear-history-btn" class="btn-danger">清空</button>
            </div>
            <div id="history-list" class="history-list"></div>
          </div>
        </div>
      </div>
    `;

    attachSearchHandlers(container, roche);
  }

  function attachSearchHandlers(container, roche) {
    const engineSelect = container.querySelector("#engine-select");
    const searchInput = container.querySelector("#search-input");
    const searchBtn = container.querySelector("#search-btn");
    const loading = container.querySelector("#loading");
    const resultsSection = container.querySelector("#results-section");
    const resultsContent = container.querySelector("#results-content");
    const copyBtn = container.querySelector("#copy-btn");
    const historyList = container.querySelector("#history-list");
    const clearHistoryBtn = container.querySelector("#clear-history-btn");

    let currentResults = "";

    // 加载自定义引擎
    state.customEngines.forEach((engine) => {
      const option = document.createElement("option");
      option.value = engine.id;
      option.textContent = `🔧 ${engine.name}`;
      engineSelect.appendChild(option);
    });

    // 渲染历史记录
    function renderHistory() {
      if (state.searchHistory.length === 0) {
        historyList.innerHTML = '<p class="empty-text">暂无搜索记录</p>';
        return;
      }

      historyList.innerHTML = state.searchHistory
        .map(
          (item) => `
        <div class="history-item" data-query="${item.query}">
          <div class="history-query">${item.query}</div>
          <div class="history-meta">${item.engine} · ${new Date(item.timestamp).toLocaleString()}</div>
        </div>
      `
        )
        .join("");

      historyList.querySelectorAll(".history-item").forEach((item) => {
        item.onclick = () => {
          searchInput.value = item.dataset.query;
        };
      });
    }

    // 搜索功能
    async function performSearch() {
      const query = searchInput.value.trim();
      if (!query) {
        roche.ui.toast("⚠️ 请输入搜索关键词");
        return;
      }

      const engineType = engineSelect.value;

      loading.style.display = "flex";
      resultsSection.style.display = "none";

      try {
        let results;
        let engineName;

        if (engineType === "duckduckgo") {
          const data = await searchDuckDuckGo(query);
          results = data.results;
          engineName = "DuckDuckGo";

          if (data.fromCache) {
            roche.ui.toast("📦 使用缓存结果");
          }

          currentResults = `🔍 搜索：${query}\n📊 来源：${engineName}${data.fromCache ? " (缓存)" : ""}\n\n`;
          results.forEach((r, i) => {
            currentResults += `${i + 1}. ${r.title}\n🔗 ${r.url}\n📝 ${r.snippet}\n\n`;
          });

          resultsContent.innerHTML = results
            .map(
              (r, i) => `
            <div class="result-item">
              <div class="result-title">${i + 1}. ${r.title}</div>
              <div class="result-url">${r.url}</div>
              <div class="result-snippet">${r.snippet}</div>
            </div>
          `
            )
            .join("");
        } else {
          const engine = state.customEngines.find((e) => e.id === engineType);
          const data = await searchCustomEngine(engine, query);
          engineName = engine.name;

          if (data.fromCache) {
            roche.ui.toast("📦 使用缓存结果");
          }

          currentResults = `🔍 搜索：${query}\n🔧 引擎：${engineName}\n🔗 ${data.url}\n\n${data.content}`;

          resultsContent.innerHTML = `
            <div class="result-item">
              <div class="result-title">🔧 ${engineName}</div>
              <div class="result-url">${data.url}</div>
              <div class="result-snippet" style="white-space: pre-wrap; max-height: 400px; overflow-y: auto;">${data.content}</div>
            </div>
          `;
        }

        addHistory(query, engineName);
        await saveState(roche);
        renderHistory();

        loading.style.display = "none";
        resultsSection.style.display = "block";
        roche.ui.toast("✅ 搜索完成");
      } catch (e) {
        loading.style.display = "none";
        roche.ui.toast(`❌ ${e.message}`);
        console.error("[搜索失败]", e);
      }
    }

    searchBtn.onclick = performSearch;
    searchInput.onkeypress = (e) => {
      if (e.key === "Enter") performSearch();
    };

    copyBtn.onclick = () => {
      navigator.clipboard
        .writeText(currentResults)
        .then(() => roche.ui.toast("✅ 已复制"))
        .catch(() => roche.ui.toast("❌ 复制失败"));
    };

    clearHistoryBtn.onclick = async () => {
      state.searchHistory = [];
      await saveState(roche);
      renderHistory();
      roche.ui.toast("✅ 已清空历史");
    };

    renderHistory();
  }

  function createSettingsUI(container, roche) {
    container.innerHTML = `
      <div class="settings-container">
        <div class="header">
          <h1>⚙️ 设置</h1>
          <p>配置代理和自定义引擎</p>
        </div>

        <div class="content">
          <!-- 代理设置 -->
          <div class="setting-section">
            <h3>🌐 代理服务器</h3>
            <input type="text" id="proxy-input" value="${state.proxyUrl}" placeholder="https://your-proxy.hf.space" class="input-field" />
            <button id="save-proxy-btn" class="btn-primary">💾 保存</button>
          </div>

          <!-- 自定义引擎 -->
          <div class="setting-section">
            <h3>🔧 自定义搜索引擎</h3>
            <div id="engines-list" class="engines-list"></div>
            <div class="add-engine-form">
              <input type="text" id="engine-name" placeholder="引擎名称（如：Google）" class="input-field" />
              <input type="text" id="engine-url" placeholder="搜索URL（用{query}表示关键词）" class="input-field" />
              <button id="add-engine-btn" class="btn-primary">➕ 添加引擎</button>
            </div>
          </div>

          <!-- 缓存管理 -->
          <div class="setting-section">
            <h3>🗑️ 缓存管理</h3>
            <p class="info-text">当前缓存：${Object.keys(state.searchCache).length} 条</p>
            <button id="clear-cache-btn" class="btn-danger">🗑️ 清空缓存</button>
          </div>
        </div>
      </div>
    `;

    attachSettingsHandlers(container, roche);
  }

  function attachSettingsHandlers(container, roche) {
    const proxyInput = container.querySelector("#proxy-input");
    const saveProxyBtn = container.querySelector("#save-proxy-btn");
    const enginesList = container.querySelector("#engines-list");
    const engineNameInput = container.querySelector("#engine-name");
    const engineUrlInput = container.querySelector("#engine-url");
    const addEngineBtn = container.querySelector("#add-engine-btn");
    const clearCacheBtn = container.querySelector("#clear-cache-btn");

    function renderEngines() {
      if (state.customEngines.length === 0) {
        enginesList.innerHTML = '<p class="empty-text">暂无自定义引擎</p>';
        return;
      }

      enginesList.innerHTML = state.customEngines
        .map(
          (engine) => `
        <div class="engine-item">
          <div>
            <div class="engine-name">${engine.name}</div>
            <div class="engine-url">${engine.url}</div>
          </div>
          <button class="btn-danger delete-engine-btn" data-id="${engine.id}">删除</button>
        </div>
      `
        )
        .join("");

      enginesList.querySelectorAll(".delete-engine-btn").forEach((btn) => {
        btn.onclick = async () => {
          state.customEngines = state.customEngines.filter((e) => e.id !== btn.dataset.id);
          await saveState(roche);
          renderEngines();
          roche.ui.toast("✅ 已删除");
        };
      });
    }

    saveProxyBtn.onclick = async () => {
      const url = proxyInput.value.trim();
      if (!url) {
        roche.ui.toast("⚠️ 请输入代理地址");
        return;
      }
      state.proxyUrl = url;
      await saveState(roche);
      roche.ui.toast("✅ 已保存");
    };

    addEngineBtn.onclick = async () => {
      const name = engineNameInput.value.trim();
      const url = engineUrlInput.value.trim();

      if (!name || !url) {
        roche.ui.toast("⚠️ 请填写完整信息");
        return;
      }

      if (!url.includes("{query}")) {
        roche.ui.toast("⚠️ URL 必须包含 {query}");
        return;
      }

      state.customEngines.push({
        id: `custom_${Date.now()}`,
        name,
        url,
      });

      await saveState(roche);
      renderEngines();
      engineNameInput.value = "";
      engineUrlInput.value = "";
      roche.ui.toast("✅ 已添加");
    };

    clearCacheBtn.onclick = async () => {
      state.searchCache = {};
      await saveState(roche);
      roche.ui.toast("✅ 缓存已清空");
      setTimeout(() => {
        roche.ui.closeApp();
        roche.ui.openApp("settings-app");
      }, 500);
    };

    renderEngines();
  }

  // ============================================================
  // 样式
  // ============================================================

  const styles = `
    <style>
      * {
        box-sizing: border-box;
      }

      .search-container, .settings-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        font-family: system-ui, -apple-system, sans-serif;
        background: #f5f7fa;
      }

      .header {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        padding: 24px 20px;
      }

      .header h1 {
        margin: 0;
        font-size: 24px;
        font-weight: 600;
      }

      .header p {
        margin: 8px 0 0;
        opacity: 0.9;
        font-size: 14px;
      }

      .content {
        flex: 1;
        overflow-y: auto;
        padding: 20px;
      }

      .search-box {
        background: white;
        border-radius: 12px;
        padding: 20px;
        margin-bottom: 20px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      }

      .engine-select {
        width: 100%;
        padding: 12px;
        border: 2px solid #e0e7ff;
        border-radius: 8px;
        font-size: 14px;
        margin-bottom: 12px;
        cursor: pointer;
        transition: border-color 0.3s;
      }

      .engine-select:focus {
        outline: none;
        border-color: #667eea;
      }

      .search-input {
        width: 100%;
        padding: 14px;
        border: 2px solid #e0e7ff;
        border-radius: 8px;
        font-size: 15px;
        transition: border-color 0.3s;
      }

      .search-input:focus {
        outline: none;
        border-color: #667eea;
      }

      .btn-primary {
        width: 100%;
        margin-top: 12px;
        padding: 14px;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        border: none;
        border-radius: 8px;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.2s, box-shadow 0.3s;
      }

      .btn-primary:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
      }

      .btn-secondary {
        padding: 10px 20px;
        background: #4CAF50;
        color: white;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.3s;
      }

      .btn-secondary:hover {
        background: #45a049;
      }

      .btn-danger {
        padding: 8px 16px;
        background: #f44336;
        color: white;
        border: none;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.3s;
      }

      .btn-danger:hover {
        background: #d32f2f;
      }

      .loading {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 60px 20px;
      }

      .spinner {
        width: 50px;
        height: 50px;
        border: 4px solid #f3f3f3;
        border-top: 4px solid #667eea;
        border-radius: 50%;
        animation: spin 1s linear infinite;
      }

      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }

      .loading p {
        margin-top: 20px;
        font-size: 16px;
        color: #666;
      }

      .results-section {
        background: white;
        border-radius: 12px;
        padding: 20px;
        margin-bottom: 20px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      }

      .results-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
      }

      .results-header h3 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        color: #333;
      }

      .results-content {
        max-height: 500px;
        overflow-y: auto;
      }

      .result-item {
        padding: 16px;
        border-bottom: 1px solid #f0f0f0;
      }

      .result-item:last-child {
        border-bottom: none;
      }

      .result-title {
        font-weight: 600;
        color: #1a73e8;
        margin-bottom: 6px;
        font-size: 15px;
      }

      .result-url {
        font-size: 13px;
        color: #5f6368;
        margin-bottom: 8px;
        word-break: break-all;
      }

      .result-snippet {
        font-size: 14px;
        color: #666;
        line-height: 1.6;
      }

      .history-section, .setting-section {
        background: white;
        border-radius: 12px;
        padding: 20px;
        margin-bottom: 20px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      }

      .section-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
      }

      .section-header h3, .setting-section h3 {
        margin: 0 0 16px;
        font-size: 16px;
        font-weight: 600;
        color: #333;
      }

      .history-list, .engines-list {
        max-height: 300px;
        overflow-y: auto;
      }

      .history-item {
        padding: 12px;
        border-bottom: 1px solid #f0f0f0;
        cursor: pointer;
        transition: background 0.2s;
      }

      .history-item:hover {
        background: #f8f9fa;
      }

      .history-query {
        font-weight: 500;
        color: #333;
        margin-bottom: 4px;
      }

      .history-meta {
        font-size: 12px;
        color: #999;
      }

      .empty-text {
        text-align: center;
        color: #999;
        padding: 20px;
      }

      .input-field {
        width: 100%;
        padding: 12px;
        border: 2px solid #e0e7ff;
        border-radius: 8px;
        font-size: 14px;
        margin-bottom: 12px;
        transition: border-color 0.3s;
      }

      .input-field:focus {
        outline: none;
        border-color: #667eea;
      }

      .info-text {
        margin: 0 0 12px;
        font-size: 14px;
        color: #666;
      }

      .add-engine-form {
        padding: 16px;
        background: #f5f5f5;
        border-radius: 8px;
        margin-top: 16px;
      }

      .add-engine-form .input-field {
        margin-bottom: 8px;
      }

      .engine-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px;
        background: #f9f9f9;
        border-radius: 8px;
        margin-bottom: 8px;
      }

      .engine-name {
        font-weight: 600;
        color: #333;
        margin-bottom: 4px;
      }

      .engine-url {
        font-size: 12px;
        color: #666;
        word-break: break-all;
      }
    </style>
  `;

  // ============================================================
  // 注册插件
  // ============================================================

  window.RochePlugin.register({
    id: PLUGIN_ID,
    name: "智能联网助手",
    version: VERSION,
    description: "AI 自动联网搜索，支持缓存和自定义引擎",
    author: "zxinyi404-maker",

    // Chat Tools - AI 可以自动调用
    chat: {
      tools: [
        {
          name: "web_search",
          description: "在互联网上搜索信息。当用户询问最新信息、实时数据、新闻、天气、产品价格、特定网站内容等需要联网才能回答的问题时使用此工具。",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "搜索关键词"
              },
              engine: {
                type: "string",
                description: "搜索引擎（默认 duckduckgo）",
                enum: ["duckduckgo"]
              }
            },
            required: ["query"]
          },
          handler: async (args, context) => {
            try {
              await loadState(context.roche);

              const { query, engine = "duckduckgo" } = args;

              if (engine === "duckduckgo") {
                const data = await searchDuckDuckGo(query);

                // 添加历史记录
                addHistory(query, "DuckDuckGo");
                await saveState(context.roche);

                return {
                  success: true,
                  engine: "DuckDuckGo",
                  fromCache: data.fromCache,
                  results: data.results.slice(0, 5).map(r => ({
                    title: r.title,
                    url: r.url,
                    snippet: r.snippet
                  }))
                };
              }

              return { success: false, error: "不支持的搜索引擎" };
            } catch (e) {
              return { success: false, error: e.message };
            }
          }
        }
      ]
    },

    apps: [
      {
        id: "search-app",
        name: "搜索",
        icon: "search",
        async mount(container, roche) {
          await loadState(roche);
          container.innerHTML = styles;
          const wrapper = document.createElement("div");
          container.appendChild(wrapper);
          createSearchUI(wrapper, roche);
        },
        async unmount(container) {
          container.innerHTML = "";
        },
      },
      {
        id: "settings-app",
        name: "设置",
        icon: "settings",
        async mount(container, roche) {
          await loadState(roche);
          container.innerHTML = styles;
          const wrapper = document.createElement("div");
          container.appendChild(wrapper);
          createSettingsUI(wrapper, roche);
        },
        async unmount(container) {
          container.innerHTML = "";
        },
      },
    ],
  });
})();
