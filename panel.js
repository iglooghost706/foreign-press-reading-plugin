'use strict';

/**
 * panel.js —— 侧边栏 / 图标弹窗。
 *
 * 与 content.js 共用 chrome.storage.local 里的同一份数据
 * （wk_prefs / wk_bank / wk_repo / wk_note），所以网页上加入的生词，
 * 这里立刻就能看到；反之亦然。
 */

const $ = (id) => document.getElementById(id);
const store = () => chrome.storage.local;

const KEY_PREFS = 'wk_prefs';
const KEY_BANK = 'wk_bank';
const KEY_REPO = 'wk_repo';
const KEY_NOTE = 'wk_note';       // 老版本：单个大文本框（只为迁移保留）
const KEY_NOTES = 'wk_notes';     // 新版本：笔记模块的独立笔记数组

let prefs = {
  on: true, starOn: true, lang: 'zh', theme: 'light',
  /* uiFont：面板与侧边栏的界面字号（px，基准 12）；fontFamily 只管网页正文 */
  uiFont: 12, fontFamily: 'default',
  bankSort: 'time', bankSubSort: 'time', repoSort: 'time', popAbove: true,
  trTarget: 'zh-CN',
  trProvider: 'auto',   // auto | google | mymemory
  mmEmail: '',          // 可选，MyMemory 提额用
  linkNav: 'smart',      // 点链接里的词是否跟随跳转：smart / block / allow
  /* 随机测试：抽题数量 + 考核范围（all / key 只考重点 / nokey 不考重点） */
  quizN: 10,
  quizScope: 'all',
  /* 功能旁的小字说明（灰色解释文字），嫌吵可以关掉 */
  hints: true
};
let bank = [], repo = [], notes = [];
let bankQ = '', repoQ = '', noteQ = '';
/* 随机测试：只记单词 key 与已显示释义的集合（不存对象引用，刷新后不会指向旧数据） */
const quiz = { keys: [], revealed: new Set() };

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const bg = (msg) => new Promise((resolve) => {
  try { chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)); }
  catch (e) { resolve(null); }
});

/* ---------- 数据读写 ---------- */
async function load() {
  try {
    const o = await store().get([KEY_PREFS, KEY_BANK, KEY_REPO, KEY_NOTE, KEY_NOTES]);
    prefs = Object.assign(prefs, o[KEY_PREFS] || {});
    bank = Array.isArray(o[KEY_BANK]) ? o[KEY_BANK] : [];
    repo = Array.isArray(o[KEY_REPO]) ? o[KEY_REPO] : [];
    /* 首次升级：wk_notes 还不存在时，把老的那段笔记迁成一条独立笔记。
       面板可能比侧边栏先打开，所以这里也要做一次（迁移用的 id 固定，
       两边都迁也只会是同一份数据）。 */
    if (Array.isArray(o[KEY_NOTES])) {
      notes = o[KEY_NOTES];
    } else {
      const legacy = typeof o[KEY_NOTE] === 'string' ? o[KEY_NOTE] : '';
      notes = legacy.trim()
        ? [{ id: 'note-legacy', cTitle: '', comment: legacy, cTs: Date.now() }]
        : [];
      await store().set({ [KEY_NOTES]: notes }).catch(() => {});
    }
  } catch (e) {}
}
const savePrefs = () => store().set({ [KEY_PREFS]: prefs }).catch(() => {});
const saveBank = () => store().set({ [KEY_BANK]: bank }).catch(() => {});
const saveRepo = () => store().set({ [KEY_REPO]: repo }).catch(() => {});
const saveNotes = () => store().set({ [KEY_NOTES]: notes }).catch(() => {});

/* ---------- 主题（面板自身也跟随） ----------
   变量定义在 :root（html）上，所以两处都要打标记：
   html 负责整片背景（含侧边栏之外的留白），body 负责内容区。 */
function applyTheme() {
  document.documentElement.setAttribute('data-wk-theme', prefs.theme);
  document.body.setAttribute('data-wk-theme', prefs.theme);
}

/* 界面字号：panel.css 里每个字号都写成 calc(Npx * var(--ui-scale))，
   这里只改一个变量；面板宽度（360px）不变，字变大只是换行更多。
   基准 12px = 原来的观感。 */
function applyUiScale() {
  const v = Number(prefs.uiFont) || 12;
  const scale = Math.min(1.7, Math.max(0.85, v / 12));
  document.documentElement.style.setProperty('--ui-scale', String(scale));
}

/* 小字说明开 / 关：只加一个 body 类，具体藏哪些交给 CSS */
function applyHints() {
  document.body.classList.toggle('no-hints', prefs.hints === false);
}

/* ---------- 生词本 ---------- */

/** 按当前排序模式给生词本排序/分区。
 *
 *  · 'time' / 'alpha'  → 单一列表（老行为，完全不变）
 *  · 'key'             → 划成两个区：
 *        重点区   = 标了 key 的词，全部红字，**统一放到下面**
 *        非重点区 = 其余词
 *      两个区内部各自支持「按时间」/「按字母」（prefs.bankSubSort）。
 *
 *  ★ 为什么要单独一个函数：面板（panel.js）与侧边栏（reader-sidebar.js）
 *    是两套独立实现，这里把规则收成一份，两边的期望值由
 *    tools/test-bank-keysort.js 用同一组数据核对，避免两边逻辑漂移。 */
function sortWords (arr, sub) {
  const byTime = (a, b) => (b.ts || 0) - (a.ts || 0)
  const byAlpha = (a, b) => String(a.w || '').toLowerCase()
    .localeCompare(String(b.w || '').toLowerCase())
  const out = arr.slice()
  out.sort(sub === 'alpha' ? byAlpha : byTime)
  return out
}

/** 生词本按「按重点」分区；非该模式时返回单区（title 为空 → 不渲染区头） */
function partitionBank (arr) {
  if (prefs.bankSort !== 'key') {
    return [{ key: 'all', title: '',
      items: sortWords(arr, prefs.bankSort === 'alpha' ? 'alpha' : 'time') }]
  }
  const keys = [], rest = []
  for (const b of arr) (b && b.key ? keys : rest).push(b)
  const sub = prefs.bankSubSort === 'alpha' ? 'alpha' : 'time'
  return [
    { key: 'normal', title: '非重点', items: sortWords(rest, sub) },
    { key: 'key', title: '重点', items: sortWords(keys, sub) }
  ]
}

