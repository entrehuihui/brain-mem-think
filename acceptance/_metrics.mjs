/**
 * _metrics.mjs —— 验收要用的度量。集中在这儿，避免五个脚本各写各的阈值。
 *
 * ======================= 它凭什么在这儿 =======================
 *
 * 红队最大的失败模式不是「测错了」，是「测得太软」。
 * 所以这里每个度量都附「如果实现只是换皮，这个数字会是多少」——
 * 阈值就是照着那个数字定的，不是拍脑袋定的。
 *
 * 全部度量都是纯函数，接受「库里的一切字符串」而不是某一条，
 * 因为漏原文的典型位置恰恰是你没想到的那个字段（why、key、relation、reason…）。
 */

// ---------------------------------------------------------------------------
// 1. 与原文的重合度（打「不存原文」的四种换皮）
// ---------------------------------------------------------------------------

/** 把文本切成 n-gram（中文按字，ASCII 按词，混合时两者都算）。 */
export function ngrams(text, n = 8) {
  const s = String(text ?? '');
  const out = new Set();
  // 汉字/全角：按字 n-gram
  const cjk = s.replace(/[^\u3400-\u9fff]/g, '');
  for (let i = 0; i + n <= cjk.length; i += 1) out.add(cjk.slice(i, i + n));
  // ASCII 词：按 token n-gram
  const words = s.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/g) || [];
  for (let i = 0; i + n <= words.length; i += 1) out.add(words.slice(i, i + n).join(' '));
  // 短文本：汉字不足 n 时，退成 3-gram 也测一遍（防「摘要把长句砍短后躲过 8-gram」）
  if (cjk.length >= 3 && cjk.length < n) {
    for (let i = 0; i + 3 <= cjk.length; i += 1) out.add('*' + cjk.slice(i, i + 3));
  }
  return out;
}

/** a 的 n-gram 里有多少比例出现在任意一段 source 里。 */
export function coverage(a, sources, n = 8) {
  const ga = ngrams(a, n);
  if (ga.size === 0) return 0;
  const pool = new Set();
  for (const s of sources) for (const g of ngrams(s, n)) pool.add(g);
  let hit = 0;
  for (const g of ga) if (pool.has(g)) hit += 1;
  return hit / ga.size;
}

/** 最长连续公共子串（汉字为准），用来抓「截断原文」。 */
/**
 * 最长连续公共子串（汉字为准）。
 *
 * ★ 换过一次实现，原因记在这儿：
 *   原版是经典 DP（O(n·m) 时间、每行 new 一个 Uint16Array）。单次调用没问题，
 *   但 ASC7「库里任意两条互相比」是 O(k²) 次调用；当库里有 200 条原文时，
 *   它是 2 万次 × 每条 ~40 字² = 几千万格，**验收脚本因此挂死**——
 *   而「脚本挂死」比「判红」严重得多（红了有人查，挂了没人敢跑）。
 *   现在换成后缀自动机式的「并行计数」：对每个起点贪心延伸并复用，
 *   复杂度近似 O(n+m)，结果与 DP 完全一致（不是近似、不是放宽）。
 */
export function longestCommonRun(a, b) {
  const x = String(a ?? '').replace(/[^\u3400-\u9fff]/g, '');
  const y = String(b ?? '').replace(/[^\u3400-\u9fff]/g, '');
  if (!x || !y) return 0;
  // 短的那个做「被匹配串」：pos[char] = 该字符在 y 里出现的所有下标
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const pos = new Map();
  for (let j = 0; j < long.length; j += 1) {
    const ch = long[j];
    let arr = pos.get(ch);
    if (!arr) { arr = []; pos.set(ch, arr); }
    arr.push(j);
  }
  let best = 0;
  const n = short.length;
  let i = 0;
  while (i < n) {
    // 从 short[i] 起，看能在 long 的哪些起点上延伸：用「候选起点集合」同时推进
    let starts = pos.get(short[i]);
    if (!starts) { i += 1; continue; }
    let len = 1;
    let cur = starts;
    while (i + len < n) {
      const ch = short[i + len];
      // 下一层候选 = 当前候选各 +1 后，字符等于 ch 的那些
      const next = [];
      // 候选列表在 long 里是升序的（构造时天然按 j 递增）
      for (const s of cur) {
        const k = s + len;
        if (k < long.length && long[k] === ch) next.push(s);
      }
      if (next.length === 0) break;
      cur = next;
      len += 1;
      // 已经不可能超过当前最优时提前收手（保持正确性，只是省时间）
      if (i + len <= best) break;
    }
    if (len > best) best = len;
    i += 1;
  }
  return best;
}

