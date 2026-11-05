// ==UserScript==
// @name         作业流程助手 · 自动开始/提交（配合 OCS 答题）
// @namespace    local.ai-tiku.exam-flow
// @version      2.1.1
// @description  智慧树作业列表页：自动进入下一份测验，等 OCS 网课助手答完后自动提交并继续下一份（答题交给 OCS）
// @author       local
// @match        https://onlineexamh5new.zhihuishu.com/*
// @match        https://onlineexam5.zhihuishu.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '2.1.1';
  const HOST_ID = '__exam_flow_host';
  const HOOK_KEY = 'data-exam-open-url';

  const DEFAULTS = {
    enabled: true,
    autoNext: true, // 列表页是否自动进入下一份；关掉后自己选章节/作业，脚本只在答题页等你交卷
    pollMs: 20000,
    settleMs: 7000,
    listWaitMs: 20000,
    ocsStartWaitMs: 15000,
    ocsSubmitWaitMs: 12000,
    probeMs: 45000, // 每隔多少毫秒点一次「提交作业」探测是否已答完（靠平台弹窗判断，不依赖 OCS 状态）
    attempts: 40,
    waitAfterSubmitMs: 3500,
  };

  const store = {
    get(key, def) {
      try {
        const v = typeof GM_getValue === 'function' ? GM_getValue(key, null) : localStorage.getItem('examflow.' + key);
        if (v == null || v === '') return def;
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch (e) { return def; }
    },
    set(key, val) {
      try {
        const s = JSON.stringify(val);
        if (typeof GM_setValue === 'function') GM_setValue(key, s);
        else localStorage.setItem('examflow.' + key, s);
      } catch (e) { /* ignore */ }
    },
  };

  const cfg = Object.assign({}, DEFAULTS, store.get('cfg', {}));
  const done = new Set(store.get('done', []));

  const state = {
    running: false,
    busy: false,
    finished: false,
    listUrl: '',
    examIndex: 0,
    examName: '',
    currentKey: '',
    submitted: 0,
    filledTicks: 0,
    logs: [],
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function log(msg, type) {
    const t = new Date().toTimeString().slice(0, 8);
    state.logs.push({ t, msg, type: type || 'info' });
    if (state.logs.length > 300) state.logs.splice(0, state.logs.length - 300);
    render();
  }

  function textOf(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // OCS 面板在 Shadow DOM 里，document.body.innerText 读不到，这里把所有 open shadow root 的文字也收集起来
  function shadowText() {
    let out = '';
    try {
      const all = document.querySelectorAll('*');
      for (const el of all) {
        if (el.shadowRoot) {
          const s = el.shadowRoot.textContent || '';
          if (s) out += ' ' + s;
        }
      }
    } catch (e) { /* ignore */ }
    return out.replace(/\s+/g, ' ').trim();
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }

  function fire(el, type) {
    if (!el) return;
    const t = type || 'click';
    try {
      if (t === 'click' && typeof el.click === 'function') { el.click(); return; }
    } catch (e) { /* 继续 */ }
    try {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
    } catch (e) {
      el.dispatchEvent(new Event(t, { bubbles: true, cancelable: true }));
    }
  }

  // ---------- 页面世界注入：接住 window.open 的目标地址 ----------
  const PAGE_HOOK_SRC = '(' + function () {
    if (window.__examFlowHook) return;
    window.__examFlowHook = true;
    const KEY = 'data-exam-open-url';
    const CAP = 'data-exam-capture';
    const originalOpen = window.open;
    function capturing() {
      try { return document.documentElement.getAttribute(CAP) === '1'; } catch (e) { return false; }
    }
    function publish(u) {
      try {
        document.documentElement.setAttribute(KEY, String(u || ''));
        document.documentElement.dispatchEvent(new Event('exam-flow-open-url'));
      } catch (e) { /* ignore */ }
    }
    window.open = function (url) {
      if (!capturing()) {
        try {
          if (originalOpen) return originalOpen.apply(window, arguments);
        } catch (e) { /* ignore */ }
        return null;
      }
      if (url) {
        publish(url);
        return { closed: false, focus() {}, close() {}, location: { href: url } };
      }
      const fake = { closed: false, focus() {}, close() {}, location: { href: '' } };
      try {
        Object.defineProperty(fake.location, 'href', {
          get() { return ''; },
          set(v) { publish(v); },
        });
      } catch (e) { /* ignore */ }
      return fake;
    };
  } + ')()';

  function ensurePageHook() {
    if (window.__examFlowHook) return;
    try {
      const s = document.createElement('script');
      s.textContent = PAGE_HOOK_SRC;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch (e) { /* ignore */ }
  }

  function takeOpenUrl() {
    const el = document.documentElement;
    const v = el.getAttribute(HOOK_KEY) || '';
    if (v) el.removeAttribute(HOOK_KEY);
    return v;
  }

  // ---------- 页面识别 ----------
  function hashRoute() {
    return (location.hash || '').replace(/^#/, '');
  }

  function isListPage() {
    const h = hashRoute();
    if (!h) return false;
    if (/dohomework|doexamination|computerExamination|checkHomework|questionDetail/i.test(h)) return false;
    return /webExamList/i.test(h);
  }

  function isAnswerPage() {
    const h = hashRoute();
    if (/dohomework|doexamination|computerExamination/i.test(h)) return true;
    const t = textOf(document.body);
    return /提交作业|暂存作业/.test(t) && /下一题|保存/.test(t);
  }

  function isResultPage() {
    return /checkHomework/i.test(hashRoute());
  }

  // ---------- 列表页 ----------
  function cardOf(btn) {
    let cur = btn;
    for (let i = 0; i < 8 && cur; i++) {
      const t = textOf(cur);
      if (/题目数量|总\s*分\s*数|对应章节|截止时间/.test(t) && t.length < 1500) return cur;
      cur = cur.parentElement;
    }
    return btn.closest('li, .exam-item, .job-item') || btn.parentElement || btn;
  }

  function listCards() {
    const nodes = Array.from(document.querySelectorAll('button, a, span, div'));
    const out = [];
    nodes.forEach((el) => {
      if (el.children && el.children.length) return;
      if (!isVisible(el)) return;
      const t = textOf(el);
      if (!/^开始(答题|考试)$/.test(t)) return;
      const card = cardOf(el);
      const cardText = textOf(card).slice(0, 160);
      if (/已完成|已提交|已批阅|查看解析|查看答案/.test(cardText)) return;
      out.push({ btn: el, card, key: cardText.slice(0, 60), title: (cardText.match(/^(.{2,40}?)\s/) || [cardText.slice(0, 30)])[0].trim() });
    });
    const seen = new Set();
    return out.filter((x) => {
      if (seen.has(x.key)) return false;
      seen.add(x.key);
      return true;
    });
  }

  async function waitListCards(ms) {
    const t0 = Date.now();
    let last = [];
    while (Date.now() - t0 < ms) {
      last = listCards();
      if (last.length) return last;
      await sleep(700);
    }
    return last;
  }

  async function doListStep() {
    state.listUrl = location.href;
    store.set('listUrl', location.href);

    if (cfg.autoNext === false) {
      log('「自动进入下一份」已关闭：请自己选章节/作业，点「开始答题」后脚本会接管（等你交卷→回列表）', 'info');
      state.finished = true;
      state.running = false;
      render();
      return;
    }

    // 从答题页回列表时，页面可能还在渲染（真实站点比 mock 慢），先等卡片出现再判断
    const all = await waitListCards(cfg.listWaitMs);
    if (!all.length) {
      if (!sessionStorage.getItem('examFlowListReload')) {
        sessionStorage.setItem('examFlowListReload', '1');
        log('列表还没渲染出作业卡片，刷新一次再看…', 'warn');
        await sleep(800);
        location.reload();
        return;
      }
      log('还是找不到作业卡片：请确认当前在作业列表页（「未提交」标签），然后点「重新扫描」', 'warn');
      state.finished = true;
      state.running = false;
      render();
      return;
    }

    sessionStorage.removeItem('examFlowListReload');
    const cards = all.filter((x) => !done.has(x.key));
    if (!cards.length) {
      log('列表里可作答的作业都做完了，停止。（已完成 ' + done.size + ' 份）', 'ok');
      state.finished = true;
      state.running = false;
      render();
      return;
    }
    const next = cards[0];
    state.currentKey = next.key;
    state.examIndex++;
    state.examName = next.title || ('第 ' + state.examIndex + ' 份');
    log('第 ' + state.examIndex + ' 份：' + state.examName + '，进入答题…');

    takeOpenUrl();
    ensurePageHook();
    // 只有脚本自己点按钮时才接管 window.open，避免影响你手动点「开始答题」
    document.documentElement.setAttribute('data-exam-capture', '1');
    try {
      fire(next.btn, 'click');
      fire(next.btn.parentElement || next.btn, 'click');

      let url = '';
      for (let i = 0; i < 40; i++) {
        await sleep(200);
        url = takeOpenUrl();
        if (url) break;
        if (isAnswerPage()) return;
      }
      if (!url) {
        if (isAnswerPage()) return;
        log('点了「开始答题」但没拿到跳转地址（可能被站点拦截）', 'warn');
        done.add(next.key);
        persistDone();
        await sleep(1500);
        return;
      }
      log('跳转答题页：' + url.slice(0, 90));
      const hash = url.indexOf('#') >= 0 ? url.slice(url.indexOf('#')) : url;
      if (hash.startsWith('#')) location.hash = hash;
      else location.href = url;
    } finally {
      document.documentElement.removeAttribute('data-exam-capture');
    }
  }

  function persistDone() {
    store.set('done', Array.from(done));
  }

  // ---------- 答题页：等 OCS 答完 → 提交 ----------
  function submitButton() {
    const nodes = Array.from(document.querySelectorAll('button, a, span, div'));
    let fallback = null;
    for (const b of nodes) {
      if (!isVisible(b)) continue;
      if (textOf(b) !== '提交作业') continue;
      if (!b.children || b.children.length === 0) return b;
      if (!fallback) fallback = b;
    }
    return fallback;
  }

  function visibleDialog() {
    const boxes = Array.from(document.querySelectorAll('.el-message-box, .el-dialog, .el-message-box__wrapper'))
      .filter((d) => isVisible(d) && textOf(d).length > 4);
    return boxes[0] || null;
  }

  function dialogButton(box, labels) {
    if (!box) return null;
    const nodes = Array.from(box.querySelectorAll('button, .el-button, span, div'));
    for (const re of labels) {
      for (const b of nodes) {
        if (!isVisible(b)) continue;
        if (b.children && b.children.length) continue;
        if (re.test(textOf(b))) return b;
      }
    }
    return null;
  }

  function closeDialogByCancel() {
    const box = visibleDialog();
    if (!box) return false;
    const btn = dialogButton(box, [/^取消$/, /^关闭$/]);
    if (btn) { fire(btn, 'click'); return true; }
    return false;
  }

  // OCS 是否已经开始答题：看选项是否被选中（站点选项选中态/Element 输入框 checked）
  function ocsAnsweredCount() {
    const sel = [
      'li.active', 'li .active',
      '.topic-item.active', '.subject-option.active',
      '[class*="topic-option"][class*="active"]',
      '[class*="is-checked"]', '[class*="checked"]', '[aria-checked="true"]',
      'input[type=radio]:checked', 'input[type=checkbox]:checked',
    ].join(', ');
    try { return document.querySelectorAll(sel).length; } catch (e) { return 0; }
  }

  async function waitOcsStarted(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (ocsAnsweredCount() > 0) return true;
      const prog = examProgress();
      if (prog && prog.answered > 0) return true;
      await sleep(1500);
    }
    return false;
  }

  // 进度估算：优先用「总题数：N」和选项选中态；检测不到时返回 null 交给弹窗判断
  function examProgress() {
    const bodyText = textOf(document.body);
    const m = /总题数[：:]\s*(\d+)/.exec(bodyText);
    const total = m ? Number(m[1]) : 0;
    const marks = document.querySelectorAll(
      'li.active, li .active, .topic-item.active, .subject-option.active, [class*="topic-option"][class*="active"], [class*="is-checked"], [class*="checked"], [aria-checked="true"], input[type=radio]:checked, input[type=checkbox]:checked'
    );
    const answered = marks.length;
    if (!total) return null;
    return { total, answered: Math.min(answered, total) };
  }

  async function trySubmitOnce() {
    const btn = submitButton();
    if (!btn) return { state: 'no-button' };
    fire(btn, 'click');
    await sleep(1500);
    const box = visibleDialog();
    if (!box) return { state: 'no-dialog' };
    const content = textOf(box);
    if (/未作答|还有\s*\d+\s*道|未完成/.test(content)) {
      closeDialogByCancel();
      return { state: 'unanswered', content };
    }
    const okBtn = dialogButton(box, [/^确定$/, /^确认$/, /^提交$/, /^去考试$/]);
    if (okBtn) {
      log('确认提交：' + content.slice(0, 40));
      fire(okBtn, 'click');
      await sleep(cfg.waitAfterSubmitMs);
      return { state: 'submitted', content };
    }
    // 有些页面提交时弹的框按钮文案不同，兜底点主按钮
    const primary = box.querySelector('.el-button--primary, .el-message-box__btns .el-button:last-child');
    if (primary && isVisible(primary)) {
      log('确认提交（兜底点主按钮）：' + textOf(primary));
      fire(primary, 'click');
      await sleep(cfg.waitAfterSubmitMs);
      return { state: 'submitted', content };
    }
    closeDialogByCancel();
    return { state: 'unknown-dialog', content };
  }

  function submitSuccessSignal() {
    if (isResultPage()) return true;
    return /提交成功|交卷成功|已交卷|已提交|提交完成/.test(textOf(document.body));
  }

  // OCS 已答完的信号：OCS 的完成提示语（可能在自己面板的 Shadow DOM 里）
  // 注意：重做作业时平台会把上次答案带出来，页面可能一进来就是“答满”状态，所以不能只看选项选中数
  function ocsFinishedSignal() {
    const t = textOf(document.body) + ' ' + shadowText();
    return /作业\/考试完成|请自行检查后保存或提交|完成率\s*100(\.0+)?\s*%/.test(t);
  }

  async function waitOcsSubmit(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (submitSuccessSignal()) return true;
      if (!isAnswerPage()) return true;
      await sleep(1500);
    }
    return false;
  }

  async function doAnswerStep() {
    await sleep(cfg.settleMs);
    if (!isAnswerPage()) return;
    log('已进入答题页：OCS 负责答题，答完由它先交；它不交我再替你交');

    // OCS 有时不会在「同页 hash 跳转」后重新识别答题页（会提示「请手动进入作业/考试，或尝试刷新页面」）
    // 这里先确认它真的开始动了；没动就刷新一次，让 OCS 按正常加载流程初始化
    const reloadKey = 'examFlowReloaded:' + (state.currentKey || location.hash);
    const started = await waitOcsStarted(cfg.ocsStartWaitMs);
    if (!started) {
      if (!sessionStorage.getItem(reloadKey)) {
        sessionStorage.setItem(reloadKey, '1');
        log('OCS 还没开始答题，刷新页面让它重新识别答题页…（每份只刷一次）', 'warn');
        await sleep(800);
        location.reload();
        return;
      }
      log('刷新后仍未检测到 OCS 答题：请确认 OCS「自动答题」已开启。我会继续等。', 'warn');
    }

    // 重做作业时平台会把上次答案带出来：此时页面一进来就是“答满”，绝不能据此提交
    const prog0 = examProgress();
    state.retryFlow = !!(prog0 && prog0.total && prog0.answered >= prog0.total);
    if (state.retryFlow) {
      log('检测到这是「重做」：页面已带出上次答案，脚本不会因此提交。等 OCS 重新答完并显示「作业/考试完成」后才会交；急的话点「强制提交」', 'warn');
    }

    let lastProbe = 0;
    for (let i = 0; i < cfg.attempts; i++) {
      if (!state.running) return;
      if (submitSuccessSignal()) {
        state.submitted++;
        done.add(state.currentKey);
        persistDone();
        log('已交卷，回作业列表进入下一份', 'ok');
        await backToList();
        return;
      }
      if (!isAnswerPage()) {
        log('已离开答题页（大概率已交卷），回列表继续');
        await backToList();
        return;
      }

      const prog = examProgress();
      const ocsDone = ocsFinishedSignal();
      const filled = !!(prog && prog.total && prog.answered >= prog.total);
      const now = Date.now();

      // 是否允许现在探测/提交：
      // - 读到 OCS 完成提示 → 可以交
      // - 重做流程（旧答案已填满）→ 不许靠“答满”判断，只能等 OCS 完成提示
      // - 正常流程 → 答满才探测
      const canProbe = ocsDone || (!state.retryFlow && filled);
      if (!canProbe) {
        if (state.retryFlow) {
          log('重做流程：等 OCS 重新答完并显示「作业/考试完成」；急的话点「强制提交」');
        } else {
          log('等 OCS 答题：' + (prog ? '页面选中 ' + prog.answered + '/' + prog.total : '进度未知') +
            '（答满或 OCS 显示完成后自动提交）');
        }
        await sleep(cfg.pollMs);
        continue;
      }

      // 探测提交：用平台自己的弹窗判断有没有答完（不依赖 OCS 面板的文字）
      lastProbe = now;
      if (ocsDone) log('OCS 显示已完成，尝试提交…');
      else if (filled) log('页面已答满，尝试提交…');
      else log('定期探测：点「提交作业」看平台是否允许提交…');

      const r = await trySubmitOnce();
      if (r.state === 'submitted') {
        state.submitted++;
        done.add(state.currentKey);
        persistDone();
        log('提交成功，回作业列表继续下一份', 'ok');
        await backToList();
        return;
      }
      if (r.state === 'unanswered') {
        log('还没答完（平台提示还有未作答的题），继续等 OCS', 'warn');
        await sleep(cfg.pollMs);
        continue;
      }
      if (r.state === 'no-dialog') {
        log('点了提交没有确认弹窗，检查页面是否已提交…');
        await sleep(2500);
        if (!isAnswerPage()) {
          state.submitted++;
          done.add(state.currentKey);
          persistDone();
          log('已离开答题页，按已提交处理，回列表', 'ok');
          await backToList();
          return;
        }
        log('仍在答题页，继续等 OCS', 'warn');
        await sleep(cfg.pollMs);
        continue;
      }
      if (r.state === 'no-button') {
        log('找不到「提交作业」按钮，等一下再看', 'warn');
        await sleep(cfg.pollMs);
        continue;
      }
      log('提交弹窗无法识别：' + String(r.content || '').slice(0, 40) + '，继续等 OCS', 'warn');
      await sleep(cfg.pollMs);
    }
    log('等太久了：请检查 OCS 是否卡住；也可以点面板「强制提交」。', 'warn');
    state.running = false;
    render();
  }

  async function manualSubmit() {
    if (state.submitting) return;
    if (!isAnswerPage()) {
      log('当前不在答题页（可能已经提交/跳走了），直接回列表', 'info');
      await backToList();
      return;
    }
    state.submitting = true;
    log('收到「强制提交」：开始点「提交作业」…');
    render();
    try {
      log('手动提交：点「提交作业」…');
      const r = await trySubmitOnce();
      if (r.state === 'submitted') {
        state.submitted++;
        done.add(state.currentKey);
        persistDone();
        log('提交成功，回列表继续下一份', 'ok');
        await backToList();
      } else if (r.state === 'unanswered') {
        log('还有题没答，先等 OCS 答完再提交', 'warn');
      } else {
        log('提交没成功：' + r.state + (r.content ? '（' + String(r.content).slice(0, 40) + '）' : ''), 'warn');
      }
    } finally {
      state.submitting = false;
      render();
    }
  }

  function runSelfCheck() {
    log('—— 自检 ——', 'info');
    log('地址：' + location.href.slice(0, 120));
    const pageType = isListPage() ? '作业列表' : isAnswerPage() ? '答题页' : isResultPage() ? '结果页' : '其他（不支持的页面）';
    log('页面类型：' + pageType);
    let cards = [];
    try { cards = listCards(); } catch (e) {}
    log('作业卡片：' + cards.length + ' 个；题目块：' + document.querySelectorAll('.examPaper_subject, .exam-item, .question-item').length + ' 个');
    let prog = null;
    try { prog = examProgress(); } catch (e) {}
    log('答题进度：' + (prog && prog.total ? prog.answered + '/' + prog.total : '读不到'));
    log('OCS 完成信号：' + (ocsFinishedSignal() ? '有（可以提交）' : '无（还在答题或未检测到）'));
    log('已记录完成：' + done.size + ' 份');
    if (!isListPage() && !isAnswerPage() && !isResultPage()) log('提示：本脚本只在作业列表/答题/结果页生效', 'warn');
    log('—— 结束 ——', 'info');
  }

  async function backToList() {
    if (!state.listUrl) state.listUrl = store.get('listUrl', '') || '';
    if (!state.listUrl) {
      log('没记录列表页地址，请手动回列表', 'warn');
      state.finished = true;
      return;
    }
    await sleep(1500);
    if (isAnswerPage()) {
      log('返回作业列表…');
      location.href = state.listUrl;
    }
  }

  // ---------- 主循环 ----------
  async function step() {
    if (!state.running || state.busy || state.finished) return;
    state.busy = true;
    try {
      if (isResultPage()) {
        log('当前是结果页，回列表继续', 'info');
        await backToList();
        return;
      }
      if (isAnswerPage()) { await doAnswerStep(); return; }
      if (isListPage()) { await doListStep(); return; }
      log('当前页面不是作业列表/答题页，待命中', 'warn');
      state.finished = true;
    } catch (e) {
      log('出错：' + (e && e.message), 'error');
    } finally {
      state.busy = false;
      render();
    }
  }

  function setRunning(on) {
    state.running = !!on;
    state.finished = false;
    cfg.enabled = !!on;
    store.set('cfg', cfg);
    log(on ? '开始：自动进入下一份 → 等 OCS 答题交卷 → 继续下一份' : '已停止', on ? 'ok' : 'info');
    if (on) setTimeout(step, 600);
    render();
  }

  // ---------- 面板 ----------
  const TEMPLATE = `
    <style>
      :host { all: initial; }
      .wrap { position: fixed; right: 16px; bottom: 120px; width: 336px; z-index: 2147483647;
        background: #1f2430; color: #e6e9ef; border-radius: 10px; box-shadow: 0 8px 26px rgba(0,0,0,.45);
        font: 12px/1.5 "Microsoft YaHei", Arial, sans-serif; overflow: hidden; }
      .hd { display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: #262c3a; cursor: move; user-select: none; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #f0a020; }
      .title { font-weight: 600; font-size: 13px; }
      .ver { margin-left: auto; color: #8b93a7; font-size: 11px; }
      .body { padding: 8px 10px; }
      .status { background: #171b25; border-radius: 6px; padding: 6px 8px; color: #cfd6e4; margin-bottom: 8px; word-break: break-all; }
      .btns { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
      button { border: 0; border-radius: 6px; padding: 6px 10px; cursor: pointer; background: #2f3a4f; color: #e6e9ef; font: inherit; }
      button.primary { background: #2563eb; }
      button:disabled { opacity: .45; cursor: not-allowed; }
      .count { color: #9aa4b8; margin-bottom: 6px; }
      label.row { display: flex; align-items: center; gap: 6px; margin: 4px 0 6px; color: #cfd6e4; cursor: pointer; }
      label.row input { accent-color: #2563eb; }
      .log { height: 170px; overflow-y: auto; background: #12151d; border-radius: 6px; padding: 6px; font: 11px/1.55 Consolas, "Microsoft YaHei", monospace; }
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
        <span class="title">作业流程助手</span>
        <span class="ver">VERSION_PLACEHOLDER</span>
      </div>
      <div class="body">
        <div class="status">待命</div>
        <div class="btns">
          <button data-act="start" class="primary">开始</button>
          <button data-act="stop">停止</button>
          <button data-act="scan">重新扫描</button>
          <button data-act="submit">强制提交</button>
          <button data-act="check">自检</button>
          <button data-act="clear">清空记录</button>
        </div>
        <label class="row"><input type="checkbox" data-cfg="autoNext"> 自动进入下一份（关掉后自己选章节/作业）</label>
        <div class="count"></div>
        <div class="log"></div>
        <div class="hint">配合「OCS 网课助手」：OCS 答题，本脚本等它显示「作业/考试完成」后交卷并进入下一份。想自己选章节/作业就关掉上面的「自动进入下一份」，点「开始答题」后脚本会自动接管。</div>
      </div>
    </div>`.replace('VERSION_PLACEHOLDER', VERSION);

  let host = null;
  let shadow = null;

  function buildUI() {
    if (host) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = TEMPLATE;
    document.documentElement.appendChild(host);

    shadow.querySelector('[data-act=start]').addEventListener('click', () => setRunning(true));
    shadow.querySelector('[data-act=stop]').addEventListener('click', () => setRunning(false));
    shadow.querySelector('[data-act=scan]').addEventListener('click', () => {
      state.finished = false;
      log('重新扫描当前页面…');
      step();
    });
    shadow.querySelector('[data-act=submit]').addEventListener('click', () => manualSubmit());
    shadow.querySelector('[data-act=check]').addEventListener('click', () => runSelfCheck());
    const autoNextBox = shadow.querySelector('[data-cfg=autoNext]');
    if (autoNextBox) {
      autoNextBox.checked = cfg.autoNext !== false;
      autoNextBox.addEventListener('change', () => {
        cfg.autoNext = !!autoNextBox.checked;
        store.set('cfg', cfg);
        log(cfg.autoNext ? '已开启「自动进入下一份」' : '已关闭「自动进入下一份」：列表页不再自动点，你自己选', 'info');
        if (cfg.autoNext && !state.running) {
          state.finished = false;
          setRunning(true);
        }
      });
    }
    shadow.querySelector('[data-act=clear]').addEventListener('click', () => {
      state.logs = [];
      done.clear();
      persistDone();
      render();
      log('已清空日志和「已完成」记录');
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
    let pageName = '其他页';
    if (isResultPage()) pageName = '结果页';
    else if (isAnswerPage()) pageName = '答题页';
    else if (isListPage()) pageName = '作业列表';
    const parts = [state.running ? '运行中' : '已暂停', pageName];
    if (state.examName) parts.push(state.examName);
    if (state.submitted) parts.push('已提交 ' + state.submitted + ' 份');
    st.textContent = parts.join(' · ');
    cnt.textContent = '已完成记录：' + done.size + ' 条';

    const dots = box.querySelectorAll('div');
    if (dots.length !== state.logs.length) {
      box.innerHTML = '';
      state.logs.forEach((l) => {
        const d = document.createElement('div');
        d.textContent = '[' + l.t + '] ' + l.msg;
        if (l.type) d.className = l.type;
        box.appendChild(d);
      });
      box.scrollTop = box.scrollHeight;
    }
    const startBtn = shadow.querySelector('[data-act=start]');
    const stopBtn = shadow.querySelector('[data-act=stop]');
    if (startBtn) startBtn.disabled = state.running;
    if (stopBtn) stopBtn.disabled = !state.running;
  }

  // ---------- 启动 ----------
  function init() {
    buildUI();
    ensurePageHook();
    const onList = isListPage();
    const onAnswer = isAnswerPage();
    state.listUrl = onList ? location.href : (store.get('listUrl', '') || '');
    log('v' + VERSION + ' 已加载：' + (onList ? '作业列表' : onAnswer ? '答题页' : '其他页'));
    log('OCS 负责答题 + 交卷；本脚本负责自动开始下一份、等它交完后继续');
    const canAuto = onAnswer || (onList && cfg.autoNext !== false);
    if (cfg.enabled && canAuto) {
      state.running = true;
      log(onAnswer ? '答题页：接管流程，等 OCS 答完/交卷后回列表' : '自动开始：点「开始答题」→ 等 OCS 答完并交卷 → 下一份', 'ok');
      setTimeout(step, 800);
    } else if (onList) {
      log('「自动进入下一份」已关闭：你自己选章节/作业，点「开始答题」后脚本接管', 'info');
    }
    setInterval(() => {
      if (state.running && !state.busy && !state.finished) step();
    }, 2500);
    window.addEventListener('hashchange', () => {
      setTimeout(() => { if (state.running && !state.busy && !state.finished) step(); }, 600);
    });
    if (onList) store.set('listUrl', location.href);
    render();
  }

  window.__examFlow = {
    version: VERSION,
    state,
    cfg,
    step,
    listCards,
    submitButton,
    visibleDialog,
    examProgress,
    setRunning,
    manualSubmit,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
