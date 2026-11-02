/**
 * smoke_doubt.mjs —— 「我拿不准的事」的判据。
 *
 * 这一块**不是主人设计的**，是我自己补的：
 * 原设计里 `reconcile()` 认真地把 `contested` 记下来（连 because 都写好了），
 * 然后 `world.mjs` 从来不读它——冲突记了，却走不进她睁眼看到的世界。
 *
 * 要证的五件事：
 *   ① 有冲突就摆出来，两边都在场（不是只留一边）；
 *   ② 说人话：内部谓词键（pushes/guards）绝不许漏进她的眼睛；
 *   ③ 不硬造：库里那条已经不在了，整桩丢掉，不凭空生一桩「拿不准」；
 *   ④ 不裁决：不许出现「但是」「其实」这类一出现就等于已经选了边的字；
 *   ⑤ 老路径不动：不传 reconcile，世界跟以前一字不差。
 */

import { doubtsOf, doubtLines } from '../src/doubt.mjs';
import { renderWorld } from '../src/world.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

const mk = (id, text, extra = {}) => ({
  id, status: extra.status ?? 'held', kind: extra.kind ?? 'episodic', text,
  themeKey: extra.themeKey ?? 'pushes|他', subject: extra.subject ?? '他',
  relation: extra.relation ?? 'pushes', polarity: extra.polarity ?? 1,
  strength: extra.strength ?? 0.6, sting: extra.sting ?? 0, weight: 0.6,
});

const notes = [
  mk('b1', '他总先顾着我的感受', { polarity: 1, strength: 0.7 }),
  mk('b2', '我自己不肯先开口', { subject: '我', relation: 'cannot_say', polarity: -1, strength: 0.5 }),
];

const contested = (beliefId, action, candidatePolarity, support = 4) => ({
  candidate: { actor: '他', action, polarity: candidatePolarity, support, consistency: 0.8 },
  beliefId,
  beliefPolarity: 1,
  candidatePolarity,
  because: `我数了 ${support} 回，80% 是${candidatePolarity > 0 ? '正' : '负'}的；库里那条说的是反的`,
});

// ── ① 有冲突就摆，两边都在场 ────────────────────────────────────
{
  const d = doubtsOf(notes, { contested: [contested('b1', 'pushes', -1)] });
  ok('冲突被摆出来', d.length === 1, 'len=' + d.length);
  ok('我记着的那一侧在场', d[0]?.mine === '他总先顾着我的感受');
  ok('我数着的那一侧在场', /他催/.test(d[0]?.counted ?? ''), d[0]?.counted);
  ok('回数带上（看得出是数出来的）', /4 回/.test(d[0]?.counted ?? ''));
}

// ── ② 说人话：内部键漏了就是丑 ──────────────────────────────────
{
  const d = doubtsOf(notes, { contested: [contested('b1', 'pushes', -1)] });
  const seg = doubtLines(d).join('\n');
  ok('谓词键不许漏出来', !/pushes|guards|stalls|cannot_say/.test(seg), seg);
  ok('整段有人话', /我记着的是：/.test(seg) && /可我数出来：/.test(seg), seg);
}

// ── ③ 不硬造：库里那条不在了就整桩丢 ────────────────────────────
{
  const d = doubtsOf(notes, { contested: [contested('b-not-here', 'pushes', -1)] });
  ok('库里没有就不摆（不凭空生一桩拿不准）', d.length === 0, 'len=' + d.length);
  const d2 = doubtsOf(notes, {});
  ok('没有对账结果就一条不摆', d2.length === 0);
  const d3 = doubtsOf([], { contested: [contested('b1', 'pushes', -1)] });
  ok('空库也不摆', d3.length === 0);
}

// ── ④ 不裁决：转折词一出现，就等于已经选了边 ────────────────────
{
  const seg = doubtLines(doubtsOf(notes, { contested: [contested('b1', 'pushes', -1)] })).join('\n');
  ok('不许出现「但是」', !/但是/.test(seg), seg);
  ok('不许出现「其实」', !/其实/.test(seg), seg);
  ok('明说两边都还在', /两份都还在/.test(seg), seg);
}

// ── ⑤ 老路径一字不动 ────────────────────────────────────────────
{
  const before = renderWorld(notes, { name: '大乔' }).text;
  ok('不传 reconcile：世界没有「拿不准」这段', !/我拿不准的事/.test(before), before);
  const after = renderWorld(notes, { name: '大乔', reconcile: { contested: [contested('b1', 'pushes', -1)] } }).text;
  ok('传了 reconcile：这段出现在世界里', /我拿不准的事/.test(after), after);
  // 位置：在「我还记得这些」之前（先事情、再两种说法、最后别的记忆）
  const iDoubt = after.indexOf('我拿不准的事');
  const iRest = after.indexOf('我还记得这些');
  ok('摆的位置在记忆段之前', iDoubt >= 0 && iRest > iDoubt, `doubt=${iDoubt} rest=${iRest}`);
}

// ── ⑥ 条数受上限约束 ────────────────────────────────────────────
{
  const many = [];
  const ns = [];
  for (let i = 0; i < 8; i += 1) {
    ns.push(mk(`m${i}`, `第 ${i} 件我记得的事`));
    many.push(contested(`m${i}`, 'pushes', -1));
  }
  const d = doubtsOf(ns, { contested: many }, { max: 3 });
  ok('最多摆三桩', d.length === 3, 'len=' + d.length);
}

console.log(`\n==== doubt：${pass} 通过 / ${fail} 失败 ====`);
process.exitCode = fail ? 1 : 0;
