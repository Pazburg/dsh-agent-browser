/**
 * Host 半边自测：不依赖 DSH、不需要安装，直接跑真实 HTTP 路由 + 模拟面板。
 *   node dsh-agent-browser/selftest.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离数据目录，避免污染真实的 ~/.dsh/agent-browser
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dab-selftest-'))

const mod = await import('./index.js')
const { internals } = mod
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
const pass = (name) => console.log(`PASS  ${name}`)

/* 1. 规则归一化与匹配 ------------------------------------------------ */
assert.equal(internals.normalizePattern('example.com'), 'host:example.com')
assert.equal(internals.normalizePattern('*.example.com'), 'host:example.com')
assert.equal(internals.normalizePattern('https://portal.example.com/problem'), 'url:https://portal.example.com/problem')
assert.equal(internals.normalizePattern('这不是域名'), null)
assert.equal(internals.normalizePattern(''), null)
assert.ok(internals.isAllowed(['example.com'], 'https://portal.example.com/x?y=1'), '域名规则应覆盖子域')
assert.ok(!internals.isAllowed(['example.com'], 'https://other.example.net/'), '不同域名不应命中')
assert.ok(!internals.isAllowed(['example.com'], 'https://notexample.com.evil.com/'), '后缀伪装不应命中')
assert.ok(internals.isAllowed(['https://a.com/solve'], 'https://a.com/solve/1'), 'url 规则按前缀命中')
assert.ok(!internals.isAllowed(['https://a.com/solve'], 'https://a.com/other'), 'url 规则不越界')
assert.ok(!internals.isAllowed(['https://example.com'], 'https://example.com.evil.com/x'), 'url 规则不得跨源（子域伪装）')
assert.ok(!internals.isAllowed(['https://example.com'], 'https://example.com:8443/x'), 'url 规则不得跨端口')
assert.ok(internals.isAllowed(['https://example.com'], 'https://example.com/any/path'), '仅 origin 的 url 规则应命中同源任意路径')
pass('白名单规则（域名/子域/网址前缀/伪装域名/跨源 URL 规则）')

/* 2. 组装：假 ctx ---------------------------------------------------- */
const tools = new Map()
const routes = []
/**
 * 复刻内核 @deepseek-ai/dsh-tools 的 register() 前置校验。
 * 真实内核要求每个工具声明 output { schema, render }，缺失就抛 TypeError；
 * 插件里那条 register 调用被 try/catch 包着，所以这类错误在真机上会**静默**丢掉全部工具。
 * 假 ctx 必须同样严格，否则测试永远是「通过」的假绿。
 */
function assertKernelToolContract(def) {
  const name = def?.name
  const output = def?.output
  if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function') {
    throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
  }
  if (output.schema === undefined || output.schema === null || typeof output.schema !== 'object') {
    throw new TypeError(`tool "${name}" output.schema must be an object`)
  }
  if (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function') {
    throw new TypeError(`tool "${name}" output.presentationMeta must be a function`)
  }
  if (typeof def.description !== 'string' || def.description.length === 0) {
    throw new TypeError(`tool "${name}" must declare a description`)
  }
  if (typeof def.execute !== 'function') throw new TypeError(`tool "${name}" must declare execute`)
  return def
}
const ctx = {
  tools: { register(def) { tools.set(def.name, assertKernelToolContract(def)) } },
  inject(_names, cb) {
    cb({ effect: (fn) => fn(), webServer: { register(route) { routes.push(route); return () => {} } } })
  },
}
// 现有用例覆盖「确认机制」；free 策略单独在第 9 节验证
const state = mod.apply(ctx, { allowlist: ['trusted.example'], openPolicy: 'confirm' })
assert.equal(tools.size, 6, '应注册 6 个工具')
assert.equal(routes.length, 1, '应注册 1 条路由')
const names = [...tools.keys()].sort()
assert.deepEqual(names, ['browser_allowlist', 'browser_fill', 'browser_open', 'browser_panel', 'browser_read', 'browser_screenshot'])
assert.ok(!names.some((n) => /click|submit|press|key/i.test(n)), '不得存在独立的点击/按键/提交类工具')
pass(`工具集固定为 ${names.length} 个：点击能力通过 browser_fill.click 显式提供，没有独立的 click/submit 工具`)

