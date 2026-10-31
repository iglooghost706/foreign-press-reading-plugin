'use strict';

/**
 * content.js —— 注入网页的阅读增强层。
 *
 * 交互约定（与软件版完全一致，用户不用重新学）：
 *   单击词   → 查词释义
 *   双击词   → 加入生词本
 *   拖选词组 → 词组翻译
 *   拖选句子 → 句子翻译
 *   悬停段落/句子 → 出现「☆」收藏按钮
 *
 * ★ 三击翻译已废弃：现在**两种翻译都是"按住鼠标拖选一段再松开"**，
 *   浮层标题由选中的内容决定（见 classifySelection），不看点击次数。
 *
 * ★ 页面角的「收藏全文」与「复制全文」按钮均已按需求删除。
 *   收藏只保留段落 / 句子两种（悬停 ☆），页面上不再有浮动工具条。
 *
 * ★ 插件版**没有新闻区**（用户要求），所以全部功能都发生在「当前网页」上：
 *   正文来自用户正在读的页面，而不是软件内的新闻面板 iframe。
 */

(function () {
  if (window.__wkInjected) return;
  window.__wkInjected = true;

  /* ---------- 状态（存在 chrome.storage.local，多标签页共享） ---------- */
  const KEY_PREFS = 'wk_prefs';
  const KEY_BANK = 'wk_bank';
  const KEY_REPO = 'wk_repo';

  let prefs = {
    on: true,            // 总开关
    starOn: true,        // 悬停收藏星标（独立开关，设置面板可关）
    lang: 'zh',
    theme: 'light',
    /* 网页正文只保留「字体」这一项。字号/行距/编辑模式已经从设置里去掉：
       字号改成调侧边栏界面（见 reader-sidebar.js 的 applyUiScale），
       正文版式交回站点自己管，不再强行覆盖。 */
    fontFamily: 'default',
    bankSort: 'time',
    popAbove: true,       // 释义浮层显示在词的上方（够不到时自动翻到下方）
    trTarget: 'zh-CN',    // 翻译目标语言（侧边栏设置里可改）
    /* 点击链接里的单词时是否跟随跳转，三档：
         'smart'（默认）正文里的内联超链接只查词；标题/导航/卡片链接照常跳转
         'block'       所有链接都不跳转（只查词）
         'allow'       全部保持浏览器原生行为（点词也会跳走）
       兼容旧值：true → allow，false/undefined → smart。
       想临时跳转不用改设置，按住 Alt 点即可。 */
    linkNav: 'smart'
  };
  let bank = [];         // 生词本
  let repo = [];         // 仓库（收藏的段落/句子；旧的 kind='full' 条目仍可正常显示）

  /* ★ 我们自己注入的界面：工具坞、释义浮层、段落星标、toast。
     凡是要"从页面里找词"的地方，都必须先把它们整块排除掉。
     踩过的坑：右下角模式按钮英文界面显示「Auto」，它本身就是个英文单词，
     而当时的排除名单只写了 .wk-fab（电源按钮），漏了 .wk-nav-fab 等，
     于是点「Auto」会弹出 auto 的释义，按钮反而切不动。
     现在统一用这个选择器，新增按钮只要放进工具坞就自动被排除。 */
  const UI_SEL = '.wk-dock, .wk-pop, .wk-star, .wk-toast';

  const store = () => chrome.storage.local;

  async function loadAll() {
    try {
      const o = await store().get([KEY_PREFS, KEY_BANK, KEY_REPO]);
      prefs = Object.assign(prefs, o[KEY_PREFS] || {});
      bank = Array.isArray(o[KEY_BANK]) ? o[KEY_BANK] : [];
      repo = Array.isArray(o[KEY_REPO]) ? o[KEY_REPO] : [];
    } catch (e) { /* 用默认值 */ }
  }
  async function savePrefs() { try { await store().set({ [KEY_PREFS]: prefs }); } catch (e) {} }
  async function saveBank() { try { await store().set({ [KEY_BANK]: bank }); } catch (e) {} }
  async function saveRepo() { try { await store().set({ [KEY_REPO]: repo }); } catch (e) {} }

  /* ---------- i18n ---------- */
  const I18N = {
    zh: {
      noDef: '未收录该词', fetching: '查词中…', saving: '保存中…', saved: '已保存',
      translate: '翻译', sentence: '句子翻译', phrase: '词组翻译', addBank: '加入生词本',
      inBank: '已在生词本', removeBank: '移出生词本', think: '想表达', loading: '加载中',
      markKey: '标记为重点词语', unmarkKey: '取消重点标记',
      quota: '翻译额度已用完（Google 与 MyMemory 都不可用），可在设置里切换引擎，或填 MyMemory 邮箱提额', netErr: '翻译失败：可能是网络问题（Google 需能访问外网，MyMemory 可直连）',
      timeoutErr: '翻译超时：网络较慢或请求被拦截，可重试', httpErr: '翻译服务返回错误',
      lowqErr: '没找到可靠译文（仅有低质量机翻，已忽略）',
      lemma: '原形', addSentence: '收藏句子', addPhrase: '收藏词组', addPara: '收藏段落',
      addLink: '收藏网址', bookmarked: '该文章已收藏过', link: '链接',
      savedAlready: '该内容已收藏过',
      copied: '已复制', onTip: '外刊阅读：已开启（点此关闭）', onToast: '外刊阅读：已开启',
      off: '已关闭（点此开启）',
      navBlocked: '链接跳转：全部阻止（点此切到允许）',
      navAllowed: '链接跳转：全部允许（点此切到智能）',
      navSmart: '链接跳转：智能（标题可点，正文链接不跳）',
      /* 按钮上的"智"字也要跟着界面语言走，英文用一个能塞进 30px 方块的词 */
      navSmartBadge: '智',
      navBlockedToast: '已阻止全部链接跳转：点词只查词（按住 Alt 点可跳转）',
      navAllowedToast: '已允许全部链接跳转：点链接里的词会跟随跳转',
      navSmartToast: '智能模式：标题/导航可点，正文里的超链接只查词',
      starOnTip: '段落收藏：已开启（点此关闭）', starOffTip: '段落收藏：已关闭（点此开启）',
      starOnToast: '段落收藏已开启：鼠标移到段落上会出现 ☆',
      starOffToast: '段落收藏已关闭：段落旁不再出现 ☆',
      noText: '没有可翻译的内容', wordBank: '生词本', repo: '仓库', comments: '我的笔记'
    },
    en: {
      noDef: 'Not found', fetching: 'Looking up…', saving: 'Saving…', saved: 'Saved',
      translate: 'Translate', sentence: 'Translate sentence', phrase: 'Translate phrase',
      addBank: 'Add to word bank', inBank: 'In word bank', removeBank: 'Remove from bank',
      markKey: 'Mark as key word', unmarkKey: 'Unmark key word',
      think: 'Think', loading: 'Loading', quota: 'Translation quota exhausted (Google & MyMemory both failed). Switch engine or add a MyMemory email in Settings',
      netErr: 'Translate failed: possibly a network issue',
      timeoutErr: 'Translate timed out: slow network or blocked request, retry',
      httpErr: 'Translation service returned an error',
      lowqErr: 'No reliable translation found (low-quality MT ignored)', lemma: 'lemma',
      addSentence: 'Save sentence', addPhrase: 'Save phrase', addPara: 'Save paragraph',
      addLink: 'Save link', bookmarked: 'Already bookmarked', link: 'Link',
      savedAlready: 'Already saved',
      copied: 'Copied', onTip: 'Reading mode: on (click to turn off)', onToast: 'Reading mode: on',
      off: 'Off (click to turn on)',
      navBlocked: 'Link jump: block all (click for allow)',
      navAllowed: 'Link jump: allow all (click for smart)',
      navSmart: 'Link jump: smart (headlines yes, body links no)',
      navSmartBadge: 'Auto',
      navBlockedToast: 'All link jumps blocked: clicking a word only looks it up (hold Alt to follow)',
      navAllowedToast: 'All link jumps allowed: clicking a word inside a link follows it',
      navSmartToast: 'Smart mode: headlines and nav links open; links inside body text only look up',
      starOnTip: 'Paragraph save: on (click to turn off)',
      starOffTip: 'Paragraph save: off (click to turn on)',
      starOnToast: 'Paragraph save on: hover a paragraph to see the star',
      starOffToast: 'Paragraph save off: no star beside paragraphs',
      noText: 'Nothing to translate', wordBank: 'Word bank', repo: 'Repository', comments: 'My notes'
    }
  };
  const t = (k, o) => {
    const s = (I18N[prefs.lang] || I18N.zh)[k];
    if (!s) return k;
    return o ? s.replace(/\{(\w+)\}/g, (m, n) => o[n] != null ? o[n] : '') : s;
  };

  /* ---------- 与后台通信 ---------- */
  function bg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          resolve(chrome.runtime.lastError ? null : r);
        });
      } catch (e) { resolve(null); }
    });
  }
  const lookupDict = (word) => bg({ type: 'dict:lookup', word });
  /* 翻译语对由用户在侧边栏设置里选；没有或是非法值时退回中文简体。
     源语言固定 en：外刊站点基本都是英文站点。 */
  function targetLangPair () {
    const tgt = String(prefs.trTarget || '').trim() || 'zh-CN';
    const safe = /^[a-z]{2}(-[A-Z]{2})?$/i.test(tgt) ? tgt : 'zh-CN';
    return 'en|' + safe;
  }
  const doTranslate = async (q, langpair) => {
    const r = await bg({ type: 'tr:translate', q, langpair: langpair || targetLangPair() });
    if (r === null) return null;            // 消息通道断了（扩展刚重载/页面未注入）
    return {
      text: (r && r.text) || '',
      code: (r && r.code) || (r && r.text ? '' : 'empty'),
      status: r && r.status
    };
  };

  /* ---------- 样式 ----------
     样式由 manifest 的 content_scripts.css 注入（同一批 matches，必然生效），
     这里**不要再**用 <link href=chrome.runtime.getURL(...)> 补一次：
     content.css 不在 web_accessible_resources 里（matches:[]），那个请求
     每次都被 Chromium 拦掉，控制台固定报一条
        Failed to load resource: net::ERR_BLOCKED_BY_CLIENT .../content.css
     （实测：打包版每开一个网页就报 2 条，纯噪音，对功能毫无帮助。）
     判定"内容脚本注入成功"请看 window.__wkInjected 或 #wk-fab，
     不要再看 #wk-ext-css —— 那个节点已经不存在了。 */

  /* 给页面留一个"内容脚本已注入"的 DOM 痕迹。
     内容脚本跑在隔离世界，主世界读不到 window.__wkInjected，
     而测试/诊断需要一条主世界也能看到的证据（旧的 #wk-ext-css 就是干这个的）。 */
  function markInjected() {
    try { document.documentElement.setAttribute('data-wk-injected', '1'); } catch (e) {}
  }

  /* ---------- 弹窗（释义 / 译文） ---------- */
  let popEl = null;

  /* ★ 异步竞态防护（点词翻译精度修复 ④）。
     查词要走 chrome.runtime 消息 + 长尾词还要走在线翻译，**是异步的**；
     用户点得比回包快时，先发出的慢请求会**后到**，把新点击的浮层直接顶掉：
       点 "said"（词典没收录 → 转在线翻译，慢）
       点 "the"（词典秒回，浮层立刻显示 the）
       ↑ "said" 的回包这时才到 → 浮层又被改回 "said"
     用户看到的就是"点了这个词，却弹/闪出另一个词"。
     （tools/test-hit-precision.js 实测：连点 42 个词时 6 处串词。）
     解法：每次"开始一次新的查询"就把代数 +1，异步回来后代数变了就丢弃。 */
  let popGen = 0;
  function nextPopGen() { popGen++; return popGen; }
  function popGenStale(g) { return g !== popGen; }

  function closePop() {
    popGen++;                 // 收浮层也算"作废在途的旧查询"
    if (popEl) { popEl.remove(); popEl = null; }
  }

  /* 点完浮层上的按钮后自动收起。
     留 420ms 让「✓ 已保存」这类反馈能被看见——立刻关掉的话，
     用户根本来不及确认操作成功，观感上像是"点了没反应"。
     用代数做守卫：这 420ms 内如果用户又点了别的词、弹了新浮层，
     代数已经变了，就不要把新浮层误关掉。 */
  function closePopAfter(ms) {
    const g = popGen;
    setTimeout(() => { if (popGen === g) closePop(); }, ms || 420);
  }
  function showPop(rect, html, opts) {
    closePop();
    opts = opts || {};
    const d = document.createElement('div');
    d.className = 'wk-pop' + (opts.wide ? ' wk-pop-wide' : '');
    d.innerHTML = html;
    document.documentElement.appendChild(d);
    popEl = d;

    /* 定位。
     * ★ 默认**显示在词的上方**（place='above'）：释义框底边紧贴词的顶边，
     *   「加入生词本」按钮离光标更近，抬手就能点，不必再往下挪一段。
     *   浮层仍然在 .wk-pop 内部，click 处理器的 .wk-pop 排除会照常生效。
     *   **关键修复（生词本/重点词定位 bug）**：上方方向**永远贴着词的上方，
     *   绝不翻到词下方**。已加入生词本 / 已标记重点的单词，释义框比普通单词
     *   多一行「标记为重点词语 / 取消重点标记」按钮，整体更高；旧逻辑一旦
     *   "上方放不下就翻到下方"，这些词就会突然跳到词下面，看着就像"按钮没
     *   出现在单词正上方"。现在上方放不下就**上贴视口顶**（仍算"上方"），
     *   只有在极短屏 + 极高浮层、两侧都塞不下时，才退而求其次夹在视口里。
     */
    const place = (opts.place === 'below' || prefs.popAbove === false) ? 'below' : 'above';
    const pw = d.offsetWidth, ph = d.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    const sx = window.scrollX, sy = window.scrollY;
    const gap = 6;
    const pad = 8;
    const aboveTop = rect.top + sy - ph - gap;    // 上方时浮层顶边
    const belowTop = rect.bottom + sy + gap;     // 下方时浮层顶边
    const fitsAbove = aboveTop >= sy + pad;
    const fitsBelow = belowTop + ph <= sy + vh - pad;

    let top;
    if (place === 'above') {
      /* 始终在词上方：首选 aboveTop；放不下就上贴视口顶，绝不翻到下方 */
      top = fitsAbove ? aboveTop : Math.max(sy + pad, aboveTop);
    } else {
      if (fitsBelow) top = belowTop;
      else if (fitsAbove) top = aboveTop;
      else top = Math.max(sy + pad, Math.min(belowTop, sy + vh - ph - pad));
    }

    /* 横向：让浮层**以单词为中心**。
     * ★ 之前是把浮层**左边缘**对齐单词左边缘，于是「加入生词本」按钮
     *   （flex:1 撑满整行）落在单词的左边很远的地方 —— 用户要挪一大段
     *   鼠标才对得上，不符合直觉。按钮文字正好在按钮里居中，
     *   所以把浮层中心对齐单词中心，按钮就落在单词**正上方**。
     * 放不下再退回左对齐，最后夹在视口内。 */
    let left;
    if (opts.center !== false) {
      left = rect.left + rect.width / 2 - pw / 2;
      /* 居中会多露出一侧，越界时退回贴左沿（比硬夹更接近原位置感） */
      if (left + pw > sx + vw - pad || left < sx + pad) left = rect.left + sx;
      if (left + pw > sx + vw - pad) left = sx + vw - pw - pad;
      if (left < sx + pad) left = sx + pad;
    } else {
      left = rect.left + sx;
      if (left + pw > sx + vw - pad) left = sx + vw - pw - pad;
      if (left < sx + pad) left = sx + pad;
    }
    d.style.left = left + 'px';
    d.style.top = top + 'px';

    d.addEventListener('mousedown', (e) => e.stopPropagation());
    return d;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 释义里的词性等排版微调（与软件版 decorateDef 同思路） */
  function decorateDef(def, lemma, isApi) {
    let h = escapeHtml(def || '');
    // [医] [计] [化] 等纯中文领域标记加淡底，避免和正文混在一起看串行
    h = h.replace(/\[([\u4e00-\u9fff]{1,4})\]/g, '<i class="wk-dom">[$1]</i>');
    // v. / n. / a. / prep. 等词性标记加粗一点，便于扫读
    h = h.replace(/(^|[；;，,、\s])((?:art|n|v|a|ad|adv|adj|prep|conj|pron|num|int|vt|vi|abbr)\.)/gi,
      '$1<b class="wk-pos">$2</b>');
    let extra = '';
    if (lemma) extra += '<div class="wk-lemmat">' + escapeHtml(t('lemma')) + ' <b>' + escapeHtml(lemma) + '</b></div>';
    return h + extra;
  }

  /* ---------- 查词 ---------- */
  const dictCache = new Map();     // 本标签页缓存，二次点击零延迟

  async function showDefinition(word, anchorEl, wordRect) {
    /* ★ 锚点优先用**词自己的矩形**。
       以前只传元素（被点的 <p> 或 <span>），getBoundingClientRect() 给出的是
       整个元素的盒子 —— 段落越长，浮层离词越远，于是"释义显示在单词上方"
       看着像是完全没生效。findWord() 现在会把 Range 量到的词矩形一起带出来。 */
    const rect = (wordRect && (wordRect.width || wordRect.height))
      ? wordRect
      : anchorEl.getBoundingClientRect();
    const w = String(word || '').trim();
    if (!w) return;

    /* ★ 本次查询的"代数"。异步回包时若代数已变（用户又点了别的词、或浮层
       被关掉），说明这份结果已经过期，必须丢弃 —— 否则慢回包会把新词的
       浮层顶掉，表现为"点了 A 却弹 B"。 */
    const gen = nextPopGen();

    if (dictCache.has(w)) {
      const c = dictCache.get(w);
      renderDef(w, c, rect, c.viaApi);
      return;
    }

    let d = await lookupDict(w);
    if (popGenStale(gen)) return;          // 期间用户点了别的词 → 丢弃
    let viaApi = false;
    if (!d) {
      // 长尾生词：走在线翻译兜底（与句子翻译同一条链路）
      showPop(rect, '<div class="wk-pop-title">' + escapeHtml(w) + '</div>' +
        '<div class="wk-loading">' + t('fetching') + '</div>');
      /* ★ 同样必须"先 showPop 再取代数"：上面的 showPop 内部会 closePop→popGen++，
         用第 254 行那个 gen 去判断必然已作废，长尾词在线兜底会永远停在"查词中…"。 */
      const gen2 = nextPopGen();
      const r = await doTranslate(w);
      if (popGenStale(gen2)) return;       // 在线翻译更慢，这里最容易串词
      if (r && r.text && r.text.trim() && r.text.trim() !== w) {
        dictCache.set(w, { def: r.text, lemma: '', viaApi: true });
        renderDef(w, { def: r.text, lemma: '' }, rect, true);
        return;
      }
      closePop();
      showPop(rect, '<div class="wk-pop-title">' + escapeHtml(w) + '</div>' +
        '<div class="wk-muted">' + t('noDef') + '</div>');
      return;
    }
    dictCache.set(w, { def: d.def, lemma: d.lemma, viaApi: false });
    renderDef(w, d, rect, false);
  }

  function renderDef(word, d, rect, isApi) {
    const low = word.toLowerCase();
    const idx = bank.findIndex((b) => String(b.w || '').toLowerCase() === low);
    const inBank = idx >= 0;
    const isKey = inBank && !!bank[idx].key;
    const srcLabel = isApi ? 'MyMemory' : (d.via === 'lemma-table' || d.via === 'lemma-rule' ? '词典·原形还原' : '内置词典');
    /* ★ 这里原本还有一个「翻译」按钮：点单词已自动显示内置词典释义，
       再让用户点一次翻译是多余的一步，而且和拖选句子翻译重复。
       按用户要求删除，只保留「加入生词本」。

       重点词语：只有在**已加入生词本**时才提供（没入库谈不上"重点"）。
       独占第二行，不和移除按钮挤在一排 —— 移除是常用操作，
       重点标记是低频操作，分开摆能避免误点。 */
    const keyBtn = inBank
      ? '<div class="wk-acts wk-acts-2">' +
        '<button class="wk-btn wk-key-btn ' + (isKey ? 'wk-key-on' : '') + '" data-a="key">' +
        (isKey ? '★ ' + escapeHtml(t('unmarkKey')) : escapeHtml(t('markKey'))) + '</button>' +
        '</div>'
      : '';
    const html =
      '<div class="wk-pop-title">' + escapeHtml(word) +
      (isApi ? '' : ' <span class="wk-src">' + escapeHtml(srcLabel) + '</span>') + '</div>' +
      '<div class="wk-def">' + decorateDef(d.def, d.lemma, isApi) + '</div>' +
      '<div class="wk-acts">' +
      '<button class="wk-btn ' + (inBank ? 'wk-on' : '') + '" data-a="bank">' +
      (inBank ? t('removeBank') : t('addBank')) + '</button>' +
      '</div>' + keyBtn;
    const pop = showPop(rect, html, { wide: true });
    pop.querySelector('[data-a="bank"]').onclick = () => {
      const i = bank.findIndex((b) => String(b.w || '').toLowerCase() === low);
      if (i >= 0) bank.splice(i, 1);
      else bank.unshift({ w: word, def: d.def, lemma: d.lemma || '', ts: Date.now(), key: false });
      saveBank();
      renderDef(word, d, rect, isApi);      // 原地刷新按钮状态
      flash(pop.querySelector('[data-a="bank"]'), i >= 0 ? t('addBank') : t('removeBank'));
      closePopAfter();                      // 操作完成 → 浮层自动收起
    };
    const kb = pop.querySelector('[data-a="key"]');
    if (kb) {
      kb.onclick = () => {
        const i = bank.findIndex((b) => String(b.w || '').toLowerCase() === low);
        if (i < 0) return;
        bank[i].key = !bank[i].key;
        saveBank();
        markBanked();                       // 立刻重画，让网页上的虚线变红
        renderDef(word, d, rect, isApi);   // 按钮文案切成"取消重点标记"
        closePopAfter();
      };
    }
  }

  /* 按钮上的短暂反馈（收藏 / 复制 / 入生词本）。
     ★ 原来固定 900ms，而「✓ 该内容已收藏过」有 9 个字，
       正常人从点完到看清这段字往往要 1.5 秒以上，提示早就变回去了，
       用户会以为"点了没反应"。现在给到 2.2 秒，并且可以由调用方覆盖。 */
  function flash(el, msg, ms) {
    if (!el) return;
    const old = el.textContent;
    el.textContent = msg;
    el.classList.add('wk-flash');
    setTimeout(() => { el.textContent = old; el.classList.remove('wk-flash'); }, ms || 2200);
  }

  /* ---------- 入库 ---------- */
  async function addToBank(word) {
    const w = String(word || '').trim().toLowerCase();
    if (!w) return;
    if (bank.some((b) => String(b.w || '').toLowerCase() === w)) {
      toast(t('inBank'));
      return;
    }
    let def = '';
    let lemma = '';
    if (dictCache.has(word)) {
      const c = dictCache.get(word); def = c.def; lemma = c.lemma || '';
    } else {
      const d = await lookupDict(word);
      if (d) { def = d.def; lemma = d.lemma || ''; dictCache.set(word, { def, lemma, viaApi: false }); }
      else {
        const r = await doTranslate(word);
        def = (r && r.text) || '';
      }
    }
    bank.unshift({ w: word, def, lemma, ts: Date.now() });
    await saveBank();
    /* 双击时浏览器会留下选中高亮，遮住我们的标记效果，看起来像"没入库"，
       入库成功后清掉选区。 */
    try { const s = getSelection(); if (s && !s.isCollapsed) s.removeAllRanges(); } catch (e) {}
    toast(t('saved') + ' · ' + bank.length);
    markBanked();
  }

  /* ---------- 翻译 ---------- */
  /* 把"翻译空了"翻译成人话。
     ★ 这里踩过一个大坑：原来只要结果为空就一律显示"免费额度已用完"，
       于是 HTTP 403 / 429、CORS、断网、被代理拦、响应里全是 quality=0
       的机翻……任何失败都长得像"额度用尽"，把排查方向整个带偏。
       现在按 translate() 回传的 code 分开提示。 */
  function trErrorText(r) {
    if (r === null) return t('netErr');                 // 消息通道断了（扩展重载/未注入）
    const code = (r && r.code) || 'empty';
    if (code === 'quota') return t('quota');
    if (code === 'timeout') return t('timeoutErr');
    if (code === 'http') return t('httpErr') + (r && r.status ? '（HTTP ' + r.status + '）' : '');
    if (code === 'lowq') return t('lowqErr');
    return t('netErr');                                 // net / noreply / empty
  }

  async function showTranslation(text, anchorEl, kind) {
    const rect = anchorEl.getBoundingClientRect();
    const q = String(text || '').trim();
    if (!q) return;
    const isSent = kind !== 'phrase';
    const title = t(isSent ? 'sentence' : 'phrase');
    /* ★★ 顺序是这段代码的命门：必须**先 showPop 占位、再取代数 gen**。
       showPop() 的第一件事是 closePop()，而 closePop() 会 popGen++（见 148 行）。
       若像以前那样先 `const gen = nextPopGen()` 再 showPop，gen 在这一行之内
       就已经作废；回包一到 popGenStale(gen) 恒为真，函数直接 return，
       浮层永远停在"加载中"——这就是词组翻译/句子翻译"拖选后没反应"的根因。
       先占位后取号，异步回包时只要用户没点别的词，代数就还是本次的。 */
    showPop(rect, '<div class="wk-pop-title">' + title + '</div>' +
      '<div class="wk-src-text">' + escapeHtml(q) + '</div>' +
      '<div class="wk-loading">' + t('loading') + '</div>', { wide: true });
    const gen = nextPopGen();
    const r = await doTranslate(q);
    if (popGenStale(gen)) return;          // 期间用户点了别的词 → 丢弃
    const ok = !!(r && r.text && String(r.text).trim());
    const body = ok ? String(r.text).trim() : trErrorText(r);
    showPop(rect, '<div class="wk-pop-title">' + title + '</div>' +
      '<div class="wk-src-text">' + escapeHtml(q) + '</div>' +
      '<div class="wk-def' + (ok ? '' : ' wk-def-err') + '">' + escapeHtml(body) + '</div>' +
      '<div class="wk-acts"><button class="wk-btn" data-a="save">' +
      t(isSent ? 'addSentence' : 'addPhrase') +
      '</button>' +
      '<button class="wk-btn" data-a="copy">' + t('copied') + '</button></div>', { wide: true });
    const copyBtn = popEl.querySelector('[data-a="copy"]');
    if (copyBtn) copyBtn.onclick = () => {
      navigator.clipboard.writeText(body).then(() => {
        flash(copyBtn, '✓');
        closePopAfter();                    // 复制完自动收起
      });
    };
    const saveBtn = popEl.querySelector('[data-a="save"]');
    if (saveBtn) saveBtn.onclick = () => {
      /* 片段类型跟着浮层走：词组存成词组，整句存成句子。
         以前无论哪种都写死 kind:'sentence'、标题写死「句子」，
         存进去一个词组却在列表里标成句子。 */
      const fragKind = isSent ? 'sentence' : 'phrase';
      if (isFragmentSaved(q, fragKind)) {
        flash(saveBtn, '✓ ' + t('savedAlready'));
        closePopAfter();
        return;
      }
      repo.unshift({
        id: 'snip-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        title: (CURRENT_TITLE ? CURRENT_TITLE + ' · ' : '') + t(fragKind),
        source: location.hostname, text: q, tr: body,
        blocks: null, kind: fragKind, comment: '', ts: Date.now()
      });
      saveRepo();
      flash(saveBtn, '✓ ' + t('saved'));
      closePopAfter();                      // 收藏完自动收起
    };
  }

  /* ---------- 悬停收藏（☆） ----------
   ★ 踩过的三个坑，都记在这里免得再犯：
     ① 星标原本定位在段落**外面**，鼠标朝它移动时先触发段落 mouseleave，
        星标被立刻删掉 —— 表现为"鼠标一靠近就消失"，根本点不中。
        → 星标改放到段落**内部**右上角。
     ② 收起若立即执行，鼠标从段落划向星标的途中会被误删。
        → 延迟收起，并在到期时确认鼠标确实不在星标上。
     ③ ★ 定时器**原来是全局唯一的**，而真实阅读是"从一段划到下一段"：
          A.mouseleave → 挂上 A 的收起定时器
          B.mouseenter → cancelStarLeave() 把 A 的定时器清了！
        于是 A 的星标永远不会被移除，正文也就永远留着那份让位内边距。
        实测划过 3 段后残留 2 个星标、2 处内边距。
        → 每个段落各管各的定时器，互不干扰；全局只保留"当前悬停段落"。 */

  /* 当前鼠标所在、且星标已展开的段落；同��只可能有一个 */
  let starActiveEl = null;

  /* ★ 星标位置：优先放到段落**右侧外部**的空隙里，零重排。
     只有放不下（右侧被别的栏占着、或祖先裁剪会把星标切掉）时，
     才退回来贴段落内部右上角，并加 .wk-star-inside 半透明以免压住字。
     全程不碰段落的 padding / width / height —— 那些会让正文重排。 */
  const STAR_SZ = 28;
  const STAR_GAP = 2;      /* 离段落右缘的间距 */
  const STAR_INSET = 1;    /* 贴内时的内缩 */

  function placeStar(el, r) {
    const box = el.getBoundingClientRect();
    const wantL = box.right + STAR_GAP;
    let outside = false;

    /* ① 必须整颗都在视口内 */
    if (wantL >= 0 && wantL + STAR_SZ <= window.innerWidth + 1) {
      /* ② 落点不能压到正文：探星标中心那一格是不是"自己人" */
      const probe = document.elementFromPoint(wantL + STAR_SZ / 2, box.top + 14);
      const clear = !probe || probe === el || el.contains(probe) || probe.contains(el);
      /* ③ 不能有祖先把溢出裁掉（否则星标放出去会被切一半） */
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'hidden' || ox === 'clip' || ox === 'auto' || ox === 'scroll') { clipped = true; break; }
      }
      if (clear && !clipped) outside = true;
    }

    /* ★ 视口坐标 → 定位祖先的偏移。
       两个坑：
         ① 绝对定位的参照点是定位祖先的**padding box**（边框内侧），
            不是 getBoundingClientRect 给的 border box。
            少减一个 border-top，星标就会整体下沉 border 那么多像素
            （实测段落顶 93、星标顶 187，正好差 94px）。
         ② 参照祖先要用星标自己的 offsetParent，不能用 el.offsetParent ——
            有些站点会把段落的 position 覆盖掉，两者可能不是同一个。 */
    const pos = r.offsetParent || document.body;
    const pb = pos.getBoundingClientRect();
    const ps = getComputedStyle(pos);
    const padTop = parseFloat(ps.borderTopWidth) || 0;
    const padLeft = parseFloat(ps.borderLeftWidth) || 0;
    r.style.position = 'absolute';
    if (outside) {
      r.classList.remove('wk-star-inside');
      r.style.top = Math.round(box.top + STAR_INSET - pb.top - padTop) + 'px';
      r.style.left = Math.round(wantL - pb.left - padLeft) + 'px';
      r.style.right = 'auto';
    } else {
      r.classList.add('wk-star-inside');
      r.style.top = '';
      r.style.left = '';
      r.style.right = '';
    }
  }

  function cancelStarLeave(el) {
    if (el && el.__wkStarTimer) {
      clearTimeout(el.__wkStarTimer);
      el.__wkStarTimer = null;
    }
  }

  /* 注：旧版靠切换 .wk-star-open 来加减 padding-right，正是它导致正文重排。
     ���在星标改为纯绝对定位（placeStar），段落盒模型完全不动，
     那个类已彻底删除，CSS 里也不再有对应规则。 */

  function scheduleStarLeave(el, e) {
    /* 只清自己的定时器 —— 绝不能碰别段的，否则会把别段的收起取消掉 */
    cancelStarLeave(el);
    /* 记住鼠标移去了哪里，延迟到期时再判断它是否已进星标 */
    const to = e && e.relatedTarget;
    el.__wkStarTimer = setTimeout(() => {
      el.__wkStarTimer = null;
      const r = el.querySelector(':scope > .wk-star');
      if (!r) return;
      /* ★ 鼠标此刻仍在星标上（或正从段落移向星标的中途），不要删。
         两次判定都做：relatedTarget 是当时的意图，matches(':hover') 是此刻的事实。 */
      if (to && (r === to || r.contains(to) || (to.closest && to.closest('.wk-star')))) return;
      if (r.matches && r.matches(':hover')) return;
      r.remove();
      if (starActiveEl === el) starActiveEl = null;
    }, 260);
  }

  /* 收掉某段落上的星标（立即生效），用于总开关、翻页等场景 */
  function closeStar(el) {
    if (!el) return;
    cancelStarLeave(el);
    const r = el.querySelector(':scope > .wk-star');
    if (r) r.remove();
    if (starActiveEl === el) starActiveEl = null;
  }

  /* ★ 关掉除当前段落外的所有星标。
     真实阅读时同一时刻只应有一个星标；兜住任何"多开"的异常路径。 */
  function closeOtherStars(keep) {
    document.querySelectorAll('.wk-star').forEach((r) => {
      const owner = r.parentElement;
      if (!owner || owner === keep) return;
      closeStar(owner);
    });
  }

  /* ★ 页面角的「收藏全文」与「复制全文」两个按钮都已按需求删除。
   * 随之消失的是这一整块「整篇操作」的实现：正文抽取（ART_SELECTORS /
   * goodPara / NOISE_RE / extractArticle）、剪贴板写入（copyViaExecCommand）
   * 和页面角工具条本身（mountToolbar，含 BBC cookie 弹层那套四角避让探测）。
   * 它们彼此独占，没有任何其他功能依赖，所以一并删除而非留成死代码。
   * 仍然保留：悬停 ☆ 收藏段落/句子、点词、翻译、生词本、总开关。 */

  function attachStar(el, getText, kind) {
    if (el.__wkStar) return;
    el.__wkStar = true;

    el.addEventListener('mouseenter', () => {
      /* ★ 两个条件任一不满足就不出现星标：
           总开关关 / 星标开关关（设置面板） */
      if (!prefs.on || prefs.starOn === false) return;
      /* 只取消**本段**的待收起；别人段的定时器照常到期自行清理 */
      cancelStarLeave(el);
      starActiveEl = el;
      /* 兜底：同一时刻只留一个星标，把之前漏下的清掉 */
      closeOtherStars(el);
      if (el.querySelector(':scope > .wk-star')) return;   // 已在，别重复建
      const r = document.createElement('button');
      r.className = 'wk-star';
      r.textContent = '☆';
      r.title = kind === 'para' ? t('addPara') : t('addSentence');
      r.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        const txt = getText();
        if (!txt || txt.length < 2) { toast(t('noText')); return; }
        if (isFragmentSaved(txt, kind)) { toast(t('savedAlready')); return; }
        repo.unshift({
          id: 'snip-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
          title: (CURRENT_TITLE ? CURRENT_TITLE + ' · ' : '') +
            (kind === 'para' ? '段落' : '句子'),
          source: location.hostname, text: txt,
          blocks: null, kind: kind, comment: '', ts: Date.now()
        });
        saveRepo();
        r.textContent = '★';
        toast(t('saved') + ' · ' + repo.length);
        setTimeout(() => { if (r.isConnected) r.textContent = '☆'; }, 2400);
      });
      /* 鼠标移到星标上时：取消本段待执行的收起，否则刚建就被删 */
      r.addEventListener('mouseenter', () => cancelStarLeave(el));
      r.addEventListener('mouseleave', (e) => scheduleStarLeave(el, e));
      el.appendChild(r);
      /* ★ 入 DOM 之后再定位：offsetParent / getBoundingClientRect 都要元素已在树上 */
      placeStar(el, r);
    });

    el.addEventListener('mouseleave', (e) => scheduleStarLeave(el, e));
  }

  /** 从 <meta> 取标题候选（去掉常见站点后缀） */
  function metaTitle() {
    const pick = (sel) => {
      const m = document.querySelector(sel);
      return m && (m.getAttribute('content') || '').trim();
    };
    let t = pick('meta[property="og:title"]') || pick('meta[name="twitter:title"]');
    if (t) t = t.replace(/\s*[-|–—]\s*(Nature|Science|Reuters|BBC News|The Guardian|Financial Times|The Economist)\s*$/i, '');
    return t;
  }

  /* ---------- 文章标题 ----------
   * ★ 原实现只有一句 `document.querySelector('h1')`，实测到处踩空：
   *   · Nature 首页：h1 是空的（<h1 class="..."><span></span></h1>）→ 退化成 "Nature"
   *   · Science / Economist 被风控挡在 "请稍候…" 页，h1 是 "www.science.org"
   *   · BBC 文章：某些版式 h1 是错误提示语（"Try searching for it instead"）
   *   · Guardian 文章页甚至没有 h1
   * 所以改成多级兜底，并且**明确排除这些垃圾值**。 */
  /* ★ 垃圾标题黑名单：站点没给文章页而是挡在风控/错误页时，标题会变成这些。
   * 「请稍候…」是 Science / Economist 的风控页；BBC 某些版式给的是
   * "Try searching for it instead"。都要排除，否则仓库里会存下一堆垃圾标题。 */
  const JUNK_TITLE = new RegExp([
    'page not found', 'not found', '\\b404\\b', 'access denied', 'forbidden',
    '请稍候', 'just a moment', 'attention required', 'verify you are human',
    'checking your browser', 'loading', 'www\\.[a-z0-9.-]+',
    'try searching for it', 'untitled', '^home$', '^news$', '^首页$',
    'error', 'page unavailable', 'temporarily unavailable'
  ].join('|'), 'i');
  /* 纯站点名：既不是垃圾页，也不算文章标题 */
  const SITE_NAME_ONLY = /^(bbc news|bbc|cnn|reuters|news|home|首页|nature|science|the guardian|guardian|the economist|economist|financial times|wsj|new york times|nyt|ap news|reuters science|science news)$/i;
  let CURRENT_TITLE = '';
  function pickTitle() {
    const cands = [];

    /* ① 所有 h1 里挑"最像文章标题"的：非空、够长、不在导航/页眉页脚里 */
    for (const h of document.querySelectorAll('h1')) {
      const s = (h.innerText || h.textContent || '').trim().replace(/\s+/g, ' ');
      if (!s || s.length < 8) continue;
      if (JUNK_TITLE.test(s)) continue;
      cands.push({ s, score: s.length });
    }
    /* ② meta og:title / twitter:title（新闻站最可靠，ScienceMag/Nature 都有） */
    const mt = metaTitle();
    if (mt && !JUNK_TITLE.test(mt)) cands.push({ s: mt, score: mt.length + 30 });

    /* ③ document.title：去掉 " | 站点名" 后缀。
       ★ 去掉后缀后如果**只剩站点名**（"BBC News" / "Nature" 这种），
         说明这一页根本没有文章标题（错误页、风控页），要判为无效 ——
         否则收藏时会把 "BBC News" 当成文章名存进仓库。 */
    const dt = (document.title || '').trim().replace(/\s+/g, ' ');
    const head = dt.split(/[|–—]/)[0].trim();
    if (head && !JUNK_TITLE.test(head) && !SITE_NAME_ONLY.test(head))
      cands.push({ s: head, score: head.length + 10 });

    if (!cands.length) { CURRENT_TITLE = ''; return; }
    cands.sort((a, b) => b.score - a.score);
    CURRENT_TITLE = cands[0].s.slice(0, 80);
  }

  /* ---------- 生词本标记（所有词形都划线） ---------- */

  /* ★ 容器过滤。
     原来只有一条 `p.closest('nav, header, footer, aside')` 就把 header 整个毙了，
     可现代新闻站（Al Jazeera 实测）恰恰用 <header> 包文章 <h1>，
     于是标题里的词一个都划不上线（正文里的却正常，很容易被误判成"虚线坏了"）。

     现在按"这块区域是不是导航性文字"来判断：
       - nav / footer / aside 照旧整体排除：里面全是菜单、版权、推荐链接
       - header 不再一刀切：保留真正的文章标题与导语，只躲开导航条本身
       - 再补一层 class/id 关键词兜底，兼容五花八门的站方写法 */
  // 文章标题 / 导语：这些是真正该划线的地方
  const HEADINGISH = /^(H1|H2|H3|H4|H5|H6|P|FIGCAPTION|TD|TH|STRONG|EM|B|I|LI|DD|DT|SPAN|A)$/;

  /** 判断某个元素是否属于"导航性文字"（不该划线） */
  function isChrome (el) {
    if (!el) return true;
    // 整个标签排除：菜单区、页脚、侧栏
    if (el.closest('nav, footer, aside')) return true;
    // 关键词命中的容器：站名、社交按钮、面包屑等
    if (el.closest('[class*="nav" i], [id*="nav" i], [class*="menu" i], [id*="menu" i],' +
      '[class*="brand" i], [id*="brand" i], [class*="social" i], [id*="social" i],' +
      '[class*="logo" i], [id*="logo" i], [class*="breadcrumb" i], [class*="masthead" i],' +
      '[class*="topbar" i], [class*="toolbar" i], [class*="search" i], [class*="subscribe" i]')) {
      // 例外：正文容器名字里带这些词（如 article-nav、post-menu）不该误伤。
      // 判据是它自己是不是文章主体的一部分——标题元素永远放行。
      if (!HEADINGISH.test(el.tagName)) return true;
    }
    // header 里只有导航条才排除：标题(heading)、导语、时间戳类都放行
    if (el.closest('header')) {
      if (HEADINGISH.test(el.tagName)) return false;
      // 标题之外的元素，看它离 header 顶部有多近 —— 顶部通栏通常是站导航
      const hdr = el.closest('header');
      const hr = hdr.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.height && r.top < hr.top + 90) return true;
      // header 里链接密度极高 = 菜单栏
      const links = hdr.querySelectorAll('a').length;
      if (links >= 6 && !HEADINGISH.test(el.tagName)) return true;
    }
    return false;
  }

  function markBanked() {
    // 清掉旧标记
    document.querySelectorAll('.wk-banked').forEach((e) => {
      const w = e.textContent;
      e.replaceWith(document.createTextNode(w));
    });
    if (!bank.length) return;
    /* forms: 词形列表。额外维护 keyForms —— 重点词的所有词形集合，
       命中其中之一就打上 .wk-key，网页上显示为红色虚线。 */
    const forms = new Map();
    const keyForms = new Set();
    for (const b of bank) {
      const w = String(b.w || '').toLowerCase();
      if (!w) continue;
      if (!forms.has(w)) forms.set(w, []);
      forms.get(w).push(w);
      if (b.key) keyForms.add(w);
      if (b.lemma) {
        const l = b.lemma.toLowerCase();
        for (const f of inflect(l)) {
          if (!forms.get(w).includes(f)) forms.get(w).push(f);
          if (b.key) keyForms.add(f);
        }
      }
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        if (p.closest(UI_SEL + ', [contenteditable="true"]')) return NodeFilter.FILTER_REJECT;
        if (isChrome(p)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const targets = [];
    let n;
    while ((n = walker.nextNode())) targets.push(n);
    const WORD = wordRe();
    for (const node of targets) {
      const text = node.nodeValue;
      if (!hasWord(text)) continue;
      let m, last = 0, frag = null;
      WORD.lastIndex = 0;
      while ((m = WORD.exec(text))) {
        const raw = m[0];
        const low = raw.toLowerCase();
        let hit = forms.has(low);
        let isKey = keyForms.has(low);
        let markWord = raw;
        if (!hit && globalThis.Engine) {
          try {
            const lm = Engine.lemmatize(low, {});
            if (lm) {
              const lml = lm.toLowerCase();
              for (const [bw, list] of forms) {
                if (list.includes(lml) || bw === lml) {
                  hit = true;
                  // 词形命中时，重点判定按**该词条**走，不是按当前形态
                  isKey = keyForms.has(lml) || keyForms.has(bw);
                  markWord = raw;
                  break;
                }
              }
            }
          } catch (e) {}
        }
        if (!hit) continue;
        if (!frag) frag = document.createDocumentFragment();
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const s = document.createElement('span');
        s.className = 'wk-banked' + (isKey ? ' wk-key' : '');
        s.textContent = raw;
        s.title = isKey ? '重点词语：' + raw : '生词本：' + raw;
        frag.appendChild(s);
        last = m.index + raw.length;
      }
      if (frag) {
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
      }
    }
  }

  /** 生成一个词的常见变形（软件版同思路，这里只覆盖常见规则形态） */
  function inflect(lemma) {
    const out = [lemma];
    const l = lemma.toLowerCase();
    if (/[^aeiou]y$/.test(l)) out.push(l.slice(0, -1) + 'ies', l.slice(0, -1) + 'ied');
    if (/(s|x|z|ch|sh)$/.test(l)) out.push(l + 'es', l.replace(/([^s])$/, '$1ed'));
    else out.push(l + 's', l + 'ed');
    if (/e$/.test(l)) out.push(l.slice(0, -1) + 'ing', l + 'd');
    else out.push(l + 'ing');
    out.push(l + 'er', l + 'est', l + 'ly');
    return out;
  }

  /* ---------- 段落级：句子划分 ---------- */
  function splitSentences(text) {
    if (globalThis.Engine && typeof Engine.splitSentences === 'function') {
      try { return Engine.splitSentences(text); } catch (e) {}
    }
    return String(text || '').split(/(?<=[.!?。！？])\s+/).filter((s) => s.trim());
  }

  /* ---------- 事件：单击/双击/拖选 ---------- */

  /** 单词命中判定：命中框 + 一个很小的容差，且横向**不能**离谱 */
  const HIT_PAD_X = 3;    // 左右各放宽 3px，覆盖字形边缘与抗锯齿
  const HIT_PAD_Y = 2;    // 上下各放宽 2px
  const MAX_NEAR_DIST = 10; // 找"最近的词"时的最大距离（px）

  /* ★ 取词 token 正则（点词翻译精度修复 ①）。
     老写法 `[A-Za-z][A-Za-z'’-]*`（带 /g）的问题：`*` 允许词**以连字符或
     撇号结尾**，于是行末断词 "self-"（"self-driving" 被排版断成两行、
     或正文里本就写成 "self- "）会被当成一个完整的"词"拿去查，词典永远
     查不到，浮层就退化成在线翻译并原样回显 —— 看起来就像"识别到了别的词语"。
     新写法要求连字符/撇号**两侧都得有字母**，词边界与人类直觉一致：
       twenty-five-year-old ✓   don’t ✓   children’s ✓   self- ✗（只取 self）
     用函数每次返回新正则，避免 /g 的 lastIndex 在多次调用间残留。 */
  const WORD_SRC = "[A-Za-z]+(?:['’-][A-Za-z]+)*";
  const wordRe = () => new RegExp(WORD_SRC, 'g');
  const hasWord = (s) => /[A-Za-z]/.test(s || '');

  /** 取一个 Range 的**逐行片段**矩形（点词翻译精度修复 ②，本次核心）。
   *
   *  ★ 根因：Range.getBoundingClientRect() 对一个**跨行**的 Range 返回的是
   *    **所有行片段的并集**。实测（tools/probe-hitroot.js，窄栏 250px）：
   *      counter-revolutionary 跨 2 行 → 并集宽 222px，而它每行实际只有 64px
   *      long-standing          跨 2 行 → 并集宽 161px，而每行只有 34px
   *    旧代码把这个并集当命中框，且 clientY 判定用的是并集的 top~bottom
   *    （横跨两行），于是**同一行里它左边和右边的词全被它吃掉**：
   *      点 movement → 返回 counter-revolutionary
   *      点 was      → 返回 counter-revolutionary
   *      点 inter-government → 返回 long-standing
   *    这正是用户说的"有时会识别到别的词语"。
   *
   *  改用 getClientRects() 拿到**每一行的真实片段**，逐个片段比坐标：
   *     · 每个片段只覆盖一行，横向范围就是该行上这个词真正占的宽度
   *     · 纵向也只覆盖自己那一行，不会跨行误命中
   *     · 返回的 rect 是**片段**矩形，浮层定位也跟着更贴词
   *  （取不到片段时退回整体矩形，绝不返回空手而归的结果。） */
  function rangeFragments(range) {
    const out = [];
    let list = null;
    try { list = range.getClientRects(); } catch (e) { list = null; }
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r && (r.width || r.height)) out.push(r);
      }
    }
    if (!out.length) {
      try {
        const r = range.getBoundingClientRect();
        if (r && (r.width || r.height)) out.push(r);
      } catch (e) { /* 忽略 */ }
    }
    return out;
  }

  /** 在**一个文本节点**里按坐标取词（findWord / wordInRect 共用的唯一实现）。
   *
   *  判定顺序（越靠前越可信）：
   *    ① 精确命中：坐标落在某个**行片段**内 → 多个时取"离片段中心最近"的那个
   *    ② 近似命中：坐标在某片段的左右 MAX_NEAR_DIST 内（覆盖字形边缘/抗锯齿），
   *       取最近的
   *  ★ 精确命中一旦找到就**不**再被近似命中顶掉 —— 反过来才对。
   *  返回 { word, start, end, rect, exact, dist }，rect 是**行片段**矩形。 */
  function hitInTextNode(node, clientX, clientY) {
    if (!node || node.nodeType !== 3) return null;
    const text = node.nodeValue || '';
    if (!hasWord(text)) return null;

    const re = wordRe();
    let m, exact = null, near = null;
    while ((m = re.exec(text))) {
      const s = m.index, e = s + m[0].length;
      const r = document.createRange();
      try { r.setStart(node, s); r.setEnd(node, e); } catch (err) { continue; }
      const frags = rangeFragments(r);
      for (const fr of frags) {
        /* 纵向必须先落在**这一行片段**上，跨行的并集不会再来捣乱 */
        if (clientY < fr.top - HIT_PAD_Y || clientY > fr.bottom + HIT_PAD_Y) continue;

        const inside = clientX >= fr.left - HIT_PAD_X && clientX <= fr.right + HIT_PAD_X;
        if (inside) {
          /* 取"离片段中心最近"的：字形有连笔/负字距时，两个词的框可能轻微重叠，
             按中心距离择优比"文档顺序先到先得"更符合眼睛看到的那个词。 */
          const dcx = clientX - (fr.left + fr.right) / 2;
          const dcy = clientY - (fr.top + fr.bottom) / 2;
          const d = Math.sqrt(dcx * dcx + dcy * dcy);
          if (!exact || d < exact.d) {
            exact = { word: m[0], start: s, end: e, rect: fr, exact: true, d };
          }
          continue;
        }

        const dist = clientX < fr.left ? fr.left - clientX : clientX - fr.right;
        if (dist <= MAX_NEAR_DIST && (!near || dist < near.dist || (dist === near.dist && fr.height < near.rect.height))) {
          near = { word: m[0], start: s, end: e, rect: fr, exact: false, dist };
        }
      }
    }
    return exact || near;
  }

  /** 统一出口：把节点级命中整理成 findWord 要的形状（丢掉内部评分字段） */
  function hitOf(node, clientX, clientY) {
    const h = hitInTextNode(node, clientX, clientY);
    return h ? { word: h.word, rect: h.rect, exact: h.exact } : null;
  }

  /** 在点击位置找单词。
   *
   *  精度优先的顺序（点词翻译精度修复 ③，2024 版排序，与老代码相反）：
   *    ① 文本节点上直接点 → 在该节点里逐**行片段**取词（最准）
   *    ② 其它情况 → 先问 browser caretRangeFromPoint（浏览器排版引擎的
   *       权威命中，跨行/连字符都对），且**只接受精确命中**
   *    ③ 再退回"以被点元素为根、逐文本节点扫描 + 全场择优"
   *  ★ 老代码把 caretRangeFromPoint 放在**最后**当兜底，而把
   *    getBoundingClientRect() 并集矩形放在最前，顺序刚好反了 ——
   *    这正是"识别到别的词语"的根因。 */
  function findWord(target, clientX, clientY) {
    if (!target) return null;
    const p = target.parentElement || target;
    if (!p) return null;
    /* 被点元素自己也要判一次。用 parentElement 判有个盲区：
       点在 <button> 上时 p 是它的**容器**，容器本身不是 button，
       closest('button') 就落空了 —— 「Auto」按钮正是这样被当成正文单词的。 */
    const self = target.nodeType === 1 ? target : target.parentElement;
    if (self && self.closest(UI_SEL)) return null;
    if (p.closest(UI_SEL)) return null;

    /* ★ 这里原来一刀切排除了 'nav, header, footer, aside, button, a,
       input, textarea, select, code, pre'，在很多网站上导致点词**完全失灵**。
       实测（tools/test-real-click.js）：
         · BBC 文章正文整段被 <a> 包着（祖先链 p < div < … < a < …），
           命中 a 的判据直接 return null —— 单击毫无反应。
         · Nature / Science 等站正文常在 <a> 链接、<code>、<pre> 附近的富文本里，
           一律被当成"不该查词"跳过。
       真正该跳过的只有**交互控件**（点它们有原生行为）和**表单输入**；
       'a' / 'code' / 'pre' 是内容容器，不该拦。下面按角色分流：
         · 控件类 → 一律不查（点了要留给原生行为）
         · 结构类（nav/header/aside/footer）→ 只在**没有正文**时跳过，
           即被点元素自身很短（导航项就是几个词）才认作导航。 */
    const CTRL = 'button, input, textarea, select, option, label, summary, video, audio, canvas, svg';
    if (self && self.closest(CTRL)) return null;
    if (p.closest(CTRL)) return null;

    const STRUCT = 'nav, aside, header, footer';
    if (p.closest(STRUCT)) {
      /* 结构区里也可能有大段正文（如 Nature 的 <header> 内嵌摘要）。
         判据：点到的词够长、且所在块文字明显是成句的，就当正文处理。 */
      const own = (p.innerText || '').trim();
      const host = p.closest(STRUCT);
      const hostLen = (host.innerText || '').trim().length;
      if (own.length < 40 && hostLen < 600) return null;   // 短词 + 小容器 = 导航
    }

    /* ★ 命中必须落在词自己的盒子里。
       之前 wordAt() 只按字符偏移判断，完全不看点击坐标落在行的哪一段，
       于是点在段落右侧空白（同一行末尾之后）也会被算成该行最后一个词。
       所以先要求坐标落在词的 client rect 内，再谈偏移。 */
    if (target.nodeType === 3) {
      const w = wordInRect(target, clientX, clientY);
      if (w) return w;
    }
    if (target.classList && target.classList.contains('wk-banked')) {
      /* ★ 已入库词也用 Range 量出词自己的精确矩形（与下方普通词同一条路），
         保证"标记为重点/取消重点"按钮的浮层精确贴在词上方。
         textContent 就是那个单词本身；兜底用 span 元素盒子（同大小）。 */
      const txt = (target.textContent || '').trim();
      if (txt) {
        const re = new RegExp(WORD_SRC);
        const m = re.exec(txt);
        const wordOnly = m ? m[0] : txt;
        const r = document.createRange();
        try {
          const tn = target.firstChild && target.firstChild.nodeType === 3 ? target.firstChild : target;
          r.selectNodeContents(tn);
          const wr = r.getBoundingClientRect();
          if (wr.width || wr.height) return { word: wordOnly, rect: wr };
        } catch (err) { /* 落到下面 fallback */ }
        return { word: wordOnly, rect: target.getBoundingClientRect() };
      }
      return { word: target.textContent };
    }

    /* ★ 精度修复第一步：优先问浏览器自己"光标落在哪个字符之间"。
       caretRangeFromPoint 是浏览器排版引擎的命中结果，跨行词、连字符、
       RTL、复杂 shaping 都由它正确处理，比我们逐词量矩形更权威，也更快。
       只接受**精确命中**（坐标真的落在那一行片段里）：返回来的 caret offset
       常常落在词尾之后（点空白处时尤其如此），那种情况必须判为"没点中"，
       否则又会回到"点空白弹出最后一个词"的老毛病。 */
    if (document.caretRangeFromPoint && target.nodeType !== 3) {
      let cr = null;
      try { cr = document.caretRangeFromPoint(clientX, clientY); } catch (err) { cr = null; }
      const cn = cr && cr.startContainer;
      if (cn && cn.nodeType === 3 && (cn.parentElement === null ||
          !cn.parentElement.closest(UI_SEL))) {
        const h = hitInTextNode(cn, clientX, clientY);
        if (h && h.exact) return { word: h.word, rect: h.rect, exact: true };
      }
    }

    /* 点在元素（<p>/<span>）上而不是文本节点上时，用 Range 取每个词的**真实**
       client rect 逐个比对。不能用「字符序号 / 全文长度 × 整段宽度」线性插值，
       文本换行后会全错位。

       ★ 精度修复第二步：命中判定全部交给 hitInTextNode（逐**行片段**比对）。
         旧代码用 getBoundingClientRect() 的**并集**当命中框，跨行词会把
         它左右两侧同行的词一起吃掉（实测点 movement 取回
         counter-revolutionary、点 inter-government 取回 long-standing）。
       这里仍是"逐文本节点扫描 + 全场择优"，但每个词只在它**真正占的
       那一行片段**上参与竞争。 */
    let best = null;                 // 全场最优（精确优先，其次近似最近）
    const el = (target.nodeType === 1 ? target : target.parentElement);
    if (el) {
      const tn = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tn.nextNode())) {
        const par = n.parentElement;
        if (!par || par.closest(UI_SEL)) continue;
        if (!hasWord(n.nodeValue)) continue;
        const h = hitInTextNode(n, clientX, clientY);
        if (!h) continue;
        /* 排序准则：
             ① 精确命中永远胜过近似命中（exact=true 优先）
             ② 同为精确 → 离片段中心更近者胜
             ③ 同为近似 → 横向距离更近者胜 */

        if (!best) { best = h; continue; }
        if (h.exact !== best.exact) { if (h.exact) best = h; continue; }
        if (h.exact) { if (h.d < best.d) best = h; }
        else if (h.dist < best.dist) best = h;
      }
    }
    /* ★ 命中就**把词自己的行片段矩形一起返回**。
       浮层定位要用它 —— 以前只返回 { word }，调用方只好退回
       anchorEl.getBoundingClientRect()，而 anchorEl 是被点的
       <p>（整个段落！），于是释义框贴着**段落顶边**而不是词，
       段落越长偏得越远，"显示在单词上方"根本看不出效果。 */
    if (best) return { word: best.word, rect: best.rect, exact: best.exact };

    return null;
  }

  /** 只在坐标真正落在某个词的行片段内时，才用字符偏移确定是哪个词 */
  function wordInRect(node, clientX, clientY) {
    return hitOf(node, clientX, clientY);
  }

  /* ---------- 链接跳转：智能识别 ----------
     目标：**单独的文章条目**（标题、卡片、导航、列表、侧栏）点哪儿都能进；
           **正文句子里由词组构成的超链接**只查词，不带走页面。
     ★ 判据是「链接有没有和别的文字同处一条行内流」——
       不是比长度，而是看链接所在的行内流里、链接之外还有没有字母。
       旧版拿"整块文字长度 ÷ 链接文字长度"做比值，只要对方比它长就算正文链接，
       于是三类结构必然判错（20 条真实结构用例实测错 3 条）：
         · 正文里一个很长的词组链接，周围那句比它还短
           → 误判成文章条目，一点就跳走（该查词却跳）
         · 卡片"分类标签 + 大标题"，标签只有几个字母
           → 标签成了"上下文"，整条标题被拦住跳不动
         · 不带 h 标签的卡片标题（<div class=card><a>标题</a><p>摘要</p></div>）
           → 摘要成了"上下文"，标题被拦住跳不动
       换成行内流判据后，摘要、标签这些**另起一块**的兄弟不再被算进上下文，
       三种结构全部判对，且不依赖对方的长短。
     判定顺序：
       ① nav/header/footer/aside/[role=navigation|banner|contentinfo|complementary] → 导航（可点）
       ② 链接在 h1~h6 里，或链接内含 h1~h6 → 标题（可点）
       ③ 链接自身是块级（block/flex/grid/table/list-item） → 独占一块（可点）
       ④ 链接内含图片/视频/div 等块状内容（卡片、缩略图） → 文章条目（可点）
       ⑤ 同一行内流里、链接之外的字母 >= 3 个 → 夹在句子里（词组链接，默认不跳）
          例外：链接自己很长（>= 40 字母）而周围只有它的一小半
                → 那是"分类标签 + 大标题"的卡片结构，按文章条目处理
       ⑥ 其余（"Read more"、纯标题、带时间的标题、列表条目） → 文章条目（可点）
     ★ 判错的兜底：按住 Alt 点一定跳转；设置里也能切成「全部阻止 / 全部允许」。 */
  function linkNavMode() {
    const v = prefs.linkNav;
    if (v === 'allow' || v === true) return 'allow';
    if (v === 'block') return 'block';
    return 'smart';                       // 'smart' / false / undefined
  }

  /* 链接所在的那条「行内文字流」里，除它自己以外还有多少字母。
     做法：先找到最近的块级祖先 —— 它才是行内流的容器；再只统计这个容器里
     **行内级**兄弟的文字。块级兄弟（卡片里另起一段的摘要 <p>）属于另一块，
     不算"链接被句子包着"，否则卡片标题会因为它下面有摘要而被当成正文链接。 */
  function inlineFlowLetters(a) {
    let box = a.parentElement;
    while (box && box !== document.body && box !== document.documentElement) {
      let d = '';
      try { d = getComputedStyle(box).display; } catch (e) { d = ''; }
      /* 只有 inline / contents / ruby 还能继续往上找，其余都已经是块级容器 */
      if (d !== 'inline' && d !== 'contents' && d !== 'ruby') break;
      box = box.parentElement;
    }
    if (!box) return 0;

    let txt = '';
    for (const c of Array.from(box.childNodes)) {
      if (c.nodeType === 3) { txt += c.nodeValue || ''; continue; }
      if (c.nodeType !== 1) continue;
      if (c === a || c.contains(a)) continue;          // 链接自己（含包着它的行内元素）
      let d = '';
      try { d = getComputedStyle(c).display; } catch (e) { d = ''; }
      if (d === 'none') continue;
      if (d !== 'inline' && d !== 'contents' && d.indexOf('inline') !== 0) continue;  // 块级兄弟属于另一块
      txt += c.textContent || '';
    }
    return txt.replace(/[^\p{L}]/gu, '').length;
  }

  function classifyLink(a) {
    if (!a) return 'content';
    try {
      if (a.closest('nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"]')) return 'nav';
      if (a.closest('h1,h2,h3,h4,h5,h6') || a.querySelector('h1,h2,h3,h4,h5,h6')) return 'title';

      const disp = getComputedStyle(a).display;
      if (disp === 'block' || disp === 'flex' || disp === 'grid' ||
          disp === 'table' || disp === 'list-item' || disp === 'flow-root') return 'block';

      if (a.querySelector('img,picture,video,svg,div,section,article,figure')) return 'block';

      const self = String(a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!self) return 'block';           // 纯图标/图片链接

      const selfLetters = self.replace(/[^\p{L}]/gu, '').length;
      const around = inlineFlowLetters(a);

      /* 被同一条行内流的文字包着 → 词组链接，只查词 */
      if (around >= 3) {
        /* 例外：链接本身很长、周围只有零星几个字母，那是"分类标签 + 大标题"的卡片，
           别把整条标题当成句中的词组拦下来。 */
        if (!(selfLetters >= 40 && around * 2 < selfLetters)) return 'content';
      }
      return 'block';
    } catch (e) { /* 取不到样式就按正文链接处理，宁可多拦一次 */ }
    return 'content';
  }

  document.addEventListener('click', (e) => {
    if (!prefs.on) return;
    if (e.target.closest && e.target.closest(UI_SEL)) return;

    /* ★ 选区判定必须区分"双击选词"和"拖选词组/句子"。
       双击时浏览器会自动选中那个单词（选区非空），早期版本一律 return，
       于是连"加入生词本"都没反应。
       判据：选区里**不含空格且只有一个词** → 那是双击选词，属于入库手势。 */
    const sel = window.getSelection();
    const selTxt = sel ? String(sel).trim() : '';
    const selIsSingleWord = selTxt && !/\s/.test(selTxt) && new RegExp('^(?:' + WORD_SRC + ')$').test(selTxt);

    /* 拖选选中了多个词或整句 → 交给 mouseup 翻译，这里不弹词义 */
    if (selTxt && !selIsSingleWord) return;

    const hit = findWord(e.target, e.clientX, e.clientY);
    if (!hit) {
      /* ★ 点在空白处：把上一个浮层收掉。
         否则上一个词的释义会一直挂在屏幕上，
         用户点别处它也不消失，看起来就像"点空白也弹出了这个词"。 */
      closePop();
      return;
    }

    /* ★ 链接里的单词：默认「查词优先」，但只拦**正文里的内联链接**；
       标题、导航、卡片这类链接照常跳转（见 classifyLink）。
         · 需要拦 → preventDefault + stopPropagation，然后继续弹释义
         · 不拦   → 直接 return，让浏览器完成跳转，不再弹一个马上消失的浮层
         · Alt+点击 → 永远不拦（强制跳转的逃生通道） */
    const inLink = e.target.closest ? e.target.closest('a[href]') : null;
    if (inLink && !e.altKey) {
      const mode = linkNavMode();
      const kind = classifyLink(inLink);
      const block = mode === 'block' || (mode === 'smart' && kind === 'content');
      if (block) {
        e.preventDefault();
        e.stopPropagation();
      } else {
        return;
      }
    }

    /* ★ 单击**立即**弹释义，不再等 320ms 定时器。
       旧逻辑为了"区分单击/双击"把单击延迟 320ms 才弹窗，
       导致点单词感觉迟钝、不灵敏。现在单击直接出释义，
       "加入生词本"改由浏览器原生的 dblclick 事件触发（见下方监听器），
       两者互不干扰，且双击的浏览器选区已在 dblclick 里统一处理。 */
    const word = hit.word;
    /* e 是事件对象，派发完属性会被回收；锚点元素必须此刻取出 */
    const anchor = e.target;
    /* 词自己的矩形：float 布局/页面滚动后不失效，取不到就退回元素矩形 */
    const wordRect = hit.rect ? (hit.rect.left || hit.rect.top
      ? hit.rect
      : hit.rect.toJSON ? hit.rect.toJSON() : null) : null;

    closePop();                              // 先收掉可能挡住视线的旧浮层
    showDefinition(word, anchor, wordRect);  // ★ 即时显示，零等待
  }, true);

  /* ★ 双击 = 加入生词本（与单击释义解耦，不再用 320ms 定时器区分）。
     浏览器双击会自动选中该词，这里取命中词即可；
     若命中不到则退化为选区文本，保证两种来源都能入库。 */
  document.addEventListener('dblclick', (e) => {
    if (!prefs.on) return;
    if (e.target.closest && e.target.closest(UI_SEL)) return;
    const hit = findWord(e.target, e.clientX, e.clientY);
    const word = (hit && hit.word) ? hit.word : (() => {
      const s = window.getSelection();
      const t = s ? String(s).trim() : '';
      return (t && !/\s/.test(t) && new RegExp('^(?:' + WORD_SRC + ')$').test(t)) ? t : null;
    })();
    if (!word) return;          // 不是单英文词的双击 → 交给 mouseup 翻译
    addToBank(word);
    try { const s = getSelection(); if (s && !s.isCollapsed) s.removeAllRanges(); } catch (err) {}
  }, true);

  /* ---------- 拖选翻译：由"选中的内容"决定是词组还是句子 ----------
     ★ 判据只能是**选中的文本本身**，不能是点击次数。
       插入点已废弃三击，两种翻译都是"按住鼠标拖选一段再松开"，
       所以 mouseup 的 detail 两种情况下都等于 1，拿它分类必然全是词组。
       规则：选中内容以句末标点收尾、或明显的多词从句（词数多且无句末标点
       但有逗号/连词结构）→ 整句；其余（几个词的短语、术语）→ 词组。 */
  function classifySelection(txt) {
    const s = String(txt || '').trim();
    if (!s) return 'phrase';
    const wordCount = s.split(/\s+/).length;
    /* 以句末标点收尾（允许后面跟右引号/右括号） → 整句 */
    if (/[.!?。！？…]["'”’)\]）】」』]?$/.test(s)) return 'sentence';
    /* 词很多（>=12）基本只能是句子，不管末尾有没有标点（可能是被截断的整句） */
    if (wordCount >= 12) return 'sentence';
    /* 中等长度但含分句结构（逗号/分号/破折号 + 从属连词） → 整句 */
    if (wordCount >= 7 && /[,;:—-]/.test(s) && /\b(that|which|who|whom|whose|when|while|because|although|though|if|as|and|but|or|so)\b/i.test(s)) {
      return 'sentence';
    }
    return 'phrase';
  }

  document.addEventListener('mouseup', (e) => {
    if (!prefs.on || e.button !== 0) return;
    /* ★ 点在浮层或浮钮上（收藏、复制、切开关）不是"拖选结束"。
       点按钮时浏览器不会清掉原来的选区，mouseup 照样冒泡到 document，
       于是 30ms 后又按"选区变了"重新翻译一遍 —— 浮层被整块重建，
       刚出现的「✓ 已保存 / 该内容已收藏过」一闪就被冲掉。
       这里直接把自家 UI 上的 mouseup 排除掉。 */
    if (e.target && e.target.closest &&
        e.target.closest(UI_SEL)) return;
    // 延迟到 selection 稳定
    setTimeout(() => {
      const sel = window.getSelection();
      const txt = sel ? String(sel).trim() : '';
      if (!txt) return;
      if (!/[A-Za-z]/.test(txt)) return;
      /* ★ 双击选词时选区正好是「一个单词」（内部无空格），
         那是"入生词本"的手势，不是翻译手势。
         早期版本这里没排除，导致双击同时触发 addToBank 和翻译浮层，
         两个浮层互相顶掉，看起来就是"双击没反应"。 */
      if (!/\s/.test(txt)) return;
      /* ★★ 这里原来写的是 `const multi = txt.length > 1`，再传 `multi ? 'phrase' : 'sentence'`。
         可是能走到这一行的选区**必定含空格**，长度必然 > 1，multi 恒为 true——
         于是 'sentence' 是永远执行不到的死代码，「句子翻译」这个标题
         **从来没出现过**：拖选一整句，浮层标题也写着"词组翻译"。
         现在判据改成选中文本自身的特征（见 classifySelection）。 */
      const kind = classifySelection(txt);
      let rect;
      try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (err) { return; }
      if (!rect || (!rect.width && !rect.height)) return;
      showTranslation(txt, { getBoundingClientRect: () => rect }, kind);
    }, 30);
  });

  /* ---------- 右下角工具坞 ----------
     四个按钮不再各自 fixed 在右下角（那样要靠手写 right 值对齐，还互相抢注意力），
     而是统一塞进一个胶囊容器，顺序与间距由 CSS 管。
     容器用 id 取，按钮仍保留原来的 id / class —— 其它地方（比如 mouseup 守卫）不必跟着改。 */
  function ensureDock() {
    let d = document.getElementById('wk-dock');
    if (!d) {
      d = document.createElement('div');
      d.id = 'wk-dock';
      d.className = 'wk-dock';
      (document.body || document.documentElement).appendChild(d);
    }
    return d;
  }

  /* 图标用内联 SVG：比 ☆ / 🔗 这类字符在不同系统上的字形稳定得多
     （emoji 会带彩色，字符星号在部分字体里粗细不一）。颜色一律 currentColor。 */
  const ICON_STAR = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M12 3.6l2.62 5.31 5.86.85-4.24 4.13 1 5.84L12 17.1l-5.24 2.75 1-5.84L3.52 9.76l5.86-.85z" ' +
    'fill="currentColor" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  const ICON_LINK = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" ' +
    'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M10 13.5a4.5 4.5 0 0 0 6.4 0l2.6-2.6a4.5 4.5 0 0 0-6.4-6.4L11.4 5.7"/>' +
    '<path d="M14 10.5a4.5 4.5 0 0 0-6.4 0l-2.6 2.6a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/></svg>';

  /* ---------- 右下角浮动按钮：总开关 ---------- */
  /** 把总开关按钮的外观同步成当前状态。
   *  ★ 原来 mountFab 里写的是 `b.title = t('off')`（无条件赋值），
   *    于是无论功能开着还是关着，悬停提示永远都是「已关闭（在插件图标里可开启）」——
   *    开着的时候也这么说，和真实状态相反，纯属误导。
   *    改成按 prefs.on 取对应文案，并在**每次状态变化**时都调用，
   *    包括从侧边栏改开关的情况（那条路径以前因为 mountFab 已存在而直接 return，
   *    按钮外观压根不更新）。 */
  function syncFab() {
    const b = document.getElementById('wk-fab');
    if (!b) return;
    const on = !!prefs.on;
    b.classList.toggle('wk-off', !on);
    /* 文案跟着语言走：on/off 两条提示都在 i18n 里 */
    b.title = on ? t('onTip') : t('off');
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function mountFab() {
    if (document.getElementById('wk-fab')) { syncFab(); return; }
    const b = document.createElement('button');
    b.id = 'wk-fab';
    b.className = 'wk-fab';
    /* 按钮上的字母：按用户要求由「WK」改为「R」。
       38px 的圆里放单个字母比放两个更居中，也更不挡视线。 */
    b.textContent = 'R';
    b.onclick = (e) => {
      e.stopPropagation();
      prefs.on = !prefs.on;
      savePrefs();
      document.documentElement.classList.toggle('wk-off', !prefs.on);
      syncFab();
      toast(prefs.on ? t('onToast') : t('off'));
    };
    ensureDock().appendChild(b);
    document.documentElement.classList.toggle('wk-off', !prefs.on);
    syncFab();
  }

  /* ---------- 链接跳转开关（R 左边的小圆钮） ----------
     三档循环：智（智能，默认）→ ⊘（全部阻止）→ ↗（全部允许）→ 智。
     与设置页里的「链接跳转」是同一个 prefs.linkNav，改哪边都同步。 */
  function syncNavFab() {
    const b = document.getElementById('wk-nav-fab');
    if (!b) return;
    const mode = linkNavMode();
    /* 三档里只有"智能"需要文字，其余用符号（⊘ / ↗ 是国际通用字形，不用翻译）。
       "智能"这一档的文字跟着界面语言走：中文「智」，英文「Auto」。
       文字变长时加 wk-nav-word，由 CSS 收到 9px，免得 4 个字母把 30px 的方块撑破。 */
    const label = mode === 'allow' ? '↗' : (mode === 'block' ? '⊘' : t('navSmartBadge'));
    b.textContent = label;
    b.classList.toggle('wk-nav-word', label.length > 1);
    b.classList.toggle('wk-nav-on', mode === 'allow');
    b.classList.toggle('wk-nav-block', mode === 'block');
    b.title = mode === 'allow' ? t('navAllowed')
      : (mode === 'block' ? t('navBlocked') : t('navSmart'));
    b.setAttribute('aria-pressed', mode === 'allow' ? 'true' : 'false');
  }

  function mountNavFab() {
    if (document.getElementById('wk-nav-fab')) { syncNavFab(); return; }
    const b = document.createElement('button');
    b.id = 'wk-nav-fab';
    b.className = 'wk-nav-fab';
    b.onclick = (e) => {
      e.stopPropagation();
      const cur = linkNavMode();
      const next = cur === 'smart' ? 'block' : (cur === 'block' ? 'allow' : 'smart');
      prefs.linkNav = next;
      savePrefs();
      syncNavFab();
      toast(next === 'allow' ? t('navAllowedToast')
        : (next === 'block' ? t('navBlockedToast') : t('navSmartToast')));
    };
    ensureDock().appendChild(b);
    syncNavFab();
  }

  /* ---------- 段落收藏开关（☆ 浮钮） ----------
     悬停段落出现 ☆ 这件事，有人嫌它挡字、有人离不开，所以给个一键开关，
     不用每次都翻到侧栏设置里。与设置页的「悬停段落时显示 ☆」是同一个
     prefs.starOn，改哪边都同步。
     关掉时把已经冒出来的星标立刻收掉，不留残星。 */
  function syncStarFab() {
    const b = document.getElementById('wk-star-fab');
    if (!b) return;
    const on = prefs.starOn !== false;
    b.classList.toggle('wk-star-off', !on);
    b.title = on ? t('starOnTip') : t('starOffTip');
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function mountStarFab() {
    if (document.getElementById('wk-star-fab')) { syncStarFab(); return; }
    const b = document.createElement('button');
    b.id = 'wk-star-fab';
    b.className = 'wk-star-fab';
    b.innerHTML = ICON_STAR;
    b.onclick = (e) => {
      e.stopPropagation();
      prefs.starOn = prefs.starOn === false;   // 取反
      savePrefs();
      syncStarFab();
      if (prefs.starOn === false) closeOtherStars(null);
      toast(prefs.starOn === false ? t('starOffToast') : t('starOnToast'));
    };
    ensureDock().appendChild(b);
    syncStarFab();
  }

  /* ---------- 收藏当前网址（🔗 浮钮） ----------
     与 ☆ 收藏段落/句子并列的第三种收藏：把"正在看的这篇文章网址"
     整条存进仓库（kind='link'），方便以后回看。重复网址不入库。 */
  function isBookmarked(url) {
    return repo.some((r) => r.kind === 'link' && r.url === url);
  }

  // 段落/句子收藏去重：同一来源 + 同一正文（去空白后）视为已收藏
  function isFragmentSaved(text, kind) {
    const t = String(text || '').replace(/\s+/g, '');
    if (!t) return false;
    return repo.some((r) => r.kind === kind && String(r.text || '').replace(/\s+/g, '') === t);
  }

  async function addLinkBookmark() {
    const url = location.href;
    if (isBookmarked(url)) { toast(t('bookmarked')); return; }
    pickTitle();
    const item = {
      id: 'link-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      kind: 'link',
      url: url,
      title: (CURRENT_TITLE || document.title || '').trim(),
      source: location.hostname,
      text: url,
      blocks: null,
      comment: '',
      ts: Date.now()
    };
    repo.unshift(item);
    await saveRepo();
    // 同步给侧边栏/弹窗：把"当前网址 + 标题"写进存储，供它们一键收藏
    try { await store().set({ wk_current: { url: url, title: item.title } }); } catch (e) {}
    toast(t('addLink') + '：' + item.title);
  }

  /* 提示文案依赖语言，必须在**每次**同步时重取，而不是只在挂载时取一次
     —— 否则切到英文后，这个按钮的 tooltip 还停在中文。 */
  function syncLinkFab() {
    const b = document.getElementById('wk-link-fab');
    if (b) b.title = t('addLink');
  }

  function mountLinkFab() {
    if (document.getElementById('wk-link-fab')) { syncLinkFab(); return; }
    const b = document.createElement('button');
    b.id = 'wk-link-fab';
    b.className = 'wk-link-fab';
    b.innerHTML = ICON_LINK;
    b.onclick = (e) => { e.stopPropagation(); addLinkBookmark(); };
    ensureDock().appendChild(b);
    syncLinkFab();
  }

  /* ---------- toast ---------- */
  let toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'wk-toast';
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('wk-show');
    if (toastTimer) clearTimeout(toastTimer);
    /* 1.6s 读「该内容已收藏过 · 12」这种带数字的提示偏紧，统一给到 2.4s */
    toastTimer = setTimeout(() => toastEl.classList.remove('wk-show'), 2400);
  }

  /* ---------- 应用阅读偏好（字体/主题） ----------
     字号和行距已经不做接管了：字号现在调的是侧边栏界面（reader-sidebar.js），
     正文的排版交回站点自己，这里只剩「正文字体」一项可选。 */
  function applyPrefs() {
    const r = document.documentElement;
    const fam = {
      default: '', sans: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
      serif: 'Georgia,"Times New Roman",serif',
      mono: 'ui-monospace,Consolas,monospace',
      cjk: '"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif'
    }[prefs.fontFamily] || '';
    if (fam) r.style.setProperty('--wk-ff', fam); else r.style.removeProperty('--wk-ff');
    /* 默认字体档不能接管 —— --wk-ff 的初值是 inherit，硬压下去会把站点字体洗掉 */
    r.classList.toggle('wk-ff-custom', !!fam);
    r.setAttribute('data-wk-theme', prefs.theme);
    /* ★ 这里原来漏了总开关：wk-off 只在 mountFab 的点击回调里加。
       于是**从侧边栏切换总开关**时，浮层/星标/toast 的隐藏样式完全没跟着变 ——
       关了照样弹释义。这条补上，与按钮点击走同一套状态。 */
    r.classList.toggle('wk-off', !prefs.on);
    /* 总开关 / 星标开关 —— 任何一个关掉，都要把已出现的星标清干净，
       不然会留下"关了也不消失"的残星 */
    if (!prefs.on || prefs.starOn === false) closeOtherStars(null);
  }

  /* ---------- 给段落挂 ☆ ---------- */
  /* 找出正文容器，打上 data-wk-read —— 字号/行距/字体只在这个范围里生效。
     先按常见容器选择器找；找不到就按"哪个元素装的正文段落最多"来猜，
     这样没有 <article> 的站点也能用上阅读设置。 */
  function pickArticleRoot() {
    /* 明确是"一篇文章"的容器，命中即用 */
    const STRICT = 'article, .article, .article-body, .story-body, .post, .entry-content, .post-content';
    /* main / #content 这类太宽泛：首页、列表页也都有，
       直接接管会把推荐位、卡片的文字一起改掉。只有里面确实装着
       成篇正文（≥3 段长段落）时才认。 */
    const LOOSE = 'main, [role="main"], #maincontent, #main-content, #content';
    const longParas = (el) => {
      let n = 0;
      for (const p of el.querySelectorAll('p')) {
        if ((p.innerText || '').trim().length >= 60) n++;
      }
      return n;
    };
    /* "链接文字占整块文字的比例"——区分文章页和列表页最靠谱的一个信号。
       实测：BBC 首页 0.99（卡片标题几乎全是链接）、BBC 文章页 0.03、
       维基条目 0.39。列表页不该被阅读设置接管，否则整屏卡片字号被拉大。 */
    const linkRatio = (el) => {
      const total = (el.innerText || '').length;
      if (!total) return 1;
      let n = 0;
      for (const a of el.querySelectorAll('a')) n += (a.innerText || '').length;
      return n / total;
    };
    const isArticleish = (el) => el && longParas(el) >= 2 && linkRatio(el) <= 0.6;

    let known = null;
    /* 页面上常有多个 <article>（正文 + 一堆卡片），选"长段落最多"的那个，
       否则会把首页第一张卡片当成正文。 */
    try {
      let bestN = 0;
      for (const el of document.querySelectorAll(STRICT)) {
        const n = longParas(el);
        if (n > bestN) { bestN = n; known = el; }
      }
      if (bestN < 2 || !isArticleish(known)) known = null;
    } catch (e) { known = null; }
    if (!known) {
      try {
        const cand = document.querySelector(LOOSE);
        if (cand && longParas(cand) >= 3 && isArticleish(cand)) known = cand;
      } catch (e) { /* 选择器不支持就跳过 */ }
    }
    if (known) return known;

    const score = new Map();
    let long = 0;
    for (const p of document.querySelectorAll('p')) {
      if ((p.innerText || '').trim().length < 60) continue;
      long++;
      let el = p.parentElement, depth = 0;
      while (el && el !== document.body && depth < 6) {
        score.set(el, (score.get(el) || 0) + 1);
        el = el.parentElement;
        depth++;
      }
    }
    let best = null, bestN = 0;
    for (const [el, n] of score) if (n > bestN) { best = el; bestN = n; }
    /* 至少 3 段长正文才认为是文章，否则宁可不动（首页、列表页） */
    return (bestN >= 3 && long >= 3 && isArticleish(best)) ? best : null;
  }

  function decorateArticle() {
    const root = document.body;
    if (!root) return;
    // 取文章主体：优先常见容器，退回 body
    const picked = pickArticleRoot();
    /* 标记只在识别出真正的正文容器时打；退回 body 时不打，
       否则整页的 p/li（含导航）都会被阅读设置接管。 */
    if (picked) {
      for (const old of document.querySelectorAll('[data-wk-read]')) {
        if (old !== picked) old.removeAttribute('data-wk-read');
      }
      if (!picked.hasAttribute('data-wk-read')) picked.setAttribute('data-wk-read', '');
    }
    const art = picked || root;
    const blocks = art.querySelectorAll('p, blockquote, h1, h2, h3, li');
    let i = 0;
    for (const el of blocks) {
      if (el.__wkDone) continue;
      el.__wkDone = true;
      // 段落太短或含大量链接，跳过（多半是导航/推荐位）
      const txt = (el.innerText || '').trim();
      if (txt.length < 20) continue;
      /* ★ 链接数判据原来写死 >6，实测把 BBC 这类正文**整段挂在 <a> 里**的
       * 文章全跳过了 → 星标永远不出现。这里改成按"链接文字占整段的比例"判断：
       * 正文里夹一两个内联链接照常挂星标，只有链接几乎铺满整段（导航卡片、
       * 推荐位）才跳过。 */
      const links = el.querySelectorAll('a');
      if (links.length > 6) {
        const linkChars = [...links].reduce((n, a) => n + (a.innerText || '').trim().length, 0);
        if (linkChars > txt.length * 0.6) continue;   // 八成以上是链接 → 推荐位
      }
      attachStar(el, () => (el.innerText || '').trim(), 'para');
      i++;
    }
    /* ★ 原来写成 `if (i) pickTitle()`：只有"成功挂了至少一个星标"才取标题。
     * 于是像 Nature 首页这种段落大多落在导航/弹层里（一个都挂不上）的页面，
     * 标题永远是空的 —— 而标题恰恰是用户最容易看到、也最该显示的地方。
     * 标题与星标是两件独立的事，这里无条件取。 */
    pickTitle();
  }

  /* ---------- 监听设置变化 ---------- */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[KEY_PREFS]) {
      prefs = Object.assign(prefs, changes[KEY_PREFS].newValue || {});
      applyPrefs();
      mountFab();
      /* 侧栏设置页改「链接跳转」/「段落星标」/「界面语言」时，工具坞里的按钮要跟着变 */
      mountNavFab();
      mountStarFab();
      mountLinkFab();
    }
    if (changes[KEY_BANK]) { bank = changes[KEY_BANK].newValue || []; markBanked(); }
    if (changes[KEY_REPO]) repo = changes[KEY_REPO].newValue || [];
  });

  /* ---------- 启动 ---------- */
  (async function init() {
    await loadAll();
    /* 把当前偏好落盘一次：这样侧边栏/弹窗打开时读到的就是同一份状态，
       「开关」按钮也一定有对应的存储条目可改。 */
    await savePrefs();
    markInjected();
    applyPrefs();
    mountFab();
    mountNavFab();
    mountStarFab();
    mountLinkFab();
    decorateArticle();
    markBanked();
    // 把"当前网址 + 标题"写进存储，供侧边栏/弹窗一键收藏当前网址
    try { await store().set({ wk_current: { url: location.href, title: CURRENT_TITLE || document.title || '' } }); } catch (e) {}

    /* ★ SPA 正文是**异步渲染**的：页面 URL 从头到尾不变，但段落要过好几秒
       才由 React 挂上来。只在启动时装饰一次，这些段落就永远拿不到监听器
       —— 症状是"鼠标明明悬停在正文上，星标却不出现"
       （实测 hoverMatch=true 而段落未装饰）。
       所以监听 DOM 变化，冒出新的段落就补装饰。 */
    let pending = null;
    const schedule = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        decorateArticle();
        /* 新渲染出来的正文里，生词本里已有的词也要补上标记 */
        markBanked();
      }, 300);
    };
    try {
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* 极端情况下没有 body，忽略 */ }

    // SPA 路由变化后重新装饰
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        closePop();
        decorateArticle();
        markBanked();
        // 路由变化后刷新"当前网址"，让侧边栏/弹窗拿到新文章
        try { store().set({ wk_current: { url: location.href, title: CURRENT_TITLE || document.title || '' } }); } catch (e) {}
      }
    }, 1200);

    /* ---------- Cookie 同意横幅：自动接受 ----------
       外文新闻站几乎都会弹同意条（Al Jazeera 的深蓝条、CNN 的转圈、
       Guardian 的绿色条……），它会盖住正文开头，让划词查义完全没法用。
       这里按"文案 + 结构"识别，优先点同意按钮；点不到就隐藏容器。
       注意：只处理真正的同意弹层，绝不碰文章本身的内容。 */
    const COOKIE_TXT = /\b(cookie|cookies|consent|privacy settings|gdpr)\b/i;
    const ACCEPT_TXT = /^(accept( all)?|allow all|i agree|agree|accept all cookies|accept the use of cookies|got it|ok|okay|同意|接受|全部接受|允许所有|我同意|接受全部|知道了|同意并继续|accept and continue|continue)$/i;
    const REJECT_TXT = /^(reject|deny|decline|manage|manage preferences|设置|拒绝|拒绝全部|管理偏好|稍后|essential only|necessary only)$/i;
    const COOKIE_SEL = [
      '#onetrust-banner-sdk', '#onetrust-consent-sdk', '#CybotCookiebotDialog',
      '#usercentrics-root', '#didomi-host', '#didomi-popup', '.qc-cmp2-container',
      '.truste_box_overlay', '.gdpr-consent', '.cky-consent-container',
      '.cc-window', '.cookie-banner', '.cookie-consent', '#cookie-law-info-bar',
      '[class*="cookie-banner" i]', '[class*="cookieBanner" i]', '[id*="cookie" i][class*="banner" i]',
      '[class*="consent" i][class*="banner" i]', '[aria-label*="cookie" i][role="dialog"]'
    ].join(',');

    /** 判断某个元素是不是同意弹层 */
    function isCookieBox (el) {
      if (!el || !el.getBoundingClientRect) return false;
      // 已在视口外的（display:none）不处理
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      // 真正的弹层一般贴着视口底部或占据整屏
      const nearBottom = r.bottom > window.innerHeight - 40;
      const fullWidth = r.width > window.innerWidth * 0.6;
      const fullScreen = r.height > window.innerHeight * 0.5;
      if (!(nearBottom || fullScreen || (fullWidth && r.height > 90))) return false;
      // 文案里出现 cookie/consent 才认，避免误伤正文里的 "cookie policy" 链接
      const txt = (el.innerText || el.textContent || '').slice(0, 700);
      return COOKIE_TXT.test(txt);
    }

    /** 找到弹层里"同意类"的按钮（排除拒绝类） */
    function findAcceptBtn (box) {
      const cands = Array.from(box.querySelectorAll(
        'button, [role="button"], a[href], input[type="button"], input[type="submit"], [class*="btn" i], [class*="button" i]'
      )).slice(0, 80);
      for (const el of cands) {
        const txt = (el.innerText || el.value || el.textContent || '').trim();
        if (!txt || txt.length > 24) continue;
        if (REJECT_TXT.test(txt)) continue;       // 拒绝类绝不点
        if (ACCEPT_TXT.test(txt)) return el;
      }
      return null;
    }

    let cookieTries = 0;
    function handleCookie () {
      if (cookieTries > 12) return;      // 最多试 12 轮，别一直扫
      // 同样节流：MutationObserver 在动态站上触发极频繁
      const now = Date.now();
      if (now - handleCookie._t < 900) return;
      handleCookie._t = now;
      const seen = new Set();
      let boxes = [];
      try { boxes = Array.from(document.querySelectorAll(COOKIE_SEL)); } catch (e) { return }
      // 结构选择器没命中时，再按"底部大块 + cookie 文案"兜底扫一遍
      if (!boxes.length) {
        const all = Array.from(document.body.children || []);
        boxes = all.filter(isCookieBox);
      }
      for (const box of boxes) {
        if (!box || seen.has(box)) continue;
        seen.add(box);
        if (!isCookieBox(box)) continue;
        cookieTries++;
        const btn = findAcceptBtn(box);
        if (btn) {
          try { btn.click(); } catch (e) { /* 跨域 iframe 之类，点不到就算了 */ }
        } else {
          // 找不到同意按钮（常见于 iframe 里的弹层）→ 直接隐藏，别让它挡着正文
          try { box.style.display = 'none'; box.setAttribute('data-wk-cookie', 'hidden'); } catch (e) {}
        }
      }
    }

    // 前 30 秒里多扫几次：同意弹层常在正文之后才由脚本插进来
    for (const ms of [400, 1200, 2500, 4000, 6000, 9000, 13000, 18000, 24000]) {
      setTimeout(handleCookie, ms);
    }
    // 之后交给 MutationObserver 兜底（SPA 切页后可能又弹）
    try {
      new MutationObserver(() => {
        if (cookieTries > 12) return;
        handleCookie();
      }).observe(document.body, { childList: true, subtree: true });
    } catch (e) {}

    // 标签页遮罩类弹层（点空白处关不掉的）：一并尝试关闭
    try {
      const blockers = document.querySelectorAll('.qc-cmp-ui-content, .truste_box, #usercentrics-root');
      blockers.forEach((b) => { if (b && b.parentElement) b.parentElement.style.pointerEvents = 'none'; });
    } catch (e) {}

    /* ---------- 登录/订阅提示气泡 ----------
       不是法律弹层，但同样挡住正文阅读（Al Jazeera 的黑色 "signing in" 气泡、
       各种 "subscribe to continue"）。
       策略：只认「带关闭按钮 + 文案像推销」的浮层，优先点关闭；
       点不到就直接隐藏。比 cookie 判定更保守，避免误伤正文里的推荐位。 */
    const PITCH_TXT = /(sign in|signing in|log ?in|subscribe|subscription|create (an )?account|become a member|注册|登录|订阅|开通会员)/i;
    // 已压制过的气泡选择器（站点重建同类气泡时复用）
    killPitch.blocked = new Set();

    /* 定位推销气泡的可靠判据（实测 Al Jazeera 的完整结构得到）：
         <a class="tooltip tooltip--bottom-right" style="position:absolute; z-index:100">   ← 气泡本体
           <button id="user-accounts-tooltip" class="tooltip_text">                            ← 关闭键(×)
           …文案…
         </a>
       气泡本体挂在 .tooltip_container 里，而容器自己是 position:relative、无阴影、透明背景。

       ★ 前一版没生效的原因有两处，都已定位：
         ① "是不是浮层"用 position/shadow/背景色判断 → 容器三条全不中，被放过；
         ② 真正的气泡在容器**上面一层**，我却只在容器里**向下**找关闭键，方向反了。

       现在改成：从匹配文案的元素**向上**找定位祖先，那才是气泡本体；
       再在它内部找"空按钮"（× 通常无文字）点掉。找不到按钮才隐藏本体。 */
    function findPitchBubble (el) {
      if (!PITCH_TXT.test((el.innerText || '').slice(0, 300))) return null;
      /* ★ 这里原来从 el.parentElement 往上找定位祖先，漏掉了 el 自己。
         而 Al Jazeera 的气泡恰好是 <a class="tooltip" style="position:absolute">——
         **它自己的** position 就是 absolute，祖先链上的
         .tooltip_container 是 relative、header 是 relative，一路到 BODY 都不是
         absolute/fixed，于是永远找不到气泡，19 个文案命中的元素全部落空。
         必须先检查 el 自己。 */
      const self = getComputedStyle(el);
      if (self.position === 'absolute' || self.position === 'fixed') {
        if (elSizeOK(el)) return el;
      }
      let a = el.parentElement, bubble = null;
      while (a && a.tagName !== 'BODY') {
        const cs = getComputedStyle(a);
        if (cs.position === 'absolute' || cs.position === 'fixed') { bubble = a; break; }
        a = a.parentElement;
      }
      if (!bubble) return null;
      if (!PITCH_TXT.test((bubble.innerText || '').slice(0, 300))) return null;
      return elSizeOK(bubble) ? bubble : null;
    }

    /* 尺寸只用来"排除整页级容器"，不能用来判断"是否存在"——
       气泡用 clip/transform 定位时 getBoundingClientRect() 会返回 0×0，
       但它明明在屏幕上看得见（Al Jazeera 实测）。 */
    function elSizeOK (el) {
      const r = el.getBoundingClientRect();
      return !(r.width > window.innerWidth * 0.7 || r.height > window.innerHeight * 0.6);
    }

    /* ★ 这里原来还会点"空按钮"的关闭键，已删除 —— 那是个定时炸弹。

       对照实验（同一台机器、同一网络、同一 URL）：
         改动前：edition.cnn.com 20 秒加载完成，8389 字符，29 处标记
         改动后：dom-ready 每秒触发一次，40 秒内 46 次 —— 无限重载

       原因：killPitch 每 1.2 秒扫一遍，找到"文案含 subscribe/sign in
       且是 absolute/fixed 定位"的小容器后，就去点里面第一个**空按钮**。
       但页面上"文案含 subscribe"的定位元素多半是导航项，它的空按钮就是
       导航触发器 —— 一键就跳页，页面重载后我的代码又点一次，于是成环。

       隐藏浮层本身就够了，不点任何东西：
         · 不会误触导航/购买/登录等有副作用的控件
         · 不会触发重定向，也就绝不可能形成重载循环
       cookie 横幅那边保留"点接受"，因为那是用户明确要求的行为，
       且只点文案明确是 Accept 的按钮，判据严格，不涉及这种情况。 */
    function closeBubble (bubble) {
      const cls = (typeof bubble.className === 'string' ? bubble.className : '').trim();
      const sig = cls ? '.' + cls.split(/\s+/).slice(0, 2).join('.') : '';
      if (sig) {
        killPitch.blocked.add(sig);
        if (killPitch.blocked.size > 12) killPitch.blocked.clear();
        // 同一类气泡可能有多个，全部按下去
        for (const e of document.querySelectorAll(sig)) {
          if (!PITCH_TXT.test((e.innerText || '').slice(0, 300))) continue;
          if (!elSizeOK(e)) continue;
          try {
            e.style.setProperty('display', 'none', 'important');
            e.setAttribute('data-wk-pitch', 'hidden');
          } catch (err) {}
        }
      }
      try {
        bubble.style.setProperty('display', 'none', 'important');
        bubble.setAttribute('data-wk-pitch', 'hidden');
        return true;
      } catch (e) {}
      return false;
    }

    function killPitch () {
      // MutationObserver 每次 DOM 变动都会触发；节流到 2.5 秒一次。
      // （现在只做隐藏、不点按钮，风险比原先低，但扫描仍是全量的。）
      const now = Date.now();
      if (now - killPitch._t < 2500) return;
      killPitch._t = now;

      // 先把"记住"的同类气泡重新按下去（站点重建后属性标记会丢）
      for (const sig of killPitch.blocked) {
        for (const e of document.querySelectorAll(sig)) {
          if (!PITCH_TXT.test((e.innerText || '').slice(0, 300))) continue;
          if (!elSizeOK(e)) continue;         // 只排除整页级容器；0×0 的也要处理
          try { e.style.setProperty('display', 'none', 'important'); } catch (err) {}
        }
      }

      const all = document.querySelectorAll('div, aside, section, a, span');
      for (const el of all) {
        if (el.hasAttribute('data-wk-pitch') || el.hasAttribute('data-wk-cookie')) continue;
        if (el.children.length > 3) continue;      // 只从近叶子出发，避免重复处理
        const bubble = findPitchBubble(el);
        if (!bubble) continue;
        if (!closeBubble(bubble)) break;
      }
    }

    for (const ms of [2000, 5000, 9000, 15000, 22000]) setTimeout(killPitch, ms);
    try {
      new MutationObserver(() => killPitch())
        .observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
  })();
})();