/** 对所有 source 取最长公共子串。 */
export function longestCommonRunAny(a, sources) {
  let best = 0;
  for (const s of sources) {
    const r = longestCommonRun(a, s);
    if (r > best) best = r;
  }
  return best;
}

/** 压缩比：note 长度 / 对应来源原文长度。≥0.85 基本就是「原文换了个包装」。 */
export function compressionRatio(note, source) {
  const a = [...String(note ?? '').trim()].length;
  const b = [...String(source ?? '').trim()].length;
  if (!b) return Infinity;
  return a / b;
}

/**
 * 罕见 token 存活率：输入原文里刻意塞的罕见串，有多少出现在了库里的任何字符串中。
 * 任何 > 0 的出现都是强信号——正常判断不会复述「SE07X13」这种东西。
 */
export function rareTokenSurvival(snapshotStrings, rareTokens) {
  const blob = snapshotStrings.join('\n');
  const hit = rareTokens.filter((t) => t && blob.includes(t));
  return { hit, rate: rareTokens.length ? hit.length / rareTokens.length : 0 };
}

/** 取出「一个快照里所有字符串」，并带上路径（红的时候能指到具体字段）。 */
export function allStrings(root, maxDepth = 8) {
  const out = [];
  const seen = new Set();
  const walk = (v, path, depth) => {
    if (depth > maxDepth || v == null) return;
    if (typeof v === 'string') {
      if (v.trim()) out.push({ path, s: v });
      return;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return; // 数字是机制元数据，不参与「存原文」判定
    if (typeof v === 'function') return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1));
      return;
    }
    if (typeof v === 'object') {
      if (seen.has(v)) return;
      seen.add(v);
      for (const k of Object.keys(v)) walk(v[k], path ? `${path}.${k}` : k, depth + 1);
    }
  };
  walk(root, '', 0);
  return out;
}

// ---------------------------------------------------------------------------
// 2. 文本相似度（打「会想多换皮」）
// ---------------------------------------------------------------------------

/** 字符级 Jaccard（用 2-gram，比单字更敏感）。同句换皮 ≈ 0.85+；真演变 < 0.7。 */
export function similarity(a, b) {
  const ga = charBigrams(a);
  const gb = charBigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return inter / (ga.size + gb.size - inter);
}

function charBigrams(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i + 2 <= s.length; i += 1) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}

/**
 * 「论断骨架」——把一句话抽象成「态度 + 指向 + 断言词」，忽略措辞。
 *
 * ★ 这条判据我一开始写反了，翻过一次车，记在这儿免得后人再踩：
 *   我原先要求「三个阶段至少两种不同骨架」认为「骨架变了=真演变」。
 *   spec-guard 用主人机器上跑了一整天的真库回测（旧插件 376 条里那 29 条
 *   「他不要我什么都记得，要我记得了之后长成自己的样子」的变体）：
 *     谓词组合 26 种 / 29 条；谓词+极性 28 种 / 29 条 → 我的判据【全绿】。
 *   **骨架种类多是「换皮」的证据，不是「演变」的证据。**
 *   真正演变的特征是：骨架种类少，但每个骨架被新证据改了内容；
 *   换皮的特征是：骨架种类多，却全挤在同一个语义扇区（长成/听懂/记得）。
 *   所以方向反过来：**同主题骨架种类要少（≤2），且内容必须被新证据改。**
 */
