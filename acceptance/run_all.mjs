/**
 * run_all.mjs —— 一次跑完全部验收 + 红队对抗，输出一张总表。
 *
 * ======================= 它凭什么在这儿 =======================
 *
 * 单个脚本能跑，集合跑挂过——主人实况报的就是这个：
 * 60 秒没完、120 秒还在转、没有任何输出。
 * 验收套件的价值在于「随时可跑」，所以这里必须做到三件事：
 *   1. 每个脚本**独立子进程**跑，互不污染（一个挂死不带倒全桌）
 *   2. 每个脚本**独立超时**，超时 = FAIL，不静默挂死
 *   3. 最后**必有一张总表**，退出码只在全绿时为 0
 *
 * 用法：
 *   node acceptance/run_all.mjs
 *   node acceptance/run_all.mjs --timeout=90000
 *   node acceptance/run_all.mjs --only=b,c
 *
 * 判定口径：
 *   PASS(0)  脚本自报全绿
 *   FAIL(1)  脚本自报有红
 *   SKIP(2)  真实现还加载不了（明确标注，不算绿，也不冒充红）
 *   TIMEOUT  超过单脚本时限没退出 → 判 FAIL
 *   CRASH    进程非 0 但连 VERDICT 都没打出来 → 判 FAIL
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const DEFAULT_TIMEOUT = Number(args.timeout ?? 60_000);

// 验收六条 + 红队对抗 + 自检（判据是否真有牙齿）
// ★ 这张表里的每个文件都必须真的存在（_selftest_all 会检查），不许挂空号。
const SUITE = [
  { key: 'a', file: 'acceptance/a_seed_discard.mjs', title: '不存原文（200 条零散经历须≈0 条）' },
  { key: 'b', file: 'acceptance/b_think_more.mjs', title: '会想多（1→3→6 条，结论真演变）' },
  { key: 'c', file: 'acceptance/c_curiosity.mjs', title: '会追问（主动/会落定/不死循环）' },
  { key: 'd', file: 'acceptance/d_change_mind.mjs', title: '会改自己（自己的证据，不是被纠正）' },
  { key: 'e', file: 'acceptance/e_forget_by_new.mjs', title: '会忘（因记了新的而腾，不是容量淘汰）' },
  { key: 'f', file: 'acceptance/f_unknown_wording.mjs', title: '陌生说法（词表盲区：同一件事换 5 种说法）' },
  { key: 'g', file: 'acceptance/g_theme_structural.mjs', title: '结构断言（主题归一不许回潮成关键词表）' },
  // 插件壳：出口唯一 / 六步顺序 / 账本坏状态往"不说"倒 / 归档熔白名单 / 醒≠说
  { key: 'p', file: 'acceptance/p_plugin_shell.mjs', title: '插件壳（唯一出口·六步契约·坏账本往不说倒）' },
  { key: 'q', file: 'acceptance/q_persistence.mjs', title: '落盘（跨重启她还在·原文仍不入库）' },
  { key: 's', file: 'acceptance/r_synth_wiring.mjs', title: '接线（模型真被问到·熔的路真的通）' },
  { key: 't', file: 'acceptance/t_collect_hook.mjs', title: '采集与钩子（系统注入不收·钩子可还原不叠层）' },
  // 裁决七：她的话不是经历（四块各自独立，不许合并看）
  { key: 'h', file: 'acceptance/h_digest_whitelist.mjs', title: '唤醒①·她的话不是经历（归档熔白名单）' },
  { key: 'i', file: 'acceptance/i_single_exit.mjs', title: '唤醒②·只有一条出口（followup 一处、无 steer/send）' },
  { key: 'j', file: 'acceptance/j_wake_stop_loss.mjs', title: '唤醒③·止损阀（账本不动就闭嘴·成对跑）' },
  { key: 'k', file: 'acceptance/k_timeline_gate2.mjs', title: '唤醒④·时序（第二道闸要在首次 assemble 前装好）' },
  { key: 'l', file: 'acceptance/l_ledger_hash.mjs', title: '唤醒⑤·账本指纹（只算想法，不算时间与次数）' },
  { key: 'm', file: 'acceptance/m_loop_closed.mjs', title: '唤醒⑥·环闭合（端到端：她说话不让库变大）' },
  // ★ 2026-10-30 加：主人问「为什么只会说、没有去做」查出的病根——
  //   被闸挡回来的那趟也记 found:true，于是「越没去成，劲越大」。
  { key: 's2', file: 'acceptance/s_settle_honest.mjs', title: '结算诚实（没去成不许记成做到了）' },
  // ★ 2026-10-30 加：主人「要让主动性真落地」——被挡回来的事要能补做，
  //   但不能烂在手里（要过期、要放手）。
  { key: 'u', file: 'acceptance/t_debt_retry.mjs', title: '主动欠账（挡下来的能补做·到期会放手）' },
  // ★ 2026-10-30 加：主人问「meow-memory 会不会影响我这个插件」——
  //   别的插件塞进来的字（plugin:*、runtime-context…）一条都不许进熔炉。
  { key: 'v', file: 'acceptance/v_plugin_inject.mjs', title: '插件注入隔离（别家的字不许进熔炉）' },
  { key: 'r1', file: 'acceptance/redteam/r1_paraphrase_alive.mjs', title: '对抗·换皮冒充会想多' },
  { key: 'r2', file: 'acceptance/redteam/r2_correction_driven.mjs', title: '对抗·被纠正冒充会改自己' },
  { key: 'r3', file: 'acceptance/redteam/r3_curiosity_loop.mjs', title: '对抗·死循环冒充会追问' },
  { key: 'r4', file: 'acceptance/redteam/r4_capacity_eviction.mjs', title: '对抗·容量淘汰冒充会忘' },
  { key: 'r5', file: 'acceptance/redteam/r5_summary_laundering.mjs', title: '对抗·摘要/截断/改写冒充不存原文' },
  { key: 'r6', file: 'acceptance/redteam/r6_phantom_mind.mjs', title: '对抗·幽灵实现（什么都不做也全绿？）' },
  { key: 'r7', file: 'acceptance/redteam/r7_ungrounded_fabrication.mjs', title: '对抗·胡编（grounding 放松后仍要咬住）' },
  { key: 'r8', file: 'acceptance/redteam/r8_self_contradiction.mjs', title: '对抗·自相矛盾的回执不许静默吞掉' },
  { key: 'rt', file: 'acceptance/redteam/run_redteam.mjs', title: '对抗·总控（六条假绿都有人打吗）' },
  { key: 'selftest', file: 'acceptance/_selftest_all.mjs', title: '元验收（判据有牙齿吗）' },
];

function runOne(item, timeoutMs) {
  return new Promise((resolveP) => {
    const started = Date.now();
    const abs = resolve(ROOT, item.file);
    const child = spawn(process.execPath, [abs], {
      cwd: ROOT,
      env: { ...process.env, ACCEPT_BUDGET_MS: String(Math.max(1000, timeoutMs - 2000)) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let done = false;
    const finish = (status, extra = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const ms = Date.now() - started;
      resolveP({ ...item, status, ms, out, err, extra });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
      finish('TIMEOUT', `>${timeoutMs}ms 未结束`);
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => finish('CRASH', `spawn 失败：${e.message}`));
    child.on('close', (code, signal) => {
      if (code === 0) return finish('PASS');
      if (code === 2) return finish('SKIP');
      if (!/VERDICT:/.test(out)) {
        // ★ 没打出裁决 = 脚本自己崩了（脚手架问题），不是判据报红（实现问题）。
        //   这两类必须分开报，否则总表只会说「红」，没人知道该派谁去改。
        const firstErr = (err || out).split(/\r?\n/).find((l) => /Error|error:|Cannot|不是|TypeError|SyntaxError/.test(l)) || (err || out).split(/\r?\n/)[0] || '';
        return finish('CRASH', `脚本没打出 VERDICT（exit=${code}${signal ? ' signal=' + signal : ''}）：${firstErr.trim().slice(0, 140)}`);
      }
      return finish('FAIL', `exit=${code}`);
    });
  });
}

/** 从脚本输出里抠出「红在哪」，总表只给摘要，细节在单独跑时看。 */
function redList(out) {
  const lines = out.split(/\r?\n/);
  const start = lines.findIndex((l) => /VERDICT: FAIL/.test(l));
  if (start < 0) return '';
  const tail = lines.slice(start, start + 40).filter((l) => /✗/.test(l));
  return tail.map((l) => l.replace(/✗\s*/, '').trim()).slice(0, 6).join('；');
}

