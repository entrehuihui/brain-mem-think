/**
 * smoke_recall.mjs —— 阶段四「按情境检索」的判据。
 *
 * 要证的四件事：
 *   ① 当下这件事相关的那几条被取到，不相关的沉底；
 *   ② 身份和悬案**永远留**（它们不是「相关」，是底色）；
 *   ③ 取不满就不取——没有相关的只留底色，不硬凑五条；
 *   ④ 没给情境时退回全量（老调用方一个字不用改）。
 */

import { recallFor } from '../src/recall.mjs';
import { renderWorld } from '../src/world.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

const mk = (id, text, extra = {}) => ({
  id, status: extra.status ?? 'held', kind: extra.kind ?? 'episodic', text, why: '有理由的',
  themeKey: extra.themeKey ?? 'wants|他', subject: extra.subject ?? '他',
  relation: extra.relation ?? 'wants', polarity: 1,
  strength: extra.strength ?? 0.6, sting: extra.sting ?? 0,
  weight: 0.6, createdAt: 1, turns: [],
});

const beliefs = [
  mk('b1', '他总在催我快点，可我还没看明白', { themeKey: 'pushes|他', relation: 'pushes' }),
  mk('b2', '他嘴上说随便，其实想要我挑', { themeKey: 'wants|他' }),
  mk('b3', '我妈打电话只报平安，不让我担心', { themeKey: 'hides|母亲', subject: '母亲', relation: 'hides' }),
  mk('b4', '我该先看手里有没有真东西，再开口', { themeKey: 'checks_first|我', subject: '我', relation: 'checks_first', kind: 'identity' }),
  mk('b5', '他还没说清楚那件事到底要不要我插手', { themeKey: 'stalls|他', relation: 'stalls', status: 'open' }),
  mk('b6', '我把水杯放下，没再问', { themeKey: 'can_stand|他', relation: 'can_stand' }),
  mk('b7', '她不喜欢别人替她做决定', { themeKey: 'rejects|她', subject: '她', relation: 'rejects' }),
];

// ── ① 相关的被取到 ──────────────────────────────────────────────
{
  const r = recallFor({ text: '他今天又在催我，说我动作太慢' }, beliefs, { maxHeld: 3 });
  const ids = r.held.map((n) => n.id);
  ok('相关的被取到（催）', ids.includes('b1'), JSON.stringify(ids));
  ok('身份永远留', ids.includes('b4'));
  ok('悬案永远留', ids.includes('b5'));
  ok('条数不超过上限', r.held.filter((n) => n.status === 'held').length <= 3, 'held=' + r.held.filter((n) => n.status === 'held').length);
}

// ── ② 不相关的沉底 ─────────────────────────────────────────────
{
  const r = recallFor({ text: '我妈今天又打电话来了' }, beliefs, { maxHeld: 3 });
  const ids = r.held.map((n) => n.id);
  ok('母亲那条被取到', ids.includes('b3'), JSON.stringify(ids));
  ok('跟「他催我」无关的不在这几条里', !ids.includes('b2') && !ids.includes('b7'), JSON.stringify(ids));
}

// ── ③ 取不满就不取 ─────────────────────────────────────────────
{
  const r = recallFor({ text: '今天天气不错，出去走了走' }, beliefs, { maxHeld: 5 });
  const held = r.held.filter((n) => n.status === 'held');
  ok('完全不相关时只留底色（身份 + 悬案）', held.every((n) => n.kind === 'identity'), held.map((n) => n.id).join(','));
  ok('不硬凑五条', held.length < 5, 'held=' + held.length);
}

// ── ④ 没给情境 → 全量（兼容）────────────────────────────────────
{
  const out = renderWorld(beliefs, { name: '小乔' });
  const shown = beliefs.filter((b) => b.status === 'held' && out.text.includes(b.text)).length;
  ok('没给 focus 时全部现役都看得见', shown === beliefs.filter((b) => b.status === 'held').length, `${shown} 条`);

  const out2 = renderWorld(beliefs, { name: '小乔', focus: { text: '他今天又在催我' }, maxHeld: 3 });
  const shown2 = beliefs.filter((b) => b.status === 'held' && out2.text.includes(b.text)).length;
  ok('给了 focus 时只摆几条', shown2 <= 3 + 1, `给了 focus 后可见 ${shown2} 条`); // +1 = 身份那条可能也算 held
  ok('给了 focus 时相关的还在', out2.text.includes('他总在催我快点'));
  ok('给了 focus 时无关的沉下去了', !out2.text.includes('她不喜欢别人替她做决定'), out2.text);
}

// ── ⑤ 理由能审计：为什么想起这条 ────────────────────────────────
{
  const r = recallFor({ text: '他今天又在催我', themeKeys: ['pushes|他'] }, beliefs, { maxHeld: 3 });
  const top = r.scored[0];
  ok('分数最高的那条带着理由字段', !!top && typeof top.score === 'number' && ('themeHit' in top), JSON.stringify(top));
  ok('主题命中给了加成', top?.themeHit === 1 || top?.sim > 0, JSON.stringify(top));
}

console.log(`\n==== ${fail === 0 ? '全绿' : '有红'}：${pass} 通过 / ${fail} 失败 ====\n`);
process.exit(fail === 0 ? 0 : 1);
