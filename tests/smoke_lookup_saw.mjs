/**
 * smoke_lookup_saw.mjs —— 「回去查一次」和「我亲手看过」的判据。
 *
 * 这两块都是我自己加的，不是主人设计的。要证的事：
 *
 *   lookup
 *     ① 关键词翻得到 / 翻不到，都说实话；
 *     ② 重述抄了原文（连续 ≥8 字）→ 整条丢掉，宁可说不知道；
 *     ③ 想不起来就不许摆——绝不编一句「大概是那个意思」；
 *     ④ 返回值里永远没有原文字段（第一铁律）。
 *
 *   saw
 *     ① 只有「看」的动作算（read/run/fetch/look），「说」和「想」一律拒收；
 *     ② 没有 mount（说不出看的是哪儿）就不算看过；
 *     ③ 同一个地方看第二遍不记两遍；
 *     ④ 看过的主题不再算「二手空白」；
 *     ⑤ 过期的不再当理由。
 */

import { scan, shape, lookup, lookupLine } from '../src/lookup.mjs';
import { normalizeSaw, addSaw, unverifiedOf, sawLines, isSaw } from '../src/saw.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

// ── lookup ─────────────────────────────────────────────────────
const materials = [
  '他那天把手机放下，说了一句「你先吃，别等我」，然后去了书房。',
  '我把那页纸翻过去，没再问那扇窗的事。',
  '后来他留了张便签在桌上，我看了很久，也没去擦。',
];

{
  const hit = scan('便签', materials);
  ok('关键词翻得到（便签）', !!hit && hit.mount === 'archive:2', JSON.stringify(hit));
  const miss = scan('航班号', materials);
  ok('翻不到就是 null（不硬凑）', miss === null, JSON.stringify(miss));
  ok('一个字不查（别假装查到了）', scan('他', materials) === null);
}

{
  // 重述得足够远 → 算想起来
  const good = shape({ gist: '他留了张纸条在桌上，我一直没动', mount: 'archive:2' }, materials);
  ok('重述隔得开 → 算想起', good.found === true, JSON.stringify(good));

  // 重述把原文抄下来 → 整条丢
  const bad = shape({ gist: '他留了张便签在桌上，我看了很久', mount: 'archive:2' }, materials);
  ok('抄原文（连续 ≥8 字）→ 整条丢掉', bad.found === false, JSON.stringify(bad));
  ok('丢掉时说清楚为什么', /不算想起/.test(bad.why ?? ''), bad.why);

  // 空重述 → 不算
  ok('一句都说不上来 → 不算', shape({ gist: '', mount: 'archive:2' }, materials).found === false);
  // 没有坐标 → 不算
  ok('说不出在哪儿翻到的 → 不算', shape({ gist: '他留了张纸条', mount: '' }, materials).found === false);
  // 太长 → 那是在背
  ok('太长（>60 字）→ 不算', shape({ gist: '啊'.repeat(61), mount: 'archive:2' }, materials).found === false);
}

{
  const r = await lookup('便签', materials, () => '他留了张纸条在桌上，我一直没动');
  ok('一步做完：翻 → 重述 → 过闸', r.found === true, JSON.stringify(r));
  // ★ 第一铁律：返回值里不许有原文字段
  ok('返回值里没有原文字段', !('text' in r) && !('raw' in r) && !('material' in r), Object.keys(r).join(','));

  const r2 = await lookup('便签', materials, () => '后来他留了张便签在桌上，我看了很久');
  ok('抄原文的回退成「没翻到」', r2.found === false, JSON.stringify(r2));
  ok('没翻到时她如实说不知道', /想不起来|没有找到/.test(lookupLine(r2).join('')), lookupLine(r2).join(''));

  const r3 = await lookup('航班号', materials, () => '某某航班');
  ok('原库里就没有 → 不去调重述', r3.found === false);
  // 重述函数抛错也不许崩
  const r4 = await lookup('便签', materials, () => { throw new Error('boom'); });
  ok('重述抛错 → 退回不知道，不崩', r4.found === false);
}