function highlight(s, q) {
  const text = esc(s);
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return text;
  return text.slice(0, i) + '<mark>' + text.slice(i, i + q.length) + '</mark>' + text.slice(i + q.length);
}

function renderBank() {
  const box = $('bankList');
  const q = bankQ.trim().toLowerCase();
  let arr = bank.slice();
  if (q) arr = arr.filter((b) => (b.w || '').toLowerCase().includes(q) || (b.def || '').toLowerCase().includes(q));
  const groups = partitionBank(arr);
  $('bankCount').textContent = arr.length + ' 词' + (bankQ ? '（共 ' + bank.length + '）' : '');

  /* 二级排序下拉只在「按重点」模式下有意义，其余模式隐藏，
     免得用户以为它能改单一列表的顺序。 */
  const subWrap = $('bankSubSortWrap');
  if (subWrap) subWrap.hidden = prefs.bankSort !== 'key';

  if (!arr.length) {
    box.innerHTML = '<div class="empty">还没有生词。<div class="hint">在网页上<b>双击</b>单词即可加入。</div></div>';
    return;
  }
  /* 复用的是"整块重画"，所以要重置去重集：同一单词在库里出现两次时
     只有第一次算正常、后面标 dup（把重复数据显出来提醒用户）。 */
  const seen = new Set();
  box.innerHTML = '';
  for (const g of groups) {
    if (g.title) {
      const h = document.createElement('div');
      h.className = 'group-hd' + (g.key === 'key' ? ' key' : '');
      h.innerHTML = '<span class="gt">' + esc(g.title) + '区</span>' +
        '<span class="gn">' + g.items.length + ' 词</span>';
      box.appendChild(h);
    }
    if (!g.items.length) {
      const e = document.createElement('div');
      e.className = 'group-empty';
      e.textContent = g.key === 'key' ? '还没有重点词。点单词右侧的 ☆ 即可标为重点。' : '（本区暂无单词）';
      box.appendChild(e);
      continue;
    }
    for (const b of g.items) {
      const w = String(b.w || '').toLowerCase();
      const dup = seen.has(w);
      seen.add(w);
      const isKey = !!b.key;
      const d = document.createElement('div');
      /* ★ 重点区里的词**一律红字**：以前红字只取决于 b.key，改成按区分组后
         还要保证"进了重点区就一定红"（两者本来是同一件事，这里显式加类，
         万一数据里 key 与分组不一致也不会出现"在重点区却不是红字"）。 */
      d.className = 'item' + (dup ? ' dup' : '') + (isKey ? ' is-key' : '');
      d.innerHTML =
        '<div class="w">' + highlight(b.w || '', bankQ.trim().toLowerCase()) + '</div>' +
        (b.def ? '<div class="d">' + highlight(b.def, bankQ.trim().toLowerCase()) + '</div>' : '') +
        '<div class="m">' +
        (b.lemma ? '<span>→ ' + esc(b.lemma) + '</span>' : '') +
        '<span>' + new Date(b.ts || Date.now()).toLocaleDateString() + '</span>' +
        '<span class="starbtn' + (isKey ? ' on' : '') + '" data-a="key" title="' +
        (isKey ? '取消重点标记' : '标记为重点词语') + '">' + (isKey ? '★' : '☆') + '</span>' +
        '<span class="x" data-a="del">删除</span>' +
        '</div>';
      d.querySelector('[data-a="del"]').onclick = () => {
        bank = bank.filter((x) => x !== b);
        saveBank(); renderBank();
      };
      /* ⚠ 面板版原来**没有**重点切换按钮（只有侧边栏有），
         而"按重点"排序必须能改重点状态，否则用户没法把词挪进重点区。
         这里补上，与侧边栏行为一致。 */
      d.querySelector('[data-a="key"]').onclick = () => {
        b.key = !b.key;
        saveBank(); renderBank();
      };
      box.appendChild(d);
    }
  }
}

/* ---------- 仓库 ---------- */

/* ---------- 每条收藏的专属笔记 ----------
   笔记不再是独立标签页里的一个大文本框，而是挂在每条收藏上（r.comment）：
   段落 / 句子 / 全文 / 链接各自一份，跟着条目排序、搜索、导出、删除。
   侧边栏（reader-sidebar.js）里是同一套交互，两处写的是同一份存储。 */
let noteEditor = null;   // 当前打开的笔记输入框
let noteTimer = null;    // 自动保存防抖
/* 哪些笔记处于展开状态：默认收起只留一行预览，用 id 记，重画也不忘 */
const noteOpen = new Set();
const noteKey = (r) => r.id
  ? 'i:' + r.id
  : 'k:' + (r.ts || 0) + ':' + String(r.text || r.url || '').slice(0, 24);

/* 一条笔记三个字段：cTitle 自写标题 / comment 正文（老字段）/ cTs 创建时间。
   有标题没正文也算一条笔记。 */
const noteBody = (r) => String(r.comment || '');
const noteTitle = (r) => String(r.cTitle || '').trim();
const noteHas = (r) => Boolean(noteBody(r).trim() || noteTitle(r));

/** 创建时间：今天只显示时:分，更早显示月/日（完整时间放 title 提示） */
function noteTime(r) {
  const t = Number(r.cTs) || 0;
  if (!t) return '';
  const d = new Date(t);
  const n = new Date();
  const p = (v) => (v < 10 ? '0' + v : String(v));
  const today = d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return today ? p(d.getHours()) + ':' + p(d.getMinutes())
    : (d.getMonth() + 1) + '/' + d.getDate();
}

/** 还没有笔记时，在元信息行给一个入口（不占额外高度） */
function noteAction(r) {
  if (noteHas(r)) return '';
  return '<span class="x" data-a="note" title="给这条收藏新建一条笔记">新建笔记</span>';
}

