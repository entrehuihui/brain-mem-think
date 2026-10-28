/**
 * smoke_associate.mjs —— 阶段二「联想」的判据。
 *
 * 工具：`node tests/smoke_associate.mjs`
 *
 * 这一层要证的是：**novel 终于有来源了。**
 *   · 联想只能来自「判断之外」的原料（经历），不能又从判断倒推；
 *   · 内核只做计数（谁、隔多久、几件），模型只说一句人话且必须挑闭集谓词；
 *   · 说出来的话不许抄经历原句（第一铁律）；
 *   · 对账四分类：库里有同向 → confirmed 不重复收；反向 → contested 记冲突；没有 → novel 收进来。
 */

import { ASSOCIATE_DEFAULTS, buildAssocPrompt, findPatterns, parseAssoc } from '../src/associate.mjs';
import { Mind } from '../src/mind.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

const NOW = 1_793_200_000_000;
const H = 3600_000;
const D = 24 * H;

const eps = [
  { id: 'e-1', at: NOW - 2 * D, who: '他', what: '他把那页纸翻过去，只让我先坐下吃饭', feel: '手还颤', arousal: 0.7, themeKey: null },
  { id: 'e-2', at: NOW - 1 * D, who: '他', what: '他把水杯往我这边推了推', feel: '心里松了一下', arousal: 0.6, themeKey: null },
  { id: 'e-3', at: NOW - 3 * H, who: '他', what: '他把我拉到身边，什么也没问', feel: '踏实', arousal: 0.8, themeKey: null },
];

// ── ① 纯计数：找模式 ─────────────────────────────────────────────
{
  const pats = findPatterns(eps, { now: NOW });
  ok('三件同一个人、情绪够重、隔得开 → 一个模式', pats.length === 1, 'patterns=' + pats.length);
  ok('support = 3', pats[0]?.support === 3, 'support=' + pats[0]?.support);
  ok('who 对', pats[0]?.who === '他');

  const near = [
    { id: 'a', at: NOW - 1 * H, who: '他', what: '他把水杯推过来，我接了', feel: '松', arousal: 0.7 },
    { id: 'b', at: NOW - 2 * H, who: '他', what: '他把外套披在我肩上', feel: '暖', arousal: 0.7 },
  ];
  ok('隔不到 6 小时的不算两件事（同一件事的两种说法）', findPatterns(near, { now: NOW }).length === 0);

  ok('单件经历不联想（那是回想）', findPatterns([eps[0]], { now: NOW }).length === 0);
  ok('情绪太淡的不参与', findPatterns(eps.map((e) => ({ ...e, arousal: 0.1 })), { now: NOW }).length === 0);

  const twoWho = [
    { id: 'x1', at: NOW - 2 * D, who: '他', what: '他把我拉到身边', feel: '踏实', arousal: 0.7 },
    { id: 'x2', at: NOW - 1 * D, who: '母亲', what: '她在电话里问我吃饭没有', feel: '有点酸', arousal: 0.7 },
  ];
  ok('不同的人不硬凑成一对', findPatterns(twoWho, { now: NOW }).length === 0);
}

// ── ② 模型的话：只认闭集谓词，不许数字/超长 ─────────────────────
{
  const p = findPatterns(eps, { now: NOW })[0];
  const prompt = buildAssocPrompt(p, { name: '小乔' });
  ok('提示词里给了谓词闭集', prompt.includes('can_stand') && prompt.includes('learns_from'));
  ok('提示词里给了两件事、不给结论', prompt.includes('他把那页纸翻过去'));

  const good = parseAssoc(JSON.stringify({
    text: '我每次被他照顾，都是先紧后松，其实心里接得住',
    why: '两件旧事摆在一起才看见',
    relation: 'can_stand',
    polarity: 'favorable',
  }));
  ok('合格的一句能过', !!good && good.relation === 'can_stand' && good.polarity === 1, JSON.stringify(good));

  ok('谓词不在闭集里 → 丢', parseAssoc(JSON.stringify({ text: '我总是先紧后松，其实心里接得住', relation: 'feels_safe', polarity: 'favorable' })) === null);
  ok('带数字 → 丢', parseAssoc(JSON.stringify({ text: '我三次都是先紧后松，心里接得住', relation: 'can_stand', polarity: 'favorable' })) === null);
  ok('说 NULL → 丢', parseAssoc('NULL') === null);
  ok('太长 → 丢', parseAssoc(JSON.stringify({ text: '我'.repeat(41), relation: 'can_stand', polarity: 'favorable' })) === null);
}

// ── ③ 端到端：联想 → 对账 → 收进库 ───────────────────────────────
{
  const mkMind = (reply, beliefs = []) => {
    const synth = {
      async ask() { return typeof reply === 'function' ? reply() : reply; },
      async synthesize() { return null; },
    };
    const mind = new Mind({ synth, now: () => NOW, name: '小乔' });
    mind.episodes = eps.map((e) => ({ ...e }));
    for (const b of beliefs) mind.store.add(b);
    return mind;
  };

  const reply = JSON.stringify({
    text: '我每次被他照顾，都是先紧后松，其实心里接得住',
    why: '两件旧事摆在一起才看见',
    relation: 'can_stand',
    polarity: 'favorable',
  });

  const m1 = mkMind(reply);
  const r1 = await m1.associate();
  ok('没有同主题判断 → 收进来（novel）', r1.adopted === 1 && r1.reason === 'new', JSON.stringify(r1));
  ok('主题键 = 谓词|谁', m1.store.list.some((b) => b.themeKey === 'can_stand|他'));
  ok('这条是内核自己发现的（origin=induction）', m1.store.list.find((b) => b.themeKey === 'can_stand|他')?.origin === 'induction');
  ok('记了一条 source=association 的观测', m1.store.events.some((e) => e.source === 'association'));

  const r2 = await m1.associate();
  ok('同样的模式再跑一次 → confirmed，不重复收', r2.reason === 'confirmed' && r2.adopted === 0, JSON.stringify(r2));

  // 反向：库里已经有一条反着看的
  const { Belief, STATUS, transition } = await import('../src/judge.mjs');
  const opposing = new Belief({
    themeKey: 'can_stand|他', subject: '他', relation: 'can_stand', polarity: -1,
    text: '我其实接不住他给的东西', why: 'x', weight: 0.6, at: NOW - D, via: 'digest',
  });
  transition(opposing, STATUS.HELD, { at: NOW - D });
  const m2 = mkMind(reply, [opposing]);
  const r3 = await m2.associate();
  ok('方向相反 → contested，记冲突不收', r3.reason === 'contested' && r3.adopted === 0, JSON.stringify(r3));
  ok('冲突写在旧判断的 tension 上', opposing.tension?.kind === 'conflict' && String(opposing.tension?.counterView ?? '').includes('先紧后松'));

  // 第一铁律：模型把经历原句搬进判断
  const copy = JSON.stringify({
    text: '他把那页纸翻过去，只让我先坐下吃饭',
    why: 'x', relation: 'can_stand', polarity: 'favorable',
  });
  const m3 = mkMind(copy);
  const r4 = await m3.associate();
  ok('抄经历原句 → copied，不收（第一铁律）', r4.reason === 'copied' && r4.adopted === 0, JSON.stringify(r4));

  const m4 = mkMind(reply);
  m4.episodes = [];
  ok('没有经历 → no-pattern', (await m4.associate()).reason === 'no-pattern');
}

console.log(`\n==== ${fail === 0 ? '全绿' : '有红'}：${pass} 通过 / ${fail} 失败 ====\n`);
process.exit(fail === 0 ? 0 : 1);
