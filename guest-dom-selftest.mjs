/**
 * Guest 脚本 DOM 级自测：真正在 DOM 里执行 READ_SRC / fillSrc，验证读/填/点击/脱敏。
 *
 * 为什么单独一个文件：Host 自测只验证路由和参数透传，Client 自测只验证「脚本语法合法」——
 * 两者都不执行 guest 脚本。这里用 domino（DSH profile 里 turndown 依赖自带的 DOM 实现）
 * 跑真正的脚本，能抓到「脚本语法没问题、真机一跑就错」的回归（2026-10-18 审计指出的假绿）。
 *
 * 依赖：`@mixmark-io/domino`。找不到时打印 SKIP 并以 0 退出（不影响其它自测）。
 * 运行：node dsh-agent-browser/guest-dom-selftest.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const pass = (name) => console.log(`PASS  ${name}`)

/* ------------------------------------------------ 找 domino（可选依赖） */
const requireFrom = createRequire(import.meta.url)
const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
const candidates = [
  '@mixmark-io/domino',
  join(dshHome, 'profiles', 'node_modules', '@mixmark-io', 'domino'),
  join(dshHome, 'profiles', 'desktop', 'node_modules', '@mixmark-io', 'domino'),
]
let domino = null
for (const candidate of candidates) {
  try {
    domino = requireFrom(candidate)
    break
  } catch {
    /* 尝试下一个 */
  }
}
if (domino === null) {
  console.log('SKIP  guest DOM 级自测（找不到 @mixmark-io/domino；装过 DSH 的 profile 里应该自带）')
  process.exit(0)
}

/* ------------------------------------------------ 加载插件拿 guest 脚本 */
globalThis.window = { __ModuleLoader__: { load(definition) { globalThis.__loaded = definition } } }
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
await import('./client.js')
const plugin = globalThis.__loaded.factory(requireStub)
const { READ_SRC, fillSrc } = plugin.__scripts

/* ------------------------------------------------ 测试页 */
const FIXTURE = `<!doctype html><html><head><title>DOM 测试页</title></head><body>
<form id="f1" onsubmit="return false">
  <input type="hidden" name="problemID" value="P1">
  <p>单选题：
    <label><input type="radio" name="ans" value="A"> A</label>
    <label><input type="radio" name="ans" value="B"> B</label>
    <label><input type="radio" name="ans" value="C" checked> C</label>
    <label><input type="radio" name="ans" value="D" disabled> D</label>
  </p>
  <p>文本：<input type="text" name="t" id="t" value="hello"></p>
  <p>密码：<input type="password" name="pwd" id="pwd" value="secret123"></p>
  <p>复选：<input type="checkbox" name="chk" value="1"></p>
  <p>下拉：<select name="s" id="s"><option value="x">X</option><option value="y">Y</option></select></p>
  <p><button id="submitBtn">提交</button><button type="button" id="plainBtn" class="btn primary">普通按钮</button></p>
  <p><button id="disabledBtn" disabled>禁用按钮</button></p>
</form>
<p><a href="https://x.test/a" id="alink">链接</a></p>
<div id="log">（空）</div>
</body></html>`

const createPage = (html = FIXTURE) => {
  const win = domino.createWindow(html, 'https://x.test/page')
  // 这个版本的 domino 在 Node 24 下 a.href getter 会抛（它自带 URL 实现不兼容）；
  // 真机 Chromium 没这个问题。这里给测试页的链接加个等价 getter，让 READ_SRC 的链接收集能跑。
  for (const anchor of Array.from(win.document.querySelectorAll('a[href]'))) {
    Object.defineProperty(anchor, 'href', {
      configurable: true,
      get() { return String(anchor.getAttribute('href') || '') },
    })
  }
  const cssShim = {
    escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch),
  }
  win.CSS = cssShim
  const run = (source) => new Function('window', 'document', 'location', 'Event', 'CSS', 'return ' + source)(
    win, win.document, win.location, win.Event, cssShim,
  )
  return { win, run }
}

