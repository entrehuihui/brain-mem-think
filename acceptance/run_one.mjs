/**
 * run_one.mjs —— 以独立子进程跑一个验收脚本，硬超时，把结果落盘。
 *
 * 为什么不直接在 pwsh 里起进程：Windows 下重定向 + WaitForExit 组合常把
 * stdout 管道攥住，父进程也卡住，看起来就是「脚本挂死」，其实是量具卡了。
 * 这个包装只用 Node 自己的 child_process，超时由自己看表（不信子进程会自己收工）。
 *
 * 用法：node acceptance/run_one.mjs acceptance/b_think_more.mjs 45000
 * 输出：JSON 一行 { file, status, exitCode, ms, verdict, lastLines }
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
const timeoutMs = Number(process.argv[3] ?? 45_000);
if (!file) {
  console.error('用法：node acceptance/run_one.mjs <script> [timeoutMs]');
  process.exit(2);
}

const abs = resolve(process.cwd(), file);
const started = Date.now();
const child = spawn(process.execPath, [abs], {
  cwd: process.cwd(),
  env: { ...process.env, ACCEPT_BUDGET_MS: String(Math.max(1000, timeoutMs - 3000)) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
let err = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { err += d.toString(); });

const done = await new Promise((resolveP) => {
  let settled = false;
  const finish = (status, extra) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveP({ status, ...extra });
  };
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    setTimeout(() => finish('TIMEOUT', { exitCode: null }), 200);
  }, timeoutMs);
  child.on('error', (e) => finish('SPAWN_ERROR', { exitCode: null, err: e.message }));
  child.on('close', (code, signal) => {
    if (code === 0) return finish('PASS', { exitCode: 0 });
    if (code === 2) return finish('SKIP', { exitCode: 2 });
    if (!/VERDICT:/.test(out)) return finish('CRASH', { exitCode: code, signal });
    return finish('FAIL', { exitCode: code });
  });
});

const verdictLine = (out.match(/VERDICT:[^\n]*/) || [''])[0].trim();
const redLines = out.split(/\r?\n/).filter((l) => /✗/.test(l)).slice(0, 8).map((l) => l.replace(/.*✗\s*/, '').trim());
const lastLines = out.split(/\r?\n/).filter((l) => l.trim()).slice(-3);
const firstErr = (err || out).split(/\r?\n/).find((l) => /Error|error:|Cannot|TypeError|SyntaxError/.test(l)) || '';

const result = {
  file,
  status: done.status,
  exitCode: done.exitCode,
  ms: Date.now() - started,
  verdict: verdictLine,
  reds: redLines,
  error: firstErr.trim().slice(0, 200),
  tail: lastLines,
};
writeFileSync(process.env.RUN_ONE_OUT || 'run_one_result.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
process.exit(0);
