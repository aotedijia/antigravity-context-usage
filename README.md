# Antigravity Context Usage（谷歌反重力上下文占用查看插件）

轻量级、零外部依赖的 Google Antigravity 插件，用于精准查看当前及历史会话的上下文窗口占用情况：

- **Codex 风格侧边栏实时环形表（Sidecar UI）**：嵌入 Antigravity 右侧辅助栏（Aux Pane），实时轮询 `transcript.jsonl` 变更自动刷新，原生接入 `preload.js` 主题变量自动适配深浅色模式。
- **快捷对话技能（`/context-usage` Skill）**：在对话中输入 `/context-usage` 或自然语言随时查询上下文占用，也可一键打开右侧环形面板。
- **独立 CLI 工具**：零依赖 Node.js 脚本，不消耗模型 Token，支持单会话查询、多会话概览、自定义上限与 JSON 输出。

---

## 核心原理

读取 Antigravity 本地会话日志 `<appDataDir>/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`，从最新一条 `PLANNER_RESPONSE` 记录中精确计算：

```text
当前上下文占用 = input_tokens + cache_read_tokens
```

同时自动识别 `CHECKPOINT`（上下文压缩事件），分别展示「本段峰值」「历史最高峰值」和「已压缩次数」；当占用率达到 80% 及以上时，自动标红并提示执行 `/compact`。

---

## 快速安装

前置要求：Node.js 18+

```bash
git clone https://github.com/aotedijia/antigravity-context-usage.git
cd antigravity-context-usage
node scripts/sync-plugin.mjs
```

安装脚本会将插件包同步到 `~/.gemini/config/plugins/context-usage`，Antigravity 会自动发现并加载插件（无需重启；若 Sidecar 面板未立即可用，可在 Antigravity 插件页开关一次 `context-usage`）。

> **Windows 说明**：安装脚本在 Windows 上会自动把已安装目录中的 `sidecars/context-gauge/sidecar.json` 启动命令调整为 `"node.exe"`，以绕过部分 Windows 版 Antigravity 内置 `node` 包装层触发 `ELECTRON_RUN_AS_NODE` 报错的问题；macOS / Linux 则保持 `"node"`。

### 卸载

```bash
node scripts/sync-plugin.mjs --uninstall
```

---

## 使用方式

### 1. 右侧辅助栏实时环形面板（Sidecar UI）

插件启用后，可在对话中说「打开上下文占用环形面板」，或直接点击生成的 `[上下文占用](sidecar://context-usage/context-gauge/)` 胶囊打开：

- 居中 Codex 风格环形进度条，悬停查看精确已用与剩余 Token
- 自动追踪当前活跃会话，也支持下拉切换最近 12 个历史会话
- 支持自定义上下文窗口上限（自动 / `128K` / `200K` / `256K` / `1M`）

### 2. 对话中通过 Skill 查询

输入 `/context-usage` 或任意自然语言：

- `查看当前会话的上下文占用`
- `列出最近 5 个会话的上下文占用情况`
- `按 200k 上下文上限查看当前会话占用率`

### 3. 命令行直接使用（零对话 Token 消耗）

```bash
# 查看最近活跃会话的上下文占用
node skills/context-usage/scripts/context-usage.mjs

# 查看指定会话（支持完整 UUID 或前缀）
node skills/context-usage/scripts/context-usage.mjs --conversation <conversation-id>

# 列出最近 5 个会话的上下文占用概览
node skills/context-usage/scripts/context-usage.mjs --list 5

# 按自定义上下文窗口上限计算占比
node skills/context-usage/scripts/context-usage.mjs --limit 200k

# 输出 JSON（便于二次集成）
node skills/context-usage/scripts/context-usage.mjs --json
```

---

## 项目结构

```text
context-usage/
├── plugin.json                              # Antigravity 插件清单
├── LICENSE                                  # MIT 许可证
├── README.md                                # 项目说明
├── package.json                             # 脚本与环境声明（零依赖）
├── assets/
│   └── logo.svg                             # 插件矢量图标
├── sidecars/
│   └── context-gauge/
│       ├── sidecar.json                     # 右侧辅助栏 Sidecar 声明
│       ├── server.mjs                       # 零依赖 HTTP 实时服务（/api/usage + /preload.js）
│       └── ui.html                          # Codex 风格极简环形指示器页面
├── skills/
│   └── context-usage/
│       ├── SKILL.md                         # 对话触发技能
│       └── scripts/
│           └── context-usage.mjs            # 零依赖上下文分析核心与 CLI
├── scripts/
│   └── sync-plugin.mjs                      # 跨平台同步/卸载安装脚本
└── test/
    └── context-usage.test.mjs               # 单元测试与 Sidecar 接口测试
```

---

## 开发与测试

```bash
# 运行全部测试
node --test test/context-usage.test.mjs

# 修改后重新同步到本机 Antigravity 插件目录
node scripts/sync-plugin.mjs
```

## License

[MIT](./LICENSE)
