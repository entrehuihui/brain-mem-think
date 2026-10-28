/**
 * event.mjs —— 把「一条判断」拆成可统计的结构，让内核自己会数。
 *
 * ======================= 它为什么必须存在 =======================
 *
 * 现在整条链是这样的：
 *
 *   主人说话 → [模型] → 一条判断（text/why/relation/subject/polarity/weight）→ 库
 *
 * 判断的**内容**全由模型给，内核只做过滤。这叫「存储器」，不叫「会判断」。
 *
 * 要让它自己判断，得先让内核手里有一份**能数的东西**：
 * 不是一段话，是一组 (谁 / 做了什么 / 什么方向) 的记录。
 * 数得出「同一个人同一个动作，我见过 5 回，4 回是这个方向」，
 * 才谈得上「我认为他就是这样」——那是内核自己得出的，不是谁告诉它的。
 *
 * ======================= 事件从哪来 =======================
 *
 * 不额外调模型。`digestSession` 熔出来的每一条判断，本身就是一份结构化记录：
 * relation 是动作、subject 是对象、polarity 是方向。
 * 所以：**一条判断入库 = 一次观测入账**。
 *
 * 模型仍然负责「把这段经历理解成一个动作 + 一个方向」——
 * 这一步离开语言理解做不到，硬用规则抽只会抽出一堆垃圾。
 * 但它不再负责「这意味着什么、我有多确定」——那两样交给内核数。
 *
 *   [模型] 把经历理解成 (谁, 动作, 方向)
 *   [内核] 数重复、算一致、定份量、判该不该悬着
 *   [模型] 把结论说成她的话
 *
 * 这是「判断权归内核」的实际落脚点。
 */

import { createHash } from 'node:crypto';

/** 一条观测。只存结构 + 正文摘要，不存原文。 */
export function makeEvent({
  seq = 0,
  at = Date.now(),
  actor = '',
  action = '',
  polarity = 1,
  text = '',
  themeKey = null,
  source = 'digest',
  weight = 0,
  beliefId = null,
} = {}) {
  return {
    seq,
    at,
    // 「谁」——归一后可能是「他 / 我 / 主人 / 这摊事」
    actor: String(actor ?? '').trim() || '这摊事',
    // 「做了什么」——谓词闭集里的一个
    action: String(action ?? '').trim() || 'unknown',
    // 「往哪个方向」：+1 / -1
    polarity: Number(polarity) === -1 ? -1 : 1,
    // 正文摘要（判断自己的话，不是原文）
    text: String(text ?? '').slice(0, 120),
    themeKey: themeKey ?? null,
    // 这次观测从哪来：digest（归档熔）/ synth（逐条熔）/ self（她自己的行为，阶段 D 才有）
    source: String(source ?? 'digest'),
    weight: Number(weight) || 0,
    // 这条 event 是从哪条判断来的（用来回溯「我想的是什么」）
    beliefId: beliefId ?? null,
  };
}

/** 从一条 Belief 造一条 event。一条判断入库，就是一次观测入账。 */
export function eventFromBelief(b, { seq = 0, source = 'digest' } = {}) {
  if (!b) return null;
  return makeEvent({
    seq,
    at: Number(b.createdAt) || Date.now(),
    actor: b.subject,
    action: b.relation,
    polarity: b.polarity,
    text: b.text,
    themeKey: b.themeKey,
    source,
    weight: b.weight,
    beliefId: b.id,
  });
}

/** 分组键：「同一个人 + 同一个动作」才算同一件事的重复。 */
export function groupKey(e) {
  return `${String(e?.actor ?? '')}|${String(e?.action ?? '')}`;
}

/** 只存结构指纹，不存原文；用来判「这条观测是不是同一次」。 */
export function eventHash(e) {
  return createHash('sha1')
    .update(`${e?.actor}|${e?.action}|${e?.polarity}|${e?.at}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * 只存该存的：events 会跟着判断库一起落盘，所以字段要收窄，
 * 不能把整条判断塞进去（那等于把库存两遍）。
 */
export function eventToJson(e) {
  return {
    seq: e.seq,
    at: e.at,
    actor: e.actor,
    action: e.action,
    polarity: e.polarity,
    text: e.text,
    themeKey: e.themeKey,
    source: e.source,
    weight: e.weight,
    beliefId: e.beliefId,
  };
}

export function eventFromJson(o) {
  return makeEvent(o ?? {});
}
