// ==UserScript==
// @name         成绩回填 · 把作业正确答案喂给本地 AI
// @namespace    local.course.helper.grade
// @version      0.9.3
// @description  在作业/考试结果页提取题目与答案：答对的题直接回填「正确答案」；答错的题把平台 AI 解析存为提示，重做时让 AI 带着解析重答，逐轮逼近满分。
// @author       local
// @match        *://*.zhihuishu.com/*
// @match        *://*.ilearn.esp.com.cn/*
// @match        *://*.chaoxing.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window) return;

  const VERSION = '0.9.3';
  const CORRECT_URL = 'http://127.0.0.1:8765/correct';
  const WRONG_URL = 'http://127.0.0.1:8765/wrong';
  const SEARCH_URL = 'http://127.0.0.1:8765/search';

  // 只在「作业结果 / 查看答案 / 解析」这类页面显示面板
  function isResultPage() {
    return /(checkHomework|checkAnswer|examResult|getAnswer|examAnalysis|\/result)/i.test(location.href);
  }
  const HEALTH_URL = 'http://127.0.0.1:8765/health';
  const RAW_URL = 'http://127.0.0.1:8765/raw';

  const MARKER = /(正确答案|参考答案|标准答案)/;
  const NOISE_LINE = /^(我的答案|正确答案|参考答案|标准答案|解析|答案解析|得分|本题得分|题型|难度|知识点|收藏|纠错|回答|作答)[:：]?/;

  /* ------------------------------ 工具 ------------------------------ */
  const norm = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .trim();

  const normKey = (s) =>
    String(s || '')
      .replace(/[\s\u3000]+/g, '')
      .replace(/[，。！？；：""''、（）【】《》,.!?;:'"()\[\]<>-]/g, '')
      .toLowerCase();

  function log(msg, level) {
    state.log.push({ t: msg, level: level || 'info' });
    if (state.log.length > 30) state.log.shift();
    renderLog();
    try {
      console.log('[成绩回填] ' + msg);
    } catch (e) {}
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  /* ------------------------------ 解析 ------------------------------ */

  /** 从一段文本里拆出「正确答案」这一行的内容 */
  function answerAfterMarker(text, markerIdx, markerLen) {
    const rest = text.slice(markerIdx + markerLen);
    const firstLine = rest.split('\n')[0] || '';
    return norm(firstLine.replace(/^[:：\s]+/, ''));
  }

  function optionLines(text) {
    return String(text || '')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => /^[A-Ja-j][.、．:：)）]\s*\S+/.test(s));
  }

  function cleanQuestion(raw) {
    const lines = String(raw || '')
      .split('\n')
      .map((s) => norm(s))
      .filter(Boolean)
      .filter((s) => !NOISE_LINE.test(s));
    if (!lines.length) return '';
    // 选项行之前的才是题干；否则会把选项文字也当成题目
    const firstOption = lines.findIndex((s) => /^[A-Ja-j][.、．:：)）]\s*\S+/.test(s));
    const qLines = (firstOption > 0 ? lines.slice(0, firstOption) : lines).slice(-3);
    return qLines
      .join(' ')
      .replace(/^\d+[.、)）]\s*/, '')
      .replace(/^(单选题|多选题|判断题|填空题|简答题|判断|选择|填空)[:：]?/, '')
      .trim();
  }

  /** 把结果页里的一整块文字解析成 {question, answer, options, type} */
  function parseBlock(text) {
    const raw = String(text || '');
    const m = raw.match(MARKER);
    if (!m) return null;
    const markerIdx = m.index;
    const before = raw.slice(0, markerIdx);
    const question = cleanQuestion(before);
    const answerRaw = answerAfterMarker(raw, markerIdx, m[0].length);
    if (!question || question.length < 6 || question.length > 400) return null;

    const opts = optionLines(before);
    const optionsText = opts.join('\n');
    let answer = '';
    let type = '';

    // 1) 答案直接就是字母（A / ABD / A、C）
    const letterOnly = answerRaw.match(/^[A-Ja-j][A-Ja-j\s,，、]*$/);
    if (letterOnly) {
      answer = [...new Set(answerRaw.toUpperCase().match(/[A-J]/g) || [])].sort().join('');
      type = answer.length > 1 ? 'multiple' : 'single';
    } else if (optionsText && answerRaw) {
      // 2) 答案是选项原文：用选项文字反查字母
      const letters = [];
      opts.forEach((line, i) => {
        const body = norm(line.replace(/^[A-Ja-j][.、．:：)）]\s*/, ''));
        if (body && body.length >= 2 && answerRaw.includes(body)) letters.push('ABCDEFGHIJ'[i]);
      });
      if (letters.length) {
        answer = letters.sort().join('');
        type = letters.length > 1 ? 'multiple' : 'single';
      }
    }

    // 3) 判断/文字答案
    if (!answer) {
      if (/^(对|正确|√|是)$/.test(answerRaw)) {
        answer = '对';
        type = 'judgement';
      } else if (/^(错|错误|×|否)$/.test(answerRaw)) {
        answer = '错';
        type = 'judgement';
      } else if (answerRaw) {
        answer = answerRaw.replace(/[。；]+$/, '');
        type = 'completion';
      }
    }

    if (!answer) return null;
    return { question, answer, options: optionsText, type };
  }

  /** 找所有「正确答案」标记，逐块解析；按题干去重 */
  function extract() {
    const out = [];
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) {
      const p = n.parentElement;
      if (!p) continue;
      const tag = (p.tagName || '').toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') continue;
      if (host && host.contains(p)) continue;
      if (MARKER.test(n.nodeValue || '')) nodes.push(n);
      if (nodes.length > 200) break;
    }
    for (const node of nodes) {
      // 向上找到「一道题」的容器：块内文字不太长、且包含该标记
      let block = node.parentElement;
      let best = null;
      for (let i = 0; i < 10 && block && block !== document.body; i++, block = block.parentElement) {
        const t = block.innerText || '';
        if (t.length > 4000) break;
        if (MARKER.test(t) && t.length < 2000) best = block;
      }
      const text = best ? best.innerText : (node.parentElement && node.parentElement.innerText) || '';
      const item = parseBlock(text);
      if (!item) continue;
      const key = normKey(item.question);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  /* --------------------- 从页面 Vue 实例里取作业数据 ---------------------
     智慧树的「作业考试结果」页是 Vue2 SPA，答案不在 DOM 的「正确答案」文字里，
     而是藏在页面的 checkHomework 组件 data 里：
       examinationArr.workExamParts[].questionDtos[]  → 题目 / 选项
       answerData[questionId]                         → 答案、得分、对错
       analysisData[questionId]                       → 解析
     所以这里往页面里注入一段脚本（页面世界），把这份数据捞出来再用 postMessage 传回来。 */

  const COLLECTOR_SRC = '(' + function () {
    function keys(o) {
      var out = [];
      try {
        out = Object.keys(o || {});
      } catch (e) {}
      return out;
    }
    function looksLikeQuestion(o) {
      return (
        o &&
        typeof o === 'object' &&
        (o.questionName || o.questionContent || o.title || o.content || o.stem) &&
        (o.questionOptions || o.questionOptionDtos || o.options)
      );
    }
    function collectQuestionArrays(root) {
      var found = [];
      var seen = [];
      function walk(obj, depth) {
        if (!obj || typeof obj !== 'object' || depth > 7) return;
        if (seen.indexOf(obj) >= 0) return;
        seen.push(obj);
        var ks = keys(obj);
        for (var i = 0; i < ks.length && i < 120; i++) {
          var k = ks[i];
          if (k.charAt(0) === '$' || k.charAt(0) === '_') continue;
          var v;
          try {
            v = obj[k];
          } catch (e) {
            continue;
          }
          if (!v || typeof v !== 'object') continue;
          if (Array.isArray(v)) {
            if (v.length && looksLikeQuestion(v[0])) {
              found.push(v);
              continue;
            }
            for (var j = 0; j < v.length && j < 8; j++) walk(v[j], depth + 1);
          } else {
            walk(v, depth + 1);
          }
          if (found.length > 12) return;
        }
      }
      walk(root, 0);
      return found;
    }
    function findVm() {
      var stack = [];
      var app = document.querySelector('#app') || document.querySelector('#appRoot') || document.body;
      if (app && app.__vue__) stack.push(app.__vue__);
      if (!stack.length) {
        var all = (document.body || document).querySelectorAll('*');
        for (var i = 0; i < all.length && i < 3000 && !stack.length; i++) {
          if (all[i].__vue__) stack.push(all[i].__vue__);
        }
      }
      var guard = 0;
      var best = null;
      while (stack.length && guard < 5000) {
        guard++;
        var vm = stack.shift();
        if (!vm) continue;
        try {
          var d = vm.$data || {};
          var hasAd = d.answerData || vm.answerData;
          var hasExam = d.examinationArr || vm.examinationArr;
          if (hasAd || hasExam) {
            if (hasAd && hasExam) return vm;
            if (!best) best = vm;
          }
          var kids = vm.$children || [];
          for (var c = 0; c < kids.length; c++) stack.push(kids[c]);
        } catch (e) {}
      }
      return best;
    }
    function strip(s) {
      return String(s == null ? '' : s)
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    function optionText(o) {
      if (o == null) return '';
      if (typeof o === 'string') return strip(o);
      return strip(o.content || o.optionContent || o.questionOption || o.name || o.value || o.label || '');
    }
    function collect() {
      var vm = findVm();
      if (!vm) return { ok: false, reason: '页面里没找到作业数据（Vue 组件）' };
      var d = vm.$data || {};
      var answerData = d.answerData || vm.answerData || (vm.$store && vm.$store.state && vm.$store.state.answerData) || {};
      var analysisData = d.analysisData || vm.analysisData || (vm.$store && vm.$store.state && vm.$store.state.analysisData) || {};
      var qs = [];
      var arrays = collectQuestionArrays(d);
      for (var a = 0; a < arrays.length && qs.length < 400; a++) {
        for (var q = 0; q < arrays[a].length && qs.length < 400; q++) {
          var item = arrays[a][q];
          if (item && qs.indexOf(item) < 0) qs.push(item);
        }
      }
      var out = [];
      for (var i = 0; i < qs.length; i++) {
        var item2 = qs[i];
        var id = item2.id != null ? item2.id : item2.questionId != null ? item2.questionId : item2.qid;
        var ad = answerData && answerData[id] != null ? answerData[id] : null;
        var an = analysisData && analysisData[id] != null ? analysisData[id] : null;
        var rawOptions = item2.questionOptions || item2.questionOptionDtos || item2.options || [];
        var opts = [];
        for (var k = 0; k < rawOptions.length; k++) {
          var o = rawOptions[k];
          opts.push({
            id: o && (o.id != null ? o.id : o.optionId != null ? o.optionId : o.questionOptionId),
            content: optionText(o),
            flagChecked: o && o.flagChecked,
          });
        }
        var qt = item2.questionType || item2.questionTypeDto || {};
        out.push({
          id: id,
          typeId: qt.id != null ? qt.id : item2.questionTypeId != null ? item2.questionTypeId : item2.typeId,
          typeName: qt.name || item2.questionTypeName || item2.typeName || '',
          stem: strip(item2.questionName || item2.questionContent || item2.title || item2.content || item2.stem || ''),
          options: opts,
          answerData: ad,
          analysis: typeof an === 'string' ? strip(an) : an,
        });
      }
      return {
        ok: true,
        total: out.length,
        page: location.href,
        title: (document.title || '').slice(0, 80),
        score: (vm.totalScore != null ? vm.totalScore : d.totalScore != null ? d.totalScore : '') + '',
        answerCount: keys(answerData).length,
        data: out,
      };
    }
    window.addEventListener('message', function (ev) {
      var m = ev.data;
      if (!m || m.__grade_collect !== 'req') return;
      var res;
      try {
        res = collect();
      } catch (e) {
        res = { ok: false, reason: String((e && e.message) || e) };
      }
      res.__grade_collect = 'data';
      window.postMessage(res, '*');
    });
  }.toString() + ')()';


  function ensureCollector() {
    if (document.getElementById('__grade_collector_script')) return true;
    try {
      const s = document.createElement('script');
      s.id = '__grade_collector_script';
      s.textContent = COLLECTOR_SRC;
      (document.head || document.documentElement).appendChild(s);
      return true;
    } catch (e) {
      return false;
    }
  }

  function collectFromVue(timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(v);
      };
      const onMsg = (ev) => {
        const d = ev.data;
        if (!d || d.__grade_collect !== 'data') return;
        finish(d);
      };
      const timer = setTimeout(() => finish(null), timeoutMs || 4000);
      window.addEventListener('message', onMsg);
      if (!ensureCollector()) return finish(null);
      window.postMessage({ __grade_collect: 'req' }, '*');
    });
  }

  /* --------------------- 把 Vue 数据整理成 {question, answer, options, type} --------------------- */

  const htmlText = (s) => {
    try {
      const div = document.createElement('div');
      div.innerHTML = String(s == null ? '' : s);
      return norm(div.textContent || div.innerText || '');
    } catch (e) {
      return norm(String(s || ''));
    }
  };

  const LETTERS = 'ABCDEFGHIJ';

  function lettersFromTokens(tokens, options) {
    const letters = new Set();
    for (const raw of tokens) {
      const t = String(raw).trim();
      if (!t) continue;
      if (/^[A-Ja-j]{1,10}$/.test(t)) {
        t.toUpperCase()
          .split('')
          .forEach((c) => letters.add(c));
        continue;
      }
      // 选项 id 精确匹配
      let hit = options.findIndex((o) => String(o.id) === t);
      if (hit >= 0) {
        letters.add(LETTERS[hit]);
        continue;
      }
      // 1 基序号（"1,2" 这种）
      if (/^\d{1,2}$/.test(t)) {
        const n = Number(t);
        if (n >= 1 && n <= options.length) letters.add(LETTERS[n - 1]);
        continue;
      }
      // 选项原文
      hit = options.findIndex((o) => o.content && (o.content === t || o.content.includes(t)));
      if (hit >= 0) letters.add(LETTERS[hit]);
    }
    return [...letters].sort().join('');
  }

  function answerTextOf(ansData) {
    if (ansData == null) return '';
    if (typeof ansData === 'string' || typeof ansData === 'number') return String(ansData);
    const keys = ['answer', 'answers', 'rightAnswer', 'correctAnswer', 'studentAnswer', 'content'];
    for (const k of keys) {
      if (ansData[k] != null && String(ansData[k]).trim() !== '') {
        return Array.isArray(ansData[k]) ? ansData[k].join(',') : String(ansData[k]);
      }
    }
    return '';
  }

  function optionPrefix(options) {
    return options.map((o, i) => LETTERS[i] + '. ' + htmlText(o.content)).join('\n');
  }

  function analysisTextOf(a) {
    if (a == null) return '';
    if (typeof a === 'string') return norm(a);
    if (typeof a !== 'object') return norm(String(a));
    const keys = ['content', 'analysis', 'answerAnalyse', 'analyse', 'text', 'answerAnalysis'];
    for (const k of keys) {
      if (a[k]) return norm(String(a[k]));
    }
    try {
      return norm(JSON.stringify(a).slice(0, 1200));
    } catch (e) {
      return '';
    }
  }

  function itemsFromVue(data) {
    const out = [];
    (data || []).forEach((q) => {
      const stem = htmlText(q.stem);
      if (!stem || stem.length < 4) return;
      const options = (q.options || []).filter((o) => htmlText(o.content));
      const rawAnswer = answerTextOf(q.answerData);
      const ad0 = q.answerData || {};
      const isCurrent = ad0 && ad0.isCurrent != null ? Number(ad0.isCurrent) : null;
      const typeId = Number(q.typeId);
      let answer = '';
      let type = '';

      if (typeId === 14) {
        // 判断题：选项一般是「对 / 错」，答案可能是选项 id、字母或 1/0
        const tokens = String(rawAnswer).split(/[,，\s;；]+/).filter(Boolean);
        const letters = lettersFromTokens(tokens, options);
        const idx = letters ? LETTERS.indexOf(letters[0]) : -1;
        const optText = idx >= 0 ? htmlText(options[idx].content) : '';
        if (/^(对|正确|是|√|T|true)/i.test(optText) || /^(对|正确|是|√|T|true)$/i.test(rawAnswer)) answer = '对';
        else if (/^(错|错误|否|×|F|false)/i.test(optText) || /^(错|错误|否|×|F|false)$/i.test(rawAnswer)) answer = '错';
        else if (rawAnswer === '1') answer = '对';
        else if (rawAnswer === '0' || rawAnswer === '2') answer = '错';
        type = 'judgement';
      } else if (typeId === 1 || typeId === 2 || typeId === 0 || (!typeId && options.length)) {
        const tokens = String(rawAnswer)
          .split(/[,，\s;；]+/)
          .filter(Boolean);
        answer = lettersFromTokens(tokens, options);
        type = answer.length > 1 ? 'multiple' : 'single';
      } else {
        // 填空/简答等：直接把文字答案给它
        const tokens = String(rawAnswer).split(/[,，]+/).filter(Boolean);
        answer = tokens.join(' ');
        type = 'completion';
      }

      if (!answer) return;
      out.push({
        question: stem,
        options: optionPrefix(options),
        answer: answer,
        type: type,
        source: 'page',
        verified: isCurrent === 1,
        wrong: isCurrent === 0,
        analysis: analysisTextOf(q.analysis),
        stuAnswer: rawAnswer,
      });
    });
    return out;
  }


  function postJson(url, obj) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(obj);
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'POST',
          url,
          headers: { 'Content-Type': 'application/json' },
          data: payload,
          timeout: 60000,
          onload: (r) => {
            try {
              resolve(JSON.parse(r.responseText));
            } catch (e) {
              reject(new Error('返回不是 JSON: ' + String(r.responseText).slice(0, 120)));
            }
          },
          onerror: () => reject(new Error('连不上服务')),
          ontimeout: () => reject(new Error('请求超时')),
        });
      } else {
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
          .then((r) => r.json())
          .then(resolve, reject);
      }
    });
  }

  async function getJson(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout: 10000,
          onload: (r) => {
            try {
              resolve(JSON.parse(r.responseText));
            } catch (e) {
              reject(new Error('返回不是 JSON'));
            }
          },
          onerror: () => reject(new Error('连不上服务')),
          ontimeout: () => reject(new Error('超时')),
        });
      } else {
        fetch(url).then((r) => r.json()).then(resolve, reject);
      }
    });
  }

  /* ------------------------------ 状态与面板 ------------------------------ */
  const state = {
    items: [],
    wrongItems: [],
    rightCount: 0,
    uploaded: 0,
    online: null,
    busy: false,
    collapsed: false,
    log: [],
  };

  let host, shadow;

  function renderLog() {
    const box = shadow && shadow.querySelector('[data-box=log]');
    if (!box) return;
    box.innerHTML = state.log
      .slice(-8)
      .map((l) => '<div class="' + l.level + '">' + escapeHtml('[' + new Date().toTimeString().slice(0, 8) + '] ' + l.t) + '</div>')
      .join('');
    box.scrollTop = box.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const CSS = `
    :host { all: initial; }
    .panel { position: fixed; right: 16px; bottom: 110px; width: 330px; background: #1f232b; color: #e8eaed; border-radius: 10px; font: 12px/1.55 "Microsoft YaHei",system-ui,sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.4); z-index: 2147483646; overflow: hidden; }
    .hd { display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: #262b34; cursor: move; }
    .hd b { flex: 1; font-weight: 600; }
    .hd button { background: none; border: 0; color: #9aa0a6; cursor: pointer; font-size: 14px; }
    .bd { padding: 8px 10px 10px; }
    .status { background: #151a21; border-radius: 6px; padding: 5px 8px; margin-bottom: 6px; color: #9cc7ff; font-size: 11px; }
    .btns { display: flex; gap: 6px; margin-bottom: 6px; }
    .btns button { flex: 1; padding: 5px 6px; border-radius: 5px; border: 1px solid #3a4150; background: #2b313b; color: #d7dbe0; cursor: pointer; }
    .btns button.pri { background: #2563eb; border-color: #2563eb; color: #fff; }
    .btns button:disabled { opacity: .5; cursor: default; }
    .log { max-height: 120px; overflow: auto; background: #151a21; border-radius: 6px; padding: 5px 8px; font-size: 11px; color: #a8b1bd; }
    .log .warn { color: #f0b400; } .log .error { color: #ff6b6b; } .log .ok { color: #3ddc84; }
    .hint { color: #7c848f; font-size: 10px; margin-top: 6px; }
    .collapsed .bd { display: none; }
  `;

  function render() {
    if (!shadow) return;
    const st = shadow.querySelector('[data-status]');
    const online = state.online === null ? '检测中' : state.online ? '在线' : '未连接';
    st.textContent =
      '可回填 ' +
      state.rightCount +
      ' 题 · 错题 ' +
      state.wrongItems.length +
      ' 题 · 已回填 ' +
      state.uploaded +
      ' 条 · AI 服务 ' +
      online;

    const dot = shadow.querySelector('[data-dot]');
    dot.style.background = state.busy ? '#f0b400' : state.online ? '#3ddc84' : '#666';
    shadow.querySelector('[data-act=upload]').disabled = state.busy || !state.items.length;
  }

  function buildUI() {
    host = document.createElement('div');
    host.id = '__grade_feedback_host';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="panel">
        <div class="hd">
          <span data-dot style="width:8px;height:8px;border-radius:50%;background:#666"></span>
          <b>成绩回填 ${VERSION}</b>
          <button data-act="collapse" title="收起">–</button>
        </div>
        <div class="bd">
          <div class="status" data-status>初始化…</div>
          <div class="btns">
            <button class="pri" data-act="scan">扫描本页答案</button>
            <button data-act="upload">回填 / 记错题</button>
          </div>
          <div class="log" data-box="log"></div>
          <div class="hint">平台结果页不显示正确答案时：答对的题直接回填；答错的题会直接在面板里显示 AI 答案（同时记录解析），重做时 AI 带着解析重答，逐轮逼近满分。</div>
        </div>
      </div>`;
    shadow.querySelector('[data-act=collapse]').addEventListener('click', () => {
      state.collapsed = !state.collapsed;
      shadow.querySelector('.panel').classList.toggle('collapsed', state.collapsed);
    });
    shadow.querySelector('[data-act=scan]').addEventListener('click', () => doScan());
    shadow.querySelector('[data-act=upload]').addEventListener('click', () => doUpload());
    document.documentElement.appendChild(host);
    render();
  }

  async function doScan() {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      // 页面上直接写着「正确答案」的（少部分解析页有）先拿；其余从 Vue 数据判断对错
      const verified = extract();
      const wrongs = [];
      let total = verified.length;

      const data = await collectFromVue(5000);
      if (!data) {
        log('没拿到页面数据（注入脚本被拦截，或页面不是作业结果页）', 'warn');
      } else if (!data.ok) {
        log('页面数据里没找到作业对象：' + (data.reason || ''), 'warn');
      } else {
        log('页面数据：' + (data.title || '') + ' · ' + data.total + ' 题 · 得分 ' + (data.score || '-'));
        try {
          const r = await postJson(RAW_URL, {
            page: 'gradefeed',
            url: data.page,
            count: data.total,
            data: data.data,
          });
          if (r && r.ok) log('原始数据已存档（' + Math.round((r.saved || 0) / 1024) + ' KB）', 'info');
        } catch (e) {
          /* 存档失败不影响主流程 */
        }
        const vueItems = itemsFromVue(data.data);
        vueItems.forEach((it) => {
          if (it.verified) verified.push(it);
          else if (it.wrong) wrongs.push(it);
        });
        total = data.total;
      }

      state.items = verified.concat(wrongs);
      state.wrongItems = wrongs;
      state.rightCount = verified.length;

      if (!isResultPage()) {
        log('当前不是作业结果/解析页，面板会自动隐藏', 'info');
      }


      if (wrongs.length && state.online) {
        log('给答错的 ' + wrongs.length + ' 题生成 AI 答案（看答案 + 重做时使用）…', 'info');
        for (let i = 0; i < wrongs.length && i < 20; i++) {
          const it = wrongs[i];
          try {
            const r = await postJson(SEARCH_URL, {
              title: it.question,
              options: it.options,
              type: it.type,
            });
            if (r && r.ok && r.answer) {
              it.aiAnswer = r.answer;
              it.aiSource = r.source || "";
            }
          } catch (e) {
            log('AI 作答失败：' + e.message, 'warn');
            break;
          }
        }
      }

      if (!state.items.length) {
        log('没有可提取的题：确认在「结果 / 查看答案 / 解析」页，等页面加载完再扫（可先滚到底部）', 'warn');
        return;
      }
      if (host) host.style.display = '';
      log('扫描到 ' + total + ' 题：答对可回填 ' + verified.length + ' 题，答错 ' + wrongs.length + ' 题');
      verified.slice(0, 3).forEach((it) => log('· [对] ' + it.question.slice(0, 32) + ' → ' + it.answer));
      wrongs.slice(0, 5).forEach((it) =>
        log(
          '· [错] ' +
            it.question.slice(0, 28) +
            (it.aiAnswer ? ' → AI 答案：' + it.aiAnswer : it.analysis ? '（有平台解析，AI 未返回）' : '（无解析）'),
        ),
      );
      if (wrongs.length && !verified.length) {
        log('答错的题平台不给答案；会把平台 AI 解析存起来，重做时 AI 带着解析重答', 'info');
      }
    } catch (e) {
      log('扫描出错：' + e.message, 'error');
    } finally {
      state.busy = false;
      render();
    }
  }

  async function doUpload() {
    if (state.busy || !state.items.length) return;
    state.busy = true;
    render();
    try {
      const right = state.items.filter((it) => !it.wrong);
      const wrong = state.items.filter((it) => it.wrong);
      if (right.length) {
        const res = await postJson(CORRECT_URL, { items: right });
        if (res && res.ok) {
          state.uploaded = res.corrections;
          log('回填 ' + (res.saved || 0) + ' 题正确答案，服务里共 ' + (res.corrections || 0) + ' 条', 'ok');
          if (res.failed && res.failed.length) log('有 ' + res.failed.length + ' 题没解析成功（见 Console）', 'warn');
        } else {
          log('回填返回异常：' + JSON.stringify(res).slice(0, 120), 'warn');
        }
      }
      if (wrong.length) {
        const r2 = await postJson(WRONG_URL, {
          items: wrong.map((it) => ({
            question: it.question,
            options: it.options,
            analysis: it.analysis || '',
            stuAnswer: it.stuAnswer || it.answer,
            type: it.type,
          })),
        });
        if (r2 && r2.ok) {
          log(
            '记录 ' + wrong.length + ' 道错题：删旧缓存 ' + (r2.removedCache || 0) + ' 条、存解析 ' + (r2.savedHints || 0) + ' 条',
            'ok',
          );
        } else {
          log('错题记录返回异常：' + JSON.stringify(r2).slice(0, 100), 'warn');
        }
      }
      if (!right.length && !wrong.length) log('没有可提交的内容', 'warn');
    } catch (e) {
      log('上传失败：' + e.message + '（先双击 start-ai-tiku.cmd 启动服务）', 'error');
    } finally {
      state.busy = false;
      render();
    }
  }

  async function init() {
    buildUI();
    if (!isResultPage()) {
      host.style.display = 'none';
      log('当前页面不是作业结果/解析页，面板已隐藏（到结果页再显示）', 'info');
    }
    log('v' + VERSION + ' 已加载');
    try {
      const h = await getJson(HEALTH_URL);
      state.online = !!(h && h.ok);
      log(state.online ? 'AI 服务在线，已有正确答案 ' + (h.corrections || 0) + ' 条' : 'AI 服务返回异常', state.online ? 'info' : 'warn');
    } catch (e) {
      state.online = false;
      log('AI 服务未启动：先双击 start-ai-tiku.cmd', 'error');
    }
    render();
    // 进入页面 1.2 秒后自动扫一次（只预览，不上传）
    if (isResultPage()) {
      setTimeout(() => {
        if (!state.items.length) doScan();
      }, 1200);
    }
  }

  window.__gradefeed = { extract, scan: doScan, upload: doUpload, state };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