/* ------------------------------------------------ READ_SRC：读页面 */
{
  const { run } = createPage()
  const read = run(READ_SRC)
  assert.equal(read.title, 'DOM 测试页')
  assert.equal(read.frameCount, 0)
  const tags = read.editables.map((item) => item.tag)
  const types = read.editables.map((item) => item.type)
  assert.ok(tags.includes('select'), 'editables 应包含 select')
  for (const expected of ['radio', 'text', 'password', 'checkbox']) {
    assert.ok(types.includes(expected), `editables 应包含 ${expected}`)
  }
  const password = read.editables.find((item) => item.id === 'pwd')
  assert.equal(password.valueLength, 9, 'editables 对 password 只给 valueLength')
  assert.equal(password.value, undefined, 'editables 不得带 password 明文')

  assert.equal(read.forms.length, 1, '应识别 1 个题目表单')
  const form = read.forms[0]
  assert.equal(form.problemId, 'P1')
  const textControl = form.textControls.find((item) => item.id === 't')
  assert.equal(textControl.value, 'hello', '文本控件应回传当前值')
  assert.ok(typeof textControl.index === 'number', '文本控件应有全局 index')
  const pwdControl = form.textControls.find((item) => item.id === 'pwd')
  assert.equal(pwdControl.redacted, true, 'password 必须标记 redacted')
  assert.equal(pwdControl.value, '', 'password 明文不得回传')
  assert.equal(pwdControl.valueLength, 9, 'password 应给 valueLength')
  assert.equal(form.radioOptions.length, 4, '应列出 4 个单选选项')
  const optionB = form.radioOptions.find((item) => item.value === 'B')
  assert.equal(optionB.name, 'ans', '单选选项应带 name')
  assert.ok(typeof optionB.label === 'string', '单选选项应带 label 字段')
  assert.equal(form.radioOptions.find((item) => item.value === 'C').checked, true, 'C 应标记 checked')
  assert.equal(form.radioOptions.find((item) => item.value === 'D').disabled, true, 'disabled 单选应标记 disabled')
  assert.equal(form.checkboxOptions.length, 1, '应列出复选框')
  assert.ok(read.formsTruncated === false && read.buttonsTruncated === false && read.linksTruncated === false)
  assert.ok(read.buttons.length >= 3, '应列出按钮')
  const submitButton = read.buttons.find((item) => item.id === 'submitBtn')
  assert.equal(submitButton.type, 'submit', '无 type 的 <button> 应视为 submit')
  assert.equal(submitButton.selector, '#submitBtn')
  const plainButton = read.buttons.find((item) => item.id === 'plainBtn')
  assert.equal(plainButton.class, 'btn primary', 'buttons[].class 应读到 class 属性')
  assert.equal(plainButton.type, 'button')
  assert.equal(read.buttons.find((item) => item.id === 'disabledBtn').disabled, true, 'disabled 按钮应标记 disabled')
  assert.equal(read.links.length, 1)
  assert.equal(read.links[0].selector, '#alink', '链接应带 selector（供 click:true 点击）')
  pass('READ_SRC：select/密码脱敏/单选组/复选框/按钮 class+type/链接 selector 都正确')
}

/* ------------------------------------------------ fillSrc：填文本 / 拒绝敏感字段 */
{
  const { win, run } = createPage()
  const doc = win.document
  const read = run(READ_SRC)
  const textIndex = read.editables.find((item) => item.id === 't').index
  let result = run(fillSrc({ index: textIndex, text: 'new-value' }))
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'input')
  assert.equal(doc.querySelector('#t').value, 'new-value', '文本应真的写进 DOM')
  assert.equal(result.submitted, false)

  result = run(fillSrc({ selector: '#pwd', text: 'hack' }))
  assert.equal(result.ok, false)
  assert.match(result.error, /password|敏感/)
  assert.equal(doc.querySelector('#pwd').value, 'secret123', 'password 不得被填写')

  result = run(fillSrc({ selector: '#s', text: 'y' }))
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'select')
  assert.equal(doc.querySelector('#s').value, 'y', 'select 应按 value 选中')

  result = run(fillSrc({ selector: '#s', text: 'not-exist' }))
  assert.equal(result.ok, false)
  pass('fillSrc：填文本 / 拒绝 password / select 选择 / 非法选项报错')
}

