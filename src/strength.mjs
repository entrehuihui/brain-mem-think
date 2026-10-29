/**
 * strength.mjs —— 一条判断的「底气」，是从证据算出来的，不是模型随口给的。
 *
 * ======================= 它为什么必须存在 =======================
 *
 * 2026-10-28 评审查出来的第 3 条钳制：
 *
 *   `weight` 从模型 JSON 里透传到 `Belief.weight`，然后直接决定
 *   fade 淘汰谁、wake 觉得谁压得重、world 排谁在前面、curiosity 判该不该认了。
 *
 *   模型随口给 0.7，她就「很在意」；给 0.3，那条就该被挤掉。
 *   **那不是判断，是采样。** 同一份输入跑两次得两个答案，那不叫记忆，叫抽签。
 *
 * ======================= 只加一个字段，不改 weight =======================
 *
 * 两个数分开存，谁都不许混：
 *
 *   weight   = 模型觉得这件事多重（`hint`，只当上限参考，可以审计它偏了多少）
 *   strength = 证据算出来的底气（**所有决策只认它**）
 *
 * 这么做的好处：向后兼容。老数据里没有 `strength` 时，读的地方一律
 * `strength ?? weight` 回退，跨版本不会炸。
 *
 * ======================= 公式怎么来的 =======================
 *
 * 四个维度，加起来是 1.0，每一项都能单独审计「这条为什么重」：
 *
 *   support     0.45  见过几回。第 1 条不算数，5 条撑满。
 *   consistency 0.30  同一个方向占几成。只见过 1 条时算「不知道」= 0.5，不算满分。
 *   variety     0.10  几个来源（digest / synth）。单一来源容易偏，多来源更可信。
 *   recency     0.15  最近一次多久前。30 天半衰。
 *
 *   再乘一个反例惩罚：1 / (1 + 反例数 × 0.6)。
 *
 * 几个校准点（拿它跟原来的行为对齐，免得改完她整个人都变轻或变重）：
 *
 *   第 1 条证据            → 0.35   （原来 Belief 默认 0.30，接近）
 *   3 条一致               → 0.72
 *   5 条一致               → 0.95
 *   5 条里 3 正 2 反       → 0.37   （反例一多就掉下来，这是要的）
 *   1 条 + 30 天没动       → 0.28
 */

import { clamp01 } from './judge.mjs';

export const STRENGTH_DEFAULTS = Object.freeze({
  /** 几条证据算「撑满」 */
  supportCeil: 5,
  /** 30 天没动，新鲜度掉一半 */
  recencyHalfLifeMs: 30 * 86400e3,
  /** 每多一条反例，底气打这个折 */
  counterPenalty: 0.6,
  /** 四维权重，和为 1 */
  weights: Object.freeze({ support: 0.45, consistency: 0.30, variety: 0.10, recency: 0.15 }),
});

/** 状态迁移记的那笔账不是证据：它只说明「状态变了」，不说明「又看到一回」。 */
function isEvidence(turn) {
  if (!turn || typeof turn !== 'object') return false;
  return !String(turn.change ?? '').startsWith('status:');
}

/**
 * 纯函数版：给一组证据，算底气。
 *
 * @param {object} p
 * @param {object[]} p.turns     证据（Belief.turns）
 * @param {number}   p.polarity  这条判断现在的立场
 * @param {string[]} [p.sources] 每次证据的来源（via）
 * @param {number}   [p.now]
 * @returns {number} 0~1
 */
export function strengthOf({ turns = [], polarity = 1, now = Date.now(), opts = {} } = {}) {
  const o = { ...STRENGTH_DEFAULTS, ...opts };
  const w = o.weights;
  const evidence = turns.filter(isEvidence);
  const n = evidence.length;
  if (!n) return 0;

  const sameSide = evidence.filter((t) => Number(t.polarity) === Number(polarity)).length;
  const counter = n - sameSide;

  // 1 条证据时 support=0、consistency=0.5（不知道），于是落回 0.35 左右。
  const support = Math.min(1, Math.max(0, (n - 1) / (o.supportCeil - 1)));
  const consistency = n >= 2 ? sameSide / n : 0.5;

  // 来源：只算真证据的来源，去重。「seed / synth / digest」三种都算。
  const via = new Set(evidence.map((t) => String(t.via ?? 'unknown')));
  const variety = via.size >= 2 ? 1 : 0.5;

  const lastAt = Math.max(
    ...evidence.map((t) => Number(t.at) || 0),
    0,
  );
  const recency = lastAt ? Math.exp(-Math.max(0, now - lastAt) / o.recencyHalfLifeMs) : 0;

  const base = w.support * support
    + w.consistency * consistency
    + w.variety * variety
    + w.recency * recency;
  const clean = 1 / (1 + counter * o.counterPenalty);
  return Number(clamp01(base * clean).toFixed(4));
}

