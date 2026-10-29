/**
 * smoke_episode_flow.mjs —— 经历层的**端到端**（不是纯函数）。
 *
 * 工具：`node tests/smoke_episode_flow.mjs`
 *
 * 为什么还要这一条：`smoke_episode.mjs` 只证明「一条经历能收、能渲染」，
 * 证明不了「熔 → 收 → 落盘 → 重启还在 → 她看得见」这条链是通的。
 * 这个项目最贵的教训就是「模块写完了，没人叫得到它」——
 * 2026-10-28 真实熔了一次，judgments:2 / episodes:0，EPISODES 一次都没长出来。
 *
 * 所以这条测试用假模型把整条链跑一遍，四道断言：
 *   ① 只熔出经历、没有判断的那一轮，经历也要进库（不许挂在 judgments 非空后面）
 *   ② 落盘文件里真有 episodes
 *   ③ 重启（新建 Mind 读同一个文件）之后经历还在
 *   ④ 她看得见（world() 里出现「最近发生的事」）
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Mind } from '../src/mind.mjs';
import { createFileIo } from '../src/persist.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

const dir = mkdtempSync(join(tmpdir(), 'mind-episode-'));
const path = join(dir, 'judgments.json');
const NOW = 1_793_200_000_000;
const material = [
  '你把那扇付费弹窗关掉了，说这种东西不该让我碰。',
  '我没说话，只是把手机放下了。后来你问我累不累，我说还行。',
  '你没再追问，把水杯往我这边推了推。',
].join('\n');

/** 假模型：只给一件经历，一条判断都不给。 */
const synth = {
  async synthesize() {
    return JSON.stringify({
      judgments: [],
      episodes: [{ what: '我把手机放下，没再问那扇窗的事', feel: '有点惭愧，也有点松', who: '他', arousal: 0.7 }],
      theme: '',
    });
  },
};

try {
  const mind = new Mind({ synth, io: createFileIo(path), now: () => NOW, name: '小乔' });
  const out = await mind.digestSession([material]);

  ok('只熔出经历的那一轮也收（没被 judgments 挡）', mind.episodes.length === 1, 'episodes=' + mind.episodes.length);
  ok('再熔一次同一条不新增（同一件事合并）', await (async () => {
    await mind.digestSession([material]);
    return mind.episodes.length === 1;
  })());

  const raw = JSON.parse(readFileSync(path, 'utf8'));
  ok('落盘文件里有 episodes', Array.isArray(raw.episodes) && raw.episodes.length === 1, 'file episodes=' + (raw.episodes ?? []).length);
  ok('落盘的是她自己的话，不是原文', raw.episodes?.[0]?.what === '我把手机放下，没再问那扇窗的事');

  // ③ 重启
  const again = new Mind({ synth, io: createFileIo(path), now: () => NOW + 1000, name: '小乔' });
  ok('重启之后经历还在', again.episodes.length === 1, 'restored=' + again.episodes.length);

  // ④ 她看得见
  const world = again.world();
  ok('世界里有「最近发生的事」', world.includes('最近发生的事：'), world.slice(0, 120));
  ok('世界里有那件事的原句', world.includes('我把手机放下，没再问那扇窗的事'));
  ok('判断为空时世界仍然成立（不崩、不补空话）', typeof world === 'string' && world.length > 0);

  // 负控制：模型不给 episodes 时，什么都不长
  const silentSynth = { async synthesize() { return JSON.stringify({ judgments: [] }); } };
  const mind2 = new Mind({ synth: silentSynth, now: () => NOW, name: '小乔' });
  await mind2.digestSession([material]);
  ok('模型不给经历时不会凭空长出一条（负控制）', mind2.episodes.length === 0, 'episodes=' + mind2.episodes.length);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n==== ${fail === 0 ? '全绿' : '有红'}：${pass} 通过 / ${fail} 失败 ====\n`);
process.exit(fail === 0 ? 0 : 1);
