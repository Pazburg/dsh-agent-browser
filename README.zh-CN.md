# dsh-agent-browser（中文说明）

[![CI](https://github.com/Pazburg/dsh-agent-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/Pazburg/dsh-agent-browser/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

给 **DSH（DeepSeek Harness）桌面端** 的内置「AI 浏览器」插件：让 AI 能在一个受控的侧栏浏览器里读页面、填输入框、截图，并**只在显式要求时**点击控件（单选/复选/按钮/链接）。它不碰你日常用的 Edge/Chrome，不按回车，也不调用 `form.submit()`。

> 状态：实验性。开发与验证基于 DSH 桌面端 `0.2.1-rc.2`（Electron 44 / Node 24，Windows）。插件依赖 DSH 内部 API，DSH 升级后可能需要适配，请固定你验证过的 DSH 版本。

## 它能做什么 / 不能做什么

**能做：**

- 在 DSH 右侧栏的「AI 浏览器」标签里打开 http/https 页面（真正的 Electron `<webview>`，走 DSH 主进程的租约通道）；
- `browser_read` 读取页面 URL、标题、可见文本、可编辑元素、表单分组（单选/复选/文本控件）、按钮、链接，同源 iframe 也能读；
- `browser_fill` 往 input / textarea / select / contenteditable / CodeMirror / Monaco / Ace 里填内容；
- 显式点击：`browser_fill({ click: true, ... })` 才会真实点击单选、复选、按钮、链接（含提交按钮）；
- `browser_screenshot` 截图成 PNG（需要 DSH 窗口与「AI 浏览器」标签可见）；
- `browser_panel` 查看面板连接状态；`browser_allowlist` 在确认模式下管理白名单。

**不能做（设计如此）：**

- 不按回车、不调用 `form.submit()` / `requestSubmit()`、不在未传 `click:true` 时点击任何控件；
- **永远不填、不读取 `password` / `file` 字段的明文**（读取只回传 `valueLength`；表单文本控件另带 `redacted: true`）；
- 不接触外部浏览器进程或其配置；
- 跨域 iframe 读不到、填不进。

## 架构

```
┌─ DSH 窗口 ───────────────────────────────────────────────────────┐
│                                        │ 右侧栏                   │
│   正常 DSH 对话区                       │ ┌──────────────────────┐ │
│                                        │ │ ← ↻ [网址....] ↵     │ │
│                                        │ │ 标题 · host/path  ●  │ │
│                                        │ │ ┌──────────────────┐ │ │
│                                        │ │ │     webview      │ │ │
│                                        │ │ └──────────────────┘ │ │
│                                        │ │ ▸ 受信白名单          │ │
│                                        │ └──────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
        ▲                                          │
        │ 工具调用（open/read/fill/screenshot）      │ 每 500ms 轮询指令
        │                                          ▼
   Host 插件（dsh-desktop-host 子进程）  ←── HTTP 路由 /dsh-agent-browser/*
```

DSH 的架构把两半分开：Host 半边（`index.js`）运行在 `dsh-desktop-host` 子进程里，碰不到页面，只能注册工具、排队指令、存白名单；Client 半边（`client.js`）运行在 DSH 渲染进程，持有真正的 `<webview>` 并执行指令。两边通过带令牌的 HTTP 指令队列 + 500ms 轮询通信。协议细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 环境要求

- DSH 桌面端 **0.2.x**（验证版本 `0.2.1-rc.2`）。普通浏览器里打开 DSH 页面拿不到 `dshDesktop.browser`，无法创建受控 webview。
- Windows 可使用仓库自带的 `install.cmd` / `install.ps1`；手动安装也可用于 DSH 支持的其他平台。
- 开发/自测需要 Node.js **20+**（CI 跑 22/24）；插件自身零运行时依赖。

## 安装

**一键安装（Windows）：**

1. **完全退出 DSH**（托盘图标 → 退出；只点窗口 × 可能只是最小化到托盘）；
2. 双击仓库根目录的 **`install.cmd`**；
3. 重新打开 DSH，在右侧栏打开「AI 浏览器」标签（或直接让 AI 用一次浏览器，它会自己开标签）。

安装脚本会：把运行文件复制到
`%USERPROFILE%\.dsh\profiles\desktop\node_modules\@local\dsh-agent-browser\`；
把已有插件目录备份到 `…\profiles\desktop\agent-browser-backups\install-<时间戳>\`；
**保留已有的 `cordis.patch.yml` 配置**；把 `@local/dsh-agent-browser` 登记进 `…\profiles\desktop\package.json` 的 `dsh.profile.bundles`；失败时回滚 profile 清单。

**手动安装：**

1. 退出 DSH；
2. 把 `index.js`、`client.js`、`package.json`、`cordis.patch.yml`（可选 `README.md`、`CHANGELOG.md`）复制到
   `%USERPROFILE%\.dsh\profiles\desktop\node_modules\@local\dsh-agent-browser\`；
3. 在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 数组里加一行 `"@local/dsh-agent-browser"`；
4. 重启 DSH。

**卸载：** 完全退出 DSH 后运行 `uninstall.cmd`（移除登记并删除插件目录）；或只从 `dsh.profile.bundles` 里删掉这一行再重启，即可停用。

## 首次使用

1. 重启 DSH → 右侧栏出现「AI 浏览器」标签（侧栏的 ＋ 里也能选到）；
2. 在面板地址栏里**自己**输入网址并打开（你自己开页面不需要白名单）；
3. 需要登录的站点，**你自己在面板里登录一次**。注意：DSH 给内部浏览器的分区是内存态，关掉 DSH 登录态就会丢失（这是 DSH 的行为）；插件只会记住「最近访问/上次页面」的网址，不会保留 cookie；
4. 之后就可以让 AI 干活，例如「读一下当前页面」「把这段代码填进第 0 个输入框」。

## 配置

配置文件是已安装插件里的 `cordis.patch.yml`（改完重启 DSH）。若完全省略 `openPolicy`，代码会回落到 `confirm`（安全默认）。

```yaml
- insert:
    - id: dsh-agent-browser
      name: '@local/dsh-agent-browser'
      config:
        # confirm（默认，推荐）：白名单外的网址先由用户在面板里点「允许」
        # free：任意 http/https 直接打开（白名单与确认 UI 关闭，慎用）
        openPolicy: confirm

        # 可选：门户点击桥生效的宿主后缀（含子域）。
        # 用于「window.open('') 打开空窗口再写入表单」的内网/门户站点：
        # 插件会在当前页生成一个可见的「继续打开」按钮，而不是自动提交。
        # portalBridgeHosts:
        #   - example.com

        # 可选：预置白名单（仅 confirm 模式生效）。
        # allowlist:
        #   - example.com
        #   - https://intranet.example.com/app

        # 可选：截图输出目录。
        # shotDir: C:\Users\you\Pictures\dsh-shots
```

运行时数据保存在 `$DSH_HOME/agent-browser/`（一般是 `~/.dsh/agent-browser/`）：`allowlist.json`（面板里维护的白名单）与 `shots/`（默认截图目录）。

**白名单规则：**

- 域名规则：`example.com` —— 命中它自己和所有子域（`app.example.com`……）；
- 网址前缀规则：`https://app.example.com/path` —— 只命中这个前缀下的页面；
- 域名规则不允许后缀伪装（`notexample.com` 不会命中 `example.com`）；网址前缀规则限定**同源**（`https://example.com` 不会命中 `https://example.com.evil.com` 或其它端口）。无效规则会被拒绝。

## 工具一览

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `browser_panel` | 查看面板是否连接、当前页面、白名单、待执行指令数；浏览器操作前先调它 | — |
| `browser_open` | 在面板里打开 http/https 网址；confirm 模式下白名单外需用户允许 | `url` |
| `browser_read` | 读当前页：URL、标题、可见文本（截断）、可编辑元素、`forms`（单选/复选分组）、`buttons`、`links`；同源 iframe 带 `framePath`；password/file 只回传长度 | — |
| `browser_fill` | 填值；显式 `click:true` 时点击控件。默认只填、不回车、不点击、不提交 | `text`、`click`、`selector`、`index`、`framePath`、`replace` |
| `browser_screenshot` | 截图成 PNG 并返回路径（需要 DSH 窗口和「AI 浏览器」标签可见） | — |
| `browser_allowlist` | confirm 模式下 list/add/remove 白名单；free 模式下只读状态 | `action`、`pattern` |

**`browser_fill` 说明**

- 填值：`browser_fill({ selector: '#code', text: '...' })` 或 `browser_fill({ index: 3, text: '...' })`；
- 点击：`browser_fill({ selector: '#submitBtn', click: true })`；单选可传 `text:'B'` 校验选项值；复选不传 `text` 时点击切换一次，传字符串 `'true'`/`'false'` 指定目标状态；
- `index` 是 `browser_read` 返回的**全局扁平序号**（跨同源 iframe 一致）；`framePath` 用于把 `selector` 限定到某个 iframe，或对 `index` 做一致性校验；
- `replace` 只对 `input`/`textarea` 生效；`contenteditable` 与 CodeMirror/Monaco/Ace 会忽略它；
- 会被拒绝：password/file 字段、disabled/已脱离 DOM 的控件、不唯一的 selector、没传 `click:true` 的点击；
- 点击是**合成事件**（`isTrusted=false`）：要求真实用户激活的站点可能不生效，这是 webview 的安全边界。

## 面板功能

按普通浏览器的习惯做了这些：

| 功能 | 说明 |
|---|---|
| 页面缩放 25%–300% | 标题行 `− 100% +`；`Ctrl +` / `Ctrl -` / `Ctrl 0`；`Ctrl + 滚轮`；比例会记住 |
| 前进 / 后退 | 工具栏 `←` `→`；`Alt + ←/→` |
| 刷新 / 停止 | 加载中变 `✕`（点击停止）；`Ctrl+R` / `F5` |
| 页面内查找 | `Ctrl+F` 或 🔍；回车下一个、`Shift+回车` 上一个、`Esc` 关闭 |
| 弹窗 / 新窗口 | 页面里的 `target=_blank` / `window.open`：free 模式在当前标签直接打开；confirm 模式走打开策略 |
| 门户点击桥 | 在 `portalBridgeHosts` 配置的站点上，把「空窗口 + 写表单 + POST」改成可见的「继续打开」按钮，点击后由浏览器原生提交 |
| 同源 iframe | `browser_read` / `browser_fill` 可进入同源 iframe（`framePath`），内嵌编辑器/表单可读可填 |
| 最近访问 / 上次页面 | 最多 12 条，存 `localStorage`；重启 DSH 后打开面板回到上次页面（登录态仍会丢） |
| 快捷键 | 焦点在网页里也生效（捕获阶段按键桥） |

## 安全边界（简版）

| 措施 | 说明 |
|---|---|
| 固定指令集 | 只有 open / read / fill / screenshot / status；没有独立点击/提交工具 |
| 点击显式化 | 只有 `click:true` 才会真实点击；不传则拒绝；disabled 控件报错 |
| 账密不外泄 | password/file 不填；读取只回传 `valueLength`（表单控件另带 `redacted`），不回传明文 |
| 打开确认 | 默认 `confirm`；白名单外网址先由用户点「允许」 |
| 令牌制 | 面板启动时认领随机令牌，缺失/错误令牌返回 403；路由走 DSH webServer 的 Host/Origin 校验。令牌防误连/跨源投递，不防「已能访问 DSH 本机回环服务的恶意本地进程」（claim/reclaim 先到先得），请把本机账户视为可信 |
| 浏览器受限 | webview 由 DSH 主进程按浏览器租约创建；DSH（验证版本 0.2.1-rc.2）应用 `nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`（这些 webPreferences 由 DSH 设置，不是本仓库设置） |
| 不碰外部浏览器 | 只操作 DSH 内部 guest，不接触 Edge/Chrome 及其配置 |

**提示注入仍然可能发生**：网页是不可信输入，恶意页面可能诱导 Agent 去点击/导航。请在不可信页面使用 `confirm` 模式，并在 Agent 操作时留意面板。完整威胁模型与漏洞上报方式见 [SECURITY.md](SECURITY.md)。

## 已知限制

1. **必须是 DSH 桌面窗口**：普通浏览器里没有 `dshDesktop.browser`，无法创建受控 webview；
2. **重启 DSH 后登录态丢失**：内部浏览器用内存分区，网址记得、cookie/登录不记得，需要重新登录；
3. **截图需要窗口可见**：窗口最小化/被遮挡或标签不在前台时失败（会重试一次并给中文提示）；
4. **只支持同源 iframe**：跨域 iframe 读不到、填不进；
5. **合成点击**可能被检查 `isTrusted`/真实用户激活的站点忽略；
6. **DSH 宿主层限制**：下载被禁、摄像头/定位/通知/麦克风被拒、`alert/confirm/prompt` 被取消、HTTP Basic 认证打不开、拖拽导航被禁、打包版无开发者工具；
7. **提交后果是真实的**：显式点击提交按钮/链接可能触发原生提交或跳转，请自行核对页面结果；
8. **去重内存态**：回执重试的点击去重只在当前控制器会话内有效，刷新页面或重启 DSH 不保留。

## 开发与自测

```powershell
npm install     # 测试依赖：@mixmark-io/domino（仅 guest DOM 级测试需要）
npm test        # 三套自测：Host / Client / Guest DOM
```

单独运行：

- `node selftest.mjs` —— Host 半边（真实 HTTP 路由、令牌、free/confirm 策略、工具、参数校验、截图 PNG、`/allowed`）；
- `node client-selftest.mjs` —— Client 半边（控制器 + 假 DOM/桥/fetch：侧栏注册、确认门禁、令牌 409 自愈、弹窗接管、去重、iframe 脚本、缩放/查找/前进后退）；
- `node guest-dom-selftest.mjs` —— 在 DOM 里真正执行 `READ_SRC` / `fillSrc`；缺 domino 时 SKIP。

CI 在 Node 22/24（Windows）上跑全部自测。贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 目录结构

```
dsh-agent-browser/
├── index.js                 # Host：工具、HTTP 路由、指令队列、白名单
├── client.js                # Client：侧栏标签、webview、指令执行
├── cordis.patch.yml         # DSH bundle patch + 配置
├── package.json             # DSH 插件清单（exports / dsh.client / dsh.bundle）
├── selftest.mjs             # Host 自测
├── client-selftest.mjs      # Client 自测
├── guest-dom-selftest.mjs   # 注入脚本的 DOM 级自测
├── install.ps1 / install.cmd
├── uninstall.ps1 / uninstall.cmd
├── .github/workflows/ci.yml # CI（Node 22/24，Windows）
├── docs/                    # 架构、审计摘要、发布清单
├── CHANGELOG.md
├── SECURITY.md
└── CONTRIBUTING.md
```

## 版本与审计

`1.1.1` 是首个公开版本，包含内部审计（针对 1.1.0）后的修复：密码侧信道、门户自动提交、强置 checked、confirm 绕过、回执重试重复点击、iframe 作用域与测试诚实性问题。详见 [CHANGELOG.md](CHANGELOG.md) 与 [docs/AUDIT-SUMMARY.md](docs/AUDIT-SUMMARY.md)。

## 许可证与免责声明

[MIT](LICENSE)。

本项目与 DeepSeek、DSH 项目及任何被操作网站均无关联。浏览器自动化可能触犯第三方网站的服务条款，请只在你有权操作的站点/账号上使用。软件按「现状」提供，不附带任何担保。
