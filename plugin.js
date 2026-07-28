/*
 * Roche 智能联网助手 v5.0 Lite
 * 精简版：只保留设置和应用，移除所有可能干扰消息的功能
 * 聊天工具改为完全独立加载，不影响主线程
 */
(function () {
  "use strict";

  const PLUGIN_ID = "auto-web";

  // 最小化全局状态
  let config = {
    proxyUrl: "",
    enabled: true,
    enableChatTools: false,
    customHeaders: {},
    customEngines: [],
  };

  // ============================================================
  // 配置管理（异步非阻塞）
  // ============================================================

  async function loadConfig(roche) {
    try {
      const saved = await roche.storage.get(`${PLUGIN_ID}:config`);
      if (saved) {
        Object.assign(config, saved);
      }
    } catch (e) {
      console.error("[联网助手] 加载配置失败:", e);
    }
  }

  async function saveConfig(roche) {
    try {
      await roche.storage.set(`${PLUGIN_ID}:config`, config);
    } catch (e) {
      console.error("[联网助手] 保存配置失败:", e);
    }
  }

  // ============================================================
  // 代理请求（核心功能）
  // ============================================================

  async function proxyFetch(url, opts = {}) {
    if (!config.proxyUrl) {
      throw new Error("未配置代理地址");
    }

    const headers = { ...(opts.headers || {}), ...config.customHeaders };

    const resp = await fetch(config.proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: url,
        method: opts.method || "GET",
        headers: headers,
        body: opts.body,
      }),
    });

    if (!resp.ok) {
      throw new Error(`代理请求失败: ${resp.status}`);
    }

    const data = await resp.json();
    return data;
  }

  // ============================================================
  // 搜索工具函数（简化版）
  // ============================================================

  async function webSearch(query) {
    const baseUrl = config.proxyUrl.replace("/proxy", "");
    const resp = await fetch(`${baseUrl}/api/duckduckgo?q=${encodeURIComponent(query)}`);
    return await resp.json();
  }

  async function openPage(url) {
    const data = await proxyFetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    return { url, content: data.text?.substring(0, 5000) || "" };
  }

  // ============================================================
  // 插件注册
  // ============================================================

  window.RochePlugin.register({
    id: PLUGIN_ID,
    name: "智能联网助手",
    version: "5.0.0",

    // 聊天工具：完全独立，只在启用时加载
    chat: config.enableChatTools ? {
      scope: {},
      tools: [
        {
          id: "web_search",
          description: "网页搜索（DuckDuckGo）",
          parameters: { query: "string" },
          async execute(args) {
            if (!config.enabled || !config.proxyUrl) {
              return { error: "联网功能未启用" };
            }
            try {
              return await webSearch(String(args?.query || "").trim());
            } catch (e) {
              return { error: e.message };
            }
          },
        },
        {
          id: "open_page",
          description: "打开网页并读取正文",
          parameters: { url: "string" },
          async execute(args) {
            if (!config.enabled || !config.proxyUrl) {
              return { error: "联网功能未启用" };
            }
            try {
              return await openPage(String(args?.url || "").trim());
            } catch (e) {
              return { error: e.message };
            }
          },
        },
      ],
    } : undefined, // 关闭时不注册 chat 对象

    apps: [
      {
        id: "auto-web-settings",
        name: "联网设置",
        async mount(container, roche) {
          await loadConfig(roche);

          container.innerHTML = `
            <div style="display: flex; flex-direction: column; height: 100%; background: #f5f5f5;">
              <div style="display: flex; align-items: center; padding: 16px; background: white; border-bottom: 1px solid #e0e0e0; flex-shrink: 0;">
                <button id="back-btn" style="padding: 8px 16px; background: #f0f0f0; border: none; border-radius: 6px; cursor: pointer;">← 返回</button>
                <h2 style="margin: 0 0 0 16px; font-size: 18px;">智能联网助手 v5.0 Lite</h2>
              </div>

              <div style="flex: 1; overflow-y: auto; padding: 20px;">
                <!-- 代理设置 -->
                <div style="background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                  <label style="display: block; font-weight: 600; margin-bottom: 8px;">代理服务器地址 *</label>
                  <input id="proxy-input" type="text" placeholder="https://用户名-项目名.hf.space/proxy" value="${config.proxyUrl}" style="width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 8px; box-sizing: border-box;" />
                </div>

                <!-- 自定义请求头 -->
                <div style="background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                  <h3 style="margin: 0 0 8px; font-size: 16px;">🍪 自定义请求头</h3>
                  <textarea id="custom-headers-input" placeholder="Cookie: session=abc123" style="width: 100%; min-height: 80px; padding: 12px; border: 1px solid #ddd; border-radius: 8px; font-family: monospace; box-sizing: border-box; resize: vertical;">${Object.entries(config.customHeaders).map(([k, v]) => `${k}: ${v}`).join('\n')}</textarea>
                </div>

                <!-- 开关 -->
                <div style="background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                  <label style="display: flex; align-items: center; cursor: pointer; margin-bottom: 12px;">
                    <input id="enabled-checkbox" type="checkbox" ${config.enabled ? "checked" : ""} style="width: 20px; height: 20px; margin-right: 10px;" />
                    <span style="font-weight: 600;">启用联网功能</span>
                  </label>
                  <label style="display: flex; align-items: center; cursor: pointer;">
                    <input id="chat-tools-checkbox" type="checkbox" ${config.enableChatTools ? "checked" : ""} style="width: 20px; height: 20px; margin-right: 10px;" />
                    <span style="font-weight: 600;">启用聊天工具</span>
                  </label>
                  <div style="margin-left: 30px; margin-top: 8px; font-size: 12px; color: #666;">
                    开启后需要刷新页面生效
                  </div>
                </div>

                <!-- 自定义搜索引擎 -->
                <div style="background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                  <h3 style="margin: 0 0 12px; font-size: 16px;">🔧 自定义搜索引擎</h3>
                  <div id="engines-list" style="margin-bottom: 12px;">
                    ${config.customEngines.length > 0 ? config.customEngines.map((e, i) => `
                      <div style="padding: 10px; background: #f5f5f5; border-radius: 6px; margin-bottom: 8px; display: flex; justify-content: space-between;">
                        <div><strong>${e.name}</strong><br/><small>${e.searchUrl}</small></div>
                        <button class="del-engine" data-index="${i}" style="padding: 4px 12px; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer;">删除</button>
                      </div>
                    `).join("") : "<div style='color: #999;'>暂无</div>"}
                  </div>
                  <button id="add-engine-btn" style="padding: 8px 16px; background: #4caf50; color: white; border: none; border-radius: 6px; cursor: pointer;">+ 添加引擎</button>
                </div>

                <button id="save-btn" style="width: 100%; padding: 14px; background: #007aff; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer;">💾 保存设置</button>
              </div>
            </div>
          `;

          // 事件绑定
          container.querySelector("#back-btn").onclick = () => roche.ui.closeApp();

          container.querySelector("#save-btn").onclick = async () => {
            const proxyInput = container.querySelector("#proxy-input");
            const headersInput = container.querySelector("#custom-headers-input");
            const enabledCheck = container.querySelector("#enabled-checkbox");
            const chatToolsCheck = container.querySelector("#chat-tools-checkbox");

            if (!proxyInput.value.trim()) {
              roche.ui.toast("请输入代理地址");
              return;
            }

            // 解析 headers
            const headers = {};
            for (const line of headersInput.value.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              const colonIndex = trimmed.indexOf(':');
              if (colonIndex === -1) continue;
              const key = trimmed.substring(0, colonIndex).trim();
              const value = trimmed.substring(colonIndex + 1).trim();
              if (key) headers[key] = value;
            }

            config.proxyUrl = proxyInput.value.trim();
            config.enabled = enabledCheck.checked;
            config.enableChatTools = chatToolsCheck.checked;
            config.customHeaders = headers;

            await saveConfig(roche);
            roche.ui.toast("✅ 保存成功！" + (chatToolsCheck.checked ? " 请刷新页面。" : ""));
          };

          container.querySelector("#add-engine-btn").onclick = async () => {
            const name = prompt("引擎名称（如：百度）：");
            if (!name) return;
            const url = prompt("URL 模板（用 {query} 表示搜索词）：\n如：https://www.baidu.com/s?wd={query}");
            if (!url || !url.includes("{query}")) {
              roche.ui.toast("❌ URL 必须包含 {query}");
              return;
            }

            config.customEngines.push({
              id: `custom_${Date.now()}`,
              name: name.trim(),
              searchUrl: url.trim()
            });

            await saveConfig(roche);
            roche.ui.toast("✅ 已添加");
            roche.ui.closeApp();
            roche.ui.openApp("auto-web-settings");
          };

          container.querySelectorAll(".del-engine").forEach(btn => {
            btn.onclick = async () => {
              const index = parseInt(btn.dataset.index);
              config.customEngines.splice(index, 1);
              await saveConfig(roche);
              roche.ui.toast("✅ 已删除");
              roche.ui.closeApp();
              roche.ui.openApp("auto-web-settings");
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