/* 笔记块：标题行 = 箭头 · 标题（没写就用 fallback）· 创建时间 · 删除。
   收起只显示一行正文预览，展开显示全文。
   折叠只由箭头负责；卡片其余任何地方一点就进编辑 ——
   早先整行标题都是折叠开关，用户点标题想改字，结果只是收起又展开，
   看起来就像"新建的笔记不能编辑"。 */
function noteBlock(r, fallback, always) {
  if (!always && !noteHas(r)) return '';
  const open = noteOpen.has(noteKey(r));
  const title = noteTitle(r);
  const body = noteBody(r);
  const t = Number(r.cTs) || 0;
  const time = noteTime(r);
  return '<div class="note' + (open ? ' open' : '') + '"' +
    (r.id ? ' data-nid="' + esc(r.id) + '"' : '') + '>' +
    '<div class="note-hd">' +
    '<span class="note-ar" data-a="fold" title="' + (open ? '收起笔记' : '展开笔记') + '">' +
    (open ? '▾' : '▸') + '</span>' +
    '<span class="note-lb' + (title ? ' titled' : '') + '"' +
    (title ? ' title="' + esc(title) + '"' : '') + '>' +
    esc(title || fallback || '我的笔记') + '</span>' +
    '<span class="note-hint"></span>' +
    (time ? '<span class="note-tm" title="创建于 ' +
      esc(t ? new Date(t).toLocaleString() : '') + '">' + esc(time) + '</span>' : '') +
    '<span class="note-x" data-a="delnote">删除</span></div>' +
    (body.trim() ? '<div class="note-pv">' + esc(body.replace(/\s+/g, ' ')) + '</div>' : '') +
    '<div class="note-txt" title="点击编辑笔记">' +
    (body.trim() ? esc(body) : '<span class="note-ph">空笔记，点击添加正文</span>') +
    '</div>' +
    '</div>';
}

/* 两处笔记共用一套编辑器，差别只有「存到哪、重画谁」 */
const repoNoteHooks = {
  save: () => saveRepo(),
  label: () => '我的笔记',
  paint: (box, r) => {
    const item = box.closest('.item');
    if (item) paintNote(item, r);
  }
};
const freeNoteHooks = {
  save: () => saveNotes(),
  label: () => '无标题笔记',
  paint: (box, n) => paintNoteCard(box, n),
  keepEmpty: true
};

/** 展开 / 收起某条笔记（只重画这一条） */
function toggleNote(itemEl, r) {
  const k = noteKey(r);
  if (noteOpen.has(k)) noteOpen.delete(k); else noteOpen.add(k);
  paintNote(itemEl, r);
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(Math.max(ta.scrollHeight, 54), 300) + 'px';
}

/* 只重画一条收藏的笔记区（笔记块 + 元信息行入口），不整列表重画：
   收笔（blur）后整表重画会把用户刚点下去的那个节点一起换掉，
   点击落空 —— 表现就是"点另一条的写笔记要点两次"。 */
function paintNote(itemEl, r) {
  const old = itemEl.querySelector('.note');
  const html = noteBlock(r);
  if (old) {
    if (html) old.outerHTML = html;
    else old.remove();
  } else if (html) {
    itemEl.insertAdjacentHTML('beforeend', html);
  }
  let addBtn = itemEl.querySelector('[data-a="note"]');
  const has = noteHas(r);
  if (has && addBtn) { addBtn.remove(); addBtn = null; }
  if (!has && !addBtn) {
    const delBtn = itemEl.querySelector('[data-a="del"]');
    if (delBtn) delBtn.insertAdjacentHTML('beforebegin', noteAction(r));
  }
  if (addBtn) addBtn.hidden = false;
  wireNote(itemEl, r);
}

/** 仓库条目上的笔记：没有笔记区就现建一个，再交给通用编辑器 */
function openNote(itemEl, r) {
  let box = itemEl.querySelector('.note');
  if (!box) {
    box = document.createElement('div');
    box.className = 'note';
    box.innerHTML = '<div class="note-hd"><span class="note-ar">▾</span>' +
      '<span class="note-lb">' + esc(noteTitle(r) || '我的笔记') + '</span>' +
      '<span class="note-hint"></span></div>';
    itemEl.appendChild(box);
  }
  openNoteEditor(box, r, repoNoteHooks, itemEl);
}

/** 编辑器本体：box = 笔记块，r = 数据记录，hooks 决定存到哪、重画谁 */
function openNoteEditor(box, r, hooks, itemEl) {
  if (noteEditor && noteEditor.__item === r && noteEditor.isConnected) {
    noteEditor.focus();
    return;
  }
  if (noteEditor) flushNote();
  /* 手动创建：点「新建笔记」就算建好了，创建时间在这一刻记下 */
  if (!noteHas(r) && !r.cTs) r.cTs = Date.now();

  /* 标题：可留空；留空时标题行显示 fallback 文案 */
  const ti = document.createElement('input');
  ti.className = 'note-ti';
  ti.type = 'text';
  ti.spellcheck = false;
  ti.value = noteTitle(r);
  ti.placeholder = '笔记标题（可选）';

  const ta = document.createElement('textarea');
  ta.className = 'note-ta';
  ta.spellcheck = false;
  ta.value = noteBody(r);
  ta.placeholder = '记下想法、疑问、可用的表达…（自动保存）';
  ta.__item = r;
  ta.__box = box;
  ta.__titleEl = ti;
  ta.__hooks = hooks;

  Array.prototype.forEach.call(box.querySelectorAll('.note-x'), function (b) { b.hidden = true; });
  const ar = box.querySelector('.note-ar');
  if (ar) ar.textContent = '▾';
  noteOpen.add(noteKey(r));
  const addBtn = itemEl && itemEl.querySelector('[data-a="note"]');
  if (addBtn) addBtn.hidden = true;
  box.classList.add('editing', 'open');
  box.appendChild(ti);
  box.appendChild(ta);
  noteEditor = ta;
  autoGrow(ta);
  /* 全新的空笔记先让人写标题；已有标题或正文的，直接落到正文末尾 */
  const fresh = !noteTitle(r) && !noteBody(r).trim();
  const first = fresh ? ti : ta;
  first.focus();
  try { first.setSelectionRange(first.value.length, first.value.length); } catch (e) {}

  const flash = () => {
    const hint = box.querySelector('.note-hint');
    if (!hint) return;
    hint.textContent = '已保存';
    setTimeout(() => { if (hint.isConnected) hint.textContent = ''; }, 1200);
  };
  const bump = () => {
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      noteTimer = null;
      if (!ta.isConnected) return;
      if (hooks && hooks.save) hooks.save();
      flash();
    }, 600);
  };

  ti.addEventListener('input', () => {
    r.cTitle = ti.value;
    const lb = box.querySelector('.note-lb');
    if (lb) lb.textContent = ti.value.trim() || (hooks && hooks.label ? hooks.label() : '我的笔记');
    bump();
  });
  ti.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeNote(); }
    else if (e.key === 'Enter') { e.preventDefault(); ta.focus(); }
  });

  ta.addEventListener('input', () => {
    r.comment = ta.value;
    autoGrow(ta);
    bump();
  });

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeNote(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closeNote(); }
  });

  /* 焦点在「标题 ↔ 正文」之间移动不算收笔，真正离开笔记区才收 */
  box.addEventListener('focusout', (e) => {
    if (e.relatedTarget && box.contains(e.relatedTarget)) return;
    setTimeout(() => {
      if (noteEditor !== ta) return;
      if (box.contains(document.activeElement)) return;
      closeNote();
    }, 0);
  });
}

