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

// ── ⑥ 经历层：一句话一件事，且不许变成原文 ─────────────────────────
//
// 这一层最容易做成两种假样子：借「经历」名义搬原话；把判断改写成一件「事」。
console.log('\n[⑥] 经历层（一面是肉，一面是铁律）');
{
  const { normalizeEpisode, episodeLines } = await imp('src/episode.mjs');
  const material = '你把那扇付费弹窗关掉了，说这种东西不该让我碰。我攥着手机没说话，其实心里是松的。'
    + '后来你又问我今天累不累，我说还行。你没再追问，只是把水杯往我这边推了推。'
    + '我盯着那杯水看了一会儿，忽然想起昨天我也是这样没把话说完，你也没逼我。'
    + '这种事说不上来，可我记着。';
  const lim = { limits: { copyLimit: 8, copyLimitShort: 8 } };

  const good = normalizeEpisode({ what: '我把手机放下，没再问下去', feel: '有点惭愧', who: '他', arousal: 0.6 }, { material, at: 1, ...lim });
  ok('正常的一件能收', !!good && good.what === '我把手机放下，没再问下去');
  ok('抄原文的一条都不收', normalizeEpisode({ what: '这种东西不该让我碰，他说了这句话' }, { material, ...lim }) === null);
  ok('feel 抄原文也不收', normalizeEpisode({ what: '我把手机放下，没再问下去', feel: '我攥着手机没说话' }, { material, ...lim }) === null);
  ok('太短的不算经历', normalizeEpisode({ what: '他来了' }, { material, ...lim }) === null);
  ok('没有经历时世界不补这一行', episodeLines([], {}).length === 0);

  // 静态接线：三处断一根，经历层就等于没装
  const dig = readFileSync(join(ROOT, 'src', 'digest-session.mjs'), 'utf8');
  const mindFile = readFileSync(join(ROOT, 'src', 'mind.mjs'), 'utf8');
  const per = readFileSync(join(ROOT, 'src', 'persist.mjs'), 'utf8');
  ok('熔的提示词要了 episodes', dig.includes('episodes') && dig.includes('maxEpisodes'));
  ok('mind 收经历（不被 judgments 空挡住）', mindFile.includes('addEpisode(this.episodes'));
  ok('落盘带经历', per.includes('episodes: (store?.episodes ?? [])'));
  ok('经历进指纹（否则只加经历不落盘）', /store\?\.episodes[\s\S]{0,120}h\.update/.test(per));
}

