/**
 * dsh-agent-browser —— Client 半边（跑在 DSH 页面里）
 *
 * 职责：
 *   1. 在右侧栏注册一个「AI 浏览器」标签页（kind = agent-browser），页面住在标签里，不再是右下角浮层。
 *   2. 通过 globalThis.dshDesktop.browser 租约会话（DSH 主进程唯一允许的 webview 通道），建真正的 <webview>。
 *   3. 每 500ms 轮询 Host 的 /dsh-agent-browser/poll，执行指令（open/read/fill/screenshot/status）并回传结果。
 *   4. confirm 模式下白名单外的网址先问用户；free 模式直接打开 http(s) 网址。
 *   5. 指令到达而标签页没开时，自己把标签打开，用户不必手动找入口。
 *
 * 不做的事：不按回车、不调用 form.submit()、不发起任何提交动作。
 * 点击是**显式能力**：只有 browser_fill 传 click:true 时才会真实点击
 * radio / checkbox / button / 链接（2026-10-18 用户明确要求放行点击）。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-agent-browser',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ROUTE = '/dsh-agent-browser'
    const TOKEN_HEADER = 'x-dsh-agent-browser-token'
    const LEASE_WORKSPACE = 'dsh-agent-browser' // 固定仓储身份：同一次 DSH 运行内登录态保持
    const POLL_MS = 500

    /**
     * 共用的「文档收集 + 元素定位」片段（嵌进两个脚本里）：
     * 递归进入**同源** iframe（跨域 try/catch 跳过，属于 webview 安全边界），
     * 得到全局扁平的元素顺序——read 的 index 与 fill 的 index 用同一套顺序，跨帧也对得上；
     * framePath 只用于精确 selector 定位与 index 一致性校验。
     */
    const DOC_HELPERS = `
  const QUERY = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], .CodeMirror, .monaco-editor, .ace_editor';
  const collectDocs = () => {
    const docs = [];
    const seen = [];
    const walk = (doc, path, depth) => {
      if (!doc || depth > 3 || docs.length >= 8) return;
      docs.push({ doc, path });
      let frames = [];
      try { frames = Array.from(doc.querySelectorAll('iframe, frame')); } catch (error) { frames = []; }
      for (let i = 0; i < frames.length && docs.length < 8; i += 1) {
        let child = null;
        try { child = frames[i].contentDocument; } catch (error) { child = null; } // 跨域会抛，跳过
        if (child && seen.indexOf(child) === -1) {
          seen.push(child);
          walk(child, path.concat(i), depth + 1);
        }
      }
    };
    walk(document, [], 0);
    return docs;
  };
  const nodesOf = (doc) => {
    try { return Array.from(doc.querySelectorAll(QUERY)); } catch (error) { return []; }
  };
  const inputTypeOf = (el) => String(el.type || (el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
  const isDisabled = (el) => {
    if (el.disabled === true) return true;
    try { if (el.matches && el.matches(':disabled')) return true; } catch (error) { /* DOM shim may not support :disabled */ }
    // A disabled fieldset also disables descendants, except those in its first legend.
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (String(parent.tagName).toUpperCase() !== 'FIELDSET' || parent.disabled !== true) continue;
      const legend = Array.from(parent.children || []).find((child) => String(child.tagName).toUpperCase() === 'LEGEND');
      if (!legend || !legend.contains(el)) return true;
    }
    return false;
  };
  /** 扁平顺序遍历所有同源文档里的可编辑元素。 */
  const eachEditable = (visit) => {
    const docs = collectDocs();
    let index = 0;
    for (const entry of docs) {
      for (const el of nodesOf(entry.doc)) {
        if (visit(el, index, entry.doc, entry.path) === false) return;
        index += 1;
      }
    }
  };
`

    /** 元素定位与可编辑元素识别脚本（在 guest 页面里执行，覆盖同源 iframe）。 */
    const READ_SRC = `(() => {
${DOC_HELPERS}
  /** 只返回能唯一定位的选择器；不唯一时返回 null，避免 Agent 照抄后填错字段（此时应改用 index）。 */
  const selectorOf = (el, doc) => {
    const unique = (candidate) => {
      if (!candidate) return null;
      try { return doc.querySelectorAll(candidate).length === 1 ? candidate : null; } catch (error) { return null; }
    };
    if (el.id) return unique('#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id));
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
      depth += 1;
    }
    return unique(parts.join(' > '));
  };
  const MAX_EDITABLES = 400;
  const editables = [];
  const indexOfEl = new Map();
  let editableTotal = 0;
  eachEditable((el, index, doc, path) => {
    editableTotal += 1;
    if (editables.length >= MAX_EDITABLES) return true;
    indexOfEl.set(el, index);
    const cls = el.classList || { contains: () => false };
    const kind = cls.contains('CodeMirror') ? 'codemirror'
      : cls.contains('monaco-editor') ? 'monaco'
      : cls.contains('ace_editor') ? 'ace'
      : el.isContentEditable ? 'contenteditable'
      : (el.tagName || '').toLowerCase();
    const value = typeof el.value === 'string' ? el.value : '';
    editables.push({
      index,
      framePath: path,
      kind,
      tag: (el.tagName || '').toLowerCase(),
      type: el.getAttribute ? (el.getAttribute('type') || '') : '',
      id: el.id || '',
      name: el.getAttribute ? (el.getAttribute('name') || '') : '',
      placeholder: el.getAttribute ? (el.getAttribute('placeholder') || '') : '',
      selector: selectorOf(el, doc),
      valueLength: value.length,
    });
    return true;
  });
  /**
   * 题目表单清单：作业页把「题干 + 作答控件」放进一个个 <form> 里。
   * 单看扁平的可编辑元素清单根本分不清「第 11 个输入框属于哪道题」，
   * 所以这里按 form 输出：题干前半段 + 该题所有作答控件的扁平 index + 单选/复选选项。
   * problemId 取表单里 hidden input[name=problemID] 的值。
   *
   * 隐私（2026-10-18 审计修复）：password / file 控件只回传「值多长」，绝不回传明文；
   * 之前这里会把表单里的密码原样带给 Agent，违反「不碰账密」的边界。
   */
  const sensitiveTypes = ['password', 'file'];
  const collectLabel = (item) => {
    let label = '';
    try {
      const wrap = item.closest ? item.closest('label') : null;
      if (wrap) label = wrap.innerText || wrap.textContent || '';
      else if (item.id && item.ownerDocument && window.CSS && CSS.escape) {
        const found = item.ownerDocument.querySelector('label[for="' + CSS.escape(item.id) + '"]');
        if (found) label = found.innerText || found.textContent || '';
      }
    } catch (error) { /* 标签取不到就算了 */ }
    return String(label || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
  };
  const docs = collectDocs();
  const forms = [];
  let formsTruncated = false;
  for (const entry of docs) {
    let list = [];
    try { list = Array.from(entry.doc.querySelectorAll('form')); } catch (error) { list = []; }
    for (const form of list) {
      if (forms.length >= 200) { formsTruncated = true; break; }
      try {
        let controls = [];
        try { controls = Array.from(form.querySelectorAll('input, textarea, select')); } catch (error) { controls = []; }
        const answerControls = controls.filter((item) => {
          const type = String((item.getAttribute && item.getAttribute('type')) || '').toLowerCase();
          if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset') return false;
          const name = String((item.getAttribute && item.getAttribute('name')) || '');
          return name !== '' || item.isContentEditable === true;
        });
        if (answerControls.length === 0) continue;
        const pidControl = controls.find((item) => inputTypeOf(item) === 'hidden' && String((item.getAttribute && item.getAttribute('name')) || '') === 'problemID');
        const answer = answerControls.map((item) => {
          const type = inputTypeOf(item) || 'text';
          const raw = String(typeof item.value === 'string' ? item.value : '');
          const sensitive = sensitiveTypes.indexOf(type) !== -1;
          return {
            index: indexOfEl.has(item) ? indexOfEl.get(item) : null,
            name: String((item.getAttribute && item.getAttribute('name')) || ''),
            type,
            id: item.id || '',
            label: collectLabel(item),
            value: sensitive ? '' : raw,
            valueLength: sensitive ? raw.length : undefined,
            redacted: sensitive ? true : undefined,
            disabled: isDisabled(item) ? true : undefined,
            checked: type === 'radio' || type === 'checkbox' ? item.checked === true : undefined,
          };
        });
        const toOption = (item) => ({
          index: item.index,
          name: item.name,
          id: item.id,
          label: item.label,
          value: item.value,
          disabled: item.disabled === true,
          checked: item.checked === true,
        });
        forms.push({
          problemId: pidControl === undefined ? '' : String(pidControl.value || ''),
          framePath: entry.path,
          radioName: (answer.find((item) => item.type === 'radio') || {}).name || '',
          textControls: answer.filter((item) => item.type !== 'radio' && item.type !== 'checkbox'),
          radioOptions: answer.filter((item) => item.type === 'radio').map(toOption),
          checkboxOptions: answer.filter((item) => item.type === 'checkbox').map(toOption),
          questionText: String(form.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 220),
        });
      } catch (error) { /* 单个 form 出错不影响整体读取 */ }
    }
  }
  /**
   * 可点击控件清单（按钮 / 提交按钮 / 图片按钮）。
   * 点击入口是 browser_fill 的 click:true（显式参数），这些控件没有 index，
   * 所以给出可唯一定位的 CSS 选择器 + framePath + 是否 disabled。
   */
  const buttons = [];
  let buttonsTruncated = false;
  for (const entry of docs) {
    let list = [];
    try { list = Array.from(entry.doc.querySelectorAll('button, input[type=submit], input[type=button], input[type=reset], input[type=image]')); } catch (error) { list = []; }
    for (const item of list) {
      if (buttons.length >= 60) { buttonsTruncated = true; break; }
      try {
        const tag = String(item.tagName || '').toUpperCase();
        let type = String((item.getAttribute && item.getAttribute('type')) || '').toLowerCase();
        if (tag === 'BUTTON' && type === '') type = 'submit'; // HTML 默认值：无 type 的 button 就是提交按钮
        const text = String(item.innerText || item.value || item.getAttribute('aria-label') || item.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
        const id = item.id || '';
        const cls = String((item.getAttribute && item.getAttribute('class')) || '').trim();
        // 只保留「看得见 + 有意义」的控件，避免几十个装饰性元素把结果撑爆
        const visible = !!(item.offsetParent !== null || (item.getClientRects && item.getClientRects().length > 0));
        if (!visible) continue;
        const selector = selectorOf(item, entry.doc);
        if (!selector && text.length === 0) continue;
        buttons.push({ tag: tag.toLowerCase(), type, text, id, class: cls.slice(0, 60), selector, framePath: entry.path, disabled: isDisabled(item) });
      } catch (error) { /* 单个控件出错跳过 */ }
    }
  }
  const textParts = [];
  for (const entry of docs) {
    try {
      const body = entry.doc.body;
      if (body && body.innerText) textParts.push(body.innerText);
    } catch (error) { /* 跨域在收集时已跳过 */ }
  }
  // 页面上可点的链接清单：题目列表这类页面只有链接文本、没有可编辑元素，
  // Agent 需要 href 才能用 browser_open 逐题打开（同源 iframe 里的也算上）。
  // click:true 也可用 selector 点击链接（链接没有 index）。
  const links = [];
  let linksTruncated = false;
  for (const entry of docs) {
    try {
      for (const anchor of Array.from(entry.doc.querySelectorAll('a[href]'))) {
        if (links.length >= 80) { linksTruncated = true; break; }
        let href = '';
        try { href = String(anchor.href || ''); } catch (error) { href = ''; }
        if (!/^https?:\\/\\//i.test(href)) continue;
        const label = String(anchor.innerText || anchor.textContent || anchor.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
        if (links.some((item) => item.href === href && item.text === label)) continue;
        links.push({
          text: label,
          href,
          target: String(anchor.getAttribute('target') || ''),
          selector: selectorOf(anchor, entry.doc),
          framePath: entry.path,
        });
      }
    } catch (error) { /* 单个文档出错不影响整体读取 */ }
  }
  return {
    url: location.href,
    title: document.title,
    frameCount: Math.max(0, docs.length - 1),
    text: textParts.join('\\n\\n').slice(0, 20000),
    editables,
    editableTotal,
    editablesTruncated: editableTotal > editables.length,
    forms,
    formsTruncated,
    buttons,
    buttonsTruncated,
    links,
    linksTruncated,
  };
})()`

    /**
     * 填写/点击脚本。
     *   - 默认：只写值（绝不回车、绝不点击、绝不提交）。
     *   - click:true：真实点击 radio / checkbox / button / 链接（含 submit 类 input）。
     * index 语义与 READ_SRC 完全一致：跨同源 iframe 的**全局扁平序号**；
     * framePath 只用于 selector 精确定位，或对 index 做一致性校验。
     */
    const fillSrc = (payload) => `(() => {
  const payload = ${JSON.stringify(payload)};
  const text = typeof payload.text === 'string' ? payload.text : '';
  const wantsClick = payload.click === true;
${DOC_HELPERS}
  /** 按 framePath 逐级进入同源 iframe 文档。 */
  const docAt = (path) => {
    let doc = document;
    for (const index of path || []) {
      let frames = [];
      try { frames = Array.from(doc.querySelectorAll('iframe, frame')); } catch (error) { return null; }
      const frame = frames[index];
      if (!frame) return null;
      let child = null;
      try { child = frame.contentDocument; } catch (error) { return null; } // 跨域
      if (!child) return null;
      doc = child;
    }
    return doc;
  };
  const fail = (message) => ({ ok: false, error: message });
  let el = null;
  let targetDoc = document;
  let targetPath = [];
  if (payload.selector) {
    const selector = String(payload.selector);
    if (Array.isArray(payload.framePath)) {
      const doc = docAt(payload.framePath);
      if (!doc) return fail('目标 iframe 不可访问（可能是跨域）');
      let matches = [];
      try { matches = Array.from(doc.querySelectorAll(selector)); } catch (error) { return fail('选择器无效: ' + String((error && error.message) || error)); }
      if (matches.length === 0) return fail('选择器在该 iframe 内没有匹配元素');
      if (matches.length > 1) return fail('选择器不唯一（匹配 ' + matches.length + ' 个元素），请改用 browser_read 返回的 index');
      el = matches[0]; targetDoc = doc; targetPath = payload.framePath.slice();
    } else {
      // 不带 framePath：必须全页面（含同源 iframe）唯一命中，避免点到同 id 的另一份
      let found = null; let foundDoc = null; let foundPath = null; let total = 0;
      for (const entry of collectDocs()) {
        let matches = [];
        try { matches = Array.from(entry.doc.querySelectorAll(selector)); } catch (error) { continue; }
        total += matches.length;
        if (matches.length === 1 && found === null) { found = matches[0]; foundDoc = entry.doc; foundPath = entry.path; }
      }
      if (total > 1) return fail('选择器不唯一（页面/同源 iframe 中共匹配 ' + total + ' 个元素），请改用 browser_read 返回的 index 或补 framePath');
      if (found) { el = found; targetDoc = foundDoc; targetPath = foundPath; }
    }
  } else if (typeof payload.index === 'number') {
    // 与 browser_read 完全一致的全局扁平顺序（跨同源 iframe），所以跨帧 index 也对得上
    eachEditable((node, index, doc, path) => {
      if (index === payload.index) { el = node; targetDoc = doc; targetPath = path; return false; }
      return true;
    });
    if (el && Array.isArray(payload.framePath) && payload.framePath.join('/') !== targetPath.join('/')) {
      return fail('index 与 framePath 不一致：index 对应的 framePath 是 [' + targetPath.join(', ') + ']，收到 [' + payload.framePath.join(', ') + ']（以 browser_read 返回的 framePath 为准）');
    }
  }
  if (!el) return fail('没找到目标元素（先用 browser_read 看清单，注意 index / selector / framePath）');
  const unavailable = () => {
    if (el.isConnected === false || (targetDoc.documentElement && !targetDoc.documentElement.contains(el))) return '目标元素已不在页面里（页面可能重新渲染了，请重新 browser_read）';
    if (isDisabled(el)) return '目标控件被禁用（disabled），无法填写或点击';
    return '';
  };
  if (unavailable()) return fail(unavailable());
  const targetWindow = targetDoc.defaultView || window;
  const TargetEvent = targetWindow.Event || Event;
  const cls = el.classList || { contains: () => false };
  const tagName = String(el.tagName || '').toUpperCase();
  const inputType = inputTypeOf(el);
  const isRadio = tagName === 'INPUT' && inputType === 'radio';
  const isCheckbox = tagName === 'INPUT' && inputType === 'checkbox';
  const isClickable = tagName === 'BUTTON' || tagName === 'A' || (tagName === 'INPUT' && ['submit', 'button', 'reset', 'image'].indexOf(inputType) !== -1);
  const resultBase = { selector: payload.selector || null, framePath: targetPath, submitted: false };
  // 点击是显式能力：只有 payload.click === true 才会走下面这段（2026-10-18 用户明确要求）。
  if (wantsClick) {
    const label = String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    if (isRadio) {
      const option = String(el.value || '').trim();
      const wanted = String(text || '').trim();
      if (option !== '' && wanted !== '' && option.toUpperCase() !== wanted.toUpperCase()) {
        return fail('选项不匹配：目标选项是 ' + option + '，收到 ' + wanted + '（index/selector 选错了？）');
      }
      try { el.click(); } catch (error) { return fail('点击单选失败：' + String((error && error.message) || error)); }
      if (unavailable()) return fail(unavailable());
      if (!el.checked) return fail('页面取消了单选点击，选项未选中；请重新读取或手动操作');
      return { ok: true, kind: 'radio', ...resultBase, clicked: true, checked: el.checked === true, option, label, valueLength: option.length };
    }
    if (isCheckbox) {
      const wanted = String(text || '').trim().toLowerCase();
      if (wanted !== '' && ['true', '1', 'on', 'false', '0', 'off'].indexOf(wanted) === -1) return fail('复选框状态只接受 true/false、1/0 或 on/off；不传 text 时点击切换一次');
      const targetChecked = wanted === '' ? !el.checked : wanted === 'true' || wanted === '1' || wanted === 'on';
      const needsClick = wanted === '' || el.checked !== targetChecked;
      if (needsClick) {
        try { el.click(); } catch (error) { return fail('点击复选框失败：' + String((error && error.message) || error)); }
      }
      if (unavailable()) return fail(unavailable());
      if (el.checked !== targetChecked) return fail('页面取消了复选框点击，勾选状态未达到目标；请重新读取或手动操作');
      return { ok: true, kind: 'checkbox', ...resultBase, clicked: needsClick, checked: el.checked === true, label };
    }
    if (isClickable) {
      try { el.click(); } catch (error) { return fail('点击失败：' + String((error && error.message) || error)); }
      return { ok: true, kind: 'click', ...resultBase, clicked: true, tag: tagName.toLowerCase(), type: inputType, label, note: '只发送点击，不按回车、不调用 form.submit()；若目标是提交按钮/链接，页面可能自行提交或跳转' };
    }
    return fail('目标不是可点击控件：' + tagName.toLowerCase() + (inputType ? '[' + inputType + ']' : '') + '（click:true 只支持 radio / checkbox / button / a / submit 类 input）');
  }
  // 未传 click:true：只允许写文本；按钮 / 单选 / 复选 / 链接一律拒绝（避免把「填值」误当点击）
  if (isRadio || isCheckbox || isClickable) {
    return fail('目标是 ' + tagName.toLowerCase() + (inputType ? '[' + inputType + ']' : '') + '：要点击请在 browser_fill 里传 click:true；不传时本工具只填文本，不会点击');
  }
  if (tagName === 'SELECT') {
    const wanted = String(text || '').trim();
    const options = Array.from(el.options || []);
    const match = options.filter((option) => String(option.value) === wanted)[0] || options.filter((option) => String(option.textContent || '').trim() === wanted)[0];
    if (!match) {
      return fail('下拉框没有匹配的选项：' + wanted + '（可用 value：' + options.slice(0, 10).map((option) => String(option.value)).join(' / ') + '）');
    }
    el.value = match.value;
    el.dispatchEvent(new TargetEvent('input', { bubbles: true }));
    el.dispatchEvent(new TargetEvent('change', { bubbles: true }));
    return { ok: true, kind: 'select', ...resultBase, selectedValue: el.value };
  }
  // 只允许真正的文本类输入；submit/button/checkbox/file 一律拒绝
  // （给 submit 赋值会改按钮文字却什么都没提交，给 file 赋值会抛异常；password 也刻意不给填，凭据不该经手 Agent）
  if (tagName === 'INPUT') {
    const type = inputType || 'text';
    const allowedTypes = ['', 'text', 'search', 'url', 'tel', 'email', 'number'];
    if (allowedTypes.indexOf(type) === -1) {
      return fail('不是可填写的输入框：type=' + type + '（password/file 等敏感字段刻意不填）');
    }
  }
  const result = { ok: true, kind: '', ...resultBase, replace: payload.replace !== false };

  if (cls.contains('CodeMirror') && el.CodeMirror && typeof el.CodeMirror.setValue === 'function') {
    el.CodeMirror.setValue(text);
    result.kind = 'codemirror';
    result.valueLength = text.length;
    return result;
  }
  const cmHolder = el.querySelector ? el.querySelector('.CodeMirror') : null;
  if (cmHolder && cmHolder.CodeMirror && typeof cmHolder.CodeMirror.setValue === 'function') {
    cmHolder.CodeMirror.setValue(text);
    result.kind = 'codemirror';
    result.valueLength = text.length;
    return result;
  }
  if (cls.contains('monaco-editor')) {
    const monaco = targetWindow.monaco;
    const models = monaco && monaco.editor && typeof monaco.editor.getModels === 'function' ? monaco.editor.getModels() : [];
    if (models.length > 0 && typeof models[0].setValue === 'function') {
      models[models.length - 1].setValue(text);
      result.kind = 'monaco';
      result.valueLength = text.length;
      return result;
    }
  }
  if (cls.contains('ace_editor') && el.env && el.env.editor && typeof el.env.editor.setValue === 'function') {
    el.env.editor.setValue(text, -1);
    result.kind = 'ace';
    result.valueLength = text.length;
    return result;
  }

  el.focus();
  if (unavailable()) return fail(unavailable());
  if (tagName === 'INPUT' && ['text', 'search', 'url', 'tel', 'email', 'number', ''].indexOf(inputTypeOf(el)) === -1) return fail('目标在获得焦点后变为不可填写类型，请重新 browser_read');
  if (el.isContentEditable) {
    const range = targetDoc.createRange();
    range.selectNodeContents(el);
    const selection = targetWindow.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = targetDoc.execCommand && targetDoc.execCommand('insertText', false, text);
    if (!inserted) el.textContent = text;
    result.kind = 'contenteditable';
    result.valueLength = (el.innerText || '').length;
    return result;
  }
  if (payload.replace !== false && typeof el.select === 'function') el.select();
  if (payload.replace !== false && typeof el.setSelectionRange === 'function') {
    try { el.setSelectionRange(0, (el.value || '').length); } catch (error) { /* 某些 input 类型不支持 */ }
  }
  const inserted = targetDoc.execCommand && targetDoc.execCommand('insertText', false, text);
  if (!inserted) el.value = payload.replace === false ? (el.value || '') + text : text;
  el.dispatchEvent(new TargetEvent('input', { bubbles: true }));
  el.dispatchEvent(new TargetEvent('change', { bubbles: true }));
  result.kind = (el.tagName || '').toLowerCase();
  result.valueLength = typeof el.value === 'string' ? el.value.length : text.length;
  return result;
})()`

    /**
     * guest 内的按键桥。
     * 焦点一进网页，按键就归网页所有、宿主页面收不到——所以在页面里用捕获阶段拦下常用组合，
     * 再通过 console 通道（宿主侧监听 <webview> 的 console-message）回传，实现「网页里也能用快捷键」。
     * 只拦浏览器级组合，不改其它按键；重复注入时先卸掉旧监听，避免叠加。
     */
    const KEY_MARK = '[dsh-agent-browser:key]'
    const KEY_BRIDGE_SRC = `(() => {
  const MARK = '${KEY_MARK}';
  try {
    if (typeof window.__dshAgentBrowserKeyBridge === 'function') window.__dshAgentBrowserKeyBridge();
  } catch (error) { /* 旧监听清理失败可忽略 */ }
  const send = (action) => { try { console.log(MARK + action); } catch (error) { /* 页面覆盖了 console 就算了 */ } };
  const handler = (event) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = String(event.key || '');
    const lower = key.toLowerCase();
    if (mod && !event.altKey) {
      if (lower === '=' || lower === '+') { event.preventDefault(); event.stopPropagation(); send('zoom-in'); return; }
      if (lower === '-') { event.preventDefault(); event.stopPropagation(); send('zoom-out'); return; }
      if (lower === '0') { event.preventDefault(); event.stopPropagation(); send('zoom-reset'); return; }
      if (lower === 'f') { event.preventDefault(); event.stopPropagation(); send('find'); return; }
      if (lower === 'r') { event.preventDefault(); event.stopPropagation(); send('reload'); return; }
    }
    if (event.altKey && !mod) {
      if (key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); send('back'); return; }
      if (key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); send('forward'); return; }
    }
    if (key === 'F5') { event.preventDefault(); event.stopPropagation(); send('reload'); }
  };
  window.addEventListener('keydown', handler, true);
  window.__dshAgentBrowserKeyBridge = () => {
    try { window.removeEventListener('keydown', handler, true); } catch (error) { /* ignore */ }
  };
})()`

    /**
     * 门户点击桥：只在 portalBridgeHosts 配置的宿主上接管 window.open。
     * 门户站点资源时常用「window.open('') + 往新窗口写表单 + POST」——DSH 主进程会静默丢弃这种弹窗，
     * 于是点击完全没反应。这里保留表单参数，在当前页展示明确的继续按钮：
     *   - window.open(真实 URL) → 报告给宿主，由面板在当前标签打开；
     *   - window.open('')/about:blank → 返回一个假窗口，收集 document.write 的 HTML；
     *   - 假窗口关闭或请求提交时，只准备表单，不调用提交 API、不自动点击。
     *     用户或 browser_fill(click:true) 点击「继续打开门户」后，由浏览器原生提交。
     */
    const NAV_MARK = '[dsh-agent-browser:nav]'
    const navBridgeSrc = (hosts) => `(() => {
  const HOSTS = ${JSON.stringify(hosts)};
  const host = String(location.hostname || '').toLowerCase();
  const matches = HOSTS.some((suffix) => host === suffix || host.endsWith('.' + suffix));
  if (!matches) return;
  try { if (typeof window.__dshAgentBrowserNavBridge === 'function') window.__dshAgentBrowserNavBridge(); } catch (error) { /* ignore */ }
  const report = (payload) => { try { console.log('${NAV_MARK}' + JSON.stringify(payload)); } catch (error) { /* ignore */ } };
  const realOpen = window.open;
  const prepareHtml = (html) => {
    try {
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const source = parsed.querySelector('form');
      if (!source) return false;
      const action = new URL(source.getAttribute('action') || location.href, document.baseURI || location.href);
      if (action.protocol !== 'http:' && action.protocol !== 'https:') return false;
      const method = (source.getAttribute('method') || 'POST').toUpperCase();
      if (method !== 'GET' && method !== 'POST') return false;
      const inputs = Array.from(source.querySelectorAll('input'));
      if (inputs.some((input) => ['password', 'file'].indexOf(String(input.getAttribute('type') || '').toLowerCase()) !== -1)) return false;
      const oldPreview = document.getElementById('dsh-agent-browser-portal-preview');
      if (oldPreview && oldPreview.parentNode) oldPreview.parentNode.removeChild(oldPreview);
      const preview = document.createElement('section');
      preview.id = 'dsh-agent-browser-portal-preview';
      preview.setAttribute('role', 'dialog');
      preview.setAttribute('aria-label', '门户跳转确认');
      preview.style.cssText = 'position:fixed;z-index:2147483647;left:24px;right:24px;top:24px;padding:20px;border:1px solid #bbb;border-radius:12px;background:white;color:#222;box-shadow:0 4px 24px #0004;font:16px sans-serif';
      const explanation = document.createElement('p');
      explanation.textContent = '门户需要发送表单才能继续。请点击下面的按钮打开：' + action.origin;
      preview.appendChild(explanation);
      const form = document.createElement('form');
      form.method = method;
      form.action = action.href;
      form.target = '_self';
      const enctype = source.getAttribute('enctype');
      if (enctype) form.setAttribute('enctype', enctype);
      for (const input of inputs) {
        const clone = document.createElement('input');
        clone.type = 'hidden';
        clone.name = input.getAttribute('name') || '';
        clone.value = input.getAttribute('value') || '';
        form.appendChild(clone);
      }
      const button = document.createElement('button');
      button.id = 'dsh-agent-browser-portal-continue';
      button.type = 'submit';
      button.textContent = '继续打开门户';
      form.appendChild(button);
      let sent = false;
      form.addEventListener('submit', (event) => {
        if (sent) { event.preventDefault(); return; }
        sent = true;
        button.disabled = true;
      });
      preview.appendChild(form);
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = '取消';
      cancel.addEventListener('click', () => { if (preview.parentNode) preview.parentNode.removeChild(preview); });
      preview.appendChild(cancel);
      document.body.appendChild(preview);
      report({ action: 'form-ready' });
      return true;
    } catch (error) {
      return false;
    }
  };
  window.open = function (url) {
    const target = typeof url === 'string' ? url.trim() : '';
    if (/^https?:\\/\\//i.test(target)) {
      report({ action: 'navigate', url: target });
      return null;
    }
    let html = '';
    let prepared = false;
    const flush = () => {
      if (prepared) return;
      prepared = prepareHtml(html);
      if (!prepared) report({ action: 'blocked' });
    };
    const fakeDocument = {
      write: function () { html += Array.prototype.join.call(arguments, ''); },
      writeln: function () { html += Array.prototype.join.call(arguments, '') + '\\n'; },
      open: function () {},
      close: flush,
      get forms() { return [{ submit: flush }]; },
      get body() { return { appendChild: function () {}, innerHTML: '' }; },
      documentElement: { innerHTML: '' },
      addEventListener: function () {},
      removeEventListener: function () {},
      querySelector: function () { return null; },
      querySelectorAll: function () { return []; },
    };
    return {
      closed: false,
      document: fakeDocument,
      location: {
        href: target,
        assign: function (nextUrl) { report({ action: 'navigate', url: String(nextUrl || '') }); },
        replace: function (nextUrl) { report({ action: 'navigate', url: String(nextUrl || '') }); },
        reload: function () {},
      },
      close: flush,
      focus: function () {},
      blur: function () {},
      print: function () {},
      postMessage: function () {},
      addEventListener: function () {},
      removeEventListener: function () {},
      opener: window,
    };
  };
  /**
   * target=_blank 链路的兜底：即使 Electron 的「页面想开新窗口」转发因环境差异没触发，
   * 捕获阶段直接把这个链接的 URL 报回来、由面板在当前标签打开（等价于浏览器里点它）。
   * 只处理 <a target="_blank"> 的 http(s) 链接，其它点击一概不管。
   */
  const onClickAnchor = function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    const origin = event.target;
    const anchor = origin && origin.closest ? origin.closest('a[href]') : null;
    if (!anchor) return;
    const target = String(anchor.getAttribute('target') || '').toLowerCase();
    if (target !== '_blank') return;
    let url = '';
    try { url = String(anchor.href || ''); } catch (error) { return; }
    if (!/^https?:\\/\\//i.test(url)) return;
    event.preventDefault();
    report({ action: 'navigate', url: url });
  };
  window.__dshAgentBrowserNavBridge = function () {
    try { window.open = realOpen; } catch (error) { /* ignore */ }
    try { document.removeEventListener('click', onClickAnchor, true); } catch (error) { /* ignore */ }
  };
  document.addEventListener('click', onClickAnchor, true);
})()`

    const desktopBridge = () => {
      const carrier = globalThis.dshDesktop
      if (!carrier || carrier.protocolVersion !== 1 || !carrier.browser) return undefined
      return carrier.browser
    }

    /* ------------------------------------------------------------ 控制器 */

    function createController() {
      const listeners = new Set()
      const state = {
        open: false,
        claimed: false,
        connected: false,
        notice: '',
        allowlist: [],
        page: null,
        consent: null, // { command, url }
        blockedRedirect: null, // { url } —— 页面自行跳转到白名单外，已阻止，等用户决定
        windowRequest: null, // { url } —— 页面想开新窗口（target=_blank / window.open），等用户决定
        policy: 'confirm', // confirm = 白名单 + 用户确认；free = 全部关闭（由 Host 的 openPolicy 下发）
        portalHosts: [], // 门户点击桥生效的宿主后缀（Host 下发）
        busy: false,
        address: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        zoom: 1,
        find: { open: false, text: '', matches: 0, active: 0 },
        recent: [], // 最近访问的网址（跨 DSH 重启保留）
      }
      let token = ''
      let timer
      let disposed = false
      let webview
      let container
      let lease
      let ready = false
      let detachOpenRequested
      /** 我们主动加载的地址（用户输入 / 已确认 / 白名单内），用于区分「页面自己跳转」。 */
      let expectedNav = ''
      /** 最近一次成功打开的地址：guest 重建后用它恢复页面。 */
      let lastUrl = ''
      /** 正在进行的显式导航目标；非空时 guest 重建后不要再额外恢复 lastUrl（否则会加载两遍）。 */
      let pendingNavTarget = ''
      /**
       * 访问记录持久化。
       * 背景：DSH 给侧栏浏览器分配的是**内存分区**（dsh-sidebar-browser-<uuid>，没有 persist: 前缀），
       * 所以页面自己的 cookie/历史在退出 DSH 时一定会丢——这是 DSH 内核行为，插件改不了。
       * 但「上次打开了哪个网址」属于本插件自己的状态，可以存在宿主文档的 localStorage 里：
       * 应用文档的 origin 是固定的 dsh-app://app（不像 127.0.0.1:<随机端口> 那样每次变），
       * 所以这份记录能跨 DSH 重启保留，下次打开面板自动回到上次的页面。
       */
      const NAV_KEY = 'dsh-agent-browser:nav'
      const NAV_HISTORY_LIMIT = 12

      function loadNavMemory() {
        try {
          const raw = JSON.parse(globalThis.localStorage && globalThis.localStorage.getItem(NAV_KEY) || 'null')
          if (raw && typeof raw === 'object') {
            const last = typeof raw.lastUrl === 'string' && /^https?:\/\//i.test(raw.lastUrl) ? raw.lastUrl : ''
            const history = Array.isArray(raw.history)
              ? raw.history.filter((item) => typeof item === 'string' && /^https?:\/\//i.test(item)).slice(0, NAV_HISTORY_LIMIT)
              : []
            return { lastUrl: last, history }
          }
        } catch (error) {
          /* 存储损坏就当没有记录 */
        }
        return { lastUrl: '', history: [] }
      }

      const navMemory = loadNavMemory()
      let recentUrls = navMemory.history.slice()
      if (navMemory.lastUrl && recentUrls.indexOf(navMemory.lastUrl) === -1) recentUrls.unshift(navMemory.lastUrl)
      lastUrl = navMemory.lastUrl

      /** 记录一次成功导航（写内存 + 写 localStorage）。 */
      function rememberUrl(url) {
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
        lastUrl = url
        recentUrls = [url].concat(recentUrls.filter((item) => item !== url)).slice(0, NAV_HISTORY_LIMIT)
        try {
          if (globalThis.localStorage) {
            globalThis.localStorage.setItem(NAV_KEY, JSON.stringify({ lastUrl: url, history: recentUrls, savedAt: Date.now() }))
          }
        } catch (error) {
          /* 存不了就只在本次运行有效 */
        }
        patch({ recent: recentUrls.slice() })
      }

      // 初始化时把读到的最近访问列表放进 state，面板空状态会直接展示
      state.recent = recentUrls.slice()

      /** 用户本次会话里点过「允许并继续」的跳转目标。 */
      const tempTrusted = new Set()
      /** 启动阶段是否已经自动接管过一次令牌（只做一次）。 */
      let autoTakeoverTried = false
      const inFlight = new Set()
      // Keep receipts until Host removes the command. A transport retry must never repeat a click.
      const completedResults = new Map()

      /* ---------------------------------------------------- 缩放 / 导航 / 查找 */

      const ZOOM_MIN = 0.25
      const ZOOM_MAX = 3
      const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
      const ZOOM_KEY = 'dsh-agent-browser:zoom'

      function loadZoom() {
        try {
          const value = Number(globalThis.localStorage && globalThis.localStorage.getItem(ZOOM_KEY))
          if (Number.isFinite(value) && value >= ZOOM_MIN && value <= ZOOM_MAX) return value
        } catch (error) {
          /* 无 localStorage 时用默认值 */
        }
        return 1
      }
      function saveZoom(value) {
        try {
          if (globalThis.localStorage) globalThis.localStorage.setItem(ZOOM_KEY, String(value))
        } catch (error) {
          /* 存不了就只在本次有效 */
        }
      }
      function applyZoom() {
        if (!webview || typeof webview.setZoomFactor !== 'function') return
        try {
          webview.setZoomFactor(state.zoom)
        } catch (error) {
          /* guest 未就绪 */
        }
      }
      /** 设置缩放；返回 true 表示值变了。 */
      function setZoomValue(next) {
        const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100))
        if (Math.abs(clamped - state.zoom) < 0.001) return false
        state.zoom = clamped
        saveZoom(clamped)
        emit()
        applyZoom()
        return true
      }
      function stepZoom(direction) {
        const index = ZOOM_STEPS.findIndex((step) => step >= state.zoom - 0.001)
        const current = index === -1 ? ZOOM_STEPS.length - 1 : index
        const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, current + direction))]
        return setZoomValue(next)
      }
      function refreshNavState() {
        if (!webview) return
        let back = false
        let forward = false
        try {
          if (typeof webview.canGoBack === 'function') back = webview.canGoBack() === true
        } catch (error) {
          /* guest 未就绪 */
        }
        try {
          if (typeof webview.canGoForward === 'function') forward = webview.canGoForward() === true
        } catch (error) {
          /* guest 未就绪 */
        }
        if (back !== state.canGoBack || forward !== state.canGoForward) patch({ canGoBack: back, canGoForward: forward })
      }
      function runFind(text, options) {
        if (!webview || typeof webview.findInPage !== 'function') return
        try {
          webview.findInPage(text, options)
        } catch (error) {
          /* guest 未就绪 */
        }
      }

      /** 把 guest 里捕获到的组合键落到具体动作上。 */
      function dispatchGuestShortcut(action) {
        switch (action) {
          case 'zoom-in':
            stepZoom(1)
            return true
          case 'zoom-out':
            stepZoom(-1)
            return true
          case 'zoom-reset':
            setZoomValue(1)
            return true
          case 'find':
            patch({ find: { ...state.find, open: true } })
            return true
          case 'reload':
            try {
              if (webview && typeof webview.reload === 'function') webview.reload()
            } catch (error) {
              /* guest 未就绪 */
            }
            return true
          case 'back':
            try {
              if (webview && typeof webview.goBack === 'function') webview.goBack()
            } catch (error) {
              /* 历史为空 */
            }
            return true
          case 'forward':
            try {
              if (webview && typeof webview.goForward === 'function') webview.goForward()
            } catch (error) {
              /* 历史为空 */
            }
            return true
          default:
            return false
        }
      }

      /** 往当前 guest 注入按键桥（每次 DOM 就绪都注入，页面换了也生效）。 */
      async function injectKeyBridge() {
        if (!webview || typeof webview.executeJavaScript !== 'function') return
        try {
          await withTimeout(webview.executeJavaScript(KEY_BRIDGE_SRC, false), 5000, '注入快捷键')
        } catch (error) {
          /* 页面可能禁止执行，快捷键降级为「仅在面板内生效」，不影响其它功能 */
        }
      }

      /** 在配置的门户宿主上注入 window.open 接管（修「点门户入口没反应」）。 */
      async function injectNavBridge() {
        if (!webview || typeof webview.executeJavaScript !== 'function') return
        const hosts = Array.isArray(state.portalHosts) && state.portalHosts.length > 0 ? state.portalHosts : []
        try {
          await withTimeout(webview.executeJavaScript(navBridgeSrc(hosts), false), 5000, '注入门户桥')
        } catch (error) {
          /* 注入失败只影响门户点击，不影响读/填 */
        }
      }

      // 恢复上次的缩放比例
      state.zoom = loadZoom()


      const emit = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.error('[agent-browser] listener failed', error)
          }
        }
      }
      const patch = (next) => {
        Object.assign(state, next)
        emit()
      }
      /**
       * 写提示文案。sticky 的提示不会被下一轮轮询的成功心跳清掉
       * （否则 500ms 后就消失，用户根本看不到「弹窗已被阻止」这类信息）。
       */
      const setNotice = (text, sticky = false) => {
        state.noticeSticky = text ? Boolean(sticky) : false
        patch({ notice: text })
      }
      const getState = () => ({ ...state })

      const api = (path, init) => {
        const headers = Object.assign({}, (init && init.headers) || {})
        if (token) headers[TOKEN_HEADER] = token
        return fetch(ROUTE + path, Object.assign({}, init, { headers }))
      }

      async function claim(force) {
        try {
          const response = await fetch(ROUTE + (force ? '/reclaim' : '/claim'), { method: 'POST' })
          if (!response.ok) {
            const body = await response.json().catch(() => ({}))
            // 409：令牌已被认领。常见于页面刷新/HMR 后旧实例仍持有令牌，或开了第二个 DSH 窗口。
            // 只在启动阶段自动接管一次，之后交给用户点「强制重新认领」——
            // 否则两个窗口会互相抢令牌，形成来回踢对方下线的死循环。
            if (response.status === 409 && force !== true && !autoTakeoverTried) {
              autoTakeoverTried = true
              return await claim(true)
            }
            patch({ claimed: false })
            setNotice(
              response.status === 409
                ? '令牌已被另一个页面认领。若是同一窗口刷新过或开了第二个窗口，请点「强制重新认领」。'
                : '无法连接 Host：' + (body.error || response.status),
              true,
            )
            return false
          }
          const body = await response.json()
          token = body.token
          setNotice('')
          patch({ claimed: true, allowlist: Array.isArray(body.allowlist) ? body.allowlist : [] })
          return true
        } catch (error) {
          patch({ claimed: false })
          setNotice('Host 路由不可达：' + String((error && error.message) || error))
          return false
        }
      }

      // 单一轮询链：loopId 是门闩。任何需要重启轮询的地方都走 startLoop()，
      // 旧链在下一轮检查 id 后自行退出，绝不会出现两条链互相轮换令牌。
      let loopId = 0

      function startLoop() {
        loopId += 1
        clearTimeout(timer)
        void runLoop(loopId)
      }

      async function runLoop(id) {
        if (disposed || id !== loopId) return
        const ok = await claim(false)
        if (disposed || id !== loopId) return
        if (!ok) {
          // Host 路由可能比页面晚就绪：2 秒后重试，直到认领成功
          timer = setTimeout(() => void runLoop(id), 2000)
          return
        }
        void pollLoop(id)
      }

      async function pollLoop(id) {
        while (!disposed && id === loopId) {
          let restart = false
          try {
            const response = await api('/poll')
            if (response.status === 403) {
              // 令牌失效（例如面板被「强制重新认领」）：换一条新链重连
              token = ''
              patch({ connected: false }); setNotice('面板令牌失效，正在重新认领…', true)
              restart = true
            } else if (response.ok) {
              const body = await response.json()
              const next = {
                connected: true,
                policy: body.policy === 'free' ? 'free' : 'confirm',
                portalHosts:
                  Array.isArray(body.portalHosts) && body.portalHosts.length > 0
                    ? body.portalHosts.filter((item) => typeof item === 'string' && item.length > 0)
                    : state.portalHosts,
                allowlist: Array.isArray(body.allowlist) ? body.allowlist : state.allowlist,
              }
              if (!state.noticeSticky) next.notice = ''
              patch(next)
              const commands = Array.isArray(body.commands) ? body.commands : []
              const pendingIds = new Set(commands.map((command) => command.id))
              for (const id of completedResults.keys()) {
                if (!pendingIds.has(id) && !inFlight.has(id)) completedResults.delete(id)
              }
              for (const command of commands) {
                if (inFlight.has(command.id)) continue
                inFlight.add(command.id)
                const receipt = completedResults.get(command.id)
                if (receipt !== undefined) void sendResult(command.id, receipt)
                else void run(command)
              }
            } else {
              patch({ connected: false })
            }
          } catch (error) {
            patch({ connected: false }); setNotice('轮询失败：' + String((error && error.message) || error))
          }
          if (restart) {
            startLoop()
            return
          }
          await delay(POLL_MS)
        }
      }

      /** Record completion before any network await; subsequent polls only resend the receipt. */
      async function report(id, ok, value, error) {
        const body = JSON.stringify({ id, ok, value, error, page: state.page })
        completedResults.set(id, body)
        return sendResult(id, body)
      }

      async function sendResult(id, body) {
        try {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              const response = await api('/result', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
              })
              if (response.ok) return
              if (response.status === 403) {
                setNotice('结果回传被拒绝（令牌失效），已保留结果，重新连接后只重传回执', true)
                return
              }
            } catch (error) {
              /* 网络抖动，重试 */
            }
            await delay(300)
          }
          setNotice('结果回传失败，已保留结果等待重传，本会话不会再次执行该指令', true)
        } finally {
          inFlight.delete(id)
        }
      }

      /** 给可能永不 settle 的调用加超时，避免 busy 被永久焊住。 */
      function withTimeout(promise, ms, label) {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(label + ' 超时（' + Math.round(ms / 1000) + ' 秒）')), ms)
          Promise.resolve(promise).then(
            (value) => { clearTimeout(timeout); resolve(value) },
            (error) => { clearTimeout(timeout); reject(error) },
          )
        })
      }

      /**
       * 武装「等 dom-ready」：每次 guest 重建都要重新武装一次。
       * - 先武装再挂载，避免 append 与监听之间错过事件；
       * - 超时不是永久状态：teardown 后 armPromise 复位，下次能重新等。
       */
      let armPromise
      const GUEST_READY_TIMEOUT_MS = 8000

      function armReady(element) {
        if (ready) return Promise.resolve()
        if (armPromise) return armPromise
        armPromise = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            armPromise = undefined
            reject(new Error('受控浏览器初始化超时（dom-ready 未触发）'))
          }, GUEST_READY_TIMEOUT_MS)
          element.addEventListener('dom-ready', () => {
            clearTimeout(timeout)
            armPromise = undefined
            ready = true
            emit()
            resolve()
          }, { once: true })
        })
        return armPromise
      }

      /** 由 apply() 注入：需要容器时把侧栏的「AI 浏览器」标签打开。 */
      let onNeedContainer
      /** 由 apply() 注入：截图前把侧栏展开，避免拍到空白。 */
      let onExpandSidebar
      /** 等侧栏把标签页渲染出来（openTab 之后 React 需要一两帧）。 */
      async function waitForContainer(timeoutMs = 6000) {
        if (container !== undefined) return
        if (typeof onNeedContainer === 'function') {
          try {
            onNeedContainer()
          } catch (error) {
            /* 打开失败会在下面统一报错 */
          }
        }
        const deadline = Date.now() + timeoutMs
        while (container === undefined && Date.now() < deadline) await delay(120)
      }

      /** 拆掉当前 guest：移除元素 + 释放租约 + 复位就绪态。 */
      function teardownGuest() {
        if (typeof detachOpenRequested === 'function') {
          try {
            detachOpenRequested()
          } catch (error) {
            /* 容器可能已销毁 */
          }
        }
        detachOpenRequested = undefined
        if (webview && typeof webview.remove === 'function') {
          try {
            webview.remove()
          } catch (error) {
            /* 可能已被 React 卸载 */
          }
        }
        webview = undefined
        ready = false
        armPromise = undefined
        // guest 没了，页面内查找状态也失效：不复位会让新页面显示旧的「2/5」
        if (state.find.open || state.find.matches > 0 || state.find.text) {
          patch({ find: { open: false, text: '', matches: 0, active: 0 } })
        }
        const bridge = desktopBridge()
        if (lease && bridge) {
          try {
            // release 的返回值不一定声明为 Promise：包一层，避免清理阶段抛错
            Promise.resolve(bridge.release(lease)).catch(() => {})
          } catch (error) {
            /* 租约可能已随窗口销毁 */
          }
        }
        lease = undefined
      }

      /**
       * 用「新租约 + 新元素」建一个 guest。
       * DSH 主进程规定：一个租约只接受一次 attach（lease.attached），
       * 所以元素一旦离开过 DOM 就只能整条链路重建，不能复用旧元素/旧租约。
       */
      async function createGuest() {
        const bridge = desktopBridge()
        if (!bridge) throw new Error('当前不是 DSH 桌面窗口，无法创建受控浏览器（请用 DSH 桌面端打开，而不是浏览器里的 127.0.0.1 页面）')
        const reservation = await bridge.acquire(LEASE_WORKSPACE)
        lease = reservation.lease
        const element = document.createElement('webview')
        element.setAttribute('name', reservation.lease)
        element.setAttribute('partition', reservation.partition)
        // 必须声明 allowpopups，否则 guest 里 window.open / target=_blank 的请求根本到不了
        // 主进程的 setWindowOpenHandler，DSH 转发「页面想开新窗口」的那条链就永远不会触发
        //（表现：点链接毫无反应、window.open() 返回 null）。官方侧栏浏览器同样声明了这一项；
        // 真正的弹窗仍由主进程 return { action: 'deny' } 拒绝，只在当前标签内导航。
        element.setAttribute('allowpopups', '')
        element.setAttribute('src', 'about:blank#' + reservation.lease)
        element.className = 'dab-webview'
        element.addEventListener('did-navigate', (event) => {
          void syncPage()
          refreshNavState()
          // 成功导航后清掉上一轮「页面加载失败」的残留提示
          if (state.noticeSticky && /页面加载失败/.test(String(state.notice))) setNotice('')
          void guardNavigation(event && typeof event.url === 'string' ? event.url : '')
        })
        element.addEventListener('did-navigate-in-page', () => {
          void syncPage()
          refreshNavState()
        })
        element.addEventListener('did-start-loading', () => patch({ loading: true }))
        element.addEventListener('did-stop-loading', () => {
          patch({ loading: false })
          refreshNavState()
        })
        element.addEventListener('dom-ready', () => {
          // guest 重建后缩放会丢，重新应用一次
          applyZoom()
          refreshNavState()
          // 每次 DOM 就绪都注入按键桥 / 门户点击桥（页面切换后依然生效）
          void injectKeyBridge()
          void injectNavBridge()
        })
        element.addEventListener('console-message', (event) => {
          const details = event && event.details ? event.details : null
          const message =
            event && typeof event.message === 'string'
              ? event.message
              : details && typeof details.message === 'string'
                ? details.message
                : ''
          // 门户点击桥：window.open 被接管后回传的动作
          if (message.indexOf(NAV_MARK) === 0) {
            try {
              const payload = JSON.parse(message.slice(NAV_MARK.length))
              if (payload && payload.action === 'navigate' && typeof payload.url === 'string') {
                const target = payload.url.trim()
                if (/^https?:\/\//i.test(target)) {
                  void handleOpenRequest(target).catch((error) => setNotice('打开链接失败：' + String((error && error.message) || error), true))
                }
              } else if (payload && payload.action === 'form-ready') {
                setNotice('门户表单已准备好。请在网页中显式点击「继续打开门户」（或让 AI 用 click:true 点击该按钮）。', true)
              } else if (payload && payload.action === 'blocked') {
                setNotice('页面想打开的新窗口无法在当前标签重放（可能是纯脚本弹窗）', true)
              }
            } catch (error) {
              /* 不是我们的消息或 JSON 损坏，忽略 */
            }
            return
          }
          if (message.indexOf(KEY_MARK) !== 0) return
          dispatchGuestShortcut(message.slice(KEY_MARK.length))
        })
        element.addEventListener('found-in-page', (event) => {
          const result = event && event.result ? event.result : {}
          patch({
            find: {
              open: true,
              text: state.find.text,
              matches: Number(result.matches) || 0,
              active: Number(result.activeMatchOrdinal) || 0,
            },
          })
        })
        element.addEventListener('page-title-updated', () => void syncPage())
        element.addEventListener('did-fail-load', (event) => {
          patch({ loading: false })
          if (event && event.errorCode === -3) return
          // 子帧（广告/统计 iframe）失败不应报成「整页失败」
          if (event && event.isMainFrame === false) return
          const reason = String((event && event.errorDescription) || '') || '未知错误'
          setNotice('页面加载失败：' + reason + '（可点 ↻ 重试）', true)
        })
        // 先武装 dom-ready 再挂载：避免事件在 append 与监听之间到达
        const readyPromise = armReady(element)
        container.appendChild(element)
        webview = element
        // 页面自身请求开新窗口：主进程拒绝弹窗但会把 URL 交给我们，这里在白名单内直接接管导航，
        // 白名单外交给用户决定（否则点击 target=_blank / window.open 的链接会像「没反应」）。
        const releaseOpenRequested = bridge.onOpenRequested(reservation.lease, (requestUrl) => {
          if (disposed) return
          void handleOpenRequest(requestUrl)
        })
        if (typeof releaseOpenRequested === 'function') detachOpenRequested = releaseOpenRequested
        try {
          await readyPromise
        } catch (error) {
          // 主进程拒绝了 attach 或 guest 被关闭：整条拆掉，交给上层重建
          teardownGuest()
          throw error
        }
        applyZoom()
        refreshNavState()
        return webview
      }

      /** 重挂载导致 guest 重建后，把原来的页面恢复回去。 */
      async function restoreLastUrl(element) {
        if (!/^https?:\/\//i.test(lastUrl)) return
        try {
          expectedNav = lastUrl
          patch({ loading: true })
          await element.loadURL(lastUrl)
          await waitLoaded(15000)
          await syncPage()
          refreshNavState()
        } catch (error) {
          /* 恢复失败就停在空白页，用户可以手动重开 */
        } finally {
          patch({ loading: false })
        }
      }

      /**
       * 取得可用的 webview：
       *   - 必须等 dom-ready 之后才能调用 loadURL / executeJavaScript（Electron 的硬要求）；
       *   - 元素离开过 DOM 时 guest 已被销毁，旧租约也不能复用 → 新租约重建，并恢复原来的页面；
       *   - 重建失败自动再试一次；
       *   - 单例：并发指令共用同一次创建，避免双建 guest / 租约泄漏 / 双 webview。
       */
      let ensurePromise = null

      function ensureWebview() {
        if (ensurePromise) return ensurePromise
        ensurePromise = (async () => {
          await waitForContainer()
          if (container === undefined) throw new Error('侧栏里的「AI 浏览器」标签还没打开：请展开右侧栏，或点右侧栏的 ＋ 选择「AI 浏览器」')
          if (webview) {
            if (webview.parentNode === container) {
              await armReady(webview)
              return webview
            }
            teardownGuest()
          }
          let lastError
          for (let attempt = 0; attempt < 2; attempt += 1) {
            if (disposed) throw new Error('受控浏览器已关闭')
            try {
              const element = await createGuest()
              // 防御：并发兜底后若全局已指向别的元素，把本次多建的这个立刻拆掉
              if (webview !== element) {
                try {
                  element.remove()
                } catch (error) {
                  /* 忽略 */
                }
                throw new Error('受控浏览器被并发创建，已回滚本次实例')
              }
              // 有明确的导航目标时不要再用 lastUrl 恢复一次，否则同一次打开会加载两遍
              if (!pendingNavTarget) await restoreLastUrl(element)
              return element
            } catch (error) {
              lastError = error
              teardownGuest()
              if (attempt === 0) await delay(250)
            }
          }
          throw lastError ?? new Error('受控浏览器创建失败')
        })()
        return ensurePromise.finally(() => {
          ensurePromise = null
        })
      }

      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

      async function waitLoaded(timeoutMs) {
        const element = webview
        if (!element) return
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          let loading = true
          try {
            loading = element.isLoading ? element.isLoading() : false
          } catch (error) {
            loading = false
          }
          if (!loading && ready) return
          await delay(120)
        }
      }

      async function syncPage() {
        if (!webview) return
        try {
          const info = await withTimeout(
            webview.executeJavaScript(`({ url: location.href, title: document.title })`, false),
            10000,
            '读取当前页信息',
          )
          if (info && typeof info.url === 'string') {
            if (info.url === 'about:blank' || info.url === '') {
              // 空白页不算「有页面」：保持空状态提示，页签也显示固定名
              patch({ page: null })
              return
            }
            // 页内点击/页面自跳也算「当前页」，这样 guest 重建后能回到真正的当前页；
            // 同时写进 localStorage，DSH 重启后能自动恢复。
            if (/^https?:\/\//i.test(info.url)) rememberUrl(info.url)
            // 地址栏与当前页在同一次 patch 里更新，否则界面会停在旧地址
            patch({ page: info, address: info.url })
          }
        } catch (error) {
          /* 页面切换瞬间可能取不到，忽略 */
        }
      }

      /** 向 Host 询问某个地址是否命中白名单（判定逻辑只在 Host 一份，避免两侧漂移）。 */
      async function checkAllowed(url) {
        try {
          const response = await api('/allowed?url=' + encodeURIComponent(url))
          if (!response.ok) return false
          const body = await response.json()
          return body.allowed === true
        } catch (error) {
          return false // 拿不准就当不允许（fail closed）
        }
      }

      /**
       * 页面请求开新窗口（target=_blank / window.open）。
       * 主进程会拒绝弹窗，但把目标 URL 通过 onOpenRequested 交给我们。
       * 之前只弹一条提示，结果就是「点了链接像没反应」——所以这里改成：
       *   白名单内 → 直接在当前标签打开；白名单外 → 交给用户点「在当前标签打开」。
       */
      async function handleOpenRequest(requestUrl) {
        if (disposed) return
        const url = typeof requestUrl === 'string' ? requestUrl.trim() : ''
        if (!/^https?:\/\//i.test(url)) {
          setNotice('页面请求打开不支持的链接：' + String(url || '(空)'), true)
          return
        }
        try {
          if (state.policy === 'free' || tempTrusted.has(url) || (await checkAllowed(url))) {
            if (disposed) return
            setNotice('')
            await navigate(url)
            return
          }
        } catch (error) {
          /* 判定失败就按白名单外处理 */
        }
        if (disposed) return
        patch({ windowRequest: { url } })
        setNotice('页面想打开新窗口，已拦下等你决定：' + shortUrl(url), true)
      }

      /**
       * 落地页守卫：白名单只挡「打开」那一刻是不够的——
       * 一个白名单内的地址完全可以 302/JS 跳到外站，之后 read/fill 就都在外站执行了。
       * 所以每一次主框架跳转都复核：不是我们主动加载的、且不在白名单、也不在本次会话临时信任里，就拦下来问用户。
       */
      async function guardNavigation(url) {
        if (state.policy === 'free') return // 确认机制整体关闭：不拦跳转
        if (disposed || !url || url === 'about:blank') return
        if (url === expectedNav) {
          expectedNav = ''
          return
        }
        if (tempTrusted.has(url)) return
        if (await checkAllowed(url)) return
        if (disposed || !webview) return
        patch({ blockedRedirect: { url } })
        setNotice('页面自行跳转到白名单外的地址，已阻止：' + url, true)
        try {
          expectedNav = 'about:blank'
          await webview.loadURL('about:blank')
        } catch (error) {
          /* 已经跳走了就算了，提示仍然有效 */
        }
      }

      async function navigate(url) {
        pendingNavTarget = url
        try {
          const element = await ensureWebview()
          expectedNav = url
          await element.loadURL(url)
          await waitLoaded(20000)
          await syncPage()
          refreshNavState()
          rememberUrl((state.page && state.page.url) || url)
          return { url: lastUrl, title: (state.page && state.page.title) || '' }
        } finally {
          pendingNavTarget = ''
        }
      }

      async function run(command) {
        try {
          if (command.kind === 'open') {
            const payload = command.payload && typeof command.payload === 'object' ? command.payload : {}
            const url = typeof payload.url === 'string' ? payload.url : ''
            if (url.length === 0) {
              report(command.id, false, undefined, '打开指令缺少 url')
              return
            }
            // 客户端再校验一次协议：Host 已校验，但这一步成本为零，避免将来 Host 侧改动被绕
            if (!/^https?:\/\//i.test(url)) {
              report(command.id, false, undefined, '只允许 http/https 地址：' + url)
              return
            }
            const trusted = state.policy === 'free' ? true : payload.trusted === true
            if (trusted !== true) {
              // 白名单外：必须由用户点「允许」。
              // 保留 inFlight，否则下一次轮询会把同一条指令再弹一次窗。
              // 若已有待确认请求，先把它按「被取代」结束，避免它永远悬在 Host 侧。
              const previous = state.consent
              if (previous) report(previous.command.id, false, undefined, '被新的打开请求取代')
              // 关键：确认卡片要渲染就必须先把侧栏标签打开（否则用户看不到卡片，Host 干等 180s）
              if (typeof onNeedContainer === 'function') {
                try {
                  onNeedContainer()
                } catch (error) {
                  setNotice('无法打开「AI 浏览器」标签：' + String((error && error.message) || error), true)
                }
              }
              patch({ consent: { command, url }, open: true, busy: true })
              // 顺手把容器/guest 准备好，用户点「允许」时能立刻加载
              void ensureWebview().catch((error) => {
                setNotice(String((error && error.message) || error), true)
              })
              return
            }
            await executeOpen(command)
            return
          }
          patch({ busy: true })
          if (command.kind === 'read') {
            const element = await ensureWebview()
            const value = await withTimeout(element.executeJavaScript(READ_SRC, false), 30000, '读取页面')
            if (value && value.url) patch({ page: { url: value.url, title: value.title } })
            report(command.id, true, value)
            return
          }
          if (command.kind === 'fill') {
            const element = await ensureWebview()
            // userGesture 传 false：写值靠赋值 + input/change 事件；click:true 点的是页面元素本身
            const value = await withTimeout(element.executeJavaScript(fillSrc(command.payload), false), 30000, '填写/点击')
            if (value && value.ok === false) report(command.id, false, undefined, value.error)
            else report(command.id, true, value)
            return
          }
          if (command.kind === 'screenshot') {
            const element = await ensureWebview()
            if (typeof element.capturePage !== 'function') {
              report(command.id, false, undefined, '当前 Electron 版本不支持 webview.capturePage()')
              return
            }
            // 收起状态（visibility:hidden）下合成结果可能是空白：先让侧栏展开再拍
            if (typeof onExpandSidebar === 'function') {
              try {
                onExpandSidebar()
              } catch (error) {
                /* 展开失败也继续，最多拍到空白图 */
              }
            }
            patch({ open: true })
            await delay(300)
            let image = null
            try {
              image = await withTimeout(element.capturePage(), 20000, '截图')
            } catch (error) {
              // Electron 对最小化/被遮挡的窗口 capturePage 会抛 UnknownVizError；
              // 等一帧再试一次，仍失败就给可操作提示，而不是把原始 Electron 错误丢给用户。
              await delay(500)
              try {
                image = await withTimeout(element.capturePage(), 20000, '截图')
              } catch (retryError) {
                const raw = String((retryError && retryError.message) || retryError)
                if (/UnknownVizError|GUEST_VIEW_MANAGER_CALL/i.test(raw)) {
                  report(command.id, false, undefined, '截图失败：DSH 窗口当前不可见（最小化/被遮挡），或「AI 浏览器」标签不在右侧栏前台。请还原 DSH 窗口并切到该标签后重试。')
                } else {
                  report(command.id, false, undefined, '截图失败：' + raw)
                }
                return
              }
            }
            const dataUrl = typeof image.toDataURL === 'function' ? image.toDataURL() : ''
            const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : ''
            report(command.id, true, { base64, page: state.page })
            return
          }
          if (command.kind === 'status') {
            report(command.id, true, {
              webviewReady: Boolean(webview && ready),
              webviewAttached: Boolean(webview && webview.parentNode === container),
              page: state.page,
              connected: state.connected,
            })
            return
          }
          report(command.id, false, undefined, '未知指令：' + String(command.kind))
        } catch (error) {
          report(command.id, false, undefined, String((error && error.message) || error))
        } finally {
          if (state.consent === null) patch({ busy: false })
        }
      }

      async function executeOpen(command) {
        try {
          setNotice(''); patch({ busy: true })
          const info = await navigate(command.payload.url)
          report(command.id, true, { userApproved: true, page: info })
        } catch (error) {
          report(command.id, false, undefined, String((error && error.message) || error))
        } finally {
          // 只负责收尾自己这条：绝不能在这里清 consent，
          // 否则后到的受信打开会顺手关掉别人的同意弹窗，让那条指令一直悬在 Host 侧。
          patch({ busy: false })
        }
      }

      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getState,
        /** apply() 用它把「打开侧栏标签」的办法交给控制器。 */
        setNeedContainerHook(hook) {
          onNeedContainer = hook
        },
        /** apply() 用它把「展开侧栏」的办法交给控制器（截图前用）。 */
        setExpandHook(hook) {
          onExpandSidebar = hook
        },
        /** 侧栏标签页里的容器挂载 / 卸载。 */
        attach(node) {
          container = node
        },
        detach() {
          if (container === undefined) return
          container = undefined
        },
        /**
         * 面板打开时自动回到上次访问的页面（跨 DSH 重启有效）。
         * 只恢复本插件自己记下的网址；cookie/登录态属于 DSH 的内存分区，重启后必然要重新登录。
         */
        async restoreSession() {
          if (disposed) return
          if (state.page && state.page.url) return
          if (state.loading) return
          const target = /^https?:\/\//i.test(lastUrl) ? lastUrl : (recentUrls[0] || '')
          if (!/^https?:\/\//i.test(target)) return
          try {
            await navigate(target)
          } catch (error) {
            setNotice('恢复上次访问的页面失败：' + String((error && error.message) || error) + '（可手动输入网址）', true)
          }
        },
        /** 面板里点「最近访问」里的条目。 */
        async navigateTo(url) {
          if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
          try {
            setNotice('')
            await navigate(url)
          } catch (error) {
            setNotice('打开失败：' + String((error && error.message) || error), true)
          }
        },
        back() {
          try {
            if (webview && typeof webview.goBack === 'function' && (!webview.canGoBack || webview.canGoBack())) webview.goBack()
          } catch (error) {
            /* 历史为空 */
          }
        },
        forward() {
          try {
            if (webview && typeof webview.goForward === 'function' && (!webview.canGoForward || webview.canGoForward())) webview.goForward()
          } catch (error) {
            /* 历史为空 */
          }
        },
        reload() {
          try {
            if (webview && typeof webview.reload === 'function') webview.reload()
          } catch (error) {
            /* guest 还没就绪 */
          }
        },
        /** 停止加载（等价于浏览器里的 ✕）。 */
        stop() {
          try {
            if (webview && typeof webview.stop === 'function') webview.stop()
          } catch (error) {
            /* guest 还没就绪 */
          }
          patch({ loading: false })
        },
        zoomIn() {
          stepZoom(1)
        },
        zoomOut() {
          stepZoom(-1)
        },
        resetZoom() {
          setZoomValue(1)
        },
        setZoom(factor) {
          setZoomValue(Number(factor) || 1)
        },
        async copyAddress() {
          const url = (state.page && state.page.url) || state.address
          if (!url) return
          try {
            await navigator.clipboard.writeText(url)
            setNotice('已复制地址', true)
          } catch (error) {
            setNotice('复制失败：' + String((error && error.message) || error), true)
          }
        },
        openFind() {
          patch({ find: { ...state.find, open: true } })
        },
        closeFind() {
          try {
            if (webview && typeof webview.stopFindInPage === 'function') webview.stopFindInPage('clearSelection')
          } catch (error) {
            /* guest 还没就绪 */
          }
          patch({ find: { open: false, text: '', matches: 0, active: 0 } })
        },
        find(text, forward = true) {
          const value = String(text || '')
          patch({ find: { open: true, text: value, matches: 0, active: 0 } })
          if (value.length === 0) {
            try {
              if (webview && typeof webview.stopFindInPage === 'function') webview.stopFindInPage('clearSelection')
            } catch (error) {
              /* ignore */
            }
            return
          }
          runFind(value, { forward, findNext: false })
        },
        findNext(forward = true) {
          if (!state.find.text) return
          runFind(state.find.text, { forward, findNext: true })
        },
        start() {
          disposed = false
          startLoop()
        },
        dispose() {
          disposed = true
          loopId += 1 // 让在跑的轮询链退出
          clearTimeout(timer)
          teardownGuest()
        },
        setOpen(open) {
          patch({ open })
          if (open) {
            void ensureWebview().then(() => {
              if (!state.page) void syncPage()
            }).catch((error) => setNotice(String((error && error.message) || error), true))
          }
        },
        setAddress(value) {
          state.address = value
          emit()
        },
        async openByUser() {
          const url = (state.address || '').trim()
          if (!/^https?:\/\//i.test(url)) {
            setNotice('请输入 http:// 或 https:// 开头的完整网址', true)
            return
          }
          try {
            setNotice(''); patch({ busy: true })
            await navigate(url)
          } catch (error) {
            setNotice('打开失败：' + String((error && error.message) || error), true)
          } finally {
            patch({ busy: false })
          }
        },
        allowConsent() {
          const consent = state.consent
          if (!consent) return
          patch({ consent: null })
          void executeOpen(consent.command)
        },
        denyConsent() {
          const consent = state.consent
          if (!consent) return
          patch({ consent: null, busy: false })
          report(consent.command.id, false, undefined, '用户拒绝了这次打开请求')
        },
        async addPattern(pattern) {
          const response = await api('/allowlist', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'add', pattern }),
          })
          if (!response.ok) {
            const body = await response.json().catch(() => ({}))
            setNotice('加入白名单失败：' + (body.error || response.status), true)
            return
          }
          const list = await api('/allowlist')
          if (list.ok) {
            const body = await list.json()
            patch({ allowlist: body.patterns || [] })
          }
        },
        async removePattern(pattern) {
          const response = await api('/allowlist', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'remove', pattern }),
          })
          if (!response.ok) {
            const body = await response.json().catch(() => ({}))
            setNotice('删除白名单失败：' + (body.error || response.status), true)
            return
          }
          const list = await api('/allowlist')
          if (list.ok) {
            const body = await list.json()
            patch({ allowlist: body.patterns || [] })
          }
        },
        /** 页面自行跳到白名单外被拦下后，用户点「允许并继续」。 */
        async allowRedirect() {
          const blocked = state.blockedRedirect
          if (!blocked) return
          tempTrusted.add(blocked.url)
          patch({ blockedRedirect: null, address: blocked.url })
          setNotice('')
          try {
            patch({ busy: true })
            const element = await ensureWebview()
            expectedNav = blocked.url
            await element.loadURL(blocked.url)
            await waitLoaded(20000)
            await syncPage()
          } catch (error) {
            setNotice('继续打开失败：' + String((error && error.message) || error), true)
          } finally {
            patch({ busy: false })
          }
        },
        dismissRedirect() {
          patch({ blockedRedirect: null })
          setNotice('')
        },
        /** 页面想开新窗口、但目标不在白名单：用户点「在当前标签打开」。 */
        async allowWindowRequest() {
          const request = state.windowRequest
          if (!request) return
          patch({ windowRequest: null })
          try {
            patch({ busy: true })
            tempTrusted.add(request.url)
            await navigate(request.url)
            setNotice('')
          } catch (error) {
            setNotice('打开失败：' + String((error && error.message) || error), true)
          } finally {
            patch({ busy: false })
          }
        },
        dismissWindowRequest() {
          patch({ windowRequest: null })
          setNotice('')
        },
        async reclaim() {
          // 换发令牌：先停掉在跑的链并清空旧令牌，避免两条链互相轮换令牌
          loopId += 1
          clearTimeout(timer)
          token = ''
          const ok = await claim(true)
          if (disposed) return
          if (ok) void pollLoop(loopId)
          else startLoop()
        },
      }
    }

    /* ------------------------------------------- 侧栏标签页（UI） */

    const KIND = 'agent-browser'
    const TYPE_ID = '@local/dsh-agent-browser'

    const CSS = `
.dab-pane { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font: var(--dsw-font-xxs-12, 12px/1.5 sans-serif); }
.dab-bar { display: flex; align-items: center; gap: 4px; padding: 6px; border-bottom: .5px solid var(--dsw-alias-border-l3); flex: none; }
.dab-icon { width: 26px; height: 26px; flex: none; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit; font-size: 14px; line-height: 1; }
.dab-icon:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dab-icon:disabled { opacity: .4; cursor: default; }
.dab-addr { flex: auto; min-width: 0; height: 26px; padding: 0 8px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; }
.dab-addr:focus { outline: none; border-color: var(--dsw-alias-label-quaternary); }
.dab-meta { display: flex; align-items: center; gap: 6px; padding: 0 8px 7px; flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dab-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-quaternary); flex: none; }
.dab-dot.on { background: var(--dsw-alias-state-success-primary); }
.dab-meta-text { flex: auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dab-note { padding: 6px 8px; flex: none; font-size: 11px; color: var(--dsw-alias-state-warning-primary); background: color-mix(in srgb, var(--dsw-alias-state-warning-primary) 10%, transparent); border-bottom: .5px solid var(--dsw-alias-border-l3); }
.dab-block { display: flex; align-items: center; gap: 6px; padding: 6px 8px; flex: none; font-size: 11px; background: color-mix(in srgb, var(--dsw-alias-state-warning-primary) 12%, transparent); }
.dab-block-text { flex: auto; min-width: 0; word-break: break-all; }
.dab-view { position: relative; flex: auto; min-height: 0; background: #fff; }
.dab-webview { width: 100%; height: 100%; border: 0; display: flex; }
.dab-empty { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 10px; align-items: center; justify-content: center; color: var(--dsw-alias-label-quaternary); font-size: 12px; text-align: center; padding: 20px; }
.dab-recent { display: flex; flex-direction: column; gap: 4px; align-items: stretch; width: 100%; max-width: 340px; }
.dab-recent-title { font-size: 11px; opacity: .75; text-align: left; padding-left: 2px; }
.dab-recent-item { font: inherit; font-size: 11px; text-align: left; padding: 5px 8px; border-radius: 6px; cursor: pointer; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-l1); border: .5px solid var(--dsw-alias-border-l2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dab-recent-item:hover { background: var(--dsw-alias-bg-l2); color: var(--dsw-alias-label-primary); }
.dab-scrim { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--dsw-alias-bg-base) 85%, transparent); padding: 16px; }
.dab-card { width: 100%; max-width: 320px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); box-shadow: 0 8px 24px rgba(0,0,0,.18); padding: 14px; }
.dab-card h4 { margin: 0 0 6px; font-size: 12px; }
.dab-card p { margin: 0 0 10px; font-size: 11px; color: var(--dsw-alias-label-tertiary); word-break: break-all; }
.dab-actions { display: flex; gap: 8px; justify-content: flex-end; }
.dab-btn { height: 26px; padding: 0 10px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: inherit; cursor: pointer; font: inherit; }
.dab-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dab-btn.primary { background: var(--dsw-alias-interactive-bg-hover); font-weight: 600; }
.dab-sect { flex: none; border-top: .5px solid var(--dsw-alias-border-l3); }
.dab-sect-head { width: 100%; display: flex; align-items: center; gap: 6px; padding: 7px 8px; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; cursor: pointer; text-align: left; }
.dab-sect-head:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dab-sect-body { padding: 0 8px 8px; display: flex; flex-direction: column; gap: 6px; }
.dab-row { display: flex; gap: 6px; align-items: center; }
.dab-list { display: flex; flex-direction: column; gap: 2px; max-height: 120px; overflow: auto; }
.dab-item { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dab-item code { flex: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dab-x { border: 0; background: transparent; color: var(--dsw-alias-label-quaternary); cursor: pointer; font: inherit; }
.dab-x:hover { color: var(--dsw-alias-state-error-primary); }
.dab-zoom { display: inline-flex; align-items: center; gap: 1px; flex: none; }
.dab-zbtn { min-width: 20px; height: 20px; padding: 0 3px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 4px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; font: inherit; font-size: 11px; line-height: 1; flex: none; }
.dab-zbtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dab-zbtn:disabled { opacity: .35; cursor: default; }
.dab-zval { min-width: 34px; font-variant-numeric: tabular-nums; }
.dab-find { display: flex; align-items: center; gap: 4px; padding: 0 8px 6px; flex: none; }
.dab-find-count { min-width: 44px; flex: none; text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; }
`

    /** 地址栏下方那行只显示 host + 截断的 path，完整 URL 放在 title 里。 */
    function shortUrl(url) {
      if (!url) return ''
      try {
        const parsed = new URL(url)
        const path = parsed.pathname === '/' ? '' : parsed.pathname
        return parsed.host + (path.length > 28 ? path.slice(0, 28) + '…' : path)
      } catch (error) {
        return String(url).slice(0, 40)
      }
    }

    function Panel(props) {
      const controller = props.controller
      const [state, setState] = React.useState(controller.getState())
      const [draft, setDraft] = React.useState('')
      const [showAllowlist, setShowAllowlist] = React.useState(false)
      const viewRef = React.useRef(null)
      const bootRef = React.useRef(false)

      React.useEffect(() => controller.subscribe(() => setState(controller.getState())), [controller])
      React.useEffect(() => {
        if (viewRef.current) controller.attach(viewRef.current)
        return () => controller.detach()
      }, [controller])
      // 标签页一挂载就按需创建 webview（不必等用户再点一次）
      React.useEffect(() => {
        if (bootRef.current) return
        bootRef.current = true
        controller.setOpen(true)
        // 挂载后恢复上次访问的页面（跨 DSH 重启记录在最外层 dsh-app://app 的 localStorage 里）
        const timer = setTimeout(() => { void controller.restoreSession() }, 300)
        return () => clearTimeout(timer)
      }, [controller])

      const consent = state.consent
      const find = state.find || { open: false, text: '', matches: 0, active: 0 }
      const zoomPercent = Math.round(state.zoom * 100)
      const findInputRef = React.useRef(null)
      React.useEffect(() => {
        if (find.open && findInputRef.current) findInputRef.current.focus()
      }, [find.open])

      // 面板内快捷键：Ctrl/Cmd + (+/-/0) 缩放、Ctrl/Cmd+F 查找、Alt+←/→ 前进后退
      const onKeyDown = (event) => {
        const mod = event.ctrlKey || event.metaKey
        const key = event.key
        // 缩放在面板里也支持 Ctrl + / - / 0
        if (mod) {
          if (key === '+' || key === '=') {
            event.preventDefault()
            controller.zoomIn()
            return
          }
          if (key === '-' || key === '_') {
            event.preventDefault()
            controller.zoomOut()
            return
          }
          if (key === '0') {
            event.preventDefault()
            controller.resetZoom()
            return
          }
          if (key === 'f' || key === 'F') {
            event.preventDefault()
            controller.openFind()
            return
          }
          if (key === 'r' || key === 'R') {
            event.preventDefault()
            controller.reload()
            return
          }
        }
        // Alt + 左右：前进 / 后退（与网页内按键桥保持一致）
        if (event.altKey && key === 'ArrowLeft') {
          event.preventDefault()
          controller.back()
          return
        }
        if (event.altKey && key === 'ArrowRight') {
          event.preventDefault()
          controller.forward()
          return
        }
        if (key === 'F5') {
          event.preventDefault()
          controller.reload()
          return
        }
        if (key === 'Escape' && state.loading) {
          event.preventDefault()
          controller.stop()
        }
      }
      // Ctrl+滚轮缩放：必须用原生非被动监听，React 的 onWheel 在被动监听下无法 preventDefault
      const rootRef = React.useRef(null)
      React.useEffect(() => {
        const node = rootRef.current
        if (!node) return undefined
        const handler = (event) => {
          if (!(event.ctrlKey || event.metaKey)) return
          event.preventDefault()
          if (event.deltaY < 0) controller.zoomIn()
          else controller.zoomOut()
        }
        node.addEventListener('wheel', handler, { passive: false })
        return () => node.removeEventListener('wheel', handler)
      }, [controller])

      return h(
        'div',
        { className: 'dab-pane', ref: rootRef, onKeyDown },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dab-bar' },
          h('button', {
            className: 'dab-icon',
            title: '后退',
            disabled: !state.canGoBack,
            onClick: () => controller.back(),
          }, '←'),
          h('button', {
            className: 'dab-icon',
            title: '前进',
            disabled: !state.canGoForward,
            onClick: () => controller.forward(),
          }, '→'),
          h('button', {
            className: 'dab-icon',
            title: state.loading ? '停止加载' : '刷新',
            onClick: () => (state.loading ? controller.stop() : controller.reload()),
          }, state.loading ? '✕' : '↻'),
          h('input', {
            className: 'dab-addr',
            value: state.address,
            placeholder: '输入网址后回车（你自己开页无需确认）',
            spellCheck: false,
            onChange: (event) => controller.setAddress(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void controller.openByUser()
              if (event.key === 'Escape') controller.setAddress(state.page ? state.page.url : '')
            },
          }),
          h('button', { className: 'dab-icon', title: '打开', disabled: state.busy, onClick: () => void controller.openByUser() }, '↵'),
        ),
        h(
          'div',
          { className: 'dab-meta', title: state.page ? state.page.url : '' },
          h('span', { className: 'dab-dot' + (state.connected ? ' on' : '') }),
          h(
            'span',
            { className: 'dab-meta-text' },
            state.loading && !state.page ? '加载中…' : state.page
              ? (state.page.title ? state.page.title + ' · ' : '') + shortUrl(state.page.url)
              : state.connected ? '未打开页面' : '未连接 Host',
          ),
          // 缩放：− 百分比 +（点百分比重置）
          h(
            'span',
            { className: 'dab-zoom' },
            h('button', { className: 'dab-zbtn', title: '缩小 (Ctrl -)', onClick: () => controller.zoomOut() }, '−'),
            h('button', { className: 'dab-zbtn dab-zval', title: '点击重置为 100%', onClick: () => controller.resetZoom() }, zoomPercent + '%'),
            h('button', { className: 'dab-zbtn', title: '放大 (Ctrl +)', onClick: () => controller.zoomIn() }, '+'),
          ),
          h('button', { className: 'dab-zbtn', title: '页面内查找 (Ctrl+F)', onClick: () => (find.open ? controller.closeFind() : controller.openFind()) }, '🔍'),
          h('button', { className: 'dab-zbtn', title: '复制当前地址', onClick: () => void controller.copyAddress() }, '⧉'),
          !state.claimed || !state.connected
            ? h('button', { className: 'dab-x', title: '换发新令牌（令牌被另一个窗口占用时用）', onClick: () => void controller.reclaim() }, '重新认领')
            : null,
        ),
        find.open
          ? h(
              'div',
              { className: 'dab-find' },
              h('input', {
                ref: findInputRef,
                className: 'dab-addr',
                value: find.text,
                placeholder: '在页面中查找',
                spellCheck: false,
                onChange: (event) => controller.find(event.target.value, true),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') controller.findNext(!event.shiftKey)
                  if (event.key === 'Escape') controller.closeFind()
                },
              }),
              h('span', { className: 'dab-find-count' },
                find.text ? (find.matches > 0 ? find.active + '/' + find.matches : '无匹配') : ''),
              h('button', { className: 'dab-zbtn', title: '上一个 (Shift+Enter)', disabled: find.matches === 0, onClick: () => controller.findNext(false) }, '↑'),
              h('button', { className: 'dab-zbtn', title: '下一个 (Enter)', disabled: find.matches === 0, onClick: () => controller.findNext(true) }, '↓'),
              h('button', { className: 'dab-zbtn', title: '关闭 (Esc)', onClick: () => controller.closeFind() }, '✕'),
            )
          : null,
        state.notice ? h('div', { className: 'dab-note' }, state.notice) : null,
        state.blockedRedirect
          ? h(
              'div',
              { className: 'dab-block' },
              h('span', { className: 'dab-block-text' }, '页面想跳到白名单外：' + state.blockedRedirect.url),
              h('button', { className: 'dab-btn', onClick: () => controller.dismissRedirect() }, '忽略'),
              h('button', { className: 'dab-btn primary', onClick: () => void controller.allowRedirect() }, '允许并继续'),
            )
          : null,
        state.windowRequest
          ? h(
              'div',
              { className: 'dab-block' },
              h('span', { className: 'dab-block-text' }, '页面想打开新窗口：' + state.windowRequest.url),
              h('button', { className: 'dab-btn', onClick: () => controller.dismissWindowRequest() }, '忽略'),
              h('button', { className: 'dab-btn primary', onClick: () => void controller.allowWindowRequest() }, '在当前标签打开'),
            )
          : null,
        h(
          'div',
          { className: 'dab-view', ref: viewRef },
          state.page ? null : h('div', { className: 'dab-empty' },
            h('div', null, '输入网址打开页面；AI 可读页面、填表单、点选项/按钮。'),
            (state.recent && state.recent.length > 0)
              ? h('div', { className: 'dab-recent' },
                  h('div', { className: 'dab-recent-title' }, '最近访问（重启 DSH 后仍保留）'),
                  state.recent.slice(0, 6).map((url) => h('button', {
                    key: url,
                    className: 'dab-recent-item',
                    title: url,
                    onClick: () => void controller.navigateTo(url),
                  }, shortUrl(url))),
                )
              : null,
          ),
          consent
            ? h(
                'div',
                { className: 'dab-scrim' },
                h(
                  'div',
                  { className: 'dab-card' },
                  h('h4', null, 'AI 想打开一个白名单外的网址'),
                  h('p', null, consent.url),
                  h('p', null, '允许后本次加载；加入白名单可不再询问。'),
                  h(
                    'div',
                    { className: 'dab-actions' },
                    h('button', { className: 'dab-btn', onClick: () => controller.denyConsent() }, '拒绝'),
                    h('button', { className: 'dab-btn primary', onClick: () => controller.allowConsent() }, '允许打开'),
                  ),
                ),
              )
            : null,
        ),
        // 白名单与打开确认已关闭（openPolicy=free）时，这块整体不显示
        state.policy === 'free'
          ? null
          : h(
              'div',
              { className: 'dab-sect' },
              h(
                'button',
                { className: 'dab-sect-head', onClick: () => setShowAllowlist((value) => !value) },
                (showAllowlist ? '▾ ' : '▸ ') + '受信白名单（' + state.allowlist.length + '）',
              ),
              showAllowlist
                ? h(
                    'div',
                    { className: 'dab-sect-body' },
                    h(
                      'div',
                      { className: 'dab-row' },
                      h('input', {
                        className: 'dab-addr',
                        value: draft,
                        placeholder: '域名（example.com）或网址前缀',
                        spellCheck: false,
                        onChange: (event) => setDraft(event.target.value),
                        onKeyDown: (event) => {
                          if (event.key === 'Enter' && draft.trim()) {
                            void controller.addPattern(draft.trim())
                            setDraft('')
                          }
                        },
                      }),
                      h(
                        'button',
                        {
                          className: 'dab-btn',
                          onClick: () => {
                            if (draft.trim()) {
                              void controller.addPattern(draft.trim())
                              setDraft('')
                            }
                          },
                        },
                        '加入',
                      ),
                    ),
                    h(
                      'div',
                      { className: 'dab-list' },
                      state.allowlist.length === 0
                        ? h('div', { className: 'dab-item' }, '空：AI 每次开页都会先问你')
                        : state.allowlist.map((pattern) =>
                            h(
                              'div',
                              { className: 'dab-item', key: pattern },
                              h('code', { title: pattern }, pattern),
                              h('button', { className: 'dab-x', title: '删除', onClick: () => void controller.removePattern(pattern) }, '×'),
                            ),
                          ),
                    ),
                  )
                : null,
            ),
      )
    }

    /** 侧栏标签上的标题：有页面时跟随页面标题，否则用固定名。 */
    function TabTitle(props) {
      const controller = props.controller
      const [state, setState] = React.useState(controller.getState())
      React.useEffect(() => controller.subscribe(() => setState(controller.getState())), [controller])
      const title = state.page && state.page.title ? state.page.title : 'AI 浏览器'
      return h('span', { title }, title)
    }

    const inject = ['slots', 'sidebarRight', 'sidebarRightTabs']

    function apply(ctx) {
      const controller = createController()
      const openSidebarTab = () => {
        try {
          ctx.sidebarRight.openTab(KIND, { revealIfOpened: false })
        } catch (error) {
          console.error('[dsh-agent-browser] 无法打开侧栏标签：', error)
        }
      }
      // 指令到达而标签页不在时，让控制器能把标签自己打开
      controller.setNeedContainerHook(openSidebarTab)
      // 截图前展开侧栏，避免 visibility:hidden 下拍到空白
      controller.setExpandHook(() => {
        try {
          if (typeof ctx.sidebarRight.isExpanded === 'function' && !ctx.sidebarRight.isExpanded()) {
            ctx.sidebarRight.toggleExpanded()
          }
        } catch (error) {
          /* 侧栏 API 不可用时忽略 */
        }
      })
      ctx.effect(() => {
        controller.start()
        return () => controller.dispose()
      }, 'dsh-agent-browser: controller')
      // 标签类型：kind 用于 openTab，guide 给用户一个手动入口
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TYPE_ID,
        kind: KIND,
        priority: 'builtin',
        keepMounted: true,
        title: () => 'AI 浏览器',
        guide: [{
          id: 'open',
          order: 40,
          title: () => 'AI 浏览器',
          description: () => '让 AI 读页面、填表单、按 click:true 点击控件（不按回车、不主动提交）',
        }],
      }), 'dsh-agent-browser: tab type')
      // 标签内容：key 必须等于类型 id
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TYPE_ID,
      }, () => h(Panel, { controller }))), 'dsh-agent-browser: tab body')
      // 标签标题：有页面时跟随页面标题（DSH 允许标题单独注册，缺省则用打开时捕获的文本）
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: TYPE_ID,
      }, () => h(TabTitle, { controller }))), 'dsh-agent-browser: tab title')
    }

    // __createController / __scripts 供自测使用；DSH 只读 inject / apply。
    return { inject, apply, __createController: createController, __scripts: { READ_SRC, fillSrc, KEY_BRIDGE_SRC, navBridgeSrc } }
  },
})
