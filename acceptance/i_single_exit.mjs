/**
 * i_single_exit.mjs —— 验收②：只有一条出口（`followup(` 全插件只许出现一次）
 *
 * ============== 它凭什么在这儿 ==============
 *
 * 裁决七：旧插件「60 秒说 6 条」的根因是**旁路**——
 * 有两条出口，一条走去重、一条不走，于是限制形同虚设。
 *
 * 这条验收是**静态扫描**，跟 g_theme_structural 同一类：测的不是功能，是禁令。
 * 用途是让它进 CI——以后谁想"顺手再加一条出口"，在测试里就过不去。
 *
 * ============== 判据 ==============
 *
 * I1  全插件 `followup(` 的**调用点**恰好 1 处
 * I2  这一处必须在**同一个文件**里（不能一个文件里调、另一个文件里也调）
 * I3  定义处不算：`function followup(`、`followup = (`、`.followup =` 这类不算调用
 * I4  注释里提到的不算（只扫代码行）
 * I5  白名单：本文件自己提到它不算（这条测试必须能说出 "followup(" 这个词）
 *
 * 扫描面：插件目录下所有 js/mjs/ts 文件（默认 src/ + plugins 一类），
 * 可用环境变量 MIND_SCAN_DIRS 指定（逗号分隔）。
 */

import { createHarness, EXIT } from './_harness.mjs';
import { isMain } from './_run.mjs';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const DEFAULT_DIRS = ['src'];

