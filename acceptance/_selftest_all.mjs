/**
 * _selftest_all.mjs —— 把「已知坏的实现」喂给每条验收，确认它们都会红。
 *
 * ======================= 它凭什么在这儿 =======================
 *
 * 红队脚本有一个特别恶心的失败模式：**对着任何实现都绿**。
 * 可能是字段名读错了（取到空数组，全 0 通过），可能是阈值写松了，
 * 可能是断言落在一个恒真的条件上。这种脚本比没有还坏，
 * 因为它会给人「已经验过」的错觉。
 *
 * 所以：同一个 runAgainst(factory) 函数，除了喂真实现，还喂假实现。
 *   - 跟 thinker 脑配对的「正常内核」→ 必须绿（证明脚本不是见谁咬谁）
 *   - 每个假绿档位的假内核 → 必须红（证明判据有牙齿）
 * 任何一格不符，本脚本红。
 */

import { createHarness, EXIT } from './_harness.mjs';
import { isMain } from './_run.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// 每条验收的 import
const mods = {
  a: () => import('./a_seed_discard.mjs'),
  b: () => import('./b_think_more.mjs'),
  c: () => import('./c_curiosity.mjs'),
  d: () => import('./d_change_mind.mjs'),
  e: () => import('./e_forget_by_new.mjs'),
};

/**
 * 静默跑一个验收，但**崩溃必须与红分开**。
 *
 * ★ 这是 2026-10-27 主人点名要修的：
 *   原来这里 `try { ... } finally { 恢复 console }`，异常会直接抛到 main 里，
 *   而 main 那边把它包成 `{ ok:false, fails:[{id:'threw'}] }`——
 *   于是「脚本崩了」和「判据红了」长成一个样子。
 *
 *   后果今晚实际发生了：`_fake_synth.mjs` 少了一个函数定义，
 *   任何 fakeSynth() 都抛 ReferenceError，而 selftest 报出来是
 *   「b.good / c.good / e.good 三档红」。**看着像判据在冤枉实现，
 *   其实是它压根没跑起来。**
 *
 *   一个吞异常的验收框架，比没有验收更危险——它会报出一堆看起来很严肃的红。
 *
 * 现在三档分明：
 *   PASS   判据跑了，通过
 *   FAIL   判据跑了，没过
 *   CRASH  判据压根没跑起来（异常）← 独立一档，异常原文一并带出
 */
async function quiet(run) {
  const origLog = console.log;
  // 静默只静「正常打印」；错误照样走 stderr，不吞。
  console.log = () => {};
  try {
    const h = await run();
    const v = h.verdict();
    return {
      status: v.status === 'PASS' ? 'PASS' : 'FAIL',
      fails: v.fails.map((f) => ({ id: f.id, detail: f.detail })),
      ok: v.status === 'PASS',
    };
  } catch (err) {
    // 异常 = 崩塌，不是红。把异常原文带出来，让人一眼看出是"没跑"。
    return {
      status: 'CRASH',
      fails: [{ id: 'threw', detail: `${err?.constructor?.name ?? 'Error'}: ${err?.message ?? err}` }],
      ok: false,
      crash: `${err?.constructor?.name ?? 'Error'}: ${err?.message ?? err}`,
      stack: String(err?.stack ?? '').split('\n').slice(0, 4).join(' ← '),
    };
  } finally {
    console.log = origLog;
  }
}

/**
 * 在一个**独立子进程**里跑单个用例。
 *
 * 为什么不用 quiet() 就地跑：主人裁决要的是**进程隔离**，不是「各自新建 mind」。
 * 今晚三次串状态都证明了一件事——**共享状态会以你没想到的方式串账**，
 * 而进程隔离是唯一不靠纪律的隔离。
 */
function runInSubprocess(key, impl, timeoutMs = 40_000) {
  return new Promise((resolveP) => {
    const here = dirname(fileURLToPath(import.meta.url));
    const child = spawn(process.execPath, [resolve(here, '_selftest_one.mjs'), key, impl], {
      cwd: resolve(here, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolveP(r); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退 */ }
      done({ status: 'CRASH', fails: [], crash: `子进程超过 ${timeoutMs}ms 没结束` });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => done({ status: 'CRASH', fails: [], crash: 'spawn 失败：' + e.message }));
    child.on('close', (code) => {
      const m = out.match(/@@RESULT@@(.*)/);
      if (!m) {
        const first = (err || out).split(/\r?\n/).find((l) => /Error|error:/.test(l)) || '';
        return done({ status: 'CRASH', fails: [], crash: `子进程没吐出结果（exit=${code}）：${first.trim().slice(0, 120)}` });
      }
      try {
        done(JSON.parse(m[1]));
      } catch {
        done({ status: 'CRASH', fails: [], crash: '子进程结果解析失败' });
      }
    });
  });
}

async function main() {
  const h = createHarness('selftest · 判据有牙齿吗（坏实现必须红、好实现必须绿）', {
    capability: '元验收：这套验收脚本本身不许是假绿',
    purpose: '同一套判据喂假实现，必须报红；喂正常实现，必须不误伤',
  });
  h.armWatchdog();

  const table = [
    // [验收, 假实现标签, 期望]
    ['a', 'bad.storage', '必须红'],
    ['a', 'good', '必须绿'],
    ['b', 'bad.paraphraser', '必须红'],
    ['b', 'good', '必须绿'],
    ['c', 'bad.repeater', '必须红'],
    ['c', 'good', '必须绿'],
    ['d', 'bad.correction', '必须红'],
    ['d', 'good', '必须绿'],
    ['e', 'bad.capacity', '必须红'],
    ['e', 'good', '必须绿'],
  ];

  for (const [key, impl, expect] of table) {
    // ★ 每个用例一个独立子进程（裁决：进程隔离是唯一不靠纪律的隔离）
    const res = await runInSubprocess(key, impl);

    const shouldBeGreen = expect === '必须绿';
    // 三档：崩溃单独一档，且永远判红（并写明"没跑"），不许混成"判据红"。
    if (res.status === 'CRASH') {
      h.check(`selftest.${key}.${impl}`, false,
        `崩溃（判据压根没跑起来，不是判据红）：${res.crash}${res.stack ? ' ｜ ' + res.stack : ''}`);
      continue;
    }
    const ok = res.status === 'PASS';
    const pass = shouldBeGreen ? ok : !ok;
    h.check(
      `selftest.${key}.${impl}`,
      pass,
      `${expect}，实际=${ok ? '绿' : '红'}${ok ? '' : ' 红在:' + res.fails.slice(0, 6).map((f) => f.id).join(',')}`,
    );
  }

  // 汇总：有几档是"崩溃"（没跑）——单独报，别混进"红几条"里
  const crashed = h.raw().filter((c) => /崩溃（/.test(String(c.detail ?? '')));
  if (crashed.length) {
    h.info('crashed_count', `${crashed.length} 档崩溃（没跑起来）——这不算判据不许，是脚手架问题`);
  }

  h.exit();
  h.forceExit();
}

/** 假实现工厂表：每个都是「看起来像那么回事、其实没做到」的实现。 */
export function implFactory(label) {
  return async (synth, opts) => {
    const { makeFakeKernel } = await import('./_fake_kernels.mjs');
    return makeFakeKernel(label, synth, opts);
  };
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error('selftest 崩溃：', err);
    process.exitCode = EXIT.FAIL;
  });
}
