/**
 * judge.mjs —— 判断条目本身。
 *
 * 它为什么在这儿：
 * 记忆库里根本不存「发生过什么」，只存一个判断。所以要有一份数据结构，
 * 把「我原来这么以为 → 后来我这么想」这条轨迹完整留住，一条也不许删。
 * 这里只放数据、生命周期和演变比较，不放任何采集/遗忘/追问的策略——
 * 那些策略必须依赖这张表，而不是反过来。
 *
 * 演变怎么防换皮（机制，不是口号）：
 * 一条判断的身份 = relation（核心谓词）+ subject + polarity（立场正负）。
 * 三者不变＝同一个信念，换的说法只能算「同一句再讲一遍」；
 * 三者之一变了才算真演变。模型被要求只吐谓词空间里的词，空间外的谓词
 * 判为不稳定（让上层换一次再试），不硬接受。
 */

import { createHash } from 'node:crypto';

export const STATUS = Object.freeze({
  PENDING: 'pending',
  HELD: 'held',
  OVERTURNED: 'overturned',
  ESTEEMED: 'esteemed',
});

/** 生命周期：悬而未决 → 成立 / 被推翻 → 曾经这么以为（永久在场）。 */
export const LIFECYCLE = Object.freeze({
  [STATUS.PENDING]: Object.freeze([STATUS.HELD, STATUS.OVERTURNED, STATUS.ESTEEMED]),
  [STATUS.HELD]: Object.freeze([STATUS.ESTEEMED, STATUS.OVERTURNED, STATUS.PENDING]),
  [STATUS.OVERTURNED]: Object.freeze([]),
  [STATUS.ESTEEMED]: Object.freeze([]),
});

/**
 * 谓词词表（核心谓词闭集）。
 *
 * 这里的中文不是「主题关键词」，是**谓词的说法样本**：模型吐「信得过」时，
 * 内核要能认出它就是闭集里的 trusts，否则模型一换说法判断就整条作废。
 * 它只用来归一谓词，永远不参与「这条经历属于哪个主题」——主题由
 * relation|subject 决定，经历在熔出判断之前不属于任何主题。
 */
/** 想法的层级：从悬置一路走到行动。内核只比对顺序，不猜句式。 */
export const STAGE_KEYS = Object.freeze(['pending', 'understood', 'settled', 'acting']);

/** 这一层是不是比上一层往前走了；任一方不知道就返回 false（不猜）。 */
export function stageWentForward(prev, next) {
  const a = STAGE_KEYS.indexOf(String(prev ?? ''));
  const b = STAGE_KEYS.indexOf(String(next ?? ''));
  if (a < 0 || b < 0) return false;
  return b > a;
}

export const PREDICATES = Object.freeze({
  // 动作/状态类：每一条都是一个**能做出来、能看见**的动作或状态。
  // 属性评价词（「是」「为人」「要紧」这一族）不许进闭集——
  // 「他就是这样的人」这种话在谓词这一步就该死，不需要在别处加闸。
  stalls: ['拖', '拖着', '搁着', '一直不动'],
  pushes: ['催', '逼', '推着'],
  checks_first: ['先问', '先确认', '过一遍'],
  hides: ['瞒', '不说', '藏着'],
  shows: ['说出来', '讲出来', '开口'],
  endures: ['忍着', '撑着', '扛着'],
  not: ['不是', '并不是', '不是那种'],
  trusts: ['信得过', '信', '靠得住'],
  distrusts: ['信不过', '不敢信', '靠不住'],
  wants: ['要', '想要', '需要', '缺不了'],
  rejects: ['不要', '不想要', '受不住'],
  needs: ['得', '必须要'],
  cant_stand: ['受不住', '忍不了', '扛不了'],
  can_stand: ['扛得住', '忍得了', '受得住'],
  grows_away: ['会把我推开', '慢慢远了', '会散'],
  grows_toward: ['把我拉近', '越靠越亲', '往我这边长'],
  learns_from: ['学到', '认下了', '记下了'],
  is_because: ['是因为', '八成是因为', '不是别的因为'],
  fears: ['怕', '怕的是', '输不起'],
  is_afraid_of: ['不怕', '不算怕'],

  is_below: ['配不上', '够不着'],
  is_above: ['配得上', '够得上'],
  can_say: ['说得出口', '可以直说'],
  cannot_say: ['说不出口', '开不了口'],
  wants_more: ['还不够', '还想要更多'],
  is_enough: ['够了', '这样就够了'],
  still_thinks_about: ['还惦记', '还没放下'],
});

