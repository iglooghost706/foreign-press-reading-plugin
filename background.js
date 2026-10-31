'use strict';

/**
 * background.js —— 插件版的大脑。
 *
 * 承担三件事，都放在 service worker 里，是因为：
 *   ① 5.9 万词词典（2.7MB）需要一份共享内存，内容脚本与侧边栏都向这里查；
 *   ② 查词 / 翻译要走跨域请求，内容脚本直接 fetch 会被 CORS 拦掉；
 *   ③ MV3 的 service worker 会被休眠，所有查词必须 `await` 唤回，
 *      词典用「首次懒加载 + 常驻变量」保住（详见 ensureDict）。
 */

const DICT_URLS = ['dict-ecdict.txt', 'dict-lemmas.txt'];

/* 词形还原规则（与软件版共用 engine.js，保证两边判定一致）。
   MV3 的 service worker 用 importScripts 加载经典脚本即可（非 module 类型）。 */
try { importScripts(chrome.runtime.getURL('engine.js')); } catch (e) { /* 没加载就退回纯查表 */ }

let DICT_EC = null;      // Map<word, definition>
let LEMMA_MAP = null;    // Map<inflection, lemma>
let DICT_SET = null;     // Set<word>，供规则还原择优
let dictReady = null;    // Promise，避免并发重复加载

/* ============================================================
 * 词典加载
 * ============================================================ */

/** 把「词⇥释义」整包读进内存（并发调用只会真正加载一次） */
function ensureDict() {
  if (!dictReady) {
    dictReady = (async () => {
      const t0 = Date.now();
      try {
        const [ecTxt, lmTxt] = await Promise.all([
          fetch(chrome.runtime.getURL(DICT_URLS[0])).then((r) => r.ok ? r.text() : ''),
          fetch(chrome.runtime.getURL(DICT_URLS[1])).then((r) => r.ok ? r.text() : '')
        ]);
        DICT_EC = new Map();
        DICT_SET = new Set();
        for (const line of ecTxt.split('\n')) {
          const i = line.indexOf('\t');
          if (i <= 0) continue;
          const w = line.slice(0, i).trim().toLowerCase();
          const d = line.slice(i + 1).trim();
          if (w && d) { DICT_EC.set(w, d); DICT_SET.add(w); }
        }
        LEMMA_MAP = new Map();
        for (const line of lmTxt.split('\n')) {
          const i = line.indexOf('\t');
          if (i <= 0) continue;
          const w = line.slice(0, i).trim().toLowerCase();
          const d = line.slice(i + 1).trim().toLowerCase();
          if (w && d) LEMMA_MAP.set(w, d);
        }
        return { ok: true, size: DICT_EC.size, lemmas: LEMMA_MAP.size, ms: Date.now() - t0 };
      } catch (e) {
        DICT_EC = new Map(); DICT_SET = new Set(); LEMMA_MAP = new Map();
        return { ok: false, size: 0, lemmas: 0, error: String(e && e.message || e) };
      }
    })();
  }
  return dictReady;
}

/* ============================================================
 * 查词：与软件版 server.js 的 lookup() 完全同一条链路
 *   ① 大词典直接命中
 *   ② lemma 查表（accompanied → accompany 这类规则做不到的形态）
 *   ③ 规则还原（用完整词库当 dictSet 择优）
 * ============================================================ */
function lookup(word) {
  const w = String(word || '').trim().toLowerCase();
  if (!w || !DICT_EC) return null;

  const direct = DICT_EC.get(w);
  if (direct) return { word, def: direct, via: 'ecdict' };

  const viaTable = LEMMA_MAP.get(w);
  if (viaTable && DICT_EC.has(viaTable) && viaTable !== w) {
    return { word, def: DICT_EC.get(viaTable), via: 'lemma-table', lemma: viaTable };
  }

  if (globalThis.Engine && typeof Engine.lemmatize === 'function') {
    let lemma = '';
    try { lemma = Engine.lemmatize(w, { dictSet: DICT_SET }); } catch (e) { lemma = ''; }
    if (lemma && lemma.toLowerCase() !== w) {
      const d = DICT_EC.get(lemma.toLowerCase());
      if (d) return { word, def: d, via: 'lemma-rule', lemma: lemma.toLowerCase() };
    }
  }
  return null;
}

