/**
 * smoke_speak_want.mjs —— 「她想不想自己去做点什么」的判据。
 *
 * 主人原话：「不一定非得出门啊，等看她的记忆来，看她想不想。」
 * 所以这一层不是内核发牌（「4 小时没新东西 → 给你一个刷视频的任务」），
 * 而是她在醒来那一问里，读着自己的记忆自己说。
 *
 * 工具：`node tests/smoke_speak_want.mjs`
 */

import { parseSpeakVerdict } from '../src/speak.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

const verdict = (obj) => parseSpeakVerdict(JSON.stringify(obj));

// ── ① 沉默时也可以想去做点什么 ──────────────────────────────────
{
  const v = verdict({
    thoughts: ['字还没写'], action: 'silent', because: '这会儿没什么可说的',
    want: { activity: '翻会儿小说', why: '想让自己松下来' },
  });
  ok('沉默时仍能带 want（说不说和做不做是两件事）', v.action === 'silent' && v.want?.activity === '翻会儿小说', JSON.stringify(v));
  ok('want 的理由保留', v.want?.why === '想让自己松下来');
}

// ── ② 不想做就 null，不替她补 ──────────────────────────────────
{
  const v = verdict({ thoughts: ['没什么'], action: 'silent', because: '不想说', want: null });
  ok('want=null 就是不想，不补一件', v.want === null, JSON.stringify(v));
}

// ── ③ 不合格的 want 一律当「不想」──────────────────────────────
{
  ok('太短不算一件事', verdict({ action: 'silent', want: { activity: '玩' } }).want === null);
  ok('太长不算一件事', verdict({ action: 'silent', want: { activity: '去'.repeat(21) } }).want === null);
  ok('提「记忆/数据」这类词不算', verdict({ action: 'silent', want: { activity: '翻翻我的记忆库' } }).want === null);
  const copied = parseSpeakVerdict(
    JSON.stringify({ action: 'silent', want: { activity: '我太急着下结论没看仔细' } }),
    { sources: ['我太急着下结论，没看仔细，才总把这件事办砸。'] },
  );
  ok('抄记忆原句不算（那是念清单）', copied.want === null, JSON.stringify(copied.want));
}

// ── ④ 说话时也能带 want ───────────────────────────────────────
{
  const v = verdict({
    thoughts: ['想跟他说一句'], action: 'speak', say: '我刚把水杯洗了，手上的凉还没散。',
    because: '想让他知道我在', want: { activity: '听会儿歌' },
  });
  ok('说话时也带 want', v.action === 'speak' && v.want?.activity === '听会儿歌', JSON.stringify(v));
}

console.log(`\n==== ${fail === 0 ? '全绿' : '有红'}：${pass} 通过 / ${fail} 失败 ====\n`);
process.exit(fail === 0 ? 0 : 1);