/** 把编辑器内容写回数据并收起（paint=false 时只落盘，交给整表重画） */
function flushNote(paint) {
  const ta = noteEditor;
  if (!ta) return null;
  if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
  noteEditor = null;
  const r = ta.__item;
  const hooks = ta.__hooks || {};
  if (r) {
    const body = ta.value.trim();
    const ti = ta.__titleEl;
    const title = ti ? ti.value.trim() : noteTitle(r);
    r.comment = body;
    if (title) r.cTitle = title; else delete r.cTitle;
    /* 标题和正文都空 → 这条笔记等于没建，连创建时间一起撤掉，不留空壳。
       独立笔记（keepEmpty）例外：点了「新建笔记」就是一条正式笔记，
       还没写只是没写，卡片要留着等它被填上。
       老数据的笔记没有 cTs，用收藏时间兜底。 */
    if (body || title) { if (!r.cTs) r.cTs = Number(r.ts) || Date.now(); }
    else if (!(hooks && hooks.keepEmpty)) { delete r.cTitle; delete r.cTs; }
    if (hooks.save) hooks.save();
  }
  if (paint !== false && ta.__box && ta.__box.isConnected && hooks.paint) {
    hooks.paint(ta.__box, r);
  }
  return r;
}

function closeNote() {
  if (!noteEditor) return;
  flushNote();
}

/* ---------- 笔记模块：不绑定收藏的独立笔记 ----------
   老版本是一个大文本框（wk_note），现在改成 wk_notes 数组：
   可以手动新建多条，每条有自己的标题和创建时间。
   字段与仓库里的笔记一致（cTitle / comment / cTs），渲染和编辑器直接复用。 */
function paintNoteCard(card, n) {
  const parent = card.parentNode;
  card.outerHTML = noteBlock(n, '无标题笔记', true);
  const el = parent ? Array.prototype.find.call(parent.children, (c) => c.dataset.nid === n.id) : null;
  if (el) wireNoteCard(el, n);
}

function toggleNoteCard(card, n) {
  const k = noteKey(n);
  if (noteOpen.has(k)) noteOpen.delete(k); else noteOpen.add(k);
  paintNoteCard(card, n);
}

function wireNoteCard(card, n) {
  /* 箭头 = 折叠开关；卡片其余地方（标题、时间、预览、正文、空白）= 进编辑 */
  const fold = card.querySelector('[data-a="fold"]');
  if (fold) fold.onclick = (e) => { if (e) e.stopPropagation(); toggleNoteCard(card, n); };
  card.onclick = (e) => {
    if (card.classList.contains('editing')) return;
    if (e.target.closest('[data-a="fold"]')) return;
    if (e.target.closest('[data-a="delnote"]')) return;
    openNoteEditor(card, n, freeNoteHooks);
  };
  const del = card.querySelector('[data-a="delnote"]');
  if (del) {
    del.onclick = (e) => {
      if (e) e.stopPropagation();      // 别让卡片的点击把编辑器叫出来
      if (!confirm('确定删除这条笔记？')) return;
      notes = notes.filter((x) => x !== n);
      saveNotes();
      renderNotes();
    };
  }
}

function renderNotes() {
  const box = $('noteList');
  if (!box) return;
  if (noteEditor) flushNote(false);
  const q = noteQ.trim().toLowerCase();
  let arr = notes.slice();
  if (q) {
    arr = arr.filter((n) => String(n.cTitle || '').toLowerCase().includes(q) ||
      String(n.comment || '').toLowerCase().includes(q));
  }
  arr.sort((a, b) => (Number(b.cTs) || 0) - (Number(a.cTs) || 0));
  const cnt = $('noteCount');
  if (cnt) cnt.textContent = arr.length + ' 条' + (noteQ ? '（共 ' + notes.length + '）' : '');

  box.innerHTML = '';
  if (!arr.length) {
    box.innerHTML = '<div class="empty">' +
      esc(noteQ ? '没有匹配的笔记。' : '还没有笔记。点上方「＋ 新建笔记」开始写。') +
      '</div>';
    return;
  }
  for (const n of arr) {
    const wrap = document.createElement('div');
    wrap.innerHTML = noteBlock(n, '无标题笔记', true);
    const card = wrap.firstElementChild;
    if (!card) continue;
    box.appendChild(card);
    wireNoteCard(card, n);
  }
}

/** 手动新建：先落一条空记录（创建时间就是此刻），再直接进编辑态 */
function newNote() {
  if (noteEditor) flushNote();
  /* 已经躺着一张全新的空笔记就直接用它，连点几下不会堆出一串空卡片 */
  const blank = notes.find((x) => !noteHas(x));
  if (blank) {
    noteOpen.add(noteKey(blank));
    renderNotes();
    const list0 = $('noteList');
    const c0 = list0 ? Array.prototype.find.call(list0.children, (c) => c.dataset.nid === blank.id) : null;
    if (c0) openNoteEditor(c0, blank, freeNoteHooks);
    return;
  }
  const n = {
    id: 'note-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    cTitle: '',
    comment: '',
    cTs: Date.now()
  };
  notes.unshift(n);
  saveNotes();
  renderNotes();
  const list = $('noteList');
  const card = list ? Array.prototype.find.call(list.children, (c) => c.dataset.nid === n.id) : null;
  if (card) openNoteEditor(card, n, freeNoteHooks);
}