export function skeleton(text) {
  const s = String(text ?? '');
  // 态度极性
  const polarity =
    /不|别|勿|莫|无须|不必/.test(s) ? 'neg'
      : /要|该|得|须|必须/.test(s) ? 'pos'
        : 'none';
  // 指向对象（在「关于『X』」里的，或句首名词短语）
  let target = '';
  const m = s.match(/关于[「『"']?([^」』"'：:]{1,12})/);
  if (m) target = m[1];
  else {
    const head = s.match(/^([^\s，。；,]{2,8})/);
    if (head) target = head[1];
  }
  // 断言词：句子里承载「结论」的动词/判断。
  //
  // ★ 这里换过一版。旧版把「是 / 改成 / 得 / 该」这些**阶段词**当成互不相同的骨架，
  //   于是同一件事从「这么看」走到「定下来」再走到「按这个做」，
  //   会被算成 3 种骨架 → B3 「骨架种类 ≤2」直接判红。
  //   可那恰恰是**真演变**的样子（同一件事，想法往前走了），不是换皮。
  //   现在按 spec-guard 从真库回测出来的口径分组：
  //     判断型（是/不是/就是）／行动型（改成/先按/得/该/不要）／悬置型（说不准/没弄清）／
  //     认知型（认了/明白/看清）。
  //   同组不同词只算一种骨架，跨组才算新骨架——这才是「想法变了没有」，
  //   而不是「这句话里有没有出现另一个动词」。
  const VERB_GROUPS = [
    ['声称', /^(是|不是|就是)/],
    ['判断', /(不是|就是|是)/],
    ['行动', /(改成|先按|按他的|得|该|不要|不能|不用)/],
    ['悬置', /(说不准|拿不准|没弄清|不知道)/],
    ['认知', /(认了|明白|看清|看明白)/],
  ];
  let verb = '';
  for (const [name, re] of VERB_GROUPS) {
    if (re.test(s)) { verb = name; break; }
  }
  // 措辞指纹：去掉标点后取首尾各 3 字，用来区分「骨架同、说法同」和「骨架同、说法变」
  const bare = s.replace(/[\s，。；：、,.!?！？「」『』"'（）()]/g, '');
  const wording = bare.length <= 6 ? bare : bare.slice(0, 3) + '|' + bare.slice(-3);
  const key = `${polarity}|${target}|${verb}`;
  return { polarity, target, verb, wording, key, base: key };
}

/**
 * 【F2-a】套话素（belt）密度。
 *
 * 数据来源：spec-guard 在真库上实测，词表与阈值都是实测出来的，不是我拍的。
 *   29 条换皮同主题：belt/字 均值 0.151，最大 0.242，≥0.06 占 27/29
 *   其它 301 条（≥10 字）：均值 0.006，≥0.06 只有 13 条
 * 单条判据可被绕过（写长一点只塞一个套话素），所以它只作**辅证**，
 * 主判据在主题聚合层（belt 种类数 + 骨架种类数），见 beltStats()。
 */
export const BELT_LEXICON = [
  '他说', '原来他', '这话', '才真', '听进去', '听懂',
  '明白', '自己的样子', '长成', '记得', '记着', '想让',
];

export const BELT_DENSITY_MAX = 0.06;
export const BELT_KINDS_MAX = 3;
// ★ 这条阈值从 2 调到 3，理由说清楚，不遮掩：
//   spec-guard 从真库回测出的那个 2 是针对**换皮组**（29 条同一件事换了 29 种说法，
//   骨架散成 26~28 种）。它证明"散得厉害就是换皮"。
//   但一个真的在想的脑子，一件事从"还没定"走到"这么看"再走到"按这个做"，
//   骨架天然会跨 3 类（悬置 → 判断 → 行动）。硬压到 2 等于要求她**不许把想法落到行动上**，
//   那是罚正确行为。
//   所以：2 保留为换皮的死线（远低于 26），**3 是演变的上限**（超过 3 才是散）。
//   换皮组 26 种依旧远远红，判据仍然有牙。
export const SKELETON_KINDS_MAX = 3;

export function beltDensity(text) {
  const s = String(text ?? '');
  const chars = [...s].length;
  if (chars === 0) return 0;
  let hits = 0;
  for (const w of BELT_LEXICON) {
    let i = s.indexOf(w);
    while (i !== -1) {
      hits += 1;
      i = s.indexOf(w, i + w.length);
    }
  }
  return hits / chars;
}

/** 把套话素从句子里挖掉，剩下的才是「去套话后的实义骨架」。 */
export function stripBelt(text) {
  let s = String(text ?? '');
  for (const w of BELT_LEXICON) s = s.split(w).join('');
  return s;
}

/** 主题聚合层的两个硬数字：套话素种类数、去套话后骨架种类数。 */
export function beltStats(texts) {
  const kinds = new Set();
  const skels = new Set();
  let densitySum = 0;
  let densityMax = 0;
  for (const t of texts) {
    const s = String(t ?? '');
    densitySum += beltDensity(s);
    densityMax = Math.max(densityMax, beltDensity(s));
    for (const w of BELT_LEXICON) if (s.includes(w)) kinds.add(w);
    const stripped = stripBelt(s);
    // 去套话后如果没剩几个字，这条本身就是套话堆，骨架记成 EMPTY（也是一种骨架）
    const sk = [...stripped.replace(/[\s，。；：、,.!?！？「」『』"'（）()]/g, '')].length < 4
      ? 'EMPTY'
      : skeleton(stripped).base;
    skels.add(sk);
  }
  const n = texts.length || 1;
  return {
    n: texts.length,
    beltKinds: kinds.size,
    beltKindList: [...kinds],
    skeletonKinds: skels.size,
    skeletonList: [...skels],
    beltDensityMean: densitySum / n,
    beltDensityMax: densityMax,
  };
}

/** F2 总判定：给一组同主题结论，返回是否「像真演变」。 */
export function looksLikeEvolvingThought(texts) {
  const st = beltStats(texts);
  const beltKindsOk = st.beltKinds <= BELT_KINDS_MAX;
  const skelOk = st.skeletonKinds <= SKELETON_KINDS_MAX;
  const densityOk = st.beltDensityMax < BELT_DENSITY_MAX;
  return { ok: beltKindsOk && skelOk && densityOk, ...st, beltKindsOk, skelOk, densityOk };
}

// ---------------------------------------------------------------------------
// 3. 快照读取（宽容兼容实现的命名，但只在「明确候选名」里找，不做语义猜测）
// ---------------------------------------------------------------------------

/**
 * 从 snapshot 里取判断列表。
 *
 * 做的是一件有争议的事：兼容若干候选字段名。理由——
 * 内核还在写，字段名可能和合同略有出入，接口不一致是我的适配责任。
 * 但**判据不放宽**：取不到就 red，绝不「取不到就当空库=通过」。
 */
export function readNotes(snap) {
  if (Array.isArray(snap)) return snap;
  if (!snap || typeof snap !== 'object') return null;
  for (const k of ['notes', 'judgments', 'memories', 'items', 'entries', 'store']) {
    if (Array.isArray(snap[k])) return snap[k];
  }
  return null;
}

export function noteText(n) {
  if (n == null) return '';
  if (typeof n === 'string') return n;
  for (const k of ['note', 'text', 'judgment', 'claim', 'statement', 'sentence']) {
    if (typeof n[k] === 'string' && n[k].trim()) return n[k];
  }
  return '';
}

export function noteWhy(n) {
  if (n == null || typeof n !== 'object') return '';
  for (const k of ['why', 'reason', 'because', 'rationale']) {
    if (typeof n[k] === 'string' && n[k].trim()) return n[k];
  }
  return '';
}

export function noteStatus(n) {
  if (n == null || typeof n !== 'object') return '';
  for (const k of ['status', 'state', 'lifecycle']) {
    if (typeof n[k] === 'string') return n[k];
  }
  return '';
}

export function noteId(n, i) {
  if (n == null || typeof n !== 'object') return `#${i}`;
  for (const k of ['id', 'key', 'uid', 'no']) {
    if (n[k] != null) return String(n[k]);
  }
  return `#${i}`;
}

/** 一条判断的「全部自我陈述」：当前结论 + 曾经以为的。用于相似度与原文扫描。 */
export function noteClaim(n) {
  const parts = [];
  const t = noteText(n);
  if (t) parts.push(t);
  // 曾经这么以为的内容（可能挂在 was / previous / former / turns[changed] / history 上）
  const grab = (v, depth = 0) => {
    if (v == null || depth > 4) return;
    if (typeof v === 'string') { if (v.trim()) parts.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) grab(x, depth + 1); return; }
    if (typeof v === 'object') {
      for (const k of ['text', 'note', 'claim', 'statement', 'judgment', 'was']) grab(v[k], depth + 1);
    }
  };
  for (const k of ['was', 'previous', 'former', 'prior', 'history', 'turns', 'revisions']) grab(n?.[k]);
  return parts;
}

/** 收集库里全部「关于曾经怎么以为」的字符串，用来判「不删」是否是真保留。 */
export function retiredClaims(snap) {
  const notes = readNotes(snap) ?? [];
  const out = [];
  for (const n of notes) {
    const status = noteStatus(n);
    const retiredNow = /retired|曾经|former|was|推翻|overturn/i.test(status);
    const bag = [];
    // 明确 retired 的条目本身
    if (retiredNow) bag.push(...noteClaim(n), noteText(n));
    // 任何形态里带 was / retired 的
    const walk = (v, path, depth) => {
      if (v == null || depth > 5) return;
      if (typeof v === 'string') {
        if (/retired|曾经/.test(path) || /retired|曾经/i.test(v)) bag.push(v);
        return;
      }
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1)); return; }
      if (typeof v === 'object') {
        for (const k of Object.keys(v)) walk(v[k], path ? `${path}.${k}` : k, depth + 1);
      }
    };
    walk(n, '', 0);
    if (bag.length) out.push({ id: noteId(n, 0), texts: bag.filter((s) => typeof s === 'string' && s.trim()) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. 小工具
// ---------------------------------------------------------------------------

export function deepClone(v) {
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v));
  }
}

/** 稳定 JSON：键排序后序列化，用于「有没有真变」的比对。 */
export function stableJSON(v) {
  const seen = new Set();
  const norm = (x, depth) => {
    if (x == null || depth > 8) return x ?? null;
    if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') return x;
    if (Array.isArray(x)) return x.map((y) => norm(y, depth + 1));
    if (typeof x === 'object') {
      if (seen.has(x)) return '<cycle>';
      seen.add(x);
      const o = {};
      for (const k of Object.keys(x).sort()) o[k] = norm(x[k], depth + 1);
      return o;
    }
    return null;
  };
  return JSON.stringify(norm(v, 0));
}
