/*
 * Roche 智能联网助手 v6.0
 * 功能：DuckDuckGo搜索 + AI自动调用 + 缓存 + 历史 + 高度自定义引擎
 */

(function () {
  "use strict";

  const PLUGIN_ID = "roche-auto-web";
  const VERSION = "6.0.0";
  const CACHE_DURATION = 24 * 60 * 60 * 1000;

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
      if (stored) state = { ...state, ...stored };
    } catch (e) {
      console.error("[加载失败]", e);
    }
  }

  async function saveState(roche) {
    try {
      await roche.storage.set(`${PLUGIN_ID}:state`, state);
    } catch (e) {
      console.error("[保存失败]", e);
    }
  }

  function getCache(key) {
    const cached = state.searchCache[key];
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      return cached.data;
    }
    return null;
  }

  function setCache(key, data) {
    state.searchCache[key] = { data, timestamp: Date.now() };
    Object.keys(state.searchCache).forEach((k) => {
      if (Date.now() - state.searchCache[k].timestamp > CACHE_DURATION) {
        delete state.searchCache[k];
      }
    });
  }

  function addHistory(query, engine) {
    state.searchHistory.unshift({ query, engine, timestamp: Date.now() });
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
    if (cached) return { results: cached, fromCache: true };

    const url = `${state.proxyUrl}/api/search/duckduckgo?q=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`搜索失败: ${response.status}`);

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
    if (cached) return { ...cached, fromCache: true };

    let searchUrl = engine.url;
    
    // 替换占位符
    searchUrl = searchUrl.replace(/\{query\}/g, encodeURIComponent(query));
    searchUrl = searchUrl.replace(/\{query_raw\}/g, query);

    const proxyUrl = `${state.proxyUrl}/api/proxy`;
    const headers = { "User-Agent": "Mozilla/5.0" };
    
    // 自定义headers
    if (engine.headers) {
      Object.assign(headers, engine.headers);
    }

    const response = await fetch(proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: searchUrl,
        method: engine.method || "GET",
        headers: headers,
      }),
    });

    if (!response.ok) throw new Error(`请求失败: ${response.status}`);

    const text = await response.text();
    const result = {
      engineName: engine.name,
      url: searchUrl,
      content: text.substring(0, 10000),
    };

    setCache(cacheKey, result);
    return { ...result, fromCache: false };
  }

  // ============================================================
  // UI 样式
  // ============================================================

  const CSS_STYLES = `
    <style>
      .auto-web-app {
        display: flex;
        flex-direction: column;
        height: 100%;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f5f7fa;
      }
      .auto-web-header {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        padding: 20px;
        display: flex;
        align-items: center;
        gap: 16px;
      }
      .auto-web-back-btn {
        font-size: 24px;
        cursor: pointer;
        transition: transform 0.2s;
      }
      .auto-web-back-btn:hover {
        transform: translateX(-4px);
      }
      .auto-web-title {
        font-size: 22px;
        font-weight: 600;
      }
      .auto-web-subtitle {
        font-size: 14px;
        opacity: 0.9;
        margin-top: 4px;
      }
      .auto-web-content {
        flex: 1;
        overflow-y: auto;
        padding: 20px;
      }
      .auto-web-card {
        background: white;
        border-radius: 12px;
        padding: 20px;
        margin-bottom: 20px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      }
      .auto-web-card-title {
        font-size: 18px;
        font-weight: 600;
        color: #333;
        margin-bottom: 16px;
      }
      .auto-web-btn {
        width: 100%;
        padding: 14px;
        border: none;
        border-radius: 8px;
        font-size: 15px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s;
      }
      .auto-web-btn-primary {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
      }
      .auto-web-btn-primary:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
      }
      .auto-web-btn-secondary {
        background: #4CAF50;
        color: white;
      }
      .auto-web-btn-secondary:hover {
        background: #45a049;
      }
      .auto-web-btn-danger {
        background: #f44336;
        color: white;
        padding: 10px 16px;
        width: auto;
      }
      .auto-web-btn-danger:hover {
        background: #d32f2f;
      }
      .auto-web-input {
        width: 100%;
        padding: 12px;
        border: 2px solid #e0e7ff;
        border-radius: 8px;
        font-size: 14px;
        margin-bottom: 12px;
        box-sizing: border-box;
        transition: border-color 0.3s;
      }
      .auto-web-input:focus {
        outline: none;
        border-color: #667eea;
      }
      .auto-web-select {
        width: 100%;
        padding: 12px;
        border: 2px solid #e0e7ff;
        border-radius: 8px;
        font-size: 14px;
        margin-bottom: 12px;
        cursor: pointer;
      }
      .auto-web-loading {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 40px;
      }
      .auto-web-spinner {
        width: 40px;
        height: 40px;
        border: 4px solid #f3f3f3;
        border-top: 4px solid #667eea;
        border-radius: 50%;
        animation: spin 1s linear infinite;
      }
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      .auto-web-result-item {
        padding: 16px;
        border-bottom: 1px solid #f0f0f0;
      }
      .auto-web-result-item:last-child {
        border-bottom: none;
      }
      .auto-web-result-title {
        font-weight: 600;
        color: #1a73e8;
        margin-bottom: 6px;
      }
      .auto-web-result-url {
        font-size: 12px;
        color: #5f6368;
        margin-bottom: 8px;
        word-break: break-all;
      }
      .auto-web-result-snippet {
        font-size: 14px;
        color: #666;
        line-height: 1.5;
      }
      .auto-web-history-item {
        padding: 12px;
        border-bottom: 1px solid #f0f0f0;
        cursor: pointer;
        transition: background 0.2s;
      }
      .auto-web-history-item:hover {
        background: #f8f9fa;
      }
      .auto-web-engine-item {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        padding: 12px;
        background: #f9f9f9;
        border-radius: 8px;
        margin-bottom: 12px;
      }
      .auto-web-empty {
        text-align: center;
        color: #999;
        padding: 40px;
      }
    </style>
  `;

  // ============================================================
  // 搜索页面
  // ============================================================

  function createSearchPage(container, roche) {
    container.innerHTML = CSS_STYLES + `
      <div class="auto-web-app">
        <div class="auto-web-header">
          <div class="auto-web-back-btn" id="back-btn">←</div>
          <div>
            <div class="auto-web-title">🔍 搜索助手</div>
            <div class="auto-web-subtitle">快速搜索互联网内容</div>
          </div>
        </div>
        <div class="auto-web-content">
          <div class="auto-web-card">
            <select id="engine-select" class="auto-web-select">
              <option value="duckduckgo">🦆 DuckDuckGo</option>
            </select>
            <input type="text" id="search-input" placeholder="输入搜索关键词..." class="auto-web-input" />
            <button id="search-btn" class="auto-web-btn auto-web-btn-primary">搜索</button>
          </div>

          <div id="loading" style="display: none;">
            <div class="auto-web-loading">
              <div class="auto-web-spinner"></div>
              <p style="margin-top: 16px; color: #666;">搜索中...</p>
            </div>
          </div>

          <div id="results" style="display: none;" class="auto-web-card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
              <div class="auto-web-card-title">搜索结果</div>
              <button id="copy-btn" class="auto-web-btn auto-web-btn-secondary" style="width: auto; padding: 10px 20px;">📋 复制</button>
            </div>
            <div id="results-content"></div>
          </div>

          <div class="auto-web-card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
              <div class="auto-web-card-title">📜 搜索历史</div>
              <button id="clear-history-btn" class="auto-web-btn auto-web-btn-danger">清空</button>
            </div>
            <div id="history-list"></div>
          </div>
        </div>
      </div>
    `;

    const backBtn = container.querySelector("#back-btn");
    const engineSelect = container.querySelector("#engine-select");
    const searchInput = container.querySelector("#search-input");
    const searchBtn = container.querySelector("#search-btn");
    const loading = container.querySelector("#loading");
    const results = container.querySelector("#results");
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

    // 渲染历史
    function renderHistory() {
      if (state.searchHistory.length === 0) {
        historyList.innerHTML = '<div class="auto-web-empty">暂无搜索记录</div>';
        return;
      }
      historyList.innerHTML = state.searchHistory.map(item => `
        <div class="auto-web-history-item" data-query="${item.query}">
          <div style="font-weight: 500; color: #333; margin-bottom: 4px;">${item.query}</div>
          <div style="font-size: 12px; color: #999;">${item.engine} · ${new Date(item.timestamp).toLocaleString()}</div>
        </div>
      `).join('');

      historyList.querySelectorAll('.auto-web-history-item').forEach(item => {
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
      loading.style.display = "block";
      results.style.display = "none";

      try {
        let engineName;

        if (engineType === "duckduckgo") {
          const data = await searchDuckDuckGo(query);
          engineName = "DuckDuckGo";

          if (data.fromCache) {
            roche.ui.toast("📦 使用缓存结果");
          }

          currentResults = `🔍 搜索：${query}\n📊 来源：${engineName}${data.fromCache ? " (缓存)" : ""}\n\n`;
          data.results.forEach((r, i) => {
            currentResults += `${i + 1}. ${r.title}\n🔗 ${r.url}\n📝 ${r.snippet}\n\n`;
          });

          resultsContent.innerHTML = data.results.map((r, i) => `
            <div class="auto-web-result-item">
              <div class="auto-web-result-title">${i + 1}. ${r.title}</div>
              <div class="auto-web-result-url">${r.url}</div>
              <div class="auto-web-result-snippet">${r.snippet}</div>
            </div>
          `).join('');
        } else {
          const engine = state.customEngines.find(e => e.id === engineType);
          const data = await searchCustomEngine(engine, query);
          engineName = engine.name;

          if (data.fromCache) {
            roche.ui.toast("📦 使用缓存结果");
          }

          currentResults = `🔍 搜索：${query}\n🔧 引擎：${engineName}\n🔗 ${data.url}\n\n${data.content}`;

          resultsContent.innerHTML = `
            <div class="auto-web-result-item">
              <div class="auto-web-result-title">🔧 ${engineName}</div>
              <div class="auto-web-result-url">${data.url}</div>
              <div class="auto-web-result-snippet" style="white-space: pre-wrap; max-height: 400px; overflow-y: auto;">${data.content}</div>
            </div>
          `;
        }

        addHistory(query, engineName);
        await saveState(roche);
        renderHistory();

        loading.style.display = "none";
        results.style.display = "block";
        roche.ui.toast("✅ 搜索完成");
      } catch (e) {
        loading.style.display = "none";
        roche.ui.toast(`❌ ${e.message}`);
        console.error("[搜索失败]", e);
      }
    }

    backBtn.onclick = () => roche.ui.closeApp();
    searchBtn.onclick = performSearch;
    searchInput.onkeypress = (e) => {
      if (e.key === 'Enter') performSearch();
    };
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(currentResults)
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

  // ============================================================
  // 设置页面
  // ============================================================

  function createSettingsPage(container, roche) {
    container.innerHTML = CSS_STYLES + `
      <div class="auto-web-app">
        <div class="auto-web-header">
          <div class="auto-web-back-btn" id="back-btn">←</div>
          <div>
            <div class="auto-web-title">⚙️ 设置</div>
            <div class="auto-web-subtitle">配置代理和自定义引擎</div>
          </div>
        </div>
        <div class="auto-web-content">
          <!-- 代理设置 -->
          <div class="auto-web-card">
            <div class="auto-web-card-title">🌐 代理服务器</div>
            <input type="text" id="proxy-input" value="${state.proxyUrl}" placeholder="https://your-proxy.hf.space" class="auto-web-input" />
            <button id="save-proxy-btn" class="auto-web-btn auto-web-btn-primary">💾 保存</button>
          </div>

          <!-- 自定义引擎 -->
          <div class="auto-web-card">
            <div class="auto-web-card-title">🔧 自定义搜索引擎</div>
            <div id="engines-list"></div>
            <div style="padding: 16px; background: #f5f5f5; border-radius: 8px; margin-top: 16px;">
              <input type="text" id="engine-name" placeholder="引擎名称（如：Google）" class="auto-web-input" />
              <input type="text" id="engine-url" placeholder="搜索URL（用{query}代替关键词）" class="auto-web-input" />
              <select id="engine-method" class="auto-web-select">
                <option value="GET">GET 请求</option>
                <option value="POST">POST 请求</option>
              </select>
              <textarea id="engine-headers" placeholder='自定义Headers（JSON格式，可选）\n例如：{"Cookie": "xxx", "Authorization": "Bearer xxx"}' class="auto-web-input" rows="3" style="resize: vertical; font-family: monospace;"></textarea>
              <button id="add-engine-btn" class="auto-web-btn auto-web-btn-primary">➕ 添加引擎</button>
            </div>
            <div style="margin-top: 16px; padding: 12px; background: #fff3cd; border-radius: 8px; font-size: 13px; color: #856404;">
              <strong>💡 提示：</strong><br>
              • 使用 <code>{query}</code> 作为关键词占位符（会自动 URL 编码）<br>
              • 使用 <code>{query_raw}</code> 如果不需要编码<br>
              • 自定义 Headers 可以添加 Cookie、Authorization 等<br>
              • 例如：<code>https://www.google.com/search?q={query}</code>
            </div>
          </div>

          <!-- 缓存管理 -->
          <div class="auto-web-card">
            <div class="auto-web-card-title">🗑️ 缓存管理</div>
            <p style="margin: 0 0 12px; font-size: 14px; color: #666;">当前缓存：${Object.keys(state.searchCache).length} 条</p>
            <button id="clear-cache-btn" class="auto-web-btn auto-web-btn-danger">🗑️ 清空缓存</button>
          </div>
        </div>
      </div>
    `;

    const backBtn = container.querySelector("#back-btn");
    const proxyInput = container.querySelector("#proxy-input");
    const saveProxyBtn = container.querySelector("#save-proxy-btn");
    const enginesList = container.querySelector("#engines-list");
    const engineNameInput = container.querySelector("#engine-name");
    const engineUrlInput = container.querySelector("#engine-url");
    const engineMethodSelect = container.querySelector("#engine-method");
    const engineHeadersInput = container.querySelector("#engine-headers");
    const addEngineBtn = container.querySelector("#add-engine-btn");
    const clearCacheBtn = container.querySelector("#clear-cache-btn");

    function renderEngines() {
      if (state.customEngines.length === 0) {
        enginesList.innerHTML = '<div class="auto-web-empty">暂无自定义引擎</div>';
        return;
      }

      enginesList.innerHTML = state.customEngines.map(engine => `
        <div class="auto-web-engine-item">
          <div style="flex: 1;">
            <div style="font-weight: 600; color: #333; margin-bottom: 4px;">${engine.name}</div>
            <div style="font-size: 12px; color: #666; word-break: break-all; margin-bottom: 4px;">${engine.url}</div>
            <div style="font-size: 11px; color: #999;">方法: ${engine.method || 'GET'}${engine.headers ? ' | 有自定义Headers' : ''}</div>
          </div>
          <button class="auto-web-btn auto-web-btn-danger delete-engine-btn" data-id="${engine.id}">删除</button>
        </div>
      `).join('');

      enginesList.querySelectorAll('.delete-engine-btn').forEach(btn => {
        btn.onclick = async () => {
          state.customEngines = state.customEngines.filter(e => e.id !== btn.dataset.id);
          await saveState(roche);
          renderEngines();
          roche.ui.toast("✅ 已删除");
        };
      });
    }

    backBtn.onclick = () => roche.ui.closeApp();
    
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
      const method = engineMethodSelect.value;
      const headersText = engineHeadersInput.value.trim();

      if (!name || !url) {
        roche.ui.toast("⚠️ 请填写引擎名称和URL");
        return;
      }

      if (!url.includes("{query}") && !url.includes("{query_raw}")) {
        roche.ui.toast("⚠️ URL 必须包含 {query} 或 {query_raw}");
        return;
      }

      let headers = null;
      if (headersText) {
        try {
          headers = JSON.parse(headersText);
        } catch (e) {
          roche.ui.toast("⚠️ Headers 格式错误，必须是有效的 JSON");
          return;
        }
      }

      state.customEngines.push({
        id: `custom_${Date.now()}`,
        name,
        url,
        method,
        headers
      });

      await saveState(roche);
      renderEngines();
      engineNameInput.value = "";
      engineUrlInput.value = "";
      engineMethodSelect.value = "GET";
      engineHeadersInput.value = "";
      roche.ui.toast("✅ 已添加");
    };

    clearCacheBtn.onclick = async () => {
      state.searchCache = {};
      await saveState(roche);
      roche.ui.toast("✅ 缓存已清空");
    };

    renderEngines();
  }

  // ============================================================
  // 插件注册
  // ============================================================

  window.RochePlugin.register({
    id: PLUGIN_ID,
    name: "智能联网助手",
    version: VERSION,
    description: "AI 自动联网搜索，支持高度自定义引擎",
    author: "zxinyi404-maker",

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
              }
            },
            required: ["query"]
          },
          handler: async (args, context) => {
            try {
              await loadState(context.roche);
              const { query } = args;
              const data = await searchDuckDuckGo(query);

              addHistory(query, "DuckDuckGo (AI)");
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
          createSearchPage(container, roche);
        },
        async unmount(container) {
          container.innerHTML = "";
        }
      },
      {
        id: "settings-app",
        name: "设置",
        icon: "settings",
        async mount(container, roche) {
          await loadState(roche);
          createSettingsPage(container, roche);
        },
        async unmount(container) {
          container.innerHTML = "";
        }
      }
    ]
  });
})();
