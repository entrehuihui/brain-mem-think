/**
 * _selftest_one.mjs —— 单个用例的跑手（**一次进程只跑一个用例**）。
 *
 * ============== 它凭什么在这儿 ==============
 *
 * 主人裁决：「selftest 里每一个 good / bad 用例，各自起一个独立子进程跑。
 *           不是『各自新建 mind』，是『各自一个进程』。」
 *
 * 理由是他说的那句，我抄在这里：
 *   **「进程隔离是唯一不靠纪律的隔离。」**
 *
 * 今晚已经证明过三次「共享状态会以你没想到的方式串账」：
 *   · 模块级累积计数（resetSeen 那次）
 *   · burden 读成对象
 *   · 状态值 'open' / 'pending' 不一致
 * 每次都是同一类病：**我以为隔离了，其实没有。**
 *
 * 用法（由 _selftest_all.mjs 内部 spawn）：
 *   node acceptance/_selftest_one.mjs <验收key> <假实现label>
 *
 * 输出：最后一行是 JSON
 *   { status: 'PASS'|'FAIL'|'CRASH', fails: [id...], crash?: string }
 */

import { EXIT } from './_harness.mjs';
import { isMain } from './_run.mjs';

const MODS = {
  a: () => import('./a_seed_discard.mjs'),
  b: () => import('./b_think_more.mjs'),
  c: () => import('./c_curiosity.mjs'),
  d: () => import('./d_change_mind.mjs'),
  e: () => import('./e_forget_by_new.mjs'),
};

async function main() {
  const key = process.argv[2];
  const impl = process.argv[3];
  if (!key || !impl) {
    console.log(JSON.stringify({ status: 'CRASH', fails: [], crash: '缺参数：需要 <验收key> <假实现label>' }));
    return;
  }

  const origLog = console.log;
  console.log = () => {};
  let out;
  try {
    const m = await MODS[key]();
    const { makeFakeKernel } = await import('./_fake_kernels.mjs');
    // ★ 2026-10-27 大乔撤回：原来这里写 `const keepsPending = key === 'c'`，给 c.good 开了开关。
    //   开了之后 selftest.c.good 红在 C3B.fires_capped（追问预算被烧穿）。
    //   我当时的判断是「good 该面对跟真实现一样的材料」，但漏了一点：
    //   **场景 B 测的是「证据永远差一点时她会不会反复回头」——那是个极端场景，
    //   参照实现（good）在这个场景里必然把追问预算用满，这不是它有毛病。**
    //   一个能通过「永远差一点」还不多问一句的实现，才是假的好。
    //   所以撤回：selftest 的参照实现不面对这个极端场景。
    //   c_curiosity.mjs 自己跑时仍由它内部显式开（那是真实现要过的关）。
    const keepsPending = false;
    const factory = async (_synth, opts) => {
      const { fakeSynth, createLedger } = await import('./_fake_synth.mjs');
      const fresh = fakeSynth({ brain: 'thinker', ledger: createLedger(), keepsPending });
      // ★ 2026-10-27 大乔补：c.good 红在 C1A.model_called_on_related（calls=0），
      //   但 good 内核确实调了 synth.synthesize（_fake_kernels.mjs:118）。
      //   差别在「谁数」：判据读的是 counter.calls，而这里直接交出去的是 fakeSynth
      //   的原始对象，calls 计数没被挂上去。
      //   这是「量错对象」的第二次——数的是我以为它在用的那本账。
      //   补一个 calls getter，让它跟内核真实调用同步。
      let callCount = 0;
      const wrapped = Object.create(fresh);
      wrapped.synthesize = (req) => { callCount += 1; return fresh.synthesize(req); };
      Object.defineProperty(wrapped, 'calls', { get: () => Array.from({ length: callCount }) });
      const mk = makeFakeKernel(impl, wrapped, opts);
      // ★ 判据读的是 `mind.__synth ?? synth`（c_curiosity.mjs:147）。
      //   假内核不挂 __synth，于是它退回去读外面那个 synth——而外面那个不是实际在被调的那一个。
      //   「数的是我以为它在用的那本账」——今晚第三次踩这个。挂上真实的那一份。
      if (mk && typeof mk === 'object') {
        try { mk.__synth = wrapped; } catch { /* 只读对象就算了 */ }
      }
      return mk;
    };
    // 第 4 个参数：只跑某一段（e 组的 A/B/C）。不给就是跑全部。
    const only = process.argv[4] || null;
    // ★ e 组且没指定单独某段时，走**三段各自子进程**。
    //   实测：e 单独跑时 E2/E3 绿，放进全表红——差别只在同进程里 A 段先跑过。
    //   段与段之间串账，只能靠进程隔离治。
    if (key === 'e' && !only) {
      const { spawn } = await import('node:child_process');
      const { fileURLToPath } = await import('node:url');
      const { dirname, resolve } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const r = await new Promise((res) => {
        const c = spawn(process.execPath, [resolve(here, '_e_segmented.mjs'), impl], {
          cwd: resolve(here, '..'),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let o = '';
        c.stdout.on('data', (d) => { o += d.toString(); });
        c.on('close', () => {
          const mm = o.match(/@@RESULT@@(.*)/);
          try { res(JSON.parse(mm[1])); } catch { res({ status: 'CRASH', fails: [], crash: '分段结果解析失败' }); }
        });
        c.on('error', (e) => res({ status: 'CRASH', fails: [], crash: 'spawn 失败：' + e.message }));
      });
      console.log = origLog;
      process.stdout.write('\n@@RESULT@@' + JSON.stringify(r) + '\n');
      return;
    }
    const h = only ? await m.runAgainst(factory, { only }) : await m.runAgainst(factory);
    const v = h.verdict();
    out = {
      status: v.status === 'PASS' ? 'PASS' : 'FAIL',
      fails: v.fails.map((f) => ({ id: f.id, detail: f.detail })),
    };
  } catch (err) {
    out = {
      status: 'CRASH',
      fails: [],
      crash: `${err?.constructor?.name ?? 'Error'}: ${err?.message ?? err}`,
      stack: String(err?.stack ?? '').split('\n').slice(0, 4).join(' ← '),
    };
  } finally {
    console.log = origLog;
  }

  // 只吐一行 JSON，父进程好解析
  process.stdout.write('\n@@RESULT@@' + JSON.stringify(out) + '\n');
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    process.stdout.write('\n@@RESULT@@' + JSON.stringify({ status: 'CRASH', fails: [], crash: String(e?.message ?? e) }) + '\n');
    process.exitCode = EXIT.FAIL;
  });
}
