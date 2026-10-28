/**
 * sting.mjs —— 扎心度：被戳到的那一下，不该因为「只发生过一次」被算轻。
 *
 * ======================= 它为什么必须存在 =======================
 *
 * `strength` 的四个维度全是「次数型」的：见过几回、方向多一致、几个来源、多久以前。
 * 这套很公平，但公平得不像人：
 *
 *   一件事只发生了一次，可那一次把她整个人都改了；
 *   另一件事她见了十回，每回都是同一句轻飘飘的话。
 *   按 support 算，后者更重。**这就是错的。**
 *
 * 所以扎心度和底气**分开算**：
 *
 *   strength = 证据有多硬（次数、一致、来源、新鲜）——决定「信不信」
 *   sting    = 那一下有多疼（当场情绪强度）——决定「放不放得下」
 *
 * ======================= 三条纪律 =======================
 *
 * ① **不看次数。** 取关联经历里 arousal 的**最大值**，不取平均、不累加。
 *    一次 0.9 的事，永远比十次 0.2 的事更扎心——这跟见过几回无关。
 *
 * ② **没有关联就不猜。** 找不到同一主题的经历时 sting = 0（「不知道」），
 *    不许拿 weight 顶上——那又变成模型随口给的数了。
 *
 * ③ **它只影响「排在哪、放不放手」，不影响「信不信」。**
 *    fade 的护盾、wake 的 burden、world 的排序读它；strength 的公式一个字不改。
 */

import { clamp01 } from './judge.mjs';

export const STING_DEFAULTS = Object.freeze({
  /** 扎心度高于这条线，才算「被戳到过」 */
  high: 0.75,
  /** 扎心度差到这个数以上，才触发「护盾」：不让位给平淡的新事 */
  shieldGap: 0.3,
  /** 久到一定程度会淡：90 天没再被碰到，情绪减半 */
  fadeHalfLifeMs: 90 * 86400e3,
});

/** 一条经历能不能算到这条判断头上：同主题键（最硬），或同一对象且经历没主题键（退一步）。 */
function related(belief, ep) {
  if (!belief || !ep) return false;
  const key = String(belief.themeKey ?? '');
  const epKey = String(ep.themeKey ?? '');
  if (key && epKey && key === epKey) return true;
  const subj = String(belief.subject ?? '');
  if (!epKey && subj && String(ep.who ?? '') === subj) return true;
  return false;
}

/**
 * 算一条判断的扎心度。
 *
 * @param {object} belief  判断（要 themeKey / subject / createdAt）
 * @param {object[]} episodes 经历（要 arousal / who / themeKey / at）
 * @param {{now?:number, limits?:object}} [ctx]
 * @returns {number} 0~1
 */
export function stingOf(belief, episodes = [], ctx = {}) {
  const o = { ...STING_DEFAULTS, ...(ctx.limits ?? {}) };
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  if (!belief) return 0;
  let best = 0;
  let bestAt = 0;
  for (const ep of Array.isArray(episodes) ? episodes : []) {
    if (!ep || !Number.isFinite(Number(ep.arousal))) continue;
    if (!related(belief, ep)) continue;
    const a = clamp01(ep.arousal);
    if (a > best) { best = a; bestAt = Number(ep.at) || 0; }
  }
  if (best <= 0) return 0;
  // 淡：90 天没再被碰到，情绪减半（只减一半，不是抹掉——疼过的事不会完全变淡）
  if (bestAt > 0 && now - bestAt > o.fadeHalfLifeMs) {
    const years = (now - bestAt) / o.fadeHalfLifeMs;
    return clamp01(best * (0.5 + 0.5 / (1 + years)));
  }
  return clamp01(best);
}

/** 给一批判断算一遍，返回 { id → sting }。 */
export function stingMap(beliefs, episodes, ctx = {}) {
  const out = {};
  for (const b of Array.isArray(beliefs) ? beliefs : []) {
    if (b?.id) out[b.id] = stingOf(b, episodes, ctx);
  }
  return out;
}

/**
 * 让位护盾：这条「最弱」的会不会因为太扎心而不让位。
 *
 * 条件是**双重的**：它自己够扎心，而且新来的不够扎心。
 * 只判前一半的话，两条都扎心时旧的照样被挤——那不是「保护」，是「永远不改」。
 */
export function shielded(weakest, incoming, ctx = {}) {
  const o = { ...STING_DEFAULTS, ...(ctx.limits ?? {}) };
  const a = clamp01(weakest?.sting ?? 0);
  const b = clamp01(incoming?.sting ?? 0);
  return a >= o.high && a - b >= o.shieldGap;
}

/** 排序用的「份量」：底气为主，扎心度做加成（最多 +40%）。 */
export function weightWithSting(note, ctx = {}) {
  const base = clamp01(note?.strength ?? note?.weight ?? 0);
  const sting = clamp01(note?.sting ?? 0);
  return clamp01(base * (1 + 0.4 * sting));
}
