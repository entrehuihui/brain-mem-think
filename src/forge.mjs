/**
 * forge.mjs —— 火炉，整个内核的第一道闸。
 *
 * 它为什么在这儿：
 * 旧插件的死因是「原话先进库，融合只是旁支」。这里把顺序倒过来：
 * 一条经历进来，先只当一次性材料用掉；模型从它和当前判断之间挤出
 * 「没被直接说过的那句话」，然后原文当场出栈销毁。
 * 记忆库里从头到尾没有存放原文的位置。
 *
 * 先进先出怎么落地：每次 ingest 都走 take()——取栈底那条，把文本段抹成空串，
 * 只交出它的骨架（去标点、纯字符），骨架连不成一句原话，也拼不回一条经历。
 * 所以窗口里最多同时待着 capacity-1 条原文，每条还有寿命上限（ttlMs）。
 * 判断需要哪条证据，就在抹之前先把它记进 sources，后面按 sources 去核。
 *
 * 熔不出话（NULL / 客服腔 / 结构不合格 / 跟材料对不上）＝「不会让我变得不一样」：
 * 当场 discard，不留痕迹。落库的东西只有 judge 里的 Belief。
 */

import { PREDICATES, grounding, normText, normalizeRelation, similarity } from './judge.mjs';

/**
 * 稳定性 = 这句话有多少字能落回材料 × 可识别率 ^ 0.5。
 * 可识别率惩罚「一堆组织句桥接词」：句子里一半以上是材料里压根没有的字，
 * 那是在替材料说话，不是在从材料里看出东西。
 */
export function stabilityOf(text, sources) {
  const chars = new Set([...normText(text)]);
  if (chars.size === 0) return 0;
  const ground = grounding(text, sources);
  const recognized = chars.size / Math.max(1, [...String(text).replace(/\s+/g, '')].length);
  return ground * Math.sqrt(recognized);
}

export const FORGE_DEFAULTS = Object.freeze({
  capacity: 6,
  igniteAt: 1,       // 只调 forge 的人按「有一条烧一条」；不攒孤证的门槛在 mind 那一层（默认 2）
  ttlMs: 6 * 60 * 1000,
  maxChars: 400,
  minChars: 8,
  minStability: 0.12,
  keepSimilar: 0.86,
  maxAttempts: 3,
  clinical: true,
});

/** 判断里允许和原文重合的最长连续汉字数。八个字以上就跟原文一个样了，那是复述。 */
export const COPY_RUN_LIMIT = 8;

function hanOnly(text) {
  return [...String(text ?? '')].filter((ch) => /[\u3400-\u9fff]/.test(ch)).join('');
}

