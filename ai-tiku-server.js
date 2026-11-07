#!/usr/bin/env node
/**
 * AI 搜题服务（本地）—— 给 OCS / 网课助手 当「题库」
 *
 * 原理：OCS 的「题库配置」支持自定义接口，本服务把题目转发给大模型
 *        （OpenAI 兼容接口，如 DeepSeek / 通义 / Moonshot / 本地 Ollama），
 *        再把答案转成 OCS 认识的字母/对错/文本格式返回。
 *
 * 用法：
 *   node ai-tiku-server.js                  # 启动服务（默认 127.0.0.1:8765）
 *   node ai-tiku-server.js export           # 导出待答题队列（手动模式用）
 *   node ai-tiku-server.js import answers.json   # 导入答案到缓存
 *   node ai-tiku-server.js test "题目" "A.选项1\nB.选项2"   # 命令行单题测试
 *
 * 配置：同目录 ai-tiku.config.json（首次运行自动生成模板）
 *   provider: llm    —— 调大模型自动答题（需要 apiKey）
 *             manual —— 只把题目塞进队列，等你/我人工给答案后 import
 *             mock   —— 自测用，永远返回 A
 *
 * 零依赖，Node 18+ 即可运行。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const CONFIG_PATH = process.env.AI_TIKU_CONFIG || path.join(ROOT, 'ai-tiku.config.json');

const DEFAULT_CONFIG = {
  port: 8765,
  host: '127.0.0.1',
  provider: 'llm', // llm | manual | mock
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: '',
  temperature: 0.2,
  timeoutMs: 45000,
  jsonMode: true,
  cacheFile: 'ai-tiku-cache.json',
  pendingFile: 'ai-tiku-pending.json',
  correctionsFile: 'ai-tiku-corrections.json',
  hintsFile: 'ai-tiku-hints.json',
  samples: 5, // 每道题独立问几次，再投票（提高正确率；1 = 关闭投票）
  voteTemperature: 0.7, // 投票时的温度，越高几次答案差异越大
  cacheDays: 14, // 超过这个天数的 llm 缓存不再自动使用
  tikuEnabled: true, // 是否先查第三方题库（言溪）
  tikuUrl: 'https://tk.enncy.cn/query',
  tikuToken: '',
  tikuTimeoutMs: 8000,
  reviewOn: 'uncertain', // 复核：never | uncertain（多选/低置信度才复核）| always
  reviewModel: 'deepseek-reasoner', // 复核用的模型（推理模型更准，但慢/贵）
  reviewTimeoutMs: 120000,
};

const STATE = {
  config: null,
  cache: { version: 1, items: {} },
  pending: { version: 1, items: [] },
  corrections: { version: 1, items: {} },
  hints: { version: 1, items: {} },
  cachePath: '',
  pendingPath: '',
  correctionsPath: '',
  hintsPath: '',
  busy: Promise.resolve(), // 串行化大模型请求，避免并打爆
  stats: { total: 0, cache: 0, llm: 0, manual: 0, failed: 0, gen: 0, corrected: 0, review: 0, tiku: 0 },
};

/* ------------------------------ 配置与文件 ------------------------------ */

function loadConfig() {
  let cfg = { ...DEFAULT_CONFIG };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const cfgText = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
      const raw = JSON.parse(cfgText);
      cfg = { ...cfg, ...raw };
    } catch (e) {
      console.error('[config] 解析失败，使用默认配置：', e.message);
    }
  } else {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    console.log('[config] 已生成配置模板：', CONFIG_PATH);
    console.log('         请填写 baseUrl / model / apiKey 后重新启动。');
  }
  if (!cfg.apiKey || String(cfg.apiKey).indexOf('PUT-YOUR') === 0) {
    console.warn('[config] 还没有填写 apiKey（配置：' + CONFIG_PATH + '），AI 答题会失败；填好 Key 后重启服务。');
  }
  if (process.env.AI_TIKU_PROVIDER) cfg.provider = process.env.AI_TIKU_PROVIDER;
  if (process.env.AI_TIKU_KEY) cfg.apiKey = process.env.AI_TIKU_KEY;
  if (process.env.AI_TIKU_PORT) cfg.port = Number(process.env.AI_TIKU_PORT);
  STATE.config = cfg;
  STATE.cachePath = path.join(ROOT, cfg.cacheFile);
  STATE.pendingPath = path.join(ROOT, cfg.pendingFile);
  STATE.correctionsPath = path.join(ROOT, cfg.correctionsFile);
  STATE.hintsPath = path.join(ROOT, cfg.hintsFile || 'ai-tiku-hints.json');
  STATE.cache = readJson(STATE.cachePath, { version: 1, items: {} });
  STATE.pending = readJson(STATE.pendingPath, { version: 1, items: [] });
  STATE.corrections = readJson(STATE.correctionsPath, { version: 1, items: {} });
  STATE.hints = readJson(STATE.hintsPath, { version: 1, items: {} });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('[file] 读取失败，忽略：', file, e.message);
    return fallback;
  }
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[file] 写入失败：', file, e.message);
  }
}

const saveCache = () => saveJson(STATE.cachePath, STATE.cache);
const savePending = () => saveJson(STATE.pendingPath, STATE.pending);
const saveCorrections = () => saveJson(STATE.correctionsPath, STATE.corrections);
const saveHints = () => saveJson(STATE.hintsPath, STATE.hints);

/* ------------------------------ 题目与答案处理 ------------------------------ */

// 去掉平台在题干前加的噪音：题号、"测试题推荐"、"单选题" 之类的题型标签
function stripTitleNoise(s) {
  let t = String(s || '').trim();
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(/^(测试题推荐|单选题|多选题|判断题|单项选择题|多项选择题|单选|多选|判断)\s*/u, '');
    t = t.replace(/^[\d一二三四五六七八九十]+\s*[、.．:：]\s*/u, '');
    t = t.replace(/^(答案|正确答案|参考答案)\s*[:：]\s*/u, '');
    if (t === before) break;
  }
  return t;
}

function normText(s) {
  return stripTitleNoise(s)
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？；：""''、（）【】《》,.!?;:'"()\[\]<>-]/g, '')
    .toLowerCase();
}