function listSources(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue;
      out.push(...listSources(p));
    } else if (/\.(mjs|js|cjs|ts)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** 去掉注释，留下可能真的是代码的行。 */
function codeLines(text) {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock
    .split(/\r?\n/)
    .map((l, i) => ({ i: i + 1, s: l.replace(/\/\/.*$/, '') }))
    .filter((x) => x.s.trim());
}

/** 这是不是一次**调用**（而不是定义、赋值、属性声明）。 */
function isCallLine(s) {
  if (/function\s+followup\s*\(/.test(s)) return false;      // 定义
  if (/followup\s*=\s*\(/.test(s)) return false;             // 赋值
  if (/(\.|\b)followup\s*:\s*\(?function/.test(s)) return false; // 对象方法定义
  if (/(\.|\b)followup\s*:\s*\(/.test(s)) return false;      // 对象方法简写
  return /(^|[^.\w])followup\s*\(/.test(s) || /\.followup\s*\(/.test(s);
}

export async function runAgainst() {
  const h = createHarness('i_single_exit · 只有一条出口（followup 只许一处调用）', {
    capability: '防旁路：旧插件 60 秒 6 条的根因就是两条出口（裁决七 §五.1）',
    purpose: '静态扫描，进 CI —— 谁想顺手加第二条出口，在测试里就过不去',
  });
  h.armWatchdog();

  const dirs = (process.env.MIND_SCAN_DIRS || DEFAULT_DIRS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const files = dirs.flatMap((d) => listSources(resolve(ROOT, d)));
  h.atLeast('I0.scanned_files', files.length, 1,
    `扫描目录：${dirs.join(',')}，共 ${files.length} 个文件`);

  const calls = [];
  const defs = [];
  for (const f of files) {
    const rel = relative(ROOT, f);
    const text = readFileSync(f, 'utf8');
    for (const { i, s } of codeLines(text)) {
      if (!/followup/.test(s)) continue;
      if (isCallLine(s)) calls.push({ file: rel, line: i, code: s.trim().slice(0, 100) });
      else if (/function\s+followup|followup\s*=/.test(s)) defs.push({ file: rel, line: i, code: s.trim().slice(0, 100) });
    }
  }

  h.equal('I1.only_one_call', calls.length, 1,
    `全插件 \`followup(\` 的调用点必须恰好 1 处，实测 ${calls.length} 处：${calls.slice(0, 5).map((c) => `${c.file}:${c.line}`).join('，') || '无'}`);

  // ---- 旁路：steer / send 一处都不许有 ----
  // 裁决七：两条出口，一条走去重一条不走，限制就形同虚设。
  // steer/send 是"另一条出口"最典型的两个名字，必须为 0。
  const bypass = [];
  for (const f of files) {
    const rel = relative(ROOT, f);
    const text = readFileSync(f, 'utf8');
    for (const { i, s } of codeLines(text)) {
      if (/\.(steer|send)\s*\(/.test(s)) bypass.push({ file: rel, line: i, code: s.trim().slice(0, 100) });
    }
  }
  h.equal('I1b.no_bypass_exit', bypass.length, 0,
    `\`.steer(\` / \`.send(\` 必须 0 处（那是第二条出口）：实测 ${bypass.length} 处 ${bypass.slice(0, 4).map((b) => `${b.file}:${b.line}`).join('，') || ''}`);

  if (calls.length > 0) {
    const fileSet = new Set(calls.map((c) => c.file));
    h.equal('I2.single_file', fileSet.size, Math.min(1, fileSet.size),
      `调用点只许集中在同一个文件里：实测分布在 ${[...fileSet].join('，')}`);
    h.info('I2b.call_site', calls.map((c) => `${c.file}:${c.line}  ${c.code}`).join(' ／ '));
  }
  h.info('I3.definitions', defs.length ? defs.map((d) => `${d.file}:${d.line}`).join('，') : '（无定义，可能直接调 import 进来的）');

  // 定义处/注释里提到的不算调用：这条自证一下扫描器分得清
  const probe = {
    def: 'export function followup(text) { return text; }',
    assign: 'const followup = (t) => t;',
    call: 'await followup("hi");',
    comment: '// 这里提到 followup() 只是注释',
  };
  h.check('I4.scanner_distinguishes', !isCallLine(probe.def) && !isCallLine(probe.assign) && isCallLine(probe.call),
    `扫描器要能分清「定义/赋值」和「调用」：def=${isCallLine(probe.def)} assign=${isCallLine(probe.assign)} call=${isCallLine(probe.call)}`);

  // ---- 动态检查：agent 在跑的时候，一次都不许开口 ----
  //
  // 裁决七 §五.2：`followup` 前先看 `agent.status`，`running` 就这轮跳过，**不排队**。
  // 排队就是"等她忙完一口气说好几句"，那正是旧插件 60 秒 6 条的形状。
  // 静态扫描只能证明"出口只有一个"，证明不了"这个出口在忙的时候真的不开口"——
  // 所以必须动态跑：把 agent 伪造成 running，触发 50 次唤醒，数 followup 次数。
  let dyn = null;
  try {
    const wakeMod = await import('../src/wake.mjs');
    const mk = wakeMod.createWake ?? (() => wakeMod);
    const w = typeof mk === 'function' ? mk({ minGapMs: 0, maxGapMs: 0, quietAfterSpeakMs: 0 }) : wakeMod;
    const calls2 = [];
    const agent = {
      status: 'running',
      followup: (text) => { calls2.push(text); return Promise.resolve(); },
    };
    // 造一批"账本在动"的判断，逼它想说
    let notes = [];
    for (let i = 0; i < 50; i += 1) {
      notes.push({ id: `n${i}`, status: 'held', weight: 0.9, themeKey: `is|他`, relation: 'is', polarity: 1, from: 3, why: '有理由。', turns: [{}] });
      const fn = w.wake ?? wakeMod.wake;
      const r = await fn(notes, { agent, at: i * 1_000_000, opts: { minGapMs: 0, maxGapMs: 0, quietAfterSpeakMs: 0 } });
      if (r?.speak && r?.text && typeof agent.followup === 'function') agent.followup(r.text);
    }
    dyn = { calls: calls2.length };
  } catch (err) {
    dyn = { error: String(err?.message ?? err) };
  }
  h.check('I5.running_agent_not_interrupted', !!dyn && !dyn.error && dyn.calls === 0,
    dyn?.error
      ? `动态检查没跑起来：${dyn.error}`
      : `agent 在跑的时候触发 50 次唤醒，followup 必须 0 次：实测 ${dyn.calls} 次（排队=等她忙完一口气说好几句）`);

  return h;
}

async function main() {
  const h = await runAgainst();
  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('i 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}

export { isCallLine };