/* ------------------------------------------------ fillSrc：点击（click:true 显式） */
{
  const { win, run } = createPage()
  const doc = win.document
  const read = run(READ_SRC)
  let plainClicks = 0
  let submitClicks = 0
  doc.querySelector('#plainBtn').addEventListener('click', () => { plainClicks += 1 })
  doc.querySelector('#submitBtn').addEventListener('click', () => { submitClicks += 1 })

  const radio = (value) => read.forms[0].radioOptions.find((item) => item.value === value)

  // 不传 click:true：绝不点击，且明确提示
  let result = run(fillSrc({ index: radio('A').index, text: 'A' }))
  assert.equal(result.ok, false)
  assert.match(result.error, /click:true/)
  assert.equal(doc.querySelector('input[value="A"]').checked, false, '未传 click:true 不得改变单选状态')

  // 传 click:true：真的点中单选
  result = run(fillSrc({ index: radio('B').index, click: true, text: 'B' }))
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'radio')
  assert.equal(result.checked, true)
  assert.equal(doc.querySelector('input[value="B"]').checked, true, 'B 应被选中')

  // 选项值不匹配：报错，不误点
  result = run(fillSrc({ index: radio('A').index, click: true, text: 'Z' }))
  assert.equal(result.ok, false)
  assert.match(result.error, /选项不匹配/)

  // disabled 单选：必须报错，不能假装点成功
  result = run(fillSrc({ index: radio('D').index, click: true, text: 'D' }))
  assert.equal(result.ok, false)
  assert.match(result.error, /disabled/)

  // disabled 按钮同理
  result = run(fillSrc({ selector: '#disabledBtn', click: true }))
  assert.equal(result.ok, false)
  assert.match(result.error, /disabled/)

  // 普通按钮 / 提交按钮：click:true 才点，且点一次
  result = run(fillSrc({ selector: '#plainBtn', click: true }))
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'click')
  assert.equal(plainClicks, 1, '普通按钮应被点一次')
  result = run(fillSrc({ selector: '#submitBtn', click: true }))
  assert.equal(result.ok, true)
  assert.equal(submitClicks, 1, '提交按钮应被点一次（是否提交由页面决定）')

  // 旧魔法字符串不再点击
  const before = plainClicks
  result = run(fillSrc({ selector: '#plainBtn', text: 'click' }))
  assert.equal(result.ok, false)
  assert.equal(plainClicks, before, 'text:"click" 不得再触发点击（已改为显式参数）')

  // click:true 但目标不可点：报错
  result = run(fillSrc({ selector: '#log', click: true }))
  assert.equal(result.ok, false)
  assert.match(result.error, /不是可点击控件/)

  // 非唯一 selector：报错，避免点错
  result = run(fillSrc({ selector: 'input', click: true }))
  assert.equal(result.ok, false)
  assert.match(result.error, /不唯一/)

  // index 与 framePath 不一致：报错
  result = run(fillSrc({ index: 0, framePath: [0], text: 'x' }))
  assert.equal(result.ok, false)
  assert.match(result.error, /不一致/)
  pass('fillSrc：click:true 显式点击 / disabled 拒绝 / 旧 text:"click" 失效 / 唯一性与 index 校验')
}

// Cross-document traversal is executed, rather than inferred from source strings.
{
  const top = createPage('<input id="same" value="top"><iframe></iframe>')
  const child = createPage('<input id="same" value="child">')
  Object.defineProperty(top.win.document.querySelector('iframe'), 'contentDocument', { get: () => child.win.document })
  const read = top.run(READ_SRC)
  assert.deepEqual(read.editables.map((item) => [item.index, item.framePath]), [[0, []], [1, [0]]])
  assert.equal(top.run(fillSrc({ index: 1, framePath: [0], text: 'child-only' })).ok, true)
  assert.equal(top.win.document.querySelector('input').value, 'top')
  assert.equal(child.win.document.querySelector('input').value, 'child-only')
  assert.match(top.run(fillSrc({ index: 1, framePath: [], text: 'wrong' })).error, /不一致/)
  assert.match(top.run(fillSrc({ selector: '#same', text: 'wrong' })).error, /不唯一/)
  pass('全局 index / framePath 在两个实际执行脚本的 DOM 文档间保持一致')
}
{
  const { win, run } = createPage('<form><input name="problemID" type="password" value="audit-secret"></form><input id="c" type="checkbox"><input id="r" type="radio">')
  assert.ok(!JSON.stringify(run(READ_SRC)).includes('audit-secret'))
  const checkbox = win.document.querySelector('#c')
  let clicks = 0
  checkbox.addEventListener('click', () => clicks++)
  assert.equal(run(fillSrc({ selector: '#c', click: true })).ok, true)
  assert.equal(checkbox.checked, true)
  assert.equal(clicks, 1)
  assert.equal(run(fillSrc({ selector: '#c', click: true, text: 'true' })).clicked, false)
  assert.equal(clicks, 1)
  const radio = win.document.querySelector('#r')
  radio.addEventListener('click', (event) => event.preventDefault())
  assert.equal(run(fillSrc({ selector: '#r', click: true })).ok, false)
  assert.equal(radio.checked, false)
  pass('敏感 problemID 不泄漏 / checkbox 无 text 真点击 / 取消 radio 不强置状态')
}

console.log('\nguest DOM 级自测全部通过 ✅（READ_SRC / fillSrc 已在 domino DOM 上执行；真实 iframe 生命周期另需浏览器验证）')
