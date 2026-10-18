/**
 * Client 半边契约 + 行为自测：不需要 DSH、不需要真浏览器。
 * 用假的 window.__ModuleLoader__ / React / fetch / document / dshDesktop 桥，
 * 真正把控制器跑起来，验证审查发现的高危点确实被修好：
 *   1. 加载协议与插槽注册（模块契约）；
 *   2. 白名单外必须用户同意，且未同意前绝不创建 webview、绝不 loadURL；
 *   3. webview 必须等 dom-ready 之后才 loadURL（Electron 硬要求）；
 *   4. 容器重挂载后 webview 会被重新 append（否则指令打在游离节点上）；
 *   5. bridge.release 返回 undefined 也不炸（清理路径健壮）；
 *   6. 第二条待确认请求会取代第一条，不让它永远悬在 Host 侧。
 *   node dsh-agent-browser/client-selftest.mjs
 */
import assert from 'node:assert/strict'

const pass = (name) => console.log(`PASS  ${name}`)
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

/* ---------------------------------------------------------- 环境假件 */

const fetchLog = []
let pollPayloads = []
let claimCount = 0
const json = (body) => ({ ok: true, status: 200, json: async () => body })
const TOKEN_B = 'token-b' // 只把假指令喂给「被测控制器」，避免步骤 1 的控制器抢走数据
/* 可调开关：供后面的高危项用例改行为 */
let claimConflict = 0 // >0 表示接下来的非强制 claim 返回 409（每次递减），用于验证自动接管
let reclaimFails = false // true 表示连 /reclaim 也 409（模拟令牌被另一个窗口牢牢占着）
let allowHosts = [] // /allowed 的判定依据（模拟 Host 白名单）
let resultFailures = 0 // /result 前 N 次返回 500，用于验证重传期间不重复执行
let pollPolicy = 'confirm' // Host 下发的打开策略：confirm = 白名单 + 确认；free = 全部关闭
let failCapture = false // true 时 capturePage 抛 Electron 的 UnknownVizError（模拟窗口最小化）

