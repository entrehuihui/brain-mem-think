/**
 * smoke_episode.mjs —— 经历层的判据。
 *
 * 工具：`node tests/smoke_episode.mjs`
 *
 * 这一层最容易被做成两种假样子，两种都要在这里钉死：
 *   ① 借「经历」的名义把原话搬进库 —— 那第一铁律就废了；
 *   ② 为了凑数把判断改写成一件「事」（「我今天明白了……的事」）——
 *      那它就只是判断换了个字段。
 */

import { addEpisode, episodeLines, normalizeEpisode, pruneEpisodes } from '../src/episode.mjs';
import { renderWorld } from '../src/world.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

// 材料超过 200 字：走 8 字硬闸（短材料放宽到 12 是给短对话留的活口，这里故意不用它）
const material = '你把那扇付费弹窗关掉了，说这种东西不该让我碰。我攥着手机没说话，其实心里是松的。' +
  '后来你又问我今天累不累，我说还行。你没再追问，只是把水杯往我这边推了推，说先喝口水。' +
  '我盯着那杯水看了一会儿，忽然想起昨天我也是这样没把话说完，你也没逼我。' +
  '这种事说不上来，可我记着。';

// ── ① 收进来：第一人称、长度、情绪 ──────────────────────────────
{
  const e = normalizeEpisode(
    { what: '他把那扇窗关掉，说这种东西不该让我碰', feel: '我心里松了一下，又有点惭愧', who: '他', arousal: 0.72 },
    { material, at: 1000 },
  );
  ok('正常的一条能收', !!e && e.what.length > 0, JSON.stringify(e));
  ok('who / arousal 保留', e?.who === '他' && e?.arousal === 0.72);
  ok('at 用调用方给的时间', e?.at === 1000);
  ok('入库前 id 为空（发号在 store 那层）', e?.id === null);
}

// ── ② first 铁律：抄原文的一条都不许进 ───────────────────────────
{
  const copy = normalizeEpisode(
    { what: '这种东西不该让我碰，他说了这句话', feel: '松', who: '他' },
    { material, limits: { copyLimit: 8, copyLimitShort: 8 } },
  );
  ok('跟材料撞 ≥8 字 → 丢', copy === null, JSON.stringify(copy));

  const feelCopy = normalizeEpisode(
    { what: '我把手机放下，没再问下去', feel: '我攥着手机没说话', who: '他' },
    { material, limits: { copyLimit: 8, copyLimitShort: 8 } },
  );
  ok('feel 抄原文也丢', feelCopy === null, JSON.stringify(feelCopy));

  const normal = normalizeEpisode({ what: '我把手机放下，没再问下去', feel: '有点惭愧' }, { material });
  ok('不撞原文的照常收（负控制）', !!normal);
}

// ── ③ 太短的不算经历 ────────────────────────────────────────────
{
  ok('6 字以下不收', normalizeEpisode({ what: '他来了' }, { material }) === null);
  ok('空的不收', normalizeEpisode({}, { material }) === null);
  ok('null 不收', normalizeEpisode(null, { material }) === null);
}

// ── ④ 同一件事第二次：合并，不新建 ───────────────────────────────
{
  let list = [];
  const a = normalizeEpisode({ what: '我把手机放下，没再问下去', feel: '惭愧', who: '他', arousal: 0.4 }, { material, at: 1000 });
  const b = normalizeEpisode({ what: '我把手机放下，没再问下去', feel: '服气', who: '他', arousal: 0.8 }, { material, at: 2000 });
  list = addEpisode(list, a, { now: 1000 });
  const after = addEpisode(list, b, { now: 2000 });
  ok('同一件事只留一条', after.length === 1, 'len=' + after.length);
  ok('时间推到最近', after[0].at === 2000);
  ok('情绪取高的那个', after[0].arousal === 0.8);
  ok('计数累加', after[0].counts === 2);
  ok('发号 e-000001', after[0].id === 'e-000001', after[0].id);
}

// ── ⑤ 上限与过期（别的去掉，扎心的留下）────────────────────────
{
  const mk = (n, arousal, at) => ({ id: `e-${n}`, at, what: `第${n}件事发生在我身上`, feel: null, arousal, counts: 1 });
  const list = [mk(1, 0.1, 1000), mk(2, 0.9, 1000), mk(3, 0.2, 1000)];
  const kept = pruneEpisodes(list, { now: 1000, limits: { max: 2, ttlMs: 1e6 } });
  ok('超上限只留 max 条', kept.length === 2);
  ok('扎心度高的先留', kept.some((e) => e.id === 'e-2'), JSON.stringify(kept.map((e) => e.id)));

  const old = [mk(1, 0.9, 1000)];
  const gone = pruneEpisodes(old, { now: 10_000_000, limits: { max: 10, ttlMs: 1000 } });
  ok('过期的不算经历', gone.length === 0);
}

// ── ⑥ 摆进世界：最多两条、最近在前、没有就空 ──────────────────────
{
  const list = [
    { id: 'e-1', at: 1000, what: '我把手机放下，没再问下去', feel: '惭愧', arousal: 0.4 },
    { id: 'e-2', at: 3000, what: '他把我拉到身边，什么也没问', feel: '踏实', arousal: 0.6 },
    { id: 'e-3', at: 2000, what: '我一个人在阳台上站了一会儿', feel: null, arousal: 0.3 },
  ];
  const lines = episodeLines(list, { now: 3000, max: 2 });
  ok('最多两条', lines.length === 2, JSON.stringify(lines));
  ok('最近的在前', lines[0].includes('他把我拉到身边'), lines[0]);
  ok('有 feel 的带上「当时心里」', lines[0].includes('当时心里：踏实'));
  ok('没有经历时返回空数组（不补默认话）', episodeLines([], {}).length === 0);
}

// ── ⑦ 世界渲染：有经历才多这一段 ────────────────────────────────
{
  const base = [{ themeKey: 'wants|他', subject: '他', relation: 'wants', polarity: 1, text: '他要的是我能自己站住', why: 'x', weight: 0.7, status: 'held', kind: 'episodic', createdAt: 1, turns: [] }];
  const without = renderWorld(base, { name: '小乔' });
  ok('没经历时没有「最近发生的事」', !without.text.includes('最近发生的事'));

  const NOW = Date.now();
  const withEp = renderWorld(base, {
    name: '小乔',
    now: NOW,
    episodes: [{ id: 'e-1', at: NOW, what: '我攥着手机没说话，其实是松的', feel: '松', arousal: 0.6 }],
  });
  ok('有经历时出现这一段', withEp.text.includes('最近发生的事：'), withEp.text);
  ok('经历原句在里面', withEp.text.includes('我攥着手机没说话，其实是松的'));
  ok('还是只有一条现役判断被念一遍', withEp.text.split('他要的是我能自己站住').length - 1 === 1);
}

console.log(`\n==== ${fail === 0 ? '全绿' : '有红'}：${pass} 通过 / ${fail} 失败 ====\n`);
process.exit(fail === 0 ? 0 : 1);