const RELATION_ALIAS = Object.freeze({
  'untrustworthy': 'distrusts',
  'unreliable': 'distrusts',
  'dependable': 'trusts',
  // 属性评价的别名不再指向任何谓词：它们没有动作，落在闭集之外就该作废。
  'nice': 'unknown_property',
  'good': 'unknown_property',
  'bad': 'unknown_property',
  'not_wants': 'rejects',
  'doesnt_want': 'rejects',
  'afraid': 'fears',
});

const PREDICATE_RE = /^[a-z][a-z0-9_]{0,39}$/;
const POSITIVE_TOKENS = new Set(['favorable', '+', 'pos', 'positive', 'favor', 'yes', '1', 1, true]);
const NEGATIVE_TOKENS = new Set(['unfavorable', '-', 'neg', 'negative', 'against', 'no', '0', -1, false, '0']);

/** 夹到 [0,1]。分数一律自带兜底，坏数据不把整条记忆带崩。 */
export function clamp01(n, dflt = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return dflt;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 文本入库前的最后一道：只做结构清洗。去重/截短 ≠ 去原文，原文在这里本来就不该出现。 */
export function clean(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

export function normText(text) {
  return clean(text, 400)
    .toLowerCase()
    .replace(/[\s，。！？、；：,.!?;:—…·"'「」『』（）()【】\[\]]+/g, '');
}

/** 字面相似度（unicode 字符集合的 Jaccard），只用来判断「是不是同一句话换了个说法」。 */
export function similarity(a, b) {
  const A = new Set([...normText(a)]);
  const B = new Set([...normText(b)]);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const ch of A) if (B.has(ch)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** 稳定性：说出来的话里，有多少字能落回原始经历。低＝编造。 */
export function grounding(text, sources) {
  const chars = new Set([...normText(text)]);
  if (chars.size === 0 || sources.length === 0) return 0;
  const bag = new Set();
  for (const s of sources) for (const ch of normText(s)) bag.add(ch);
  let hit = 0;
  for (const ch of chars) if (bag.has(ch)) hit += 1;
  return hit / chars.size;
}

function stableHash(parts) {
  return createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 12);
}

export function normalizeRelation(predicate, polarity) {
  let key = String(predicate ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (RELATION_ALIAS[key]) key = RELATION_ALIAS[key];
  let sign;
  // 极性两种写法都收：'favorable' / 'unfavorable'，或者上游已经归一过的 ±1。
  const num = Number(polarity);
  const p = String(polarity ?? '').trim().toLowerCase();
  if (polarity === 1 || polarity === -1 || (Number.isFinite(num) && num !== 0 && String(num) === p)) {
    sign = num > 0 ? 1 : -1;
  } else if (POSITIVE_TOKENS.has(p)) sign = 1;
  else if (NEGATIVE_TOKENS.has(p)) sign = -1;
  else return { ok: false, reason: 'polarity', polarity: 0 };
  if (!PREDICATE_RE.test(key)) return { ok: false, reason: 'predicate_shape', polarity: sign };
  if (!Object.hasOwn(PREDICATES, key)) return { ok: false, reason: 'predicate_unstable', polarity: sign };
  return { ok: true, reason: '', relation: key, polarity: sign };
}

/**
 * 一条判断。
 * 生命周期各状态是同一份档案的不同面：turns 记全过程，overturnedBy 记被谁推翻。
 */
/** 一条判断被放下的原因，分三类：被自己推翻 / 追不动认了 / 被新的挤沉。
 *  这是唯一的分类判据——任何地方都不许再靠 overturnedReason 的中文字面量去猜。 */
export const RETIRE_REASON = Object.freeze({
  OVERTURNED: 'overturned',
  ABANDONED: 'abandoned',
  FORGOTTEN: 'forgotten',
});

export class Belief {
  constructor(init) {
    const now = Number.isFinite(init?.at) ? init.at : Date.now();
    this.id = init?.id ?? `b_${stableHash([init?.themeKey, init?.relation, init?.subject, String(init?.polarity), String(now)])}`;
    this.themeKey = clean(init?.themeKey ?? '', 40);
    this.themeSource = init?.themeSource ?? null;
    // 这是一条什么判断：episodic = 关于发生过的事；identity = 关于她自己是个什么样的人。
    // 身份判断也走全部闸、也会被推翻——不给后门。
    this.kind = init?.kind === 'identity' ? 'identity' : 'episodic';
    // 这一句说到哪一层了（模型自报，内核不猜）：
    //   pending 悬置 / understood 看明白 / settled 定下来 / acting 行动
    // null = 模型没说，当作「不知道」，按原规矩走（不改结论）。
    this.stage = STAGE_KEYS.includes(init?.stage) ? init.stage : null;
    this.subject = clean(init?.subject ?? '这一摊子事', 40);
    this.relation = init?.relation ?? null;
    this.polarity = init?.polarity === -1 ? -1 : 1;
    this.text = clean(init?.text ?? '', 120);
    this.why = clean(init?.why ?? '', 120);
    this.weight = clamp01(init?.weight, 0.3);
    this.imprint = init?.imprint ?? null;
    this.status = STATUS[String(init?.status ?? '').toUpperCase()] ?? STATUS.PENDING;
    this.createdAt = now;
    this.updatedAt = now;
    this.reasons = Array.isArray(init?.reasons) ? init.reasons.slice(0, 6) : [];
    this.tension = null;
    this.overturnedBy = null;
    this.overturnedReason = null;
    this.retireKind = null;  // RETIRE_REASON 之一：类型用字段判，不用文案判
    this.forgottenBecause = null;
    this.was = null;
    this.curiosityFired = 0;
    this.lastFired = null;   // 冷却的起点。初值必须是 null 不是 undefined，否则第一次冷却永远放行。
    this.fuseCount = 0;
    this.turns = [{
      at: now,
      relation: this.relation,
      polarity: this.polarity,
      text: this.text,
      weight: this.weight,
      status: this.status,
      via: init?.via ?? 'seed',
      changed: true,
      change: 'born',
    }];
  }

  /** 身份：同一个信念的三要素。不是字符串哈希，字符串变了身份可以不变。 */
  get identity() {
    return `${this.themeKey}|${this.subject}|${this.relation}|${this.polarity}`;
  }

  get signature() {
    return this.identity;
  }

  get latest() {
    return this.turns[this.turns.length - 1];
  }

  get alive() {
    return !this.demoted && (this.status === STATUS.PENDING || this.status === STATUS.HELD);
  }

  get age() {
    return Date.now() - this.updatedAt;
  }

  /** 判断对象只吐干净字段；生命周期的演变信息由 flash 在快照时补。 */
  toJSON() {
    return {
      id: this.id,
      themeKey: this.themeKey,
      themeSource: this.themeSource,
      kind: this.kind,
      subject: this.subject,
      relation: this.relation,
      polarity: this.polarity,
      text: this.text,
      why: this.why,
      weight: this.weight,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      reasons: [...this.reasons],
      tension: this.tension ? { ...this.tension } : null,
      overturnedBy: this.overturnedBy,
      overturnedReason: this.overturnedReason,
      retireKind: this.retireKind,
      forgottenBecause: this.forgottenBecause,
      curiosityFired: this.curiosityFired,
      fuseCount: this.fuseCount,
      turns: this.turns.map((t) => ({ ...t })),
    };
  }
}

/**
 * 演变的唯一判据。changed=false 的时候，text 换成什么花样的说法都不算演变。
 * @returns {{changed:boolean, cause:'text'|'relation'|'polarity'|'weight'|null, from?, to?}}
 */
export function changeOf(prev, next) {
  if (!prev) return { changed: true, cause: 'born' };
  if (prev.relation !== next.relation) return { changed: true, cause: 'relation', from: prev.relation, to: next.relation };
  if (prev.polarity !== next.polarity) return { changed: true, cause: 'polarity', from: prev.polarity, to: next.polarity };
  const delta = Math.abs((next.weight ?? 0) - (prev.weight ?? 0));
  if (delta >= 0.12) {
    return { changed: true, cause: 'weight', from: prev.weight, to: next.weight };
  }
  return { changed: false, cause: null, from: prev.weight, to: next.weight };
}

export function isSameBelief(b, { themeKey, relation, subject, polarity }) {
  return !!(b
    && b.themeKey === themeKey
    && b.relation === relation
    && b.subject === subject
    && b.polarity === polarity);
}

/**
 * 写法进档。每次熔出结论都留一笔（哪怕是同一句再讲一遍），但只有 changeOf
 * 认定为真变的才记 changed=true、才去碰 weight 之外的东西。
 */
export function recordTurn(belief, next, { at = Date.now(), via = 'synth' } = {}) {
  const ch = changeOf(belief, next);
  const entry = {
    at,
    relation: next.relation ?? belief.relation,
    polarity: next.polarity ?? belief.polarity,
    text: clean(next.text ?? belief.text, 120),
    weight: clamp01(next.weight, belief.weight),
    status: next.status ?? belief.status,
    via,
    changed: ch.changed,
    change: ch.cause,
  };
  belief.turns.push(entry);
  if (ch.changed) {
    if (ch.cause === 'relation' || ch.cause === 'polarity') {
      belief.text = entry.text;
      belief.why = clean(next.why ?? belief.why, 120);
      belief.relation = entry.relation;
      belief.polarity = entry.polarity;
    } else {
      // weight 型演变：话可以不变，但底气变了，也算变过。
      belief.text = entry.text;
    }
    belief.weight = entry.weight;
  } else {
    // 说法换了但立场没动：文案可以跟着更新，结论不算变。
    belief.text = entry.text;
    belief.weight = entry.weight;
  }
  belief.fuseCount += 1;
  belief.updatedAt = at;
  if (Array.isArray(next.reasons) && next.reasons.length) {
    for (const r of next.reasons) {
      const c = clean(r, 80);
      if (c && !belief.reasons.includes(c)) belief.reasons.push(c);
    }
    belief.reasons = belief.reasons.slice(-6);
  }
  return entry;
}

/** 状态迁移。被推翻的只能走 revoke，永远不会被这里删掉。 */
export function transition(belief, to, { at = Date.now(), reason = '', by = null, kind = null } = {}) {
  const allowed = LIFECYCLE[belief.status] ?? [];
  if (!allowed.includes(to)) {
    return { ok: false, from: belief.status, to, reason: 'invalid_transition' };
  }
  const from = belief.status;
  belief.status = to;
  belief.updatedAt = at;
  if (to === STATUS.ESTEEMED) {
    belief.overturnedBy = by;
    belief.overturnedReason = clean(reason, 100) || '我自己的证据推翻了它';
    belief.retireKind = kind ?? belief.retireKind ?? RETIRE_REASON.OVERTURNED;
    belief.tension = null;
  }
  if (to === STATUS.PENDING) {
    belief.tension = belief.tension ?? { since: at, why: '还没定下来' };
  }
  if (to === STATUS.HELD) {
    // 落定了，但「她惦记过这件事」的痕迹要留着：谁看过、看过几次、最后怎么看开的。
    // 抹掉它等于假装她没惦记过——判据和注入层都会看不见这段过程。
    if (belief.tension) {
      belief.settledFrom = { ...belief.tension, at };
    }
    belief.tension = null;
  }
  belief.turns.push({
    at,
    relation: belief.relation,
    polarity: belief.polarity,
    text: belief.text,
    weight: belief.weight,
    status: to,
    via: 'transition',
    changed: true,
    change: `status:${from}->${to}`,
  });
  return { ok: true, from, to };
}

export function setTension(belief, { since = Date.now(), why = '还没定下来' } = {}) {
  belief.tension = { since, why: clean(why, 80) };
  belief.updatedAt = since;
}

export function oldestAlive(beliefs) {
  let best = null;
  for (const b of beliefs) {
    if (!b || !b.alive) continue;
    if (!best || b.updatedAt < best.updatedAt) best = b;
  }
  return best;
}