// 内核契约回归：每个工具都必须声明 output { schema, render }，render 必须能产出文本块。
// 这正是 2026-10-18 真机「路由在线但 6 个工具全部消失」的根因：缺 output 时 register 抛 TypeError，
// 被插件里的 try/catch 吞掉。假 ctx 现在按内核规则校验，这条断言防止再次退化。
for (const [toolName, def] of tools) {
  assert.equal(typeof def.output.render, 'function', `${toolName} 缺少 output.render`)
  const blocks = def.output.render({}, { demo: true })
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${toolName}.output.render 应返回非空内容块`)
  assert.ok(
    blocks.every((b) => b && typeof b.type === 'string' && typeof b.text === 'string'),
    `${toolName}.output.render 应返回 { type, text } 文本块`,
  )
}
pass('内核契约：6 个工具都声明了 output { schema, render }，render 可产出文本块')

// 能力契约：点击必须是 browser_fill 的显式参数（模型能看到），且描述要讲清「默认只填、不点击」；
// read 描述要提到 forms/buttons 和敏感字段脱敏，否则新会话的模型根本不知道这些能力。
{
  const fillTool = tools.get('browser_fill')
  const clickSchema = fillTool.parameters?.properties?.click
  assert.ok(clickSchema && clickSchema.type === 'boolean', 'browser_fill 必须声明 click: boolean 参数')
  assert.ok(/click:true/.test(fillTool.description), 'browser_fill 描述必须说明 click:true 的用法')
  assert.ok(/不点击|只填文本|只填值/.test(fillTool.description), 'browser_fill 描述必须说明默认不点击')
  assert.deepEqual(fillTool.parameters.required, [], 'text 不应再是必填（click:true 时可以不填文本）')
  const readTool = tools.get('browser_read')
  assert.ok(/forms/.test(readTool.description) && /buttons/.test(readTool.description), 'browser_read 描述必须提到 forms/buttons')
  assert.ok(/敏感|password/i.test(readTool.description), 'browser_read 描述必须说明敏感字段脱敏')
}
pass('能力契约：click 是 browser_fill 的显式参数，工具描述对模型可发现')

/* 3. 起真实 HTTP 服务，走真实路由 ------------------------------------ */
const server = createServer(routes[0].handler)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/dsh-agent-browser`
let token = ''
const call = (path, init = {}) =>
  fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-dsh-agent-browser-token': token } : {}), ...(init.headers || {}) },
  })

assert.equal((await call('/poll')).status, 403, '无令牌必须 403')
const claim = await (await fetch(base + '/claim', { method: 'POST' })).json()
token = claim.token
assert.ok(typeof token === 'string' && token.length > 0)
assert.equal((await fetch(base + '/claim', { method: 'POST' })).status, 409, '重复认领必须 409')
pass('路由令牌：未授权 403、首次认领成功、重复认领 409')

/* 4. 面板未在线 → 工具快速失败 ---------------------------------------- */
assert.equal((await tools.get('browser_panel').execute({})).panelConnected, false)
const early = await tools.get('browser_open').execute({ url: 'https://foo.example/x' })
assert.equal(early.ok, false)
assert.equal(early.panelMissing, true)
pass('面板未打开时，工具立刻给出可操作的提示而不是干等')

