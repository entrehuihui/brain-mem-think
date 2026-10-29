/**
 * preference.mjs —— 「我喜欢做什么」只能靠做完了才知道。
 *
 * ======================= 它为什么必须存在 =======================
 *
 * 她现在的库里没有任何「我喜欢什么」——因为她什么都没做过。
 * 「想刷电视剧」这个念头，前提是**她有过一次看剧的经历，而且记得那次的滋味**。
 *
 * 所以偏好只有一条路：做过 → 结算 → 想不想再做。
 *
 * ======================= 两种活动，两种「算不算白做」 =======================
 *
 *   resolve（想去弄明白）  这是「收获型」：回来必须带回点什么——
 *                          判断库多了一条、或者那件事有了进展。没有就是空转。
 *   indulge（想去做点什么）这是「满足型」：做了本身就是回报。
 *                          刷剧没学到东西也是合法的，不需要交作业。
 *
 * 用同一把尺去量这两种，要么逼她说每部剧都教会了她什么（假），
 * 要么让她一直空转（废）。所以分成两套判据。
 */

import { clamp01 } from './judge.mjs';

export const PREF_DEFAULTS = Object.freeze({
  /** 第一次做某件事，先给这个底子 */
  start: 0.35,
  /** 有收获 / 满足了，加多少 */
  gain: 0.08,
  /** 空转（收获型没带回东西），扣多少 */
  lose: 0.2,
  /** 最多保留几条偏好 */
  maxPrefs: 24,
});

function findOrCreate(list, activity, o) {
  let p = list.find((x) => x && x.activity === activity);
  if (!p) {
    p = { activity, strength: o.start, times: 0, lastEnjoyed: null, reason: '', lastKind: null };
    list.push(p);
  }
  return p;
}

/**
 * 结算一次「出去」。
 *
 * @param {object[]} prefs     偏好表（会被就地改）
 * @param {object} p
 * @param {string} p.activity
 * @param {'resolve'|'indulge'} p.kind
 * @param {boolean} p.found    收获型：这次有没有带回东西；满足型传 true
 * @param {string} [p.reason]  这次她自己的理由（写进偏好，下次当 why 用）
 * @param {number} [p.now]
 * @returns {object} 更新后的那条偏好
 */
export function applyOutcome(prefs, { activity, kind = 'indulge', found = true, reason = '', now = Date.now() } = {}, opts = {}) {
  const o = { ...PREF_DEFAULTS, ...opts };
  const list = Array.isArray(prefs) ? prefs : [];
  if (!activity) return null;
  const p = findOrCreate(list, String(activity), o);
  const hit = kind === 'indulge' ? true : !!found;
  p.times = Number(p.times ?? 0) + 1;
  p.lastEnjoyed = now;
  p.lastKind = kind;
  if (reason) p.reason = String(reason).slice(0, 60);
  p.strength = clamp01(Number(p.strength ?? o.start) + (hit ? o.gain : -o.lose));
  // 瘦身：留份量最高的那几条，别让偏好表变成第二个无限长的库
  if (list.length > o.maxPrefs) {
    list.sort((a, b) => Number(b.strength ?? 0) - Number(a.strength ?? 0));
    list.splice(o.maxPrefs);
  }
  return p;
}

/** 只读：某条偏好现在还想不想（给调试和测试用）。 */
export function desireOf(pref, now = Date.now()) {
  if (!pref) return 0;
  const half = 30 * 86400e3;
  const age = Math.max(0, now - Number(pref.lastEnjoyed ?? 0));
  return clamp01(Number(pref.strength ?? 0) * Math.exp(-age / half));
}

export function createPreference(opts = {}) {
  return {
    ...PREF_DEFAULTS,
    ...opts,
    apply: (prefs, p) => applyOutcome(prefs, p, opts),
    desireOf,
  };
}
