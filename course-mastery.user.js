// ==UserScript==
// @name         掌握度助手 · 自动练题并回填题库（本地 AI）
// @namespace    local.ai-tiku.mastery
// @version      0.6.0
// @description  智慧树「掌握度」页：自动点知识点「提升掌握度」，在练习页用本地 AI 答题，提交后回填正确答案与解析，然后返回继续下一个知识点
// @author       local
// @match        https://studywisdomh5.zhihuishu.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '0.6.0';
  const HOST_ID = '__mastery_helper_host';
  const SEARCH_URL = 'http://127.0.0.1:8765/search';
  const CORRECT_URL = 'http://127.0.0.1:8765/correct';
  const WRONG_URL = 'http://127.0.0.1:8765/wrong';
  const HEALTH_URL = 'http://127.0.0.1:8765/health';
  const DIAGNOSE_URL = 'http://127.0.0.1:8765/diagnose';

  const DEFAULTS = {
    enabled: false,
    maxPoints: 20,       // 最多处理多少个知识点
    maxQuestions: 12,    // 单个知识点练习最多答多少题
    autoNext: true,      // 处理完一个知识点后自动下一个
  };

  const store = {
    get(key, def) {
      try {
        const v = typeof GM_getValue === 'function' ? GM_getValue(key, null) : localStorage.getItem('mastery.' + key);
        if (v == null || v === '') return def;
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch (e) { return def; }
    },
    set(key, val) {
      try {
        const s = JSON.stringify(val);
        if (typeof GM_setValue === 'function') GM_setValue(key, s);
        else localStorage.setItem('mastery.' + key, s);
      } catch (e) { /* ignore */ }
    },
  };

  const cfg = Object.assign({}, DEFAULTS, store.get('cfg', {}));
  const done = new Set(store.get('done', []));

  // 0.4.x 前期版本读错过掌握度，升级后清掉被污染的缓存（含被误标 100% 的 done）
  if (store.get('ratesVer') !== VERSION) {
    store.set('rates', {});
    store.set('done', []);
    done.clear();
    store.set('ratesVer', VERSION);
  }

  const state = {
    running: false,
    busy: false,
    phase: 'idle',
    logs: [],
    good: 0,
    bad: 0,
    corrected: 0,
    currentPoint: '',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const fire = (el, type) => {
    if (!el) return;
    try {
      if (typeof el.click === 'function') { el.click(); return; }
      el.dispatchEvent(new MouseEvent(type || 'click', { bubbles: true, cancelable: true }));
    } catch (e) { /* ignore */ }
  };

  function log(msg, type) {
    const t = new Date().toTimeString().slice(0, 8);
    state.logs.push({ t, msg, type: type || 'info' });
    if (state.logs.length > 300) state.logs.splice(0, state.logs.length - 300);
    render();
  }

  function gmJson(method, url, data, timeout) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method,
          url,
          headers: { 'Content-Type': 'application/json' },
          data: data ? JSON.stringify(data) : undefined,
          timeout: timeout || 60000,
          onload: (r) => {
            try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(new Error('返回不是 JSON')); }
          },
          onerror: () => reject(new Error('请求失败')),
          ontimeout: () => reject(new Error('超时')),
        });
      } else {
        fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: data ? JSON.stringify(data) : undefined,
        }).then((r) => r.json()).then(resolve).catch(reject);
      }
    });
  }

  // ---------- 自动诊断上报（打开页面 3 秒后自动发，无需手动操作） ----------
  let diagSent = 0;
  function collectDiag() {
    const bodyText = textOf(document.body).slice(0, 6000);
    const items = [];
    const seen = new Set();
    const nodes = Array.from(document.querySelectorAll('*'));
    for (const el of nodes) {
      const t = textOf(el);
      if (!t || t.length > 120) continue;
      if (!/提升掌握度|掌握度|提交作答|正确答案|答案解析|回答正确|回答错误|出题|练习|开始练习|下一题|返回|请选择|[A-H][.、．]/.test(t)) continue;
      const key = el.tagName + '|' + String(el.className || '') + '|' + t.slice(0, 30);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 120), text: t, visible: isVisible(el) });
      if (items.length >= 120) break;
    }
    // 结构树：热力图区域所有元素（class + 文本），用来确定知识点卡片/按钮的真实结构
    const tree = [];
    const root = (document.querySelector('.mastery-top') && document.querySelector('.mastery-top').parentElement) ||
      (document.querySelector('.mastery-data-ul') && document.querySelector('.mastery-data-ul').parentElement) ||
      document.body;
    (function walk(el, depth) {
      if (!el || depth > 8 || tree.length > 700) return;
      for (const child of Array.from(el.children)) {
        if (tree.length > 700) return;
        tree.push({
          d: depth,
          tag: child.tagName,
          cls: String(child.className || '').slice(0, 110),
          text: (child.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        });
        walk(child, depth + 1);
      }
    })(root, 0);

    return { url: location.href, kind: isExamPage() ? 'exam' : isMasteryPage() ? 'mastery' : 'other', bodyText, items, tree };
  }
  async function reportLog(reason) {
    try {
      await gmJson('POST', DIAGNOSE_URL, {
        url: location.href,
        kind: 'log',
        reason,
        lines: state.logs.slice(-40).map((l) => '[' + l.t + '] ' + l.msg),
        phase: state.phase,
        running: state.running,
        cfg: { enabled: cfg.enabled, maxPoints: cfg.maxPoints, maxQuestions: cfg.maxQuestions },
      }, 15000);
    } catch (e) { /* ignore */ }
  }

  async function reportDiag(reason) {
    if (reason !== '手动诊断' && diagSent > 5) return;
    diagSent++;
    try {
      const res = await gmJson('POST', DIAGNOSE_URL, { ...collectDiag(), reason }, 15000);
      if (res && res.ok) log('已自动上报页面结构给本地服务（' + reason + '）', 'info');
    } catch (e) { /* 静默 */ }
  }

  // ---------- 页面识别 ----------
  const isMasteryPage = () => /\/study\/mastery/.test(location.pathname + location.search);
  const isExamPage = () => /\/exam(\?|$)/.test(location.pathname + location.search);
  const isOtherStudy = () => !isMasteryPage() && !isExamPage();

  // ---------- 掌握度页：找知识点 + 提升掌握度 ----------
  // 知识点 = li.item-box，颜色代表掌握状态：gray 遗漏 > pink 薄弱 > origin 一般 > green 较好；blue 免考
  const STATUS_RANK = { gray: 1, pink: 2, origin: 3, green: 4, blue: 9 };
  function pointItems() {
    const out = [];
    document.querySelectorAll('li.item-box').forEach((li) => {
      if (!isVisible(li)) return;
      const nameEl = li.querySelector('.item-box-name') || li;
      const name = textOf(nameEl).slice(0, 60);
      if (!name) return;
      const cls = String(li.className || '');
      let status = 'green';
      for (const k of ['blue', 'gray', 'pink', 'origin']) {
        if (new RegExp('\\b' + k + '\\b').test(cls)) status = k;
      }
      out.push({ li, nameEl, name, status, rank: STATUS_RANK[status] || 5 });
    });
    return out;
  }

  function hoverEl(el) {
    const types = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove'];
    types.forEach((tp) => {
      try {
        const Ev = tp.indexOf('pointer') === 0 && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ev(tp, { bubbles: true, cancelable: true, view: window }));
      } catch (e) { /* ignore */ }
    });
    // 有些组件依赖真实坐标，补一次 elementFromPoint 命中
    try {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        el.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, cancelable: true, view: window,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        }));
      }
    } catch (e) { /* ignore */ }
  }

  async function findPopoverButton() {
    for (let i = 0; i < 12; i++) {
      await sleep(200);
      const btns = Array.from(document.querySelectorAll('.el-popper button, .el-popover button, .el-popper .el-button'));
      const hit = btns.find((b) => isVisible(b) && /提升掌握度/.test(textOf(b)));
      if (hit) return hit;
    }
    return null;
  }

  async function waitExamPage(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (isExamPage() || /提交作答/.test(textOf(document.body))) return true;
      await sleep(500);
    }
    return false;
  }

  function dismissOverlays() {
    try {
      var btns = Array.from(document.querySelectorAll('button,div,span,i,img'));
      var hit = btns.find(function (e) {
        if (e.childElementCount) return false;
        var t = (e.innerText || e.getAttribute('alt') || '').trim();
        return /^(已绑定,不再提示|下次再说|我知道了|知道了)$/.test(t);
      });
      if (hit) { hit.click(); log('处理了页面弹窗：' + (hit.innerText || '').trim().slice(0, 12), 'info'); }
    } catch (e) {}
  }

  const norm = (s) => String(s || '').replace(/\s+/g, '');

  // 按「知识点名」匹配弹层再取掌握度：页面里常驻大量 mastery 弹层（100% 的也在），
  // 不能随手拿第一个可见弹层的数字。
  function readMasteryRate(name) {
    const want = norm(name);
    const pops = Array.from(document.querySelectorAll('.el-popper.mastery-box-custom-popover, .el-popover.mastery-box-custom-popover')).filter(isVisible);
    const loose = [];
    for (const p of pops) {
      const t = norm(p.innerText || p.textContent || '');
      const m = /掌握度[：:](\d+(?:\.\d+)?)%/.exec(t);
      if (!m) continue;
      const rate = Number(m[1]);
      if (!want) return rate;
      if (t.indexOf(want) === 0) return rate;
      if (t.indexOf(want) >= 0) loose.push(rate);
    }
    if (loose.length) return loose[0];
    return null;
  }

  async function hoverAndReadRate(cand) {
    hoverEl(cand.li);
    hoverEl(cand.nameEl);
    for (let i = 0; i < 7; i++) {
      await sleep(i === 0 ? 350 : 200);
      const r = readMasteryRate(cand.name);
      if (r != null) return r;
      if (i === 2) {
        hoverEl(cand.li);
        hoverEl(cand.nameEl);
      }
    }
    return null;
  }

  async function doMasteryStep() {
    dismissOverlays();
    if (state.busy) return;
    state.busy = true;
    try {
      if (isMasteryPage()) store.set('masteryUrl', stripAutostart(location.href));
      let all = pointItems();
      for (let w = 0; w < 30 && !all.length; w++) {
        await sleep(500);
        all = pointItems();
      }
      if (!all.length) {
        log('没找到知识点卡片（li.item-box）：页面可能没加载完或结构变了', 'warn');
        state.running = false;
        return;
      }
      const todo = all.filter((x) => x.rank <= 4 && !done.has(x.name)).sort((a, b) => a.rank - b.rank);
      const stat = {};
      all.forEach((x) => { stat[x.status] = (stat[x.status] || 0) + 1; });
      log('知识点 ' + all.length + ' 个（遗漏 ' + (stat.gray || 0) + ' / 薄弱 ' + (stat.pink || 0) + ' / 一般 ' + (stat.origin || 0) + ' / 较好 ' + (stat.green || 0) + ' / 免考 ' + (stat.blue || 0) + '），待处理 ' + todo.length + ' 个');
      if (!todo.length) {
        log('没有需要提升的知识点了（已掌握/免考/都处理过），结束', 'ok');
        state.running = false;
        return;
      }
      const rates = store.get('rates', {}) || {};
      let next = null;
      let nextRate = null;
      let nextUnknown = null;
      for (const cand of todo) {
        let rate = rates[cand.name];
        if (rate == null) {
          log('检查「' + cand.name + '」的掌握度…');
          rate = await hoverAndReadRate(cand);
          if (rate != null) {
            rates[cand.name] = rate;
            store.set('rates', rates);
          }
        }
        if (rate == null) {
          if (!nextUnknown) nextUnknown = cand;
          continue;
        }
        if (rate >= 100) {
          log('「' + cand.name + '」已 ' + rate + '%，跳过', 'ok');
          done.add(cand.name);
          store.set('done', Array.from(done));
          continue;
        }
        next = cand;
        nextRate = rate;
        break;
      }
      if (!next && nextUnknown) {
        next = nextUnknown;
        nextRate = null;
        log('读不到「' + next.name + '」的弹层掌握度，按薄弱点处理它');
      }
      if (!next) {
        log('能提升的知识点都已 100%（或免考/都处理过），结束', 'ok');
        state.running = false;
        return;
      }
      state.currentPoint = next.name;
      await reportLog('选择知识点');
      log('目标：' + next.name + '（' + next.status + (nextRate != null ? '，当前 ' + nextRate + '%' : '') + '），唤出「提升掌握度」…');
      hoverEl(next.li);
      hoverEl(next.nameEl);
      hoverEl(next.li);
      hoverEl(next.nameEl);
      let btn = await findPopoverButton();
      if (!btn) {
        // 再试两轮 hover（Element 的 tooltip 可能有 200~400ms 延迟）
        await sleep(300);
        hoverEl(next.li);
        hoverEl(next.nameEl);
        btn = await findPopoverButton();
      }
      const popovers = Array.from(document.querySelectorAll('.el-popper, .el-popover'))
        .filter((p) => isVisible(p)).slice(0, 5).map((p) => textOf(p).slice(0, 40));
      log('可见弹层：' + (popovers.length ? popovers.join(' | ') : '无'));
      await reportLog('悬停之后');
      if (!btn) {
        log('没唤出按钮，改为直接点击知识点', 'warn');
        fire(next.nameEl);
      } else {
        log('已找到「提升掌握度」，点击进入练习', 'ok');
        fire(btn);
      }
      if (await waitExamPage(15000)) {
        log('已进入练习页，接下来逐题作答', 'ok');
        await reportLog('进入练习页');
        return;
      }
      log('点击后没进入练习页（可能按钮位置/弹层结构不同）', 'warn');
      await reportLog('跳转失败');
    } finally {
      state.busy = false;
      render();
    }
  }

  // ---------- 练习页：读题 / 答题 / 提交 ----------
  const EXAM_ITEM_SEL = '.exam-item';
  function currentExamItem() {
    const items = Array.from(document.querySelectorAll(EXAM_ITEM_SEL)).filter(isVisible);
    return items[0] || null;
  }
  function typeOfItem(item) {
    const t = textOf(item.querySelector('.quest-type'));
    if (/多选/.test(t)) return 'multiple';
    if (/判断/.test(t)) return 'judgement';
    if (/填空/.test(t)) return 'completion';
    return 'single';
  }
  function stemOfItem(item) {
    const p = item.querySelector('.quest-title .option-name');
    const s = textOf(p) || textOf(item.querySelector('.quest-title'));
    return s.replace(/^\s*\d+\s*[、.．]\s*/, '').trim();
  }
  // 兼容有 A./B. 前缀和判断题这种纯“对/错”选项
  function optionElsOf(item) {
    const labels = Array.from(item.querySelectorAll('label.el-radio, label.el-checkbox'));
    const out = [];
    labels.forEach((lb, idx) => {
      if (!isVisible(lb)) return;
      const labelTxt = textOf(lb.querySelector('.el-radio__label, .el-checkbox__label')) || textOf(lb);
      const m = /^([A-H])\s*[.、．]\s*(.*)$/.exec(labelTxt);
      const input = lb.querySelector('input');
      const letter = m ? m[1] : String.fromCharCode(65 + idx);
      const text = (m ? m[2] : labelTxt).replace(/\s+/g, ' ').trim();
      if (!text) return;
      out.push({ el: lb, input, letter, text, value: input ? input.value : '', checked: /is-checked/.test(String(lb.className)) });
    });
    return out;
  }
  function readExamQuestion() {
    const item = currentExamItem();
    if (!item) return null;
    const stem = stemOfItem(item);
    const opts = optionElsOf(item);
    if (!stem || opts.length < 2) return null;
    return { item, stem, opts, options: opts.map((o) => o.letter + '. ' + o.text), type: typeOfItem(item) };
  }
  function visibleButton(re) {
    const nodes = Array.from(document.querySelectorAll('button, .el-button, .submit, [class*=btn]'));
    return nodes.find((b) => isVisible(b) && re.test(textOf(b))) || null;
  }
  function clickOption(o) {
    if (!o) return false;
    try {
      if (o.input) { o.input.click(); return true; }
      o.el.click();
      return true;
    } catch (e) { return false; }
  }
  function clickAnswer(q, ans) {
    const opts = q.opts || optionElsOf(q.item);
    let n = 0;
    if (/^(对|错|正确|错误)$/.test(ans)) {
      const want = /^(对|正确)/.test(ans) ? /^(对|正确|是)/ : /^(错|错误|否)/;
      const hit = opts.find((o) => want.test(o.text));
      if (hit && clickOption(hit)) n++;
      return n;
    }
    String(ans).toUpperCase().replace(/[^A-H]/g, '').split('').forEach((l) => {
      const hit = opts.find((o) => o.letter === l);
      if (hit && clickOption(hit)) n++;
    });
    return n;
  }
  // 逐字母点击：每次点击前重新查询选项，避免 Vue 重渲染后旧引用失效
  async function applyAnswer(q, ans) {
    const letters = String(ans).toUpperCase().replace(/[^A-H]/g, '').split('');
    const isJudge = /^(对|错|正确|错误)$/.test(ans);
    const want = isJudge ? (/^(对|正确)/.test(ans) ? /^(对|正确|是)/ : /^(错|错误|否)/) : null;
    let n = 0;
    const targets = isJudge ? 1 : letters.length;
    for (let k = 0; k < targets; k++) {
      const fresh = optionElsOf(q.item);
      let hit = null;
      if (isJudge) hit = fresh.find((o) => want.test(o.text));
      else hit = fresh.find((o) => o.letter === letters[k]);
      if (hit && clickOption(hit)) n++;
      await sleep(160);
    }
    return n;
  }
  function clickNextQuestion() {
    const b = visibleButton(/^(下一题|保存)$/);
    if (b) { b.click(); return true; }
    return false;
  }
  // 站点弹窗按钮是 <div class="btn">确认提交</div>，不是 button
  function clickConfirmDialog() {
    const wrappers = Array.from(document.querySelectorAll('.el-dialog__wrapper, .el-message-box__wrapper, .el-overlay, .el-dialog, .el-message-box')).filter(isVisible);
    const roots = wrappers.length ? wrappers : [document.body];
    for (let i = 0; i < roots.length; i++) {
      const els = Array.from(roots[i].querySelectorAll('*'));
      const hit = els.find((x) => isVisible(x) && x.children.length === 0 && /^(确认提交|确认|确定)$/.test(textOf(x)));
      if (hit) {
        hit.click();
        const p = hit.parentElement;
        if (p && /(^|\s)btn(\s|$)/.test(String(p.className))) p.click();
        return true;
      }
    }
    return false;
  }
  async function askAI(q) {
    try {
      const res = await gmJson('POST', SEARCH_URL, { title: q.stem, options: q.options.join('\n'), type: q.type, force: false }, 90000);
      if (res && res.ok && res.answer) return res;
      log('AI 没给出答案：' + JSON.stringify(res).slice(0, 120), 'warn');
    } catch (e) {
      log('AI 请求失败：' + e.message, 'warn');
    }
    return null;
  }

  async function doExamStep() {
    if (state.busy) return;
    state.busy = true;
    try {
      if (clickConfirmDialog()) {
        log('先处理了页面上残留的提交弹窗', 'ok');
        await sleep(1500);
      }
      log('练习页：开始逐题作答…');
      let answered = 0;
      for (let i = 0; i < cfg.maxQuestions && state.running; i++) {
        const q = readExamQuestion();
        if (!q) { log('当前没有可读的题', 'info'); break; }
        if (q.opts.some((o) => o.checked)) {
          log('第 ' + (i + 1) + ' 题已选过，继续');
        } else {
          log('第 ' + (i + 1) + ' 题：' + q.stem.slice(0, 36) + '（' + q.type + '）');
          const res = await askAI(q);
          if (res && res.answer) {
            const n = await applyAnswer(q, String(res.answer));
            log('AI：' + res.answer + '（' + (res.source || '') + '），点了 ' + n + ' 个', 'ok');
            if (q.type === 'multiple') {
              await sleep(400);
              const wantLetters = String(res.answer).toUpperCase().replace(/[^A-H]/g, '').split('');
              const checked = optionElsOf(q.item).filter((o) => o.checked).length;
              log('多选校验：目标 ' + wantLetters.length + ' 个，当前已选 ' + checked + ' 个', checked >= wantLetters.length ? 'info' : 'warn');
            }
            answered++;
            await sleep(450);
          } else {
            log('AI 没答案，这题空着', 'warn');
          }
        }
        const before = q.stem;
        if (!clickNextQuestion()) { log('没有「下一题」按钮，准备提交', 'info'); break; }
        let moved = false;
        for (let w = 0; w < 10; w++) {
          await sleep(400);
          const after = readExamQuestion();
          if (after && after.stem !== before) { moved = true; break; }
        }
        if (!moved) { log('没有进入下一题（应该已是最后一题）', 'info'); break; }
      }
      log('作答完成（AI 答了 ' + answered + ' 题），点「提交」…', 'ok');
      const submit = visibleButton(/^提交$/) || document.querySelector('.header .submit');
      if (submit) submit.click(); else log('找不到提交按钮', 'warn');
      await sleep(1200);
      let confirmed = false;
      for (let w = 0; w < 30 && state.running; w++) {
        if (clickConfirmDialog()) { confirmed = true; log('已确认提交', 'ok'); break; }
        await sleep(400);
      }
      if (!confirmed) log('没出现确认弹窗（可能已直接提交）', 'info');
      for (let w = 0; w < 40 && !isResultPage(); w++) await sleep(500);
      log('提交后页面：' + location.pathname, 'info');
      await reportLog('提交练习');
    } finally {
      state.busy = false;
      render();
    }
  }

  // ---------- 解析页：抓题+对错+学生作答，回填题库 ----------
  function isResultPage() { return /examAnalysis|pointOfMastery/.test(location.pathname); }
  function stripAutostart(u) {
    if (!u) return u;
    const i = u.indexOf('?');
    if (i < 0) return u;
    const qs = new URLSearchParams(u.slice(i + 1));
    qs.delete('autostart');
    const rest = qs.toString();
    return u.slice(0, i) + (rest ? '?' + rest : '');
  }
  function examAnalysisUrl() {
    const segs = location.pathname.split('/').filter(Boolean);
    const qs = new URLSearchParams(location.search);
    const nodeName = qs.get('nodeName') || '';
    let examId = '', knowledgeId = '', idStr = '', recruitAndCourseId = '';
    if (segs[0] === 'pointOfMastery' && segs.length >= 6) {
      knowledgeId = segs[3] || '';
      idStr = segs[4] || '';
      examId = segs[5] || '';
      recruitAndCourseId = qs.get('recruitAndCourseId') || segs[2] || '';
      // pointOfMastery 的第二段是 recruitId，不是 recruitAndCourseId；优先用查询串
      recruitAndCourseId = qs.get('recruitAndCourseId') || '';
    } else {
      examId = qs.get('examId') || (/^\d+$/.test(segs[segs.length - 1] || '') ? segs[segs.length - 1] : '');
      knowledgeId = qs.get('knowledgeId') || '';
      idStr = qs.get('idStr') || '';
      recruitAndCourseId = qs.get('recruitAndCourseId') || '';
    }
    if (!examId) return '';
    const p = ['examId=' + encodeURIComponent(examId)];
    if (nodeName) p.push('name=' + encodeURIComponent(nodeName));
    if (knowledgeId) p.push('knowledgeId=' + encodeURIComponent(knowledgeId));
    if (recruitAndCourseId) p.push('recruitAndCourseId=' + encodeURIComponent(recruitAndCourseId));
    if (idStr) p.push('idStr=' + encodeURIComponent(idStr));
    return 'https://studywisdomh5.zhihuishu.com/examAnalysis?' + p.join('&') + '&autostart=1';
  }
  // 结果页（pointOfMastery）会直接给出「参考答案：A、B、C、D」，比解析页更可靠
  function parseResultAnswers() {
    const out = [];
    const seen = {};
    const blocks = Array.from(document.querySelectorAll('.line4-question, .line4')).filter(isVisible);
    blocks.forEach((b) => {
      const txt = textOf(b);
      const m = /参考答案[：:]\s*([^\s答]{1,40})/.exec(txt);
      if (!m) return;
      const rawAns = m[1].trim();
      const letters = rawAns.replace(/[^A-Ha-h]/g, '').toUpperCase();
      const isJudge = /判断/.test(txt);
      const opts = [];
      Array.from(b.querySelectorAll('label.el-radio, label.el-checkbox, li')).forEach((lb) => {
        const t = textOf(lb);
        const mm = /^([A-H])\s*[.、．]\s*(.*)$/.exec(t);
        if (mm && !opts.some((o) => o.indexOf(mm[1] + '.') === 0)) opts.push(mm[1] + '. ' + mm[2].trim());
      });
      if (!opts.length) {
        const re = /([A-H])\s*[.、．]\s*([^A-H]+?)(?=\s*[A-H]\s*[.、．]|\s*参考答案|$)/g;
        let mm2;
        while ((mm2 = re.exec(txt))) opts.push(mm2[1] + '. ' + mm2[2].trim());
      }
      let stem = txt.replace(/参考答案[\s\S]*$/, '');
      let prev = '';
      do {
        prev = stem;
        stem = stem.replace(/^(测试题推荐|单选题|多选题|判断题|单选|多选|判断)\s*/, '');
      } while (stem !== prev);
      opts.forEach((o) => { stem = stem.replace(o, ' ').replace(o.replace(/^([A-H])\.\s*/, '$1. '), ' '); });
      stem = stem.replace(/\s+/g, ' ').trim();
      if (!stem || seen[stem]) return;
      seen[stem] = 1;
      const type = isJudge ? 'judgement' : /多选/.test(txt) ? 'multiple' : 'single';
      const answer = isJudge ? (/对|正确|是/.test(rawAns) ? '对' : '错') : letters;
      if (!answer) return;
      out.push({ stem, type, answer, options: opts.join('\n') });
    });
    return out;
  }
  function parseAnalysisItems() {
    const blocks = Array.from(document.querySelectorAll('.exam-item')).filter(isVisible);
    const items = [];
    blocks.forEach((b) => {
      const stem = stemOfItem(b);
      if (!stem) return;
      const type = typeOfItem(b);
      const opts = optionElsOf(b);
      const bodyTxt = textOf(b);
      const correct = /回答正确|回答正确~/.test(bodyTxt) && !/回答错误|回答错误~/.test(bodyTxt);
      const sel = opts.find((o) => o.checked);
      let answer = sel ? sel.letter : '';
      if (type === 'judgement' && sel) answer = /^(对|正确|是)/.test(sel.text) ? '对' : '错';
      items.push({
        stem,
        type,
        correct,
        answer,
        options: opts.length ? opts.map((o) => o.letter + '. ' + o.text).join('\n') : ''
      });
    });
    return items;
  }
  function backToMastery() {
    const back = store.get('masteryUrl', '');
    if (!back) { log('没记录掌握度页地址，可手动返回', 'warn'); return; }
    try {
      const rates = store.get('rates', {}) || {};
      if (state.currentPoint) { delete rates[state.currentPoint]; store.set('rates', rates); }
    } catch (e) {}
    log('返回掌握度页，继续下一个知识点', 'ok');
    const clean = stripAutostart(back);
    location.href = clean + (clean.indexOf('?') >= 0 ? '&' : '?') + 'autostart=1';
  }
  async function doResultStep() {
    if (state.busy) return;
    state.busy = true;
    try {
      const onMasteryResult = /\/pointOfMastery\//.test(location.pathname);
      if (onMasteryResult) {
        let results = parseResultAnswers();
        for (let w = 0; w < 16 && !results.length; w++) {
          await sleep(500);
          results = parseResultAnswers();
        }
        if (results.length) {
          log('结果页读到 ' + results.length + ' 条参考答案，回填题库…');
          const res = await gmJson('POST', CORRECT_URL, {
            items: results.map((x) => ({ question: x.stem, answer: x.answer, options: x.options, type: x.type }))
          }, 30000);
          log('参考答案回填：' + ((res && res.saved) || 0) + ' 条', 'ok');
          await reportLog('结果页回填参考答案');
          await sleep(800);
          backToMastery();
          return;
        }
        const url = examAnalysisUrl();
        if (url) { log('结果页没读到参考答案，去解析页再试…'); location.href = url; return; }
        log('没解析出 examId，直接回掌握度页', 'warn');
        backToMastery();
        return;
      }
      let items = parseAnalysisItems();
      for (let w = 0; w < 40 && !items.length; w++) {
        await sleep(500);
        items = parseAnalysisItems();
      }
      log('解析页：读到 ' + items.length + ' 题，回填题库…');
      const right = items.filter((x) => x.correct && x.answer);
      const wrong = items.filter((x) => !x.correct);
      if (right.length) {
        const res = await gmJson('POST', CORRECT_URL, {
          items: right.map((x) => ({ question: x.stem, answer: x.answer, options: x.options, type: x.type }))
        }, 30000);
        log('正确答案回填：' + ((res && res.saved) || 0) + ' 条', 'ok');
      }
      if (wrong.length) {
        const res = await gmJson('POST', WRONG_URL, {
          items: wrong.map((x) => ({ question: x.stem, options: x.options, type: x.type, stuAnswer: x.answer, analysis: '' }))
        }, 30000);
        log('错题记录：' + ((res && res.savedHints) || 0) + ' 条', 'ok');
      }
      await reportLog('解析页回填');
      await sleep(800);
      backToMastery();
    } finally {
      state.busy = false;
      render();
    }
  }

  // ---------- 主循环 ----------
  async function step() {
    if (!state.running || state.busy) return;
    if (isMasteryPage()) { await doMasteryStep(); return; }
    if (isExamPage()) { await doExamStep(); return; }
    if (isResultPage()) { await doResultStep(); return; }
    log('当前页面不是掌握度/练习页，待命中', 'warn');
  }

  function setRunning(on) {
    state.running = !!on;
    cfg.enabled = !!on;
    store.set('cfg', cfg);
    if (on) {
      store.set('masteryUrl', isMasteryPage() ? location.href : store.get('masteryUrl', ''));
      log('开始：' + (isMasteryPage() ? '从掌握度页选知识点' : '当前在练习页，直接答题'), 'ok');
      reportLog('点了开始');
      setTimeout(step, 800);
    } else {
      log('已停止', 'info');
    }
    render();
  }

  // ---------- 面板 ----------
  const TEMPLATE = `
    <style>
      :host { all: initial; }
      .wrap { position: fixed; right: 16px; bottom: 120px; width: 330px; z-index: 2147483647;
        background: #1f2430; color: #e6e9ef; border-radius: 10px; box-shadow: 0 8px 26px rgba(0,0,0,.45);
        font: 12px/1.5 "Microsoft YaHei", Arial, sans-serif; overflow: hidden; }
      .hd { display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: #262c3a; cursor: move; user-select: none; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #8b5cf6; }
      .title { font-weight: 600; font-size: 13px; }
      .ver { margin-left: auto; color: #8b93a7; font-size: 11px; }
      .body { padding: 8px 10px; }
      .status { background: #171b25; border-radius: 6px; padding: 6px 8px; color: #cfd6e4; margin-bottom: 8px; word-break: break-all; }
      .btns { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
      button { border: 0; border-radius: 6px; padding: 6px 10px; cursor: pointer; background: #2f3a4f; color: #e6e9ef; font: inherit; }
      button.primary { background: #7c3aed; }
      button:disabled { opacity: .45; cursor: not-allowed; }
      .count { color: #9aa4b8; margin-bottom: 6px; }
      .log { height: 190px; overflow-y: auto; background: #12151d; border-radius: 6px; padding: 6px; font: 11px/1.55 Consolas, "Microsoft YaHei", monospace; }
      .log div { margin-bottom: 2px; word-break: break-all; }
      .log .warn { color: #f6c26b; }
      .log .error { color: #ff8a8a; }
      .log .ok { color: #63d69b; }
      .hint { color: #7f8aa0; margin-top: 6px; font-size: 11px; }
      .collapsed .body { display: none; }
    </style>
    <div class="wrap">
      <div class="hd">
        <span class="dot"></span>
        <span class="title">掌握度助手</span>
        <span class="ver">VERSION_PLACEHOLDER</span>
      </div>
      <div class="body">
        <div class="status">待命</div>
        <div class="btns">
          <button data-act="start" class="primary">开始</button>
          <button data-act="stop">停止</button>
          <button data-act="diag">诊断</button>
          <button data-act="clear">清空记录</button>
        </div>
        <div class="count"></div>
        <div class="log"></div>
        <div class="hint">在掌握度页点「开始」：自动选知识点 → 练习页答题并回填正确答案 → 返回继续下一个。</div>
      </div>
    </div>`.replace('VERSION_PLACEHOLDER', VERSION);

  let host = null;
  let shadow = null;

  function buildUI() {
    if (host) return;
    if (isOtherStudy() && !/mastery|exam/.test(location.pathname)) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = TEMPLATE;
    document.documentElement.appendChild(host);

    shadow.querySelector('[data-act=start]').addEventListener('click', () => setRunning(true));
    shadow.querySelector('[data-act=stop]').addEventListener('click', () => setRunning(false));
    shadow.querySelector('[data-act=diag]').addEventListener('click', () => {
      reportDiag('手动诊断');
      const t = textOf(document.body).slice(0, 1200);
      log('=== 诊断 ===');
      log('URL: ' + location.href);
      log('页面文字: ' + t);
      log('按钮: ' + Array.from(document.querySelectorAll('button, .el-button, [class*=btn]'))
        .filter(isVisible).slice(0, 20).map((b) => '[' + textOf(b).slice(0, 16) + ']').join(' '));
      log('选项候选: ' + optionElsOf(document.querySelector('.exam-item') || document.body).slice(0, 10).map((x) => '[' + x.letter + ']' + x.text.slice(0, 20)).join(' '));
    });
    shadow.querySelector('[data-act=clear]').addEventListener('click', () => {
      state.logs = [];
      done.clear();
      store.set('done', []);
      render();
      log('已清空日志和已处理记录');
    });

    const hd = shadow.querySelector('.hd');
    const wrap = shadow.querySelector('.wrap');
    let dragging = false, ox = 0, oy = 0;
    hd.addEventListener('mousedown', (e) => {
      dragging = true;
      const r = wrap.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      wrap.style.left = (e.clientX - ox) + 'px';
      wrap.style.top = (e.clientY - oy) + 'px';
      wrap.style.right = 'auto';
      wrap.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
    shadow.querySelector('.dot').addEventListener('click', () => wrap.classList.toggle('collapsed'));
  }

  function render() {
    if (!shadow) return;
    const st = shadow.querySelector('.status');
    const cnt = shadow.querySelector('.count');
    const box = shadow.querySelector('.log');
    const parts = [state.running ? '运行中' : '已暂停', isMasteryPage() ? '掌握度页' : isExamPage() ? '练习页' : isResultPage() ? '解析页' : '其他页'];
    if (state.currentPoint) parts.push(state.currentPoint);
    st.textContent = parts.join(' · ');
    cnt.textContent = '答对 ' + state.good + ' · 答错 ' + state.bad + ' · 已回填 ' + state.corrected + ' · 已处理知识点 ' + done.size;

    if (box.querySelectorAll('div').length !== state.logs.length) {
      box.innerHTML = '';
      state.logs.forEach((l) => {
        const d = document.createElement('div');
        d.textContent = '[' + l.t + '] ' + l.msg;
        if (l.type) d.className = l.type;
        box.appendChild(d);
      });
      box.scrollTop = box.scrollHeight;
    }
  }

  // ---------- 启动 ----------
  const AUTOSTART = /[?&]autostart=1/.test(location.search);
  function init() {
    if (isMasteryPage()) store.set('masteryUrl', stripAutostart(location.href));
    buildUI();
    log('v' + VERSION + ' 已加载：' + (isMasteryPage() ? '掌握度页' : isExamPage() ? '练习页' : '其他页'));
    // 打开页面后自动上报一次结构，方便按真实 DOM 适配（只发本地服务）
    if (isMasteryPage() || isExamPage()) {
      setTimeout(() => reportDiag('页面加载'), 3000);
      let lastUrl = location.href;
      setInterval(() => {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          setTimeout(() => reportDiag('navigated'), 2500);
        }
      }, 2000);
    }
    render();
    if (AUTOSTART && !state.running) {
      log('检测到 autostart=1，自动开始', 'ok');
      setTimeout(() => setRunning(true), 800);
    }
    setInterval(() => {
      if (state.running && !state.busy) step();
    }, 3000);
  }

  window.__mastery = { version: VERSION, state, cfg, pointItems, readExamQuestion, optionElsOf, isResultPage, isMasteryPage, isExamPage };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