/* ============================================================
 * 翻译：多引擎自动降级 + 本地缓存
 *
 * ★ 为什么要改（原来的单引擎方案的真实故障）：
 *   以前只接 MyMemory 一家。它匿名额度是**按 IP 每天 5000 字符**，
 *   50000 字符要带 `de=<邮箱>`。外刊一篇文章拖选几次就烧掉几百字符，
 *   一天正常阅读必然耗尽；耗尽后接口返回 quotaFinished=true，
 *   前端只能显示"额度已用完"，功能等于废掉。而且：
 *     · 额度耗尽 / 代理挂掉 / 被墙 / 429 在用户眼里长得一模一样
 *       （都是"拖选后没译文"），很容易被误判成"功能没实现"。
 *     · 同一段话反复拖选会反复请求，纯属浪费额度。
 *
 * ★ 现在的链路（按顺序，前一个失败自动换下一个）：
 *   ① 本地缓存命中 → 直接返回，0 请求 0 额度
 *   ② Google gtx 免费端点（无 key，长句质量最好，需能访问外网）
 *   ③ MyMemory（国内可直连，带邮箱时 5 万字符/天）
 *   ④ 全失败 → 把"最后一次失败的真实原因"带回前端
 *   另外每个引擎失败后进入**冷却期**，期间不再拖慢下一次翻译：
 *     · 网络类失败（断网/超时/HTTP 错误）冷却 5 分钟
 *     · 额度类失败冷却到当天 24:00
 *   这样即使 Clash 没开（Google 连不上），也只会多等第一次的 5 秒，
 *   之后直接走 MyMemory，不会每次都卡 5 秒。
 *
 * ★ MyMemory 的质量规则（server.js 实测结论，务必保持）：
 *   - 查询串不要加标点（慢 300-500ms，译文还多个句号）
 *   - 判质量必须看 matches[i].quality，不能看 match，也不能信
 *     responseData.translatedText（它取 matches[0]，常是 quality=0 的机翻）
 *       · quality 0   = ModernMT 机器翻译
 *       · quality 70~80 = 人工翻译记忆
 *   - 挑 quality 最高、且 segment 与原词一致的
 *   - 但**全都 quality=0 时不要把结果扔掉**：那仍是有用的机翻，
 *     旧代码 filter(q>0) 之后返回 'lowq'，用户看到"没找到可靠译文"，
 *     实际表现就是"这句话翻不出来"。现在按质量降级使用。
 * ============================================================ */

const TR_CACHE_KEY = 'wk_tr_cache';
const TR_HEALTH_KEY = 'wk_tr_health';
const TR_CACHE_MAX = 2000;                       // 最多缓存多少条
const TR_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;   // 30 天
const DOWN_MS = 5 * 60 * 1000;                   // 网络类失败冷却

let trCache = null;          // Map<key, {t, ts}>
let trCacheTimer = 0;        // 落盘防抖
const inflight = new Map();  // 同一句话并发只发一次
const providerDown = { google: 0, mymemory: 0 };
let lastGood = '';           // 上次成功的引擎，auto 模式下优先
let healthReady = null;

/* 冷却状态必须落盘：MV3 的 service worker 闲置 30 秒就会被回收，
   只放内存的话每次重开都要先等 Google 超时 5 秒，用户体感就是"翻译很卡"。 */
async function ensureHealth() {
  if (!healthReady) {
    healthReady = (async () => {
      try {
        const o = await chrome.storage.local.get(TR_HEALTH_KEY);
        const h = o[TR_HEALTH_KEY] || {};
        providerDown.google = Number(h.google) || 0;
        providerDown.mymemory = Number(h.mymemory) || 0;
        lastGood = typeof h.lastGood === 'string' ? h.lastGood : '';
      } catch (e) { /* 用内存默认值 */ }
    })();
  }
  return healthReady;
}

