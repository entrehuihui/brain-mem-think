/**
 * smoke_sting.mjs —— 阶段三「扎心度」的判据。
 *
 * 要证的四件事：
 *   ① 它**独立于次数**：一次 0.9 的事 > 十次 0.2 的事（取最大值，不取平均、不累加）；
 *   ② 没有关联经历就是 0（不知道），不许拿 weight 顶上；
 *   ③ 护盾是双重的：自己够扎心，且新来的明显不够——只满足一半不成立；
 *   ④ 它只影响「排在哪、放不放手」，不影响 strength 的公式本身。
 */

import { stingOf, shielded, weightWithSting } from '../src/sting.mjs';
import { decide } from '../src/fade.mjs';
import { burdenOf } from '../src/wake.mjs';
import { renderWorld } from '../src/world.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

const NOW = 1_793_200_000_000;
const D = 86400e3;
const belief = { id: 'b1', themeKey: 'can_stand|他', subject: '他', createdAt: NOW - 2 * D };

// ── ① 独立于次数 ────────────────────────────────────────────────
{
  const one = [{ id: 'e1', at: NOW - D, who: '他', themeKey: 'can_stand|他', arousal: 0.9 }];
  const ten = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, at: NOW - (i + 1) * 3600e3, who: '他', themeKey: 'can_stand|他', arousal: 0.2 }));
  const s1 = stingOf(belief, one, { now: NOW });
  const s10 = stingOf(belief, ten, { now: NOW });
  ok('一次 0.9 的事扎心', s1 === 0.9, 's=' + s1);
  ok('十次 0.2 的事不扎心（次数不加分）', s10 === 0.2, 's=' + s10);
  ok('一次 0.9 > 十次 0.2', s1 > s10);

  const mixed = [...one, ...ten];
  ok('混合时取最大值，不取平均', stingOf(belief, mixed, { now: NOW }) === 0.9);
}

// ── ② 没有关联就不猜 ────────────────────────────────────────────
{
  const unrelated = [{ id: 'x', at: NOW - D, who: '母亲', themeKey: 'hides|母亲', arousal: 0.95 }];
  ok('不同人不同主题 → 0（不猜）', stingOf(belief, unrelated, { now: NOW }) === 0);
  ok('没有经历 → 0', stingOf(belief, [], { now: NOW }) === 0);

  const sameWhoNoTheme = [{ id: 'y', at: NOW - D, who: '他', arousal: 0.6 }];
  ok('同一个人、经历没主题键 → 退一步认（0.6）', stingOf(belief, sameWhoNoTheme, { now: NOW }) === 0.6);
}

// ── ③ 会淡，但不会抹掉 ─────────────────────────────────────────
{
  const old = [{ id: 'o', at: NOW - 200 * D, who: '他', themeKey: 'can_stand|他', arousal: 0.9 }];
  const s = stingOf(belief, old, { now: NOW });
  ok('很久没再被碰到 → 变淡但仍然记得（>0 且 <0.9）', s > 0 && s < 0.9, 's=' + s);
}

// ── ④ 护盾是双重的 ──────────────────────────────────────────────
{
  ok('自己 0.9、新来 0 → 护住', shielded({ sting: 0.9 }, { sting: 0 }) === true);
  ok('自己 0.9、新来 0.8 → 不护（差距不够）', shielded({ sting: 0.9 }, { sting: 0.8 }) === false);
  ok('自己 0.6、新来 0 → 不护（自己不够扎心）', shielded({ sting: 0.6 }, { sting: 0 }) === false);

  const notes = [
    { id: 'a', status: 'held', themeKey: 'pushes|他', strength: 0.35, weight: 0.35, why: '有理由的', sting: 0.9 },
    { id: 'b', status: 'held', themeKey: 'wants|他', strength: 0.8, weight: 0.8, why: '有理由的', sting: 0 },
  ];
  const incoming = { id: 'n', themeKey: 'stalls|他', strength: 0.9, weight: 0.9, why: '有理由的', sting: 0 };
  const r = decide(incoming, notes, { now: NOW, pressure: 4, critical: 99, evictRatio: 1.0, minWeight: 0.05 });
  ok('fade：扎心的那条不让位给平淡的新事', r.verdict === 'shielded', JSON.stringify(r.verdict));
  ok('护盾生效时一条都没掉', r.dropped.length === 0);

  const notes2 = [
    { id: 'a', status: 'held', themeKey: 'pushes|他', strength: 0.35, weight: 0.35, why: '有理由的', sting: 0 },
    { id: 'b', status: 'held', themeKey: 'wants|他', strength: 0.8, weight: 0.8, why: '有理由的', sting: 0 },
  ];
  const r2 = decide(incoming, notes2, { now: NOW, pressure: 4, critical: 99, evictRatio: 1.0, minWeight: 0.05 });
  ok('不扎心的照常让位（负控制：不是永远不腾）', r2.verdict === 'made_room' && r2.dropped.length === 1, JSON.stringify(r2.verdict));
}

// ── ⑤ wake：扎心的压得更重 ─────────────────────────────────────
{
  const mk = (sting) => ({ id: 'x' + sting, status: 'held', strength: 0.6, weight: 0.6, sting, themeKey: 'wants|他', why: '有理由的' });
  const low = burdenOf([mk(0)]);
  const high = burdenOf([mk(1)]);
  ok('同 strength 下，扎心的 burden 更重', high.burden > low.burden, `low=${low.burden} high=${high.burden}`);
  ok('burden 仍然封在 0~1', high.burden <= 1 && low.burden >= 0);
  ok('排序：扎心的当最重那条', burdenOf([mk(0), mk(1)]).heaviest?.sting === 1);
}

// ── ⑥ world：扎心的排前面 ──────────────────────────────────────
{
  const a = { id: 'a', themeKey: 'wants|他', subject: '他', relation: 'wants', polarity: 1, text: '他要的是我能自己站住', why: '有理由的', weight: 0.6, strength: 0.6, sting: 0, status: 'held', kind: 'episodic', createdAt: 1, turns: [] };
  const b = { id: 'b', themeKey: 'can_stand|他', subject: '他', relation: 'can_stand', polarity: 1, text: '被他照顾的时候我其实接得住', why: '有理由的', weight: 0.6, strength: 0.6, sting: 1, status: 'held', kind: 'episodic', createdAt: 1, turns: [] };
  const out = renderWorld([a, b], { name: '小乔' });
  const ia = out.text.indexOf('他要的是我能自己站住');
  const ib = out.text.indexOf('被他照顾的时候我其实接得住');
  ok('扎心的排在不扎心的前面', ib >= 0 && ia >= 0 && ib < ia, `ia=${ia} ib=${ib}`);
}

// ── ⑦ 不影响 strength 的公式 ───────────────────────────────────
{
  const s = weightWithSting({ strength: 0.5, sting: 1 });
  ok('加成封顶 +40%', Math.abs(s - 0.7) < 0.001, 's=' + s);
  ok('没扎心度时与 strength 一致', weightWithSting({ strength: 0.5, sting: 0 }) === 0.5);
}

console.log(`\n==== ${fail === 0 ? '全绿' : '有红'}：${pass} 通过 / ${fail} 失败 ====\n`);
process.exit(fail === 0 ? 0 : 1);
