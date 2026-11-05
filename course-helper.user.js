// ==UserScript==
// @name         网课助手 · 自动挂机跳未学
// @namespace    local.course.helper
// @version      2.0.0
// @description  挂机自动播放、自动跳过已学资源、自动进入下一个未学内容；学时按真实播放时长累计。
// @author       local
// @match        *://*.yidureading.com/*
// @match        *://yidureading.com/*
// @match        *://*.esp.com.cn/*
// @match        *://esp.com.cn/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

/*
 * 用法：
 *  1. 打开课程播放页，右下角出现「网课助手」面板。
 *  2. 点「挂机 开」，然后就不用管了：
 *     - 视频被暂停会自动拉回播放；
 *     - 当前资源学满（progressRate = 1）会自动跳到下一个资源；
 *     - 一节播完由页面自己进入下一节，遇到已学过的资源脚本会继续往下跳，
 *       直到找到一个还没学的为止；到目录末尾会提示「没有下一个资源了」。
 *  3. 学时只认真实播放秒数：平台每秒 +1、每 180 秒上报一次，
 *     1 学时约 45 分钟，加速/拖进度条都不会让学时变快。
 *  4. 想停止先点「挂机 关」，否则暂停会被自动拉回播放。
 *
 * 注意：挂机时别最小化浏览器、别静音（有声音播放才不会被后台节流）；
 *       可以切到别的标签页。
 */

