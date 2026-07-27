/*
 * Roche 智能联网助手 v3.0
 * 支持：DuckDuckGo、网页浏览、知乎、Reddit、YouTube、AO3
 *
 * 使用 Roche 标准 chat.tools API
 */
(function () {
  "use strict";

  const PLUGIN_ID = "auto-web";

  // 全局状态（跨 app 共享）
  let globalState = {
    proxyUrl: "",
    enabled: true,
    initialized: false,
  };

  // ============================================================
  // 工具实现
  // ============================================================

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

  // 工具 3: 知乎搜索
  async function toolZhihuSearch(query, type = "all") {
    try {
      const result = await callPlatformAPI("/api/zhihu/search", {
        q: query,
        type: type,
        limit: 10,
      });

      if (!result.success) {
        return { error: result.error || "搜索失败" };
      }

      return { results: result.results };
    } catch (e) {
      return { error: e.message };
    }
  }

  // 工具 4: Reddit 搜索
  async function toolRedditSearch(query, sort = "relevance") {
    try {
      const result = await callPlatformAPI("/api/reddit/search", {
        q: query,
        sort: sort,
        limit: 10,
      });

      if (!result.success) {
        return { error: result.error || "搜索失败" };
      }

      return { results: result.results };
    } catch (e) {
      return { error: e.message };
    }
  }

  // 工具 5: YouTube 搜索
  async function toolYouTubeSearch(query) {
    try {
      const result = await callPlatformAPI("/api/youtube/search", {
        q: query,
        limit: 10,
      });

      if (!result.success) {
        return { error: result.error || "搜索失败" };
      }

      return { results: result.results };
    } catch (e) {
      return { error: e.message };
    }
  }

  // 工具 6: AO3 搜索
  async function toolAO3Search(query, sort = "relevance") {
    try {
      const result = await callPlatformAPI("/api/ao3/search", {
        q: query,
        sort: sort,
        limit: 10,
      });

      if (!result.success) {
        return { error: result.error || "搜索失败" };
      }

      return { results: result.results };
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

      if (savedProxy) globalState.proxyUrl = savedProxy;
      if (savedEnabled !== undefined) globalState.enabled = savedEnabled;

      globalState.initialized = true;

      if (globalState.proxyUrl && globalState.enabled) {
        console.log("[智能联网助手] v3.0 已启用，支持 6 种搜索");
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
    version: "3.0.0",

    // 注入到主聊天的工具
    chat: {
      scope: {},

      tools: [
        {
          id: "web_search",
          description: "通用网页搜索（DuckDuckGo）。搜索最新信息、新闻、常规问题时使用。参数：query（搜索关键词）",
          parameters: { query: "string" },
          async execute(args, ctx) {
            if (!globalState.enabled || !globalState.proxyUrl) {
              return { error: "联网功能未启用" };
            }
            return await toolWebSearch(String(args?.query || "").trim());
          },
        },
        {
          id: "open_page",
          description: "打开网页并读取正文。当需要阅读具体网页内容时使用。参数：url（网页地址）",
          parameters: { url: "string" },
          async execute(args, ctx) {
            if (!globalState.enabled || !globalState.proxyUrl) {
              return { error: "联网功能未启用" };
            }
            return await toolOpenPage(String(args?.url || "").trim());
          },
        },
        {
          id: "zhihu_search",
          description: "搜索知乎内容（问题、回答、文章）。适合查找中文深度讨论和专业解答。参数：query（搜索关键词），type（可选：all/question/answer/article）",
          parameters: { query: "string", type: "string" },
          async execute(args, ctx) {
            if (!globalState.enabled || !globalState.proxyUrl) {
              return { error: "联网功能未启用" };
            }
            return await toolZhihuSearch(
              String(args?.query || "").trim(),
              args?.type || "all"
            );
          },
        },
        {
          id: "reddit_search",
          description: "搜索 Reddit 帖子和讨论。适合查找英文社区讨论、评测、经验分享。参数：query（搜索关键词），sort（可选：relevance/hot/top/new）",
          parameters: { query: "string", sort: "string" },
          async execute(args, ctx) {
            if (!globalState.enabled || !globalState.proxyUrl) {
              return { error: "联网功能未启用" };
            }
            return await toolRedditSearch(
              String(args?.query || "").trim(),
              args?.sort || "relevance"
            );
          },
        },
        {
          id: "youtube_search",
          description: "搜索 YouTube 视频。适合查找视频教程、评测、娱乐内容。参数：query（搜索关键词）",
          parameters: { query: "string" },
          async execute(args, ctx) {
            if (!globalState.enabled || !globalState.proxyUrl) {
              return { error: "联网功能未启用" };
            }
            return await toolYouTubeSearch(String(args?.query || "").trim());
          },
        },
        {
          id: "ao3_search",
          description: "搜索 AO3 同人作品。适合查找小说、fanfic。参数：query（搜索关键词），sort（可选：relevance/kudos/hits/date）",
          parameters: { query: "string", sort: "string" },
          async execute(args, ctx) {
            if (!globalState.enabled || !globalState.proxyUrl) {
              return { error: "联网功能未启用" };
            }
            return await toolAO3Search(
              String(args?.query || "").trim(),
              args?.sort || "relevance"
            );
          },
        },
      ],
    },

    // 设置界面
    apps: [
      {
        id: "auto-web-settings",
        name: "联网设置",
        icon: "settings",
        async mount(container, roche) {
          await initGlobalState(roche);

          container.innerHTML = `
            <div class="roche-plugin-auto-web" style="display: flex; flex-direction: column; height: 100%; font-family: system-ui; color: #333; background: #f5f5f5;">
              <div style="display: flex; align-items: center; padding: 16px; background: white; border-bottom: 1px solid #e0e0e0; flex-shrink: 0;">
                <button id="back-btn" style="padding: 8px 16px; background: #f0f0f0; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">
                  ← 返回
                </button>
                <h2 style="margin: 0 0 0 16px; font-size: 18px; font-weight: 600;">智能联网助手 v3.0</h2>
              </div>

              <div style="flex: 1; overflow-y: auto; padding: 20px;">
                <div style="background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                  <label style="display: block; font-weight: 600; margin-bottom: 8px;">
                    代理服务器地址 *
                  </label>
                  <input
                    id="proxy-input"
                    type="text"
                    placeholder="https://你的space.hf.space/proxy"
                    value="${globalState.proxyUrl}"
                    style="width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; box-sizing: border-box;"
                  />
                  <p style="margin: 8px 0 0; font-size: 13px; color: #666;">
                    必填。格式：https://用户名-项目名.hf.space/proxy
                  </p>
                </div>

                <div style="background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                  <label style="display: flex; align-items: center; cursor: pointer;">
                    <input
                      id="enabled-checkbox"
                      type="checkbox"
                      ${globalState.enabled ? "checked" : ""}
                      style="width: 20px; height: 20px; margin-right: 10px; cursor: pointer;"
                    />
                    <span style="font-weight: 600;">启用联网功能</span>
                  </label>
                </div>

                <button id="save-btn" style="width: 100%; padding: 14px; background: #007aff; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; margin-bottom: 16px;">
                  保存设置
                </button>

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

                <div style="background: #fff3cd; border-radius: 12px; padding: 16px; border-left: 4px solid #ffc107;">
                  <h3 style="margin: 0 0 12px; font-size: 16px; color: #856404;">💡 使用提示</h3>
                  <p style="margin: 0; line-height: 1.8; font-size: 14px;">
                    AI 会自动判断使用哪个搜索引擎。你只需要正常聊天，AI 会选择最合适的工具。
                  </p>
                </div>
              </div>
            </div>
          `;

          container.querySelector("#back-btn").onclick = () => roche.ui.closeApp();

          container.querySelector("#save-btn").onclick = async () => {
            const input = container.querySelector("#proxy-input");
            const checkbox = container.querySelector("#enabled-checkbox");
            const url = input.value.trim();

            if (!url) {
              roche.ui.toast("请输入代理地址");
              return;
            }

            globalState.proxyUrl = url;
            globalState.enabled = checkbox.checked;

            await roche.storage.set("proxyUrl", url);
            await roche.storage.set("enabled", globalState.enabled);

            roche.ui.toast("✅ 保存成功！");
          };
        },
        async unmount(container) {
          container.innerHTML = "";
        },
      },
    ],
  });
})();
