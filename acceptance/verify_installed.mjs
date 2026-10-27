/**
 * verify_installed.mjs —— 重启后一键验「插件到底加载了没有」。
 *
 * 查四样，缺哪样就说哪样没到：
 *   ① .mind/mind.log 有没有 apply-entered / apply-done
 *   ② 注入回调有没有被宿主调过（inject-archive / inject-agents / systemPrompt）
 *   ③ 通道会话 mind-her 建起来没有
 *   ④ 账本 wake.json 在不在
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '%USERPROFILE%\\.dsh\\profiles\\web\\plugins\\mind';
const LOG = join(ROOT, '.mind', 'mind.log');
const WAKE = join(ROOT, '.mind', 'wake.json');
const SESSIONS = '%USERPROFILE%\\.dsh\\sessions';

let bad = 0;
const ok = (name, cond, detail) => {
  if (!cond) bad += 1;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

console.log('\n【① 插件进没进 apply】');
if (!existsSync(LOG)) {
  ok('日志文件存在', false, `${LOG} 不存在 → 插件压根没加载`);
} else {
  const lines = readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
  const events = lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const names = events.map((e) => e.event);
  ok('apply-entered', names.includes('apply-entered'), `共 ${lines.length} 行`);
  ok('apply-done', names.includes('apply-done'));
  console.log('     事件序列:', names.join(' → ') || '(空)');
  const last = events[events.length - 1];
  if (last && last.event) console.log('     最后一条:', JSON.stringify(last).slice(0, 160));
}

console.log('\n【② 注入回调有没有被宿主调】');
if (existsSync(LOG)) {
  const txt = readFileSync(LOG, 'utf8');
  ok('workspaceRegistry+sessions 触发', txt.includes('inject-archive'));
  ok('agents 触发', txt.includes('inject-agents'));
} else {
  ok('（没日志，跳过）', false);
}

console.log('\n【③ 通道会话 mind-her】');
{
  let found = false;
  try {
    const { readdirSync } = await import('node:fs');
    for (const d of readdirSync(SESSIONS)) {
      if (d.includes('mind-her')) { found = true; break; }
      const sub = join(SESSIONS, d);
      try {
        for (const s of readdirSync(sub)) if (s.includes('mind-her')) { found = true; break; }
      } catch { /* 跳过 */ }
      if (found) break;
    }
  } catch { /* 读不了目录 */ }
  ok('会话已建', found, found ? '' : '重启后 5 秒内该出现，没出现说明 channel-create 失败（看日志 channel-create-failed）');
}

console.log('\n【④ 账本】');
ok('wake.json 存在', existsSync(WAKE), existsSync(WAKE) ? '' : '唤醒定时器 10 分钟才写一次，刚重启时没有是正常的');

console.log('\n' + '═'.repeat(60));
console.log(bad === 0 ? '全部到位' : `${bad} 项没到`);
console.log('═'.repeat(60));