async function main() {
  const only = args.only ? String(args.only).split(',') : null;
  const list = only ? SUITE.filter((s) => only.includes(s.key)) : SUITE;
  const timeout = DEFAULT_TIMEOUT;

  // ★ 先查表：每个脚本文件必须真实存在。不许挂空号——
  //   空号会伪装成「脚本红了」，让人以为实现有问题，实际是表写错了。
  const missing = list.filter((s) => !existsSync(resolve(ROOT, s.file)));
  if (missing.length) {
    console.log('');
    console.log('══ 红队验收总表 ══════════════════════════════════════════════════');
    console.log('   VERDICT: FAIL（脚手架问题：总表里登记了不存在的脚本）');
    for (const m of missing) console.log(`     · ${m.key}  ${m.file}  ← 文件不存在`);
    console.log('═════════════════════════════════════════════════════════════════');
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('══ 红队验收总表 ══════════════════════════════════════════════════');
  console.log(`   项目：${ROOT}`);
  console.log(`   单脚本超时：${timeout}ms   脚本数：${list.length}`);
  console.log('─────────────────────────────────────────────────────────────────');

  const results = [];
  for (const item of list) {
    process.stdout.write(`   ▶ ${item.key.padEnd(9)} ${item.title} … `);
    const r = await runOne(item, timeout);
    results.push(r);
    const tag = { PASS: 'PASS', FAIL: 'FAIL', SKIP: 'SKIP', TIMEOUT: 'FAIL', CRASH: 'FAIL' }[r.status] ?? 'FAIL';
    console.log(`${tag}  ${(r.ms / 1000).toFixed(1)}s${r.extra ? '  (' + r.extra + ')' : ''}`);
    if (r.status !== 'PASS') {
      const red = redList(r.out);
      if (red) console.log(`            ↳ ${red}`);
      if (r.status === 'SKIP') console.log(`            ↳ 真实现尚未就绪（${(r.out.match(/SKIP[^\n]*/) || [''])[0].slice(0, 120)}）`);
    }
  }

  const green = results.filter((r) => r.status === 'PASS').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  const red = results.length - green - skipped;
  const totalMs = results.reduce((s, r) => s + r.ms, 0);

  console.log('─────────────────────────────────────────────────────────────────');
  console.log('   脚本名'.padEnd(34) + '判定   耗时     备注');
  for (const r of results) {
    const tag = r.status === 'PASS' ? '绿' : r.status === 'SKIP' ? '跳过' : r.status === 'CRASH' ? '崩' : '红';
    console.log('   ' + `${r.key}`.padEnd(30) + tag.padEnd(6) + `${(r.ms / 1000).toFixed(1)}s`.padEnd(10) + (r.extra || ''));
  }
  console.log('─────────────────────────────────────────────────────────────────');

  // ★ 把「红」分成两类，这是总表最有价值的部分：
  //   崩/TIMEOUT = 脚手架问题（派给我）；有 VERDICT 的红 = 实现问题（派给 kernel-dev）。
  const scaffold = results.filter((r) => r.status === 'CRASH' || r.status === 'TIMEOUT');
  const implRed = results.filter((r) => r.status === 'FAIL');
  if (scaffold.length) {
    console.log('   ── 脚手架问题（该我修，不是实现错）──');
    for (const r of scaffold) console.log(`     · ${r.key}  ${r.extra || r.status}`);
  }
  if (implRed.length) {
    console.log('   ── 实现问题（判据跑到了，报的是真红）──');
    for (const r of implRed) console.log(`     · ${r.key}  ${redList(r.out) || '（无摘要，单跑看细节）'}`);
  }
  console.log('─────────────────────────────────────────────────────────────────');
  console.log(`   绿 ${green} / 红 ${red} / 跳过 ${skipped}    总耗时 ${(totalMs / 1000).toFixed(1)}s`);
  const verdict = red === 0 && skipped === 0;
  console.log(verdict ? '   VERDICT: PASS（全绿）' : `   VERDICT: FAIL（红 ${red}，跳过 ${skipped}；跳过不算过）`);
  console.log(`   相对根目录：${relative(process.cwd(), ROOT) || '.'}`);
  console.log('═════════════════════════════════════════════════════════════════');
  console.log('');

  // 唯一的 0 出口：全绿。跳过（真实现没就绪）也不算绿。
  process.exitCode = verdict ? 0 : 1;
}

main().catch((e) => {
  console.error('run_all 崩了：', e);
  process.exitCode = 1;
});
