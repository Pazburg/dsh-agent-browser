/**
 * dsh-agent-browser —— Host 半边
 *
 * 作用：给 Agent 提供「受控浏览器」工具，并通过 HTTP 路由与 DSH 界面里的浏览器面板通信。
 *
 * 分工（这是 DSH 架构决定的，不是设计选择）：
 *   - Host（本文件）跑在 dsh-desktop-host 子进程里，碰不到浏览器页面，只能登记工具、排队指令、存白名单。
 *   - Client（client.js）跑在 DSH 页面里，持有真正的 Electron <webview>，负责执行指令。
 *   - 两者用 HTTP 路由 + 轮询通信：本插件注册 /dsh-agent-browser/*，面板每 500ms 拉一次指令。
 *
 * 安全边界（用户要求，2026-10-18 调整）：
 *   - 指令集只有 open / read / fill / screenshot / status；没有独立的 click 工具。
 *   - 点击是 browser_fill 的**显式参数**：只有传 click:true 才会真实点击 radio / checkbox /
 *     button / 链接（含 submit 类 input）；不传时只填文本，绝不点击。
 *   - 不按回车、不调用 form.submit()、不主动提交；password/file 等敏感字段永远不填、不读取明文。
 *   - 非白名单网址必须先由用户在面板里点「允许」才会打开（openPolicy=confirm 时；默认 confirm，可在 cordis.patch.yml 改为 free）。
 *   - 面板令牌一次性认领，避免同机其它程序随便投指令。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-agent-browser'
export const inject = ['tools']

const ROUTE = '/dsh-agent-browser'
const TOKEN_HEADER = 'x-dsh-agent-browser-token'
/** 面板心跳新鲜度：超过这个时间没轮询就算掉线。 */
const PANEL_FRESH_MS = 5000
/** 指令默认超时：用户还要在面板上点确认，给宽一点。 */
const DEFAULT_TIMEOUT_MS = 180_000
/** 面板未就绪时的快速失败时间。 */
const PANEL_MISSING_HINT =
  '受控浏览器标签页没有连接。请展开 DSH 右侧栏，用「＋」打开「AI 浏览器」标签（或在侧栏搜索框里选它），再重试。'

const HOME_DIR = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
const DATA_DIR = join(HOME_DIR, 'agent-browser')
const ALLOWLIST_FILE = join(DATA_DIR, 'allowlist.json')
const SHOTS_DIR = join(DATA_DIR, 'shots')

/* ------------------------------------------------------------------ 白名单 */

function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 目录已存在或权限不足时静默，后续写入会再报错 */
  }
}

function loadAllowlist() {
  try {
    const raw = JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8'))
    if (Array.isArray(raw?.patterns)) {
      return raw.patterns.filter((item) => typeof item === 'string' && item.trim().length > 0)
    }
  } catch {
    /* 首次运行没有文件 */
  }
  return []
}

function saveAllowlist(patterns) {
  ensureDir(DATA_DIR)
  writeFileSync(ALLOWLIST_FILE, JSON.stringify({ patterns }, null, 2), 'utf8')
}

/** 把用户输入规整成一条受信规则；返回 null 表示无效。 */
function normalizePattern(input) {
  if (typeof input !== 'string') return null
  const text = input.trim()
  if (text.length === 0 || text.length > 2048) return null
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      return `url:${url.origin}${url.pathname === '/' ? '' : url.pathname}`
    } catch {
      return null
    }
  }
  const host = text.replace(/^\*\./, '').replace(/\/.*$/, '').toLowerCase()
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null
  return `host:${host}`
}

