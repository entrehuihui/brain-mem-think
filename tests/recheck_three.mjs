/**
 * tests/recheck_three.mjs —— 一键重跑 b / d / e 三组，并排对照。
 *
 * ============== 它凭什么在这儿 ==============
 *
 * kernel-dev 要修 `forge.render` 的 `themeKey`，而那一处改动会**同时影响三个能力**：
 *
 *   e  主题键刷新了，才有「两条并存、谁该让位」
 *   d  `revision` 判自己的反证，靠的是 `themeKey` 整串一致；一改很可能就不翻了
 *   b  「原地不动」可能根本不是落定逻辑的错，而是库里只有一条
 *
 * 单看 e 绿了就收，会漏掉 d 被改坏。所以这三组必须**同一批跑、并排看**。
 * 这个脚本不替代它们各自的判据，只负责把三份结果摆在一张表上，
 * 并额外标出「谁变了」——单跑三次也能看，但要人肉对照，容易看漏。
 *
 * 用法：node tests\recheck_three.mjs
 */

import { createHarness, EXIT } from '../acceptance/_harness.mjs';
import { isMain } from '../acceptance/_run.mjs';

const GROUPS = [
  ['b', 'b_think_more', '会想多（1→3→6，结论真演变）'],
  ['d', 'd_change_mind', '会改自己（自己的证据，不是被纠正）'],
  ['e', 'e_forget_by_new', '会忘（因记了新的而腾，不是容量淘汰）'],
];

/** 上一次跑的基线：用来标出「谁变了」。跑一次有结果之后手动更新。 */
const BASELINE = {
  b: { status: 'UNKNOWN', fails: [] },
  d: { status: 'UNKNOWN', fails: [] },
  e: { status: 'UNKNOWN', fails: [] },
};

async function runOne(modPath) {
  const mod = await import(modPath);
  const { buildMind } = await import('../acceptance/_real_mind.mjs');
  const real = await import('../src/mind.mjs');
  const origLog = console.log;
  console.log = () => {};
  try {
    const h = await mod.runAgainst(async (_s, opts) => buildMind(real, { ...opts, brain: 'thinker' }));
    const v = h.verdict();
    return { status: v.status, fails: v.fails.map((f) => f.id), details: v.fails.map((f) => `${f.id}: ${f.detail}`) };
  } catch (err) {
    return { status: 'THREW', fails: ['threw'], details: [String(err?.message ?? err)] };
  } finally {
    console.log = origLog;
  }
}

async function main() {
  const h = createHarness('recheck · b / d / e 三组并排（themeKey 改动会同时影响三者）', {
    purpose: 'e 绿了不算完——d 可能被改坏，b 可能本来就不是落定的错',
  });
  h.armWatchdog();

  const rows = [];
  for (const [key, file, title] of GROUPS) {
    const r = await runOne(`../acceptance/${file}.mjs`);
    rows.push({ key, title, ...r });
  }

  // 打印并排表（只看信息，不参与裁决）
  h.log('');
  h.log('  ┌────┬────────┬──────────────────────────────────────────');
  for (const r of rows) {
    h.log(`  │ ${r.key}  │ ${r.status.padEnd(6)} │ ${r.title}`);
    for (const d of r.details.slice(0, 4)) h.log(`  │    │        │   ✗ ${d.slice(0, 90)}`);
  }
  h.log('  └────┴────────┴──────────────────────────────────────────');
  h.log('');

  // 每一组都必须跑出结论（不许静默）
  for (const r of rows) {
    h.check(`recheck.${r.key}.ran`, r.status !== 'THREW',
      `${r.key} 必须跑出裁决：${r.status}${r.status === 'THREW' ? ' ' + r.details[0] : ''}`);
  }

  // 与基线对照：谁从绿变红，必须显式报出来（这是防止「修好 e、弄坏 d」）
  const regressions = [];
  for (const r of rows) {
    const base = BASELINE[r.key];
    if (base.status === 'PASS' && r.status !== 'PASS') regressions.push(`${r.key} 由绿转红`);
    const newFails = r.fails.filter((id) => !base.fails.includes(id));
    if (base.fails.length && newFails.length) regressions.push(`${r.key} 新增红：${newFails.join(',')}`);
  }
  h.equal('recheck.no_regression', regressions.length, 0,
    regressions.length ? `回归：${regressions.join('；')}` : '三组都没有回归');

  h.info('recheck.summary', rows.map((r) => `${r.key}=${r.status}`).join('  '));

  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('recheck 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}