globalThis.window = { __ModuleLoader__: { load(definition) { globalThis.__loaded = definition } } }
// 缩放记忆用的 localStorage（真机上是 DSH 页面提供的），这里用内存版
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
}
globalThis.fetch = async (url, init = {}) => {
  const target = String(url)
  const method = init.method || 'GET'
  const token = (init.headers || {})['x-dsh-agent-browser-token']
  fetchLog.push({ url: target, method, token, body: init.body ? JSON.parse(init.body) : undefined })
  if (target.endsWith('/reclaim')) {
    if (reclaimFails) return { ok: false, status: 409, json: async () => ({ error: '令牌已被认领' }) }
    claimCount += 1
    claimConflict = 0
    return json({ token: TOKEN_B, allowlist: ['example.com'] })
  }
  if (target.endsWith('/claim')) {
    if (claimConflict > 0) {
      claimConflict -= 1
      return { ok: false, status: 409, json: async () => ({ error: '令牌已被认领' }) }
    }
    claimCount += 1
    return json({ token: claimCount === 1 ? 'token-a' : TOKEN_B, allowlist: ['example.com'] })
  }
  if (target.includes('/allowed')) {
    const asked = new URL(target, 'http://local').searchParams.get('url') || ''
    const allowed = allowHosts.some((host) => asked.includes(host))
    return json({ allowed })
  }
  if (target.includes('/poll')) {
    const commands = token === TOKEN_B ? pollPayloads.shift() || [] : []
    return json({ commands, allowlist: ['example.com'], policy: pollPolicy })
  }
  if (target.includes('/result')) {
    if (resultFailures > 0) {
      resultFailures -= 1
      return { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
    }
    return json({ settled: true })
  }
  return json({ patterns: [] })
}

const reactStub = {
  createElement: (...args) => ({ type: args[0], args }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
}
const requireStub = (name) => {
  if (name === 'react') return reactStub
  throw new Error('client.js 不应 require 其它模块，收到：' + name)
}

/* ------------------------------------------------- 1. 模块与插槽契约 */

await import('./client.js')
const loaded = globalThis.__loaded
assert.ok(loaded, 'client.js 必须调用 window.__ModuleLoader__.load()')
assert.equal(loaded.id, '@local/dsh-agent-browser', 'id 必须与 package.json 的 name 一致')
pass('模块加载协议：window.__ModuleLoader__.load({ id }) 且 id 等于包名')

const plugin = loaded.factory(requireStub)
assert.ok(plugin && typeof plugin.apply === 'function', 'factory 必须返回 { inject, apply }')
assert.deepEqual(plugin.inject, ['slots', 'sidebarRight', 'sidebarRightTabs'])
pass("factory 返回插件导出：inject = ['slots','sidebarRight','sidebarRightTabs'] + apply()")

const registrations = []
const tabTypes = []
const openTabCalls = []
const slotNames = []
const disposers = []
const ctx = {
  effect(fn, label) {
    const dispose = fn()
    const cleanup = typeof dispose === 'function' ? dispose : () => {}
    disposers.push(cleanup)
    return cleanup
  },
  sidebarRight: {
    openTab(kind, options) { openTabCalls.push({ kind, options }) },
  },
  sidebarRightTabs: {
    register(definition) { tabTypes.push(definition); return () => {} },
  },
  slots: {
    inject(name, callback) {
      slotNames.push(name)
      callback()
    },
    register(definition, component) {
      registrations.push({ definition, component })
      return () => {}
    },
  },
}
assert.deepEqual(plugin.inject, ['slots', 'sidebarRight', 'sidebarRightTabs'])
plugin.apply(ctx)
assert.equal(tabTypes.length, 1, '应注册 1 个侧栏标签类型')
const tabType = tabTypes[0]
assert.equal(tabType.id, '@local/dsh-agent-browser')
assert.equal(tabType.kind, 'agent-browser')
assert.equal(tabType.keepMounted, true, '收起侧栏后必须保住页面（guest 不能被销毁）')
assert.equal(typeof tabType.title, 'function')
assert.equal(tabType.title(), 'AI 浏览器')
assert.equal(tabType.guide.length, 1, '应给 guide 页一个手动入口')
assert.deepEqual(slotNames.sort(), ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])
const bodyReg = registrations.find((item) => item.definition.name === 'sidebar.right.pane.tab')
const titleReg = registrations.find((item) => item.definition.name === 'sidebar.right.pane.tab.title')
assert.ok(bodyReg, '应注册标签内容')
assert.equal(bodyReg.definition.key, tabType.id, '内容注册的 key 必须等于类型 id')
assert.equal(typeof bodyReg.component, 'function')
assert.ok(titleReg, '应注册标签标题（让页签跟随页面标题）')
assert.equal(titleReg.definition.key, tabType.id)
assert.equal(typeof titleReg.component, 'function')
pass('侧栏注册：标签类型 + 内容 + 标题（key = 类型 id，keepMounted）')

assert.equal(typeof globalThis.document, 'undefined', '加载与注册阶段不得触碰 document')
pass('加载与注册阶段不触碰 DOM')

// 停掉步骤 1 的控制器：它已在轮询，否则会抢走后面喂给被测控制器的假指令
// （不重置 claimCount：被测控制器是第二次认领，才能拿到 TOKEN_B 对应的假指令队列）
for (const dispose of disposers) dispose()
fetchLog.length = 0
await tick(20)

/* ------------------------------------------- 2. 真跑控制器（假 DOM/桥） */

function makeWebviewElement() {
  const handlers = new Map()
  return {
    attrs: {},
    calls: [],
    parentNode: null,
    removed: false,
    setAttribute(key, value) { this.attrs[key] = value },
    addEventListener(name, fn) {
      handlers.set(name, [...(handlers.get(name) || []), fn])
    },
    fire(name, event) {
      for (const fn of handlers.get(name) || []) fn(event || {})
    },
    loadURL(url) { this.calls.push(['loadURL', url]); return Promise.resolve() },
    isLoading() { return false },
    async executeJavaScript(code, gesture) {
      this.calls.push(['executeJavaScript', gesture, code])
      return { url: 'https://portal.example.com/problem/7', title: '三角形判断', text: '给定平面上任意三个点的坐标', editables: [] }
    },
    async capturePage() {
      this.calls.push(['capturePage'])
      if (failCapture) throw new Error("Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: UnknownVizError")
      return { toDataURL: () => 'data:image/png;base64,AAAA' }
    },
    // ---- 浏览器功能相关（缩放 / 导航 / 查找 / 停止）----
    zoomFactor: 1,
    navBack: false,
    navForward: false,
    setZoomFactor(factor) { this.zoomFactor = factor; this.calls.push(['setZoomFactor', factor]) },
    getZoomFactor() { return this.zoomFactor },
    canGoBack() { return this.navBack },
    canGoForward() { return this.navForward },
    goBack() { this.calls.push(['goBack']) },
    goForward() { this.calls.push(['goForward']) },
    reload() { this.calls.push(['reload']); return Promise.resolve() },
    stop() { this.calls.push(['stop']) },
    findInPage(text, options) { this.calls.push(['findInPage', text, options]) },
    stopFindInPage(action) { this.calls.push(['stopFindInPage', action]) },
    remove() {
      this.removed = true
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((item) => item !== this)
    },
  }
}
function makeContainer() {
  return { children: [], appendChild(element) { element.parentNode = this; this.children.push(element) } }
}
const bridgeCalls = { acquire: [], release: [], openRequested: [] }
let lastElement
globalThis.document = { createElement: (tag) => { assert.equal(tag, 'webview'); lastElement = makeWebviewElement(); return lastElement } }
globalThis.dshDesktop = {
  protocolVersion: 1,
  browser: {
    // 每次 acquire 都发新租约：模拟 DSH 主进程「一个租约只允许一次 attach」
    acquire: async (workspace) => {
      bridgeCalls.acquire.push(workspace)
      const index = bridgeCalls.acquire.length
      return { lease: 'lease-' + index, partition: 'part-' + index }
    },
    // 故意返回 undefined：验证清理路径不会因为 .catch 而抛错
    release: (lease) => { bridgeCalls.release.push(lease); return undefined },
    onOpenRequested: (lease, listener) => { bridgeCalls.openRequested.push({ lease, listener }); return () => {} },
  },
}

const controller = plugin.__createController()
const container = makeContainer()
controller.attach(container)

// 第一轮轮询就下发：两条白名单外 open + 一条受信 open
pollPayloads = [[
  { id: 'untrusted-1', kind: 'open', payload: { url: 'https://a.example/1', trusted: false } },
  { id: 'untrusted-2', kind: 'open', payload: { url: 'https://b.example/2', trusted: false } },
  { id: 'trusted-1', kind: 'open', payload: { url: 'https://app.trusted.example/3', trusted: true } },
]]
controller.start()
await tick(120)

// 2a. 同意门禁：白名单外不得 loadURL
assert.ok(controller.getState().consent, '白名单外必须进入待确认状态')
assert.equal(controller.getState().consent.url, 'https://b.example/2', '待确认的应是最后一条请求')
assert.equal(lastElement.calls.filter((call) => call[0] === 'loadURL').length, 0, '未确认前绝不能 loadURL')
assert.equal(
  lastElement.calls.filter((call) => call[0] === 'loadURL' && call[1] === 'https://b.example/2').length,
  0,
  '白名单外的地址在用户点「允许」之前绝不能加载',
)
pass('白名单外：未点「允许」前绝不加载该地址')

// 2b. 被取代的那条必须结束，不能悬在 Host 侧
const replaced = fetchLog.find((entry) => entry.url.includes('/result') && entry.body && entry.body.id === 'untrusted-1')
assert.ok(replaced, '被取代的请求必须回传结果')
assert.equal(replaced.body.ok, false)
assert.match(String(replaced.body.error), /被新的打开请求取代/)
pass('第二条待确认请求会取代第一条（Host 侧不会悬挂）')

// 2c. 受信请求：必须等 dom-ready 之后才 loadURL
assert.equal(container.children.length, 1, '受信请求应创建 webview')
assert.equal(lastElement.attrs.src, 'about:blank#lease-1', 'src 必须是 about:blank#<lease>（主进程校验）')
assert.equal(lastElement.attrs.partition, 'part-1')
// 2026-10-18 修正：必须声明 allowpopups。没有它，guest 里的 window.open / target=_blank 请求
// 根本到不了主进程的 setWindowOpenHandler，DSH「页面想开新窗口 → 转给面板」那条链永远不触发
//（真机症状：点门户入口这种 <a target=_blank> 毫无反应、window.open() 返回 null）。
// 官方侧栏浏览器同样设置了这一项；真正的弹窗仍被主进程 return { action: 'deny' } 拒绝，
// 只会把 URL 交回面板在当前标签内导航 —— 不存在「页面能自己开 OS 窗口」的风险。
assert.equal(lastElement.attrs.allowpopups, '', '必须声明 allowpopups（否则开新窗口的请求到不了主进程）')
assert.equal(lastElement.calls.filter((call) => call[0] === 'loadURL').length, 0, 'dom-ready 之前不得调用 loadURL')
pass('webview 建法正确，且 dom-ready 之前不调用 loadURL（Electron 硬要求）')

lastElement.fire('dom-ready')
await tick(80)
const loads = lastElement.calls.filter((call) => call[0] === 'loadURL')
assert.equal(loads.length, 1, 'dom-ready 之后应恰好加载一次')
assert.equal(loads[0][1], 'https://app.trusted.example/3')
pass('dom-ready 后才真正 loadURL，且只加载一次')

// 2c-2. 用户点「允许」之后，白名单外的地址才被加载
controller.allowConsent()
await tick(80)
const afterAllow = lastElement.calls.filter((call) => call[0] === 'loadURL')
assert.equal(afterAllow.length, 2, '允许后应再加载一次')
assert.equal(afterAllow[1][1], 'https://b.example/2', '允许后加载的必须是用户确认过的地址')
assert.equal(controller.getState().consent, null, '确认后待确认状态应清空')
pass('用户点「允许」后，白名单外地址才被加载')

// 2d. 容器重挂载：旧 guest 已被销毁，且 DSH 的租约只能 attach 一次 → 必须换新租约重建
const previousElement = lastElement
const freshContainer = makeContainer()
controller.attach(freshContainer)
pollPayloads = [[{ id: 'read-1', kind: 'read', payload: {} }]]
await tick(700) // 等下一轮轮询触发重建
assert.ok(bridgeCalls.release.includes('lease-1'), '旧租约必须被释放（一个租约只接受一次 attach）')
assert.equal(bridgeCalls.acquire.length, 2, '重建必须申请新租约')
const rebuilt = lastElement
assert.notEqual(rebuilt, previousElement, '必须创建新元素，不能复用已离开 DOM 的旧元素')
assert.ok(freshContainer.children.includes(rebuilt), '新 guest 要挂到当前容器')
rebuilt.fire('dom-ready')
await tick(250)
assert.ok(
  rebuilt.calls.some((call) => call[0] === 'loadURL' && String(call[1]).includes('portal.example.com')),
  '重建后要恢复原来的页面，而不是停在空白页',
)
pass('容器重挂载后：换新租约重建 guest，并恢复原页面')

// 2e. 指令执行使用 executeJavaScript 且不索取用户激活
const exec = rebuilt.calls.filter((call) => call[0] === 'executeJavaScript')
assert.ok(exec.length >= 1, 'read 指令应真正执行脚本')
assert.ok(exec.every((call) => call[1] === false), '不得用 userGesture=true 索取用户激活')
pass('执行脚本不索取用户激活（userGesture = false）')

// 2f. 弹窗 / 新窗口请求（target=_blank、window.open）：主进程拒绝弹窗但把 URL 交给我们
assert.ok(bridgeCalls.openRequested.length >= 1, '必须订阅 onOpenRequested')
const latestOpenRequested = bridgeCalls.openRequested[bridgeCalls.openRequested.length - 1]
const loadsBefore = rebuilt.calls.filter((call) => call[0] === 'loadURL').length
// 2f-1. 白名单外：拦下等用户决定，绝不能直接开页
latestOpenRequested.listener('https://popup.example/evil')
await tick(120)
assert.ok(controller.getState().windowRequest, '白名单外的弹窗请求应进入待确认状态')
assert.equal(controller.getState().windowRequest.url, 'https://popup.example/evil')
assert.equal(rebuilt.calls.filter((call) => call[0] === 'loadURL').length, loadsBefore, '未确认前不能加载弹窗目标')
// 2f-2. 用户点「在当前标签打开」后才加载
await controller.allowWindowRequest()
await tick(150)
assert.ok(
  rebuilt.calls.some((call) => call[0] === 'loadURL' && call[1] === 'https://popup.example/evil'),
  '用户允许后应在当前标签打开该链接',
)
assert.equal(controller.getState().windowRequest, null, '确认后待确认状态应清空')
// 2f-3. 白名单内的弹窗请求：直接在当前标签打开，不打扰用户
allowHosts = ['inapp.example']
const loadsBeforeTrustedPopup = rebuilt.calls.filter((call) => call[0] === 'loadURL').length
latestOpenRequested.listener('https://app.inapp.example/page')
await tick(200)
assert.equal(controller.getState().windowRequest, null, '白名单内的弹窗不应弹确认')
assert.ok(
  rebuilt.calls.some((call) => call[0] === 'loadURL' && call[1] === 'https://app.inapp.example/page'),
  '白名单内的弹窗应直接在当前标签打开',
)
assert.ok(rebuilt.calls.filter((call) => call[0] === 'loadURL').length > loadsBeforeTrustedPopup)
pass('弹窗/新窗口：白名单内自动接管，白名单外先拦下再由用户决定')

// 2g. 清理：release 返回 undefined 也不得抛错
controller.dispose()
assert.deepEqual(bridgeCalls.release, ['lease-1', 'lease-2'], 'dispose 应释放当前租约（旧租约重建时已释放）')
await tick(30)
pass('dispose 健壮：release 返回 undefined 也不抛错')

/* ---------------------- 3. 第二轮审查发现的高危项回归 ---------------------- */

// 3a. 令牌 409：启动阶段应自动接管一次，面板不能永久失联
claimConflict = 1
const controller2 = plugin.__createController()
controller2.attach(makeContainer())
pollPayloads = [[]]
controller2.start()
await tick(150)
assert.equal(controller2.getState().claimed, true, '409 后应自动接管并成功认领')
assert.equal(controller2.getState().connected, true, '接管后应恢复轮询')
const reclaims = fetchLog.filter((entry) => entry.url.endsWith('/reclaim')).length
assert.equal(reclaims, 1, '自动接管只做一次，避免多窗口互相抢令牌')
pass('令牌 409：启动阶段自动接管一次并恢复连接')
controller2.dispose() // 必须停掉，否则它继续轮询会抢走后面用例的假指令

// 3b. 连强制认领都失败时：给出可点的恢复提示（面板里有「强制重新认领」按钮），不能假装在重连
claimConflict = 5
reclaimFails = true
const controller3 = plugin.__createController()
controller3.attach(makeContainer())
controller3.start()
await tick(150)
assert.equal(controller3.getState().claimed, false)
assert.match(String(controller3.getState().notice), /强制重新认领/)
pass('持续 409 时给出「强制重新认领」提示（按钮已加在面板上）')
controller3.dispose()
reclaimFails = false

// 3c. 跳转守卫：页面自己跳到白名单外必须被拦下，且不静默放行
allowHosts = ['portal.example.com']
const controller4 = plugin.__createController()
const container4 = makeContainer()
controller4.attach(container4)
pollPayloads = [[{ id: 'trusted-9', kind: 'open', payload: { url: 'https://portal.example.com/p/7', trusted: true } }]]
controller4.start()
await tick(150)
const element4 = lastElement
element4.fire('dom-ready')
await tick(120)
assert.equal(element4.calls.filter((call) => call[0] === 'loadURL').length, 1, '白名单内打开应正常加载')
element4.fire('did-navigate', { url: 'https://evil.example/steal' })
await tick(150)
assert.ok(controller4.getState().blockedRedirect, '白名单外跳转必须被拦下')
assert.equal(controller4.getState().blockedRedirect.url, 'https://evil.example/steal')
assert.ok(
  element4.calls.some((call) => call[0] === 'loadURL' && call[1] === 'about:blank'),
  '应把页面踢回 about:blank 而不是停在外站',
)
pass('跳转守卫：页面自行跳到白名单外会被拦下并踢回空白页')

// 3d. 用户点「允许并继续」后才真正去那个外站
await controller4.allowRedirect()
await tick(150)
assert.equal(controller4.getState().blockedRedirect, null)
assert.ok(
  element4.calls.some((call) => call[0] === 'loadURL' && call[1] === 'https://evil.example/steal'),
  '用户允许后才加载该地址',
)
pass('用户点「允许并继续」后才加载被拦下的地址')
controller4.dispose()

// 3e. 结果重传期间不得重复执行同一条指令
resultFailures = 2
const controller5 = plugin.__createController()
const container5 = makeContainer()
controller5.attach(container5)
pollPayloads = [[{ id: 'read-retry', kind: 'read', payload: {} }], [{ id: 'read-retry', kind: 'read', payload: {} }]]
controller5.start()
await tick(200) // 让控制器建好 webview（此时在等 dom-ready）
const element5 = lastElement
element5.fire('dom-ready')
await tick(120)
// 只统计「读页面」脚本的调用（dom-ready 注入的按键桥也会走 executeJavaScript，不能算进来）
const countRead = () =>
  element5.calls.filter(
    (call) => call[0] === 'executeJavaScript' && typeof call[2] === 'string' && call[2].includes('editables'),
  ).length
assert.equal(countRead(), 1, '指令应执行一次')
await tick(400) // 处于结果重传窗口内，Host 会再次下发同一 id
assert.equal(countRead(), 1, '重传期间同一条指令不得被重复执行')
pass('结果重传期间同一条指令不重复执行（inFlight 在重试结束后才释放）')
controller5.dispose()

/* ---------------------- 4. 侧栏标签页：按需自动打开 ---------------------- */

const controller6 = plugin.__createController()
let needContainerCalls = 0
controller6.setNeedContainerHook(() => { needContainerCalls += 1 })
pollPayloads = [[{ id: 'auto-open', kind: 'read', payload: {} }]]
controller6.start()
await tick(400)
assert.ok(needContainerCalls >= 1, '没有容器时应请求打开侧栏标签')
const beforeAttach = fetchLog.filter((entry) => entry.url.includes('/result') && entry.body && entry.body.id === 'auto-open')
assert.equal(beforeAttach.length, 0, '容器没出现前不能假装指令已完成')

// 模拟侧栏此时才把标签内容挂载出来
controller6.attach(makeContainer())
await tick(250)
lastElement.fire('dom-ready')
await tick(200)
const autoResult = fetchLog.filter((entry) => entry.url.includes('/result') && entry.body && entry.body.id === 'auto-open')
assert.equal(autoResult.length, 1, '容器一出现指令就应继续执行')
assert.equal(autoResult[0].body.ok, true)
pass('标签页没开时会先自动请求打开，容器一出现就继续执行')
controller6.dispose()

/* ---------------------- 5. 浏览器必备功能：缩放/导航/查找/加载态 ---------------------- */

const controller7 = plugin.__createController()
controller7.attach(makeContainer())
pollPayloads = [[{ id: 'read-tools', kind: 'read', payload: {} }]]
controller7.start()
await tick(200)
const element7 = lastElement
element7.navBack = true
element7.fire('dom-ready')
await tick(150)

// 5a. 缩放：默认 100%，加减、重置、上下限、并落到 guest 上
assert.equal(controller7.getState().zoom, 1, '默认缩放应为 100%')
controller7.zoomIn()
const zoomedIn = controller7.getState().zoom
assert.ok(zoomedIn > 1, '放大后应大于 100%')
assert.ok(element7.calls.some((call) => call[0] === 'setZoomFactor' && call[1] === zoomedIn), '缩放必须真正应用到 guest')
controller7.zoomOut()
assert.equal(controller7.getState().zoom, 1, '缩小应回到 100%')
for (let i = 0; i < 30; i += 1) controller7.zoomIn()
assert.equal(controller7.getState().zoom, 3, '放大上限 300%')
controller7.setZoom(0.05)
assert.equal(controller7.getState().zoom, 0.25, '缩小下限 25%')
controller7.resetZoom()
assert.equal(controller7.getState().zoom, 1, '重置回 100%')
pass('缩放：加减 / 重置 / 25%–300% 夹取 / 真正下发到 webview')

// 5b. 缩放记忆（localStorage）
controller7.setZoom(1.5)
assert.equal(storage.get('dsh-agent-browser:zoom'), '1.5', '缩放比例要记住，下次打开沿用')
const controller8 = plugin.__createController()
assert.equal(controller8.getState().zoom, 1.5, '新控制器应恢复上次的缩放比例')
controller8.dispose()
controller7.resetZoom()
pass('缩放记忆：写入 localStorage，新会话沿用')

// 5c. 前进/后退可用状态跟随导航事件
assert.equal(controller7.getState().canGoBack, true, 'canGoBack 应跟随 guest 报告')
element7.navForward = true
element7.fire('did-navigate-in-page', { isMainFrame: true })
await tick(30)
assert.equal(controller7.getState().canGoForward, true, 'canGoForward 应跟随 guest 报告')
controller7.back()
controller7.forward()
assert.ok(element7.calls.some((call) => call[0] === 'goBack'))
assert.ok(element7.calls.some((call) => call[0] === 'goForward'))
pass('前进/后退：按钮可用态与动作都正确')

// 5d. 停止加载 + 加载态
element7.fire('did-start-loading')
await tick(20)
assert.equal(controller7.getState().loading, true, '开始加载时应显示加载态')
controller7.stop()
assert.ok(element7.calls.some((call) => call[0] === 'stop'), '停止应下发到 guest')
element7.fire('did-stop-loading')
await tick(20)
assert.equal(controller7.getState().loading, false, '加载结束应清除加载态')
pass('加载态与停止加载')

// 5e. 页面内查找
controller7.openFind()
assert.equal(controller7.getState().find.open, true)
controller7.find('主函数')
const findCall = element7.calls.filter((call) => call[0] === 'findInPage').pop()
assert.equal(findCall[1], '主函数')
assert.equal(findCall[2].findNext, false)
element7.fire('found-in-page', { result: { matches: 5, activeMatchOrdinal: 2 } })
await tick(30)
assert.equal(controller7.getState().find.matches, 5)
assert.equal(controller7.getState().find.active, 2)
controller7.findNext(false)
const nextCall = element7.calls.filter((call) => call[0] === 'findInPage').pop()
assert.equal(nextCall[2].findNext, true)
assert.equal(nextCall[2].forward, false)
controller7.closeFind()
assert.ok(element7.calls.some((call) => call[0] === 'stopFindInPage' && call[1] === 'clearSelection'), '关闭查找要清掉高亮')
assert.equal(controller7.getState().find.open, false)
pass('页面内查找：查找 / 上一个 / 下一个 / 匹配计数 / 关闭清高亮')

// 5f. guest 内快捷键桥：焦点在网页里时，按键经 console 通道回传后照样生效
const bridgeInjected = element7.calls.find(
  (call) => call[0] === 'executeJavaScript' && typeof call[2] === 'string' && call[2].includes('__dshAgentBrowserKeyBridge'),
)
assert.ok(bridgeInjected, 'dom-ready 之后应把按键桥注入 guest')
const zoomBeforeShortcut = controller7.getState().zoom
element7.fire('console-message', { message: '[dsh-agent-browser:key]zoom-in' })
await tick(20)
assert.ok(controller7.getState().zoom > zoomBeforeShortcut, '网页里按 Ctrl+ 应放大')
element7.fire('console-message', { details: { message: '[dsh-agent-browser:key]find' } })
await tick(20)
assert.equal(controller7.getState().find.open, true, '网页里按 Ctrl+F 应打开查找栏（兼容新 Electron 事件形态）')
element7.fire('console-message', { message: '[dsh-agent-browser:key]reload' })
await tick(20)
assert.ok(element7.calls.some((call) => call[0] === 'reload'), '网页里按 Ctrl+R 应刷新')
element7.fire('console-message', { message: '[dsh-agent-browser:key]unknown-action' })
await tick(10) // 未知动作只忽略，不能抛错
pass('guest 内快捷键桥：Ctrl +/-/0、Ctrl+F、Ctrl+R 在网页里也生效')

controller7.dispose()

/* ---------------------- 6. 审计 P1 回归 ---------------------- */

// 6a. P1-1：标签页未打开时，白名单外 open 也必须请求打开标签（否则确认卡片没有容器，Host 干等 180s）
const controller9 = plugin.__createController()
let needContainerCalls9 = 0
controller9.setNeedContainerHook(() => { needContainerCalls9 += 1 })
controller9.start()
await tick(550)
pollPayloads = [[{ id: 'untrusted-no-container', kind: 'open', payload: { url: 'https://new-site.example/', trusted: false } }]]
await tick(650)
assert.ok(needContainerCalls9 >= 1, '白名单外 open 必须请求打开侧栏标签')
assert.ok(controller9.getState().consent, '确认状态应已建立（卡片有地方渲染）')
pass('P1-1：标签未打开时白名单外 open 会拉起标签（确认卡片可见）')
controller9.dispose()

// 6b. P1-2：并发 ensureWebview 只能建一个 guest（单租约、单元素）
allowHosts = ['portal.example.com']
const acquiresBefore = bridgeCalls.acquire.length
const controller10 = plugin.__createController()
const container10 = makeContainer()
controller10.attach(container10)
controller10.start()
await tick(550)
pollPayloads = [[
  { id: 'concurrent-1', kind: 'read', payload: {} },
  { id: 'concurrent-2', kind: 'read', payload: {} },
]]
await tick(650)
assert.equal(bridgeCalls.acquire.length - acquiresBefore, 1, '并发指令只应申请一次租约')
assert.equal(container10.children.length, 1, '只应存在一个 webview 元素')
const element10 = lastElement
element10.fire('dom-ready')
await tick(250)
pass('P1-2：并发指令共用一次创建（单租约、单 webview）')
controller10.dispose()

// 6c. P1-3：生成给 guest 的脚本语法合法，且覆盖同源 iframe
assert.doesNotThrow(() => new Function(plugin.__scripts.READ_SRC), 'READ_SRC 必须是合法脚本')
assert.doesNotThrow(() => new Function(plugin.__scripts.fillSrc({ text: 'x', index: 0 })), 'fillSrc 必须是合法脚本')
assert.doesNotThrow(() => new Function(plugin.__scripts.KEY_BRIDGE_SRC), '按键桥必须是合法脚本')
assert.ok(plugin.__scripts.READ_SRC.includes('contentDocument'), 'READ_SRC 应遍历同源 iframe')
assert.ok(plugin.__scripts.READ_SRC.includes('framePath'), 'READ_SRC 应返回 framePath')
assert.ok(plugin.__scripts.fillSrc({ text: 'x', index: 0, framePath: [0] }).includes('framePath'), 'fillSrc 应支持 framePath')
const fillClickSrc = plugin.__scripts.fillSrc({ click: true, selector: '#submitBtn' })
assert.doesNotThrow(() => new Function(fillClickSrc), 'click:true 的 fillSrc 必须是合法脚本')
assert.ok(fillClickSrc.includes('payload.click'), 'fillSrc 应支持显式 click 参数')
assert.ok(fillClickSrc.includes('disabled'), 'fillSrc 应拒绝 disabled 控件')
assert.ok(plugin.__scripts.READ_SRC.includes('sensitiveTypes'), 'READ_SRC 应对敏感字段做处理')
assert.ok(plugin.__scripts.READ_SRC.includes("'password'"), 'READ_SRC 的敏感类型里应含 password')
assert.doesNotThrow(() => new Function(plugin.__scripts.navBridgeSrc(['example.com'])), '门户桥脚本必须合法')
assert.ok(plugin.__scripts.navBridgeSrc(['example.com']).includes('prepareHtml'), '门户桥应准备显式继续表单')
pass('guest 脚本语法/接口契约（iframe 实际读填由 guest-dom-selftest 验证）')

/* ---------------------- 7. free 策略：关闭白名单与打开确认 ---------------------- */

pollPolicy = 'free'
const controller11 = plugin.__createController()
const container11 = makeContainer()
controller11.attach(container11)
pollPayloads = [[{ id: 'free-open', kind: 'open', payload: { url: 'https://never-trusted.example/x', trusted: false } }]]
const allowedCallsBefore = fetchLog.filter((entry) => entry.url.includes('/allowed')).length
controller11.start()
await tick(600)
const element11 = lastElement
element11.fire('dom-ready')
await tick(250)
assert.equal(controller11.getState().policy, 'free', '必须采用 Host 下发的 free 策略')
assert.equal(controller11.getState().consent, null, 'free 策略下不应弹确认卡片')
assert.ok(
  element11.calls.some((call) => call[0] === 'loadURL' && call[1] === 'https://never-trusted.example/x'),
  'free 策略下白名单外地址也应直接加载',
)
pass('free 策略：白名单外地址直接打开，不弹确认')

// 落地页跳转也不再拦截（不查 /allowed、不踢回空白页）
element11.fire('did-navigate', { url: 'https://some-other.example/landing' })
await tick(250)
const allowedCallsAfter = fetchLog.filter((entry) => entry.url.includes('/allowed')).length
assert.equal(allowedCallsAfter, allowedCallsBefore, 'free 策略下跳转不应再查白名单接口')
assert.equal(controller11.getState().blockedRedirect, null, 'free 策略下不应拦跳转')
assert.equal(
  element11.calls.filter((call) => call[0] === 'loadURL' && call[1] === 'about:blank' && call[2] === 'blocked').length,
  0,
)
pass('free 策略：页面自行跳转也不再拦截')

// 门户点击桥：window.open 被接管后回传的地址，应在当前标签打开
element11.fire('console-message', { message: '[dsh-agent-browser:nav]{"action":"navigate","url":"https://portal.example.com/problem/7"}' })
await tick(250)
assert.ok(
  element11.calls.some((call) => call[0] === 'loadURL' && call[1] === 'https://portal.example.com/problem/7'),
  '门户链接应在当前标签打开（修「点门户入口没反应」）',
)
pass('门户点击桥：window.open 回传的地址在当前标签打开')
controller11.dispose()
pollPolicy = 'confirm'

/* ---------------------- 8. 截图失败的可操作提示 ---------------------- */
// 真机现象：DSH 窗口最小化时 Electron capturePage 抛 UnknownVizError，
// 旧代码把原始错误直接回传；现在要先重试一次，再给「还原窗口/切到标签」的中文提示。
failCapture = true
const controller12 = plugin.__createController()
const container12 = makeContainer()
controller12.attach(container12)
controller12.start()
await tick(550)
pollPayloads = [[{ id: 'shot-minimized', kind: 'screenshot', payload: {} }]]
await tick(650)
const element12 = lastElement
element12.fire('dom-ready')
await tick(900)
const shotResult = fetchLog.filter((entry) => entry.url.includes('/result')).pop()
assert.ok(shotResult && shotResult.body, '应回传截图结果')
assert.equal(shotResult.body.ok, false, '截图失败必须 ok:false')
assert.equal(shotResult.body.id, 'shot-minimized', '必须检查本条截图命令的回执')
assert.equal(element12.calls.filter((call) => call[0] === 'capturePage').length, 2, '截图必须失败后重试一次')
assert.match(String(shotResult.body.error), /最小化|被遮挡|还原 DSH 窗口/, '截图失败必须给出可操作的中文提示，不能只回原始 Electron 错误')
pass('截图失败：最小化/遮挡时给可操作提示（不再裸露 UnknownVizError）')
controller12.dispose()
failCapture = false

console.log('\n客户端契约 + 行为自测全部通过 ✅（真实 Electron webview 仍需装进 DSH 后验证）')
process.exit(0)