/* 5. 面板上线：轮询 + 指令往返 ---------------------------------------- */
const seen = new Set()
async function pollPanel() {
  const body = await (await call('/poll')).json()
  return (body.commands || []).filter((command) => !seen.has(command.id))
}
async function finish(id, ok, value, error) {
  seen.add(id)
  await call('/result', { method: 'POST', body: JSON.stringify({ id, ok, value, error, page: { url: 'https://portal.example.com/p', title: '样例页' } }) })
}
const status = await (async () => {
  await call('/poll') // 面板的第一次心跳
  return tools.get('browser_panel').execute({})
})()
assert.equal(status.panelConnected, true, '有心跳后应算在线')
pass('面板心跳后状态转为在线')

// 5a. 白名单外的打开：需要用户同意（Host 只排队，等面板结果）
let pending = tools.get('browser_open').execute({ url: 'https://portal.example.com/problem/7' })
await tick()
let commands = await pollPanel()
assert.equal(commands.length, 1)
assert.equal(commands[0].kind, 'open')
assert.equal(commands[0].payload.trusted, false, '白名单外必须标记为需要确认')
await finish(commands[0].id, true, { userApproved: true, page: { url: commands[0].payload.url, title: '样例页' } })
let opened = await pending
assert.equal(opened.opened, true)
assert.equal(opened.wasTrusted, false)
assert.equal(opened.userApproved, true)
pass('白名单外打开：Host 标记需确认，用户允许后才打开')

// 5b. 用户拒绝
pending = tools.get('browser_open').execute({ url: 'https://evil.example/' })
await tick()
commands = await pollPanel()
await finish(commands[0].id, false, undefined, '用户拒绝了这次打开请求')
opened = await pending
assert.equal(opened.ok, false)
assert.ok(String(opened.error).includes('拒绝'))
pass('用户拒绝时不打开，并把原因回传给 Agent')

// 5c. 白名单内的打开：直接放行
pending = tools.get('browser_open').execute({ url: 'https://app.trusted.example/page' })
await tick()
commands = await pollPanel()
assert.equal(commands[0].payload.trusted, true, '白名单内不需要确认')
await finish(commands[0].id, true, { userApproved: true, page: { url: commands[0].payload.url, title: '受信页' } })
opened = await pending
assert.equal(opened.wasTrusted, true)
pass('白名单内打开：不再弹确认框')

// 5d. 读页面
pending = tools.get('browser_read').execute({})
await tick()
commands = await pollPanel()
assert.equal(commands[0].kind, 'read')
await finish(commands[0].id, true, { url: 'https://portal.example.com/p', title: '第7题', text: '三角形判断', editables: [{ index: 0, kind: 'textarea', selector: '#code' }] })
const read = await pending
assert.equal(read.title, '第7题')
assert.equal(read.editables[0].selector, '#code')
pass('读页面：URL/标题/正文/可编辑元素清单都能回传')

// 5e. 填写
pending = tools.get('browser_fill').execute({ index: 0, text: 'int main(void){return 0;}' })
await tick()
commands = await pollPanel()
assert.equal(commands[0].kind, 'fill')
assert.equal(commands[0].payload.replace, true)
await finish(commands[0].id, true, { ok: true, kind: 'textarea', valueLength: 27, submitted: false })
const filled = await pending
assert.equal(filled.submitted, false, '填写绝不能触发提交')
pass('填写：只写值，返回 submitted:false')

// 5e-1. 显式点击：click:true 必须透传给 Client，且此时 text 不再是必填
pending = tools.get('browser_fill').execute({ click: true, selector: '#submitBtn' })
await tick()
commands = await pollPanel()
assert.equal(commands[0].kind, 'fill')
assert.equal(commands[0].payload.click, true, 'click:true 必须原样透传给 Client')
assert.equal(commands[0].payload.text, '')
assert.equal(commands[0].payload.selector, '#submitBtn')
await finish(commands[0].id, true, { ok: true, kind: 'click', clicked: true, submitted: false })
const clickResult = await pending
assert.equal(clickResult.kind, 'click')
pass('点击：browser_fill(click:true) 显式透传，且不要求 text')