function cacheKey(title, options) {
  const raw = normText(title) + '\n' + normText(options);
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function isStale(item) {
  const days = Number(STATE.config && STATE.config.cacheDays) || 14;
  return !!(item && item.ts && Date.now() - item.ts > days * 86400000);
}

/** 缓存查找：先按「题目+选项」精确命中，再按「题目」模糊命中（能按选项文字重映射才复用） */
function findCached(title, options) {
  const usable = (item) => (item && item.answer && !item.wrong && !isStale(item) ? item : null);
  const byKey = usable(STATE.cache.items[cacheKey(title, options)]);
  if (byKey) return byKey;
  const tk = normText(title);
  for (const item of Object.values(STATE.cache.items)) {
    if (!usable(item)) continue;
    if (item.titleKey !== tk && normText(item.question) !== tk) continue;
    if (!options || !item.options) return item;
    if (normText(item.options) === normText(options)) return item;
    const r = remapAnswer(item.answer, item.options, options, item.type);
    if (r.ok) return { ...item, answer: r.answer, options, remapped: true };
  }
  return null;
}

/** 正确答案（corrections）优先于任何 AI/缓存结果 */
function findCorrection(title) {
  const tk = normText(title);
  const items = STATE.corrections.items || {};
  if (items[tk]) return items[tk];
  for (const it of Object.values(items)) {
    if (it && it.answer && normText(it.question) === tk) return it;
  }
  return null;
}

/** 记录/覆盖一条「正确答案」（来自作业结果页、人工核对、导入） */
function saveCorrection({ title, answer, options, type }) {
  const tk = normText(title);
  if (!tk || !answer) return { ok: false, reason: '题目或答案为空' };
  const inferred = inferType(type, options || '');
  const norm = normalizeAnswer(answer, inferred, options || '');
  if (!norm.ok) return { ok: false, reason: norm.reason };
  STATE.corrections.items[tk] = {
    question: title,
    answer: norm.answer,
    options: options || '',
    type: inferred,
    raw: String(answer),
    ts: Date.now(),
    source: 'correction',
  };
  saveCorrections();
  // 同步清掉同题的旧缓存，避免下次误用
  for (const [k, item] of Object.entries(STATE.cache.items)) {
    if (item && normText(item.question) === tk) delete STATE.cache.items[k];
  }
  saveCache();
  return { ok: true, question: title, answer: norm.answer, type: inferred };
}

function optionList(options) {
  const lines = String(options || '')
    .replace(/\r/g, '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const letterOnly = /^([A-H])[.、．:：)）]?$/.exec(line);
    if (letterOnly && lines[i + 1] && !/^[A-H][.、．:：)）]/.test(lines[i + 1])) {
      out.push(letterOnly[1] + '. ' + lines[i + 1]);
      i++;
      continue;
    }
    const withText = /^([A-H])[.、．:：)）]\s*(.+)$/.exec(line);
    if (withText) {
      out.push(withText[1] + '. ' + withText[2]);
      continue;
    }
    out.push(line);
  }
  return out;
}

/** 去掉选项前的「A.」「B、」前缀，只留选项正文，便于跨次重做时按文字对齐选项 */
function cleanOptionText(o) {
  return normText(String(o || '').replace(/^[A-Ha-h][.、．:：)\s、]+/, ''));
}

/**
 * 重做作业时平台可能打乱选项顺序，字母答案会错位。
 * 按「选项文字」把旧答案重映射到当前选项；映射不了返回 ok:false。
 */
function remapAnswer(answer, storedOptions, currentOptions, type) {
  if (type === 'judgement' || type === 'completion') return { ok: false };
  if (!storedOptions || !currentOptions) return { ok: false };
  if (normText(storedOptions) === normText(currentOptions)) return { ok: false };
  const stored = optionList(storedOptions);
  const current = optionList(currentOptions);
  if (!stored.length || stored.length !== current.length) return { ok: false };
  const letters = 'ABCDEFGHIJ';
  let out = '';
  for (const l of String(answer || '').toUpperCase()) {
    const idx = letters.indexOf(l);
    if (idx < 0 || idx >= stored.length) return { ok: false };
    const text = cleanOptionText(stored[idx]);
    if (!text) return { ok: false };
    const ci = current.findIndex((o) => cleanOptionText(o) === text);
    if (ci < 0) return { ok: false };
    out += letters[ci];
  }
  return out ? { ok: true, answer: [...out].sort().join('') } : { ok: false };
}

/** 根据选项特征推断题型（OCS 传来的 type 可能是 unknown） */
function inferType(type, options) {
  const t = String(type || '').toLowerCase();
  if (['single', 'multiple', 'judgement', 'completion'].includes(t)) return t;
  const opts = optionList(options);
  const isJudge = opts.length === 2 && opts.every((o) => /^[A-H][.、．:：)\s]?/.test(o) || /对|错|正确|错误|√|×|是|否/.test(o));
  if (isJudge) return 'judgement';
  const blank = /_{2,}|（\s*）|\(\s*\)/.test(String(options || ''));
  if (!opts.length || blank) return 'completion';
  return 'single';
}

