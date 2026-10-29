/**
 * budget.mjs —— 「可以去」和「可以一直去」是两件事。
 *
 * 五道闸，缺一道这个机制就会退化成挂机：
 *
 *   1 驱动闸    drive < 0.5 不去              一点念头就跑，那是 ADHD
 *   2 预算闸    一天 ≤ perDay 次，间隔 ≥ minGapMs
 *   3 主人优先闸 最近 ownerQuietMs 内有主人在说话 → 不 act
 *   4 产物闸    （在 preference.applyOutcome 里）收获型回来必须带回东西
 *   5 时长闸    （在执行侧）单次 act 有工具与 wall-clock 上限
 *
 * 第 3 条是最要紧的那条：**她的主动不能变成「叫她不理她」。**
 * 宁可少主动，不能让她在你说话的时候消失。
 */

export const BUDGET_DEFAULTS = Object.freeze({
  perDay: 3,
  minGapMs: 40 * 60 * 1000,
  /** 主人最近这么多久之内说过话，她就不出门 */
  ownerQuietMs: 10 * 60 * 1000,
  /** 单次 act 的 wall-clock 上限（执行侧用） */
  actTimeoutMs: 5 * 60 * 1000,
});

/** 本地日期的 key（跨零点重置预算）。 */
export function dayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 今天已经出去几回（跨天自动归零）。 */
export function usedToday(budget, now = Date.now()) {
  if (!budget || budget.dayKey !== dayKey(now)) return 0;
  return Number(budget.actsToday ?? 0) || 0;
}

/**
 * 这一回到底允不允许出去。
 * @returns {{ok:boolean, why:string, used:number}}
 */
export function canAct({ urge, budget = {}, now = Date.now(), lastOwnerAt = null, opts = {} } = {}) {
  const o = { ...BUDGET_DEFAULTS, ...opts };
  if (!urge) return { ok: false, why: 'no_urge', used: usedToday(budget, now) };
  if (Number(urge.drive ?? 0) < 0.5) return { ok: false, why: 'weak_drive', used: usedToday(budget, now) };

  // 3 主人优先：他刚说完话 / 正在等，她不许消失
  if (Number.isFinite(lastOwnerAt) && lastOwnerAt && now - lastOwnerAt < o.ownerQuietMs) {
    return { ok: false, why: 'owner_near', used: usedToday(budget, now) };
  }

  const used = usedToday(budget, now);
  if (used >= o.perDay) return { ok: false, why: 'daily_budget', used };
  if (Number.isFinite(budget.lastActAt) && budget.lastActAt && now - budget.lastActAt < o.minGapMs) {
    return { ok: false, why: 'cooldown', used };
  }
  return { ok: true, why: 'ok', used };
}

/** 记下这一回出去了。 */
export function recordAct(budget = {}, { now = Date.now(), urge = null } = {}) {
  const key = dayKey(now);
  const used = usedToday(budget, now);
  return {
    ...budget,
    dayKey: key,
    actsToday: used + 1,
    lastActAt: now,
    lastActivity: urge?.activity ?? null,
    lastKind: urge?.kind ?? null,
    // ★ 2026-10-28：留一份「最近去过哪」的行动记录。
    //   `motive.urges()` 拿它判「今天已经去过了」，好让同一条悬案别天天霸榜
    //   （回放时她两天出去 7 次、7 次都是同一件事——就是这个洞）。
    recentActs: [
      ...(Array.isArray(budget.recentActs) ? budget.recentActs : []),
      { at: now, target: urge?.target ?? null, activity: urge?.activity ?? null, kind: urge?.kind ?? null },
    ].slice(-20),
  };
}

export function createBudget(opts = {}) {
  return {
    ...BUDGET_DEFAULTS,
    ...opts,
    canAct: (p) => canAct({ ...p, opts: { ...opts, ...(p.opts ?? {}) } }),
    recordAct,
    usedToday,
    dayKey,
  };
}