// 5e-2. 同源 iframe：framePath 必须透传给 Client
pending = tools.get('browser_fill').execute({ index: 0, framePath: [0, 1], text: 'iframe-text' })
await tick()
commands = await pollPanel()
assert.equal(commands[0].kind, 'fill')
assert.deepEqual(commands[0].payload.framePath, [0, 1], 'framePath 必须原样透传')
assert.equal(commands[0].payload.index, 0)
await finish(commands[0].id, true, { ok: true, kind: 'textarea', framePath: [0, 1], submitted: false })
await pending
pass('填写：同源 iframe 的 framePath 正确透传')

// 5f. 缺少定位参数必须报错，不会瞎填
await assert.rejects(() => tools.get('browser_fill').execute({ text: 'abc' }), /selector 或 index/)
pass('填写缺少目标时直接报错')

// 5g. 截图落盘
const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
pending = tools.get('browser_screenshot').execute({})
await tick()
commands = await pollPanel()
assert.equal(commands[0].kind, 'screenshot')
await finish(commands[0].id, true, { base64: png1x1, page: { url: 'https://x', title: 'y' } })
const shot = await pending
assert.equal(shot.ok, true)
assert.ok(existsSync(shot.path), '截图文件应落盘')
const bytes = readFileSync(shot.path)
assert.equal(bytes.length, Buffer.from(png1x1, 'base64').length)
assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG', '应是合法 PNG 头')
pass('截图：面板回传 base64 → Host 落盘为 PNG')

// 5h. Execute the timeout path with an injected 25ms deadline, including queue cleanup.
const timedOut = await internals.enqueue(state, 'read', {}, 25)
assert.equal(timedOut.ok, false)
assert.match(timedOut.error, /没有结果/)
assert.equal(state.pending.size, 0)
assert.equal(state.commands.length, 0)
pass('超时保护真实执行：25ms 注入超时后 pending/commands 清空（默认 180s 未等满）')

/* 6. 白名单工具 ------------------------------------------------------ */
let list = await tools.get('browser_allowlist').execute({ action: 'list' })
assert.ok(list.patterns.includes('trusted.example'))
list = await tools.get('browser_allowlist').execute({ action: 'add', pattern: 'example.com' })
assert.ok(list.patterns.includes('example.com'))
await assert.rejects(() => tools.get('browser_allowlist').execute({ action: 'add', pattern: '!!!' }), /规则无效/)
list = await tools.get('browser_allowlist').execute({ action: 'remove', pattern: 'example.com' })
assert.ok(!list.patterns.includes('example.com'))
pass('白名单工具：list / add / remove / 非法规则拒绝')

/* 7. 面板侧白名单编辑（HTTP） ---------------------------------------- */
const added = await (await call('/allowlist', { method: 'POST', body: JSON.stringify({ action: 'add', pattern: 'example.org' }) })).json()
assert.ok(added.patterns.includes('example.org'))
const fetched = await (await call('/allowlist')).json()
assert.ok(fetched.patterns.includes('example.org'))
await call('/allowlist', { method: 'POST', body: JSON.stringify({ action: 'remove', pattern: 'example.org' }) })
pass('面板侧白名单增删（持久化到 allowlist.json）')

/* 7b. 落地页复核接口（面板每次主框架跳转都问它） ---------------------------------- */
const allowedYes = await (await call('/allowed?url=' + encodeURIComponent('https://app.trusted.example/page'))).json()
assert.equal(allowedYes.allowed, true, '白名单内应判定为允许')
const allowedNo = await (await call('/allowed?url=' + encodeURIComponent('https://evil.example/steal'))).json()
assert.equal(allowedNo.allowed, false, '白名单外应判定为不允许')
const allowedNoToken = await fetch(base + '/allowed?url=https%3A%2F%2Fapp.trusted.example%2F')
assert.equal(allowedNoToken.status, 403, '落地复核同样需要令牌')
pass('/allowed：跳转落地页复核接口（含令牌校验）')

