/**
 * smoke_structure_regressions.mjs —— 四个「不报错、看着还在跑」的结构性 bug 的回归钉。
 *
 * 工具：`node tests/smoke_structure_regressions.mjs`
 *
 * 这四个 bug 的共同点：**不抛异常、不写错误日志，只是悄悄不做**。
 * 修一次不够——只要有人把那段代码改回「看着更顺」的写法，它们就会原样回来，
 * 而验收表是绿的。所以这一份专门钉「代码长什么样」+「行为对不对」。
 *
 *   ① `startWakeLoop` 开头 `if (!cfg.wake || !agentsSvc) return;`
 *      → 关掉自己醒时，熔 / 遮蔽 / turn 钩子 / tick 全都不定义。
 *   ② turn hook 印章只写 `true`
 *      → 换屋子后永远命中 already，旧钩子盯着旧会话 id，新屋子一轮都不熔。
 *   ③ 钩子只在 kick() 里挂一次，漏了没人补
 *      → 只剩 tick 每分钟兜底，看起来还在跑。
 *   ④ `sting` 只在 persist() 里算
 *      → 重启后到第一次落盘之间是 undefined，排序/护盾/burden 全当 0。
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Mind } from '../src/mind.mjs';
import { createFileIo } from '../src/persist.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUG = readFileSync(join(ROOT, 'plugin', 'index.mjs'), 'utf8');
const MIND = readFileSync(join(ROOT, 'src', 'mind.mjs'), 'utf8');

// ★ 扫之前先剥注释：这四个 bug 的「旧写法」都被我写在注释里当教训，
//   第一版扫描当场被自己的注释骗了——判「没修」。剥完再扫才是在看代码。
const stripComments = (text) => String(text)
  .split('\n')
  .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
  .join('\n');
const PLUG_CODE = stripComments(PLUG);
const MIND_CODE = stripComments(MIND);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

// ── ① 熔不该被「关掉醒」一起关掉 ────────────────────────────────
{
  ok('startWakeLoop 不再因为 cfg.wake=false 早退',
    !/if \(!cfg\.wake \|\| !agentsSvc\) return;/.test(PLUG_CODE));
  ok('只挡「没有 agents 服务」', /if \(!agentsSvc\)/.test(PLUG_CODE));
  ok('tick 自己看 cfg.wake 才启动', /if \(cfg\.wake\) next\(\);/.test(PLUG_CODE) && /wake-loop-disabled/.test(PLUG_CODE));
  ok('pokeWake 也不会绕过 cfg.wake', /pokeWake = \(\) => \{ if \(cfg\.wake\) next\(\); \}/.test(PLUG_CODE));
}

// ── ② 印章必须记「挂在哪条会话上」──────────────────────────────
{
  ok('印章是对象、带会话 id', /ctx\[TURN_HOOK\] = \{ id: CHANNEL_SESSION_ID/.test(PLUG_CODE));
  ok('不再出现只写 true 的老写法', !/ctx\[TURN_HOOK\] = true;/.test(PLUG_CODE));
  ok('换会话时先卸掉上一枚', /typeof prev\.off === 'function'/.test(PLUG_CODE));
  ok('同一会话重复调用才跳过', /prev\?\.id === CHANNEL_SESSION_ID/.test(PLUG_CODE));
}

// ── ③ tick 每跳复核，漏挂能自愈 ────────────────────────────────
{
  ok('tick 里核印章并在不一致时补挂',
    /ctx\[TURN_HOOK\]\?\.id !== CHANNEL_SESSION_ID\) armTurnHook\(\)/.test(PLUG_CODE));
  ok('补挂失败只记日志、不拖垮 tick', /turn-hook-failed/.test(PLUG_CODE));
}

// ── ④ 加载完就算扎心度（不是等 persist）────────────────────────
{
  ok('构造完立刻 refreshSting', /if \(this\.episodes\.length\) this\.refreshSting\(\);/.test(MIND_CODE));

  // 行为：带经历 + 带判断的存档，构造完 sting 就该是 0.9，不用等任何一次 save
  const dir = mkdtempSync(join(tmpdir(), 'mind-reg-'));
  const path = join(dir, 'judgments.json');
  const NOW = 1_793_200_000_000;
  try {
    writeFileSync(path, JSON.stringify({
      version: 1,
      savedAt: NOW,
      fp: 'seed',
      seed: 0,
      count: 1,
      list: [{
        id: 'b1', themeKey: 'can_stand|他', subject: '他', relation: 'can_stand',
        polarity: 1, text: '被他照顾时我其实接得住', why: '有理由的', weight: 0.6,
        strength: 0.6, status: 'held', kind: 'episodic', createdAt: NOW - 86400e3, turns: [],
      }],
      absorbed: {},
      events: [],
      episodes: [{ id: 'e-000001', at: NOW - 3600e3, who: '他', what: '他把水杯推过来', feel: '松', arousal: 0.9, themeKey: 'can_stand|他' }],
    }, null, 1));

    const synth = { async synthesize() { return null; }, async ask() { return null; } };
    const mind = new Mind({ synth, io: createFileIo(path), now: () => NOW, name: '小乔' });
    ok('重启读回后 sting 立刻算出来（不是 undefined）', mind.store.list[0].sting === 0.9, 'sting=' + mind.store.list[0].sting);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n==== ${fail === 0 ? '全绿' : '有红'}：${pass} 通过 / ${fail} 失败 ====\n`);
process.exit(fail === 0 ? 0 : 1);
