/*
 * Roche 智能联网助手
 * 让 AI 在正常聊天窗口自动判断何时需要联网，自动调用工具
 *
 * 工作原理：
 * 1. 插件启动后在后台运行（不显示单独页面）
 * 2. 拦截 roche.ai.chat 调用，给 AI 注入工具使用说明
 * 3. AI 输出工具调用时，自动执行并把结果喂回去
 * 4. 循环直到 AI 给出最终答案
 */
(function () {
  "use strict";

  const PLUGIN_ID = "auto-web";

  // 全局状态
  let globalState = {
    proxyUrl: "",
    enabled: true,
    roche: null,
    originalChat: null, // 保存原始的 roche.ai.chat
  };

  // ============================================================
  // 工具定义
  // ============================================================

  const TOOLS_PROMPT = `
你现在拥有以下工具，可以在回答用户时随时调用：

1. web_search - 联网搜索
   参数: {"query": "搜索关键词"}
   用途: 当需要最新信息、实时数据、不确定的事实时使用

2. open_page - 打开网页读取正文
   参数: {"url": "https://..."}
   用途: 当需要阅读具体网页内容时使用

调用规则：
- 当你判断需要使用工具时，输出一个 JSON 块：{"tool":"工具名","params":{参数}}
- 工具结果会以【工具结果】的形式返回给你
- 你可以连续调用多个工具（先搜索，再打开某个结果）
- 当信息足够时，直接输出最终答案，在开头加一行 {"tool":"final"}

例子：
用户: "帮我查一下今天北京天气"
你: {"tool":"web_search","params":{"query":"北京天气 今天"}}
系统: 【工具结果】搜索结果...
你: {"tool":"final"}
根据最新信息，今天北京...

重要：
- 主动判断是否需要工具，不要问用户"要不要我搜索"
- 如果用户提到最新信息、具体人物/事件/产品，主动搜索
- 保持角色人设和对话风格
`.trim();

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
        return { ok: false, error: "未找到搜索结果" };
      }

      return { ok: true, results: results };
    } catch (e) {
      return { ok: false, error: e.message };
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
      return { ok: false, error: "非法 URL" };
    }

    try {
      const r = await proxyFetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      const extracted = extractReadable(r.text);
      return {
        ok: true,
        url: url,
        title: extracted.title,
        text: clampText(extracted.text, 6000),
      };
    } catch (e) {
      return { ok: false, error: e.message };
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

  // ============================================================
  // AI 调用拦截器
  // ============================================================

  // 解析 AI 输出中的工具调用
  function parseToolCall(text) {
    text = String(text || "").trim();
    const start = text.indexOf("{");
    if (start === -1) return null;

    let depth = 0, end = -1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }

    if (end === -1) return null;

    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      if (!obj.tool) return null;
      return obj;
    } catch (e) {
      return null;
    }
  }

  // 执行工具调用
  async function executeTool(toolCall) {
    const { tool, params } = toolCall;

    if (tool === "web_search") {
      const query = params?.query || "";
      if (!query) return "错误：缺少搜索关键词";

      const result = await toolWebSearch(query);
      if (!result.ok) return `搜索失败：${result.error}`;

      return "搜索「" + query + "」结果：\n" +
             result.results.map((r, i) =>
               `${i+1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
             ).join("\n");
    }

    if (tool === "open_page") {
      const url = params?.url || "";
      if (!url) return "错误：缺少 URL";

      const result = await toolOpenPage(url);
      if (!result.ok) return `打开失败：${result.error}`;

      return `网页《${result.title || url}》正文：\n${result.text}`;
    }

    return "未知工具: " + tool;
  }

  // 增强的 chat 函数（带工具循环）
  async function enhancedChat(originalOptions) {
    if (!globalState.enabled || !globalState.proxyUrl) {
      // 未启用或未配置，直接调用原始 chat
      return await globalState.originalChat(originalOptions);
    }

    const messages = originalOptions.messages || [];
    const maxSteps = 5; // 最多工具调用次数

    // 注入工具说明（在 system 消息后）
    const enhancedMessages = [...messages];
    const lastSystemIdx = enhancedMessages.findIndex(m => m.role === "system");

    if (lastSystemIdx !== -1) {
      enhancedMessages.splice(lastSystemIdx + 1, 0, {
        role: "system",
        content: TOOLS_PROMPT,
      });
    } else {
      enhancedMessages.unshift({
        role: "system",
        content: TOOLS_PROMPT,
      });
    }

    // 工具调用循环
    for (let step = 0; step < maxSteps; step++) {
      const resp = await globalState.originalChat({
        ...originalOptions,
        messages: enhancedMessages,
      });

      const aiText = resp?.text || "";
      const toolCall = parseToolCall(aiText);

      // 没有工具调用或是最终答案
      if (!toolCall || toolCall.tool === "final") {
        // 返回去掉 {"tool":"final"} 的文本
        if (toolCall?.tool === "final") {
          const cleaned = aiText.replace(/\{"tool"\s*:\s*"final"\s*\}/, "").trim();
          return { ...resp, text: cleaned };
        }
        return resp;
      }

      // 记录 AI 的工具调用
      enhancedMessages.push({
        role: "assistant",
        content: aiText,
      });

      // 执行工具
      let toolResult;
      try {
        toolResult = await executeTool(toolCall);
      } catch (e) {
        toolResult = "工具执行错误: " + e.message;
      }

      // 把结果喂回去
      enhancedMessages.push({
        role: "user",
        content: "【工具结果】\n" + toolResult,
      });
    }

    // 步数用完，强制要求最终答案
    enhancedMessages.push({
      role: "user",
      content: "工具调用次数已达上限，请基于已有信息直接给出最终回答。",
    });

    return await globalState.originalChat({
      ...originalOptions,
      messages: enhancedMessages,
    });
  }

  // ============================================================
  // 插件注册
  // ============================================================

  window.RochePlugin.register({
    id: PLUGIN_ID,
    name: "智能联网助手",
    version: "1.0.0",

    // 插件初始化（在后台运行，不显示界面）
    async init(roche) {
      globalState.roche = roche;

      // 读取配置
      try {
        const saved = await roche.storage.get("proxyUrl");
        if (saved) globalState.proxyUrl = saved;
      } catch (e) {}

      // 如果没有配置代理，提示用户
      if (!globalState.proxyUrl) {
        const input = await roche.ui.prompt({
          title: "智能联网助手",
          message: "首次使用需要配置 CORS 代理地址\n（用于绕过浏览器跨域限制）",
          placeholder: "https://你的代理.hf.space/proxy",
        });

        if (input) {
          globalState.proxyUrl = input.trim();
          await roche.storage.set("proxyUrl", globalState.proxyUrl);
          roche.ui.toast("代理配置成功！AI 现在可以自动联网了");
        } else {
          roche.ui.toast("未配置代理，联网功能不可用");
          globalState.enabled = false;
          return;
        }
      }

      // 拦截 roche.ai.chat
      if (roche.ai && roche.ai.chat) {
        globalState.originalChat = roche.ai.chat;
        roche.ai.chat = enhancedChat;

        console.log("[智能联网助手] 已启用，AI 现在可以自动联网");
        roche.ui.toast("✅ 智能联网助手已启用");
      } else {
        console.error("[智能联网助手] 无法找到 roche.ai.chat");
        roche.ui.toast("❌ 启动失败：找不到聊天接口");
      }
    },

    // 插件卸载
    async destroy(roche) {
      // 恢复原始 chat 函数
      if (globalState.originalChat && roche.ai) {
        roche.ai.chat = globalState.originalChat;
      }

      globalState = {
        proxyUrl: "",
        enabled: false,
        roche: null,
        originalChat: null,
      };

      console.log("[智能联网助手] 已卸载");
    },

    // 可选：提供设置界面（用于修改代理地址）
    apps: [
      {
        id: "auto-web-settings",
        name: "联网设置",
        icon: "settings",
        async mount(container, roche) {
          container.innerHTML = `
            <div style="padding: 20px; font-family: system-ui; color: #333;">
              <h2>智能联网助手 - 设置</h2>
              <p style="color: #666;">配置 CORS 代理地址，用于绕过浏览器跨域限制</p>

              <label style="display: block; margin-top: 20px; font-weight: 600;">
                CORS 代理地址
              </label>
              <input
                id="proxy-input"
                type="text"
                placeholder="https://你的代理.hf.space/proxy"
                value="${globalState.proxyUrl}"
                style="width: 100%; padding: 10px; margin-top: 8px; border: 1px solid #ddd; border-radius: 6px;"
              />

              <div style="margin-top: 20px;">
                <button id="save-btn" style="padding: 10px 20px; background: #007aff; color: white; border: none; border-radius: 6px; cursor: pointer;">
                  保存
                </button>
                <button id="toggle-btn" style="padding: 10px 20px; background: #666; color: white; border: none; border-radius: 6px; cursor: pointer; margin-left: 10px;">
                  ${globalState.enabled ? "禁用" : "启用"}
                </button>
              </div>

              <div style="margin-top: 30px; padding: 15px; background: #f5f5f5; border-radius: 6px;">
                <h3>使用说明</h3>
                <ul style="line-height: 1.8;">
                  <li>启用后，AI 会在聊天时<strong>自动判断</strong>是否需要联网</li>
                  <li>无需任何指令，AI 会主动搜索或浏览网页</li>
                  <li>支持搜索（DuckDuckGo）和打开网页</li>
                  <li>所有操作在后台完成，聊天窗口正常显示</li>
                </ul>
              </div>

              <div style="margin-top: 20px; padding: 15px; background: #fff3cd; border-radius: 6px; border-left: 4px solid #ffc107;">
                <strong>⚠️ 注意</strong>
                <ul style="margin-top: 10px; line-height: 1.8;">
                  <li>需要部署 CORS 代理（可用现有的 browser-mcp 代理）</li>
                  <li>AI 联网会消耗更多 tokens</li>
                  <li>代理地址填错会导致工具调用失败</li>
                </ul>
              </div>
            </div>
          `;

          container.querySelector("#save-btn").onclick = async () => {
            const input = container.querySelector("#proxy-input");
            const url = input.value.trim();

            if (!url) {
              roche.ui.toast("请输入代理地址");
              return;
            }

            globalState.proxyUrl = url;
            await roche.storage.set("proxyUrl", url);
            roche.ui.toast("保存成功");
          };

          container.querySelector("#toggle-btn").onclick = () => {
            globalState.enabled = !globalState.enabled;
            container.querySelector("#toggle-btn").textContent =
              globalState.enabled ? "禁用" : "启用";
            roche.ui.toast(globalState.enabled ? "已启用" : "已禁用");
          };
        },
        async unmount(container) {
          container.innerHTML = "";
        },
      },
    ],
  });
})();