/* 8. 参数校验 -------------------------------------------------------- */
await assert.rejects(() => tools.get('browser_open').execute({ url: 'file:///etc/passwd' }), /只允许 http\/https/)
await assert.rejects(() => tools.get('browser_open').execute({ url: 'javascript:alert(1)' }), /只允许 http\/https/)
await assert.rejects(() => tools.get('browser_open').execute({ url: 'nonsense' }), /网址格式无效/)
await assert.rejects(() => tools.get('browser_fill').execute({ text: '' }), /text 不能为空/)
await assert.rejects(() => tools.get('browser_fill').execute({ click: true }), /selector 或 index/)
pass('参数校验：拒绝 file:/javascript: 等非 http(s) 目标；点击必须带定位参数')

server.close()

/* 9. free 策略：白名单 + 打开确认整体关闭 ------------------------------- */
{
  const freeTools = new Map()
  const freeRoutes = []
  const freeCtx = {
    tools: { register(def) { freeTools.set(def.name, def) } },
    inject(_names, cb) {
      cb({ effect: (fn) => fn(), webServer: { register(route) { freeRoutes.push(route); return () => {} } } })
    },
  }
  mod.apply(freeCtx, { openPolicy: 'free' })
  const freeServer = createServer(freeRoutes[0].handler)
  await new Promise((resolve) => freeServer.listen(0, '127.0.0.1', resolve))
  const freeBase = `http://127.0.0.1:${freeServer.address().port}/dsh-agent-browser`
  const freeClaim = await (await fetch(freeBase + '/claim', { method: 'POST' })).json()
  const freeToken = freeClaim.token
  const freeCall = (path, init = {}) =>
    fetch(freeBase + path, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-dsh-agent-browser-token': freeToken, ...(init.headers || {}) },
    })

  // 面板心跳 + 轮询里必须带 policy: free
  const freePoll = await (await freeCall('/poll')).json()
  assert.equal(freePoll.policy, 'free', '/poll 必须下发 policy')
  assert.deepEqual(freePoll.portalHosts, [], '/poll 默认不下发门户桥宿主（需在 cordis.patch.yml 配置 portalBridgeHosts）')

  // 任意网址都直接放行：既有白名单外的地址也不弹确认
  const openPromise = freeTools.get('browser_open').execute({ url: 'https://never-trusted.example/page' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const freeCommands = (await (await freeCall('/poll')).json()).commands
  assert.equal(freeCommands.length, 1)
  assert.equal(freeCommands[0].payload.trusted, true, 'free 策略下 trusted 必须为 true（面板不会弹确认）')
  assert.equal(freeCommands[0].payload.policy, 'free')
  await freeCall('/result', { method: 'POST', body: JSON.stringify({ id: freeCommands[0].id, ok: true, value: { page: { url: 'https://never-trusted.example/page', title: 'x' } } }) })
  const opened = await openPromise
  assert.equal(opened.opened, true, 'free 策略下应报告已打开')
  assert.equal(opened.wasTrusted, true)

  // 落地页复核一律放行
  const freeAllowed = await (await freeCall('/allowed?url=' + encodeURIComponent('https://anything.example/x'))).json()
  assert.equal(freeAllowed.allowed, true, 'free 策略下落地页复核一律放行')

  // 白名单工具变成只读状态说明，不再修改配置
  const freeList = await freeTools.get('browser_allowlist').execute({ action: 'list' })
  assert.equal(freeList.disabled, true)
  assert.equal(freeList.policy, 'free')
  const freeAdd = await freeTools.get('browser_allowlist').execute({ action: 'add', pattern: 'example.com' })
  assert.equal(freeAdd.disabled, true, 'free 策略下不允许再改白名单')

  freeServer.close()
  pass('free 策略：任意网址直接打开、落地页不拦、白名单工具转为只读说明')
}

console.log('\n全部自测通过 ✅')
try { rmSync(process.env.DSH_HOME, { recursive: true, force: true }) } catch { }
// 超时用例会留下一个 180 秒的计时器，直接退出，不等待它
process.exit(0)
