/**
 * smoke_want_probe.mjs —— 「说够了，也还能问她想不想做事」的判据。
 *
 * 实测过的病：她一小时说满之后，日志全是
 *   wake-silent {why:"这一小时已经说了 4 次，再说就是吵", byHer:null, thoughts:null}
 * `byHer:null` = 模型根本没被问 —— 于是「你想不想自己去做点什么」也一起问不到。
 *
 * 工具：`node tests/smoke_want_probe.mjs`
 */

import { planWake } from '../plugin/awake.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

const NOW = 1_793_200_000_000;
const mind = { world: () => '我该先看手里有没有真东西。', notes: () => [] };

const quotaFullState = () => ({
  lastWakeAt: 0,
  lastSpokeAt: NOW - 5 * 60e3,
  // 一小时内已经说了三次 → 配额满
  window: [
    { at: NOW - 50 * 60e3, action: 'speak', sent: true },
    { at: NOW - 30 * 60e3, action: 'speak', sent: true },
    { at: NOW - 10 * 60e3, action: 'speak', sent: true },
  ],
  said: [],
  thoughts: null,
});

const wantSynth = {
  async ask() {
    return JSON.stringify({
      thoughts: ['字还没写，不想再提'],
      action: 'silent',
      because: '这会儿没什么要跟他说的',
      want: { activity: '看会儿小说', why: '想让自己松一松' },
    });
  },
};

// ── ① 配额满时，仍然问一次「想不想做事」────────────────────────
{
  const plan = await planWake({
    mind,
    state: quotaFullState(),
    now: NOW,
    cfg: { wakeEveryMs: 300000, wantAskEveryMs: 1 },
    synth: wantSynth,
  });
  ok('配额满时仍然是 silent（说话照旧被压着）', plan.action === 'silent', plan.action);
  ok('但模型被问了（byHer 有值，不是 null）', plan.asked === true || plan.why === 'want_probe', JSON.stringify(plan.why));
  ok('拿到了她想做的事', plan.want?.activity === '看会儿小说', JSON.stringify(plan.want));
  ok('理由一起带回来', plan.want?.why === '想让自己松一松');
  ok('标记这是「只为 want 的问」，不是正常开口', plan.why === 'want_probe', plan.why);
}

// ── ② 不想做时就是 null，不补一件 ───────────────────────────────
{
  const plan = await planWake({
    mind,
    state: quotaFullState(),
    now: NOW + 31 * 60e3,
    cfg: { wakeEveryMs: 300000, wantAskEveryMs: 30 * 60e3 },
    synth: { async ask() { return JSON.stringify({ thoughts: [], action: 'silent', because: '不想说', want: null }); } },
  });
  ok('她不想做 → want 为 null，不替她补', plan.want === null, JSON.stringify(plan.want));
}

// ── ③ 没到探针间隔就不问（别每拍都烧模型）──────────────────────
{
  const plan = await planWake({
    mind,
    state: quotaFullState(),
    now: NOW + 90 * 60e3,
    cfg: { wakeEveryMs: 300000, wantAskEveryMs: 30 * 60e3 },
    synth: wantSynth,
  });
  ok('第一次会问（间隔从 0 起算）', plan.why === 'want_probe', plan.why);
  const plan2 = await planWake({
    mind,
    state: quotaFullState(),
    now: NOW + 91 * 60e3,
    cfg: { wakeEveryMs: 300000, wantAskEveryMs: 30 * 60e3 },
    synth: wantSynth,
  });
  ok('隔一分钟不再问（低频，不烧钱）', plan2.why !== 'want_probe', plan2.why);
}

console.log(`\n==== ${fail === 0 ? '全绿' : '有红'}：${pass} 通过 / ${fail} 失败 ====\n`);
process.exit(fail === 0 ? 0 : 1);