// ── saw ────────────────────────────────────────────────────────
{
  ok('read 算看过', isSaw({ kind: 'read' }));
  ok('run 算看过', isSaw({ kind: 'run' }));
  ok('fetch 算看过', isSaw({ kind: 'fetch' }));
  ok('say 不算（那是话，不是看）', !isSaw({ kind: 'say' }));
  ok('think 不算', !isSaw({ kind: 'think' }));
  ok('kind 空不算', !isSaw({}));
}

{
  const s = normalizeSaw({ kind: 'read', mount: 'D:/x.md', saw: '那行字写的是这么回事', target: 'belief:b1' });
  ok('正常的一条能归一', !!s && s.mount === 'D:/x.md');
  ok('没有 mount → 不算看过', normalizeSaw({ kind: 'read', saw: '我看了' }) === null);
  ok('正文空 → 不算', normalizeSaw({ kind: 'read', mount: 'a' }) === null);
  ok('say 就算带 mount 也不算', normalizeSaw({ kind: 'say', mount: 'a', saw: '我说过' }) === null);
}

{
  const now = 1_000_000;
  let list = addSaw([], { kind: 'read', mount: 'a.md', saw: '第一件事', at: now }, { now });
  list = addSaw(list, { kind: 'read', mount: 'a.md', saw: '第一件事', at: now }, { now });
  ok('同一处同一句不记两遍', list.length === 1, 'len=' + list.length);
  list = addSaw(list, { kind: 'run', mount: 'echo', saw: '命令输出是 42', at: now + 1 }, { now: now + 1 });
  ok('另一处算新的一条', list.length === 2);
  // ★ 这里必须把 now 传进去：上面用的是假时间戳（1_000_000），
  //   不传 now 的话 sawLines 会拿真实的 Date.now() 去比，全部超期，摆出来是空的。
  //   第一版就是这么写错的——错在测试，不在代码。
  ok('最多摆三条', sawLines(list, { now: now + 2 }).length === 3, JSON.stringify(sawLines(list, { now: now + 2 })));
  ok('摆出来说的是「我自己去看过的」', /我自己去看过的/.test(sawLines(list, { now: now + 2 })[0]));
  ok('没有就不摆', sawLines([]).length === 0);
}

{
  const now = 5_000_000;
  const notes = [
    { id: 'b1', status: 'held', themeKey: 'pushes|他', text: '他在催我' },
    { id: 'b2', status: 'held', themeKey: 'hides|他', text: '他什么都不说' },
    { id: 'b3', status: 'held', themeKey: null, text: '没主题的那条' },
  ];
  const none = unverifiedOf(notes, [], { now });
  ok('没看过 → 两条都能派（没主题的排除）', none.length === 2, JSON.stringify(none.map((n) => n.id)));
  const saws = [{ id: 's', kind: 'read', mount: 'a', saw: '看过了', target: 'belief:b1', at: now - 1000 }];
  const left = unverifiedOf(notes, saws, { now });
  ok('看过 b1 → 只剩 b2', left.length === 1 && left[0].id === 'b2', JSON.stringify(left.map((n) => n.id)));
  // 过期的不算看过
  const old = [{ id: 's', kind: 'read', mount: 'a', saw: '很久以前看的', target: 'belief:b1', at: now - 60 * 86400e3 }];
  ok('过期的不再当理由', unverifiedOf(notes, old, { now }).length === 2);
  // 没有 target 的 saw 不算数
  const loose = [{ id: 's', kind: 'read', mount: 'a', saw: '顺手看了一眼', at: now - 1000 }];
  ok('顺手看一眼不算核实过', unverifiedOf(notes, loose, { now }).length === 2);
}

console.log(`\n==== lookup+saw：${pass} 通过 / ${fail} 失败 ====`);
process.exitCode = fail ? 1 : 0;
