/**
 * smoke_induct.mjs —— 内核自己归纳的那套判据，有没有牙齿。
 *
 * 三个问题，每个都必须答得出来：
 *   1. 数得够、方向一致 → 它自己得出判断吗？
 *   2. 数得够、方向打架 → 它自己认成悬案吗？
 *   3. 对账的四分类会不会张冠李戴（同一条同时挂在两栏里）？
 *
 * 跑法：node tests/smoke_induct.mjs
 * 退出码 0 = 全绿；1 = 有红。
 */

import { makeEvent } from '../src/event.mjs';
import { induce, reconcile } from '../src/induct.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (detail ? '  — ' + detail : '')); }
};

const now = 1_700_000_000_000;
const D = 86400e3;
const ev = (i, actor, action, polarity, text, daysAgo) => makeEvent({
  seq: i, at: now - daysAgo * D, actor, action, polarity, text, themeKey: `${action}|${actor}`,
});

// ── ① 方向一致的：必须自己得出判断 ───────────────────────
console.log('\n[①] 方向一致');
{
  const events = [
    ev(1, '他', 'hides', -1, '他总先沉默一下才回', 5),
    ev(2, '他', 'hides', -1, '他又是先沉默才回', 4),
    ev(3, '他', 'hides', -1, '他还是不直说', 3),
    ev(4, '他', 'hides', -1, '他这次也没说', 2),
    ev(5, '他', 'hides', 1, '他这回开口了', 1),
  ];
  const r = induce(events, { now });
  const c = r.claims.find((x) => x.actor === '他' && x.action === 'hides');
  ok('数得出 5 回', c?.support === 5, `got ${c?.support}`);
  ok('方向是负（4 负 1 正）', c?.polarity === -1, `got ${c?.polarity}`);
  ok('一致率 0.8', c?.consistency === 0.8, `got ${c?.consistency}`);
  // 代表正文必须是「多数方向里最近的那条」，不能引用那句唯一的正向话
  ok('正文引的是负向那条，不是那句"这回开口了"', c?.text === '他这次也没说', `got 「${c?.text}」`);
}

// ── ② 方向打架的：必须自己认成悬案 ───────────────────────
console.log('\n[②] 方向打架');
{
  const events = [
    ev(1, '我', 'stalls', 1, '我拖着没动', 4),
    ev(2, '我', 'stalls', -1, '我没拖，我是想清楚了再动', 3),
    ev(3, '我', 'stalls', 1, '我又搁下了', 2),
    ev(4, '我', 'stalls', -1, '我这次没搁', 1),
  ];
  const r = induce(events, { now });
  const p = r.pendings.find((x) => x.actor === '我' && x.action === 'stalls');
  ok('落进 pendings 而不是 claims', !!p && !r.claims.some((x) => x.action === 'stalls'));
  ok('左右各 2 条', p?.split.pos === 2 && p?.split.neg === 2, JSON.stringify(p?.split));
}

// ── ③ 证据不够的：一栏都不许进 ──────────────────────────
console.log('\n[③] 证据不够');
{
  const events = [ev(1, '主人', 'pushes', 1, '他催我快点', 2), ev(2, '主人', 'pushes', 1, '他又催', 1)];
  const r = induce(events, { now });
  ok('2 回不到 minSupport=3，不进 claims', !r.claims.some((x) => x.actor === '主人'));
  ok('也不进 pendings', !r.pendings.some((x) => x.actor === '主人'));
}

// ── ④ 对账四分类：不许张冠李戴 ──────────────────────────
console.log('\n[④] 对账');
{
  const events = [
    ev(1, '他', 'hides', -1, '他总先沉默', 5),
    ev(2, '他', 'hides', -1, '他还是不直说', 4),
    ev(3, '他', 'hides', -1, '他这次也没说', 3),
    ev(4, '我', 'stalls', 1, '我拖着没动', 4),
    ev(5, '我', 'stalls', -1, '我没拖', 3),
    ev(6, '我', 'stalls', 1, '我又搁下了', 2),
    ev(7, '我', 'stalls', -1, '我这次没搁', 1),
    ev(8, '他', 'endures', -1, '他累了也不说', 5),
    ev(9, '他', 'endures', -1, '他一直硬撑', 4),
    ev(10, '他', 'endures', -1, '他撑着不吭声', 3),
  ];
  const i = induce(events, { now });
  const beliefs = [
    { id: 'b1', status: 'held', subject: '他', relation: 'hides', polarity: -1, text: '他总先沉默', themeKey: 'hides|他' },
    { id: 'b2', status: 'held', subject: '我', relation: 'stalls', polarity: 1, text: '我拖着没动', themeKey: 'stalls|我' },
    { id: 'b3', status: 'held', subject: '这摊事', relation: 'wants', polarity: 1, text: '模型自己给的', themeKey: 'wants|这摊事' },
  ];
  const r = reconcile(i, beliefs);
  ok('一致 = b1', r.confirmed.length === 1 && r.confirmed[0].beliefId === 'b1', JSON.stringify(r.confirmed.map((x) => x.beliefId)));
  ok('冲突 = b2（方向定不下来，库里却定了）', r.contested.some((x) => x.beliefId === 'b2'));
  ok('内核独立发现 = 他/endures', r.novel.some((x) => x.actor === '他' && x.action === 'endures'), JSON.stringify(r.novel.map((x) => `${x.actor}/${x.action}`)));
  ok('证据不足 = b3', r.thin.length === 1 && r.thin[0].beliefId === 'b3', JSON.stringify(r.thin.map((x) => x.beliefId)));
  // 同一条不许同时挂在两栏里
  const all = [...r.confirmed.map((x) => x.beliefId), ...r.contested.map((x) => x.beliefId), ...r.thin.map((x) => x.beliefId)];
  ok('没有一条重复出现在两个分类里', new Set(all).size === all.length, all.join(','));
}

// ── ⑤ 窗口：太老的观测不参与 ────────────────────────────
console.log('\n[⑤] 时间窗');
{
  const events = [
    ev(1, '他', 'hides', -1, '很老的一条', 40),
    ev(2, '他', 'hides', -1, '很老的一条', 39),
    ev(3, '他', 'hides', -1, '很老的一条', 38),
  ];
  const r = induce(events, { now, windowMs: 30 * D });
  ok('40 天前的三条不进归纳', !r.claims.some((x) => x.action === 'hides'));
}

console.log(`\n==== ${fail === 0 ? '全绿' : '有红'}：${pass} 通过 / ${fail} 失败 ====\n`);
process.exit(fail === 0 ? 0 : 1);