function saveHealth() {
  try {
    chrome.storage.local.set({
      [TR_HEALTH_KEY]: {
        google: providerDown.google,
        mymemory: providerDown.mymemory,
        lastGood: lastGood
      }
    });
  } catch (e) { /* 落盘失败不影响本次翻译 */ }
}

/* ---------- 缓存 ---------- */
async function ensureCache() {
  if (trCache) return trCache;
  try {
    const o = await chrome.storage.local.get(TR_CACHE_KEY);
    const raw = o[TR_CACHE_KEY];
    trCache = new Map(Array.isArray(raw) ? raw : []);
  } catch (e) {
    trCache = new Map();
  }
  return trCache;
}

function cacheKey(text, pair) {
  return pair + '\u0000' + text.replace(/\s+/g, ' ').trim().toLowerCase();
}

async function cacheGet(text, pair) {
  const m = await ensureCache();
  const v = m.get(cacheKey(text, pair));
  if (!v) return '';
  if (!v.ts || Date.now() - v.ts > TR_CACHE_TTL) { m.delete(cacheKey(text, pair)); return ''; }
  return v.t || '';
}

function cachePut(text, pair, tr) {
  if (!trCache || !tr) return;
  const k = cacheKey(text, pair);
  trCache.delete(k);                       // 重新插入到末尾，维持 LRU 顺序
  trCache.set(k, { t: tr, ts: Date.now() });
  while (trCache.size > TR_CACHE_MAX) {
    const first = trCache.keys().next();
    if (first.done) break;
    trCache.delete(first.value);
  }
  if (trCacheTimer) return;
  trCacheTimer = setTimeout(() => {
    trCacheTimer = 0;
    try {
      chrome.storage.local.set({ [TR_CACHE_KEY]: Array.from(trCache.entries()) });
    } catch (e) { /* 配额满就放弃落盘，内存里仍可用 */ }
  }, 800);
}

/* ---------- 用户偏好（引擎 / MyMemory 邮箱） ---------- */
let prefsCache = { at: 0, val: null };
async function trPrefs() {
  if (prefsCache.val && Date.now() - prefsCache.at < 5000) return prefsCache.val;
  let p = {};
  try {
    const o = await chrome.storage.local.get('wk_prefs');
    p = o.wk_prefs || {};
  } catch (e) { /* 用默认值 */ }
  const val = {
    provider: ['auto', 'google', 'mymemory'].indexOf(p.trProvider) >= 0 ? p.trProvider : 'auto',
    email: typeof p.mmEmail === 'string' ? p.mmEmail.trim() : ''
  };
  prefsCache = { at: Date.now(), val };
  return val;
}

function splitPair(pair) {
  const s = String(pair || 'en|zh-CN');
  const i = s.indexOf('|');
  if (i < 0) return ['en', 'zh-CN'];
  return [s.slice(0, i) || 'en', s.slice(i + 1) || 'zh-CN'];
}

function quotaResetAt() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);   // 次日零点（MyMemory 按天重置）
  return d.getTime();
}

