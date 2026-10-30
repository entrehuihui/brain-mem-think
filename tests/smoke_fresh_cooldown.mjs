/**
 * smoke_fresh_cooldown.mjs —— 冷却不再只看时间，看「有没有新东西」。
 *
 * 主人原话：「只要我给她发过消息，或者她融了一次归档会话，这个闸口就重置，
 *   以为是有新的记忆了。」
 *
 * 工具：`node tests/smoke_fresh_cooldown.mjs`
 */

import { gate } from '../src/wake.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

const NOW = 1_793_200_000_000;
const MIN = 60e3;
const notes = [{ id: 'b1', status: 'held', text: '他总先顾着我的感受', why: '有理由的', strength: 0.6, weight: 0.6, sting: 0, themeKey: 'wants|他', kind: 'episodic' }];
const base = { now: NOW, history: [], said: [], gap: 5 * MIN };
const spokeAgo = (ms) => NOW - ms;

// ── ① 说完 5 分钟、没有任何新东西 → 闭嘴 ─────────────────────────
{
  const g = gate(notes, { ...base, lastSpokeAt: spokeAgo(5 * MIN) });
  ok('没有新料时照旧拦住', g.pass === false && /刚说过话/.test(g.why), g.why);
}

// ── ② 说完 5 分钟，但主人刚发了消息 → 放行 ──────────────────────
{
  const g = gate(notes, { ...base, lastSpokeAt: spokeAgo(5 * MIN), freshSince: NOW - 1 * MIN });
  ok('主人说完话之后她能应一句（冷却让路）', g.pass === true, g.why);
}

// ── ③ 说完 5 分钟，但刚熔出判断 → 放行 ──────────────────────────
{
  const g = gate(notes, { ...base, lastSpokeAt: spokeAgo(5 * MIN), freshSince: NOW - 2 * MIN });
  ok('熔出判断之后也能应（记忆变了）', g.pass === true, g.why);
}

// ── ④ 新料比「上次开口」还旧 → 不算新 (不能一直放行) ────────────
{
  const g = gate(notes, { ...base, lastSpokeAt: spokeAgo(5 * MIN), freshSince: spokeAgo(30 * MIN) });
  ok('旧信号不算新料（不会永久放行）', g.pass === false && /刚说过话/.test(g.why), g.why);
}

// ── ⑤ 超过 45 分钟，本来就该放行 ────────────────────────────────
{
  const g = gate(notes, { ...base, lastSpokeAt: spokeAgo(46 * MIN) });
  ok('冷却过完自然放行（负控制）', g.pass === true, g.why);
}

// ── ⑥ 一小时说满 2 次，仍然压着（新料不能破配额）───────────────
{
  const g = gate(notes, {
    ...base,
    lastSpokeAt: spokeAgo(5 * MIN),
    freshSince: NOW - 1 * MIN,
    history: [
      { at: NOW - 20 * MIN, action: 'speak', sent: true },
      { at: NOW - 10 * MIN, action: 'speak', sent: true },
    ],
  });
  ok('配额是独立的闸：说满了，有新料也不放', g.pass === false, g.why);
}

console.log(`\n==== ${fail === 0 ? '全绿' : '有红'}：${pass} 通过 / ${fail} 失败 ====\n`);
process.exit(fail === 0 ? 0 : 1);
