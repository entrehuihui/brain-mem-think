/**
 * smoke_tick_inflight.mjs —— 「醒环不许只醒一次」的回归。
 *
 * 工具：`node tests/smoke_tick_inflight.mjs`
 *
 * 为什么要有它（2026-10-28 实测）：
 *
 *   `next()` 里 tick 成功返回时，finally 只 `schedule()`，**没给 inFlight 复位**。
 *   于是第一跳正常跑完之后 `inFlight` 永远是 true，之后每一拍都走并发闸：
 *
 *     tick-alive {n:1}
 *     tick-skip-inflight {n:1}
 *     tick-skip-inflight {n:1}     ← 每分钟一次，永远
 *     （`tick-timeout` 一次都不出现，因为保命计时器只在 tick 没返回时才触发）
 *
 *   看起来还活着，其实装好之后只醒过一次。修法是 finally 里补 `inFlight = false`。
 *
 * 测法：用假宿主把插件跑起来，`wakeTickMs=1000`，等 4 秒，数 `tick-alive` 的 n。
 *   ① 新代码：n = 1,2（≥2 拍）
 *   ② 把复位那行删掉：n = 1（这就是回归的样子）
 *
 * 注意：假宿主里第 2 拍之后可能挂住（它没有真的 llm / agents），这是测试环境的事，
 * 不是插件的事——本测试只断言「至少第二拍跑起来了」。
 */

import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'mind-tick-'));
cpSync(join(ROOT, 'plugin'), join(dir, 'plugin'), { recursive: true });
cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
cpSync(join(ROOT, 'package.json'), join(dir, 'package.json'));

const noop = () => {};
const fakeAgent = { status: 'idle', session: { id: 's' }, followup() {} };
const services = {
  agents: { get: () => null, create: async () => fakeAgent, resume: async () => fakeAgent },
  sessions: { get: () => null, flush: async () => true },
  llm: { stream: () => ({ [Symbol.asyncIterator]() { return { next: async () => ({ done: true, value: undefined }) }; } }) },
  systemPrompt: { section: () => () => {}, context: () => () => {} },
  tools: { get: () => [], register: () => () => {} },
};
const ctx = {
  get: (n) => services[n],
  on: () => noop,
  effect: (fn) => { fn(); return noop; },
  inject: (names, fn) => { try { fn(); } catch { /* 服务拿不到就算 */ } },
  logger: { info: noop, warn: noop, debug: noop, error: noop },
};

const mod = await import(pathToFileURL(join(dir, 'plugin', 'index.mjs')).href);
mod.apply(ctx, {
  enabled: true,
  wake: true,
  wakeTickMs: 1000,
  digestOnArchive: false,
  injectOnTurn: false,
  act: false,
  name: '测试',
});

await new Promise((r) => setTimeout(r, 4200));

const logPath = join(dir, '.mind', 'mind.log');
const lines = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : [];
const evs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const alive = evs.filter((e) => e.event === 'tick-alive').map((e) => e.n);
const skipped = evs.filter((e) => e.event === 'tick-skip-inflight').length;
rmSync(dir, { recursive: true, force: true });

let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log('  ✓ ' + name);
  else { fail += 1; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

ok('第二拍真的跑起来了（inFlight 复位的判据）', alive.length >= 2, 'tick-alive n=' + alive.join(','));
ok('没有连续被并发闸跳过', skipped <= 1, 'tick-skip-inflight=' + skipped);

console.log(`\n==== ${fail === 0 ? '全绿' : '有红'}：${fail === 0 ? '2 通过 / 0 失败' : fail + ' 失败'} ====\n`);
process.exit(fail === 0 ? 0 : 1);