(function () {
  'use strict';

  if (window.__courseHelperV2) return;
  window.__courseHelperV2 = true;

  /* ------------------------------- 存储 ------------------------------- */

  const hasGM = typeof GM_getValue === 'function';
  const KEY = 'ch_autoJump';

  const loadOn = () => {
    try {
      if (hasGM) return !!GM_getValue(KEY);
      return localStorage.getItem(KEY) === '1';
    } catch (e) {
      return false;
    }
  };
  const saveOn = (v) => {
    try {
      if (hasGM) GM_setValue(KEY, !!v);
      else localStorage.setItem(KEY, v ? '1' : '0');
    } catch (e) {}
  };

  /* ------------------------------- 状态 ------------------------------- */

  const state = {
    on: loadOn(),
    collapsed: false,
    host: null,
    root: null,
    lesson: null,
    video: null,
    videoSeen: new WeakSet(),
    nodeId: '',
    nodeSince: 0,
    lastAdvance: 0,
    resumeTimer: 0,
    loopSec: 0,
    lastTs: 0,
    note: '',
  };

  const clampText = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    const t = Math.floor(sec);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const pad = (x) => String(x).padStart(2, '0');
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  /* ------------------------------- 面板 ------------------------------- */

  const TEMPLATE = `
    <style>
      :host { all: initial; }
      .panel {
        width: 236px;
        font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        font-size: 12px;
        line-height: 1.45;
        color: #e8eaf0;
        background: rgba(24, 26, 32, .94);
        border: 1px solid rgba(255, 255, 255, .12);
        border-radius: 10px;
        box-shadow: 0 10px 28px rgba(0, 0, 0, .45);
        user-select: none;
        overflow: hidden;
      }
      .head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; cursor: move; background: rgba(255, 255, 255, .05); }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; flex: 0 0 auto; }
      .title { font-weight: 600; letter-spacing: .3px; }
      .spacer { flex: 1; }
      .mini { border: 0; background: rgba(255, 255, 255, .1); color: inherit; border-radius: 5px; padding: 1px 7px; line-height: 18px; cursor: pointer; font-size: 12px; }
      .mini:hover { background: rgba(255, 255, 255, .22); }
      .body { padding: 8px 10px 10px; }
      .body.hide { display: none; }
      .btn {
        display: block;
        width: 100%;
        padding: 7px 0;
        border: 0;
        border-radius: 6px;
        background: rgba(255, 255, 255, .1);
        color: inherit;
        font-size: 13px;
        font-family: inherit;
        cursor: pointer;
      }
      .btn:hover { background: rgba(255, 255, 255, .22); }
      .btn.on { background: #3b82f6; color: #fff; }
      .status, .loopinfo {
        display: none;
        margin: 0 0 7px;
        padding: 5px 7px;
        border-radius: 5px;
        font-size: 11px;
        line-height: 1.5;
        word-break: break-all;
      }
      .status { background: rgba(251, 191, 36, .12); border: 1px solid rgba(251, 191, 36, .35); color: #fbbf24; }
      .loopinfo { background: rgba(74, 222, 128, .1); border: 1px solid rgba(74, 222, 128, .3); color: #4ade80; font-variant-numeric: tabular-nums; }
      .status.show, .loopinfo.show { display: block; }
      .hint { margin-top: 7px; color: #8b93a7; font-size: 10px; line-height: 1.5; }
    </style>
    <div class="panel">
      <div class="head">
        <span class="dot"></span>
        <span class="title">网课助手</span>
        <span class="spacer"></span>
        <button class="mini" data-act="collapse" title="折叠 / 展开">–</button>
      </div>
      <div class="body">
        <div class="status" data-t="status"></div>
        <div class="loopinfo" data-t="loopinfo"></div>
        <button class="btn" data-act="loop">挂机 关</button>
        <div class="hint">开启后自动播放、跳过已学、进入下一个未学内容；学时按真实播放时长累计（1 学时约 45 分钟，不能加速）。</div>
      </div>
    </div>
  `;

  function buildUI() {
    const host = document.createElement('div');
    host.id = '__course_helper_host';
    host.style.cssText =
      'position: fixed; z-index: 2147483647; display: none; right: 16px; bottom: 120px;';

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = TEMPLATE;
    document.documentElement.appendChild(host);

    state.host = host;
    state.root = root;

    root.querySelector('[data-act=collapse]').addEventListener('click', toggleCollapse);
    root.querySelector('[data-act=loop]').addEventListener('click', toggleOn);

    enableDrag(host, root);
    render();
  }

  function toggleCollapse() {
    state.collapsed = !state.collapsed;
    const body = state.root && state.root.querySelector('.body');
    const btn = state.root && state.root.querySelector('[data-act=collapse]');
    if (body) body.classList.toggle('hide', state.collapsed);
    if (btn) btn.textContent = state.collapsed ? '+' : '–';
  }

  function enableDrag(host, root) {
    const head = root.querySelector('.head');
    let startX = 0, startY = 0, startL = 0, startT = 0, dragging = false;

    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target instanceof Element && e.target.closest('button'))) return;
      dragging = true;
      const rect = host.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startL = rect.left;
      startT = rect.top;
      host.style.left = rect.left + 'px';
      host.style.top = rect.top + 'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      try { head.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });

    head.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const nx = Math.min(Math.max(0, startL + e.clientX - startX), Math.max(0, window.innerWidth - host.offsetWidth));
      const ny = Math.min(Math.max(0, startT + e.clientY - startY), Math.max(0, window.innerHeight - 40));
      host.style.left = nx + 'px';
      host.style.top = ny + 'px';
    });

    const end = () => { dragging = false; };
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  }

  /* --------------------------- 课程组件与目录 --------------------------- */

  // 页面（Vue 2）里 learnFrom 组件的根元素挂着 __vue__，从 #app 往下找
  function findLesson() {
    const apps = document.querySelectorAll('#app, #app [id], .app-main, #main');
    let vm = null;
    for (let i = 0; i < apps.length; i++) {
      if (apps[i].__vue__) { vm = apps[i].__vue__; break; }
    }
    if (!vm) {
      const el = document.querySelector('#app');
      if (el && el.__vue__) vm = el.__vue__;
    }
    if (!vm) return null;

    const seen = new Set();
    const stack = [vm];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
      seen.add(cur);
      if (cur.handleNodeClick && cur.treeList && cur.$refs && cur.$refs.tree) return cur;
      const kids = cur.$children;
      if (kids && kids.length) {
        for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
      }
    }
    return null;
  }

  function flattenTree(nodes, out) {
    out = out || [];
    (nodes || []).forEach((n) => {
      out.push(n);
      if (n.list && n.list.length) flattenTree(n.list, out);
    });
    return out;
  }

  function currentNode(vm) {
    const list = flattenTree(vm.treeList);
    const id = vm.treeId || (vm.treeItemData && vm.treeItemData.resourceDirectoryId);
    const index = list.findIndex((n) => n.SYS_UUID === id);
    return { list: list, index: index, node: index >= 0 ? list[index] : null };
  }

  function lessonTitle(vm) {
    const cur = currentNode(vm);
    const t = (cur.node && cur.node.name) || (vm.treeItemData && (vm.treeItemData.title || vm.treeItemData.resourceName)) || '';
    return clampText(t, 24);
  }

  // 跳到下一个资源（页面自己的 handleNodeClick，跟点目录一样）
  function advance(vm, reason) {
    const now = Date.now();
    if (now - state.lastAdvance < 2000) return false;

    const cur = currentNode(vm);
    if (cur.index < 0) {
      state.note = '还没定位到当前章节，稍等再试。';
      return false;
    }
    const next = cur.list[cur.index + 1];
    if (!next) {
      state.note = '已经到目录最后一个资源了，没有下一个可跳转的内容。';
      state.lastAdvance = 0;
      return false;
    }

    state.lastAdvance = now;
    try {
      vm.$refs.tree.setCurrentKey(next.SYS_UUID);
      setTimeout(() => {
        try {
          vm.handleNodeClick(next);
        } catch (e) {
          state.note = '自动跳转失败：' + (e && e.message);
          render();
        }
      }, 200);
      state.note = (reason === 'learned' ? '已学完，跳过：' : '进入下一个：') + clampText(next.name, 22);
      log(state.note);
      return true;
    } catch (e) {
      state.note = '自动跳转失败：' + (e && e.message);
      return false;
    }
  }

  /* ---------------------------- 视频保活 ---------------------------- */

  function playSafe(v) {
    try {
      const p = v.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          state.note = '浏览器拦了自动播放：点一下页面里的播放按钮，之后挂机就会接管。';
          render();
        });
      }
    } catch (e) {
      state.note = '自动播放失败：点一下页面里的播放按钮。';
      render();
    }
  }

  function scheduleResume(v) {
    if (state.resumeTimer) return;
    state.resumeTimer = setTimeout(() => {
      state.resumeTimer = 0;
      if (!state.on || !v.isConnected || v.ended || !v.paused) return;
      playSafe(v);
    }, 700);
  }

  function attachVideo(v) {
    if (state.videoSeen.has(v)) return;
    state.videoSeen.add(v);

    v.addEventListener('play', () => {
      state.lastTs = Date.now();
      state.note = '';
      render();
    });
    v.addEventListener('pause', () => {
      state.lastTs = 0;
      if (!state.on || !v.isConnected || v.ended) return;
      scheduleResume(v);
    });
  }

  function pickVideo() {
    const list = Array.prototype.slice.call(document.querySelectorAll('video'));
    if (!list.length) return null;

    let v = state.video;
    if (!v || list.indexOf(v) === -1) {
      v = list.filter((x) => !x.paused && !x.ended)[0] ||
          list.filter((x) => isFinite(x.duration) && x.duration > 0)[0] ||
          list[0];
      state.video = v;
      attachVideo(v);
    }
    return v;
  }

  /* ------------------------------ 挂机开关 ------------------------------ */

  function toggleOn() {
    state.on = !state.on;
    saveOn(state.on);
    state.note = '';
    state.lastAdvance = 0;
    state.nodeSince = Date.now();

    if (state.on) {
      state.loopSec = 0;
      state.lastTs = Date.now();
      const v = pickVideo();
      if (v) playSafe(v);
      if (!state.lesson) state.lesson = findLesson();
      if (!state.lesson) state.note = '没找到课程组件：请确认是在课程播放页（learnFrom）里打开，页面加载完后会自动重试。';
      log('挂机已开启');
    } else {
      if (state.resumeTimer) {
        clearTimeout(state.resumeTimer);
        state.resumeTimer = 0;
      }
      log('挂机已关闭');
    }
    render();
  }

  /* -------------------------------- 循环 -------------------------------- */

  function tick() {
    if (!state.host) return;

    if (!state.lesson) state.lesson = findLesson();

    const vm = state.lesson;
    const v = pickVideo();

    if (vm) {
      const nodeId = String(vm.treeId || '');
      if (nodeId !== state.nodeId) {
        state.nodeId = nodeId;
        state.nodeSince = Date.now();
      }
    }

    // 视频保活：暂停就拉回播放（挂机开启时）
    if (state.on && v && !v.ended && v.paused) scheduleResume(v);

    // 挂机计时
    if (state.on && v && !v.paused && !v.ended) {
      const now = Date.now();
      const delta = (now - state.lastTs) / 1000;
      if (delta > 0 && delta < 5) state.loopSec += delta;
      state.lastTs = now;
    }

    if (state.on && vm) {
      if (!state.nodeSince) state.nodeSince = Date.now();
      // 当前资源学满了（progressRate = 1）：自动跳过
      const settled = Date.now() - state.nodeSince > 2600;
      if (settled && !vm.loading && Number(vm.progressRate) === 1) {
        advance(vm, 'learned');
      } else if (settled && v && v.ended) {
        // 播完了但页面没自己进下一节（比如没有下一节）：提示
        if (state.nodeSince && Date.now() - state.nodeSince > 5000 && !state.note) {
          state.note = '这一节播完了，页面没有自动进入下一节：点一下左侧目录的下一个资源即可。';
        }
      }
    }

    render();
  }

  /* -------------------------------- 渲染 -------------------------------- */

  function render() {
    const root = state.root;
    const host = state.host;
    if (!root || !host) return;

    const vm = state.lesson;
    const v = state.video;
    const show = !!(vm || v || state.on);
    host.style.display = show ? '' : 'none';

    const btn = root.querySelector('[data-act=loop]');
    if (btn) {
      btn.textContent = state.on ? '挂机 开' : '挂机 关';
      btn.classList.toggle('on', state.on);
    }

    const info = root.querySelector('[data-t=loopinfo]');
    if (info) {
      if (state.on) {
        const title = vm ? lessonTitle(vm) : '';
        info.textContent =
          '挂机中 · 已累计 ' + fmt(state.loopSec) + (title ? ' · 当前：' + title : '');
        info.classList.add('show');
      } else {
        info.classList.remove('show');
      }
    }

    const status = root.querySelector('[data-t=status]');
    if (status) {
      let text = state.note;
      if (!text && !vm) text = '没找到课程组件：请确认在课程播放页打开（脚本会自动重试）。';
      if (!text && vm && !v && state.on) text = '当前资源不是视频，页面开着就会计时，学满后会自动跳到下一个。';
      status.textContent = text || '';
      status.classList.toggle('show', !!text);
    }
  }

  function log(msg) {
    try {
      console.log('[网课助手] ' + msg, location.href);
    } catch (e) {}
  }

  /* -------------------------------- 启动 -------------------------------- */

  function init() {
    buildUI();
    try {
      console.log('[网课助手] v2.0.0 已注入', location.href);
    } catch (e) {}
    tick();
    setInterval(tick, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