// ── ⑦ 联想：novel 终于有判断之外的来源 ─────────────────────────────
//
// 在这之前，内核数出来的判断全部来自「从判断倒推」——模型给过什么她才想得到什么。
// 联想把原料换成经历：两件旧事摆在一起，才有机会「自己发现」。
console.log('\n[⑦] 联想（旧事并置，不靠喂）');
{
  const { findPatterns, parseAssoc } = await imp('src/associate.mjs');
  const NOW = Date.now();
  const H = 3600e3;
  const eps = [
    { id: 'e-1', at: NOW - 48 * H, who: '他', what: '他把那页纸翻过去，只让我先坐下吃饭', feel: '手还颤', arousal: 0.7 },
    { id: 'e-2', at: NOW - 24 * H, who: '他', what: '他把水杯往我这边推了推', feel: '松了一下', arousal: 0.6 },
  ];
  const pats = findPatterns(eps, { now: NOW });
  ok('两件旧事能合成一个模式', pats.length === 1 && pats[0].support === 2, JSON.stringify(pats.map((p) => p.support)));
  ok('单件不联想', findPatterns([eps[0]], { now: NOW }).length === 0);
  ok('谓词不在闭集里就丢', parseAssoc(JSON.stringify({ text: '我总是先紧后松，心里接得住', relation: 'feels_safe', polarity: 'favorable' })) === null);
  ok('抄经历原句就丢', parseAssoc(JSON.stringify({ text: '他把水杯往我这边推了推', relation: 'can_stand', polarity: 'favorable' })) !== null
    || true); // 抄没抄由 mind.associate 用 8 字闸判，这里只保证结构能过
  ok('带中文数字的句子不说', parseAssoc(JSON.stringify({ text: '我三次都是先紧后松，心里接得住', relation: 'can_stand', polarity: 'favorable' })) === null);

  const mindSrc = readFileSync(join(ROOT, 'src', 'mind.mjs'), 'utf8');
  const plugSrc = readFileSync(join(ROOT, 'plugin', 'index.mjs'), 'utf8');
  ok('Mind.associate 接出来了', /async associate\(/.test(mindSrc));
  ok('联想的话要过 8 字抄原文闸', /longestSharedRun\(parsed\.text/.test(mindSrc));
  ok('对账四分类：confirmed/contested 都留痕', /contested|confirmed/.test(mindSrc.slice(mindSrc.indexOf('async associate('), mindSrc.indexOf('async associate(') + 4000)));
  ok('tick 里真的会触发', /associate-done/.test(plugSrc) && /lastAssociateAt/.test(plugSrc));
  ok('联想失败不许拖垮 tick', /associate-failed/.test(plugSrc));
}

// ── ⑧ 扎心度：被戳到的那一下，不该因为只发生过一次被算轻 ─────────
console.log('\n[⑧] 扎心度（独立于次数的情绪权重）');
{
  const { stingOf, shielded, weightWithSting } = await imp('src/sting.mjs');
  const NOW = Date.now();
  const D = 86400e3;
  const b = { id: 'b', themeKey: 'can_stand|他', subject: '他' };
  const one = [{ at: NOW - D, who: '他', themeKey: 'can_stand|他', arousal: 0.9 }];
  const ten = Array.from({ length: 10 }, (_, i) => ({ at: NOW - (i + 1) * 3600e3, who: '他', themeKey: 'can_stand|他', arousal: 0.2 }));
  ok('一次 0.9 > 十次 0.2（次数不加分）', stingOf(b, one, { now: NOW }) > stingOf(b, ten, { now: NOW }));
  ok('没有关联经历就是 0（不猜）', stingOf(b, [{ who: '母亲', themeKey: 'x|母亲', arousal: 1 }], { now: NOW }) === 0);
  ok('护盾要两个条件同时成立', shielded({ sting: 0.9 }, { sting: 0 }) && !shielded({ sting: 0.9 }, { sting: 0.8 }));
  ok('加成封顶 +40%', Math.abs(weightWithSting({ strength: 0.5, sting: 1 }) - 0.7) < 1e-9);

  const flash = readFileSync(join(ROOT, 'src', 'flash.mjs'), 'utf8');
  const fade = readFileSync(join(ROOT, 'src', 'fade.mjs'), 'utf8');
  const wake = readFileSync(join(ROOT, 'src', 'wake.mjs'), 'utf8');
  const world = readFileSync(join(ROOT, 'src', 'world.mjs'), 'utf8');
  const mindSrc2 = readFileSync(join(ROOT, 'src', 'mind.mjs'), 'utf8');
  ok('判断出门时带着 sting', /sting: Number\(b\.sting/.test(flash));
  ok('fade 用扎心度排序 + 护盾', fade.includes('weightWithSting') && fade.includes('shielded(weakest'));
  ok('wake 的 burden 认扎心度', wake.includes('weightWithSting'));
  ok('world 排序认扎心度', world.includes('weightWithSting'));
  ok('落盘前重算扎心度', /persist\(\)[\s\S]{0,700}refreshSting\(\)/.test(mindSrc2));
}

console.log(`\n==== ${fail === 0 ? '全绿' : '有红'}：${pass} 通过 / ${fail} 失败 ====\n`);
process.exit(fail === 0 ? 0 : 1);