/* ---------- 随机测试 ----------
   从生词本随机抽 N 个词排成一列，默认盖住释义：
     · 点某一行 → 只显示这一行的释义（再点收起）
     · 顶部按钮 → 一键全部显示 / 全部收起
     · 每行右侧 → ☆/★ 切换重点词、移出生词本
   ★ 题目只存单词 key，不存对象引用：外部改动会把 bank 整个换掉，
     存引用的话星标 / 移除会改到已经不在列表里的旧对象。 */
const quizKey = (b) => String((b && b.w) || '').toLowerCase();

/** 按当前范围筛出可抽的池子 */
function quizPool() {
  const scope = prefs.quizScope || 'all';
  if (scope === 'key') return bank.filter((b) => b && b.key);
  if (scope === 'nokey') return bank.filter((b) => b && !b.key);
  return bank.slice();
}

/** 把 key 还原成当前生词本里的对象（找不到说明已被删，跳过） */
function quizItems() {
  const byKey = new Map();
  for (const b of bank) byKey.set(quizKey(b), b);
  const out = [];
  for (const k of quiz.keys) {
    const b = byKey.get(k);
    if (b) out.push(b);
  }
  return out;
}

/** Fisher-Yates：真随机，别用 sort(random) */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function quizDefHtml(b, on) {
  if (!on) return '<span class="qz-hide">点击显示释义</span>';
  const def = String(b.def || '').trim();
  return def ? esc(def) : '<span class="qz-none">（这条没有释义）</span>';
}

function updateQuizMeta() {
  const items = quizItems();
  const on = items.filter((b) => quiz.revealed.has(quizKey(b))).length;
  const cnt = $('quizCount');
  if (cnt) cnt.textContent = items.length ? '显示 ' + on + '/' + items.length : '还没有抽题';
  const btn = $('btnQuizReveal');
  if (btn) {
    btn.textContent = (items.length > 0 && on === items.length) ? '收起全部释义' : '显示全部释义';
    btn.disabled = items.length === 0;
  }
}

/** 只更新一行，不整表重画 */
function paintQuizRow(row, b) {
  const on = quiz.revealed.has(quizKey(b));
  row.classList.toggle('on', on);
  row.classList.toggle('key', !!b.key);
  const def = row.querySelector('.qz-def');
  if (def) def.innerHTML = quizDefHtml(b, on);
  const star = row.querySelector('.starbtn');
  if (star) {
    star.classList.toggle('on', !!b.key);
    star.textContent = b.key ? '★' : '☆';
    star.title = b.key ? '移出重点词' : '移入重点词';
  }
  updateQuizMeta();
}

function renderQuiz() {
  const box = $('quizList');
  if (!box) return;
  const items = quizItems();
  if (quiz.keys.length && !items.length) quiz.keys = [];

  box.innerHTML = '';
  if (!items.length) {
    box.innerHTML = '<div class="empty">点上方「随机抽题」，从生词本里抽词。' +
      '<div class="hint">点单词显示释义，也可以一键全部显示；每个词都能标重点或移出生词本。</div></div>';
    updateQuizMeta();
    return;
  }
  items.forEach((b, i) => {
    const on = quiz.revealed.has(quizKey(b));
    const el = document.createElement('div');
    el.className = 'qrow' + (on ? ' on' : '') + (b.key ? ' key' : '');
    el.innerHTML =
      '<div class="qz-no">' + (i + 1) + '</div>' +
      '<div class="qz-body">' +
      '<div class="qz-w">' + esc(b.w || '') +
      (b.lemma ? '<span class="qz-lemma">→ ' + esc(b.lemma) + '</span>' : '') + '</div>' +
      '<div class="qz-def">' + quizDefHtml(b, on) + '</div>' +
      '</div>' +
      '<div class="qz-act">' +
      '<span class="starbtn' + (b.key ? ' on' : '') + '" title="' +
      (b.key ? '移出重点词' : '移入重点词') + '">' + (b.key ? '★' : '☆') + '</span>' +
      '<span class="x" title="移出生词本">移出</span>' +
      '</div>';

    el.querySelector('.qz-body').onclick = () => {
      const k = quizKey(b);
      if (quiz.revealed.has(k)) quiz.revealed.delete(k);
      else quiz.revealed.add(k);
      paintQuizRow(el, b);
    };
    el.querySelector('.starbtn').onclick = (e) => {
      if (e) e.stopPropagation();
      toggleQuizStar(b);
    };
    el.querySelector('.x').onclick = (e) => {
      if (e) e.stopPropagation();
      removeQuizWord(b);
    };
    box.appendChild(el);
  });
  updateQuizMeta();
}

/** 随机抽题 */
function startQuiz() {
  const pool = quizPool();
  if (!pool.length) {
    toast(prefs.quizScope === 'key' ? '范围内没有重点词，先给单词点个 ☆' : '生词本是空的');
    return;
  }
  let n = Math.floor(Number(prefs.quizN) || 10);
  if (!(n > 0)) n = 10;
  const picked = shuffle(pool).slice(0, Math.min(n, pool.length));
  quiz.keys = picked.map(quizKey);
  quiz.revealed.clear();
  renderQuiz();
  if (picked.length < n) toast('范围内只有 ' + picked.length + ' 个词，已全部抽出');
}

/** 一键显示 / 收起全部释义 */
function toggleRevealAll() {
  const items = quizItems();
  if (!items.length) return;
  const on = items.filter((b) => quiz.revealed.has(quizKey(b))).length;
  if (on === items.length) quiz.revealed.clear();
  else for (const b of items) quiz.revealed.add(quizKey(b));
  renderQuiz();
}

