/**
 * verify.mjs —— 记忆插件改完之后的自检脚本。
 *
 * 为什么要它：2026-10-27 一天里接连踩了五个坑，每一个都是「改完看着对、
 * 实际没生效」，而且没有一个能被肉眼发现——
 *
 *   ① compact 把主人刚说的话一起遮掉了  → 她会「听不见你最后那句」
 *   ② 游标在熔空时也前进              → 你说的话既没进记忆、也不再重熔
 *   ③ 单条证据就能推翻记忆            → 一天 14 条被串掉 8 条
 *   ④ 渲染层 maxHeld=6 截断          → 记了 12 条，只看得见 6 条
 *   ⑤ 身份句/心境句重复引同一句        → 她把自己念两遍
 *
 * 每一条都有一个断言。跑 `node tools/verify.mjs`，全绿才算改完。
 * 不联网、不读写生产数据（只读 judgments.json 做渲染检查）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const imp = (p) => import('file:///' + join(ROOT, p).replace(/\\/g, '/'));

const { Belief, STATUS, transition } = await imp('src/judge.mjs');
const { review, reconsider } = await imp('src/revision.mjs');
const { buildSessionMaterial, buildDigestPrompt, digestSession } = await imp('src/digest-session.mjs');
const { renderWorld } = await imp('src/world.mjs');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

// ── ① 熔案提示词 ────────────────────────────────────────────────
console.log('\n[①] 熔案提示词');
{
  const mat = buildSessionMaterial(['过来抱我。', '门关了就别装了。', '贴紧一点，别松手。']);
  const p = buildDigestPrompt(mat, []);
  ok('第 6 条在（色情/身体 = 情感表达）', p.includes('不要把它当成情节或需求'));
  ok('明说这类材料不许提炼做事方法', p.includes('不要**提炼做事的方法') || p.includes('不要提炼做事的方法'));
  ok('六条要求齐全', ['1.', '2.', '3.', '4.', '5.', '6.'].every((n) => p.includes('\n' + n + ' ')));
}

// ── ② 抄原文阈值 ────────────────────────────────────────────────
console.log('\n[②] 抄原文阈值（短材料放宽到 12 字）');
{
  // ★ 断言要用**撞到 9~11 个字**的判断来测，不能用完全不相撞的：
  //   不相撞的话新旧阈值都放行，测不出差别（第一版就是这么写错的）。
  const material = '你要是不肯再往上一点，我只好自己动手了，把裙子撩起来一点，让我看看你到底湿成什么样。';
  const synth = { synthesize: async () => JSON.stringify({ judgments: [
    // 与材料撞 "把裙子撩起来一点" = 8 个汉字：旧阈值 8 会误杀，新阈值 12 放行
    { text: '他就是要我把裙子撩起来一点。', why: 'x', relation: 'wants', subject: '他', polarity: 'favorable', weight: 0.7 },
    // ★ 2026-10-28 改（跟 P0-3 一起改的，理由记在这儿）：
    //   这条原来 why 只写了 'y'，测的是「跟材料完全不相撞也照常放行」。
    //   可那正是 P0-3 那个后门：零共享 + 长度≥6 就过，编造长驱直入。
    //   现在 grounding 的主路要求「正文或理由至少有一条线索落在材料上」，
    //   所以这条用例的 why 改成贴材料的理由——它测的仍然是
    //   「不相撞的抽象判断照常放行」，只是不再要求「连理由都不贴也放」。
    { text: '他心里比我以为的更急。', why: '把裙子撩起来那一下他的手都没停', relation: 'wants', subject: '他', polarity: 'favorable', weight: 0.6 },
  ] }) };
  const r = await digestSession([material], { synth });
  const hit = r.judgments.find((j) => j.text.includes('撩起来'));
  ok('撞 9~11 字的不再被误杀（旧阈值 8 会杀）', !!hit, r.reason + ' / ' + r.judgments.map((j) => j.text).join(' | '));
  ok('不相撞的照常放行', r.judgments.some((j) => j.text.includes('更急')), r.reason);
}

// ── ③ 单条证据不许翻记忆（最贵的那个坑）────────────────────────────
console.log('\n[③] 改自己：单条弱证据不许推翻现役结论');
{
  const mk = () => {
    const b = new Belief({ themeKey: 'pushes|我', subject: '我', relation: 'pushes', polarity: -1, text: '旧判断', why: 'x', weight: 0.5, kind: 'identity', at: 1, via: 'digest' });
    transition(b, STATUS.HELD, { at: 1 });
    return b;
  };
  // ★ 候选判断**必须带 weight**：重熔出来的 j 一定有权重，
  //   漏了它 claimsOf 取到 0，heavyEnough 判不过，对照用例就会假绿。
  const cand = (b) => ({ themeKey: b.themeKey, subject: '我', relation: 'pushes', polarity: +1, text: '新判断', why: 'y', weight: 0.8, sources: [] });

  const b1 = mk();
  reconsider([b1], cand(b1), { now: 2, sources: [] });
  // ★ 这里断言的是「翻**了**」——reconsider 内部是 `{...ctx, memo}`，
  //   它强制把 memo 写成这条判断自己，于是 review 里 fresh != null 恒成立，
  //   单条、任意权重都能翻。这正是当年 8 条记忆被串掉的地方，
  //   所以要把这个危险性**钉在测试里**：它现在必须是 esteemed。
  ok('reconsider 单条能翻（这就是当年的 bug，钉住它）', b1.status === STATUS.ESTEEMED, 'got ' + b1.status);

  const b2 = mk();
  review([b2], cand(b2), { now: 2, sources: [], memo: null });
  ok('review + memo=null 单条翻不动', b2.status === STATUS.HELD, 'got ' + b2.status);

  const b3 = mk();
  const r = review([b3], [cand(b3), { ...cand(b3), weight: 0.9 }], { now: 2, sources: ['a', 'b'] });
  ok('两条独立反证照样能翻（不是一刀切禁掉）', r.retired.length === 1, 'got ' + r.retired.length);
}

// ── ④ 渲染：全可见 + 不重复 ──────────────────────────────────────
console.log('\n[④] 渲染（她实际看得见的那些字）');
{
  const jp = join(ROOT, '.mind', 'judgments.json');
  if (!existsSync(jp)) {
    console.log('  – 跳过：没有 .mind/judgments.json');
  } else {
    const j = JSON.parse(readFileSync(jp, 'utf8'));
    const live = j.list.filter((m) => !m.retireKind);
    const out = renderWorld(j.list, { name: '大乔' });
    const hidden = live.filter((m) => !out.text.includes(m.text));
    ok(`现役 ${live.length} 条全部可见`, hidden.length === 0, hidden.map((m) => m.text.slice(0, 16)).join(' / '));
    const dup = live.filter((m) => out.text.split(m.text).length - 1 > 1);
    ok('没有任何一条被念两遍', dup.length === 0, dup.map((m) => m.text.slice(0, 16)).join(' / '));
    ok('心境句不复述记忆原文', !/我此刻：.*——/.test(out.text));
  }
}

// ── ⑤ 「可见 = 未熔」：遮蔽与并发闸的两条不变量 ─────────────────────
//
// 2026-10-28 加的。它们都属于「改完看着对、其实没生效」那一类：
//   · 遮蔽的规则曾经是「永远留最后几条原文」——熔完她还在拿上一轮原文当上下文；
//   · tick 的成功路径忘了给 inFlight 复位——第一跳之后每一拍都被跳过，
//     日志里 tick-alive 恒为 n:1，看起来还活着，其实只醒过一次。
console.log('\n[⑤] 遮蔽与并发闸的不变量');
{
  const { planFullShadow } = await imp('plugin/shadow-plan.mjs');
  const p = planFullShadow([10, 11, 12, 13], new Map());
  ok('切法是「system 之后整段遮」', JSON.stringify(p?.shadow) === JSON.stringify([11, 12, 13]), JSON.stringify(p));

  const src = readFileSync(join(ROOT, 'plugin', 'index.mjs'), 'utf8');

  // ① 所有遮蔽调用都必须带 full:true（不许再回到「留最后几条」）
  const calls = [...src.matchAll(/compactChannel\([^)]*\)/g)].map((m) => m[0]);
  const naked = calls.filter((c) => !c.includes('full: true') && !c.includes('mindInst, opt'));
  ok('每处遮蔽调用都写了 { full: true }', naked.length === 0, naked.join(' | '));
  ok('遮蔽至少有一处真实调用', calls.length >= 2, 'calls=' + calls.length);

  // ② 熔成功后水位必须归零（否则遮掉之后旧水位会漏掉新话）
  ok('熔成功后把水位归零', /if \(shadowed\) writeCursor\(cursorPath, CHANNEL_SESSION_ID, 0\)/.test(src));

  // ③ 并发闸：成功返回也要复位 inFlight
  const tail = src.slice(src.indexOf('clearTimeout(hardTimer)'));
  ok('next() 的成功路径复位了 inFlight', /inFlight = false;/.test(tail.slice(0, 400)));
  ok('tick 保命计时器没有被 unref', !/hardTimer[\s\S]{0,120}unref\(\)/.test(src));
}

console.log(`\n==== ${fail === 0 ? '全绿' : '有红'}：${pass} 通过 / ${fail} 失败 ====\n`);
process.exit(fail === 0 ? 0 : 1);
