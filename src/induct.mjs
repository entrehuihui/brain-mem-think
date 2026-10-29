/**
 * induct.mjs —— 内核自己数出判断。不调模型。
 *
 * ======================= 它到底在做什么 =======================
 *
 * 拿到一串观测（谁 / 做了什么 / 哪个方向 / 什么时候），按「同一个人 + 同一个动作」分组，
 * 然后回答三个问题：
 *
 *   1. 见够回数了吗？        support ≥ 3
 *   2. 方向够一致吗？        consistency ≥ 0.7
 *   3. 该定下来还是该悬着？  一致 → 定；不够一致 → 悬（这是真悬案，不是模型说悬才悬）
 *
 * 全程只有计数和除法。**没有一句自然语言，也没有一次模型调用。**
 *
 * ======================= 为什么这件事必须由内核做 =======================
 *
 * 因为「我信什么」不能由那个正在跟我说话的东西决定。
 * 模型擅长的是「把这段经历理解成什么动作」，它不擅长、也不该决定
 * 「这个动作我见过几回、够不够我下结论」——那是账，账要自己算。
 *
 * 所以分工是：
 *   [模型] 把经历理解成 (谁, 动作, 方向)   ← 需要语言理解，绕不开
 *   [内核] 数、算、定                      ← 这部分从此不归它
 *   [模型] 把结论说成她的话                ← 表达
 *
 * ======================= 归纳出来的判断，跟模型的判断怎么并 =======================
 *
 * `reconcile()` 做四分类，每一类都留痕：
 *
 *   confirmed  两边一致        → 加固，份量按证据算
 *   contested  方向相反        → 记冲突，不静默吞掉（这是「她会顶嘴」的机制基础）
 *   novel      内核数出来了、模型没给过 → **内核独立发现的判断**
 *   thin       模型给了、内核没数够     → 保留，但标注「证据不足」
 *
 * `novel` 那一条最要紧：那是「她不同意模型」的地方。
 * 它能存在，才说明判断权真的不在模型手里。
 */

import { groupKey } from './event.mjs';

export const INDUCT_DEFAULTS = Object.freeze({
  /** 至少见过几回才敢下结论 */
  minSupport: 3,
  /** 同一个方向占几成才算「方向明确」 */
  minConsistency: 0.7,
  /** 只看最近这段时间的观测：太老的账不参与归纳 */
  windowMs: 30 * 86400e3,
  /** 最多产出几条候选（防止一口气冒出几十条） */
  maxCandidates: 20,
});

/**
 * 从观测里自己数出判断。
 *
 * @param {object[]} events  event.mjs 的观测
 * @param {object}   [opts]
 * @returns {{
 *   claims: Array<{actor,action,polarity,support,consistency,evidence:number[],text,themeKey}>,
 *   pendings: Array<{actor,action,support,consistency,evidence:number[],text,split:{pos:number,neg:number}}>,
 *   groups: number
 * }}
 */
export function induce(events, opts = {}) {
  const o = { ...INDUCT_DEFAULTS, ...opts };
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const live = (Array.isArray(events) ? events : [])
    .filter((e) => e && Number.isFinite(Number(e.at)))
    .filter((e) => now - Number(e.at) <= o.windowMs);
  if (!live.length) return { claims: [], pendings: [], groups: 0 };

  const buckets = new Map();
  for (const e of live) {
    const k = groupKey(e);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(e);
  }

  const claims = [];
  const pendings = [];

  for (const [, list] of buckets) {
    const n = list.length;
    if (n < o.minSupport) continue;
    const pos = list.filter((e) => Number(e.polarity) > 0).length;
    const neg = n - pos;
    const consistency = Math.max(pos, neg) / n;
    const majority = pos >= neg ? 1 : -1;
    // ★ 代表正文要取「多数方向里最近的那条」，不能直接取全组最近的那条：
    //   否则会出现「结论是负的、正文却引用了一句正向的话」——
    //   实测就是这么错配的（5 条里 4 负 1 正，正文引了那条唯一的正的）。
    const side = list.filter((e) => Number(e.polarity) === majority);
    const latest = [...(side.length ? side : list)].sort((a, b) => Number(b.at) - Number(a.at))[0];
    const base = {
      actor: latest.actor,
      action: latest.action,
      support: n,
      consistency: Number(consistency.toFixed(3)),
      evidence: list.map((e) => Number(e.seq)).filter(Number.isFinite),
      text: latest.text,
      themeKey: latest.themeKey,
      since: Math.min(...list.map((e) => Number(e.at))),
      lastAt: Math.max(...list.map((e) => Number(e.at))),
    };
    if (consistency >= o.minConsistency) {
      claims.push({ ...base, polarity: pos >= neg ? 1 : -1 });
    } else {
      // 方向不统一：这是**真悬案**——数得出来见过几回，但数不出一个方向。
      // 跟「模型说它还拿不准」不是一回事：这个悬案有证据，只是证据互相打架。
      pendings.push({ ...base, split: { pos, neg } });
    }
  }

  const byDrive = (a, b) => (b.support * b.consistency) - (a.support * a.consistency);
  return {
    claims: claims.sort(byDrive).slice(0, o.maxCandidates),
    pendings: pendings.sort(byDrive).slice(0, o.maxCandidates),
    groups: buckets.size,
  };
}

