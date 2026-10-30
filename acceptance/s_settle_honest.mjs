/**
 * s_settle_honest —— 「没去成」「去了没动手」都不许在账上当「做到了」。
 *
 * ======================= 为什么要有这一条 =======================
 *
 * 主人 2026-10-30 问「为什么只会说、没有去做」，线上取证抓到两处：
 *
 *   ① act-settle {"activity":"把那张纸读一遍","kind":"want","found":true,
 *                 "notesBefore":55,"notesNow":55}
 *      想去做（want）这一档**恒 true**，被闸挡回来那趟也走这条路 ——
 *      「想去 → 被挡 → found:true → 偏好 +gain」成了闭环，
 *      于是**越没去成，那件事的劲越大**。motive.json 里「给我妈打个电话」
 *      涨到 0.99 / 8 次就是这么来的。
 *
 *   ② 真出门那趟：判断库 55 → 55、一个工具没调，22 分钟后她自己说
 *      「抽屉还关着，我没动」——可账上记的是「我去读那张纸」。
 *
 * 所以判定提成纯函数 `src/settle.mjs`，用假数据钉死。
 * 不靠正则抠源码：抠源码的测试，换个换行就假绿了。
 */

import {
  settleVerdict, shouldChargePrefs, loseFor, settleLabel, reallyWentOf,
} from '../src/settle.mjs';

let fails = 0;
let passes = 0;
const ok = (name, cond, detail) => {
  if (cond) { passes += 1; console.log(`  [PASS] ${name}  ${detail ?? ''}`); }
  else { fails += 1; console.log(`  [FAIL] ${name}  ${detail ?? ''}`); }
};

const BASE = { notesBefore: 55, toolSeqBefore: 100 };

// ① 被闸挡回来：没去成。既不涨也不扣 —— 没出门就没有「喜不喜欢」可言。
const blocked = { ...BASE, activity: '把那张纸读一遍', skippedWhy: 'daily_budget', kind: 'want' };
const vBlocked = settleVerdict({ pending: blocked, kind: 'want', notesNow: 55, toolSeqNow: 100 });
ok('settle.blocked.not_done',
  vBlocked.verdict === 'didnt_go' && vBlocked.found === false,
  '被挡回来 → didnt_go / found=false');
ok('settle.blocked.no_charge',
  shouldChargePrefs(vBlocked.verdict) === false,
  '被挡回来不结算偏好（不涨不扣）');

// ② 去了，但一个工具没调、判断库没变：只是坐那儿想了一路
const wentIdle = { ...BASE, activity: '给我妈打个电话', kind: 'want' };
const vIdle = settleVerdict({ pending: wentIdle, kind: 'want', notesNow: 55, toolSeqNow: 100 });
ok('settle.went_but_idle.not_found',
  vIdle.verdict === 'went_thought' && vIdle.found === false && vIdle.did === false,
  '出门没动手 → went_thought / found=false');
ok('settle.went_but_idle.soft_penalty',
  loseFor(vIdle.verdict) === 0.06 && loseFor(vIdle.verdict) < 0.2,
  '温和扣 0.06，不是空转的 0.2（不把想做的事一脚踹到底）');
ok('settle.went_but_idle.label_honest',
  settleLabel(wentIdle, vIdle.verdict) === '我想给我妈打个电话，去了却没做成',
  '经历如实写「去了却没做成」，不许写成「我去…」');

// ③ 去了、真调了工具：算做成
const vDid = settleVerdict({ pending: wentIdle, kind: 'want', notesNow: 55, toolSeqNow: 130 });
ok('settle.did.counts',
  vDid.verdict === 'went_did' && vDid.found === true,
  '工具游标往前走了 → went_did / found=true');
ok('settle.did.label', settleLabel(wentIdle, vDid.verdict) === '我去给我妈打个电话', '真做了才写「我去…」');

// ④ 判断库变多也算动手（没调工具、但熔出了新判断）
const vNotes = settleVerdict({ pending: { ...BASE, activity: '查一件事', kind: 'want' }, kind: 'want', notesNow: 58, toolSeqNow: 100 });
ok('settle.notes_growth.counts', vNotes.verdict === 'went_did' && vNotes.found === true,
  '判断库 55→58 也算真做了');

// ⑤ 收获型（resolve）：调了工具但没带回判断，仍算空转 —— 两把尺不能混
const vResolve = settleVerdict({
  pending: { ...BASE, activity: '弄明白一件事', kind: 'resolve' },
  kind: 'resolve', notesNow: 55, toolSeqNow: 130,
});
ok('settle.resolve.needs_notes',
  vResolve.verdict === 'went_did' && vResolve.found === false && loseFor(vResolve.verdict) === 0.2,
  '收获型：出了门也动了手，但没带回东西 → 仍是空转（扣 0.2）');

// ⑥ 没有 skippedWhy 才是「出去了」——这条不许被写成「有 activity 就算」
ok('settle.no_skipped_means_went', reallyWentOf(wentIdle) === true && reallyWentOf(blocked) === false,
  '只有带 skippedWhy 才算没出门');

// 负控制：2026-10-30 之前那版判定（want 恒 true）必须被 ①② 咬住，
// 否则这套判据自己是假绿。
const OLD = (pending, kind) => (kind === 'resolve'
  ? Number(pending.notesBefore ?? 0) < Number(pending.notesBefore ?? 0) + 1
  : true);
ok('settle.negative_control.old_want_always_true',
  OLD(blocked, 'want') === true && vBlocked.found === false,
  '旧实现把「被挡回来」判成做到了 —— 所以上面两条才有意义');

console.log(`\n  ${fails ? 'VERDICT: FAIL' : 'VERDICT: PASS'}  (${passes} passed, ${fails} failed)`);
process.exit(fails ? 1 : 0);
