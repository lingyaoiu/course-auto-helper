// ==UserScript==
// @name         网课助手 · 讨论区自动参与（智慧树）
// @namespace    local.course.helper.discuss
// @version      1.7.5
// @description  自动回复课程讨论区的问题（答完自动跳下一题）、一键发一条新话题；内容由本地 AI 服务（ai-tiku-server）生成。
// @author       local
// @match        *://*.zhihuishu.com/*
// @match        *://*.ilearn.esp.com.cn/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  if (window.top !== window) return; // 只在顶层页面运行

  const VERSION = '1.7.5';
  const AI_URL = 'http://127.0.0.1:8765/generate';
  const HEALTH_URL = 'http://127.0.0.1:8765/health';

  /* ------------------------------ 选择器与文案 ------------------------------ */
  // 智慧树的讨论区改版频繁，这里集中放关键词，页面改版只需要改这几个正则
  const SEL = {
    replyBtn: /^(回复|评论|我要回复|回复ta|reply)$/i,
    submitBtn: /^(提交|发送|发布|发表|回复|确定)$/,
    postBtn: /^(发话题|发布话题|发表话题|发新帖|发帖|去提问|提问|写话题|我要发言)$/,
    titleInputHint: /标题|主题|话题/,
    ignore: /^(回复|评论|点赞|赞|删除|举报|收起|展开|更多|查看全部|查看|沙发|板凳|\d+|编辑|置顶)$/,
  };

  const DEFAULTS = {
    enabled: false, // 自动回复开关
    maxReplyPerDay: 8,
    maxTopicPerDay: 20, // 仅用于展示/兼容，手动发帖只受单日硬上限 20 约束
    publishCount: 5, // 连发问答的篇数
    minGapMs: 8 * 1000, // 两题之间的间隔（秒级，答完自动跳下一题）
    maxGapMs: 20 * 1000,
    collapsed: false,
    left: null,
    top: null,
  };

  /* ------------------------------ 存储 ------------------------------ */
  const store = {
    get(k, d) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(k);
          return v === undefined ? d : v;
        }
        const raw = localStorage.getItem('__discuss_' + k);
        return raw === null ? d : JSON.parse(raw);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(k, v);
        else localStorage.setItem('__discuss_' + k, JSON.stringify(v));
      } catch (e) {
        /* ignore */
      }
    },
    del(k) {
      try {
        if (typeof GM_deleteValue === 'function') GM_deleteValue(k);
        else localStorage.removeItem('__discuss_' + k);
      } catch (e) {}
    },
  };

  const state = {
    cfg: Object.assign({}, DEFAULTS, store.get('cfg', {})),
    log: [],
    busy: false,
    started: true, // 打开页面自动开始（点「停止」可暂停）
    timer: null,
    lastActionAt: 0,
    nextGap: 0,
    aiOk: null,
    topicCount: 0,
    counters: store.get('counters', {}), // { "date|course": {replies, topics} }
    replied: store.get('replied', []), // 已回复过的话题指纹
    repliedTexts: store.get('repliedTexts', []), // 已回复话题的标题前缀（列表页/详情页文字不一致时兜底比对）
    visited: new Set(store.get('visited', [])), // 已经点过/处理过的话题（持久化，避免反复点进同一题）
    lastListUrl: store.get('lastListUrl', ''), // 最近一次问答列表页地址（回列表兜底）
  };

  function saveCfg() {
    store.set('cfg', state.cfg);
  }
  function saveCounters() {
    // 只保留最近 6 个 key，避免无限增长
    const keys = Object.keys(state.counters);
    if (keys.length > 6) {
      keys.slice(0, keys.length - 6).forEach((k) => delete state.counters[k]);
    }
    store.set('counters', state.counters);
  }
  function saveReplied() {
    if (state.replied.length > 300) state.replied = state.replied.slice(-300);
    store.set('replied', state.replied);
  }
  function saveRepliedTexts() {
    if (state.repliedTexts.length > 500) state.repliedTexts = state.repliedTexts.slice(-500);
    store.set('repliedTexts', state.repliedTexts);
  }
  // 记「这题已经答过」：既存指纹也存标题前缀，防止列表页和详情页取到的文字不同导致重复答同一题
  function zhsMarkReplied(t) {
    const key = t && t.key ? t.key : '';
    const text = normText((t && (t.text || t.title)) || '').slice(0, 24);
    if (key && !state.replied.includes(key)) {
      state.replied.push(key);
      saveReplied();
    }
    if (text && !state.repliedTexts.includes(text)) {
      state.repliedTexts.push(text);
      saveRepliedTexts();
    }
  }
  function saveVisited() {
    const arr = [...state.visited].slice(-500);
    state.visited = new Set(arr);
    store.set('visited', arr);
  }
  // 记下“点过/处理过”的话题，跨页面、跨会话都不再重复点
  function zhsMarkVisited(key) {
    if (!key) return;
    state.visited.add(key);
    saveVisited();
  }

  function todayKey() {
    const d = new Date();
    const s = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    return s + '|' + pageCourse();
  }
  function counters() {
    const k = todayKey();
    if (!state.counters[k]) state.counters[k] = { replies: 0, topics: 0 };
    return state.counters[k];
  }

  /* ------------------------------ 工具 ------------------------------ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => new Date().toTimeString().slice(0, 8);

  function log(msg, level) {
    const line = '[' + now() + '] ' + msg;
    state.log.push({ t: line, level: level || 'info' });
    if (state.log.length > 20) state.log.shift();
    renderLog();
    try {
      console.log('[讨论助手] ' + msg);
    } catch (e) {}
  }

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function normText(s) {
    return String(s || '')
      .replace(/[\s\u3000]+/g, ' ')
      .trim();
  }

  function pageCourse() {
    const t = normText(document.title || '')
      .replace(/[-_|].*(智慧树|知到|在线学堂).*$/, '')
      .trim();
    const h = document.querySelector('h1, h2, .course-name, [class*=courseName]');
    const ht = h ? normText(h.textContent) : '';
    return (ht || t || '未知课程').slice(0, 40);
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.05;
  }

  function textOf(el) {
    return normText(el && (el.innerText || el.textContent) || '');
  }

  /** 在 root 里找可见、文本匹配、且自身不含嵌套按钮的元素 */
  function findClickable(root, re, maxTextLen) {
    const nodes = (root || document).querySelectorAll('button, a, span, div, i, li, input[type=button]');
    const out = [];
    for (const el of nodes) {
      const t = normText(el.textContent || '');
      if (!t || t.length > (maxTextLen || 8)) continue;
      if (!re.test(t)) continue;
      if (!isVisible(el)) continue;
      // 只认最内层的可点元素：外层容器里如果还有同样文案的子元素就跳过
      let hasInner = false;
      for (const c of el.querySelectorAll('button, a, span, div, i, li')) {
        if (re.test(normText(c.textContent || ''))) {
          hasInner = true;
          break;
        }
      }
      if (hasInner) continue;
      out.push(el);
    }
    return out;
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
    const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function waitFor(fn, timeout, interval) {
    const t0 = Date.now();
    const step = interval || 200;
    while (Date.now() - t0 < timeout) {
      try {
        const v = fn();
        if (v) return v;
      } catch (e) {}
      await sleep(step);
    }
    return null;
  }

  /* ------------------------------ AI 请求 ------------------------------ */
  function requestJson(url, method, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const done = (ok, data) => (ok ? resolve(data) : reject(new Error(String(data).slice(0, 200))));
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: method || 'GET',
          url,
          headers: { 'Content-Type': 'application/json' },
          data: payload,
          timeout: 90000,
          onload: (r) => {
            try {
              done(r.status >= 200 && r.status < 300, JSON.parse(r.responseText));
            } catch (e) {
              done(false, '返回不是 JSON: ' + String(r.responseText).slice(0, 120));
            }
          },
          onerror: () => done(false, '网络错误'),
          ontimeout: () => done(false, '请求超时'),
        });
      } else {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 90000);
        fetch(url, {
          method: method || 'GET',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          signal: ctrl.signal,
        })
          .then(async (r) => {
            const txt = await r.text();
            clearTimeout(timer);
            let data;
            try {
              data = JSON.parse(txt);
            } catch (e) {
              return done(false, '返回不是 JSON: ' + txt.slice(0, 120));
            }
            done(r.ok, data);
          })
          .catch((e) => {
            clearTimeout(timer);
            done(false, e.message);
          });
      }
    });
  }

  async function genReply(topic) {
    try {
      const res = await requestJson(AI_URL, 'POST', {
        kind: 'reply',
        title: topic.title,
        content: topic.text,
        course: pageCourse(),
      });
      if (res && res.ok && res.text) {
        state.aiOk = true;
        return res.text;
      }
      state.aiOk = false;
      log('AI 没返回内容：' + (res && res.error ? res.error : '空'), 'warn');
      return '';
    } catch (e) {
      state.aiOk = false;
      log('AI 服务连不上：' + e.message, 'error');
      return '';
    }
  }

  async function genTopic(kind) {
    const course = pageCourse();
    const isQuestion = kind === 'question';
    try {
      const res = await requestJson(AI_URL, 'POST', {
        kind: isQuestion ? 'question' : 'topic',
        title: course + (isQuestion ? ' 课程提问' : ' 课程讨论'),
        content: isQuestion
          ? '围绕本课程一个具体知识点，提出一个真实的、有价值的问题，不要空泛。'
          : '围绕本课程一个具体知识点发起讨论，题目要具体、可讨论，不要空泛。',
        course,
      });
      if (res && res.ok && res.text) return res.text;
      return '';
    } catch (e) {
      log('AI 服务连不上：' + e.message, 'error');
      return '';
    }
  }

  /* ------------------------------ 话题检测 ------------------------------ */
  function topicTextOf(container, btn) {
    const clone = container.cloneNode(true);
    // 去掉按钮、输入框、图片，只留正文
    clone.querySelectorAll('button, a, input, textarea, img, svg, .avatar, [class*=avatar], [class*=toolbar], [class*=action]').forEach((n) => n.remove());
    let t = normText(clone.textContent || '');
    // 去掉开头可能混进来的标题/时间
    t = t.replace(/^(楼主|作者|匿名|置顶|精华)\s*/g, '').replace(/\d{4}-\d{1,2}-\d{1,2}.*?$/, '').trim();
    return t;
  }

  function findTopics() {
    const btns = findClickable(document, SEL.replyBtn, 8);
    const topics = [];
    const seen = new Set();
    for (const btn of btns) {
      let node = btn.parentElement;
      let container = null;
      for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
        const repliesIn = findClickable(node, SEL.replyBtn, 8).length;
        const len = normText(node.textContent || '').length;
        if (repliesIn === 1 && len >= 12) {
          container = node;
          if (len >= 40) break; // 已经拿到足够正文就停
        }
        if (node === document.body) break;
      }
      if (!container) continue;
      const text = topicTextOf(container, btn);
      if (text.length < 8) continue;
      const key = hash((normText(container.className) + '|' + text.slice(0, 60)).slice(0, 120));
      if (seen.has(key)) continue;
      seen.add(key);
      const title = (text.split(/[。！？!?\n]/)[0] || text).slice(0, 36);
      topics.push({ key, text: text.slice(0, 600), title, btn, container });
    }
    // 优先回复还没回复过的
    topics.sort((a, b) => {
      const ra = state.replied.includes(a.key) ? 1 : 0;
      const rb = state.replied.includes(b.key) ? 1 : 0;
      return ra - rb;
    });
    state.topicCount = topics.length;
    return topics;
  }

  /* --------------------------- 智慧树问答（qah5）适配 --------------------------- */
  // 这个站的讨论区是「问题列表」：回复 = 点进问题详情页 →「我来回答」→ 填答案 → 发布
  const ZHS_ON = /(^|\.)qah5\.zhihuishu\.com$/i.test(location.hostname) || /[?&]zhs=1/.test(location.search);
  const ZHS_PENDING = '__discuss_zhs_pending';

  function zhsCount(el) {
    if (!el) return -1;
    const m = String(el.textContent || '').match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }

  function zhsItemEls() {
    // 兼容不同页面结构：li.question-item / .question-item 容器都算，只取最外层
    return [...document.querySelectorAll('li.question-item, .question-item')].filter(
      (el) => !el.parentElement || !el.parentElement.closest('.question-item')
    );
  }

  function zhsKeyOf(text) {
    return 'zhs-' + hash(normText(text).slice(0, 48));
  }

  // 兼容旧版指纹（旧版取前 80 字，这里两种都查，避免升级后把答过的题再答一遍）
  function zhsAlreadyReplied(t) {
    if (state.replied.includes(t.key) || state.replied.includes('zhs-' + hash(t.text.slice(0, 80)))) return true;
    // 标题前缀兜底：列表页的 text 和详情页的标题经常差几个字，指纹对不上就会重复答同一题
    const text = normText(t.text || t.title || '').slice(0, 24);
    if (!text) return false;
    return state.repliedTexts.some((s) => s && (s === text || s.indexOf(text) === 0 || text.indexOf(s) === 0));
  }

  function zhsFindTopics() {
    const out = [];
    const seen = new Set();
    for (const li of zhsItemEls()) {
      if (!isVisible(li)) continue;
      const contentEl = li.querySelector('.question-content');
      if (!contentEl) continue;
      let text = normText(contentEl.textContent || '').replace(/\s+/g, ' ');
      if (text.length < 6) continue;
      const key = zhsKeyOf(text);
      if (seen.has(key)) continue;
      seen.add(key);
      const answers = zhsCount(li.querySelector('.qb-answers'));
      const watchers = zhsCount(li.querySelector('.qb-watcher'));
      const title = (text.split(/[。！？!?\n]/)[0] || text).slice(0, 40);
      out.push({ key, text: text.slice(0, 600), title, answers, watchers, el: li, container: li, btn: contentEl });
    }
    state.topicCount = out.length;
    return out;
  }

  function zhsReadPending() {
    try {
      return JSON.parse(sessionStorage.getItem(ZHS_PENDING) || 'null');
    } catch (e) {
      return null;
    }
  }
  function zhsWritePending(p) {
    try {
      sessionStorage.setItem(ZHS_PENDING, JSON.stringify(p));
    } catch (e) {}
  }
  function zhsClearPending() {
    try {
      sessionStorage.removeItem(ZHS_PENDING);
    } catch (e) {}
  }

  function zhsIsListPage() {
    const items = zhsItemEls().filter(isVisible);
    if (!items.length) return false;
    const detail = document.querySelector('.my-answer-btn, .questionDetail-div');
    if (detail && isVisible(detail)) return false;
    return true;
  }

  function zhsIsDetail() {
    // 以页面真实渲染为准：只看 hash 会在「hash 已变、详情还没渲染」时误判
    if (zhsIsListPage()) return false;
    const b = document.querySelector('.my-answer-btn');
    if (b && isVisible(b)) return true;
    const d = document.querySelector('.questionDetail-div');
    if (d && isVisible(d)) return true;
    const dlg = document.querySelector('.questionDialog .el-dialog, .el-dialog__wrapper .el-dialog');
    return !!(dlg && isVisible(dlg));
  }

  // 详情内容渲染出来没有（区分「还没加载完」和「已答过所以没有按钮」）
  function zhsDetailReady() {
    const d = document.querySelector('.questionDetail-div');
    if (d && isVisible(d)) return true;
    const b = document.querySelector('.my-answer-btn');
    return !!(b && isVisible(b));
  }

  function zhsVisibleDialog() {
    const list = document.querySelectorAll('.el-dialog__wrapper, .questionDialog .el-dialog, .el-dialog');
    for (const n of list) if (isVisible(n)) return n;
    return null;
  }

  // 弹窗里的“发布/提交”按钮：优先 button 标签，避免选中带 publish 类名的外层 div
  function findDialogSubmit(scope) {
    const cands = [...scope.querySelectorAll('button, .el-button, [class*=submit], [class*=publish], [class*=btn]')]
      .filter((el) => isVisible(el) && !el.disabled);
    const labelled = cands.find((el) => /^(发布|提交|发表|发送|立即发布|确定)$/.test(normText(el.textContent || '')));
    if (labelled) return labelled;
    const primaryBtn = cands.find((el) => /el-button--primary/.test(el.className || '') && /button/i.test(el.tagName));
    return primaryBtn || cands.find((el) => /el-button--primary/.test(el.className || '')) || null;
  }
  async function waitDetail(timeout) {
    const deadline = Date.now() + (timeout || 6000);
    while (Date.now() < deadline) {
      if (zhsIsDetail()) return true;
      await sleep(300);
    }
    return false;
  }

  // 关闭/退回结果统一处理：连续两次关不掉就暂停，避免卡死在详情页反复开图
  function noteCloseResult(back) {
    if (window.closed) return;
    if (back) {
      state.closeFails = 0;
      return;
    }
    state.closeFails = (state.closeFails || 0) + 1;
    if (state.closeFails >= 2) {
      state.cfg.enabled = false;
      saveCfg();
      log('连续关页失败，先暂停自动（手动返回列表后点「立即扫描」继续）', 'warn');
      render();
    }
  }

  async function zhsOpenTopic(topic) {
    if (state.visited.has(topic.key)) {
      log('这个话题已经点过/处理过了，跳过', 'warn');
      return false;
    }
    zhsWritePending({
      key: topic.key,
      title: topic.title,
      text: topic.text,
      listUrl: location.href,
      at: Date.now(),
    });
    zhsMarkVisited(topic.key);
    log('打开问题：' + topic.title);
    // 优先在本标签内直接跳转（不新开标签，答完回列表就是「关掉页面继续下一题」）
    if (await zhsOpenByVue(topic)) {
      scheduleZhs(900);
      return true;
    }
    topic.btn.click();
    if (await waitDetail(4000)) {
      scheduleZhs(900);
      return true;
    }
    const ans = topic.el.querySelector('.qb-answers');
    if (ans) {
      log('标题没跳转，改点「N回答」入口', 'warn');
      ans.click();
      if (await waitDetail(3000)) {
        scheduleZhs(900);
        return true;
      }
    }
    zhsClearPending();
    log('没进详情页：页面结构可能又变了，把截图/Console 发我', 'warn');
    return false;
  }

  // 智慧树问答列表的标题/“N回答”点击是 moveQaDetail() → window.open(新标签)，
  // 脚本合成的点击会被浏览器当弹窗拦掉，所以从页面 Vue 数据里拿 questionId 自己跳（同标签）。
  var QA_OPENER_SRC = [
  '(function(){',
  '  if (window.__qaOpenerInstalled) return;',
  '  window.__qaOpenerInstalled = true;',
  '  function norm(s){ return String(s == null ? "" : s).replace(/\\s+/g, "").toLowerCase(); }',
  '  function textOf(el){ return norm(el && (el.innerText || el.textContent)).slice(0, 40); }',
  '  function titleOf(v){ return norm(v && (v.questionTitle || v.title || v.questionName || v.content || v.questionContent || v.topicTitle || "")); }',
  '  function idOf(v){',
  '    var keys = ["questionId","question_id","qId","questionID"];',
  '    for (var i = 0; i < keys.length; i++) {',
  '      var val = v[keys[i]];',
  '      if (val != null && (typeof val === "string" || typeof val === "number") && String(val) !== "") return val;',
  '    }',
  '    return null;',
  '  }',
  '  function matchObj(v, want){',
  '    var id = idOf(v);',
  '    if (id == null) return null;',
  '    if (!want) return id;',
  '    var t = titleOf(v);',
  '    if (t && (t.indexOf(want.slice(0, 16)) >= 0 || want.indexOf(t.slice(0, 16)) >= 0)) return id;',
  '    return null;',
  '  }',
  '  function findIn(v, want, depth, seen){',
  '    if (!v || typeof v !== "object" || depth > 5) return null;',
  '    if (seen.indexOf(v) >= 0) return null;',
  '    seen.push(v);',
  '    if (Array.isArray(v)) {',
  '      for (var i = 0; i < v.length && i < 300; i++) {',
  '        var r0 = findIn(v[i], want, depth + 1, seen);',
  '        if (r0 != null) return r0;',
  '      }',
  '      return null;',
  '    }',
  '    var direct = matchObj(v, want);',
  '    if (direct != null) return direct;',
  '    var ks = Object.keys(v);',
  '    for (var k = 0; k < ks.length && k < 80; k++) {',
  '      var key = ks[k];',
  '      if (key === "__ob__" || key.charAt(0) === "$") continue;',
  '      var r1 = findIn(v[key], want, depth + 1, seen);',
  '      if (r1 != null) return r1;',
  '    }',
  '    return null;',
  '  }',
  '  function storeStateOf(vm){',
  '    try { if (vm.$store && vm.$store.state) return vm.$store.state; } catch (e) {}',
  '    try {',
  '      var ctx = vm.$appContext || vm._context;',
  '      if (ctx && ctx.provides) {',
  '        var pv = ctx.provides;',
  '        var keys = Object.keys(pv);',
  '        for (var i = 0; i < keys.length; i++) {',
  '          var s = pv[keys[i]];',
  '          if (s && s.state && typeof s.state === "object") return s.state;',
  '        }',
  '      }',
  '    } catch (e2) {}',
  '    return null;',
  '  }',
  '  function findId(el){',
  '    var want = textOf(el);',
  '    var n = el, guard = 0, vm = null;',
  '    while (n && guard++ < 25) { if (n.__vue__) { vm = n.__vue__; break; } n = n.parentElement; }',
  '    var cur = vm, d = 0;',
  '    while (cur && d++ < 40) {',
  '      var r = findIn(cur.$data || cur.data || cur._props || cur.$props || cur.ctx || cur.props, want, 0, []);',
  '      if (r != null) return r;',
  '      cur = cur.$parent || cur.parent;',
  '    }',
  '    // Vue3：元素上挂 __vueParentComponent',
  '    var v3 = el.__vueParentComponent, g3 = 0;',
  '    while (v3 && g3++ < 40) {',
  '      var r3 = findIn(v3.ctx || v3.props || v3.data, want, 0, []);',
  '      if (r3 != null) return r3;',
  '      v3 = v3.parent;',
  '    }',
  '    // 退回全局 store / 根实例',
  '    var root = document.querySelector("#app");',
  '    var rvm = root && (root.__vue__ || (root.__vue_app__ && (root.__vue_app__._instance && root.__vue_app__._instance.proxy)));',
  '    if (rvm) {',
  '      var st = storeStateOf(rvm);',
  '      var r4 = findIn(st, want, 0, []);',
  '      if (r4 != null) return r4;',
  '      var r5 = findIn(rvm.$data || rvm.data, want, 0, []);',
  '      if (r5 != null) return r5;',
  '    }',
  '    var app3 = document.querySelector("#app");',
  '    var inst3 = app3 && app3.__vue_app__;',
  '    if (inst3) {',
  '      var ctx3 = inst3._context || {};',
  '      var p3 = ctx3.provides || {};',
  '      var ks3 = Object.keys(p3);',
  '      for (var j = 0; j < ks3.length; j++) {',
  '        var s3 = p3[ks3[j]];',
  '        if (s3 && s3.state) {',
  '          var r6 = findIn(s3.state, want, 0, []);',
  '          if (r6 != null) return r6;',
  '        }',
  '      }',
  '    }',
  '    return null;',
  '  }',
  '  function info(){',
  '    var m = (location.hash || "").match(/#\\/web\\/(?:home|questionDetail)\\/(\\d+)/);',
  '    var q = new URLSearchParams(location.search);',
  '    return { courseId: m ? m[1] : "", recruitId: q.get("recruitId") || "", role: q.get("role") || "" };',
  '  }',
  '  document.addEventListener("__qa_open", function(){',
  '    try {',
  '      var el = document.querySelector(".question-item[data-qa-target], li.question-item[data-qa-target]");',
  '      if (!el) { document.documentElement.setAttribute("data-qa-open", "err:noitem"); return; }',
  '      var qid = findId(el);',
  '      el.removeAttribute("data-qa-target");',
  '      if (qid == null) { document.documentElement.setAttribute("data-qa-open", "err:noid"); return; }',
  '      var c = info();',
  '      var url = location.origin + location.pathname + "#/web/questionDetail/" + c.courseId + "/" + qid',
  '        + "?recruitId=" + c.recruitId + "&role=" + (c.role || "");',
  '      document.documentElement.setAttribute("data-qa-open", "ok:" + qid);',
  '      location.href = url;',
  '    } catch (err) {',
  '      document.documentElement.setAttribute("data-qa-open", "err:" + (err && err.message));',
  '    }',
  '  }, true);',
  '})();',
].join('\n');

  function zhsEnsureOpener() {
    if (document.getElementById('__qa_opener_script')) return;
    const s = document.createElement('script');
    s.id = '__qa_opener_script';
    s.textContent = QA_OPENER_SRC;
    (document.head || document.documentElement).appendChild(s);
  }

  async function zhsOpenByVue(topic) {
    if (!topic.el || !topic.el.isConnected) return false;
    zhsEnsureOpener();
    [...document.querySelectorAll('.question-item[data-qa-target]')].forEach((el) => el.removeAttribute('data-qa-target'));
    topic.el.setAttribute('data-qa-target', '1');
    document.documentElement.removeAttribute('data-qa-open');
    document.dispatchEvent(new Event('__qa_open'));
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      if (await waitDetail(100)) return true;
      const st = document.documentElement.getAttribute('data-qa-open') || '';
      if (st.indexOf('err') === 0) {
        log('从页面数据打开失败：' + st, 'warn');
        return false;
      }
    }
    return false;
  }

  function scheduleZhs(delay) {
    if (!ZHS_ON) return;
    setTimeout(() => {
      try {
        zhsTick(false);
      } catch (e) {}
    }, delay || 1500);
  }

  // 两题之间的随机间隔
  function nextGap() {
    return state.cfg.minGapMs + Math.random() * (state.cfg.maxGapMs - state.cfg.minGapMs);
  }

  async function zhsSubmitAnswer(text) {
    const btn = await waitFor(() => {
      const b = document.querySelector('.my-answer-btn');
      return b && isVisible(b) ? b : null;
    }, 8000, 300);
    if (!btn) {
      // 没有「我来回答」通常说明这题已经回答过了（自己或别人答过），直接跳过换下一题
      log('这题没有「我来回答」按钮（已经回答过了），跳过这题', 'warn');
      return 'already';
    }
    btn.click();
    const area = await waitFor(() => {
      const dlg = zhsVisibleDialog();
      if (!dlg) return null;
      const t = dlg.querySelector('textarea, .el-textarea__inner');
      return t && isVisible(t) ? t : null;
    }, 8000, 250);
    if (!area) {
      log('点开「我来回答」后没出现输入框（可能是禁言/权限弹窗），看一眼页面', 'warn');
      return 'fail';
    }
    setNativeValue(area, text);
    area.focus();
    area.dispatchEvent(new Event('input', { bubbles: true }));
    area.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(400);

    const dlg = zhsVisibleDialog();
    const scope = (dlg && dlg.querySelector('.el-dialog')) || dlg || document;
    const submit = findDialogSubmit(scope);
    if (!submit) {
      log('没找到发布按钮，答案已填好请手动点发布', 'warn');
      return 'fail';
    }
    submit.click();
    await sleep(1600);

    const still = zhsVisibleDialog();
    const msg = [...document.querySelectorAll('.el-message')].map((n) => normText(n.textContent)).join(' ');
    if (/成功/.test(msg) || !still) {
      const c = counters();
      c.replies++;
      saveCounters();
      log('回答已发布（今日 ' + c.replies + '/' + state.cfg.maxReplyPerDay + '）：' + text.slice(0, 30));
      return 'ok';
    }
    log('点了发布但没看到成功提示：' + (msg || '页面无提示') + '，先跳过这题', 'warn');
    return 'fail';
  }

  // 答完一题回到列表页（优先 history.back，不行就用记住的列表页地址直接跳）
  async function zhsBackToList() {
    const pending = zhsReadPending();
    const listUrl = (pending && pending.listUrl) || state.lastListUrl || '';
    for (let i = 0; i < 4; i++) {
      if (zhsIsListPage()) return true;
      if (!zhsIsDetail()) return true;
      if (/questionDetail/i.test(location.hash || '')) {
        history.back();
      } else if (listUrl) {
        location.href = listUrl;
      } else {
        break;
      }
      await sleep(1500);
    }
    if (zhsIsListPage()) return true;
    if (listUrl && location.href !== listUrl) {
      log('没能自动回到列表页，手动跳回：' + listUrl.slice(0, 70), 'warn');
      location.href = listUrl;
      return false; // 页面重载后继续
    }
    return zhsIsListPage();
  }

  // 答完/发完回列表页：只有「脚本/站点新开的标签」才关页；
  // 同一标签进详情时一律回列表，禁止 window.close（否则会把整个浏览器窗口关掉，回不到问答页）
  async function closeAnsweredPage() {
    const openedByWindow = !!(window.opener && window.opener !== window);
    if (openedByWindow) {
      try {
        window.close();
      } catch (e) {}
      await sleep(400);
      if (window.closed) return true;
      log('浏览器不放行关闭这个标签页，改回列表页继续');
    }
    const back = await zhsBackToList();
    if (back) log('已回到问答列表，继续下一题');
    return back;
  }

  // 发一条新话题（qah5 问答页）
  async function zhsPostTopic() {
    if (state.busy) return false;
    if (zhsIsDetail()) {
      log('当前在答题页，先回列表页再发布问答', 'warn');
      return false;
    }
    state.busy = true;
    try {
      // qah5 的提问按钮：固定右下角 .ask-btn，click 绑在内层 svg > use 上
      const ask = [...document.querySelectorAll('.ask-btn, [class*=ask-btn]')].find((el) => isVisible(el));
      if (!ask) {
        log('没找到右下角「提问」按钮，把问答页截图发我', 'warn');
        return false;
      }
      (ask.querySelector('svg use') || ask).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      // 等提问弹窗
      let box = null;
      for (let i = 0; i < 20; i++) {
        await sleep(300);
        const cands = [...document.querySelectorAll('.dialog_body, .el-dialog__body, .el-dialog')].filter((el) => isVisible(el));
        box = cands.find((el) => el.querySelector('textarea, .el-textarea__inner, [contenteditable=true]')) || cands[0] || null;
        if (box) break;
      }
      if (!box) {
        log('提问弹窗没弹出来（可能未登录/被风控），把页面截图发我', 'warn');
        return false;
      }
      const ta = [...box.querySelectorAll('.el-textarea__inner, textarea, [contenteditable=true]')].find(
        (el) => isVisible(el) && !el.disabled
      );
      if (!ta) {
        log('提问弹窗里没找到输入框，把弹窗截图发我', 'warn');
        return false;
      }
      const text = await genTopic('question');
      if (!text) return false;
      setNativeValue(ta, text);
      ta.focus();
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(900);

      // 发布按钮：.up-btn.set-btn「立即发布」
      let submit = [...box.querySelectorAll('.up-btn.set-btn, .set-btn, .up-btn')].find(
        (el) => isVisible(el) && /立即发布/.test(normText(el.textContent))
      );
      if (!submit) submit = findDialogSubmit(box);
      if (!submit) {
        log('没找到「立即发布」按钮，内容已填好请手动点发布', 'warn');
        return false;
      }
      submit.click();
      // 等发布结果：成功时弹窗关闭并出现提示；失败时弹窗还在
      let published = false;
      let msg = '';
      for (let i = 0; i < 12; i++) {
        await sleep(400);
        const toasts = [...document.querySelectorAll('.el-message, [class*=toast], [class*=Toast]')].map((n) => normText(n.textContent));
        msg = toasts.join(' ');
        if (/成功|已发布/.test(msg)) {
          published = true;
          break;
        }
        if (!document.querySelector('.dialog_body, .el-dialog__wrapper')) {
          published = true;
          break;
        }
      }
      if (!published) {
        log('点了「立即发布」但没看到成功提示（弹窗还在），请手动发布或截图发我', 'warn');
        return false;
      }
      const c = counters();
      c.topics++;
      saveCounters();
      log('已发布问答（今日 ' + c.topics + ' 帖）：' + text.slice(0, 40) + (msg ? ' ' + msg : ''));
      return true;
    } catch (e) {
      log('发布问答出错：' + e.message, 'error');
      return false;
    } finally {
      state.busy = false;
      render();
    }
  }

  let zhsBusy = false;
  async function zhsTick(force) {
    if (zhsBusy) return;
    if (!state.cfg.enabled && !force) return;
    if (state.busy) return;
    zhsBusy = true;
    try {
      render();
      const c = counters();
      const pending = zhsReadPending();

      /* ---------- 情况一：在问题详情页，作答这一题 ---------- */
      if (zhsIsDetail()) {
        let pending = zhsReadPending();
        if (!pending) {
          // 自己点进详情页的：从页面标题兜底造一条 pending
          const titleEl = document.querySelector('.questionDetail-div h3, .question-title, h1, h2, .question-content');
          const title = titleEl ? normText(titleEl.textContent) : '';
          if (!title) {
            if (force) log('在问题详情页但没记录要答哪一题，回列表页点「立即扫描」', 'warn');
            return;
          }
          pending = { key: zhsKeyOf(title), title: title.slice(0, 40), text: title, listUrl: '#' };
          zhsWritePending(pending);
        }
        if (zhsAlreadyReplied({ key: pending.key, text: pending.text || pending.title || '', title: pending.title })) {
          log('这题之前答过了，直接关页换下一题', 'warn');
          zhsMarkVisited(pending.key);
          zhsClearPending();
          state.lastActionAt = Date.now();
          const backA = await closeAnsweredPage();
          noteCloseResult(backA);
          if (!window.closed && state.cfg.enabled) scheduleZhs(1500);
          return;
        }
        if (c.replies >= state.cfg.maxReplyPerDay) {
          zhsClearPending();
          log('今日回复额度已用完（' + c.replies + '/' + state.cfg.maxReplyPerDay + '）', 'warn');
          state.cfg.enabled = false;
          saveCfg();
          await closeAnsweredPage();
          render();
          return;
        }
        state.busy = true;
        try {
          // ① 先确认这题能不能答：没有「我来回答」= 已答过/不可答，绝不调用 AI，直接关页
          const answerBtn = await waitFor(function () {
            const b = document.querySelector('.my-answer-btn');
            return b && isVisible(b) ? b : null;
          }, 6000, 250);
          zhsMarkVisited(pending.key);
          if (!answerBtn) {
            log('这题没有「我来回答」按钮（已答过或不可答），不调用 AI，直接关闭页面换下一题', 'warn');
            zhsMarkReplied({ key: pending.key, text: pending.text || pending.title });
            zhsClearPending();
            state.lastActionAt = Date.now();
            const back0 = await closeAnsweredPage();
            noteCloseResult(back0);
            if (!window.closed && state.cfg.enabled && back0) {
              state.lastActionAt = 0;
              log('已回到列表，准备继续下一题…');
              scheduleZhs(1500 + Math.random() * 1500);
            }
            return;
          }
          // ② 确认能答之后再让 AI 生成答案
          log('作答中：' + pending.title);
          let status = 'fail';
          const content = await genReply({ title: pending.title, text: pending.text });
          if (content) {
            status = await zhsSubmitAnswer(content);
            if (status === 'ok') {
              zhsMarkReplied({ key: pending.key, text: pending.text || pending.title });
              log('本题完成，关页继续下一题');
            } else if (status === 'already') {
              zhsMarkReplied({ key: pending.key, text: pending.text || pending.title });
              log('这题已经答过了（没有「我来回答」按钮），标记后跳过');
            } else {
              log('这题没答成功，关页换下一题', 'warn');
            }
          } else {
            log('AI 没生成内容，跳过这题', 'warn');
          }
          zhsClearPending();
          state.lastActionAt = Date.now();
          await sleep(500);
          const back = await closeAnsweredPage();
          noteCloseResult(back);
          if (!window.closed && state.cfg.enabled && back) {
            state.lastActionAt = 0;
            log('已回到列表，准备继续下一题…');
            scheduleZhs(1500 + Math.random() * 1500);
          }
        } finally {
          state.busy = false;
        }
        return;
      }

      /* ---------- 情况二：列表页，挑下一题 ---------- */
      if (!zhsIsListPage()) {
        if (force) log('当前页面既不是话题列表也不在答题页；确认在智慧树「讨论/问答」列表页', 'warn');
        return;
      }
      // 上一题还在打开/作答中（同一列表页被多个触发同时跑）→ 不再开新页面，避免连开两个相同页面
      if (pending && Date.now() - pending.at < 20000) {
        log('上一个话题还在打开/作答中，先等它结束（避免打开两个相同页面）');
        scheduleZhs(2500);
        return;
      }
      if (pending) zhsClearPending();
      state.lastListUrl = location.href;
      store.set('lastListUrl', location.href);
      const topics = zhsFindTopics();
      const gap = state.cfg.minGapMs + Math.random() * (state.cfg.maxGapMs - state.cfg.minGapMs);
      if (!force && state.lastActionAt && Date.now() - state.lastActionAt < gap) {
        scheduleZhs(Math.max(800, gap - (Date.now() - state.lastActionAt)));
        return;
      }
      if (!topics.length) {
        if (force) log('没找到问题列表（.question-item）；确认在「讨论/问答」首页', 'warn');
        return;
      }
      if (c.replies >= state.cfg.maxReplyPerDay) {
        log('今日回复额度已用完（' + c.replies + '/' + state.cfg.maxReplyPerDay + '），自动模式已停', 'warn');
        state.cfg.enabled = false;
        saveCfg();
        render();
        return;
      }
      const next = topics.find((t) => !zhsAlreadyReplied(t) && !state.visited.has(t.key));
      if (!next) {
        log('本页 ' + topics.length + ' 题都处理完了；有新题/翻页后再点「立即扫描」', 'warn');
        if (state.cfg.enabled) {
          state.cfg.enabled = false;
          saveCfg();
          render();
        }
        return;
      }
      state.lastActionAt = Date.now();
      await zhsOpenTopic(next);
    } catch (e) {
      log('智慧树回答流程出错：' + e.message, 'error');
    } finally {
      zhsBusy = false;
      state.busy = false;
      render();
    }
  }

  /* ------------------------------ 回复流程 ------------------------------ */
  function findEditor(near) {
    const scopes = [];
    if (near) scopes.push(near);
    const dialog = near && near.closest('[class*=dialog], [class*=modal], [class*=popup], [class*=mask], [class*=layer]');
    if (dialog) scopes.push(dialog);
    scopes.push(document);
    for (const scope of scopes) {
      const areas = scope.querySelectorAll('textarea, [contenteditable=true], [contenteditable=""]');
      for (const el of areas) {
        if (isVisible(el) && !el.readOnly && !el.disabled) return el;
      }
    }
    return null;
  }

  function findSubmit(afterEditor, replyBtn) {
    let scope = afterEditor.closest('[class*=dialog], [class*=modal], [class*=popup], [class*=mask], [class*=layer], form');
    if (!scope) {
      scope = afterEditor.parentElement;
      for (let i = 0; i < 4 && scope && scope.parentElement; i++) scope = scope.parentElement;
    }
    const all = findClickable(scope || document, SEL.submitBtn, 6);
    for (const b of all) {
      if (b === replyBtn) continue;
      const t = normText(b.textContent);
      if (/^回复$/.test(t)) continue; // 原按钮
      return b;
    }
    return null;
  }

  function closeEditor(editor) {
    try {
      const scope = editor.closest('[class*=dialog], [class*=modal], [class*=popup], [class*=mask], [class*=layer]') || document;
      const cancel = findClickable(scope, /^(取消|关闭|×|x)$/i, 6);
      if (cancel[0]) cancel[0].click();
      else {
        const closeBtn = scope.querySelector('[class*=close], .el-dialog__close, .ivu-modal-close');
        if (closeBtn) closeBtn.click();
      }
    } catch (e) {}
  }

  async function replyTo(topic) {
    if (state.busy) return false;
    state.busy = true;
    try {
      log('准备回复：' + topic.title);
      topic.btn.click();
      await sleep(400);
      const editor = await waitFor(() => findEditor(topic.container), 5000, 250);
      if (!editor) {
        log('点了回复但没找到输入框，跳过', 'warn');
        return false;
      }
      const content = await genReply(topic);
      if (!content) return false;

      if (editor.isContentEditable) {
        editor.focus();
        document.execCommand('insertText', false, content);
        if (normText(editor.textContent) !== normText(content)) editor.textContent = content;
        editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } else {
        setNativeValue(editor, content);
      }
      await sleep(350);
      const submit = findSubmit(editor, topic.btn);
      if (!submit || !isVisible(submit)) {
        log('没找到提交按钮（可能没登录或者面板结构变了），内容已填好请手动点发送', 'warn');
        return false;
      }
      if (submit.disabled || /disabled/.test(submit.className)) {
        log('提交按钮是灰的，等一下再试', 'warn');
        await sleep(800);
      }
      submit.click();
      await sleep(1200);

      const stillThere = findEditor(topic.container);
      const c = counters();
      if (!stillThere) {
        zhsMarkReplied({ key: topic.key, text: topic.text || topic.title });
        c.replies++;
        saveCounters();
        log('回复成功（今日 ' + c.replies + '/' + state.cfg.maxReplyPerDay + '）：' + content.slice(0, 40));
      } else {
        log('点了提交但输入框还在，可能被拦了，请看一眼页面', 'warn');
      }
      render();
      return true;
    } catch (e) {
      log('回复出错：' + e.message, 'error');
      return false;
    } finally {
      state.busy = false;
    }
  }

  /* ------------------------------ 发新话题 ------------------------------ */
  async function postTopic() {
    if (state.busy) return false;
    state.busy = true;
    try {
      const postBtn = findClickable(document, SEL.postBtn, 10)[0];
      if (!postBtn) {
        log('没找到「发布问答」入口（页面可能不在讨论区）', 'warn');
        return false;
      }
      postBtn.click();
      await sleep(600);
      const text = await genTopic();
      if (!text) return false;
      // 标题输入框
      const titleEl = document.querySelector('input[placeholder*="标题"], input[placeholder*="主题"]') ||
        findClickable(document, SEL.titleInputHint, 20)[0];
      const bodyEl = findEditor(null);
      if (!bodyEl) {
        log('发布弹窗里没找到正文输入框', 'warn');
        return false;
      }
      const title = pageCourse() + ' 学习讨论：' + text.replace(/[。！？!?].*$/, '').slice(0, 20);
      if (titleEl && titleEl.tagName === 'INPUT') setNativeValue(titleEl, title);
      setNativeValue(bodyEl, text);
      await sleep(400);
      const submit = findSubmit(bodyEl, null);
      if (!submit) {
        log('没找到发帖的提交按钮', 'warn');
        return false;
      }
      submit.click();
      await sleep(1500);
      const c = counters();
      c.topics++;
      saveCounters();
      log('发帖成功（今日 ' + c.topics + ' 帖）：' + title.slice(0, 30));
      render();
      return true;
    } catch (e) {
      log('发布问答出错：' + e.message, 'error');
      return false;
    } finally {
      state.busy = false;
    }
  }

  /* ------------------------------ 调度 ------------------------------ */
  function withinLimit() {
    const c = counters();
    if (c.replies >= state.cfg.maxReplyPerDay) return null;
    const topics = findTopics();
    if (!topics.length) {
      log('没检测到可回复的话题（可能不在讨论区，或页面结构变了）', 'warn');
      return null;
    }
    if (topics.some((t) => !state.replied.includes(t.key))) return 'reply';
    return null;
  }

  let ticking = false;
  async function tick(force) {
    if (ZHS_ON) return zhsTick(force);
    if (ticking) return;
    if (!state.cfg.enabled && !force) return;
    ticking = true;
    try {
      render();
      if (state.busy) return;
      const gap = state.cfg.minGapMs + Math.random() * (state.cfg.maxGapMs - state.cfg.minGapMs);
      if (!force && Date.now() - state.lastActionAt < gap) return;

      const job = withinLimit();
      if (!job) {
        const c = counters();
        if (c.replies >= state.cfg.maxReplyPerDay) {
          log('今日回复额度已用完（' + c.replies + '/' + state.cfg.maxReplyPerDay + '），自动模式已停', 'warn');
          state.cfg.enabled = false;
          saveCfg();
        } else if (force) {
          log('扫描完成：本页能回复的话题都处理过了');
        }
        return;
      }
      state.lastActionAt = Date.now();
      const topics = findTopics().filter((t) => !state.replied.includes(t.key));
      await replyTo(topics[0]);
    } finally {
      ticking = false;
      render();
    }
  }

  /* ------------------------------ 面板 UI ------------------------------ */
  function renderLog() {
    const box = host && host.shadowRoot && host.shadowRoot.querySelector('[data-box=log]');
    if (!box) return;
    box.innerHTML = state.log
      .slice(-6)
      .map((l) => '<div class="' + l.level + '">' + escapeHtml(l.t) + '</div>')
      .join('');
    box.scrollTop = box.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const CSS = `
    :host { all: initial; }
    .panel { position: fixed; width: 320px; background: #1f232b; color: #e8eaed; border-radius: 10px; font: 12px/1.5 "Microsoft YaHei",system-ui,sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.4); z-index: 2147483600; overflow: hidden; user-select: none; }
    .hd { display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: #262b34; cursor: move; }
    .hd b { font-size: 12px; font-weight: 600; flex: 1; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #666; }
    .dot.on { background: #3ddc84; }
    .dot.run { background: #f0b400; }
    .hd button { background: none; border: 0; color: #9aa0a6; cursor: pointer; font-size: 14px; padding: 0 2px; }
    .bd { padding: 8px 10px 10px; }
    .row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
    .sw { display: inline-flex; align-items: center; gap: 4px; color: #cfd3d8; cursor: pointer; }
    .sw input { accent-color: #3b82f6; }
    .tag { padding: 1px 6px; border-radius: 4px; background: #2b313b; color: #9aa0a6; }
    .tag.g { color: #3ddc84; } .tag.y { color: #f0b400; } .tag.r { color: #ff6b6b; }
    .btns { display: flex; gap: 6px; margin: 6px 0; }
    .btns button { flex: 1; padding: 4px 6px; border-radius: 5px; border: 1px solid #3a4150; background: #2b313b; color: #d7dbe0; cursor: pointer; font-size: 12px; }
    .btns button:hover { background: #343c48; }
    .btns button.pri { background: #2563eb; border-color: #2563eb; color: #fff; }
    .status { background: #151a21; border-radius: 6px; padding: 5px 8px; margin: 4px 0 6px; font-size: 11px; color: #9cc7ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .log { max-height: 96px; overflow: auto; background: #151a21; border-radius: 6px; padding: 5px 8px; font-size: 11px; color: #a8b1bd; }
    .log .warn { color: #f0b400; } .log .error { color: #ff6b6b; }
    .hint { color: #7c848f; font-size: 10px; margin-top: 6px; }
    .collapsed .bd { display: none; }
  `;

  let host, shadow, panel;
  let dockEl = null;

  // 开始/停止自动回答（独立面板和 OCS 面板共用这一处逻辑）
  function setEnabled(on) {
    if (on) {
      state.started = true;
      state.cfg.enabled = true;
      state.lastActionAt = 0; // 一开就立刻从当前题/下一题开始
      log('已开始：自动选题→判断能否回答→生成答案→发布→关页；每天上限 ' + state.cfg.maxReplyPerDay + ' 题');
      clearInterval(state.timer);
      state.timer = setInterval(() => tick(false), 15000);
      tick(false);
    } else {
      state.started = false;
      state.cfg.enabled = false;
      clearInterval(state.timer);
      state.timer = null;
      log('已停止：不会再自动答题');
    }
    saveCfg();
    render();
  }

  // 找到 OCS 网课助手的面板（它是一个 <container-element> 自定义元素）
  function findOcsPanel() {
    const list = document.querySelectorAll('container-element');
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (!el.querySelector('header-element')) continue;
      return el;
    }
    return null;
  }

  // 在 OCS 面板里插一张卡片：扫描/发布/连发/停止 + 状态
  function buildDock() {
    const wrap = document.createElement('script-panel-element');
    wrap.setAttribute('data-dc-dock', '1');
    wrap.innerHTML =
      '<div class="script-panel-body">' +
      '  <div class="card" style="padding:4px 0 8px">' +
      '    <div style="display:flex;align-items:center;gap:6px;font-weight:600;padding:6px 0">讨论助手' +
      '      <span class="secondary" data-dc-mode style="font-weight:400"></span></div>' +
      '    <div class="configs"><div class="configs-body">' +
      '      <config-element><label>每天回复上限</label><span class="config-wrapper">' +
      '        <input type="number" min="1" max="50" step="1" data-dc-num="maxReplyPerDay" style="width:56px"> 题</span></config-element>' +
      '      <config-element><label>连发问答帖数</label><span class="config-wrapper">' +
      '        <input type="number" min="1" max="20" step="1" data-dc-num="publishCount" style="width:56px"> 帖</span></config-element>' +
      '    </div></div>' +
      '    <div class="secondary" data-dc-status style="line-height:18px;padding:4px 0;word-break:break-all"></div>' +
      '    <div style="display:flex;gap:8px;padding:6px 0 0;flex-wrap:wrap">' +
      '      <button class="base-style-button" data-dc-act="scan" style="padding:2px 10px">立即扫描</button>' +
      '      <button class="base-style-button" data-dc-act="post" style="padding:2px 10px">发布问答</button>' +
      '      <button class="base-style-button" data-dc-act="bulk" style="padding:2px 10px">连发问答</button>' +
      '      <button class="base-style-button-secondary" data-dc-act="stop" style="padding:2px 10px">停止</button>' +
      '    </div>' +
      '  </div>' +
      '</div>';

    wrap.querySelectorAll('[data-dc-num]').forEach((el) => {
      el.addEventListener('change', () => {
        const k = el.getAttribute('data-dc-num');
        const n = Math.max(1, Math.min(50, parseInt(el.value, 10) || DEFAULTS[k] || 1));
        state.cfg[k] = n;
        el.value = n;
        saveCfg();
        render();
      });
    });
    wrap.querySelector('[data-dc-act=scan]').addEventListener('click', () => scanOnce());
    wrap.querySelector('[data-dc-act=post]').addEventListener('click', () => postOneTopic());
    wrap.querySelector('[data-dc-act=bulk]').addEventListener('click', () => postManyTopics());
    wrap.querySelector('[data-dc-act=stop]').addEventListener('click', () => setEnabled(false));
    return wrap;
  }

  function ensureDock() {
    if (!ZHS_ON) return;
    const ocs = findOcsPanel();
    if (!ocs) {
      if (dockEl) {
        try {
          dockEl.remove();
        } catch (e) {}
        dockEl = null;
      }
      if (host) host.style.display = '';
      return;
    }
    if (dockEl && dockEl.isConnected && ocs.contains(dockEl)) {
      if (host) host.style.display = 'none';
      return;
    }
    dockEl = buildDock();
    ocs.appendChild(dockEl);
    if (host) host.style.display = 'none';
    log('已把「自动参与讨论」挂到 OCS 面板里');
    renderDock();
  }

  function renderDock() {
    if (!dockEl || !dockEl.isConnected) return;
    const c = counters();
    const st = dockEl.querySelector('[data-dc-status]');
    if (st) {
      const last = state.log.length ? state.log[state.log.length - 1].t : '';
      st.textContent =
        '今日 ' + c.replies + '/' + state.cfg.maxReplyPerDay + ' 回复 · ' + c.topics + ' 帖' +
        ' · AI ' + (state.aiOk === null ? '?' : state.aiOk ? '已连接' : '未连接') +
        ' · 话题 ' + state.topicCount + (last ? ' · ' + last : '');
    }
    const mode = dockEl.querySelector('[data-dc-mode]');
    if (mode) mode.textContent = state.cfg.enabled ? '（运行中）' : '';
    dockEl.querySelectorAll('[data-dc-sw]').forEach((el) => {
      const on = !!state.cfg[el.getAttribute('data-dc-sw')];
      el.checked = on;
      if (on) el.setAttribute('checked', 'checked');
      else el.removeAttribute('checked');
    });
    dockEl.querySelectorAll('[data-dc-num]').forEach((el) => {
      const v = state.cfg[el.getAttribute('data-dc-num')];
      if (String(el.value) !== String(v)) el.value = v;
    });
  }

  function buildUI() {
    if (!ZHS_ON) return;
    host = document.createElement('div');
    host.id = '__discuss_helper_host';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="panel" part="panel">
        <div class="hd">
          <span class="dot" data-dot></span>
          <b>讨论助手 ${VERSION}</b>
          <span class="tag" data-mode>已停止</span>
          <button data-act="collapse" title="收起">–</button>
        </div>
        <div class="bd">
          <div class="status" data-status>初始化…</div>
          <div class="row">
            <span class="tag">打开页面自动开始（点「停止」可暂停）</span>
          </div>
          <div class="row" style="gap:6px">
            <span>每天回复上限</span>
            <input type="number" data-num="maxReplyPerDay" min="1" max="50" step="1" style="width:56px;background:#2b313b;color:#e8eaed;border:1px solid #414855;border-radius:4px;padding:2px 4px">
            <span>题</span>
            <span style="margin-left:8px">连发帖数</span>
            <input type="number" data-num="publishCount" min="1" max="20" step="1" style="width:56px;background:#2b313b;color:#e8eaed;border:1px solid #414855;border-radius:4px;padding:2px 4px">
            <span>帖</span>
          </div>
          <div class="row"><span class="tag" data-count>今日 0/8 · 0/3</span><span class="tag" data-ai>AI ?</span><span class="tag" data-topics>话题 0</span></div>
          <div class="btns">
            <button class="pri" data-act="scan">立即扫描</button>
            <button data-act="post">发布问答</button>
            <button data-act="bulk">连发问答</button>
            <button data-act="stop">停止</button>
            <button data-act="reset">清空记录</button>
          </div>
          <div class="log" data-box="log"></div>
          <div class="hint">打开页面自动开始：自动选话题→进详情→先看有没有「我来回答」按钮（没有=已答过，直接关页换下一题，不浪费 AI）→再生成答案并发布→答完自动关页。点过的话题会记住，不再重复点。「连发问答」按上方帖数连续发。</div>
        </div>
      </div>`;
    panel = shadow.querySelector('.panel');

    // 恢复折叠
    if (state.cfg.collapsed) panel.classList.add('collapsed');
    // 位置
    if (state.cfg.left != null && state.cfg.top != null) {
      panel.style.left = state.cfg.left + 'px';
      panel.style.top = state.cfg.top + 'px';
    } else {
      panel.style.right = '16px';
      panel.style.bottom = '110px';
    }

    shadow.querySelectorAll('[data-sw]').forEach((el) => {
      const k = el.getAttribute('data-sw');
      el.checked = !!state.cfg[k];
      el.addEventListener('change', () => {
        if (k === 'enabled') {
          setEnabled(el.checked);
        } else {
          state.cfg[k] = el.checked;
          saveCfg();
          render();
        }
      });
    });

    shadow.querySelectorAll('[data-num]').forEach((el) => {
      const k = el.getAttribute('data-num');
      el.value = state.cfg[k];
      el.addEventListener('change', () => {
        const n = Math.max(1, Math.min(50, parseInt(el.value, 10) || DEFAULTS[k] || 1));
        state.cfg[k] = n;
        el.value = n;
        saveCfg();
        log(k === 'maxReplyPerDay' ? '每天回复上限已改为 ' + n + ' 题' : '已改为 ' + n);
        render();
      });
    });

    shadow.querySelector('[data-act=collapse]').addEventListener('click', () => {
      state.cfg.collapsed = !state.cfg.collapsed;
      panel.classList.toggle('collapsed', state.cfg.collapsed);
      saveCfg();
    });
    shadow.querySelector('[data-act=scan]').addEventListener('click', () => scanOnce());
    shadow.querySelector('[data-act=post]').addEventListener('click', () => postOneTopic());
    shadow.querySelector('[data-act=bulk]').addEventListener('click', () => postManyTopics());
    shadow.querySelector('[data-act=stop]').addEventListener('click', () => {
      setEnabled(false);
    });
    shadow.querySelector('[data-act=reset]').addEventListener('click', () => {
      state.counters = {};
      state.replied = [];
      state.visited = new Set();
      state.lastActionAt = 0;
      saveCounters();
      saveReplied();
      saveVisited();
      log('已清空今日计数、「已回复」和「点过话题」记录');
      render();
    });

    // 拖动
    const hd = shadow.querySelector('.hd');
    hd.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const r = panel.getBoundingClientRect();
      const ox = e.clientX - r.left;
      const oy = e.clientY - r.top;
      const move = (ev) => {
        panel.style.left = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - ox)) + 'px';
        panel.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - oy)) + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        const r2 = panel.getBoundingClientRect();
        state.cfg.left = Math.round(r2.left);
        state.cfg.top = Math.round(r2.top);
        saveCfg();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      e.preventDefault();
    });

    document.documentElement.appendChild(host);
    render();
  }

  // 「连发问答」：手动触发，不受每日发帖上限限制（每次最多 20 帖），每帖之间随机等 5~10 秒
  const HARD_TOPIC_LIMIT = 20;
  async function postManyTopics() {
    if (state.busy) return;
    const want = Math.max(1, Math.min(HARD_TOPIC_LIMIT, parseInt(state.cfg.publishCount, 10) || 1));
    const start = counters().topics;
    let sent = 0;
    for (let i = 0; i < want; i++) {
      const c = counters();
      if (c.topics >= HARD_TOPIC_LIMIT) {
        log('今天已经发了 ' + c.topics + ' 帖，达到单日硬上限 ' + HARD_TOPIC_LIMIT + ' 帖，先停一下', 'warn');
        break;
      }
      log('连发问答 ' + (i + 1) + '/' + want + ' …');
      const ok = ZHS_ON ? await zhsPostTopic() : await postTopic();
      if (!ok) {
        log('第 ' + (i + 1) + ' 帖没发出去，连发停止（原因看上面日志）', 'warn');
        break;
      }
      sent++;
      if (i < want - 1) {
        const wait = 5000 + Math.random() * 5000;
        log('等 ' + Math.round(wait / 1000) + ' 秒后发下一帖');
        await sleep(wait);
        // 发帖可能跳到别的页面/弹窗残留，回列表页再继续
        if (ZHS_ON && !zhsIsListPage()) await zhsBackToList();
      }
    }
    const end = counters().topics;
    log('连发结束，本次发出 ' + sent + ' 帖（今日 ' + end + ' 帖，开始前 ' + start + ' 帖）');
    render();
  }

  // 「发布问答」按钮：手动发一条（同样不受每日上限限制，只受单日硬上限约束）
  async function postOneTopic() {
    if (state.busy) return;
    const c = counters();
    if (c.topics >= HARD_TOPIC_LIMIT) {
      log('今天已经发了 ' + c.topics + ' 帖（单日硬上限 ' + HARD_TOPIC_LIMIT + '），先停一下', 'warn');
      return;
    }
    log('准备发一条新话题…');
    render();
    const ok = ZHS_ON ? await zhsPostTopic() : await postTopic();
    render();
    if (!ok) log('这次没发出去，看上面的日志', 'warn');
  }

  // 「开始回答」按钮已取消：打开页面自动开始，只有「停止」用于手动暂停
  async function scanOnce() {
    if (ZHS_ON && zhsIsDetail()) {
      log('当前在问题详情页，直接答这一题（答完自动回列表）');
      await zhsTick(true);
      return;
    }
    const topics = ZHS_ON ? zhsFindTopics() : findTopics();
    const c = counters();
    log('扫描到 ' + topics.length + ' 个' + (ZHS_ON ? '问题' : '话题') + '，今日回复 ' + c.replies + '/' + state.cfg.maxReplyPerDay + '，发帖 ' + c.topics + ' 帖');
    render();
    if (!topics.length) {
      log('列表是空的：确认当前在课程「讨论/问答」页，把页面地址发我，我按真实结构适配选择器', 'warn');
      return;
    }
    await tick(true);
  }

  function render() {
    if (!shadow) return;
    const c = counters();
    const st = shadow.querySelector('[data-status]');
    const course = pageCourse();
    st.textContent = (state.cfg.enabled ? '运行中 · ' : '已停止 · ') + course + ' · 话题 ' + state.topicCount;
    const dot = shadow.querySelector('[data-dot]');
    dot.className = 'dot' + (state.busy ? ' run' : state.cfg.enabled ? ' on' : '');
    const mode = shadow.querySelector('[data-mode]');
    if (mode) {
      mode.textContent = state.cfg.enabled ? '运行中' : '已停止';
      mode.className = 'tag ' + (state.cfg.enabled ? 'g' : '');
    }
    shadow.querySelector('[data-count]').textContent = '今日 ' + c.replies + '/' + state.cfg.maxReplyPerDay + ' · ' + c.topics + ' 帖';
    const ai = shadow.querySelector('[data-ai]');
    ai.textContent = 'AI ' + (state.aiOk === null ? '?' : state.aiOk ? '已连' : '断开');
    ai.className = 'tag ' + (state.aiOk === null ? '' : state.aiOk ? 'g' : 'r');
    shadow.querySelector('[data-topics]').textContent = '话题 ' + state.topicCount;
    ['enabled'].forEach((k) => {
      const el = shadow.querySelector('[data-sw=' + k + ']');
      if (el) el.checked = !!state.cfg[k];
    });
    shadow.querySelectorAll('[data-num]').forEach((el) => {
      const k = el.getAttribute('data-num');
      if (String(el.value) !== String(state.cfg[k])) el.value = state.cfg[k];
    });
    renderDock();
  }

  /* ------------------------------ 启动 ------------------------------ */
  async function init() {
    if (!ZHS_ON) return; // 只在智慧树「问答」界面出现，其它页面（课程/作业/考试等）不注入面板
    buildUI();
    log('v' + VERSION + ' 已加载：' + location.href.slice(0, 80));
    try {
      const h = await requestJson(HEALTH_URL, 'GET');
      state.aiOk = !!(h && h.ok);
      log(state.aiOk ? '本地 AI 服务在线（' + (h.model || '') + '）' : '本地 AI 服务返回异常', state.aiOk ? 'info' : 'warn');
    } catch (e) {
      state.aiOk = false;
      log('本地 AI 服务未启动：先双击 start-ai-tiku.cmd 或开机自启', 'error');
    }
    render();
    ensureDock();
    // OCS 面板是异步挂载/会重渲染的，定时检查并补挂
    setInterval(() => {
      try {
        ensureDock();
      } catch (e) {
        /* ignore */
      }
    }, 2000);
    // 打开页面自动开始：自动选题→先判断能不能答（无「我来回答」就关页跳过）→生成答案→发布→关页
    state.started = true;
    state.cfg.enabled = true;
    saveCfg();
    clearInterval(state.timer);
    state.timer = setInterval(() => tick(false), 15000);
    log('已自动开始：每 15 秒检查一次，自动选题/答题/发帖（点「停止」可暂停）');
    render();
    scheduleZhs(1500);
    // 从答题页关回来时（列表页重新获得焦点）立即继续下一题，不用等 15 秒
    window.addEventListener('focus', () => {
      if (state.started && !state.busy && ZHS_ON) scheduleZhs(800);
    });
    // 页面是 SPA，切页面后重新扫描
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        state.topicCount = 0;
        render();
      }
    }, 3000);
  }

  // 调试入口
  window.__discuss = {
    get cfg() {
      return state.cfg;
    },
    scan: () => scanOnce(),
    replyOne: () => tick(true),
    postTopic: () => postOneTopic(),
    zhsPostTopic: () => zhsPostTopic(),
    topics: () => (ZHS_ON ? zhsFindTopics() : findTopics()),
    zhsTopics: () => zhsFindTopics(),
    zhsTick: (force) => zhsTick(force !== false),
    pending: () => zhsReadPending(),
    resetReplied: () => { state.replied.length = 0; state.repliedTexts.length = 0; saveReplied(); saveRepliedTexts(); },
    resetVisited: () => { state.visited = new Set(); saveVisited(); },
    st: () => ({ enabled: state.cfg.enabled, busy: state.busy, zhsBusy: zhsBusy, replied: state.replied.length, visited: state.visited.size, lastActionAt: state.lastActionAt }),
    dock: () => !!dockEl,
    dockNow: () => ensureDock(),
    dbg: () => {
      const btns = [];
      document.querySelectorAll('button, a, span, div, i, li, input[type=button]').forEach((el) => {
        const t = normText(el.textContent || '');
        if (t.length <= 8 && SEL.replyBtn.test(t)) {
          const r = el.getBoundingClientRect();
          btns.push(el.tagName + '[' + t + '] ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' vis=' + isVisible(el));
        }
      });
      return { btns: btns, found: findClickable(document, SEL.replyBtn, 8).length, topics: findTopics().length };
    },
    log: state.log,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
