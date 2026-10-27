/**
 * _e_segmented.mjs —— 把 e 组的 A / B / C 三段各自放进**独立子进程**跑。
 *
 * ============== 它凭什么在这儿 ==============
 *
 * 实测过一件事：
 *   `e` 单独跑时 E2/E3 是绿的（让位 1 次、because 有值）；
 *   放进全表、或放进 selftest 跑，就红。
 *
 * 差别只在**同一进程里 A 段先跑过了**。A 段喂了三条打底、B 段再喂更重的，
 * 假模型的累积账本（同一主题见过几回）在段与段之间串了。
 *
 * 主人裁决：「进程隔离是唯一不靠纪律的隔离。」
 * 所以这里把三段拆成三个进程：每段一个全新环境，段内该连的账照连。
 *
 * 用法：node acceptance/_e_segmented.mjs <假实现label> [超时ms]
 * 输出：最后一行 @@RESULT@@{JSON}
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { EXIT } from './_harness.mjs';
import { isMain } from './_run.mjs';

const SEGMENTS = ['A', 'B', 'C'];

function runSeg(impl, seg, timeoutMs) {
  return new Promise((resolveP) => {
    const here = dirname(fileURLToPath(import.meta.url));
    const child = spawn(process.execPath, [resolve(here, '_selftest_one.mjs'), 'e', impl, seg], {
      cwd: resolve(here, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolveP({ seg, ...r }); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退 */ }
      done({ status: 'CRASH', fails: [], crash: `段 ${seg} 超过 ${timeoutMs}ms 没结束` });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => done({ status: 'CRASH', fails: [], crash: 'spawn 失败：' + e.message }));
    child.on('close', (code) => {
      const m = out.match(/@@RESULT@@(.*)/);
      if (!m) {
        const first = (err || out).split(/\r?\n/).find((l) => /Error|error:/.test(l)) || '';
        return done({ status: 'CRASH', fails: [], crash: `段 ${seg} 没吐结果（exit=${code}）：${first.trim().slice(0, 120)}` });
      }
      try { done(JSON.parse(m[1])); } catch { done({ status: 'CRASH', fails: [], crash: `段 ${seg} 结果解析失败` }); }
    });
  });
}

async function main() {
  const impl = process.argv[2] ?? 'good';
  const timeoutMs = Number(process.argv[3] ?? 45_000);
  const results = [];
  for (const seg of SEGMENTS) results.push(await runSeg(impl, seg, timeoutMs));

  const fails = results.flatMap((r) => (r.fails ?? []).map((f) => ({ ...f, seg: r.seg })));
  const crashed = results.filter((r) => r.status === 'CRASH');
  const status = crashed.length ? 'CRASH' : fails.length ? 'FAIL' : 'PASS';
  process.stdout.write('@@RESULT@@' + JSON.stringify({
    status,
    fails,
    segs: results.map((r) => ({ seg: r.seg, status: r.status, fails: (r.fails ?? []).map((f) => f.id) })),
    crash: crashed.map((c) => c.crash).join(' / ') || undefined,
  }) + '\n');

  if (process.env.E_SEG_VERBOSE) {
    for (const r of results) process.stdout.write(`  ${r.seg}: ${r.status} ${(r.fails ?? []).map((f) => f.id).join(',')}\n`);
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    process.stdout.write('@@RESULT@@' + JSON.stringify({ status: 'CRASH', fails: [], crash: String(e?.message ?? e) }) + '\n');
    process.exitCode = EXIT.FAIL;
  });
}