/** 判断网址是否命中白名单：host 规则覆盖它的子域，url 规则按前缀匹配。 */
function isAllowed(patterns, url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const host = parsed.hostname.toLowerCase()
  const full = `${parsed.origin}${parsed.pathname}`
  for (const pattern of patterns) {
    const rule = normalizePattern(pattern)
    if (rule === null) continue
    if (rule.startsWith('url:')) {
      // URL rules must stay on the same origin: a rule for https://example.com
      // must not match https://example.com.evil.com or https://example.com:8443.
      let ruleUrl
      try {
        ruleUrl = new URL(rule.slice(4))
      } catch {
        continue
      }
      if (ruleUrl.origin !== parsed.origin) continue
      const ruleBase = `${ruleUrl.origin}${ruleUrl.pathname === '/' ? '' : ruleUrl.pathname}`
      if (full.startsWith(ruleBase)) return true
      continue
    }
    const target = rule.slice(5)
    if (host === target || host.endsWith(`.${target}`)) return true
  }
  return false
}

/* -------------------------------------------------------------------- 状态 */

function createState() {
  return {
    token: randomUUID(),
    claimed: false,
    /** 待执行指令：面板轮询取走后仍保留，直到回传结果。 */
    commands: [],
    pending: new Map(),
    allowlist: loadAllowlist(),
    /** 打开策略：confirm = 白名单 + 用户确认（默认）；free = 关闭白名单与打开确认（仅显式配置时启用）。 */
    policy: 'confirm',
    /** 只在这些宿主后缀上接管 window.open（门户点击桥），默认不启用（需在 cordis.patch.yml 配置 portalBridgeHosts）。 */
    portalHosts: [],
    lastPollAt: 0,
    /** 面板上报的当前页面，仅用于状态展示。 */
    page: null,
  }
}

function panelConnected(state) {
  return Date.now() - state.lastPollAt < PANEL_FRESH_MS
}

/** 排队一条指令并等待面板回传结果。 */
function enqueue(state, kind, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!panelConnected(state)) {
    return Promise.resolve({ ok: false, error: PANEL_MISSING_HINT, panelMissing: true })
  }
  const id = randomUUID()
  const command = { id, kind, payload, at: Date.now() }
  state.commands.push(command)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.pending.delete(id)
      state.commands = state.commands.filter((item) => item.id !== id)
      resolve({ ok: false, error: `指令 ${kind} 在 ${Math.round(timeoutMs / 1000)} 秒内没有结果（面板可能已关闭或页面卡住）。` })
    }, timeoutMs)
    state.pending.set(id, { command, resolve, timer })
  })
}

function settle(state, id, ok, value, error) {
  const entry = state.pending.get(id)
  state.commands = state.commands.filter((item) => item.id !== id)
  if (entry === undefined) return false
  state.pending.delete(id)
  clearTimeout(entry.timer)
  entry.resolve(ok ? { ok: true, value } : { ok: false, error: error ?? '面板报告失败' })
  return true
}

/* ------------------------------------------------------------------- 路由 */

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > 8 * 1024 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function authorized(state, req) {
  const token = req.headers[TOKEN_HEADER]
  return typeof token === 'string' && token.length > 0 && token === state.token
}