/** Belief 实例版：从它自己的 turns 算。 */
export function strengthOfBelief(b, now = Date.now()) {
  if (!b) return 0;
  return strengthOf({
    turns: Array.isArray(b.turns) ? b.turns : [],
    polarity: b.polarity,
    now,
  });
}

/**
 * 从「内核数出来的证据」直接算底气。
 *
 * ★ 2026-10-28（阶段 C·D）：给归纳出来的判断用。
 *   它没有 turns（不是从某一次经历熔的），但有一份统计：
 *   「见过 n 回、一致率多少、最近一次什么时候」。
 *   这三个数跟 turns 能提供的信息是同一套，所以走同一个公式。
 *
 * @param {object} p
 * @param {number} p.support      见过几回
 * @param {number} p.consistency  一致率 0~1
 * @param {number} [p.lastAt]     最近一次的观测时间
 * @param {number} [p.now]
 */
export function strengthFromEvidence({ support = 0, consistency = 0.5, lastAt = 0, now = Date.now() } = {}, opts = {}) {
  const o = { ...STRENGTH_DEFAULTS, ...opts };
  const w = o.weights;
  const n = Number(support) || 0;
  if (!n) return 0;
  const sup = Math.min(1, Math.max(0, (n - 1) / (o.supportCeil - 1)));
  const cons = n >= 2 ? Math.min(1, Math.max(0, Number(consistency) || 0)) : 0.5;
  const variety = 0.5;   // 归纳这条路上暂时没有多来源，不虚报
  const recency = lastAt ? Math.exp(-Math.max(0, now - Number(lastAt)) / o.recencyHalfLifeMs) : 0;
  const base = w.support * sup + w.consistency * cons + w.variety * variety + w.recency * recency;
  return Number(clamp01(base).toFixed(4));
}

/**
 * 审计用：把四维拆开报出来。给「她为什么这么想」的回答提供可读的依据。
 * @returns {{value:number, support:number, consistency:number, variety:number, recency:number, counter:number, supportCount:number}}
 */
export function explainStrength(b, now = Date.now(), opts = {}) {
  const o = { ...STRENGTH_DEFAULTS, ...opts };
  const w = o.weights;
  const evidence = (Array.isArray(b?.turns) ? b.turns : []).filter(isEvidence);
  const n = evidence.length;
  const sameSide = evidence.filter((t) => Number(t.polarity) === Number(b?.polarity)).length;
  const counter = n - sameSide;
  const support = Math.min(1, Math.max(0, (n - 1) / (o.supportCeil - 1)));
  const consistency = n >= 2 ? sameSide / n : 0.5;
  const via = new Set(evidence.map((t) => String(t.via ?? 'unknown')));
  const variety = via.size >= 2 ? 1 : 0.5;
  const lastAt = Math.max(...evidence.map((t) => Number(t.at) || 0), 0);
  const recency = lastAt ? Math.exp(-Math.max(0, now - lastAt) / o.recencyHalfLifeMs) : 0;
  return {
    value: strengthOfBelief(b, now),
    supportCount: n,
    support: Number((w.support * support).toFixed(4)),
    consistency: Number((w.consistency * consistency).toFixed(4)),
    variety: Number((w.variety * variety).toFixed(4)),
    recency: Number((w.recency * recency).toFixed(4)),
    counter,
    sources: [...via],
  };
}

export function createStrength(opts = {}) {
  return {
    ...STRENGTH_DEFAULTS,
    ...opts,
    of: (turns, polarity, now) => strengthOf({ turns, polarity, now, opts }),
    ofBelief: (b, now) => strengthOfBelief(b, now),
    explain: (b, now) => explainStrength(b, now, opts),
  };
}
