// ==UserScript==
// @name         智慧树登录助手（自动填学校 / 勾协议 / 登录）
// @namespace    local.deepseek.zhs-login-helper
// @version      1.1.0
// @description  在智慧树新登录页自动勾选「我已阅读并同意」、切到学号登录、填入并选择学校（默认山东财经大学）；等浏览器自动填充已保存的账号密码后再点登录；遇到滑块/验证码会提示你手动完成，通过后自动继续。
// @author       local
// @match        *://login.zhihuishu.com/*
// @match        *://passport.zhihuishu.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ===================== 配置与存储 ===================== */

  const VERSION = '1.1.0';
  const STORE_KEY = 'zhs_login_helper_v2';
  const DEFAULTS = {
    school: '山东财经大学',
    autoAgree: true,
    autoLogin: true,
    collapsed: false,
    left: null,
    top: null
  };
  const cfg = Object.assign({}, DEFAULTS);

  function gmGet(k, d) {
    try {
      if (typeof GM_getValue === 'function') {
        const v = GM_getValue(k, undefined);
        return v === undefined ? d : v;
      }
      const raw = localStorage.getItem(k);
      return raw == null ? d : JSON.parse(raw);
    } catch (e) {
      return d;
    }
  }
  function gmSet(k, v) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(k, v);
      else localStorage.setItem(k, JSON.stringify(v));
    } catch (e) {}
  }

  function loadCfg() {
    const saved = gmGet(STORE_KEY, null);
    if (saved && typeof saved === 'object') Object.assign(cfg, saved);
  }
  function saveCfg() {
    gmSet(STORE_KEY, cfg);
  }

  const logs = [];
  function log(msg, kind) {
    const line = '[' + new Date().toTimeString().slice(0, 8) + '] ' + msg;
    logs.push(line);
    if (logs.length > 120) logs.shift();
    if (kind === 'error') console.warn('[登录助手] ' + msg);
    else console.log('[登录助手] ' + msg);
    render();
  }

  /* ===================== DOM 工具 ===================== */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function $(sel, scope) {
    try {
      return (scope || document).querySelector(sel);
    } catch (e) {
      return null;
    }
  }
  function $$(sel, scope) {
    try {
      return Array.prototype.slice.call((scope || document).querySelectorAll(sel));
    } catch (e) {
      return [];
    }
  }
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || 1) > 0.05;
  }
  function norm(t) {
    return String(t == null ? '' : t).replace(/\s+/g, '');
  }
  function textOf(el) {
    if (!el) return '';
    return norm(el.innerText || el.textContent || '');
  }
  // 在候选里按「文本包含」找可见元素（要求元素本身是叶子/按钮，不选包住一切的容器）
  function findByText(selector, re, scope) {
    const all = $$(selector, scope);
    const hit = [];
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!visible(el)) continue;
      const t = textOf(el);
      if (!t || !re.test(t)) continue;
      // 只要最内层：如果子元素里还有同样命中的，就跳过当前
      const inner = $$('*', el).filter((c) => visible(c) && re.test(textOf(c)));
      if (inner.length) continue;
      hit.push(el);
    }
    return hit;
  }
  function setNativeValue(el, value) {
    try {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
    } catch (e) {
      el.value = value;
    }
    ['input', 'change'].forEach((type) => {
      try {
        el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
      } catch (e) {}
    });
  }
  function fire(el, type) {
    try {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    } catch (e) {
      try {
        el.click();
      } catch (e2) {}
    }
  }
  function realClick(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: 'center' });
    } catch (e) {}
    fire(el, 'mousedown');
    fire(el, 'mouseup');
    fire(el, 'click');
    return true;
  }

  /* ===================== 页面识别 ===================== */

  const onLoginPage = () => /login\.zhihuishu\.com|passport\.zhihuishu\.com/i.test(location.host);

  function agreementBox() {
    // 1) 智慧树新页的结构：label.el-checkbox.privacy-checkbox > input.el-checkbox__original
    const direct = $('label.privacy-checkbox input[type=checkbox], .privacy-con input[type=checkbox], .privacy input[type=checkbox]');
    if (direct) return direct;
    // 2) 兜底：文本含「我已阅读」的可见复选框
    const boxes = $$('input[type=checkbox]');
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const label = b.closest('label') || b.parentElement;
      const t = textOf(label) + textOf(b.parentElement);
      if (/我已阅读|已经阅读|阅读并同意/.test(t)) return b;
    }
    return null;
  }
  function isChecked(box) {
    return !!box && (box.checked === true || box.getAttribute('aria-checked') === 'true');
  }
  function tickAgreement() {
    const box = agreementBox();
    if (!box) return false;
    if (isChecked(box)) return true;
    // 原生 click() 会触发浏览器默认行为并让 Element Plus 的 v-model 同步
    try {
      box.click();
    } catch (e) {}
    if (!isChecked(box)) {
      const label = box.closest('label');
      if (label) {
        try {
          label.click();
        } catch (e) {}
      }
    }
    if (!isChecked(box)) {
      // 最后兜底：手动改属性再派发 change（部分自定义组件只监听 change）
      try {
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) {}
    }
    return isChecked(box);
  }

  function studentTab() {
    const byId = $('#tab-2');
    if (byId && visible(byId)) return byId;
    const list = findByText('.el-tabs__item, .login-tabs__item, [role=tab], li, a, span, div', /学号登录/);
    return list[0] || null;
  }

  function schoolInputs() {
    const out = [];
    $$('input').forEach((el) => {
      if (!visible(el)) return;
      const ph = (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '');
      if (/学校|机构|院校/.test(ph)) out.push(el);
    });
    return out;
  }
  function schoolSelectWrapper() {
    const wrappers = $$('.el-select__wrapper, .el-select, .select-wrapper, .institution-select');
    for (let i = 0; i < wrappers.length; i++) {
      const w = wrappers[i];
      if (!visible(w)) continue;
      const t = textOf(w);
      if (/学校|机构|院校|请选择/.test(t)) return w;
    }
    return null;
  }

  function dropdownOptions() {
    const sels = [
      '.el-select-dropdown__item',
      '.el-popper li',
      '.el-select-dropdown li',
      '.el-autocomplete-suggestion li',
      '.dropdown-menu li',
      '.institution-list li',
      'li'
    ];
    const out = [];
    sels.forEach((s) => {
      $$(s).forEach((el) => {
        if (!visible(el)) return;
        const t = textOf(el);
        if (t) out.push({ el: el, text: t });
      });
    });
    return out;
  }

  function credentialInputs() {
    const res = { id: null, pwd: null, idValue: '', pwdValue: '' };
    $$('input').forEach((el) => {
      if (!visible(el)) return;
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      const ph = (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('name') || '') + ' ' + (el.getAttribute('autocomplete') || '');
      if (type === 'password') {
        if (!res.pwd) res.pwd = el;
        return;
      }
      if (/学号|工号|账号|手机号|用户名|user|account|mobile/i.test(ph)) {
        if (!res.id) res.id = el;
      }
    });
    if (res.id) res.idValue = String(res.id.value || '').trim();
    if (res.pwd) res.pwdValue = String(res.pwd.value || '');
    return res;
  }

  function loginButton() {
    const direct =
      $('.btn-block__grandient_login') ||
      $('.login-btn') ||
      $('.btn-login') ||
      $('button[type=submit]');
    if (direct && visible(direct) && /登录|登陆/.test(textOf(direct))) return direct;
    const list = findByText('.base-button-component, button, div, span, a', /^(登录|登\s*录)$/);
    return list[0] || null;
  }

  function captchaVisible() {
    const s = ['#ableCaptchaEl', '.yidun', '.yidun_intelli-tips', '.captcha', '.verify-slide', 'iframe[src*="captcha"]', '.NC_scale', '.slide-verify'];
    for (let i = 0; i < s.length; i++) {
      const el = $(s[i]);
      if (el && visible(el)) return el;
    }
    return null;
  }

  /* ===================== 主流程 ===================== */

  let running = false;
  let done = { agree: false, tab: false, school: false, login: false };

  function resetDone() {
    done = { agree: false, tab: false, school: false, login: false };
  }

  async function ensureAgreement() {
    if (!cfg.autoAgree) return false;
    for (let i = 0; i < 5; i++) {
      if (tickAgreement()) {
        if (!done.agree) log('已勾选「我已阅读并同意」');
        done.agree = true;
        return true;
      }
      await sleep(350);
    }
    return false;
  }

  async function ensureStudentTab() {
    // 账号登录页也要保证在「学号登录」tab，才填学校
    const tab = studentTab();
    if (!tab) {
      log('页面里没有「学号登录」tab，跳过选学校');
      return false;
    }
    const active = /active|is-active/.test(tab.className || '') || tab.getAttribute('aria-selected') === 'true';
    if (!active) {
      realClick(tab);
      log('已切换到「学号登录」');
      await sleep(900);
    }
    done.tab = true;
    return true;
  }

  async function fillSchool() {
    if (!cfg.school) return;
    const target = cfg.school;
    // 1) 先找原生 input（有 placeholder 的学校输入框）
    let input = null;
    for (let i = 0; i < 6 && !input; i++) {
      input = schoolInputs()[0] || null;
      if (!input) {
        const wrap = schoolSelectWrapper();
        if (wrap && !$('input', wrap)) realClick(wrap);
        await sleep(400);
        input = $('input', schoolSelectWrapper() || document);
      }
      if (!input) await sleep(300);
    }

    if (input) {
      realClick(input);
      setNativeValue(input, target);
      log('已填入学校：' + target);
      await sleep(1000);
    } else {
      log('没找到学校输入框，先点开选择框重试…', 'warn');
      const wrap = schoolSelectWrapper();
      if (wrap) {
        realClick(wrap);
        await sleep(700);
        input = $('input', wrap) || $('.el-select-dropdown input') || null;
        if (input) {
          realClick(input);
          setNativeValue(input, target);
          log('已填入学校：' + target);
          await sleep(1000);
        }
      }
    }

    // 2) 在展开的候选项里点「山东财经大学」
    const re = new RegExp(target.replace(/[()（）\[\]{}.*+?^$|\\]/g, ''));
    for (let i = 0; i < 8; i++) {
      const opts = dropdownOptions();
      const hit = opts.find((o) => re.test(o.text) && o.text.length <= target.length + 8);
      if (hit) {
        realClick(hit.el);
        log('已选择学校：' + hit.text);
        done.school = true;
        return true;
      }
      if (i === 2 && opts.length) {
        log('候选里没看到目标学校，当前候选：' + opts.slice(0, 6).map((o) => o.text).join(' / '), 'warn');
      }
      await sleep(450);
    }
    log('没能在下拉里选中「' + target + '」，可点「重试」或手动选一下', 'warn');
    return false;
  }

  // 浏览器保存过账号密码时，点/聚焦输入框会触发自动填充；这里等它填上
  async function waitCredentials(timeout) {
    const deadline = Date.now() + (timeout || 12000);
    let focused = false;
    while (Date.now() < deadline) {
      const cred = credentialInputs();
      if (cred.idValue && cred.pwdValue) return cred;
      if (!focused && cred.id) {
        try {
          cred.id.focus();
          cred.id.click();
          if (cred.pwd) cred.pwd.focus();
        } catch (e) {}
        focused = true;
        log('已聚焦账号/密码框，等浏览器自动填充…');
      }
      await sleep(400);
    }
    return credentialInputs();
  }

  async function doLogin(force) {
    if (!force && !cfg.autoLogin) return;
    const btn = loginButton();
    if (!btn) {
      log('没找到「登录」按钮', 'warn');
      return;
    }
    let cred = credentialInputs();
    if ((!cred.idValue || !cred.pwdValue) && !force) {
      log('学号/密码还是空的，等你保存的账号自动填充…');
      cred = await waitCredentials(12000);
    }
    if (!cred.idValue || !cred.pwdValue) {
      log(
        force
          ? '学号/密码为空，请手动填好后浏览器/点「立即登录」'
          : '没等到自动填充：点一下学号/密码框让浏览器填入，然后点面板「立即登录」',
        'warn'
      );
      if (!force) return;
    }
    realClick(btn);
    done.login = true;
    log('已点击「登录」');
    // 验证码：脚本不代替你过，但检测到会提示，并在消失后自动继续
    let cap = captchaVisible();
    for (let i = 0; i < 16 && !cap; i++) {
      await sleep(500);
      cap = captchaVisible();
    }
    if (cap) {
      log('出现验证码/滑块：请在页面上手动完成，完成后我会自动继续', 'warn');
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline && captchaVisible()) await sleep(700);
      if (!captchaVisible()) {
        log('验证码已通过，等待页面跳转');
        await sleep(1500);
        const b2 = loginButton();
        if (b2 && visible(b2) && !captchaVisible() && !/gologin|studyspace|home/i.test(location.href)) {
          realClick(b2);
          log('再点一次「登录」');
        }
      }
    } else {
      log('未出现验证码；若弹出短信/扫码二次验证，按页面提示完成');
    }
  }

  async function runAll(opts) {
    if (running) return;
    if (!onLoginPage()) return;
    running = true;
    resetDone();
    try {
      log('开始执行（v' + VERSION + '，学校：' + cfg.school + '）');
      // 协议可能挂在账号登录页，也可能在学号登录页：切换前后各试一次
      await ensureAgreement();
      const okTab = await ensureStudentTab();
      if (!done.agree) await ensureAgreement();
      if (okTab) await fillSchool();
      if (!done.agree) await ensureAgreement();
      if (!done.agree && cfg.autoAgree) log('没找到协议勾选框，可能当前登录方式不需要勾选', 'warn');
      await doLogin(false);
      log('本轮执行结束');
    } catch (e) {
      log('执行出错：' + (e && e.message ? e.message : e), 'error');
    } finally {
      running = false;
      render();
    }
  }

  /* ===================== 面板 ===================== */

  let host = null;
  let shadow = null;
  let panel = null;

  const TEMPLATE = `
    <style>
      :host { all: initial; }
      .panel { position: fixed; z-index: 2147483647; right: 16px; bottom: 130px; width: 278px;
        background: #1f2329; color: #e9ecf1; border: 1px solid #3a414d; border-radius: 10px;
        box-shadow: 0 10px 28px rgba(0,0,0,.45); font: 12px/1.6 "Microsoft YaHei", system-ui, sans-serif;
        user-select: none; overflow: hidden; }
      .hd { display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: #262b33; cursor: move; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #2ea043; }
      .ttl { font-weight: 600; flex: 1; }
      .hd button { background: transparent; border: 0; color: #9aa4b2; cursor: pointer; font-size: 14px; padding: 0 4px; }
      .hd button:hover { color: #fff; }
      .bd { padding: 8px 10px 10px; }
      .status { font-size: 11px; color: #9aa4b2; padding: 2px 0 6px; word-break: break-all; }
      .row { display: flex; align-items: center; gap: 6px; margin: 5px 0; }
      .row label { color: #c7cdd6; }
      .row input[type=text] { flex: 1; min-width: 0; background: #2b313b; color: #e9ecf1; border: 1px solid #414855;
        border-radius: 5px; padding: 4px 6px; font: 12px/1.4 "Microsoft YaHei"; }
      .sw { display: flex; align-items: center; gap: 6px; color: #c7cdd6; }
      .btns { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
      .btns button { flex: 1; min-width: 64px; padding: 6px 0; border-radius: 6px; border: 1px solid #414855;
        background: #2b313b; color: #e9ecf1; cursor: pointer; font: 12px "Microsoft YaHei"; }
      .btns button.pri { background: #2563eb; border-color: #2563eb; color: #fff; }
      .btns button:hover { filter: brightness(1.15); }
      .log { margin-top: 8px; max-height: 132px; overflow: auto; background: #14171c; border: 1px solid #2f3540;
        border-radius: 6px; padding: 6px; font: 11px/1.55 Consolas, "Microsoft YaHei", monospace; color: #b9c2cf;
        white-space: pre-wrap; word-break: break-all; }
      .log .e { color: #ff9d9d; }
      .log .w { color: #ffd479; }
      .log .o { color: #7ee787; }
      .hint { margin-top: 6px; font-size: 11px; color: #8b95a3; line-height: 1.55; }
      .collapsed .bd { display: none; }
    </style>
    <div class="panel">
      <div class="hd"><span class="dot"></span><span class="ttl">登录助手 ${VERSION}</span>
        <button data-act="collapse">–</button></div>
      <div class="bd">
        <div class="status" data-t="status">初始化…</div>
        <div class="row"><label>学校</label>
          <input type="text" data-in="school" placeholder="学校名称">
        </div>
        <div class="row">
          <label class="sw"><input type="checkbox" data-sw="autoAgree"> 自动勾选协议</label>
          <label class="sw"><input type="checkbox" data-sw="autoLogin"> 自动登录</label>
        </div>
        <div class="btns">
          <button class="pri" data-act="run">立即执行</button>
          <button data-act="login">立即登录</button>
          <button data-act="retry">重试选校</button>
        </div>
        <div class="log" data-box="log"></div>
        <div class="hint">自动执行：勾协议 → 切「学号登录」→ 填并选中学校 → （学号密码已填时）点登录。滑块/验证码需手动完成。</div>
      </div>
    </div>`;

  function buildUI() {
    if (host) return;
    host = document.createElement('div');
    host.id = '__zhs_login_helper_host';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = TEMPLATE;
    panel = shadow.querySelector('.panel');
    (document.body || document.documentElement).appendChild(host);

    shadow.querySelector('[data-in=school]').value = cfg.school;
    shadow.querySelector('[data-sw=autoAgree]').checked = !!cfg.autoAgree;
    shadow.querySelector('[data-sw=autoLogin]').checked = !!cfg.autoLogin;
    if (cfg.collapsed) panel.classList.add('collapsed');
    if (cfg.left != null && cfg.top != null) {
      panel.style.left = cfg.left + 'px';
      panel.style.top = cfg.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }

    shadow.querySelector('[data-in=school]').addEventListener('change', (e) => {
      cfg.school = String(e.target.value || '').trim() || DEFAULTS.school;
      e.target.value = cfg.school;
      saveCfg();
      render();
    });
    shadow.querySelectorAll('[data-sw]').forEach((el) => {
      el.addEventListener('change', () => {
        cfg[el.getAttribute('data-sw')] = el.checked;
        saveCfg();
      });
    });
    shadow.querySelector('[data-act=run]').addEventListener('click', () => runAll());
    shadow.querySelector('[data-act=login]').addEventListener('click', () => doLogin(true));
    shadow.querySelector('[data-act=retry]').addEventListener('click', async () => {
      log('重试选校…');
      await ensureStudentTab();
      await fillSchool();
    });
    shadow.querySelector('[data-act=collapse]').addEventListener('click', () => {
      cfg.collapsed = !cfg.collapsed;
      panel.classList.toggle('collapsed', cfg.collapsed);
      saveCfg();
    });

    // 拖动
    const hd = shadow.querySelector('.hd');
    let drag = null;
    hd.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const x = Math.max(0, Math.min(window.innerWidth - 280, e.clientX - drag.dx));
      const y = Math.max(0, Math.min(window.innerHeight - 80, e.clientY - drag.dy));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      drag = null;
      const r = panel.getBoundingClientRect();
      cfg.left = Math.round(r.left);
      cfg.top = Math.round(r.top);
      saveCfg();
    });
  }

  function render() {
    if (!shadow) return;
    const st = shadow.querySelector('[data-t=status]');
    if (st) {
      const flags = [];
      flags.push(done.agree ? '协议✓' : '协议');
      flags.push(done.tab ? '学号登录✓' : '学号登录');
      flags.push(done.school ? '学校✓' : '学校');
      flags.push(done.login ? '已登录' : '未登录');
      st.textContent = flags.join(' · ');
    }
    const box = shadow.querySelector('[data-box=log]');
    if (box) {
      const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
      box.innerHTML = logs
        .slice(-40)
        .map((l) => {
          const cls = /出错|失败|没找到|找不到/.test(l) ? 'e' : /没能在|还没填|需要手动|没看到|不需要/.test(l) ? 'w' : /已点击|已选择|已填入|已勾选|已切换|完成/.test(l) ? 'o' : '';
          return '<div class="' + cls + '">' + esc(l) + '</div>';
        })
        .join('');
      box.scrollTop = box.scrollHeight;
    }
  }

  /* ===================== 启动 ===================== */

  function boot() {
    loadCfg();
    if (!onLoginPage()) return;
    buildUI();
    log('v' + VERSION + ' 已加载：' + location.href);
    render();
    // 等 SPA 渲染完
    setTimeout(() => runAll(), 900);
    // 若页面异步渲染较慢，再补一次
    setTimeout(() => {
      if (!done.school && !done.login) runAll();
    }, 3800);
  }

  // GM 菜单
  try {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('立即执行登录助手', () => runAll());
      GM_registerMenuCommand('切换自动登录', () => {
        cfg.autoLogin = !cfg.autoLogin;
        saveCfg();
        buildUI();
        if (shadow) shadow.querySelector('[data-sw=autoLogin]').checked = cfg.autoLogin;
        log('自动登录已' + (cfg.autoLogin ? '开启' : '关闭'));
      });
      GM_registerMenuCommand('重置收起状态', () => {
        cfg.collapsed = false;
        saveCfg();
        if (panel) panel.classList.remove('collapsed');
      });
    }
  } catch (e) {}

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 暴露调试句柄
  window.__zhsLoginHelper = {
    version: VERSION,
    run: runAll,
    login: () => doLogin(true),
    fillSchool,
    tickAgreement,
    state: () => ({ done: Object.assign({}, done), cfg: Object.assign({}, cfg) })
  };
})();