function routes(state) {
  const base = {
    name: 'dsh-agent-browser',
    kind: 'prefix',
    path: ROUTE,
  }
  base.handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const action = url.pathname.slice(ROUTE.length).replace(/^\//, '')

    // 面板启动时认领令牌：只有第一个认领者拿到 token。
    // 信任边界：令牌防的是误连/跨源投递；同机其它进程若能访问 DSH 的本地 webServer，
    // 仍可能抢先 claim 或调用 reclaim。DSH 的 Host/Origin 校验是外层边界，这里假设
    // 本机用户与本地进程可信（single-user desktop app）。
    if (action === 'claim' && req.method === 'POST') {
      if (state.claimed) {
        send(res, 409, { error: '令牌已被认领。若面板显示无法连接，可在面板里点「强制重新认领」。' })
        return
      }
      state.claimed = true
      send(res, 200, { token: state.token, allowlist: state.allowlist })
      return
    }

    // 用户在面板上点了「强制重新认领」：换发新令牌（旧的立即失效）。
    if (action === 'reclaim' && req.method === 'POST') {
      state.token = randomUUID()
      state.claimed = true
      send(res, 200, { token: state.token, allowlist: state.allowlist })
      return
    }

    if (!authorized(state, req)) {
      send(res, 403, { error: '缺少或错误的令牌' })
      return
    }

    if (action === 'poll' && req.method === 'GET') {
      state.lastPollAt = Date.now()
      send(res, 200, {
        commands: state.commands,
        allowlist: state.allowlist,
        policy: state.policy,
        portalHosts: state.portalHosts,
        panel: true,
      })
      return
    }

    if (action === 'result' && req.method === 'POST') {
      state.lastPollAt = Date.now()
      try {
        const body = await readJsonBody(req)
        const { id, ok, value, error, page } = body
        if (typeof id !== 'string') {
          send(res, 400, { error: '缺少指令 id' })
          return
        }
        if (page !== undefined && page !== null) state.page = page
        const settled = settle(state, id, ok === true, value, error)
        send(res, 200, { settled })
      } catch (error) {
        send(res, 400, { error: String(error?.message ?? error) })
      }
      return
    }

    // 落地页复核：面板每次主框架跳转都会问一次，判定逻辑只在 Host 这一份。
    if (action === 'allowed' && req.method === 'GET') {
      const target = url.searchParams.get('url') ?? ''
      // free 策略下不再拦截任何落地页（确认机制整体关闭）
      send(res, 200, { allowed: state.policy === 'free' ? true : isAllowed(state.allowlist, target) })
      return
    }

    if (action === 'allowlist' && req.method === 'GET') {
      send(res, 200, { patterns: state.allowlist })
      return
    }

    if (action === 'allowlist' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const { action: op, pattern } = body
        if (op === 'add') {
          const rule = normalizePattern(pattern)
          if (rule === null) {
            send(res, 400, { error: '规则无效：请填域名（如 example.com）或网址（https://…）' })
            return
          }
          if (!state.allowlist.includes(pattern.trim())) state.allowlist.push(pattern.trim())
          saveAllowlist(state.allowlist)
          send(res, 200, { patterns: state.allowlist })
          return
        }
        if (op === 'remove') {
          state.allowlist = state.allowlist.filter((item) => item !== pattern)
          saveAllowlist(state.allowlist)
          send(res, 200, { patterns: state.allowlist })
          return
        }
        if (op === 'set') {
          const list = Array.isArray(pattern) ? pattern : []
          const cleaned = []
          for (const item of list) {
            if (normalizePattern(item) !== null && !cleaned.includes(String(item).trim())) cleaned.push(String(item).trim())
          }
          state.allowlist = cleaned
          saveAllowlist(state.allowlist)
          send(res, 200, { patterns: state.allowlist })
          return
        }
        send(res, 400, { error: '未知操作' })
      } catch (error) {
        send(res, 400, { error: String(error?.message ?? error) })
      }
      return
    }

    send(res, 404, { error: `未知路由 ${url.pathname}` })
  }
  return [base]
}

/* ------------------------------------------------------------------- 工具 */

function httpUrlOrThrow(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new Error('需要一个非空的 url')
  let url
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('网址格式无效，需要 http:// 或 https:// 开头的完整地址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`只允许 http/https，收到 ${url.protocol}`)
  }
  return url.toString()
}