/**
 * 把内核归纳的结果跟库里的判断对账。
 *
 * @param {{claims:Array, pendings:Array}} induct
 * @param {object[]} beliefs 现役判断（要有 themeKey / polarity / relation / subject / text）
 * @returns {{confirmed:[], contested:[], novel:[], thin:[]}}
 */
export function reconcile(induct, beliefs = []) {
  const live = (Array.isArray(beliefs) ? beliefs : [])
    .filter((b) => b && (b.status === 'pending' || b.status === 'open' || b.status === 'held'));
  const keyOf = (x) => `${String(x?.actor ?? x?.subject ?? '')}|${String(x?.action ?? x?.relation ?? '')}`;

  const byKey = new Map();
  for (const b of live) {
    const k = keyOf(b);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(b);
  }

  const confirmed = [];
  const contested = [];
  const novel = [];
  const thin = [];
  const matched = new Set();

  for (const c of induct?.claims ?? []) {
    const k = `${c.actor}|${c.action}`;
    const mine = byKey.get(k) ?? [];
    if (!mine.length) {
      // ★ 内核数出来了，模型从没给过这条：她自己的判断。
      novel.push({ ...c, why: `我见过 ${c.support} 回，${Math.round(c.consistency * 100)}% 是同一个方向` });
      continue;
    }
    matched.add(k);
    const same = mine.find((b) => Number(b.polarity) === Number(c.polarity));
    if (same) {
      confirmed.push({ candidate: c, beliefId: same.id });
    } else {
      // 模型给的是反方向。不静默吞，也不立刻翻——留成冲突，等下一次观测。
      contested.push({
        candidate: c,
        beliefId: mine[0].id,
        beliefPolarity: Number(mine[0].polarity),
        candidatePolarity: Number(c.polarity),
        because: `我数了 ${c.support} 回，${Math.round(c.consistency * 100)}% 是 ${c.polarity > 0 ? '正' : '负'}的；库里那条说的是反的`,
      });
    }
  }

  // 内核数出来是「悬案」的也算「对上了这条」，否则它会被误报成「证据不足」。
  // （顺序曾经错过一次：thin 在 pending 之前跑，同一条同时挂在「冲突」和「证据不足」两栏。）
  for (const p of induct?.pendings ?? []) matched.add(`${p.actor}|${p.action}`);

  // 模型给了、但内核没数够的证据 → 标注出来，不删（可能是新方向，也可能是一条证据不足的结论）
  for (const b of live) {
    const k = keyOf(b);
    if (matched.has(k)) continue;
    thin.push({ beliefId: b.id, themeKey: b.themeKey, text: b.text, why: '内核数不出这个方向的一致证据' });
  }

  // 内核数出来是「悬案」的，如果库里有对应判断且是 held，也记一笔
  for (const p of induct?.pendings ?? []) {
    const k = `${p.actor}|${p.action}`;
    const mine = byKey.get(k) ?? [];
    matched.add(k);
    if (!mine.length) {
      // 内核数出来是个悬案，而库里连这条都没有 → 这也是它自己的发现（只是还悬着）
      novel.push({ ...p, polarity: null, why: `我见过 ${p.support} 回，${p.split.pos} 正 ${p.split.neg} 负——定不下来，但这事有数` });
      continue;
    }
    contested.push({
      candidate: p,
      beliefId: mine[0].id,
      beliefPolarity: Number(mine[0].polarity),
      candidatePolarity: null,
      because: `我数了 ${p.support} 回，${p.split.pos} 正 ${p.split.neg} 负——方向定不下来，库里那条却已经定了`,
    });
  }

  return { confirmed, contested, novel, thin };
}

export function createInduct(opts = {}) {
  return {
    ...INDUCT_DEFAULTS,
    ...opts,
    induce: (events) => induce(events, { ...opts }),
    reconcile: (i, b) => reconcile(i, b),
  };
}