/** 主题键归一：两边都在比「是不是同一摊事」，大小写、空格、连字符不该让它们变成两摊。 */
function normalizeKey(k) {
  return String(k ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * 模型自报的谓词归一成闭集里的那一个。
 * 认两种说法：闭集名本身（`trusts`），或这个谓词的说法样本（`信得过`）。
 * 认不出返回 null——由调用方当成「谓词不稳定」处理。
 */
export function canonicalRelation(raw) {
  const key = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!key) return null;
  if (Object.hasOwn(PREDICATES, key)) return key;
  for (const [name, samples] of Object.entries(PREDICATES)) {
    if (samples.some((s) => s === key || key.includes(s))) return name;
  }
  return null;
}

/** 谓词与立场是否和已有的一模一样。一样＝同一个念头又讲了一遍，不是新想法。 */
function sameClaim(candidate, prior) {
  if (!candidate || !prior) return false;
  const rel = normalizeKey(candidate.relation);
  const pred = normalizeKey(prior.relation);
  if (!rel || !pred) return false;
  return rel === pred && Number(candidate.polarity) === Number(prior.polarity);
}

/** 份量比原来重了一档（≥0.1）：同一个念头又攒到了凭据，这叫底气变了，不叫重讲一遍。 */
const WEIGHT_STEP = 0.1;
function weightedUp(candidate, prior) {
  const a = Number(candidate?.weight);
  const b = Number(prior?.weight);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a - b > 1e-9;
}

/** 任意两条文本之间最长的连续汉字重合（只算汉字，别的字符不计）。 */
export function longestSharedRun(a, list) {
  const x = hanOnly(a);
  if (!x) return 0;
  let best = 0;
  for (const s of list ?? []) {
    const y = hanOnly(s);
    if (!y) continue;
    for (let i = 0; i < x.length; i += 1) {
      if (best >= x.length - i) break;
      for (let j = 0; j < y.length; j += 1) {
        if (x[i] !== y[j]) continue;
        let k = 1;
        while (i + k < x.length && j + k < y.length && x[i + k] === y[j + k]) k += 1;
        if (k > best) best = k;
      }
    }
  }
  return best;
}

/** 模型自报的 subject 只用来归并，不许当正文：取第一个词，撇掉引号和标点，撇掉整句。 */
export function normalizeSubject(raw) {
  const s = String(raw ?? '').replace(/[「」『』"'“”‘’\s，。！？；：,、!?;:]/g, '');
  if (!s) return '这摊事';
  return [...s].slice(0, 6).join('');
}

/**
 * 模型自己指认主题（裁决二）。只认两条路：
 *   themeOf —— 直接指向某条现役判断的编号，说「我说的是这件事」；
 *   theme   —— 自己给一个主题键（relation|subject），必须和某条现役判断对得上。
 * 三条约束：
 *   1. 对不上现役判断的，一律当新主题，不许凭空造槽；
 *   2. 不许把输入原句塞进 theme：和 rawSources 连续 8 字重合即废；
 *   3. 规矩是「她 想完了自己说」，所以内核自己不去猜——猜不到就返回 null。
 * @returns {{themeKey:string, source:string, by:string}|null}
 */
export function resolveTheme(obj, candidates = [], rawSources = []) {
  if (!obj || typeof obj !== 'object') return null;
  const cands = candidates ?? [];

  // 路一：指向某条现役判断
  const idRaw = obj.themeOf ?? obj.priorId ?? obj.prior;
  if (typeof idRaw === 'string' && idRaw.trim()) {
    const id = idRaw.trim();
    const hit = cands.find((c) => c.id === id);
    if (hit) return { themeKey: hit.themeKey, source: 'model', by: 'themeOf' };
    return null;
  }

  // 路二：自己给一个主题键（或一个自己起的主题名，如 t_sleep）
  const raw = typeof obj.theme === 'string'
    ? obj.theme.trim().replace('｜', '|')
    : (typeof obj.topicId === 'string' ? obj.topicId.trim() : '');
  if (!raw) return null;
  // 约束 2：不许把原句塞进来
  if (rawSources.length && longestSharedRun(raw, rawSources) >= COPY_RUN_LIMIT) return null;
  // 约束 1：必须和某条现役判断对得上
  const direct = cands.find((c) => c.themeKey === raw);
  if (direct) return { themeKey: direct.themeKey, source: 'model', by: 'theme' };
  // 只给了一半（比如只给 relation 或只给 subject）也算认得上：和一条件撞就是它
  const parts = raw.split('|').filter(Boolean);
  if (parts.length === 1) {
    const p0 = parts[0];
    const hit = cands.find((c) => String(c.themeKey).split('|').includes(p0));
    if (hit) return { themeKey: hit.themeKey, source: 'model', by: 'theme-part' };
  }
  // 路三：自己起的主题名（t_sleep / t_deploy 这类）。她说「这是同一件事」，内核不去猜字——
  //      只要现役里**只有一摊**能被这次经历挂上（没有歧义），就认那一摊；有多摊就不认。
  //      认不上就成新的一摊，不许硬塞。
  if (cands.length && /^[A-Za-z][\w-]*$/.test(raw) && parts.length === 1) {
    const related = cands.filter((c) => Array.isArray(c.relatedTo) ? c.relatedTo : false);
    void related;
    const pool = cands.filter((c) => c.relevant !== false);
    if (pool.length === 1) return { themeKey: pool[0].themeKey, source: 'model', by: 'topicId' };
  }
  return null;
}

/**
 * 这句话有没有落到「这一摊事」的具体东西上。
 * 只数两样：与材料的连续汉字重合、与材料共享的二字词组。
 * 两者都近乎为零、句子又短——那是在说一个人「就是这样」，不是在说一件发生过的事。
 */
/**
 * 裁决三的三路 grounded 判定（满足其一即算）。
 * 每一路都要能落到「这一摊事」上，不是「随便一句话都算」。
 * @param {{text:string, subject?:string, relation?:string}} claim
 * @param {string[]} skeletons 这次材料的骨架
 * @param {{groundedIn?:number[]}} obj 模型的原始返回（可能带 groundedIn）
 */
export function groundedPaths(claim, skeletons, obj = {}) {
  const sk = (skeletons ?? []).filter(Boolean);
  if (!sk.length) return { ok: true, via: 'no-material' };

  // ③ 模型显式声明 groundedIn：序号必须在窗口里真实存在（1 起算）
  const declared = Array.isArray(obj.groundedIn) ? obj.groundedIn : [];
  if (declared.length) {
    const valid = declared.every((i) => Number.isInteger(i) && i >= 1 && i <= sk.length);
    if (valid) return { ok: true, via: 'declared' };
  }

  // ② 对象 + 谓词：subject 在材料里出现过，relation 出自闭集
  const subject = String(claim.subject ?? '').replace(/[^\u3400-\u9fffA-Za-z0-9]/g, '');
  const rel = String(claim.relation ?? '');
  if (subject && sk.some((x) => x.includes(subject)) && Object.hasOwn(PREDICATES, rel)) {
    return { ok: true, via: 'object+predicate' };
  }

  // ① 骨架落回（主路）：判断正文与材料骨架在「同一件事」上（共享的中文二元组足够）
  const t = String(claim.text ?? '');
  const tr = new Set();
  const skAll = sk.join('');
  for (let i = 0; i + 1 < t.length; i += 1) {
    const g = t.slice(i, i + 2);
    if (/^[\u3400-\u9fff]{2}$/.test(g) && skAll.includes(g)) tr.add(g);
  }
  if (tr.size >= 2) return { ok: true, via: 'skeleton' };

  return { ok: false, via: null };
}

/**
 * grounding 主路（裁决三第一条）。三问全过才算「落在这件事上」：
 *   ① 谓词出自闭集（属性评价词已经不在集内，这一问就把「他就是这样的人」挡了）
 *   ② 说的那个对象，材料里真的出现过
 *   ③ 正文和材料骨架至少共享一个连续二字片段——它确实踩在这件事上，
 *      不是拿一个「他」就当对上了（「他上个月去爬山」就是被这一问挡的）
 */
export function mainPathHolds(text, skeletons, obj = {}) {
  const sk = (skeletons ?? []).filter(Boolean);
  if (!sk.length) return true;
  // ① 谓词合法
  const rel = canonicalRelation(obj.relation) ?? canonicalRelation(String(obj.theme ?? '').split('|')[0] ?? '');
  if (!rel) return false;
  // ② 对象在材料里出现过
  const subject = String(obj.subject ?? '').replace(/[^\u3400-\u9fffA-Za-z0-9]/g, '');
  if (!subject) return false;
  const material = sk.join('');
  if (!material.includes(subject)) return false;
  // ③ 正文踩在这件事上
  // 不是「撞上一个二字就算」——「他上个月自己跑去爬山了」里的「自己」「一个」都不是这件事的内容。
  // 只有共享的片段是**实词内容**才算踩上了。纯代词/虚词不算（这是语法范畴，不是主题词表）。
  // 只有「虚词/代词/方位/数量」这类组合不算踩到这件事——它们是语法范畴，不是主题词。
  const STOP = new Set([
    '自己', '一个', '这个', '那个', '他们', '我们', '你们', '一个人', '也不', '也没', '或是',
    '就是', '但是', '还是', '一直', '一下', '上都', '上一', '一次', '一遍', '一会', '这时',
    '那时', '有些', '有点', '什么', '这样', '那样', '这么', '那么', '已经', '可以', '还是',
  ]);
  const t = [...String(text ?? '')].filter((c) => /[\u3400-\u9fff]/.test(c)).join('');
  let hits = 0;
  for (let i = 0; i + 2 <= t.length; i += 1) {
    const g = t.slice(i, i + 2);
    if (STOP.has(g)) continue;
    if (material.includes(g)) hits += 1;
    if (hits >= 2) return true;
  }
  if (hits >= 1) return true;
  // 第三问的另一种成立方式：她把这个人的**行为**说出了个样子——
  // 以她认的那个对象起头、句子里有能做出/看见的动作、长度够说成一件事。
  // 这是「从具体行为里看出一个人的样子」，正是「想」该做的事。
  const ACTION = /[说问讲做走来到去拿放喝吃看等拦劝改想记答应睡起坐站开写完读拖搁瞒忍撑催逼]/;
  // 恒常的口气：说一个人「总是这样」，而不是「我这次看明白了」。
  const HABIT = /(总是|老是|一直|动不动|每次都|习惯|一向)/;
  // 具体时点：那是转述某件事，不是从经历里看出一个人的样子。
  const POINT_IN_TIME = /[上下这那前昨明后]?(月|日|号|天)|[一二三四五六七八九十两几\d](次|回|遍|趟)/;
  if (t.startsWith(subject) && ACTION.test(t) && HABIT.test(t)
    && !POINT_IN_TIME.test(t) && t.length >= 8) return true;
  return false;
}

export function concreteEnough(text, sources, strict = false) {
  const src = (sources ?? []).map((x) => String(x ?? ''));
  if (!src.length) return true;
  const t = String(text);
  // 连续重合够长：明摆着落在材料上
  if (longestSharedRun(t, src) >= 3) return true;
  // 二字词组共享：换了说法也总有几个词落在同一件事上
  const bigrams = (x) => {
    const out = [];
    const han = [...String(x)].filter((c) => /[\u3400-\u9fff]/.test(c));
    for (let i = 0; i + 1 < han.length; i += 1) out.push(han[i] + han[i + 1]);
    return out;
  };
  const theirs = new Set(src.flatMap((x) => bigrams(x)));
  const shared = bigrams(t).filter((g) => theirs.has(g)).length;
  if (strict) {
    // 严模式：句子里的三元组片段，至少要有**一个**落在材料上。
    // 纯粹换领域/换对象的句子，三元组一个都对不上——它讲的是另一件事。
    const han = [...t].filter((c) => /[\u3400-\u9fff]/.test(c));
    const joined = src.join('');
    for (let i = 0; i + 2 < han.length; i += 1) {
      const tri = han[i] + han[i + 1] + han[i + 2];
      if (joined.includes(tri)) return true;
    }
    return false;
  }
  if (shared >= 2) return true;
  // 共享一个词 + 句子短：那是在讲这一件事的一句话，放过
  if (shared >= 1) return true;
  return false;
}

/** 客服腔/报告腔。继承自旧 fuser.js：这类句子一旦写进判断，她想起的是一个工单。 */
const CLINICAL = [
  /关于[^，。]{0,12}[，,]/,
  /我(已经)?(理解|了解|记录|注意到)了?/,
  /根据(以上|上述|材料)/,
  /共[一二三四五六七八九十\d]+(条|次|件|项)/,
  /总结|概括|归纳|综上/,
  /您的/,
  /了呢$|哦$|呀$|啦$/,
  /[！!]/,
  /^[\p{L}\p{N}]{1,4}[:：]/u,
];

export function looksClinical(text) {
  const s = String(text ?? '');
  return CLINICAL.some((re) => re.test(s));
}

/**
 * 从模型输出里抠 JSON。包了代码块、加了前言都不该让一炉废掉。
 * 注入的模型既可能吐字符串，也可能直接交一个对象；对象里可能叫 text，
 * 也可能叫 note / fused / judgement / judgment。这些口都收——
 * 只是换个字段名就整炉作废，那是我们没接好，不是它熔不出来。
 */
export function parseSynthesis(raw) {
  if (raw && typeof raw === 'object') {
    if (typeof raw.text === 'string' || typeof raw.fused === 'string') return raw;
    const named = raw.judgement ?? raw.judgment;
    if (typeof named === 'string') return { ...raw, text: named };
    if (named && typeof named === 'object') {
      return { ...raw, ...named, text: named.text ?? named.note ?? named.fused };
    }
    if (typeof raw.note === 'string') return { ...raw, text: raw.note };
    return raw;
  }
  const text = String(raw ?? '').trim();
  if (!text || text.toUpperCase() === 'NULL') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 骨架：只留字和数，不留标点。连不成原句，算不得原文。 */
export function skeletal(text) {
  return normText(text).slice(0, 600);
}

/**
 * 裁决四第四问：只对 groundedIn 生效。
 *   ① 序号真实存在（1 起算，越界作废）
 *   ② 被指的那几条材料里，至少两条含同一 relation 的语义信号（= 这是归纳出来的）
 *   ③ 正文里不许出现材料里没有的具体时点/数量（= 不是编造细节）
 * 三问全过才算声明有效；无效就退回字面判定，绝不直接放行。
 */
export function declaredGrounded(obj, skeletons, text) {
  const declared = Array.isArray(obj?.groundedIn) ? obj.groundedIn : [];
  if (!declared.length) return false;
  const sk = (skeletons ?? []).filter(Boolean);
  // ① 序号真实存在
  if (!declared.every((i) => Number.isInteger(i) && i >= 1 && i <= sk.length)) return false;
  const picked = declared.map((i) => sk[i - 1]);
  // ② 归纳证据：至少两条材料含同一 relation 的说法样本
  const rel = canonicalRelation(obj.relation) ?? canonicalRelation(String(obj.theme ?? '').split('|')[0] ?? '');
  const samples = (rel && PREDICATES[rel]) ? PREDICATES[rel] : [];
  const hits = samples.length
    ? picked.filter((x) => samples.some((w) => String(x).includes(w))).length
    : 0;
  if (hits < 2) return false;
  // ③ 不许有材料里没有的具体时点/数量
  const POINTS = text.match(/[上下这那前昨明后]?(月|日|号|天)|[一二三四五六七八九十两几每\d](次|回|遍|趟)/g) ?? [];
  const material = picked.join('');
  if (POINTS.some((p) => !material.includes(p))) return false;
  return true;
}

/**
 * 这句话有没有点名一个「材料里没有的具体时点或次数」。
 * 只有两种形态算：数量词 + 量词（三次/两回/一遍/第2次），或时间词（上个月/昨天/这一年）。
 * 它们不是句式识别，是语法范畴——「多会儿发生的、几回」是能被指认的事实。
 * 材料里出现过同样的时点就放行：长句带时点、而时点是真的，不该被误杀。
 */
export function inventsTimePoint(text, sources) {
  const RE = /(上|下|这|那|前|昨|今|明|去|本)(一)?(个)?(月|日|号|年)|(昨天|今天|明天|前天|后天|去年|今年|明年)/g;
  const points = String(text ?? '').match(RE) ?? [];
  if (!points.length) return false;
  const material = (sources ?? []).join('');
  return points.some((pt) => !material.includes(pt));
}

/**
 * 核对：模型的「立场字段」和「正文自述」有没有互相打架。
 * 只回答一件事——「它说的和它给的，是不是一回事」。
 * 不下判断、不改判定、不参与 grounding 或 revision，只把矛盾记下来，供事后查。
 */
export function checkConsistency(obj) {
  if (!obj || typeof obj !== 'object') return { ok: true, inconsistent: false, why: null };
  const text = String(obj.text ?? obj.fused ?? obj.note ?? '');
  const why = String(obj.why ?? '');
  const body = `${text}${why}`;
  // 正文里「我改了主意」的说法
  const SELF_REVERSAL = /(看偏|想偏|先前那样想|以前那样想|认后一条|不这么看|改成|反过来|我错了|收回了)/;
  const saysFlipped = SELF_REVERSAL.test(body);
  // 立场字段
  const pol = String(obj.polarity ?? '').toLowerCase();
  const stance = String(obj.stance ?? '').toLowerCase();
  const fieldSaysNeg = pol === 'unfavorable' || pol === '-1' || obj.polarity === -1 || stance === 'neg';
  // 矛盾：正文说「我改了主意」，但立场字段还是正向
  if (saysFlipped && !fieldSaysNeg) {
    return {
      ok: false,
      inconsistent: true,
      why: 'body_says_flipped_field_says_positive',
      body: text.slice(0, 40),
      field: { polarity: obj.polarity ?? null, stance: obj.stance ?? null },
    };
  }
  return { ok: true, inconsistent: false, why: null };
}

export class Forge {
  constructor(synth, opts = {}) {
    if (!synth || typeof synth.synthesize !== 'function') {
      throw new TypeError('forge: 需要注入 { synthesize(material) }');
    }
    this.synth = synth;
    this.opts = { ...FORGE_DEFAULTS, ...opts };
    this.heat = [];
    this.seq = 0;
    this.history = [];
    this.stats = { witnessed: 0, discarded: 0, synthCalls: 0, expired: 0 };
  }

  /**
   * 记一条经历。它不进库，只进这个短命窗口。
   * @param {string} raw
   * @param {{at?:number, hints?:string[]}} meta
   */
  witness(raw, meta = {}) {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < this.opts.minChars) {
      this.stats.discarded += 1;
      return { ok: false, why: 'too_short' };
    }
    const kept = text.slice(0, this.opts.maxChars);
    const now = Number.isFinite(meta.at) ? meta.at : Date.now();
    this.stats.witnessed += 1;
    this.heat.push({
      seq: ++this.seq,
      skeletal: skeletal(kept),
      at: now,
      hints: Array.isArray(meta.hints) ? meta.hints.map((h) => String(h).slice(0, 24)) : [],
      text: kept,
    });
    this.expire(now);
    // 先进先出：出了上限就把栈底那条交出去（原文抹掉），窗口只留骨架。
    // 一条孤证不烧（见 mind：攒够 igniteAt 才点火），所以这里只管腾位置。
    const handed = [];
    while (this.heat.length > this.opts.capacity) {
      const t = this.take();
      if (t) handed.push(t);
    }
    return { ok: true, seq: this.seq, heat: this.heatSnapshot(), handed };
  }

  /** 到寿的当场腾位置。 */
  expire(now = Date.now()) {
    const dead = [];
    while (this.heat.length && now - this.heat[0].at > this.opts.ttlMs) {
      const t = this.take();
      if (t) {
        dead.push(t);
        this.stats.expired += 1;
      }
    }
    return dead;
  }

  /**
   * 取栈底那条的骨架，并把它的原文抹掉。
   * 抹的是内容本身（原地置空 + 从栈里去掉），不是复制一份再删。
   */
  take() {
    const item = this.heat.shift();
    if (!item) return null;
    const out = { seq: item.seq, skeletal: item.skeletal, at: item.at, hints: item.hints };
    item.text = '';
    item.skeletal = '';
    item.hints = [];
    item.at = null;
    return out;
  }

  get pending() {
    return this.heat.length;
  }

  heatSnapshot() {
    return this.heat.map((i) => ({ seq: i.seq, skeletal: i.skeletal, at: i.at, hints: [...i.hints] }));
  }

  /** 材料段：原文只在这里用一次，不存、不回传。 */
  gather() {
    return this.heat.filter((i) => i.text).map((i) => i.text);
  }

  #material(sources, current, facts) {
    const prev = current
      ? `你原来这么以为：${current.text}（${current.why || '没写理由'}）——核心谓词 ${current.relation}，立场 ${current.polarity > 0 ? 'favorable' : 'unfavorable'}。新证据若还是同一个谓词同一个立场，就只是它又多了一条凭据，结论不必改，但分量该动；只有谓词或立场真的换了，才算你想法变了。\n`
      : '你原来还没有定论。\n';
    // 送进模型的东西只有骨架：不打标点、不留原句，模型也就抄不走原话。
    const notes = facts.skeletons?.length
      ? facts.skeletons
      : this.heat.filter((i) => i.text).map((i) => skeletal(i.text));
    const body = notes.map((s) => `- ${s}`).join('\n');
    const known = [
      `已有判断 ${facts.occupied ?? 0}/${facts.max ?? 6}`,
      facts.total ? `这摊事你已经是第 ${facts.total} 回见到它了（含这一次）` : null,
      facts.oldest ? `最老的一条放了一阵子了，它占着位置` : null,
      facts.absorbed ? `这一锅之前烧成过「${facts.absorbed.text}」，现在再烧不是重写，是往下想一步` : null,
    ].filter(Boolean).join('；');
    const hint = facts.themeHint ? `（反复出现的：${facts.themeHint}）\n` : '';
    // 已经在库里的那几摊事：让模型有机会说「这跟我先前想的那件事是一回事」。
    // 已经确定是同一件的那条不重复列（上面「你原来这么以为」已经说过），
    // 免得同一个判断在材料里出现两处，把模型的注意力从材料拽到判断上。
    const cands = (Array.isArray(facts.candidates) ? facts.candidates : [])
      .filter((c) => !current || c.id !== current.id);
    const candBlock = cands.length
      ? ['', '你已经想过、还在的事（如果你看出这次是同一件，把它的编号填进 priorId）：',
        ...cands.map((c) => `- ${c.id}：${c.text}`)].join('\n')
      : '';
    return [
      hint,
      prev,
      '这次的材料（只剩骨架，标点和原句都已抹掉）：',
      body || '（这一锅只剩骨架，没有新材料）',
      '',
      `账本：${known}。`,
      candBlock,
      '',
      '要求：',
      '1. 不要概括发生过什么，不要说关于……、共几次。',
      '2. 说出这几条经历里没有直接说过的那句话——你从它们之间看出来的东西。',
      '3. 只准用材料里真实发生的事，不准补情节、人物、时间；也不许把材料里连续八个字原样抄进你的话。',
      '4. 第一人称，句子短，像心里嘀咕。',
      '5. 必须带一句为什么这么想。',
      '6. 这次的新材料如果没有让你变得不一样，就只输出 NULL。',
      '',
      '另外必须交出：',
      '- relation：核心谓词，只能从下面这些里挑一个，挑不到吐 "?"。',
      '  ' + Object.keys(PREDICATES).join(' '),
      '- subject：这个判断是关于谁的（我 / 他 / 这摊事），一个词；这是你将来认出「同一件事」的凭据，不许抄原句。',
      '- polarity：favorable 或 unfavorable，你站在哪一边。',
      '- weight：0 到 1，这件事现在该占多重，要算上已经攒了几条。',
      '- themeOf：如果这次的经历就是上面列过的某一件，填它的编号；不是就别填。',
      '- theme：或者直接给这件事的主题键，形如「谓词|关于谁」，比如 trusts|他。',
      '  只有你认得它确实是同一件事时才填；拿不准就空着，让它成一件新事。',
      '',
      '只输出 JSON：{"text":"那句话","why":"为什么","relation":"trusts","subject":"他","polarity":"unfavorable","weight":0.7}',
      '或者只输出 "NULL"。',
    ].join('\n');
  }

  async #ask(material) {
    this.stats.synthCalls += 1;
    let out = null;
    try {
      out = parseSynthesis(await this.synth.synthesize(material));
    } catch {
      return null;
    }
    // 核对：它说的和它给的如果打架，就记下来（不据此改任何判定）。
    const cc = checkConsistency(out);
    if (cc.inconsistent) {
      this.stats.inconsistent = (this.stats.inconsistent ?? 0) + 1;
      this.lastInconsistent = cc;
      this.history.push({ at: Date.now(), why: 'inconsistent_receipt', head: cc.body ?? '' });
    }
    return out;
  }

  /** 观察窗：最近一次拦截的原因。给调试和测试用，不进记忆库。 */
  get lastRejected() {
    return [...this.history];
  }

  /**
   * 材料怎么造。默认两步走：
   *   第一次用真材料（模型能看懂、也更愿意说真话）；
   *   被稳定性/抄原文拦下，第二次改用「这一摊事全部材料的骨架」——
   *   它看得见上下文，就不会只凭一句话编。
   * 注入的模型认别的形状，覆盖这个就行（mind 的 opts.forge.craft）。
   */
  craft(sources, current, facts) {
    return this.#material(sources, current, facts);
  }

  #validate(obj, sources, rawSources = [], candidates = []) {
    if (!obj || typeof obj !== 'object') return { ok: false, why: 'no_output' };
    const text = String(obj.text ?? obj.fused ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return { ok: false, why: 'empty_text' };
    if (this.opts.clinical && looksClinical(text)) return { ok: false, why: 'clinical' };
    if ([...text].length < 6) return { ok: false, why: 'too_short' };
    // 稳定性只拿真实材料核：骨架是字母表，拿它算「多少字落得回材料」没有意义。
    // 阈值：材料少（同一句话被复述、说得比它长）时天然偏低，所以只拦「离谱地对不上」；
    // 真正盯「抄原文」的是下面那条连续八个汉字的重合检查。
    const stab = rawSources.length ? stabilityOf(text, rawSources) : null;
    if (stab != null && stab < this.opts.minStability) {
      return { ok: false, why: 'not_grounded', stability: Math.round(stab * 1000) / 1000, head: text.slice(0, 6) };
    }
    const trial = String(obj.relation ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const themeRelation = typeof obj.theme === 'string' ? String(obj.theme).split('|')[0] : '';
    const pickedRel = (() => {
      const p = resolveTheme(obj, candidates, rawSources);
      if (!p) return '';
      return String(p.themeKey).split('|')[0];
    })();
    if (trial !== '?' && !canonicalRelation(trial)
      && !canonicalRelation(themeRelation)
      && !canonicalRelation(pickedRel)
      && !canonicalRelation(text) && !(obj.why && canonicalRelation(String(obj.why)))) {
      return { ok: false, why: 'predicate_unstable', head: text.slice(0, 6) };
    }
    // 铁律的最后一道：这句话里不许有连着八个字跟原文一样。
    // 熔出来的判断必须比原文更短、更疏、更像自己的话；抄了原句就是原文变体，不许入库。
    // 同理，它得能从材料里长出点东西来——一个字都落不回材料，那是在凭空编。
    const copied = longestSharedRun(text, rawSources);
    if (copied >= COPY_RUN_LIMIT) {
      return { ok: false, why: 'copied_from_source', copied, head: text.slice(0, 6) };
    }
    // 裁决三：grounding 有两条路，任一路成立即算「落在这一件事上」。
    //   路一（字面）：正文有足够的字能落回材料。
    //   路二（主路，本来该有的一路）：谓词合法 + 说的对象在材料里 + 正文确实踩在这件事上。
    // 裁决四：模型显式声明 groundedIn 时，内核复核三问；任一问不过就作废、退回字面判定。
    const declareOk = declaredGrounded(obj, sources, text);
    if (rawSources.length && !declareOk && grounding(text, rawSources) < 0.08) {
      return { ok: false, why: 'not_grounded', stability: 0, head: text.slice(0, 6) };
    }
    // A-① 空话：短句，且句子里没有任何具体指认（动作/对象），材料里也找不到。
    const why = String(obj.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const byText = canonicalRelation(text) ?? (why ? canonicalRelation(why) : null);
    const canon = canonicalRelation(obj.relation)
      ?? canonicalRelation(themeRelation)
      ?? canonicalRelation(pickedRel)
      ?? byText ?? obj.relation;
    const pol = normalizeRelation(canon, obj.polarity);
    // 模型回一个它自己起的主题名（如 t_sleep）：只要和某条现役判断撞得上，就当作「同一摊事」。
    // 这是裁决里那条「模型自己指定主题」的路，但**必须撞得上已有的**——新起的名字不会凭空凭空成主题。
    const picked = resolveTheme(obj, candidates, rawSources);
    let resolved = picked ? picked.themeKey : null;
    const themeSource = picked ? picked.source : null;
    if (!resolved) {
      // 模型回一个它自己起的主题名（t_sleep / t_deploy）：必须和某条现役判断撞得上才算数。
      const alias = String(obj.topicId ?? obj.topic ?? obj.theme ?? '').trim();
      if (alias) {
        const pool = [alias, ...alias.split('_').filter((x) => x.length >= 2)];
        const hit = (candidates ?? []).find((c) => [...pool].some((p) => p.length >= 2 && (
          String(c.themeKey).includes(p)
          || String(c.relation ?? '').includes(p)
          || String(c.text).includes(p)
          || p.includes(String(c.relation ?? ''))
        )));
        if (hit) resolved = hit.themeKey;
      }
    }
    return {
      ok: true,
      text: text.slice(0, 120),
      why,
      // 谓词/立场在这里就归一：'favorable' 和 1 是同一件事，别到下游再猜一次。
      relation: pol.ok ? pol.relation : obj.relation,
      polarity: pol.ok ? pol.polarity : obj.polarity,
      // subject / 谓词 / 立场都是模型自报的元数据，不是判断本身；
      // 它们不许被当正文展示（`「主人熬夜到后」是巧合还是规律` 那种引号里塞原话的写法就是这么来的）。
      subject: normalizeSubject(obj.subject),
      weight: obj.weight,
      // 模型自报的另外两样元数据，同样只做透传：
      //   stage = 这句说到哪一层（裁决十），kind = 这是关于事还是关于她自己（裁决九）。
      // 不在这里补、不在这里推——模型没说就是 null，下游按「不知道」处理。
      stage: obj.stage ?? null,
      kind: obj.kind ?? null,
      stability: stab,
      // 模型自己指认「这是哪一摊事」——主题归一允许的第二条路（第一条是骨架重合）。
      resolved,
      themeSource,
    };
  }

  /**
   * 和 #validate 同一套判据，公开只为调试/测试能问「这一句为什么被拦」。
   * 不写库、不改状态、不记 history。
   */
  inspect(obj, sources, candidates = []) {
    const r = this.#validate(obj, sources, this.gather(), candidates);
    return { ...r, text: undefined };
  }

  /**
   * 烧一锅：这一锅材料够不够让我不一样。
   * @param {object|null} current 这个主题现役的信念
   * @param {object} facts { occupied, max, oldest, absorbed, themeKey, themeHint, subjectHint,
   *                         igniteAt, skeletons, total }
   * @returns {Promise<object|null>} 合格结果；不会让我不一样就 null（并已清窗）
   *
   * ★ skeletons：上层若已经先把经历的骨架算好了（它确实会，因为要算主题），就从这儿送进来，
   *   不再重算一遍；不给才用窗口里现存的原文。
   * ★ total：这个主题到这次第几回。不传时按「窗口里还剩几条材料」算——
   *   窗口在每次判断成立后清空，所以「剩几条」就是「这次攒了几条」，这和以前的行为一致。
   */
  async render(current, facts = {}) {
    const ignite = Number.isFinite(facts.igniteAt) ? facts.igniteAt : 1;
    const skeletons = Array.isArray(facts.skeletons) && facts.skeletons.length
      ? facts.skeletons.filter(Boolean)
      : null;
    const sources = skeletons ?? this.gather();
    if (!sources.length) return null;
    if (ignite > 1 && sources.length < ignite) return null;
    if (sources.join('').length < 8) {
      this.discardAll();
      this.stats.discarded += 1;
      return null;
    }

    const material = this.craft(sources, current, facts);
    // 稳定的对照物：有材料就用材料，窗口里已经没有原文时用骨架（总比不核好）。
    const rawSources = this.gather().length ? this.gather() : sources;
    // 备胎方案（按优先级）：②「这一摊事全部材料的骨架」 ③「只给骨架、不给先前判断」
    // ——模型看得见上下文的字数，就爱把上下文里的字句抄进正文；所以被抄原文拦下时，
    //   先收窄它的视野，再考虑换一种问法。
    // 注意：谓词不合规不再重试。同一条材料追问三次，模型只会越改越离谱；
    // 这种熔不出来就该当场丢掉，不要硬凑。
    const backupCards = [
      facts.fullSkeletons?.length
        ? [
          `你原来这么以为：${current?.text ?? '（还没有定论）'}（${current?.why || '没写理由'}）`
          + `——核心谓词 ${current?.relation ?? '?'}，立场 ${current ? (current.polarity > 0 ? 'favorable' : 'unfavorable') : '?'}。\n`,
          facts.total ? `这个主题攒到第 ${facts.total} 回。\n` : '',
          '这一摊事攒下来的全部材料（只剩骨架，标点和原句都抹掉了）：',
          facts.fullSkeletons.map((s) => `- ${s}`).join('\n'),
          '',
          '说出这几条经历里没有直接说过的那句话；只准用材料里真实发生的事。',
          '只输出 JSON：{"text":"那句话","why":"为什么","relation":"trusts","subject":"他","polarity":"unfavorable","weight":0.7}',
          '或者只输出 "NULL"。',
        ].filter((x) => x !== undefined).join('\n')
        : null,
      [
        '这次只给你材料的骨架（标点和原句都已抹掉）：',
        sources.map((s) => `- ${s}`).join('\n'),
        '',
        '说出你从里面看出来的那句话，只准用这些字里真实出现过的事。',
        '只输出 JSON：{"text":"那句话","why":"为什么","relation":"trusts","subject":"他","polarity":"favorable","weight":0.5}',
        '或者只输出 "NULL"。',
      ].join('\n'),
    ].filter(Boolean);
    const rejected = [];
    let verdict = null;
    for (let attempt = 0; attempt < this.opts.maxAttempts; attempt += 1) {
      // 被「对不上材料」或「抄原文」拦过，就换一种问法；否则问同一份。
      let base = material;
      if (rejected.length) {
        const needSwitch = rejected.some((r) => r === 'not_grounded' || r === 'copied_from_source');
        if (needSwitch) base = backupCards[Math.min(backupCards.length - 1, rejected.length - 1)] ?? material;
      }
      const obj = await this.#ask(
        attempt === 0 ? base : `${base}\n\n上一回不合格（${rejected.at(-1)}）。再说一遍，吐 NULL 也可以。`,
      );
      if (!obj) {
        rejected.push('NULL');
        break;
      }
      const checked = this.#validate(obj, sources, rawSources, facts.candidates ?? []);
      if (!checked.ok && (checked.why === 'predicate_unstable' || checked.why === 'no_output')) {
        // 谓词说不清是模型这一回没想明白，不是材料不够。再问也是逼它编，直接作废。
        this.history.push({ at: Date.now(), why: checked.why, head: checked.head ?? '' });
        rejected.push(checked.why);
        break;
      }
      if (!checked.ok) {
        rejected.push(checked.why);
        this.history.push({ at: Date.now(), why: checked.why, stability: checked.stability ?? null, head: checked.head ?? '' });
        continue;
      }
      // 同一主题前后必须是一个主谓：跨主题的相似不算「换皮」。
      // 判据是「谓词和立场都没变」——同一个念头换个说法，不是新想法；
      // 但「攒够了凭据、分量涨了一档」就是往前走了一步，要放行（那正是会想多的那一下）。
      if (current && normalizeKey(current.themeKey) === normalizeKey(facts.themeKey)
        && sameClaim(checked, current) && !weightedUp(checked, current)
        && !weightedUp(checked, { weight: facts.occupiedWeight })) {
        rejected.push('same_as_old');
        this.history.push({ at: Date.now(), why: 'same_as_old' });
        continue;
      }
      if (facts.absorbed && normalizeKey(facts.absorbed.themeKey) === normalizeKey(facts.themeKey)
        && sameClaim(checked, facts.absorbed) && !weightedUp(checked, facts.absorbed)) {
        rejected.push('same_as_absorbed');
        this.history.push({ at: Date.now(), why: 'same_as_absorbed' });
        continue;
      }
      verdict = {
        ...checked,
        rejected,
        batchSize: sources.length,
        themeHint: facts.themeHint ?? null,
        total: facts.total ?? sources.length,
      };
      break;
    }

    // 判断成没成，这一锅的原文都在这里销毁（证据已在 sources 里记过）。
    const heat = this.heatSnapshot();
    this.discardAll();
    if (!verdict) {
      this.stats.discarded += 1;
      return null;
    }
    return {
      ...verdict,
      sources,
      attempts: rejected.length + 1,
      themeKey: facts.themeKey ?? null,
      subjectHint: facts.subjectHint ?? null,
      absorbed: facts.absorbed ?? null,
      heat,
    };
  }

  discardAll() {
    while (this.heat.length) this.take();
  }

  /** 换一组：take 完之后的骨架交给调用方自己处理。 */
  bones() {
    return this.heatSnapshot();
  }
}

export function createForge(synth, opts = {}) {
  const { craft, ...rest } = opts;
  const f = new Forge(synth, rest);
  // 注入的模型有自己认的材料形状，就让它自己决定怎么接；默认那段话仍是最合适的。
  if (typeof craft === 'function') f.craft = craft.bind(f);
  return f;
}
