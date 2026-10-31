'use strict';

/**
 * bridge.js —— 主进程与扩展存储之间的唯一通道。
 *
 * 为什么要单独做一个页面：
 *   侧边栏界面是 file:// 页面（沙箱 + contextIsolation），
 *   它拿不到 chrome.* API；而扩展的 panel 页面有 chrome.storage，却没有 ipcRenderer。
 *   两边谁也够不着谁。所以挂一个不可见的扩展页面在这里：
 *   主进程用 executeJavaScript 调用它的函数，它再用 chrome.storage 落盘。
 *
 * 它与 panel.js 共用同一份 chrome.storage.local 键（wk_prefs / wk_bank / wk_repo / wk_note），
 * 因此侧边栏改设置 → 网页上的 content script 立刻生效（content.js 监听 storage.onChanged）。
 */

const KEY_PREFS = 'wk_prefs';
const KEY_BANK = 'wk_bank';
const KEY_REPO = 'wk_repo';
const KEY_NOTE = 'wk_note';       // 老版本：一个全局大文本框（只为迁移保留）
const KEY_NOTES = 'wk_notes';     // 新版本：笔记模块的独立笔记数组

const store = () => chrome.storage.local;

/* 读全部数据。dictionary 只回统计信息，不回 3.6MB 词库本身。 */
async function readAll() {
  const o = await store().get([KEY_PREFS, KEY_BANK, KEY_REPO, KEY_NOTE, KEY_NOTES]);
  const legacy = typeof o[KEY_NOTE] === 'string' ? o[KEY_NOTE] : '';
  let notes = Array.isArray(o[KEY_NOTES]) ? o[KEY_NOTES] : null;
  /* 首次升级到"多条笔记"：wk_notes 这个键还不存在时，把老的那一大段
     迁成一条独立笔记，然后立刻落盘。之后（哪怕是空数组）都不再迁移，
     否则用户把笔记全删了，一重启老内容又会冒出来。 */
  if (notes === null) {
    notes = legacy.trim()
      ? [{ id: 'note-legacy', cTitle: '', comment: legacy, cTs: Date.now() }]
      : [];
    try { await store().set({ [KEY_NOTES]: notes }); } catch (e) { /* 只读环境就算了 */ }
  }
  return {
    prefs: o[KEY_PREFS] || {},
    bank: Array.isArray(o[KEY_BANK]) ? o[KEY_BANK] : [],
    repo: Array.isArray(o[KEY_REPO]) ? o[KEY_REPO] : [],
    notes,
    note: legacy
  };
}

/* 整份替换某个键。侧边栏与面板可能同时写，
   所以先重新读一次再合并，避免用陈旧数据覆盖对方的改动。 */
async function doWriteOne(key, value) {
  try {
    const cur = await store().get([key]);
    if (key === KEY_PREFS) {
      // 偏好是"补丁"语义：侧边栏只改自己那几个字段，别的字段必须保住
      const merged = Object.assign({}, cur[key] || {}, value || {});
      await store().set({ [key]: merged });
      return { ok: true, value: merged };
    }
    // 生词本 / 仓库 / 笔记是整体数据，直接以调用方给的为准
    await store().set({ [key]: value });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ★ 写入必须串行。
   doWriteOne 是「读 → 合并 → 写」，两次调用并发时两边读到的是同一份旧值：
     改主题 → 读 {…} → 合并 {theme} 
     改语言 → 读 {…}（还没写入）→ 合并 {lang} → 写
     改主题的那次再写 → 把 lang 覆盖掉
   实测就踩到了：同时改「主题」和「界面语言」，重开只剩一个生效。
   这里用一条 Promise 链把写入排队，保证每次都是「基于上一次的结果」再合并。 */
let writeQueue = Promise.resolve();
function writeOne(key, value) {
  if (![KEY_PREFS, KEY_BANK, KEY_REPO, KEY_NOTE, KEY_NOTES].includes(key)) {
    return Promise.resolve({ ok: false, error: '不支持的键: ' + key });
  }
  const job = writeQueue.then(
    () => doWriteOne(key, value),
    () => doWriteOne(key, value)
  );
  writeQueue = job.then(() => {}, () => {});
  return job;
}

/* 词典状态：只回是否就绪与词条数，避免把整本词典搬过桥 */
async function dictStatus() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'dict:status' });
    return r || { ok: false };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* 查一个词（给侧边栏的"即时查词"用） */
async function lookup(word) {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'dict:lookup', word });
    return r || null;
  } catch (e) {
    return null;
  }
}

/* 翻译一段文本（给侧边栏的翻译小工具用）
   ★ 原样透传后台的 { text, code, status }：主进程需要 code 才能分辨
     "额度用尽 / 网络失败 / 服务报错"，旧代码只回 text，失败信息全被吃掉。 */
async function translate(q, langpair) {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'tr:translate', q, langpair });
    if (!r) return { text: '', code: 'empty' };
    if (typeof r === 'string') return { text: r, code: '', status: 0 };
    return { text: r.text || '', code: r.code || (r.text ? '' : 'empty'), status: r.status || 0 };
  } catch (e) {
    return { text: '', code: 'noreply' };
  }
}

/* 清掉翻译缓存与引擎冷却（侧边栏设置页用）
   ★ 冷却状态存在 background 的内存 + storage 里，这里只负责转发一条消息；
     用户点这个按钮，多半是刚换好网络/代理，希望立刻重试 Google。 */
async function clearTrCache() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'tr:clear-cache' });
    return r || { ok: false };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* 主进程通过 window.__wkBridge 调用上面这些函数 */
window.__wkBridge = { readAll, writeOne, dictStatus, lookup, translate, clearTrCache };

/* 侧边栏改完数据后通知扩展页面刷新列表（面板窗口可能开着） */
function pingPanel() {
  try {
    chrome.runtime.sendMessage({ type: 'wk:data-changed' }, () => void chrome.runtime.lastError);
  } catch (e) { /* 面板没开时忽略 */ }
}
window.__wkBridge.pingPanel = pingPanel;

/* ---------- 数据版本号 ----------
 * 侧边栏要能看出"数据被谁改了"，好把列表刷新一遍。
 * 页面上双击入库、面板里删词，扩展内部都会写 chrome.storage，
 * 主进程看不见这些写入，但本页面在扩展上下文里，能收到 storage.onChanged。
 * 于是把每次变化记成一个自增号，主进程轮询这个号即可，不必反复搬全量数据。 */
let version = 0;
try {
  chrome.storage.onChanged.addListener(() => { version++; });
} catch (e) { /* 没有该 API 时保持 0，功能降级为"不自动刷新" */ }

/** 只回一个整数，极轻量，供主进程轮询比对 */
async function versionNo() { return version; }
window.__wkBridge.versionNo = versionNo;

// 心跳标志：主进程用它在 ready-state 里确认桥接脚本已就绪
window.__wkReady = true;
const stEl = document.getElementById('st');
if (stEl) stEl.textContent = '就绪（可被主进程调用）';