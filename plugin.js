/*
 * Roche 智能联网助手 v2.0
 * 让 AI 在正常聊天窗口自动判断何时需要联网，自动调用工具
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

  // 工具 1: 搜索
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
        console.log("[智能联网助手] 已启用，AI 现在可以自动联网");
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
    version: "2.0.0",

    // 注入到主聊天的工具
    chat: {
      // 所有会话都可用
      scope: {},

      // 注册工具
      tools: [
        {
          id: "web_search",
          description: "联网搜索（DuckDuckGo）。当需要最新信息、实时数据、不确定的事实时使用。参数：query（搜索关键词）",
          parameters: {
            query: "string",
          },
          async execute(args, ctx) {
            if (!globalState.enabled || !globalState.proxyUrl) {
              return { error: "联网功能未启用或未配置代理" };
            }

            const query = String(args?.query || "").trim();
            if (!query) {
              return { error: "缺少搜索关键词" };
            }

            return await toolWebSearch(query);
          },
        },
        {
          id: "open_page",
          description: "打开网页并读取正文。当需要阅读具体网页内容时使用。参数：url（网页地址）",
          parameters: {
            url: "string",
          },
          async execute(args, ctx) {
            if (!globalState.enabled || !globalState.proxyUrl) {
              return { error: "联网功能未启用或未配置代理" };
            }

            const url = String(args?.url || "").trim();
            if (!url) {
              return { error: "缺少网页地址" };
            }

            return await toolOpenPage(url);
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
          // 首次打开任何 app 时初始化全局状态
          await initGlobalState(roche);

          container.innerHTML = `
            <div class="roche-plugin-auto-web" style="display: flex; flex-direction: column; height: 100%; font-family: system-ui; color: #333; background: #f5f5f5;">
              <!-- 顶部栏 -->
              <div style="display: flex; align-items: center; padding: 16px; background: white; border-bottom: 1px solid #e0e0e0; flex-shrink: 0;">
                <button id="back-btn" style="padding: 8px 16px; background: #f0f0f0; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">
                  ← 返回
                </button>
                <h2 style="margin: 0 0 0 16px; font-size: 18px; font-weight: 600;">智能联网助手 - 设置</h2>
              </div>

              <!-- 内容区 -->
              <div style="flex: 1; overflow-y: auto; padding: 20px;">
                <div style="background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                  <label style="display: block; font-weight: 600; margin-bottom: 8px;">
                    CORS 代理地址 *
                  </label>
                  <input
                    id="proxy-input"
                    type="text"
                    placeholder="https://你的代理.hf.space/proxy"
                    value="${globalState.proxyUrl}"
                    style="width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; box-sizing: border-box;"
                  />
                  <p style="margin: 8px 0 0; font-size: 13px; color: #666;">
                    用于绕过浏览器跨域限制，必填。可复用 browser-mcp 的代理。
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
                  <p style="margin: 8px 0 0; font-size: 13px; color: #666;">
                    关闭后 AI 将无法调用联网工具
                  </p>
                </div>

                <button id="save-btn" style="width: 100%; padding: 14px; background: #007aff; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; margin-bottom: 16px;">
                  保存设置
                </button>

                <div style="background: #e8f5e9; border-radius: 12px; padding: 16px; margin-bottom: 16px;">
                  <h3 style="margin: 0 0 12px; font-size: 16px; color: #2e7d32;">✅ 使用说明</h3>
                  <ul style="margin: 0; padding-left: 20px; line-height: 1.8; font-size: 14px;">
                    <li>启用后，AI 会在聊天时<strong>自动判断</strong>是否需要联网</li>
                    <li>无需任何指令，AI 会主动搜索或浏览网页</li>
                    <li>支持搜索（DuckDuckGo）和打开网页读正文</li>
                    <li>所有操作在后台完成，聊天窗口正常显示</li>
                  </ul>
                </div>

                <div style="background: #fff3cd; border-radius: 12px; padding: 16px; border-left: 4px solid #ffc107;">
                  <h3 style="margin: 0 0 12px; font-size: 16px; color: #856404;">⚠️ 注意事项</h3>
                  <ul style="margin: 0; padding-left: 20px; line-height: 1.8; font-size: 14px;">
                    <li>AI 联网会消耗更多 tokens</li>
                    <li>需要部署 CORS 代理（可用现有的 browser-mcp 代理）</li>
                    <li>代理地址填错会导致工具调用失败</li>
                    <li>DuckDuckGo 可能反爬，搜索失败时检查代理</li>
                  </ul>
                </div>
              </div>
            </div>
          `;

          // 返回按钮
          container.querySelector("#back-btn").onclick = () => {
            roche.ui.closeApp();
          };

          // 保存按钮
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

            roche.ui.toast("✅ 保存成功！AI 现在可以自动联网了");
          };
        },
        async unmount(container) {
          container.innerHTML = "";
        },
      },
    ],
  });
})();