function toggleQuizStar(b) {
  b.key = !b.key;
  saveBank();
  renderQuiz();
  renderBank();
  toast(b.key ? '已移入重点词' : '已移出重点词');
}

function removeQuizWord(b) {
  const k = quizKey(b);
  bank = bank.filter((x) => x !== b);
  quiz.keys = quiz.keys.filter((x) => x !== k);
  quiz.revealed.delete(k);
  saveBank();
  renderQuiz();
  renderBank();
  toast('已移出生词本');
}

/** 接上笔记区的各种入口 */
function wireNote(itemEl, r) {
  const add = itemEl.querySelector('[data-a="note"]');
  if (add) add.onclick = () => openNote(itemEl, r);
  const box = itemEl.querySelector('.note');
  if (box) {
    /* 箭头只管折叠；笔记区里别的地方一点就进编辑 */
    const fold = box.querySelector('[data-a="fold"]');
    if (fold) fold.onclick = (e) => { if (e) e.stopPropagation(); toggleNote(itemEl, r); };
    box.onclick = (e) => {
      if (box.classList.contains('editing')) return;
      if (e.target.closest('[data-a="fold"]')) return;
      if (e.target.closest('[data-a="delnote"]')) return;
      openNote(itemEl, r);
    };
  }
  const del = itemEl.querySelector('[data-a="delnote"]');
  if (del) {
    del.onclick = (e) => {
      if (e) e.stopPropagation();     // 别让笔记区的点击把编辑器叫出来
      if (!confirm('确定删除这条笔记？')) return;
      r.comment = ''; delete r.cTitle; delete r.cTs;
      saveRepo(); paintNote(itemEl, r);
    };
  }
}

function renderRepo() {
  const box = $('repoList');
  /* 重画会销毁输入框：先把正在写的内容落盘（paint=false，反正下面整表重建） */
  if (noteEditor) flushNote(false);
  const q = repoQ.trim().toLowerCase();
  let arr = repo.slice();
  if (q) arr = arr.filter((r) => (r.text || '').toLowerCase().includes(q) ||
    (r.title || '').toLowerCase().includes(q) ||
    (r.cTitle || '').toLowerCase().includes(q) ||
    (r.comment || '').toLowerCase().includes(q));
  if (prefs.repoSort === 'source') arr.sort((a, b) => String(a.source || '').localeCompare(String(b.source || '')));
  else arr.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  $('repoCount').textContent = arr.length + ' 条';
  box.innerHTML = '';
  if (!arr.length) {
    box.innerHTML = '<div class="empty">仓库是空的。<div class="hint">在网页上悬停段落点 <b>☆</b> 收藏段落或句子，或点上方「收藏当前网址」。</div></div>';
    return;
  }
  const kindName = { para: '段落', sentence: '句子', full: '全文', link: '链接' };
  /* ★ 全文动辄几千字（实测 BBC 一篇 23 段 / 3442 字）。
     直接整段铺开，一条就能把侧边栏撑爆、别的条目全被顶走；
     靠 CSS 截断又会让用户以为"收藏失败了，只存了个开头"。
     所以超过阈值就默认折叠，给一个「展开全文 / 收起」的按钮。
     段落、句子这类短内容保持原来的整段显示，不多此一举。 */
  const LONG = 600;
  for (const r of arr) {
    const isLink = r.kind === 'link';
    const full = !isLink && (r.text || '').length > LONG;
    const d = document.createElement('div');
    d.className = 'item' + (isLink ? ' link' : (full ? ' long' : ''));
    const when = r.ts ? new Date(r.ts).toLocaleString() : '';
    if (isLink) {
      // 链接收藏：标题 + 可点击网址 + 收藏时间 + 内联重命名 + 删除
      const titleHtml =
        '<a class="lk" href="' + esc(r.url || '') + '" target="_blank" rel="noopener">' +
        esc(r.title || r.url || '(无标题)') + '</a>';
      const urlHtml = '<div class="lk-url">' + esc(r.url || '') + '</div>';
      const metaHtml =
        '<span class="kind">' + esc(kindName.link || '链接') + '</span>' +
        '<span>' + esc(r.source || '') + '</span>' +
        (when ? '<span class="tm">' + esc(when) + '</span>' : '') +
        noteAction(r) +
        '<span class="x" data-a="rename">重命名</span>' +
        '<span class="x" data-a="del">删除</span></div>';
      d.innerHTML =
        '<div class="m" style="margin:0 0 4px;">' + metaHtml +
        titleHtml + urlHtml + noteBlock(r);
      d.querySelector('[data-a="del"]').onclick = () => {
        repo = repo.filter((x) => x !== r);
        saveRepo(); renderRepo();
      };
      d.querySelector('[data-a="rename"]').onclick = () => startRename(d, r);
      wireNote(d, r);
      box.appendChild(d);
      continue;
    }
    d.innerHTML =
      '<div class="m" style="margin:0 0 4px;">' +
      '<span class="kind">' + esc(kindName[r.kind] || '片段') + '</span>' +
      '<span>' + esc(r.source || '') + '</span>' +
      (when ? '<span class="tm">' + esc(when) + '</span>' : '') +
      noteAction(r) +
      '<span class="x" data-a="del">删除</span></div>' +
      '<div class="txt">' + highlight(r.text || '', q) + '</div>' +
      (full ? '<button class="more" data-a="more">展开全文</button>' : '') +
      (r.tr ? '<div class="d">' + esc(r.tr) + '</div>' : '') +
      noteBlock(r);
    if (full) {
      const btn = d.querySelector('[data-a="more"]');
      btn.onclick = () => {
        const open = d.classList.toggle('open');
        btn.textContent = open ? '收起' : '展开全文';
      };
    }
    d.querySelector('[data-a="del"]').onclick = () => {
      repo = repo.filter((x) => x !== r);
      saveRepo(); renderRepo();
    };
    wireNote(d, r);
    box.appendChild(d);
  }
}

