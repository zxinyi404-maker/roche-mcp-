/*
 * Roche 智能联网助手 v6.0
 * 支持：DuckDuckGo、网页浏览、知乎、Reddit、YouTube、AO3
 * 功能：AI自动调用、缓存、历史记录、统计、自定义搜索引擎
 *
 * 使用 Roche 标准 chat.tools API
 */
(function () {
  "use strict";

  const PLUGIN_ID = "auto-web";
  const CACHE_TTL = 24 * 60 * 60 * 1000; // 24小时
  const MAX_HISTORY = 50; // 最多保存50条历史

  // 全局状态（跨 app 共享）
  let globalState = {
    proxyUrl: "",
    enabled: true,
    enableCache: true,
    initialized: false,
    cache: {}, // 缓存：key -> {data, timestamp}
    history: [], // 历史：[{tool, query, timestamp, cached}]
    stats: { // 统计
      total: 0,
      byTool: {},
      cacheHits: 0,
    },
    customEngines: [], // 自定义搜索引擎
  };

  // ============================================================
  // 缓存和统计
  // ============================================================

  function getCacheKey(tool, query) {
    return `${tool}:${query}`;
  }

  function getFromCache(tool, query) {
    if (!globalState.enableCache) return null;

    const key = getCacheKey(tool, query);
    const cached = globalState.cache[key];

    if (!cached) return null;

    const age = Date.now() - cached.timestamp;
    if (age > CACHE_TTL) {
      delete globalState.cache[key];
      return null;
    }

    return cached.data;
  }

  function saveToCache(tool, query, data) {
    if (!globalState.enableCache) return;

    const key = getCacheKey(tool, query);
    globalState.cache[key] = {
      data: data,
      timestamp: Date.now(),
    };
  }

  function addToHistory(tool, query, cached = false) {
    globalState.history.unshift({
      tool: tool,
      query: query,
      timestamp: Date.now(),
      cached: cached,
    });

    if (globalState.history.length > MAX_HISTORY) {
      globalState.history = globalState.history.slice(0, MAX_HISTORY);
    }
  }

  function updateStats(tool, cached = false) {
    globalState.stats.total++;
    globalState.stats.byTool[tool] = (globalState.stats.byTool[tool] || 0) + 1;
    if (cached) {
      globalState.stats.cacheHits++;
    }
  }

  async function persistState(roche) {
    try {
      await roche.storage.set("cache", globalState.cache);
      await roche.storage.set("history", globalState.history);
      await roche.storage.set("stats", globalState.stats);
      await roche.storage.set("customEngines", globalState.customEngines);
    } catch (e) {
      console.error("[持久化失败]", e);
    }
  }

  // ============================================================
  // 工具实现
  // ============================================================

  // 通用工具包装器（自动缓存）
  async function executeWithCache(roche, tool, query, fn) {
    const cached = getFromCache(tool, query);
    if (cached) {
      addToHistory(tool, query, true);
      updateStats(tool, true);
      await persistState(roche);
      return cached;
    }

    const result = await fn();

    saveToCache(tool, query, result);
    addToHistory(tool, query, false);
    updateStats(tool, false);
    await persistState(roche);

    return result;
  }

  // 通过 CORS 代理发起请求
  async function proxyFetch(url, opts) {
    opts = opts || {};
    if (!globalState.proxyUrl) {
      throw new Error("未配置 CORS 代理地址");
    }

    const payload = {
      url: url,
      method: opts.method || "GET",
      headers: opts.headers || {},
    };
    if (opts.body != null) payload.body = opts.body;

    const resp = await fetch(globalState.proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await resp.text();
    if (resp.headers.get("x-ai-proxy-error") === "true") {
      throw new Error("代理错误: " + text.slice(0, 300));
    }
    return { status: resp.status, text: text };
  }

  // 直接调用平台 API
  async function callPlatformAPI(endpoint, params) {
    if (!globalState.proxyUrl) {
      throw new Error("未配置代理地址");
    }

    const baseUrl = globalState.proxyUrl.replace("/proxy", "");
    const url = new URL(endpoint, baseUrl);

    Object.keys(params).forEach(key => {
      url.searchParams.append(key, params[key]);
    });

    const resp = await fetch(url.toString());
    return await resp.json();
  }

  // 工具 1: DuckDuckGo 搜索
  async function toolWebSearch(query) {
    const searchUrl = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);

    try {
      const r = await proxyFetch(searchUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      const results = parseDuckResults(r.text).slice(0, 6);
      if (!results.length) {
        return { error: "未找到搜索结果" };
      }

      return {
        results: results.map(r => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
        })),
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  // 解析 DuckDuckGo 结果
  function parseDuckResults(html) {
    const doc = new DOMParser().parseFromString(html || "", "text/html");
    const out = [];
    const nodes = doc.querySelectorAll(".result__body, .web-result, .result");

    nodes.forEach(function (node) {
      const a = node.querySelector("a.result__a") ||
                node.querySelector(".result__title a") ||
                node.querySelector("a");
      if (!a) return;

      let href = a.getAttribute("href") || "";
      const m = href.match(/[?&]uddg=([^&]+)/);
      if (m) {
        try { href = decodeURIComponent(m[1]); } catch (e) {}
      }

      const snip = node.querySelector(".result__snippet") ||
                   node.querySelector(".result-snippet");
      const title = (a.textContent || "").trim();

      if (!title || !/^https?:\/\//.test(href)) return;

      out.push({
        title: title,
        url: href,
        snippet: (snip ? snip.textContent : "").trim(),
      });
    });

    return out;
  }

  // 工具 2: 打开网页
  async function toolOpenPage(url) {
    if (!/^https?:\/\//.test(url)) {
      return { error: "非法 URL" };
    }

    try {
      const r = await proxyFetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      const extracted = extractReadable(r.text);
      return {
        title: extracted.title,
        content: clampText(extracted.text, 6000),
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  // 抽取正文
  function extractReadable(html) {
    const doc = new DOMParser().parseFromString(html || "", "text/html");
    const title = (doc.querySelector("title") || {}).textContent || "";

    doc.querySelectorAll("script,style,noscript,nav,header,footer,aside,svg,iframe,form")
       .forEach(n => n.remove());

    const main = doc.querySelector("article") ||
                 doc.querySelector("main") ||
                 doc.body ||
                 doc.documentElement;

    let text = (main ? main.textContent : "") || "";
    text = text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();

    return { title: title.trim(), text: text };
  }

  // 工具 3-6: 平台搜索
  async function toolZhihuSearch(query, type = "all") {
    try {
      const result = await callPlatformAPI("/api/zhihu/search", {
        q: query,
        type: type,
        limit: 10,
      });
      return result.success ? { results: result.results } : { error: result.error || "搜索失败" };
    } catch (e) {
      return { error: e.message };
    }
  }

  async function toolRedditSearch(query, sort = "relevance") {
    try {
      const result = await callPlatformAPI("/api/reddit/search", {
        q: query,
        sort: sort,
        limit: 10,
      });
      return result.success ? { results: result.results } : { error: result.error || "搜索失败" };
    } catch (e) {
      return { error: e.message };
    }
  }

  async function toolYouTubeSearch(query) {
    try {
      const result = await callPlatformAPI("/api/youtube/search", {
        q: query,
        limit: 10,
      });
      return result.success ? { results: result.results } : { error: result.error || "搜索失败" };
    } catch (e) {
      return { error: e.message };
    }
  }

  async function toolAO3Search(query, sort = "relevance") {
    try {
      const result = await callPlatformAPI("/api/ao3/search", {
        q: query,
        sort: sort,
        limit: 10,
      });
      return result.success ? { results: result.results } : { error: result.error || "搜索失败" };
    } catch (e) {
      return { error: e.message };
    }
  }

  // 工具 7: 自定义搜索
  async function toolCustomSearch(engineId, query) {
    const engine = globalState.customEngines.find(e => e.id === engineId);
    if (!engine) {
      return { error: "未找到自定义搜索引擎" };
    }

    try {
      const url = engine.searchUrl.replace("{query}", encodeURIComponent(query));
      const r = await proxyFetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      return {
        engine: engine.name,
        url: url,
        content: clampText(r.text, 5000),
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  // 工具函数
  function clampText(str, max) {
    str = String(str || "");
    if (str.length <= max) return str;
    return str.slice(0, max) + "\n...[已截断]";
  }

  // 初始化全局状态（只执行一次）
  async function initGlobalState(roche) {
    if (globalState.initialized) return;

    try {
      const savedProxy = await roche.storage.get("proxyUrl");
      const savedEnabled = await roche.storage.get("enabled");
      const savedEnableCache = await roche.storage.get("enableCache");
      const savedCache = await roche.storage.get("cache");
      const savedHistory = await roche.storage.get("history");
      const savedStats = await roche.storage.get("stats");
      const savedCustomEngines = await roche.storage.get("customEngines");

      if (savedProxy) globalState.proxyUrl = savedProxy;
      if (savedEnabled !== undefined) globalState.enabled = savedEnabled;
      if (savedEnableCache !== undefined) globalState.enableCache = savedEnableCache;
      if (savedCache) globalState.cache = savedCache;
      if (savedHistory) globalState.history = savedHistory;
      if (savedStats) globalState.stats = savedStats;
      if (savedCustomEngines) globalState.customEngines = savedCustomEngines;

      globalState.initialized = true;

      if (globalState.proxyUrl && globalState.enabled) {
        console.log("[智能联网助手] v4.0 已启用");
      } else {
        console.log("[智能联网助手] 未配置或未启用");
      }
    } catch (e) {
      console.error("[智能联网助手] 初始化失败:", e);
    }
  }

  // ============================================================
  // 插件注册
  // ============================================================

  window.RochePlugin.register({
    id: PLUGIN_ID,
    name: "智能联网助手",
    version: "6.0.0",

    chat: {
      scope: {},
      tools: [
        {
          id: "web_search",
          description: "通用网页搜索（DuckDuckGo）。搜索最新信息、新闻、常规问题时使用。参数：query（搜索关键词）",
          parameters: { query: "string" },
          async execute(args, ctx) {
            if (!globalState.enabled || !globalState.proxyUrl) return { error: "联网功能未启用" };
            const query = String(args?.query || "").trim();
            return await executeWithCache(ctx.roche || window.Roche, "web_search", query, () => toolWebSearch(query));
          },
        },
        {
          id: "open_page",
          description: "打开网页并读取正文。当需要阅读具体网页内容时使用。参数：url（网页地址）",
          parameters: { url: "string" },
          async execute(args, ctx) {
            if (!globalState.enabled || !globalState.proxyUrl) return { error: "联网功能未启用" };
            const url = String(args?.url || "").trim();
            // 网页内容不缓存（每次都是最新）
            const result = await toolOpenPage(url);
            addToHistory("open_page", url, false);
            updateStats("open_page", false);
            return result;
          },
        },
        {
          id: "zhihu_search",
          description: "搜索知乎内容（问题、回答、文章）。适合查找中文深度讨论和专业解答。参数：query（搜索关键词），type（可选：all/question/answer/article）",
          parameters: { query: "string", type: "string" },
          async execute(args, ctx) {
            if (!globalState.enabled || !globalState.proxyUrl) return { error: "联网功能未启用" };
            const query = String(args?.query || "").trim();
            const type = args?.type || "all";
            return await executeWithCache(ctx.roche || window.Roche, "zhihu_search", `${type}:${query}`, () => toolZhihuSearch(query, type));
          },
        },
        {
          id: "reddit_search",
          description: "搜索 Reddit 帖子和讨论。适合查找英文社区讨论、评测、经验分享。参数：query（搜索关键词），sort（可选：relevance/hot/top/new）",
          parameters: { query: "string", sort: "string" },
          async execute(args, ctx) {
            if (!globalState.enabled || !globalState.proxyUrl) return { error: "联网功能未启用" };
            const query = String(args?.query || "").trim();
            const sort = args?.sort || "relevance";
            return await executeWithCache(ctx.roche || window.Roche, "reddit_search", `${sort}:${query}`, () => toolRedditSearch(query, sort));
          },
        },
        {
          id: "youtube_search",
          description: "搜索 YouTube 视频。适合查找视频教程、评测、娱乐内容。参数：query（搜索关键词）",
          parameters: { query: "string" },
          async execute(args, ctx) {
            if (!globalState.enabled || !globalState.proxyUrl) return { error: "联网功能未启用" };
            const query = String(args?.query || "").trim();
            return await executeWithCache(ctx.roche || window.Roche, "youtube_search", query, () => toolYouTubeSearch(query));
          },
        },
        {
          id: "ao3_search",
          description: "搜索 AO3 同人作品。适合查找小说、fanfic。参数：query（搜索关键词），sort（可选：relevance/kudos/hits/date）",
          parameters: { query: "string", sort: "string" },
          async execute(args, ctx) {
            if (!globalState.enabled || !globalState.proxyUrl) return { error: "联网功能未启用" };
            const query = String(args?.query || "").trim();
            const sort = args?.sort || "relevance";
            return await executeWithCache(ctx.roche || window.Roche, "ao3_search", `${sort}:${query}`, () => toolAO3Search(query, sort));
          },
        },
      ],
    },

    apps: [
      {
        id: "auto-web-settings",
        name: "联网设置",
        icon: "settings",
        async mount(container, roche) {
          await initGlobalState(roche);

          const cacheHitRate = globalState.stats.total > 0
            ? ((globalState.stats.cacheHits / globalState.stats.total) * 100).toFixed(1)
            : "0.0";

          container.innerHTML = `
            <div class="roche-plugin-auto-web" style="display: flex; flex-direction: column; height: 100%; font-family: system-ui; color: #333; background: #f5f5f5;">
              <div style="display: flex; align-items: center; padding: 16px; background: white; border-bottom: 1px solid #e0e0e0; flex-shrink: 0;">
                <button id="back-btn" style="padding: 8px 16px; background: #f0f0f0; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">
                  ← 返回
                </button>
                <h2 style="margin: 0 0 0 16px; font-size: 18px; font-weight: 600;">智能联网助手 v4.0</h2>
              </div>

              <div style="flex: 1; overflow-y: auto; padding: 20px;">
                <!-- 基本设置 -->
                <div style="background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                  <label style="display: block; font-weight: 600; margin-bottom: 8px;">代理服务器地址 *</label>
                  <input id="proxy-input" type="text" placeholder="https://用户名-项目名.hf.space/proxy" value="${globalState.proxyUrl}" style="width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; box-sizing: border-box;" />
                </div>

                <div style="background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                  <label style="display: flex; align-items: center; cursor: pointer; margin-bottom: 12px;">
                    <input id="enabled-checkbox" type="checkbox" ${globalState.enabled ? "checked" : ""} style="width: 20px; height: 20px; margin-right: 10px; cursor: pointer;" />
                    <span style="font-weight: 600;">启用联网功能</span>
                  </label>
                  <label style="display: flex; align-items: center; cursor: pointer;">
                    <input id="cache-checkbox" type="checkbox" ${globalState.enableCache ? "checked" : ""} style="width: 20px; height: 20px; margin-right: 10px; cursor: pointer;" />
                    <span style="font-weight: 600;">启用缓存（24小时）</span>
                  </label>
                </div>

                <button id="save-btn" style="width: 100%; padding: 14px; background: #007aff; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; margin-bottom: 16px;">保存设置</button>

                <!-- 统计面板 -->
                <div style="background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                  <h3 style="margin: 0 0 12px; font-size: 16px;">📊 使用统计</h3>
                  <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; font-size: 14px;">
                    <div><strong>总搜索次数：</strong>${globalState.stats.total}</div>
                    <div><strong>缓存命中率：</strong>${cacheHitRate}%</div>
                  </div>
                  <div style="margin-top: 12px; font-size: 13px; color: #666;">
                    ${Object.entries(globalState.stats.byTool).map(([tool, count]) => `<div>${tool}: ${count}次</div>`).join("")}
                  </div>
                  <button id="clear-stats-btn" style="margin-top: 12px; padding: 8px 16px; background: #f44336; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">清空统计</button>
                </div>

                <!-- 支持的搜索 -->
                <div style="background: #e8f5e9; border-radius: 12px; padding: 16px; margin-bottom: 16px;">
                  <h3 style="margin: 0 0 12px; font-size: 16px; color: #2e7d32;">✨ 支持的搜索</h3>
                  <ul style="margin: 0; padding-left: 20px; line-height: 1.8; font-size: 14px;">
                    <li><strong>DuckDuckGo</strong> - 通用网页搜索</li>
                    <li><strong>知乎</strong> - 中文问答和文章</li>
                    <li><strong>Reddit</strong> - 英文社区讨论</li>
                    <li><strong>YouTube</strong> - 视频搜索</li>
                    <li><strong>AO3</strong> - 同人小说</li>
                    <li><strong>网页浏览</strong> - 读取任意网页</li>
                  </ul>
                </div>

                <!-- 搜索历史 -->
                <div style="background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                  <h3 style="margin: 0 0 12px; font-size: 16px;">📜 最近搜索（${globalState.history.length}/${MAX_HISTORY}）</h3>
                  <div id="history-list" style="max-height: 200px; overflow-y: auto; font-size: 13px; line-height: 1.6;">
                    ${globalState.history.slice(0, 10).map(h => {
                      const time = new Date(h.timestamp).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" });
                      const cached = h.cached ? "💾" : "";
                      return `<div style="padding: 4px 0; border-bottom: 1px solid #f0f0f0;">${cached} [${h.tool}] ${h.query} <span style="color: #999;">${time}</span></div>`;
                    }).join("") || "<div style='color: #999;'>暂无搜索历史</div>"}
                  </div>
                  <button id="clear-history-btn" style="margin-top: 12px; padding: 8px 16px; background: #ff9800; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">清空历史</button>
                </div>

                <!-- 自定义搜索引擎 -->
                <div style="background: white; border-radius: 12px; padding: 20px;">
                  <h3 style="margin: 0 0 12px; font-size: 16px;">🔧 自定义搜索引擎</h3>
                  <div id="custom-engines-list" style="margin-bottom: 12px; font-size: 13px;">
                    ${globalState.customEngines.map(e => `
                      <div style="padding: 8px; background: #f5f5f5; border-radius: 6px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                        <div>
                          <strong>${e.name}</strong><br/>
                          <span style="font-size: 11px; color: #666;">${e.searchUrl}</span>
                        </div>
                        <button class="delete-engine-btn" data-id="${e.id}" style="padding: 6px 12px; background: #f44336; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px;">删除</button>
                      </div>
                    `).join("") || "<div style='color: #999;'>暂无自定义引擎</div>"}
                  </div>
                  <button id="add-engine-btn" style="padding: 8px 16px; background: #4caf50; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">+ 添加引擎</button>
                  <div style="margin-top: 12px; padding: 12px; background: #fff3cd; border-radius: 6px; font-size: 12px; color: #856404;">
                    <strong>💡 提示：</strong>使用 <code>{query}</code> 作为搜索关键词的占位符<br/>
                    例如：<code>https://www.google.com/search?q={query}</code>
                  </div>
                </div>
              </div>
            </div>
          `;

          container.querySelector("#back-btn").onclick = () => roche.ui.closeApp();

          container.querySelector("#save-btn").onclick = async () => {
            const input = container.querySelector("#proxy-input");
            const enabledCheckbox = container.querySelector("#enabled-checkbox");
            const cacheCheckbox = container.querySelector("#cache-checkbox");
            const url = input.value.trim();

            if (!url) {
              roche.ui.toast("请输入代理地址");
              return;
            }

            globalState.proxyUrl = url;
            globalState.enabled = enabledCheckbox.checked;
            globalState.enableCache = cacheCheckbox.checked;

            await roche.storage.set("proxyUrl", url);
            await roche.storage.set("enabled", globalState.enabled);
            await roche.storage.set("enableCache", globalState.enableCache);

            roche.ui.toast("✅ 保存成功！");
          };

          container.querySelector("#clear-stats-btn").onclick = async () => {
            const ok = await roche.ui.confirm({
              title: "清空统计",
              message: "确定要清空所有统计数据吗？"
            });
            if (ok) {
              globalState.stats = { total: 0, byTool: {}, cacheHits: 0 };
              await roche.storage.set("stats", globalState.stats);
              roche.ui.toast("✅ 已清空统计");
              roche.ui.closeApp();
              roche.ui.openApp("auto-web-settings");
            }
          };

          container.querySelector("#clear-history-btn").onclick = async () => {
            const ok = await roche.ui.confirm({
              title: "清空历史",
              message: "确定要清空搜索历史吗？"
            });
            if (ok) {
              globalState.history = [];
              await roche.storage.set("history", []);
              roche.ui.toast("✅ 已清空历史");
              roche.ui.closeApp();
              roche.ui.openApp("auto-web-settings");
            }
          };

          container.querySelector("#add-engine-btn").onclick = async () => {
            const name = prompt("引擎名称（如：Google）：");
            if (!name) return;

            const searchUrl = prompt("搜索URL（用 {query} 表示关键词）：\n例如：https://www.google.com/search?q={query}");
            if (!searchUrl) return;

            if (!searchUrl.includes("{query}")) {
              roche.ui.toast("❌ URL 必须包含 {query}");
              return;
            }

            globalState.customEngines.push({
              id: `custom_${Date.now()}`,
              name: name.trim(),
              searchUrl: searchUrl.trim()
            });

            await roche.storage.set("customEngines", globalState.customEngines);
            roche.ui.toast("✅ 已添加自定义引擎");

            // 重新加载页面
            roche.ui.closeApp();
            setTimeout(() => roche.ui.openApp("auto-web-settings"), 100);
          };

          // 删除自定义引擎
          container.querySelectorAll(".delete-engine-btn").forEach(btn => {
            btn.onclick = async () => {
              const id = btn.getAttribute("data-id");
              const ok = await roche.ui.confirm({
                title: "删除引擎",
                message: "确定要删除这个自定义引擎吗？"
              });
              if (ok) {
                globalState.customEngines = globalState.customEngines.filter(e => e.id !== id);
                await roche.storage.set("customEngines", globalState.customEngines);
                roche.ui.toast("✅ 已删除");
                roche.ui.closeApp();
                setTimeout(() => roche.ui.openApp("auto-web-settings"), 100);
              }
            };
          });
        },
        async unmount(container) {
          container.innerHTML = "";
        },
      },
    ],
  });
})();