/** 把工具返回值渲染成模型可读的文本块。 */
function renderValue(value) {
  if (typeof value === 'string') return value
  try {
    const text = JSON.stringify(value, null, 2)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

/**
 * 内核 `ctx.tools.register` 的硬性契约：每个工具**必须**声明 `output: { schema, render }`
 * （缺失时抛 TypeError：tool "x" must declare output { schema, render, presentationMeta? }）。
 * 这些工具的返回值是面板的原始回执，形态不固定，所以用「注释型 schema」（= 不受约束的 JSON）
 * 加统一文本渲染；返回值仍由内核做 lossless-JSON 快照，非法值会变成结构化错误。
 */
function rawJsonOutput() {
  return {
    schema: {},
    render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
  }
}

function registrationFailure(state) {
  return {
    registrationFailed: true,
    registrationError: state.registrationError,
    hint: '工具注册阶段抛错，通常是内核契约变化（如 output { schema, render } 必填）。修复 dsh-agent-browser/index.js 后重装并重启 DSH。',
  }
}

function registerTools(ctx, state) {
  ctx.tools.register({
    name: 'browser_panel',
    description:
      '查看 DSH 内置「受控浏览器」面板的状态：是否已连接、当前页面 URL/标题、受信白名单。任何浏览器操作前先调它确认面板已打开。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: rawJsonOutput(),
    async execute() {
      if (state.registrationError) return registrationFailure(state)
      return {
        panelConnected: panelConnected(state),
        lastPollSecondsAgo: state.lastPollAt === 0 ? null : Math.round((Date.now() - state.lastPollAt) / 1000),
        page: state.page,
        allowlist: state.allowlist,
        pendingCommands: state.commands.length,
      }
    },
  })
  state.panelToolRegistered = true

  ctx.tools.register({
    name: 'browser_open',
    description: state.policy === 'free'
      ? '在 DSH 内置受控浏览器里打开一个网页。当前「打开确认」已关闭（openPolicy=free），任意 http/https 网址都会直接打开。只支持 http/https。'
      : '在 DSH 内置受控浏览器里打开 http/https 网页。当前 openPolicy=confirm，白名单外的网址须在面板中由用户允许后才打开。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的完整网址，http:// 或 https:// 开头' },
      },
      required: ['url'],
    },
    output: rawJsonOutput(),
    async execute(args) {
      const url = httpUrlOrThrow(args?.url)
      // free 策略：直接放行（trusted=true 让面板跳过确认卡片）
      const allowed = state.policy === 'free' ? true : isAllowed(state.allowlist, url)
      const result = await enqueue(state, 'open', { url, trusted: allowed, policy: state.policy }, DEFAULT_TIMEOUT_MS)
      if (!result.ok) return result
      return {
        opened: true,
        url,
        wasTrusted: allowed,
        userApproved: result.value?.userApproved !== false,
        page: result.value?.page ?? null,
      }
    },
  })

  ctx.tools.register({
    name: 'browser_read',
    description:
      '读取 DSH 内置受控浏览器当前页面的内容：URL、标题、可见文本（截断）、可编辑元素清单（含代码编辑器），以及 forms（按题目表单分组的控件/单选/复选选项）、buttons（可点击按钮）、links（可打开链接）。password/file 等敏感字段只返回值长度、不回传明文。用于看题目、看输入框、看可点控件。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: rawJsonOutput(),
    async execute() {
      const result = await enqueue(state, 'read', {}, DEFAULT_TIMEOUT_MS)
      return result.ok ? result.value : result
    },
  })

  ctx.tools.register({
    name: 'browser_fill',
    description:
      '在 DSH 内置受控浏览器的输入框/代码编辑器里填写内容（支持 input/textarea/select/contenteditable/CodeMirror/Monaco/Ace，也支持同源 iframe 内的表单）。默认只填值，不回车、不点击、不提交。要点击页面控件时传 click:true（可点 radio、checkbox、button、链接，含提交按钮）——点击是显式动作，点提交按钮/链接后页面可能自行提交或跳转。password/file 等敏感字段不会被填写。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要填入的完整文本（可含换行）。click:true 时可选：radio 传选项值做校验；checkbox 不传 text 时点击切换，传字符串 true/false 指定勾选状态（已满足则 clicked:false）' },
        click: { type: 'boolean', description: 'true = 真实点击目标控件（radio/checkbox/button/a/submit 类 input），不填文本；默认 false = 只填文本、绝不点击。用 browser_read 返回的 selector + framePath 定位（按钮/链接没有 index）' },
        selector: { type: 'string', description: 'CSS 选择器；与 index 二选一。选择器必须唯一，否则会报错让你改用 index' },
        index: { type: 'number', description: '用 browser_read 返回的可编辑元素序号（从 0 开始，跨同源 iframe 的**全局扁平顺序**，与 read 完全一致）；与 selector 二选一' },
        framePath: {
          type: 'array',
          items: { type: 'number' },
          description: '可选：目标在同源 iframe 里时填 browser_read 返回的 framePath。配合 selector 时只在该 iframe 内查找；配合 index 时用作一致性校验（index 仍是全局序号）',
        },
        replace: { type: 'boolean', description: '是否先清空再填，默认 true' },
      },
      required: [],
    },
    output: rawJsonOutput(),
    async execute(args) {
      const click = args?.click === true
      const rawText = typeof args?.text === 'string' ? args.text : ''
      if (!click && rawText.length === 0) {
        throw new Error('text 不能为空（只想点击控件请传 click:true）')
      }
      const framePath =
        Array.isArray(args?.framePath) && args.framePath.every((item) => typeof item === 'number' && Number.isFinite(item))
          ? args.framePath.map((item) => Math.floor(item))
          : null
      const payload = {
        text: rawText,
        click,
        selector: typeof args.selector === 'string' && args.selector.length > 0 ? args.selector : null,
        index: typeof args.index === 'number' && Number.isFinite(args.index) ? Math.floor(args.index) : null,
        replace: args.replace !== false,
      }
      if (framePath !== null) payload.framePath = framePath
      if (payload.selector === null && payload.index === null) {
        throw new Error('需要 selector 或 index 之一（可先用 browser_read 看清单）')
      }
      const result = await enqueue(state, 'fill', payload, DEFAULT_TIMEOUT_MS)
      return result.ok ? result.value : result
    },
  })

  ctx.tools.register({
    name: 'browser_screenshot',
    description:
      '给 DSH 内置受控浏览器的当前页面截图，保存为 PNG 文件并返回路径（用于肉眼核对页面是否真的填对了）。注意：DSH 窗口最小化/被遮挡时 Electron 无法截图，会返回可操作的提示；请还原窗口、并让「AI 浏览器」标签在右侧栏前台后重试。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: rawJsonOutput(),
    async execute() {
      const result = await enqueue(state, 'screenshot', {}, DEFAULT_TIMEOUT_MS)
      if (!result.ok) return result
      const base64 = result.value?.base64
      if (typeof base64 !== 'string' || base64.length === 0) return { ok: false, error: '面板没有返回截图数据' }
      const shotDir = typeof state.shotDir === 'string' && state.shotDir.length > 0 ? state.shotDir : SHOTS_DIR
      ensureDir(shotDir)
      const file = join(shotDir, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
      writeFileSync(file, Buffer.from(base64, 'base64'))
      return { ok: true, path: file, bytes: Buffer.from(base64, 'base64').length, page: result.value?.page ?? null }
    },
  })

  ctx.tools.register({
    name: 'browser_allowlist',
    description: state.policy === 'free'
      ? '【已关闭】白名单与打开确认机制已停用（openPolicy=free）：任意 http/https 网址直接打开，不再需要确认。本工具只用于查看状态；如需恢复，请把 cordis.patch.yml 的 openPolicy 改为 confirm 并重启 DSH。'
      : '管理受控浏览器白名单（当前 openPolicy=confirm）：list 查看、add 添加、remove 删除规则。白名单外的网址打开前需要用户允许。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove'], description: '操作类型' },
        pattern: { type: 'string', description: 'add/remove 时的规则文本' },
      },
      required: ['action'],
    },
    output: rawJsonOutput(),
    async execute(args) {
      const action = args?.action
      const disabled = {
        disabled: true,
        policy: state.policy,
        patterns: state.allowlist,
        note: '白名单与打开确认已关闭（openPolicy=free）：任意 http/https 网址直接打开。改回 confirm 并重启 DSH 可恢复。',
      }
      if (state.policy === 'free') return disabled
      if (action === 'list') return { patterns: state.allowlist }
      const pattern = typeof args?.pattern === 'string' ? args.pattern.trim() : ''
      if (pattern.length === 0) throw new Error('需要 pattern')
      if (action === 'add') {
        const rule = normalizePattern(pattern)
        if (rule === null) throw new Error('规则无效：请填域名（如 example.com）或网址（https://…）')
        if (!state.allowlist.includes(pattern)) state.allowlist.push(pattern)
        saveAllowlist(state.allowlist)
        return { patterns: state.allowlist, added: pattern }
      }
      if (action === 'remove') {
        state.allowlist = state.allowlist.filter((item) => item !== pattern)
        saveAllowlist(state.allowlist)
        return { patterns: state.allowlist, removed: pattern }
      }
      throw new Error(`不支持的 action: ${String(action)}`)
    },
  })
}