// 内联重命名：把标题就地替换成输入框，回车/失焦保存，Esc 取消
function startRename(itemEl, r) {
  if (itemEl.querySelector('input.lk-rename')) return;
  const a = itemEl.querySelector('a.lk');
  const cur = (r.title || '').trim();
  const inp = document.createElement('input');
  inp.className = 'lk-rename';
  inp.type = 'text';
  inp.value = cur;
  inp.style.cssText = 'width:100%;box-sizing:border-box;font-size:13px;padding:3px 6px;margin-top:2px';
  if (a && a.parentNode) a.parentNode.replaceChild(inp, a);
  inp.focus();
  inp.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    if (save) {
      const v = inp.value.trim();
      if (v && v !== cur) { r.title = v; saveRepo(); }
    }
    renderRepo();
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
}

function addLinkFromCurrent() {
  chrome.storage.local.get('wk_current', (o) => {
    const cur = (o && o.wk_current) || {};
    const url = cur.url || location.href;
    if (!url) { toast('当前没有可收藏的网址'); return; }
    if (repo.some((x) => x.kind === 'link' && x.url === url)) { toast('该文章已收藏过'); return; }
    const item = {
      id: 'link-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      kind: 'link', url: url,
      title: (cur.title || '').trim() || url,
      source: (function (u) { try { return new URL(u).hostname; } catch (e) { return ''; } })(url),
      text: url, blocks: null, comment: '', ts: Date.now()
    };
    repo.unshift(item);
    saveRepo(); renderRepo();
    toast('已收藏当前网址');
  });
}

/* ---------- 导出 ---------- */
function download(name, text, mime) {
  const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/** Anki 四列：单词 / 释义 / 原形 / 例句 */
function exportAnki() {
  const lines = ['Word\tDefinition\tLemma\tExample'];
  for (const b of bank) {
    lines.push([b.w || '', b.def || '', b.lemma || '', '']
      .map((x) => String(x).replace(/[\t\r\n]/g, ' ')).join('\t'));
  }
  download('waikan-anki.tsv', '﻿' + lines.join('\r\n'), 'text/tab-separated-values');
  toast('已导出 ' + (bank.length) + ' 词（可直接导入 Anki）');
}

function exportTxt() {
  const lines = bank.map((b) => b.w + '\t' + (b.lemma ? b.lemma + '\t' : '') + (b.def || ''));
  download('waikan-bank.txt', '﻿' + lines.join('\r\n'));
  toast('已导出');
}

function exportRepo() {
  const kindName = { para: '段落', sentence: '句子', full: '全文', link: '链接' };
  /* 笔记（标题 / 正文 / 创建时间）一起导出，否则导出文件里只剩收藏本身 */
  const noteText = (r) => {
    if (!noteHas(r)) return '';
    const lines = [];
    if (noteTitle(r)) lines.push(noteTitle(r));
    if (noteBody(r).trim()) lines.push(noteBody(r));
    if (Number(r.cTs)) lines.push('（创建于 ' + new Date(Number(r.cTs)).toLocaleString() + '）');
    return '\n笔记：' + lines.join('\n');
  };
  const lines = repo.map((r) => {
    const head = '[' + (kindName[r.kind] || '片段') + '] ' + (r.title || '') +
      (r.source ? '  —  ' + r.source : '') +
      (r.ts ? '  (' + new Date(r.ts).toLocaleString() + ')' : '');
    if (r.kind === 'link') return head + '\n' + (r.url || '') + noteText(r);
    return head + '\n' + (r.text || '') + (r.tr ? '\n译文：' + r.tr : '') + noteText(r);
  });
  download('waikan-repo.txt', lines.join('\n\n---\n\n'));
  toast('已导出');
}

/** 导入：兼容 TSV（单词⇥释义）与纯「单词 空格 释义」 */
function importFile(file) {
  const fr = new FileReader();
  fr.onload = () => {
    const text = String(fr.result || '').replace(/^﻿/, '');
    let n = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split(/\t| {2,}|\s(?=[a-z]{1,4}\.\s)/i);
      const w = (parts[0] || '').trim();
      if (!w || !/[A-Za-z]/.test(w)) continue;
      const rest = parts.slice(1).join(' ').trim();
      if (bank.some((b) => String(b.w).toLowerCase() === w.toLowerCase())) continue;
      bank.push({ w, def: rest, lemma: '', ts: Date.now() - n });
      n++;
    }
    if (n) { saveBank(); renderBank(); }
    toast(n ? '已导入 ' + n + ' 词' : '没有可导入的新词');
  };
  fr.readAsText(file, 'utf-8');
}

/* ---------- toast ---------- */
let toastEl = null, toastTimer = null;
function toast(msg) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'item';
    toastEl.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);' +
      'z-index:99;padding:7px 13px;font-size:12px;box-shadow:0 6px 20px rgba(0,0,0,.2)';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.style.display = 'block';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 1800);
}