/* ---------- 引擎 ①：Google gtx（无 key，长句质量最好） ---------- */
async function googleTranslate(text, src, tgt, timeoutMs) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx' +
    '&sl=' + encodeURIComponent(src) + '&tl=' + encodeURIComponent(tgt) +
    '&dt=t&q=' + encodeURIComponent(text);

  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  try {
    const resp = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!resp.ok) return { text: '', code: 'http', status: resp.status };
    const data = await resp.json();
    /* 返回形如 [[["译文","原文",...],["第二句","",...]],null,"en",...]
       把所有分段拼起来（长句会被切成多段）。 */
    const segs = Array.isArray(data && data[0]) ? data[0] : [];
    const out = segs.map((s) => (Array.isArray(s) ? s[0] : '')).filter(Boolean).join('').trim();
    return out ? { text: out, code: '' } : { text: '', code: 'empty' };
  } catch (e) {
    return { text: '', code: timedOut ? 'timeout' : 'net', status: 0, detail: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 引擎 ②：MyMemory（国内直连；带邮箱额度 ×10） ---------- */
async function myMemoryTranslate(text, pair, email, timeoutMs) {
  let url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) +
    '&langpair=' + encodeURIComponent(pair);
  /* de=邮箱 把匿名 5000 字符/天 提到 50000 字符/天（官方规则）。
     没填就不带，避免用假邮箱被拒。 */
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    url += '&de=' + encodeURIComponent(email);
  }

  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  let data;
  try {
    const resp = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!resp.ok) return { text: '', code: 'http', status: resp.status };
    data = await resp.json();
  } catch (e) {
    return { text: '', code: timedOut ? 'timeout' : 'net', status: 0, detail: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }

  if (!data) return { text: '', code: 'empty' };
  if (data.quotaFinished === true) return { text: '', code: 'quota' };

  const matches = Array.isArray(data.matches) ? data.matches : [];
  const fb = (data.responseData && data.responseData.translatedText) || '';
  if (!matches.length) return { text: fb, code: fb ? '' : 'empty' };

  const target = text.toLowerCase();
  const scored = matches
    .map((m) => ({
      tr: (m.translation || '').trim(),
      q: Number(m.quality) || 0,
      m: Number(m.match) || 0,
      exact: String(m.segment || '').trim().toLowerCase() === target
    }))
    .filter((x) => x.tr)
    .sort((a, b) => (b.exact - a.exact) || (b.q - a.q) || (b.m - a.m));

  /* 优先人工翻译记忆（quality>0 且原文完全一致）；
     没有就退到质量最高的机翻；再没有才用 responseData 兜底。 */
  const exact = scored.find((x) => x.exact && x.q > 0);
  const best = exact || scored.find((x) => x.q > 0) || scored[0];
  if (best) return { text: best.tr, code: '' };
  return { text: fb, code: fb ? '' : 'empty' };
}

/* ---------- 长文本切片 ----------
   MyMemory 单次查询有 500 字符上限，超了会返回
   "QUERY LENGTH LIMIT EXCEEDED" 这段英文，旧代码会把它当译文显示出来。
   拖选一整段（不是一句）时必然踩到，所以按句切块、逐块翻译再拼回去。 */
function splitSentences(text) {
  const arr = text.match(/[^.!?。！？\n]+[.!?。！？]?/g);
  return (arr && arr.length) ? arr : [text];
}

function chunkText(text, max) {
  if (text.length <= max) return [text];
  const out = [];
  let buf = '';
  for (const s of splitSentences(text)) {
    if (s.length > max) {
      if (buf) { out.push(buf); buf = ''; }
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
      continue;
    }
    if (buf && buf.length + s.length > max) { out.push(buf); buf = ''; }
    buf += s;
  }
  if (buf) out.push(buf);
  return out.length ? out : [text];
}

/* ---------- 对外：translate ----------
   返回 { text, code, provider, tried }：
     code 说明"为什么没翻出来"，让前端给准确提示，而不是一律说额度用尽。 */
