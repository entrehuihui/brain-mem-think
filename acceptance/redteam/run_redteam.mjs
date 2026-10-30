/**
 * run_redteam.mjs —— 红队总控：把全部对抗脚本串起来，出一张对抗总表。
 *
 * ======================= 它凭什么在这儿 =======================
 *
 * 单条对抗脚本各自能跑，但「五条假绿是不是都有人打」这件事，
 * 只有把它们放在一张表上才看得见。
 *
 * 而且这里要回答一个比「红没红」更重要的问题：
 *   **每一条假绿，是不是都有脚本在打？打的那个脚本，是不是真的会报警？**
 * 所以每个对抗脚本也会被喂一个「已知必须红」的样本（由脚本自己内部完成），
 * 这里只汇总它对真实现的判定。
 *
 * 退出码：0 只有「所有对抗脚本都跑完、且都给出了裁决」时才给。
 * 注意：**对抗脚本自己红，不一定是坏事**——它红通常意味着
 * 「某个假样子没被抓到」或者「真实现没达标」。两种都要人来读，所以汇总表要写清。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

const SCRIPTS = [
  ['r1', 'r1_paraphrase_alive.mjs', '换皮冒充「会想多」'],
  ['r2', 'r2_correction_driven.mjs', '被纠正冒充「会改自己」'],
  ['r3', 'r3_curiosity_loop.mjs', '死循环冒充「会追问」'],
  ['r4', 'r4_capacity_eviction.mjs', '容量淘汰冒充「会忘」'],
  ['r5', 'r5_summary_laundering.mjs', '摘要/截断/改写冒充「不存原文」'],
  ['r6', 'r6_phantom_mind.mjs', '幽灵实现：什么都不做也全绿？'],
];

const TIMEOUT = Number(process.env.RT_TIMEOUT_MS || 60_000);

function runOne(script, timeoutMs) {
  return new Promise((resolveP) => {
    const abs = resolve(HERE, script);
    const started = Date.now();
    const child = spawn(process.execPath, [abs], {
      cwd: ROOT,
      env: { ...process.env, ACCEPT_BUDGET_MS: String(Math.max(1000, timeoutMs - 5000)) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let settled = false;
    const done = (status, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({ script, status, ms: Date.now() - started, out, err, extra });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退 */ }
      done('TIMEOUT', `>${timeoutMs}ms`);
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => done('CRASH', e.message));
    child.on('close', (code) => {
      if (!/VERDICT:/.test(out)) {
        const first = (err || out).split(/\r?\n/).find((l) => /Error|error:|Cannot|TypeError|ReferenceError|SyntaxError/.test(l)) || '';
        return done('CRASH', `没打出裁决 exit=${code}：${first.trim().slice(0, 120)}`);
      }
      return done(code === 0 ? 'PASS' : 'FAIL', `exit=${code}`);
    });
  });
}

async function main() {
  console.log('');
  console.log('══ 红队对抗总表 ══════════════════════════════════════════════════');
  const rows = [];
  for (const [key, file, title] of SCRIPTS) {
    process.stdout.write(`   ▶ ${key} ${title} … `);
    const r = await runOne(file, TIMEOUT);
    rows.push({ key, title, ...r });
    const tag = { PASS: 'PASS', FAIL: 'FAIL', TIMEOUT: 'FAIL', CRASH: 'CRASH' }[r.status] ?? 'FAIL';
    console.log(`${tag}  ${(r.ms / 1000).toFixed(1)}s`);
  }
  console.log('─────────────────────────────────────────────────────────────────');
  let crashed = 0;
  let red = 0;
  for (const r of rows) {
    if (r.status === 'CRASH' || r.status === 'TIMEOUT') crashed += 1;
    else if (r.status === 'FAIL') red += 1;
    const reds = r.out.split(/\r?\n/).filter((l) => /✗/.test(l)).map((l) => l.replace(/.*✗\s*/, '').trim()).slice(0, 4);
    console.log(`   ${r.key}  ${r.status.padEnd(8)} ${(r.ms / 1000).toFixed(1)}s  ${r.title}`);
    if (r.extra && r.status !== 'PASS') console.log(`       ↳ ${r.extra}`);
    for (const x of reds) console.log(`       ✗ ${x.slice(0, 110)}`);
  }
  console.log('─────────────────────────────────────────────────────────────────');
  console.log(`   对抗脚本 ${rows.length} 条：绿 ${rows.filter((r) => r.status === 'PASS').length} / 红 ${red} / 崩或超时 ${crashed}`);
  console.log('   说明：对抗脚本报红 ≠ 实现有问题——多半是「某个假样子没被抓到」或「真实现没达标」，两种都要读细节。');
  console.log('═════════════════════════════════════════════════════════════════');
  console.log('');
  // 只有「全部跑完且都给出了裁决（没有崩、没有超时）」才给 0；红留给 run_all 汇总
  process.exitCode = crashed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('run_redteam 崩了：', e);
  process.exitCode = 1;
});