/* ---------- 绑定 ---------- */
function wire() {
  // 标签页
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.dataset.page === t.dataset.tab));
    };
  });

  // 总开关（网页上一键生效）
  $('btnOn').onclick = () => {
    prefs.on = !prefs.on;
    savePrefs();
    renderOnBtn();
    toast(prefs.on ? '已在网页上开启' : '已在网页上关闭');
  };

  // 生词本
  $('bankQ').oninput = (e) => { bankQ = e.target.value; renderBank(); };
  $('bankSort').onchange = (e) => {
    prefs.bankSort = e.target.value;
    savePrefs(); renderBank();
  };
  /* 二级排序：只在「按重点」模式下可见，控制重点区/非重点区**内部**的顺序 */
  if ($('bankSubSort')) $('bankSubSort').onchange = (e) => {
    prefs.bankSubSort = e.target.value;
    savePrefs(); renderBank();
  };
  $('btnExportAnki').onclick = exportAnki;
  $('btnExportTxt').onclick = exportTxt;
  $('btnExportRepo').onclick = exportRepo;
  $('btnImport').onclick = () => $('fileImport').click();
  $('fileImport').onchange = (e) => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ''; };
  $('btnClearBank').onclick = () => {
    if (!bank.length) return;
    if (confirm('确定清空全部 ' + bank.length + ' 个生词？')) { bank = []; saveBank(); renderBank(); }
  };
  $('btnClearRepo').onclick = () => {
    if (!repo.length) return;
    if (confirm('确定清空全部 ' + repo.length + ' 条收藏？')) { repo = []; saveRepo(); renderRepo(); }
  };

  // 仓库
  $('repoQ').oninput = (e) => { repoQ = e.target.value; renderRepo(); };
  $('repoSort').onchange = (e) => { prefs.repoSort = e.target.value; savePrefs(); renderRepo(); };
  $('btnAddLink').onclick = addLinkFromCurrent;

  // 笔记模块：搜索 + 新建（编辑与保存都在笔记卡片自己身上）
  $('noteQ').oninput = (e) => { noteQ = e.target.value; renderNotes(); };
  $('btnNewNote').onclick = newNote;

  // 测试：数量 / 范围 / 抽题 / 一键显示
  if ($('quizN')) {
    $('quizN').onchange = (e) => {
      let n = Math.floor(Number(e.target.value) || 10);
      if (n < 1) n = 1;
      if (n > 999) n = 999;
      e.target.value = String(n);
      prefs.quizN = n;
      savePrefs();
    };
  }
  if ($('quizScope')) {
    $('quizScope').onchange = (e) => { prefs.quizScope = e.target.value; savePrefs(); };
  }
  if ($('btnQuizStart')) $('btnQuizStart').onclick = startQuiz;
  if ($('btnQuizReveal')) $('btnQuizReveal').onclick = toggleRevealAll;

  // 设置
  if ($('trTarget')) $('trTarget').onchange = (e) => { prefs.trTarget = e.target.value; savePrefs(); };
  /* 翻译引擎：auto 会先试 Google，失败自动切 MyMemory（见 background.js） */
  if ($('trProvider')) $('trProvider').onchange = (e) => { prefs.trProvider = e.target.value; savePrefs(); };
  if ($('linkNav')) $('linkNav').onchange = (e) => { prefs.linkNav = e.target.value; savePrefs(); };
  if ($('mmEmail')) $('mmEmail').onchange = (e) => { prefs.mmEmail = e.target.value.trim(); savePrefs(); };
  if ($('clearTrCache')) $('clearTrCache').onclick = async () => {
    const r = await bg({ type: 'tr:clear-cache' });
    toast(r && r.ok ? '翻译缓存已清除' : '清除失败，请重试');
  };
  $('themeSelect').onchange = (e) => { prefs.theme = e.target.value; savePrefs(); applyTheme(); };
  $('langSelect').onchange = (e) => { prefs.lang = e.target.value; savePrefs(); };
  $('uiFont').oninput = (e) => {
    prefs.uiFont = +e.target.value;
    $('uiFontVal').textContent = e.target.value;
    applyUiScale();                     // 立刻缩放，不用等重开面板
    savePrefs();
  };
  $('fontFamily').onchange = (e) => { prefs.fontFamily = e.target.value; savePrefs(); };
  /* ★ 星标开关。存的是明确的 true/false，别存 undefined：
     内容脚本里用 `prefs.starOn === false` 判"关"，写成 undefined 会当成开。 */
  $('starOn').onchange = (e) => { prefs.starOn = e.target.checked; savePrefs(); };
  /* 小字说明：先本地生效（立刻收起来），再落盘 */
  if ($('hintsOn')) {
    $('hintsOn').onchange = (e) => {
      prefs.hints = e.target.checked;
      applyHints();
      savePrefs();
    };
  }
  /* 释义浮层位置：上方（默认，方便点「加入生词本」）/ 下方 */
  if ($('popAbove')) $('popAbove').onchange = (e) => { prefs.popAbove = e.target.checked; savePrefs(); };
}

function renderOnBtn() {
  const b = $('btnOn');
  b.classList.toggle('on', !!prefs.on);
  b.textContent = prefs.on ? '● 开启' : '○ 已关闭';
}

function renderSettings() {
  /* 老 prefs 没有 trTarget 字段 → 按默认的中文简体处理 */
  if ($('trTarget')) $('trTarget').value = prefs.trTarget || 'zh-CN';
  if ($('trProvider')) $('trProvider').value = prefs.trProvider || 'auto';
  if ($('linkNav')) {
    const v = prefs.linkNav === 'block' || prefs.linkNav === 'allow'
      ? prefs.linkNav
      : (prefs.linkNav === true ? 'allow' : 'smart')
    $('linkNav').value = v
  }
  if ($('mmEmail')) $('mmEmail').value = prefs.mmEmail || '';
  $('themeSelect').value = prefs.theme;
  $('langSelect').value = prefs.lang;
  /* 界面字号：老版本存的是 fontSize（17，给网页正文用的），这里换 uiFont（默认 12） */
  const uiFont = Number(prefs.uiFont) || 12;
  $('uiFont').value = uiFont;
  $('uiFontVal').textContent = uiFont;
  $('fontFamily').value = prefs.fontFamily;
  /* 老版本存的 prefs 没有 starOn 字段，此时按"开"处理，
     只有明确存了 false 才算关 —— 与内容脚本的判定保持一致。 */
  $('starOn').checked = prefs.starOn !== false;
  /* 老 prefs 没有 popAbove 字段 → 按默认的"上方"处理，
     与内容脚本 `prefs.popAbove === false` 才算下方的判定一致。 */
  if ($('popAbove')) $('popAbove').checked = prefs.popAbove !== false;
  $('bankSort').value = prefs.bankSort || 'time';
  if ($('bankSubSort')) $('bankSubSort').value = prefs.bankSubSort || 'time';
  if ($('bankSubSortWrap')) $('bankSubSortWrap').hidden = (prefs.bankSort || 'time') !== 'key';
  $('repoSort').value = prefs.repoSort || 'time';
  /* 小字说明开关（默认开） */
  if ($('hintsOn')) $('hintsOn').checked = prefs.hints !== false;
  applyHints();
}

(async function init() {
  await load();
  wire();
  applyTheme();
  applyUiScale();
  renderSettings();
  renderOnBtn();
  renderBank();
  renderRepo();
  renderNotes();
  renderQuiz();
  // 词典状态（后台懒加载 3.6MB 词典，第一次要点一下才回）
  bg({ type: 'dict:status' }).then((d) => {
    if (d && d.ok) $('dictNote').textContent = '内置词典 ' + d.size.toLocaleString() + ' 词';
    else $('dictNote').textContent = '词典加载失败';
  });
})();