/** 把模型输出规范成 OCS 能识别的答案 */
function normalizeAnswer(answer, type, options) {
  const opts = optionList(options);
  const maxIdx = opts.length ? opts.length - 1 : 5;
  const letters = 'ABCDEFGHIJ';
  const maxLetter = letters[Math.min(maxIdx, letters.length - 1)];

  let a = String(answer == null ? '' : answer).trim();
  if (!a) return { ok: false, reason: '空答案' };

  // 判断题：统一成 对 / 错
  if (type === 'judgement') {
    if (/^(对|正确|是|√|true|t|yes)$/i.test(a)) return { ok: true, answer: '对' };
    if (/^(错|错误|否|×|x|false|f|no)$/i.test(a)) return { ok: true, answer: '错' };
    if (/\btrue\b/i.test(a)) return { ok: true, answer: '对' };
    if (/\bfalse\b/i.test(a)) return { ok: true, answer: '错' };
    return { ok: false, reason: '判断题答案无法识别: ' + a };
  }

  // 填空/简答：原样返回，多空用 # 分隔
  if (type === 'completion') {
    a = a.replace(/\s*[|｜]\s*/g, '|').replace(/\n+/g, '#').replace(/[#|]+/g, '#');
    return { ok: true, answer: a.replace(/^#|#$/g, '') };
  }

  // 选择：提取字母；也支持模型直接回了选项文字
  let lettersOut = (a.match(/[A-J]/g) || []).filter((l) => l <= maxLetter);
  lettersOut = [...new Set(lettersOut)].sort();
  if (!lettersOut.length) {
    // 模型返回了选项原文：按包含关系找
    const hit = opts
      .map((text, i) => ({ i, text: normText(cleanOptionText(text)) }))
      .filter(({ text }) => text && (normText(a).includes(text) || text.includes(normText(a))))
      .map(({ i }) => letters[i])
      .filter(Boolean);
    lettersOut = [...new Set(hit)].sort();
  }
  if (!lettersOut.length) return { ok: false, reason: '答案里没有有效选项字母: ' + a };
  if (type === 'single' && lettersOut.length > 1) lettersOut = [lettersOut[0]];
  return { ok: true, answer: lettersOut.join('') };
}

/* ------------------------------ 第三方题库（言溪） ------------------------------ */

/** 查第三方题库；命中返回 { answer(字母), raw }, 未命中返回 null */
async function queryTiku({ title, options, type }) {
  const cfg = STATE.config;
  if (cfg.tikuEnabled === false || !cfg.tikuUrl || !cfg.tikuToken) return null;
  const body = {
    token: cfg.tikuToken,
    title,
    options: options || '',
    type: type === 'judgement' ? 'judgement' : type === 'multiple' ? 'multiple' : 'single',
    v: '2',
    suggestion_title: '',
    suggestion_options: '',
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.tikuTimeoutMs || 8000);
  try {
    const res = await fetch(cfg.tikuUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => null);
    if (!data || data.code !== 1 || !data.data || !data.data.answer) {
      if (data) console.log('[tiku] 未命中 code=' + data.code + ' ' + String(data.message || '').slice(0, 60));
      return null;
    }
    let ans = String(data.data.answer).trim();
    // 言溪有时把答案存成 JSON 数组字符串，如 ["错"]、["A","B"]、["","对"]，先拆开再规范化
    if (/^\[.*\]$/.test(ans)) {
      try {
        const arr = JSON.parse(ans);
        if (Array.isArray(arr)) ans = arr.map((x) => String(x == null ? '' : x)).join('');
      } catch (e) {
        ans = ans.replace(/[\[\]"'\s]/g, '');
      }
    }
    const norm = normalizeAnswer(ans, type, options);
    if (norm.ok) return { answer: norm.answer, raw: ans, question: data.data.question };
    // 多选题常返回 "A、B、C" 这类格式，逐个解析再合并
    const parts = ans.split(/[;；,，、|\s]+/).filter(Boolean);
    const letters = [];
    for (const p of parts) {
      const n = normalizeAnswer(p, type, options);
      if (n.ok) letters.push(...n.answer.split(''));
    }
    const merged = [...new Set(letters)].sort().join('');
    if (merged) return { answer: merged, raw: ans, question: data.data.question };
    console.log('[tiku] 答案无法映射：' + ans.slice(0, 80));
    return null;
  } catch (e) {
    console.log('[tiku] 请求失败：' + e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ 大模型调用 ------------------------------ */

function buildPrompt({ title, options, type }) {
  const opts = optionList(options);
  const optsText = opts.length ? '选项：\n' + opts.join('\n') + '\n' : '';
  // 答错过的题：把平台 AI 解析当参考塞进提示词，重做时更容易答对
  const tk = normText(title);
  let hintText = '';
  const hint = STATE.hints && STATE.hints.items && STATE.hints.items[tk];
  if (hint && hint.analysis) {
    hintText = '平台给出的解析（可信度高，请以它为主要依据）：\n' + String(hint.analysis).slice(0, 1500) + '\n';
    if (hint.wrongAnswer) hintText += '上一次的错误作答：' + String(hint.wrongAnswer).slice(0, 120) + '（不要再选它）\n';
  }

  // 课程知识：命中关键词时注入教材口径，避免模型用常识答错教材原文题
  let knowledgeText = '';
  if (/军事安全|军队安全|军备安全|军人安全|军纪安全|军事活动安全|军队事务/.test(title)) {
    knowledgeText =
      '【课程教材口径·军事安全】\n' +
      '1) 定义：军事安全就是国家军队事务处于没有危险的客观状态（教材定义用「军队事务」，不是「军事活动」；军事活动是军事安全涉及的对象之一，不是定义中的空）。\n' +
      '2) 军事安全首先就是军队安全；军队安全是军事安全中最基本、最核心的内容。\n' +
      '3) 军事装备（军备）是军队战斗力的物质保障，军事装备安全（军备安全）是军事安全的基础。\n' +
      '4) 军事安全的内容包括：军队安全、军人安全、军纪安全、军备安全、军事设施安全、军事秘密安全、军事信息安全、军事工业安全、军事活动安全。\n' +
      '（遇到「基础/首先/核心」等措辞时按上述对应关系作答：基础=军备安全，首先/核心=军队安全。）\n';
  }

  const typeText = { single: '单选题', multiple: '多选题', judgement: '判断题', completion: '填空/简答题' }[type] || '题目';
  const extra =
    type === 'judgement'
      ? '判断题：判断该命题在教材/课程中的正误；含「总是、一定、完全、所有、必须」等绝对化措辞的多判为「错」。'
      : type === 'multiple'
      ? '多选题：正确选项通常为 2~4 个，逐项判断是否成立，不要漏选；「下列哪个不是」这类否定问法要把符合错误描述的选项选出来。'
      : type === 'completion'
      ? '填空题：只填括号/空格处应填的原文，多空按顺序用 # 分隔，不要写解释。'
      : '单选题：只有一个最佳答案；先逐项排除再定；注意「下列哪个不是/错误的是」这类否定问法要选不符合描述的那项。';

  const system =
    '你是一位熟悉高校公共课（军事理论、思政、形势与政策等）教材与常见题库的资深教师，正在批改学生作业。' +
    '请先逐项核对每个选项与教材原文/课程知识的对应关系，再给出最可能被平台判定为正确的答案。' +
    '平台以教材原文/课程团队标准答案为准；若你的常识与常见教材表述冲突，以教材常见表述为准。' +
    '注意：题干里的括号空缺就是要求你填的内容；否定题（不是/不包括/错误的是）要选与描述相反的那项。' +
    '必须只输出一个 JSON 对象：{"analysis": "<80字内，逐项判断或关键依据>", "answer": "<答案>", "reason": "<20字以内>"}，不要输出 Markdown、代码块或多余文字。' +
    '格式：单选题 answer 为单个大写字母；多选题为按字母升序拼接（如 "ACD"）；判断题 answer 只能是 "对" 或 "错"；填空题 answer 为原文、多空用 # 分隔。' +
    '即使不确定也必须给出答案，不要留空。';

  const user = `题型：${typeText}\n${extra}\n${hintText}${knowledgeText}题目：${title}\n${optsText}请直接输出 JSON。`;


  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

async function callLLM(messages, opts) {
  const { baseUrl, model, apiKey, temperature, timeoutMs, jsonMode } = STATE.config;
  if (!apiKey) throw new Error('未配置 apiKey（ai-tiku.config.json）');
  const url = String(baseUrl).replace(/\/+$/, '') + '/chat/completions';
  const temp = opts && typeof opts.temperature === 'number' ? opts.temperature : typeof temperature === 'number' ? temperature : 0.2;
  const useModel = (opts && opts.model) || model;
  const useJson = opts && typeof opts.jsonMode === 'boolean' ? opts.jsonMode : jsonMode !== false;
  const useTimeout = (opts && opts.timeoutMs) || timeoutMs || 45000;
  const payload = {
    model: useModel,
    messages,
    temperature: temp,
    stream: false,
  };
  // 部分兼容接口（如老版本 Ollama）不认 response_format，可用 jsonMode:false 关掉
  if (useJson) payload.response_format = { type: 'json_object' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), useTimeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('模型返回不是 JSON: ' + text.slice(0, 200));
    }
    const content = data?.choices?.[0]?.message?.content || '';
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function parseLLMContent(content) {
  let c = String(content || '').trim();
  // 去掉 ```json 包裹
  c = c.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const obj = JSON.parse(c);
    if (obj && obj.answer != null) return String(obj.answer);
  } catch (e) {
    // 继续尝试截取
  }
  const m = c.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj && obj.answer != null) return String(obj.answer);
    } catch (e) {}
  }
  // 兜底：文本里直接给答案
  const am = c.match(/["']?answer["']?\s*[:：]\s*["']?([A-J]{1,8}|对|错|正确|错误)/i);
  if (am) return am[1];
  const letters = c.match(/[A-J]{1,8}/);
  if (letters) return letters[0];
  const judge = c.match(/(对|错|正确|错误)/);
  if (judge) return judge[1];
  return '';
}

/* ------------------------------ 多次采样 + 投票 ------------------------------ */

/** 问一次模型，返回规范化后的答案（失败返回 ''） */
async function sampleOnce({ title, options, type }, temperature) {
  const raw = parseLLMContent(await callLLM(buildPrompt({ title, options, type }), { temperature }));
  if (!raw) return '';
  const norm = normalizeAnswer(raw, type, options);
  return norm.ok ? norm.answer : '';
}

function modeOf(list) {
  const counts = new Map();
  let best = '';
  let bestCount = 0;
  for (const a of list) {
    const c = (counts.get(a) || 0) + 1;
    counts.set(a, c);
    if (c > bestCount) {
      best = a;
      bestCount = c;
    }
  }
  return best;
}

/** 对多次采样的答案投票：单选题多数决；多选题逐项过半；判断/填空多数决 */
function voteAnswers(list, type, options) {
  const valid = list.filter(Boolean);
  if (!valid.length) return { answer: '', confidence: 0, votes: {} };
  const opts = optionList(options);
  const letters = 'ABCDEFGHIJ';
  const maxLetter = letters[Math.min(opts.length ? opts.length - 1 : 5, letters.length - 1)];

  if (type === 'multiple') {
    const counts = {};
    for (const a of valid) {
      for (const l of a.split('')) {
        if (l <= maxLetter) counts[l] = (counts[l] || 0) + 1;
      }
    }
    const threshold = Math.max(2, Math.ceil(valid.length / 2)); // 3 票需 2 票
    const picked = Object.keys(counts)
      .filter((l) => counts[l] >= threshold)
      .sort()
      .join('');
    const answer = picked || modeOf(valid);
    const conf = picked ? Math.min(...picked.split('').map((l) => counts[l])) / valid.length : 0.5;
    return { answer, confidence: conf, votes: counts };
  }

  const counts = {};
  for (const a of valid) counts[a] = (counts[a] || 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return { answer: sorted[0][0], confidence: sorted[0][1] / valid.length, votes: counts };
}

/** 同一道题独立问 N 次再投票，N 由 config.samples 控制（默认 3） */
async function sampleAndVote({ title, options, type }) {
  const cfg = STATE.config;
  const samples = Math.max(1, Math.min(5, Number(cfg.samples) || 3));
  const voteTemp = typeof cfg.voteTemperature === 'number' ? cfg.voteTemperature : 0.7;
  const temps = Array.from({ length: samples }, (_, i) => (i === 0 ? cfg.temperature || 0.2 : voteTemp));
  const answers = await Promise.all(
    temps.map((t) => sampleOnce({ title, options, type }, t).catch(() => ''))
  );
  let voted = voteAnswers(answers, type, options);
  if (!voted.answer) {
    // 全部失败：串行重试一次
    const retry = await sampleOnce({ title, options, type }, cfg.temperature || 0.2).catch(() => '');
    if (retry) voted = { answer: retry, confidence: 1 / samples, votes: { [retry]: 1 } };
  }
  return { ...voted, samples: answers.filter(Boolean).length, raw: answers };
}


/** 复核：用推理模型独立再判一次，只在有分歧时改判 */
async function reviewAnswer({ title, options, type, firstAnswer }) {
  const cfg = STATE.config;
  const opts = optionList(options);
  const optsText = opts.length ? '选项：\n' + opts.join('\n') + '\n' : '';
  const typeText = { single: '单选题', multiple: '多选题', judgement: '判断题', completion: '填空题' }[type] || '题目';
  const messages = [
    {
      role: 'system',
      content:
        '你是一位极其严谨的课程答案复核专家，熟悉高校公共课教材原文与常见题库。' +
        '你的任务是独立重新作答，不要受他人答案影响。' +
        '只输出一个 JSON 对象：{"answer": "<答案>", "reason": "<20字以内>"}，不要输出其它文字。' +
        '单选题 answer 为单个大写字母；多选题为字母升序拼接；判断题 answer 为 “对” 或 “错”。',
    },
    {
      role: 'user',
      content:
        '题型：' + typeText + '\n题目：' + title + '\n' + optsText +
        '（上一位同事判断为：' + (firstAnswer || '无') + '，仅供参考，请独立判断）\n请输出 JSON。',
    },
  ];
  try {
    const raw = await callLLM(messages, {
      model: cfg.reviewModel || 'deepseek-reasoner',
      jsonMode: false,
      temperature: 0.2,
      timeoutMs: cfg.reviewTimeoutMs || 120000,
    });
    const parsed = parseLLMContent(raw);
    const n = normalizeAnswer(parsed, type, options);
    return n.ok ? n.answer : '';
  } catch (e) {
    console.log('[review] 复核失败：' + e.message);
    return '';
  }
}

/* ------------------------------ 讨论区内容生成 ------------------------------ */

const GEN_SYSTEM =
  '你是正在上这门网课的大学生，在课程的讨论区发言。' +
  '要求：语言自然口语化，像真人随手写的，不要用 Markdown、不要分点、不要小标题、不要「作为AI」之类的话；' +
  '结合课程内容和对方话题，言之有物，可以带一点个人感受或提问；' +
  '不要照抄题目原文，不要写太长。' +
  '必须只输出一个 JSON 对象，不要输出 Markdown 代码块、不要解释。JSON 格式：{"text": "<正文>"}。';

function buildGenPrompt({ kind, title, content, course }) {
  const isReply = kind === 'reply';
  const isQuestion = kind === 'question';
  const courseText = course ? `课程：${course}\n` : '';
  const titleText = title ? `${isReply ? '话题标题' : isQuestion ? '提问主题' : '要发的帖子主题'}：${title}\n` : '';
  const bodyText = content ? `${isReply ? '对方话题内容' : '想写的内容要点'}：\n${String(content).slice(0, 800)}\n` : '';
  const ask = isReply
    ? '请写一条回复（30~80 字），回应对方话题，可以补充自己的理解。'
    : isQuestion
      ? '请写一条学生的课堂提问（30~80 字），要是一个真实、具体的疑问句，结合课程内容，不要空泛，不要自问自答。'
      : '请写一条讨论帖正文（60~120 字），围绕上面的主题，像真人发起讨论。';
  const user = `${courseText}${titleText}${bodyText}${ask}\n直接输出 JSON。`;
  return [
    { role: 'system', content: GEN_SYSTEM },
    { role: 'user', content: user },
  ];
}

/** 从模型输出里取正文：优先 JSON.text，其次去代码块后的原文 */
function parseGenText(content) {
  const raw = String(content || '').trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    if (obj && obj.text != null) return String(obj.text).trim();
  } catch (e) {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj && obj.text != null) return String(obj.text).trim();
    } catch (e) {}
  }
  return cleaned.replace(/^["']|["']$/g, '').trim();
}

async function generateContent(input) {
  const kind = input.kind === 'topic' || input.kind === 'question' ? input.kind : 'reply';
  const title = String(input.title || '').trim();
  const content = String(input.content || '').trim();
  const course = String(input.course || '').trim();
  if (!title && !content) return { ok: false, error: 'title 和 content 至少给一个' };

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = parseGenText(await callLLM(buildGenPrompt({ kind, title, content, course })));
      if (text) {
        STATE.stats.gen++;
        return { ok: true, kind, text };
      }
      lastErr = new Error('模型返回空内容');
    } catch (e) {
      lastErr = e;
      console.warn(`[gen] 第 ${attempt + 1} 次失败：`, e.message);
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  return { ok: false, error: '生成失败：' + (lastErr ? lastErr.message : '未知错误') };
}



async function answerQuestion(input) {
  const title = String(input.title || input.question || '').trim();
  const options = String(input.options || '');
  const type = inferType(input.type, options);
  const key = cacheKey(title, options);
  const force = !!input.force;
  STATE.stats.total++;

  // 0. 正确答案（来自作业结果页/人工核对）优先级最高；选项打乱时按文字重映射
  const fixed = findCorrection(title);
  if (fixed && fixed.answer) {
    let ans = fixed.answer;
    if (options && fixed.options && normText(fixed.options) !== normText(options)) {
      const r = remapAnswer(fixed.answer, fixed.options, options, type);
      if (r.ok) {
        ans = r.answer;
      } else if (fixed.raw && /[A-Ja-j]/.test(fixed.raw) === false) {
        const n = normalizeAnswer(fixed.raw, type, options);
        if (n.ok) ans = n.answer;
      } else {
        console.log('[correct] 选项文字对不上，先按题序使用已记录的答案：' + title.slice(0, 30));
      }
    }
    STATE.stats.corrected++;
    return {
      ok: true,
      question: title,
      type,
      answer: ans,
      answers: [ans],
      source: 'correction',
      confidence: 1,
    };
  }

  // 1. 缓存（命中时已按当前选项重映射；不再拿 raw 重新规范化，避免选项顺序变化导致字母错位）
  const cached = force ? null : findCached(title, options);
  if (cached && cached.answer) {
    const ans = cached.answer;
    cached.hits = (cached.hits || 1) + 1;
    STATE.stats.cache++;
    return {
      ok: true,
      question: title,
      type,
      answer: ans,
      answers: [ans],
      source: cached.remapped ? 'cache-remap' : 'cache',
      confidence: cached.confidence,
    };
  }

  if (!title) {
    STATE.stats.failed++;
    return { ok: false, error: '题目为空', question: title, type };
  }

  let provider = STATE.config.provider;

  // 2. 手动模式：入队
  if (provider === 'manual') {
    const exists = STATE.pending.items.some((i) => i.key === key);
    if (!exists) {
      STATE.pending.items.push({
        key,
        title,
        options,
        type,
        ts: Date.now(),
      });
      savePending();
      console.log('[manual] 新题入队：', title.slice(0, 40).replace(/\n/g, ' '));
    }
    STATE.stats.manual++;
    return {
      ok: true,
      question: title,
      type,
      answer: '',
      answers: [],
      source: 'manual',
      queued: true,
      pending: STATE.pending.items.length,
    };
  }

  // 2.5 第三方题库（言溪）优先：命中就不用问大模型了
  const tikuHit = await queryTiku({ title, options, type });
  if (tikuHit && tikuHit.answer) {
    STATE.stats.tiku++;
    STATE.cache.items[key] = {
      question: title,
      titleKey: normText(title),
      options,
      type,
      answer: tikuHit.answer,
      votes: {},
      samples: 0,
      confidence: 0.95,
      source: 'tiku',
      raw: tikuHit.raw,
      ts: Date.now(),
      hits: 1,
    };
    saveCache();
    console.log('[search] tiku | ' + type + ' | ' + title.slice(0, 40) + ' => ' + tikuHit.answer + ' (' + tikuHit.raw + ')');
    return {
      ok: true,
      question: title,
      type,
      answer: tikuHit.answer,
      answers: [tikuHit.answer],
      source: 'tiku',
      confidence: 0.95,
    };
  }

  // 3. 大模型 / mock
  let answer = '';
  let confidence = 0.75;
  let votes = {};
  let usedSamples = 1;
  if (provider === 'mock') {
    answer = type === 'judgement' ? '对' : type === 'completion' ? '测试答案' : 'A';
  } else {
    const out = await sampleAndVote({ title, options, type });
    answer = out.answer;
    confidence = Math.round((out.confidence || 0) * 100) / 100;
    votes = out.votes || {};
    usedSamples = out.samples || 0;
    if (!answer) {
      STATE.stats.failed++;
      return { ok: false, error: '模型多次采样都没有给出有效答案', question: title, type };
    }
    if (confidence < 1 && usedSamples > 1) {
      console.log(`[vote] 不一致，仅 ${Math.round(confidence * 100)}% 一致：${JSON.stringify(votes)}`);
    }
  }

  const reviewOnCfg = STATE.config.reviewOn || 'uncertain';
  const needReview = !!answer && (reviewOnCfg === 'always' || (reviewOnCfg === 'uncertain' && (type === 'multiple' || confidence < 0.8)));
  if (needReview) {
    const reviewed = await reviewAnswer({ title, options, type, firstAnswer: answer });
    STATE.stats.review++;
    if (reviewed && reviewed !== answer) {
      console.log('[review] 改判：' + answer + ' → ' + reviewed + '（' + title.slice(0, 30).replace(/\n/g, ' ') + '）');
      votes = Object.assign({}, votes, { reviewChanged: 1 });
      answer = reviewed;
      confidence = Math.max(confidence, 0.9);
      provider = 'llm+review';
    }
  }

  STATE.cache.items[key] = {
    question: title,
    titleKey: normText(title),
    options,
    type,
    answer,
    votes,
    samples: usedSamples,
    confidence,
    source: provider,
    ts: Date.now(),
    hits: 1,
  };
  saveCache();
  STATE.stats.llm++;
  return {
    ok: true,
    question: title,
    type,
    answer,
    answers: [answer],
    source: provider,
    confidence,
    votes,
  };
}

/** 同一时间只跑一道题，避免 OCS 多线程把接口打爆 */
function enqueueAnswer(input) {
  const run = STATE.busy.then(() => answerQuestion(input));
  STATE.busy = run.catch(() => {});
  return run;
}

/** 生成讨论区内容（发帖/回复），与答题同样串行，避免并发打爆接口 */
function enqueueGenerate(input) {
  const run = STATE.busy.then(() => generateContent(input));
  STATE.busy = run.catch(() => {});
  return run;
}

/* ------------------------------ HTTP 服务 ------------------------------ */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// OCS 桌面版内置浏览器装不上 file:// 本地脚本，所以把脚本通过 HTTP 发出去，
// 在 OCS 的「脚本管理」里按网络脚本（https://.../scripts/xxx.user.js）登记即可。
//
// 脚本发布目录：放在 %LOCALAPPDATA%\ai-tiku-scripts，服务启动时从工作目录同步一份，
// 这样工作目录被清理/移动也不会影响 OCS 里已登记的脚本地址。
const SCRIPT_FILES = [
  'course-helper.user.js',
  'course-discuss.user.js',
  'course-grade-feedback.user.js',
  'course-login.user.js',
  'course-exam.user.js',
  'course-mastery.user.js',
];

const SCRIPT_DIR = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'ai-tiku-scripts')
  : path.join(ROOT, 'scripts');

function syncScripts() {
  try {
    fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  } catch (e) {
    console.error('[scripts] 创建发布目录失败：' + e.message);
    return;
  }
  SCRIPT_FILES.forEach((name) => {
    const src = path.join(ROOT, name);
    const dst = path.join(SCRIPT_DIR, name);
    try {
      if (!fs.existsSync(src)) return;
      const st = fs.statSync(src);
      if (fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= st.mtimeMs) return;
      fs.copyFileSync(src, dst);
      console.log('[scripts] 已发布 ' + name);
    } catch (e) {
      console.error('[scripts] 同步 ' + name + ' 失败：' + e.message);
    }
  });
}

function serveScript(req, res, url) {
  try {
    syncScripts();
  } catch (e) {
    /* ignore */
  }
  const name = decodeURIComponent(url.pathname.replace(/^\/scripts\/?/, '').split('?')[0]);
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };
  if (!name) {
    const items = SCRIPT_FILES.map((f) => `<li><a href="/scripts/${f}">${f}</a></li>`).join('');
    const html = `<!doctype html><meta charset="utf-8"><title>AI 搜题 · 本地脚本</title>` +
      `<h3>本地 userscript（OCS 里按这个地址登记）</h3><ul>${items}</ul>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...cors });
    res.end(html);
    return;
  }
  if (SCRIPT_FILES.indexOf(name) === -1) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...cors });
    res.end('not found');
    return;
  }
  const file = path.join(SCRIPT_DIR, name);
  let body = '';
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', ...cors });
    res.end('read failed: ' + e.message);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', ...cors, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function startServer() {
  const { port, host } = STATE.config;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const started = Date.now();

    if (req.method === 'OPTIONS') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // OCS 题库卡片先用 HEAD 探活（失败才降级 GET），所以 HEAD 一律直接 200
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Content-Length': 0,
      });
      res.end();
      return;
    }

    try {
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
        sendJson(res, 200, {
          ok: true,
          service: 'ai-tiku',
          provider: STATE.config.provider,
          model: STATE.config.model,
          stats: STATE.stats,
          pending: STATE.pending.items.length,
          cache: Object.keys(STATE.cache.items).length,
          corrections: Object.keys(STATE.corrections.items).length,
          hints: Object.keys(STATE.hints.items).length,
          samples: STATE.config.samples,
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/stats') {
        sendJson(res, 200, {
          ok: true,
          stats: STATE.stats,
          cache: Object.keys(STATE.cache.items).length,
          pending: STATE.pending.items.length,
          provider: STATE.config.provider,
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/pending') {
        sendJson(res, 200, { ok: true, count: STATE.pending.items.length, items: STATE.pending.items });
        return;
      }

      // 分发本地 userscript 给 OCS 的脚本管理器安装/更新
      if (req.method === 'GET' && (url.pathname === '/scripts' || url.pathname.startsWith('/scripts/'))) {
        serveScript(req, res, url);
        return;
      }

      // OCS 的「题库配置」检测会用 GET 带查询参数探活，所以 GET /search 也要能应答
      if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/search') {
        let body = {};
        if (req.method === 'POST') {
          const raw = await readBody(req);
          try {
            body = raw ? JSON.parse(raw) : {};
          } catch (e) {
            sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
            return;
          }
        } else {
          body = {
            title: url.searchParams.get('title') || url.searchParams.get('question') || '连接测试',
            options: url.searchParams.get('options') || '',
            type: url.searchParams.get('type') || '',
          };
          // 纯探活（没有题干）时直接回 200，不去调大模型
          if (!url.searchParams.get('title') && !url.searchParams.get('question')) {
            sendJson(res, 200, { ok: true, service: 'ai-tiku', message: 'ok', answer: '', answers: [] });
            return;
          }
        }
        // 兼容 OCS 的字段名，也允许直接传 question/options；force=true 跳过缓存重新问
        const input = {
          title: body.title || body.question || '',
          options: body.options || '',
          type: body.type || '',
          force: !!(body.force || url.searchParams.get('force')),
        };
        const result = await enqueueAnswer(input);
        const elapsed = Date.now() - started;
        console.log(
          `[search] ${result.source || (result.ok ? 'ok' : 'fail')} ${elapsed}ms | ` +
            (result.type || '?') + ' | ' + String(input.title).slice(0, 36).replace(/\n/g, ' ') +
            ' => ' + (result.answer || result.error || '')
        );
        // 永远 200，答案为空时 OCS 会按「没搜到」处理
        sendJson(res, 200, {
          ok: !!result.ok,
          question: result.question || input.title,
          type: result.type,
          answer: result.answer || '',
          answers: result.answers || [],
          source: result.source,
          confidence: result.confidence,
          votes: result.votes,
          queued: !!result.queued,
          pending: result.pending,
          error: result.error,
          elapsed,
        });
        return;
      }

      // 讨论区内容生成：POST /generate {kind:"reply"|"topic", title, content, course}
      if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/generate') {
        let body = {};
        if (req.method === 'POST') {
          const raw = await readBody(req);
          try {
            body = raw ? JSON.parse(raw) : {};
          } catch (e) {
            sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
            return;
          }
        } else {
          body = {
            kind: url.searchParams.get('kind') || 'reply',
            title: url.searchParams.get('title') || '',
            content: url.searchParams.get('content') || '',
            course: url.searchParams.get('course') || '',
          };
        }
        const result = await enqueueGenerate(body);
        const elapsed = Date.now() - started;
        console.log(
          `[gen] ${result.ok ? 'ok' : 'fail'} ${elapsed}ms | ${result.kind || body.kind || '?'} | ` +
            String(body.title || body.content || '').slice(0, 30).replace(/\n/g, ' ') +
            ' => ' + String(result.text || result.error || '').slice(0, 40)
        );
        sendJson(res, 200, { ...result, elapsed });
        return;
      }

      // 存原始抓取数据（成绩回填页面的 Vue 数据），方便按真实字段名写解析
      if (req.method === 'POST' && url.pathname === '/raw') {
        const raw = await readBody(req);
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch (e) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
          return;
        }
        const payload = {
          at: new Date().toISOString(),
          page: String(body.page || ''),
          url: String(body.url || ''),
          count: body.count || (Array.isArray(body.data) ? body.data.length : 0),
          data: body.data != null ? body.data : body,
        };
        const file = path.join(ROOT, 'ai-tiku-raw.json');
        let bytes = 0;
        try {
          const text = JSON.stringify(payload, null, 1);
          bytes = Buffer.byteLength(text);
          fs.writeFileSync(file, text, 'utf8');
        } catch (e) {
          sendJson(res, 500, { ok: false, error: '写入失败：' + e.message });
          return;
        }
        console.log('[raw] 收到原始数据 ' + bytes + ' 字节，' + payload.count + ' 题，来自 ' + payload.page.slice(0, 90));
        sendJson(res, 200, { ok: true, saved: bytes, path: file });
        return;
      }

      // 预览最近一次原始抓取
      if (req.method === 'GET' && url.pathname === '/raw') {
        const file = path.join(ROOT, 'ai-tiku-raw.json');
        let text = '';
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch (e) {
          sendJson(res, 200, { ok: true, empty: true, message: '还没有抓取数据' });
          return;
        }
        const limit = Math.max(200, Math.min(20000, Number(url.searchParams.get('limit')) || 4000));
        sendJson(res, 200, {
          ok: true,
          bytes: Buffer.byteLength(text),
          preview: text.slice(0, limit),
        });
        return;
      }

      // 页面结构诊断上报：POST /diagnose {url, kind, bodyText, items}
      if (req.method === 'POST' && url.pathname === '/diagnose') {
        const raw = await readBody(req);
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch (e) { /* ignore */ }
        const file = path.join(ROOT, 'ai-tiku-diagnose.json');
        let arr = [];
        try { arr = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { arr = []; }
        if (!Array.isArray(arr)) arr = [];
        arr.push({ ts: Date.now(), ...body });
        while (arr.length > 30) arr.shift();
        fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8');
        console.log('[diagnose] 收到页面结构：' + String(body.url || '').slice(0, 100) + ' kind=' + body.kind);
        sendJson(res, 200, { ok: true, saved: arr.length });
        return;
      }

      // 反馈正确答案：POST /correct  {title, answer, options?, type?} 或 {items:[...]}
      if (req.method === 'POST' && (url.pathname === '/correct' || url.pathname === '/corrections')) {
        const raw = await readBody(req);
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch (e) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
          return;
        }
        const list = Array.isArray(body) ? body : Array.isArray(body.items) ? body.items : [body];
        const okList = [];
        const badList = [];
        for (const item of list) {
          const title = String(item.question || item.title || '').trim();
          const answer = item.answer != null ? String(item.answer) : Array.isArray(item.answers) ? item.answers.join('') : '';
          const r = saveCorrection({ title, answer, options: item.options, type: item.type });
          if (r.ok) okList.push(r);
          else badList.push({ title: title.slice(0, 40), reason: r.reason });
        }
        console.log(`[correct] 成功 ${okList.length} 题，失败 ${badList.length} 题；累计正确答案 ${Object.keys(STATE.corrections.items).length}`);
        sendJson(res, 200, {
          ok: true,
          saved: okList.length,
          failed: badList,
          corrections: Object.keys(STATE.corrections.items).length,
          items: okList,
        });
        return;
      }

      // 反馈「答错的题」：POST /wrong {items:[{question, options?, analysis?, stuAnswer?, type?}]}
      // 作用：① 删掉这题的缓存答案与错误「正确答案」，避免下一轮重做继续错；
      //      ② 把平台 AI 解析存成 hint，下次答这题时塞进提示词，提高命中率。
      if (req.method === 'POST' && (url.pathname === '/wrong' || url.pathname === '/wrongs')) {
        const raw = await readBody(req);
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch (e) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
          return;
        }
        const list = Array.isArray(body) ? body : Array.isArray(body.items) ? body.items : [body];
        let removedCache = 0;
        let removedCorrections = 0;
        let savedHints = 0;
        for (const item of list) {
          const title = String(item.question || item.title || '').trim();
          const tk = normText(title);
          if (!tk) continue;
          STATE.stats.wrong = (STATE.stats.wrong || 0) + 1;
          // 删缓存
          for (const [k, it] of Object.entries(STATE.cache.items || {})) {
            if (it && (it.titleKey === tk || normText(it.question) === tk)) {
              delete STATE.cache.items[k];
              removedCache++;
            }
          }
          // 删错误「正确答案」
          if (STATE.corrections.items && STATE.corrections.items[tk]) {
            delete STATE.corrections.items[tk];
            removedCorrections++;
          }
          // 存平台解析（hint）
          const analysisRaw = item.analysis;
          let analysis = '';
          if (typeof analysisRaw === 'string') analysis = analysisRaw;
          else if (analysisRaw && typeof analysisRaw === 'object') {
            analysis = String(analysisRaw.content || analysisRaw.analysis || analysisRaw.answerAnalyse || analysisRaw.text || '');
          }
          analysis = normText(analysis);
          if (analysis.length > 8) {
            const prev = STATE.hints.items[tk] || {};
            STATE.hints.items[tk] = {
              question: title,
              options: String(item.options || prev.options || ''),
              analysis: analysis.slice(0, 1500),
              wrongAnswer: String(item.stuAnswer || item.answer || prev.wrongAnswer || ''),
              ts: Date.now(),
              count: (prev.count || 0) + 1,
            };
            savedHints++;
          }
        }
        saveCache();
        saveCorrections();
        saveHints();
        console.log(`[wrong] 删缓存 ${removedCache} 条、删错误答案 ${removedCorrections} 条、存解析 ${savedHints} 条；解析库共 ${Object.keys(STATE.hints.items).length} 条`);
        sendJson(res, 200, {
          ok: true,
          removedCache,
          removedCorrections,
          savedHints,
          hints: Object.keys(STATE.hints.items).length,
        });
        return;
      }

      // 看已保存的解析 hint
      if (req.method === 'GET' && url.pathname === '/hints-list') {
        sendJson(res, 200, {
          ok: true,
          count: Object.keys(STATE.hints.items).length,
          items: Object.values(STATE.hints.items).map((h) => ({
            question: h.question,
            analysis: String(h.analysis || '').slice(0, 300),
            count: h.count,
          })),
        });
        return;
      }

      // 查已经有了哪些「正确答案」
      if (req.method === 'GET' && url.pathname === '/corrections-list') {
        sendJson(res, 200, {
          ok: true,
          count: Object.keys(STATE.corrections.items).length,
          items: Object.values(STATE.corrections.items),
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/clear-cache') {
        const scope = url.searchParams.get('scope') || 'answers';
        if (scope === 'all' || scope === 'answers') {
          STATE.cache = { version: 1, items: {} };
          saveCache();
        }
        if (scope === 'all' || scope === 'corrections') {
          STATE.corrections = { version: 1, items: {} };
          saveCorrections();
        }
        sendJson(res, 200, {
          ok: true,
          scope,
          cache: Object.keys(STATE.cache.items).length,
          corrections: Object.keys(STATE.corrections.items).length,
        });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Not Found' });
    } catch (e) {
      console.error('[server] 异常：', e);
      sendJson(res, 500, { ok: false, error: e.message });
    }
  });

  syncScripts();
  server.listen(port, host, () => {
    const cfg = STATE.config;
    console.log('======================================================');
    console.log('  AI 搜题服务已启动');
    console.log(`  地址：http://${host}:${port}/search`);
    console.log(`  模式：${cfg.provider}    模型：${cfg.model}    每题采样：${cfg.samples || 3} 次投票`);
    console.log(`  题库缓存文件：${STATE.cachePath}`);
    console.log(`  正确答案文件：${STATE.correctionsPath}（已有 ${Object.keys(STATE.corrections.items).length} 条）`);
    console.log(`  待答队列文件：${STATE.pendingPath}`);
    console.log(`  用户脚本发布：http://${host}:${port}/scripts/  ← ${SCRIPT_DIR}`);
    console.log('  反馈正确答案：POST /correct  {title, answer}；作业结果页可用 course-grade-feedback.user.js');
    if (cfg.provider === 'llm' && !cfg.apiKey) {
      console.log('  ⚠️ 未填写 apiKey，llm 模式会全部失败；可先用 manual 模式。');
    }
    console.log('======================================================');
  });
  return server;
}

/* ------------------------------ CLI ------------------------------ */

function humanQuestion(item, idx) {
  const opts = optionList(item.options).map((o) => '  ' + o).join('\n');
  return `#${idx + 1}\n题目：${item.title}\n${opts ? '选项：\n' + opts + '\n' : ''}题型：${item.type}`;
}

function cmdExport() {
  const items = STATE.pending.items;
  if (!items.length) {
    console.log('待答队列为空。');
    return;
  }
  const txt = items.map(humanQuestion).join('\n\n');
  const txtPath = path.join(ROOT, 'ai-tiku-pending.txt');
  fs.writeFileSync(txtPath, txt, 'utf8');
  savePending();
  console.log(`已导出 ${items.length} 道题：${txtPath}`);
  console.log('把文本发给 AI，让它按下面格式回答，然后 import：');
  console.log('  [{"question": "题目原文", "answer": "A"}, ...]');
  console.log('\n----- 预览 -----\n' + txt.slice(0, 1500));
}

function cmdImport(file) {
  if (!file) {
    console.error('用法：node ai-tiku-server.js import answers.json');
    process.exit(1);
  }
  const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  const arr = readJson(abs, []);
  const list = Array.isArray(arr) ? arr : arr.items || [];
  let hit = 0;
  let miss = 0;
  const byNorm = new Map();
  for (const item of STATE.pending.items) byNorm.set(normText(item.title), item);
  for (const item of list) {
    const title = String(item.question || item.title || '').trim();
    const answer = item.answer != null ? String(item.answer) : Array.isArray(item.answers) ? item.answers.join('') : '';
    if (!title || !answer) {
      miss++;
      continue;
    }
    const pendingItem = byNorm.get(normText(title));
    const key = pendingItem ? pendingItem.key : cacheKey(title, item.options || '');
    const type = pendingItem ? pendingItem.type : inferType(item.type, item.options || '');
    const norm = normalizeAnswer(answer, type, item.options || (pendingItem ? pendingItem.options : ''));
    if (!norm.ok) {
      console.warn('[import] 无法规范化：', title.slice(0, 30), answer, norm.reason);
      miss++;
      continue;
    }
    STATE.cache.items[key] = {
      question: title,
      titleKey: normText(title),
      options: item.options || (pendingItem ? pendingItem.options : ''),
      type,
      answer: norm.answer,
      raw: answer,
      source: 'import',
      ts: Date.now(),
    };
    if (pendingItem) {
      const idx = STATE.pending.items.indexOf(pendingItem);
      if (idx !== -1) STATE.pending.items.splice(idx, 1);
    }
    hit++;
  }
  saveCache();
  savePending();
  console.log(`导入完成：成功 ${hit} 题，失败/跳过 ${miss} 题。缓存总数 ${Object.keys(STATE.cache.items).length}，剩余待答 ${STATE.pending.items.length}。`);
}

function cmdCorrect(file) {
  if (!file) {
    console.error('用法：node ai-tiku-server.js correct answers.json');
    console.error('answers.json 内容示例：[{"question":"题干","answer":"B","options":"A.xx\\nB.yy","type":"single"}]');
    process.exit(1);
  }
  const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  const arr = readJson(abs, []);
  const list = Array.isArray(arr) ? arr : arr.items || [];
  let ok = 0;
  for (const item of list) {
    const r = saveCorrection({
      title: String(item.question || item.title || '').trim(),
      answer: item.answer != null ? String(item.answer) : Array.isArray(item.answers) ? item.answers.join('') : '',
      options: item.options || '',
      type: item.type || '',
    });
    if (r.ok) ok++;
    else console.warn('[correct] 跳过：', r.reason, '|', String(item.question || '').slice(0, 30));
  }
  console.log(`已写入 ${ok} 条正确答案，累计 ${Object.keys(STATE.corrections.items).length} 条。`);
}

async function cmdTest(title, options) {
  if (!title) {
    console.error('用法：node ai-tiku-server.js test "题目" "A.xx\nB.yy"');
    process.exit(1);
  }
  const result = await answerQuestion({ title, options: options || '' });
  console.log(JSON.stringify(result, null, 2));
}

/* ------------------------------ 入口 ------------------------------ */

function main() {
  loadConfig();
  const cmd = process.argv[2];
  const arg = process.argv[3];
  const provider = STATE.config.provider;
  if (cmd === 'export') return cmdExport();
  if (cmd === 'import') return cmdImport(arg);
  if (cmd === 'correct') return cmdCorrect(arg);
  if (cmd === 'test') return cmdTest(arg, process.argv[4] || '');
  // 启动前提醒
  if (provider === 'llm' && !STATE.config.apiKey) {
    console.warn('[warn] llm 模式但没有 apiKey，请在 ai-tiku.config.json 里填写。');
  }
  startServer();
}

main();