async function translate(q, langpair) {
  const text = String(q || '').trim();
  if (!text) return { text: '', code: 'empty' };
  const pair = langpair || 'en|zh-CN';

  const hit = await cacheGet(text, pair);
  if (hit) return { text: hit, code: '', provider: 'cache', cached: true };

  const key = cacheKey(text, pair);
  if (inflight.has(key)) return inflight.get(key);
  const job = doTranslate(text, pair).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function doTranslate(text, pair) {
  await ensureHealth();
  const p = await trPrefs();
  const [src, tgt] = splitPair(pair);

  let order;
  if (p.provider === 'google') order = ['google'];
  else if (p.provider === 'mymemory') order = ['mymemory'];
  else {
    order = ['google', 'mymemory'];
    /* auto：上次成功的引擎优先，避免每次先等一个已知不可用的引擎 */
    if (lastGood && order.indexOf(lastGood) > 0) {
      order = [lastGood].concat(order.filter((x) => x !== lastGood));
    }
  }

  const now = Date.now();
  const alive = order.filter((n) => !(providerDown[n] > now));
  const seq = alive.length ? alive : order;   // 全在冷却里也要试一次，不能直接放弃
  const tried = [];
  let lastCode = 'empty';

  for (const name of seq) {
    /* 每个引擎的单次长度上限不同：Google 宽松，MyMemory 500 字符封顶 */
    const maxLen = name === 'google' ? 1800 : 450;
    let chunks = chunkText(text, maxLen);
    if (chunks.length > 12) chunks = chunks.slice(0, 12);   // 超长段落别把额度打爆

    let out = '';
    let fail = null;
    for (const c of chunks) {
      const r = name === 'google'
        ? await googleTranslate(c, src, tgt, 5000)
        : await myMemoryTranslate(c, pair, p.email, 9000);
      if (!r.text) { fail = r; break; }
      out += r.text;
    }

    if (!fail && out) {
      tried.push({ name, code: 'ok' });
      cachePut(text, pair, out);
      lastGood = name;
      saveHealth();
      return { text: out, code: '', provider: name, tried };
    }

    tried.push({ name, code: (fail && fail.code) || 'empty', status: fail && fail.status });
    lastCode = (fail && fail.code) || 'empty';
    if (lastCode === 'quota') providerDown[name] = quotaResetAt();
    else if (lastCode === 'net' || lastCode === 'timeout' || lastCode === 'http') {
      providerDown[name] = now + DOWN_MS;
    }
    saveHealth();
  }

  /* 全部失败：额度类错误优先报"额度"，其余报网络类，前端据此提示 */
  const anyQuota = tried.some((x) => x.code === 'quota');
  return { text: '', code: anyQuota ? 'quota' : lastCode, tried };
}

/* ============================================================
 * 消息接口
 * ============================================================ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'dict:status') {
    ensureDict().then((info) => sendResponse(info));
    return true;      // 异步
  }

  if (msg.type === 'dict:lookup') {
    ensureDict().then(() => sendResponse(lookup(msg.word)));
    return true;
  }

  if (msg.type === 'tr:translate') {
    translate(msg.q, msg.langpair).then((r) => sendResponse(r || { text: '', code: 'empty' }));
    return true;
  }

  /* 诊断 / 设置页用：看看缓存多少条、哪个引擎在冷却 */
  if (msg.type === 'tr:status') {
    (async () => {
      const c = await ensureCache();
      const p = await trPrefs();
      const now = Date.now();
      sendResponse({
        ok: true,
        cache: c.size,
        provider: p.provider,
        hasEmail: !!p.email,
        lastGood: lastGood || '',
        down: Object.keys(providerDown).filter((n) => providerDown[n] > now)
      });
    })();
    return true;
  }

  if (msg.type === 'tr:clear-cache') {
    (async () => {
      trCache = new Map();
      /* 顺手把冷却也清掉：用户点这个按钮，多半是刚修好代理/换了网络，
         希望立刻重新试一次 Google，而不是继续等 5 分钟冷却。 */
      providerDown.google = 0;
      providerDown.mymemory = 0;
      lastGood = '';
      healthReady = Promise.resolve();
      try { await chrome.storage.local.remove([TR_CACHE_KEY, TR_HEALTH_KEY]); } catch (e) {}
      sendResponse({ ok: true });
    })();
    return true;
  }

  /* 侧边栏（主进程 → bridge.js）改完数据后广播一句，
     让可能开着的 panel 面板与网页里的内容脚本一起刷新。
     面板与内容脚本本来就监听 chrome.storage.onChanged，会各自收到；
     这里只是把"用户是从侧边栏改的"这层意图也传下去。 */
  if (msg.type === 'wk:data-changed') {
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

/* 侧边栏 / 图标弹窗打开时预热词典，避免用户第一次点词要等 */
chrome.runtime.onInstalled.addListener(() => { ensureDict(); });
chrome.runtime.onStartup.addListener(() => { ensureDict(); });