/* ------------------------------------------------------------------- 入口 */

export function apply(ctx, config = {}) {
  const state = createState()
  // 打开策略：confirm = 白名单 + 用户确认（默认）；只有显式 free 才关闭
  state.policy = config.openPolicy === 'free' ? 'free' : 'confirm'
  // 门户点击桥生效的宿主后缀（默认不启用；配置后只在指定门户域上生效）
  if (Array.isArray(config.portalBridgeHosts) && config.portalBridgeHosts.length > 0) {
    state.portalHosts = config.portalBridgeHosts.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim().toLowerCase())
  }
  if (typeof config.shotDir === 'string' && config.shotDir.length > 0) {
    // 允许在 cordis.patch.yml 里改截图目录
    state.shotDir = config.shotDir
  }
  if (Array.isArray(config.allowlist)) {
    // 配置里的白名单与文件里的合并，便于一次性预置受信站点
    for (const item of config.allowlist) {
      if (typeof item === 'string' && item.trim().length > 0 && !state.allowlist.includes(item.trim())) {
        state.allowlist.push(item.trim())
      }
    }
    try {
      saveAllowlist(state.allowlist)
    } catch (error) {
      // 写不进去不影响本次运行：内存里的白名单仍然生效
      console.error(`[dsh-agent-browser] 预置白名单落盘失败：${error}`)
    }
  }
  // 路由与工具分别兜底：任何一边失败都不要让插件激活整体崩掉，也不要拖垮 DSH 启动
  try {
    ctx.inject(['webServer'], (scope) => {
      for (const route of routes(state)) {
        try {
          scope.effect(() => scope.webServer.register(route), `dsh-agent-browser: ${route.path}`)
        } catch (error) {
          console.error(`[dsh-agent-browser] 路由 ${route.path} 注册失败：${error}`)
        }
      }
    })
  } catch (error) {
    console.error(`[dsh-agent-browser] webServer 不可用，浏览器面板将无法连接：${error}`)
  }
  try {
    registerTools(ctx, state)
  } catch (error) {
    state.registrationError = String(error?.message ?? error)
    console.error(`[dsh-agent-browser] 工具注册失败：${error}`)
    // 「工具全消失且毫无线索」是最难查的故障（2026-10-18 真机上就发生过：内核要求每个工具声明
    // output { schema, render }，缺了会抛 TypeError，被这里吞掉，HTTP 路由却照常在线）。
    // 退化成只注册一个自检工具，让故障在页面上可见，而不是静默消失。
    // If browser_panel already registered, its execute() reports the saved failure.
    // DSH rejects duplicate names: do not try registering browser_panel a second time.
    if (!state.panelToolRegistered) try {
      ctx.tools.register({
        name: 'browser_panel',
        description:
          '【降级自检】受控浏览器插件的工具注册失败，本工具只回报失败原因。请把 registrationError 原样反馈给用户。',
        parameters: { type: 'object', properties: {}, required: [] },
        output: rawJsonOutput(),
        async execute() {
          return registrationFailure(state)
        },
      })
    } catch {
      /* 连自检工具都注册不上，只能留在控制台 */
    }
  }
  return state
}

/** 供自测脚本使用：不经过 cordis 也能验证核心逻辑。 */
export const internals = { normalizePattern, isAllowed, createState, enqueue, settle, routes, registerTools }
