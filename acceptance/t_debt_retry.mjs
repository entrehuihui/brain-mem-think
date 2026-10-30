/**
 * t_debt_retry —— 被闸挡回来的那件事，要么被补做，要么被干净地放掉。
 *
 * ======================= 为什么要有这一条 =======================
 *
 * 主人原话（2026-10-30）：「要让主动性真落地」。
 *
 * 查下来最扎人的一组数（24 小时）：
 *   她想去做 131 次 · 真出门 3 次 · 被闸挡回 267 次
 * 而被挡的每一件都只在 pending 上躺一拍，下一拍被结算成
 * 「我想…，没去成」，然后**彻底消散**——没有一件被补上过。
 *
 * 所以加了欠账（src/debt.mjs）：挡下来挂着，闸一空就补做。
 *
 * ======================= 这套判据在咬什么 =======================
 *
 * 一本账只要没人管，就会烂成两种样子，两头都要咬住：
 *   ① **烂在手里**：什么都记、永远不过期 → 她一天到晚补做三天前的事
 *   ② **纸糊的**：一挡就丢、或者到期时间被自己刷新的空子续命 → 等于没有
 *
 * 六条行为 + 一条负控制。
 */

import {
  noteDebt, debtAlive, debtLine, DEBT_TTL_MS, DEBT_MAX_TRIES,
} from '../src/debt.mjs';

let fails = 0;
let passes = 0;
const ok = (name, cond, detail) => {
  if (cond) { passes += 1; console.log(`  [PASS] ${name}  ${detail ?? ''}`); }
  else { fails += 1; console.log(`  [FAIL] ${name}  ${detail ?? ''}`); }
};

const T0 = 1_800_000_000_000;

// ① 第一次被挡：记下来，带着挡它的那道闸
const d1 = noteDebt(null, { activity: '给我妈打个电话', why: '想听她声音' }, 'daily_budget', T0);
ok('debt.first_recorded',
  d1 && d1.activity === '给我妈打个电话' && d1.tries === 1 && d1.blockedBy === 'daily_budget',
  '第一次被挡就挂上账');

// ② 同一件事再被挡：累加次数，但**起点不刷新**
const d2 = noteDebt(d1, { activity: '给我妈打个电话', why: '想听她声音' }, 'owner_near', T0 + 60_000);
ok('debt.same_counts_up', d2.tries === 2 && d2.blockedBy === 'owner_near', '第二次挡：tries=2，记为最后挡它的那道闸');
ok('debt.same_keeps_origin_at', d2.at === T0, '起点仍是第一次被挡的时刻（过期不靠刷新续命）');

// ③ 挡够次数就放手 —— 不是「永远欠着」
const d3 = noteDebt(d2, { activity: '给我妈打个电话' }, 'cooldown', T0 + 120_000);
const d4 = noteDebt(d3, { activity: '给我妈打个电话' }, 'cooldown', T0 + 180_000);
ok('debt.gives_up_after_max',
  d3.tries === DEBT_MAX_TRIES && d4 === null,
  `挡满 ${DEBT_MAX_TRIES} 次后返回 null（放手），不硬凑第 ${DEBT_MAX_TRIES + 1} 次`);

// ④ 换了一件事：重新计数，不许把上一件的次数带过来
const dOther = noteDebt(d3, { activity: '把想说的话写下来' }, 'daily_budget', T0 + 300_000);
ok('debt.other_resets',
  dOther.activity === '把想说的话写下来' && dOther.tries === 1 && dOther.at === T0 + 300_000,
  '换了事就是新账，次数归 1');

// ⑤ 没说清要做什么：不凭空造账
ok('debt.empty_no_record', noteDebt(d1, { activity: '   ' }, 'daily_budget', T0) === d1,
  '空 activity 不动现有账，也不新建');

// ⑥ 过期：6 小时内算数，过了就不算
ok('debt.alive_within_ttl', debtAlive(d1, T0 + DEBT_TTL_MS - 1000) === true, '5 小时 59 分：还算数');
ok('debt.dead_after_ttl', debtAlive(d1, T0 + DEBT_TTL_MS) === false, '满 6 小时：放手');
ok('debt.line_none_when_dead', debtLine(d1, T0 + DEBT_TTL_MS) === null, '过期了就不往账本上写一行');

// 负控制：坏账本（每次被挡都刷新起点）必须被 ⑥ 咬住 —— 否则这套判据是假绿
const BAD = (debt, want, blockedBy, at) => ({
  ...(debt ?? {}),
  at,                                   // ← 每次都刷新起点：永远不过期
  activity: String(want?.activity ?? ''),
  blockedBy,
  tries: Number(debt?.tries ?? 0) + 1,
});
const bad = BAD(BAD(null, { activity: 'x' }, 'daily_budget', T0), { activity: 'x' }, 'daily_budget', T0 + DEBT_TTL_MS - 1000);
ok('debt.negative_control.refresh_at_is_caught',
  debtAlive(bad, T0 + DEBT_TTL_MS - 500) === true
    && debtAlive(d1, T0 + DEBT_TTL_MS) === false,
  '刷新起点的坏账本会一直活着 —— 所以「起点不刷新」这条必须有');

console.log(`\n  ${fails ? 'VERDICT: FAIL' : 'VERDICT: PASS'}  (${passes} passed, ${fails} failed)`);
process.exit(fails ? 1 : 0);
