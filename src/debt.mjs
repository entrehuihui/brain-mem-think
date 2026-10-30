/**
 * debt.mjs —— 主动性·欠账：被闸挡回来的那件事，不许就这么没了。
 *
 * ======================= 它为什么必须存在 =======================
 *
 * 熔料那条路早就想通了这件事（`digestDebtAt`）：**欠账不是「晚点做」，
 * 是「等它一空立刻就做」**。主动性这条路一直没有这一层，于是：
 *
 *   2026-10-30 实测 24 小时：她想去做 131 次、真出门 3 次、被挡 267 次。
 *   那 267 次里每一件都只在 pending 上躺一拍，下一拍被结算成
 *   「我想…，没去成」，然后就**彻底消散**——没有一件被补上过。
 *
 * 所以这里记一本欠账：被挡的事挂在这里，**不随结算清掉**。
 * 闸一空（预算回来、主人走了、她自己闲下来），第一拍就补做。
 *
 * ======================= 什么时候放手 =======================
 *
 * 三条，缺一条这本账就会变成第二位朋友圈：
 *
 *   ① 真出门做了          → 还上了，清掉（在 index.mjs 里做）
 *   ② 放了 6 小时          → 那口气已经过了，再补也是硬凑
 *   ③ 同一件事被挡够 3 次   → 和 urges 的 fruitlessPenalty 一个意思：
 *                            试过不行就放手，不是不重要，是硬凑
 *
 * ======================= 为什么只认字面相同 =======================
 *
 * 她的 activity 是模型每次用不同措辞写的（「给我妈打个电话」/
 * 「把那个电话拨出去」/「找个安静地方打电话」）。要做相似度归并很容易
 * 把不相干的事并在一起，也容易因为改一个字就漏并。
 * 宁可漏合并（多记一条欠账），不要为了合并去搞一套玄学相似度。
 */

/** 欠账活多久：6 小时。 */
export const DEBT_TTL_MS = 6 * 3600e3;

/** 同一件事被挡几次就放手。 */
export const DEBT_MAX_TRIES = 3;

/**
 * 记一笔欠账。纯函数：返回新的欠账对象（或 null 表示放手），不改入参。
 *
 * @param {object|null} debt   现有欠账
 * @param {{activity?:string, why?:string, kind?:string}} want 这次被挡的念头
 * @param {string} blockedBy   被哪道闸挡的（daily_budget / owner_near / ...）
 * @param {number} at          现在
 * @returns {object|null}
 */
export function noteDebt(debt, want, blockedBy, at = Date.now()) {
  const activity = String(want?.activity ?? '').trim();
  // 没说要做什么，就没有可欠的东西 —— 不许凭空造一条欠账出来。
  if (!activity) return debt ?? null;

  const same = !!debt && String(debt.activity ?? '') === activity;
  const tries = (same ? Number(debt.tries ?? 0) : 0) + 1;
  // 试够次数了：放手。返回 null 会让调用方把这条欠账清掉。
  if (tries > DEBT_MAX_TRIES) return null;

  return {
    // at = **第一次**被挡的时刻（过期按它算，不按最后一次——
    // 否则一件永远挡着的事能靠不停刷新把自己续命）
    at: same ? Number(debt.at ?? at) : at,
    lastAt: at,
    activity,
    why: String(want?.why ?? ''),
    kind: String(want?.kind ?? 'want'),
    blockedBy: String(blockedBy ?? ''),
    tries,
  };
}

/** 这笔欠账现在还算数吗（还活着、还没过期）。 */
export function debtAlive(debt, at = Date.now()) {
  if (!debt || !debt.activity) return false;
  const since = Number(debt.at ?? 0);
  if (!Number.isFinite(since) || since <= 0) return false;
  return at - since < DEBT_TTL_MS;
}

/** 给账本看的一行摘要（没有欠账就返回 null，不补默认话）。 */
export function debtLine(debt, at = Date.now()) {
  if (!debtAlive(debt, at)) return null;
  const min = Math.max(0, Math.round((at - Number(debt.at)) / 60000));
  return `欠着：${debt.activity}（被 ${debt.blockedBy || '闸'} 挡了 ${debt.tries} 次，已经 ${min} 分钟）`;
}
