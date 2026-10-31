'use strict';

/**
 * 外刊阅读 - 纯逻辑引擎
 *
 * 包含可在浏览器与 Node 中复用的纯函数：
 *   - 不规则动词表 + lemmatize() 词形还原（动词原形 / 名词单数）
 *   - splitSentences() 英文分句
 *   - tokenizeSentence() 句子分词（区分单词与非单词）
 *
 * 这些函数不依赖 DOM，便于单元测试。
 *
 * 说明：lemmatize 为基于规则的轻量还原，对绝大多数规则变化（名词复数、
 * 动词 -ing/-ed）有效；对极个别以 -ing 结尾的基础词（如 sing/bring）及
 * 不规则复数（如 children/women）会保留原形，属已知限制。
 */

(function (global) {
  // 常见不规则动词：过去式/过去分词 -> 原形
  const IRREGULAR_VERBS = {
    abode: 'abide', alit: 'alight', arose: 'arise', awoke: 'awake',
    was: 'be', were: 'be', been: 'be', am: 'be', is: 'be', are: 'be',
    bore: 'bear', became: 'become', befell: 'befall', began: 'begin',
    began: 'begin', bent: 'bend', beset: 'beset', bet: 'bet', bade: 'bid',
    bid: 'bid', bound: 'bind', bit: 'bite', bitten: 'bite', bled: 'bleed',
    blew: 'blow', blown: 'blow', broke: 'break', broken: 'break',
    bred: 'breed', brought: 'bring', broadcast: 'broadcast', built: 'build',
    burned: 'burn', burnt: 'burn', burst: 'burst', bought: 'buy',
    cast: 'cast', caught: 'catch', chose: 'choose', chosen: 'choose',
    crept: 'creep', crew: 'crow', crowed: 'crow', cut: 'cut', dealt: 'deal',
    dug: 'dig', dove: 'dive', dived: 'dive', did: 'do', done: 'do',
    drew: 'draw', drawn: 'draw', dreamt: 'dream', dreamed: 'dream',
    drank: 'drink', drunk: 'drink', drove: 'drive', driven: 'drive',
    dwelt: 'dwell', ate: 'eat', eaten: 'eat', fell: 'fall', fallen: 'fall',
    fed: 'feed', felt: 'feel', fought: 'fight', found: 'find', fled: 'flee',
    flung: 'fling', flew: 'fly', flown: 'fly', forbade: 'forbid',
    forbidden: 'forbid', forgot: 'forget', forgotten: 'forget',
    forsook: 'forsake', forsaken: 'forsake', froze: 'freeze',
    frozen: 'freeze', got: 'get', gotten: 'get', gave: 'give',
    given: 'give', went: 'go', gone: 'go', ground: 'grind', grew: 'grow',
    grown: 'grow', hung: 'hang', heard: 'hear', hewed: 'hew', hewn: 'hew',
    hid: 'hide', hidden: 'hide', hit: 'hit', held: 'hold', hurt: 'hurt',
    kept: 'keep', knelt: 'kneel', knew: 'know', known: 'know',
    laid: 'lay', lain: 'lie', led: 'lead', leapt: 'leap', leaped: 'leap',
    learnt: 'learn', learned: 'learn', left: 'leave', lent: 'lend',
    let: 'let', lay: 'lie', lied: 'lie', lost: 'lose', made: 'make',
    meant: 'mean', met: 'meet', paid: 'pay', put: 'put', read: 'read',
    rid: 'rid', rode: 'ride', ridden: 'ride', rang: 'ring', rung: 'ring',
    rose: 'rise', risen: 'rise', ran: 'run', said: 'say', saw: 'see',
    seen: 'see', sought: 'seek', sold: 'sell', sent: 'send', set: 'set',
    sewed: 'sew', sewn: 'sew', shook: 'shake', shaken: 'shake',
    shone: 'shine', shot: 'shoot', showed: 'show', shown: 'show',
    shrank: 'shrink', shrunk: 'shrink', shut: 'shut', sang: 'sing',
    sung: 'sing', sank: 'sink', sunk: 'sink', sat: 'sit', slept: 'sleep',
    slid: 'slide', slung: 'sling', slit: 'slit', smelt: 'smell',
    smelled: 'smell', smote: 'smite', smitten: 'smite', spoke: 'speak',
    spoken: 'speak', sped: 'speed', spelt: 'spell', spelled: 'spell',
    spent: 'spend', spilt: 'spill', spilled: 'spill', span: 'spin',
    spun: 'spin', spat: 'spit', split: 'split', spread: 'spread',
    sprang: 'spring', sprung: 'spring', stood: 'stand', stole: 'steal',
    stolen: 'steal', stuck: 'stick', stung: 'sting', strode: 'stride',
    stridden: 'stride', struck: 'strike', strung: 'string', strove: 'strive',
    striven: 'strive', swore: 'swear', sworn: 'swear', swam: 'swim',
    swum: 'swim', swung: 'swing', took: 'take', taken: 'take',
    taught: 'teach', tore: 'tear', torn: 'tear', told: 'tell',
    thought: 'think', threw: 'throw', thrown: 'throw', thrust: 'thrust',
    understood: 'understand', undid: 'undo', undone: 'undo', upset: 'upset',
    woke: 'wake', woken: 'wake', wore: 'wear', worn: 'wear', wove: 'weave',
    woven: 'weave', wept: 'weep', won: 'win', wound: 'wind',
    withdrew: 'withdraw', withdrawn: 'withdraw', withheld: 'withhold',
    withstood: 'withstand', wrote: 'write', written: 'write',
    wrung: 'wring', rose: 'rise'
  };

  function isVowel(c) { return c && 'aeiou'.indexOf(c.toLowerCase()) !== -1; }
  function isConsonant(c) { return c && !isVowel(c); }

  /**
   * 词形还原：返回动词原形 / 名词单数（小写）。
   * opts.dictSet 可选，传入词库单词集合（Set，小写），用于择优。
   */
  function lemmatize(word, opts) {
    opts = opts || {};
    const dict = opts.dictSet;
    if (!word) return word;
    const w = word.toLowerCase();

    if (IRREGULAR_VERBS[w]) return IRREGULAR_VERBS[w];

    const cands = []; // { word, tag }  tag: 'bare' | 'doubled' | 'edrop'

    // 名词复数 -> 单数
    // 注意：-es 与 -s 两条规则要同时产出候选（increases -> increase / increas），
    // 不能写成 else if，否则只剩 -es 那个，词库有 increase 时也选不中。
    if (w.endsWith('ies') && w.length > 4) cands.push({ word: w.slice(0, -3) + 'y', tag: 'bare' });
    if (w.endsWith('ses') || w.endsWith('xes') || w.endsWith('zes') || w.endsWith('ches') || w.endsWith('shes')) {
      cands.push({ word: w.slice(0, -2), tag: 'bare' });
    }
    if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) {
      cands.push({ word: w.slice(0, -1), tag: 'bare' });
    }

    // 动词：-ing / -ed
    if (w.endsWith('ing')) {
      const b = w.slice(0, -3);
      if (b.length >= 3) {
        cands.push({ word: b, tag: 'bare' });
        // 双写辅音：...元音 + 相同辅音（如 runn -> run, sitt -> sit, stopp -> stop）
        if (isConsonant(b[b.length - 1]) && b[b.length - 1] === b[b.length - 2] && isVowel(b[b.length - 3])) {
          cands.push({ word: b.slice(0, -1), tag: 'doubled' });
        }
        // 去 e：末「辅音 + 元音」即可能需要补 e（lik -> like, increas -> increase, us -> use）
        // 注意 abandon 结构上完全相同，靠上面「bare 优先 + 词库裁决」区分：
        // 词库有 abandon 就选裸干，没有才退到 abandone。
        if (b.length >= 2 && isConsonant(b[b.length - 1]) && isVowel(b[b.length - 2])) {
          cands.push({ word: b + 'e', tag: 'edrop' });
        }
        // 补 e（-yse/-yze 型）：analys -> analyse, catalyz -> catalyse
        // 特征：词干「倒数第二个字母是 y，且末尾是辅音」。
        // 用独立标签 keepE 且优先级垫底——只在 DICT_SET 里确有 analyse 时才选中，
        // 这样 abandoned 不会被过度补成 abandone。
        else if (b.length >= 3 && b[b.length - 2] === 'y' && !isVowel(b[b.length - 1])) {
          cands.push({ word: b + 'e', tag: 'keepE' });
        }
      }
    }
    if (w.endsWith('ed')) {
      const b = w.slice(0, -2);
      if (b.length >= 3) {
        cands.push({ word: b, tag: 'bare' });
        if (isConsonant(b[b.length - 1]) && b[b.length - 1] === b[b.length - 2] && isVowel(b[b.length - 3])) {
          cands.push({ word: b.slice(0, -1), tag: 'doubled' });
        }
      }
      // 去 e：末「辅音 + 元音」即可能需补 e（lik -> like, increas -> increase, us -> use）
      // abandon 的歧义由「带词库时 bare 优先」解决，理由同 -ing 分支
      if (b.length >= 2 && isConsonant(b[b.length - 1]) && isVowel(b[b.length - 2])) {
        cands.push({ word: b + 'e', tag: 'edrop' });
      }
      // 补 e（-yse/-yze 型）：analysed -> analyse、catalysed -> catalyse
      // 同上：严格限定「倒数第二个字母是 y」，keepE 垫底靠 DICT_SET 择优
      else if (b.length >= 3 && b[b.length - 2] === 'y' && !isVowel(b[b.length - 1])) {
        cands.push({ word: b + 'e', tag: 'keepE' });
      }
    }

    const valid = cands.filter((c) => c.word && c.word.length >= 2);
    if (valid.length === 0) return w;

    if (dict && dict instanceof Set) {
      // 带词库择优：bare 必须先试。
      // abandon 与 lik 形态完全相同（辅音+元音+辅音），唯一区分依据就是词库：
      // 词库里有 abandon 就选它，而不是补 e 造出 abandone。
      for (const tag of ['bare', 'doubled', 'edrop', 'keepE']) {
        const hit = valid.find((c) => c.tag === tag && dict.has(c.word));
        if (hit) return hit.word;
      }
    }
    // 无词库时：doubled > edrop > bare > keepE
    // 无词库无法判断 abandon / lik 这类同形词，此时按英语常见度取补 e 形式
    // （liked->like 比 liked->lik 更常见），keepE 垫底。
    for (const tag of ['doubled', 'edrop', 'bare', 'keepE']) {
      const hit = valid.find((c) => c.tag === tag);
      if (hit) return hit.word;
    }
    return valid[0].word;
  }

  /** 英文分句，返回句子数组（保留句末标点） */
  function splitSentences(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return [];
    const parts = trimmed.split(/(?<=[.!?])\s+/);
    return parts.map((s) => s.trim()).filter(Boolean);
  }

  /**
   * 将一句英文切分为 token 数组，区分单词与其他字符。
   * 单词 = 连续的英文字母（可含连字符，不含撇号，便于处理 don't 等缩写）。
   * 返回 [{type:'word', text}, {type:'other', text}, ...]
   */
  function tokenizeSentence(sentence) {
    const re = /([A-Za-z][A-Za-z]*)/g;
    const parts = [];
    let last = 0;
    let m;
    while ((m = re.exec(sentence)) !== null) {
      if (m.index > last) parts.push({ type: 'other', text: sentence.slice(last, m.index) });
      parts.push({ type: 'word', text: m[0] });
      last = m.index + m[0].length;
    }
    if (last < sentence.length) parts.push({ type: 'other', text: sentence.slice(last) });
    return parts;
  }

  const api = { IRREGULAR_VERBS, lemmatize, splitSentences, tokenizeSentence, isVowel, isConsonant };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Engine = api;
})(typeof window !== 'undefined' ? window : globalThis);
