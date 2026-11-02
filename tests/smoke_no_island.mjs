/**
 * smoke_no_island.mjs —— 孤岛守卫：`src/` 里每一个模块，都必须在 plugin 层有着落。
 *
 * ======================= 它为什么必须存在 =======================
 *
 * 2026-11-02 实测发现两处（`src/lookup.mjs` / `src/saw.mjs`）：
 *
 *   166 行代码、34 条判据、负控制也验过、文档里写得漂漂亮亮——
 *   然后 `grep -rn "lookup" plugin/` **一个都中不了**。
 *
 *   `src/` 是纯脑子，不认宿主；**能不能被这个脑子用上，全看 plugin 层有没有人叫它。**
 *   判据全绿只能证明「它自己那部分是对的」，证明不了「它活着」。
 *
 * 这跟 README 第 30 条踩坑是同一类病：
 *
 *   代码写着、接口对不上、而且不报错。
 *
 * ======================= 这条判据到底在量什么 =======================
 *
 * 不是量「有没有人 import 它」——那是字面，能凑。量的是三件事：
 *
 *   ① **有人叫它**：`plugin/` 里至少有一处**真的调用**了它的导出名
 *      （动态 import 的 `.then` / `await import` 也要算，但只算它后面真的用了）。
 *   ② **不是只在测试里活**：`tests/` 和 `acceptance/` 里的引用**不算数**——
 *      那边测的是纯函数，测不到它有没有被世界用上。这条判据只认 `plugin/`。
 *   ③ **有例外就得写理由**：确实有「纯内核、由别的模块内部消费」的，
 *      必须在下面的 `INTERNAL_ONLY` 里**手写为什么**。
 *      不加理由的例外 = 凑绿，判据直接红。
 *
 * ======================= 负控制 =======================
 *
 * 判据要能证明它有牙齿。`--selftest` 会喂两份假源码：
 *   · 只被测试引用的模块 → 必须红
 *   · 完全没人叫的模块   → 必须红
 *   · 例外表里、理由充足的 → 必须绿
 * 三条都不对，说明这把刀是钝的，本脚本本身判红。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

/**
 * 例外表：**每一条都必须写为什么**。
 *
 * 允许的两类：
 *   a) 纯数据/纯工具，被同一个 `src/` 里的别人 import 也算「有着落」——
 *      但它们已经在内核内部被消费，plugin 层不需要直接叫它。
 *   b) 阶段性的内核零件，出口唯一（比如只经由 `mind.mjs` 门面）。
 *
 * ★ 不放任何「我还没接上」的东西进来。没接上就是没接上，判据该红就红。
 */
const INTERNAL_ONLY = Object.freeze({
  // 这些是内核内部的零件：`mind.mjs` 是唯一出口，plugin 只跟门面打交道。
  // 判据承认它们：`src/` 里有人真的消费（不是只定义），并且它们不出 IO。
  'event.mjs': '纯数据结构，只被 observe/induct 在 src/ 内部消费',
  'judge.mjs': '判断本身的定义，经 flash/mind 门面出口；plugin 不直接构造判断',
  'budget.mjs': '五道闸，经 mind.mjs / index.mjs 内部路径消费',
  'fade.mjs': '淘汰策略，经 mind.mjs 门面调用',
  'induct.mjs': '内核归纳，经 mind.reconcileInduction() 门面出口',
  'associate.mjs': '联想，经 mind.mjs 门面出口',
  'curiosity.mjs': '追问，经 mind.mjs 门面出口',
  'revision.mjs': '改自己，经 mind.mjs 门面出口',
  'digest-session.mjs': '整段会话熔断，经 plugin/index.mjs 的归档路径消费',
  'preference.mjs': '偏好记账，经 settle 路径在 src 内部消费',
  'strength.mjs': '底气，经 flash/world 在 src 内部消费',
  'sting.mjs': '扎心度，经 world/doubt 在 src 内部消费',
  'recall.mjs': '情境检索，经 world.mjs 出口',
  'flash.mjs': '记忆库门面，被 world/mind 消费',
  'forge.mjs': '火炉，被 digest-session/lookup 消费',
  'persist.mjs': '落盘，被 plugin 经 mind 间接消费',
  'world.mjs': '世界渲染，经 mind.world() 门面出口',
  // ★ 以下两条是 2026-11-02 加孤岛守卫时**判据自己抓出来的**（不是我想到的）：
  //   它们确实是「src 内部消费、plugin 层不该直接叫」的那一类，
  //   判据把它们报出来，我逐个核过源头才写进来——不是为了让判据变绿而添的。
  'doubt.mjs': '「我拿不准的事」经 mind.world({reconcile}) 拼进世界，唯一的读口是 world.mjs',
  'episode.mjs': '经历层由 mind.episodes 持有、经 world({episodes}) 渲染，plugin 不直接构造经历',
});

/** 扫一个目录下所有 .mjs，返回 { 文件名: 源码 } */
function sourcesIn(dir) {
  const out = {};
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.mjs')) continue;
    try { out[n] = readFileSync(join(dir, n), 'utf8'); } catch { /* 读不了就跳过 */ }
  }
  return out;
}

/** 把一个模块源码里的「导出名」抽出来。 */
export function exportNames(code) {
  const names = new Set();
  const re = /export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(code))) names.add(m[1]);
  // export { a, b as c }
  const re2 = /export\s*\{([^}]*)\}/g;
  while ((m = re2.exec(code))) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (t) names.add(t);
    }
  }
  return [...names];
}

/**
 * 一个导出名有没有在给定源码里被**真的用**。
 *
 * 「真的用」= 出现在 import 之后、或者 import 了模块名再用它的成员。
 * 判据刻意宽松一点（宁可放过，不冤枉好实现），但**测试目录根本不参与统计**。
 */
export function usedIn(target, code) {
  const t = String(target ?? '');
  if (!t) return false;
  // ① 具名 import：import { scan } from '.../lookup.mjs'
  if (new RegExp(`\\b${t}\\b`).test(code)) {
    // 排除「只出现在注释里」这种假命中：去掉行注释与块注释再说一次
    const stripped = code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    if (new RegExp(`\\b${t}\\b`).test(stripped)) return true;
  }
  return false;
}

/**
 * 核心检查：给定 { src: {...}, pluginCode: string } → 返回违规清单。
 * 纯函数，可被 `--selftest` 喂假数据。
 */
export function islandsOf({ src, pluginCode, allow = INTERNAL_ONLY }) {
  const bad = [];
  const plugin = String(pluginCode ?? '');
  for (const [file, code] of Object.entries(src)) {
    const exports = exportNames(code);
    if (!exports.length) continue;
    const isUsed = exports.some((n) => usedIn(n, plugin));
    if (isUsed) continue;
    const reason = allow?.[file];
    if (typeof reason === 'string' && reason.trim()) {
      // 例外可以过，但**例外自己得站得住**：它的导出名至少要在 src/ 内部被别人用上，
      // 否则「内部消费」这个理由就是假的。
      const others = Object.entries(src).filter(([k]) => k !== file).map(([, c]) => c).join('\n');
      if (exports.some((n) => usedIn(n, others))) continue;
      bad.push({ file, why: `例外理由说「内核内部消费」，可 src/ 里也没人叫它（${exports.join(', ')}）` });
      continue;
    }
    bad.push({ file, why: `plugin/ 里没有任何一处调用它的导出（${exports.join(', ')}）` });
  }
  return bad;
}

// ── 主流程 ─────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

const SRC = sourcesIn(join(ROOT, 'src'));
const PLUGIN = Object.values(sourcesIn(join(ROOT, 'plugin'))).join('\n');

console.log('[孤岛守卫] src/ 里每个模块都得在 plugin 层有着落');

// ── ① 真仓库上跑一遍 ─────────────────────────────────────────
{
  const bad = islandsOf({ src: SRC, pluginCode: PLUGIN });
  ok(
    '没有孤岛模块',
    bad.length === 0,
    bad.map((b) => `${b.file}: ${b.why}`).join(' | '),
  );
  ok('两条曾经的孤岛已被接上（lookup）', usedIn('lookup', PLUGIN) || usedIn('maybeLookup', PLUGIN));
  ok('两条曾经的孤岛已被接上（saw）', usedIn('addSaw', PLUGIN) || usedIn('sawsFromRuns', PLUGIN));
}

// ── ② 负控制：判据有没有牙齿 ──────────────────────────────────
{
  // 只被测试引用 → 必须红
  const srcA = { 'ghost.mjs': 'export function phantomThing(){ return 1; }' };
  const badA = islandsOf({ src: srcA, pluginCode: '// 测试里用了 phantomThing，但那不算\n', allow: {} });
  ok('只被测试引用的模块 → 判红', badA.length === 1, JSON.stringify(badA));

  // 完全没人叫 → 必须红
  const badB = islandsOf({ src: srcA, pluginCode: '', allow: {} });
  ok('完全没人叫的模块 → 判红', badB.length === 1, JSON.stringify(badB));

  // 例外表里、理由充足、src 内部真有人消费 → 必须绿
  const srcC = {
    'inner.mjs': 'export const helper = 1; export function helperFn(){ return helper; }',
    'outer.mjs': 'import { helperFn } from "./inner.mjs";\nexport function useIt(){ return helperFn(); }',
  };
  const badC = islandsOf({ src: srcC, pluginCode: '// 只在 plugin 里叫 outer\nconst x = useIt;\n', allow: { 'inner.mjs': '内核内部消费' } });
  ok('例外表 + src 内部真有人用 → 放过', badC.length === 0, JSON.stringify(badC));

  // 例外表写了理由，但 src 内部也没人叫 → 理由造假，必须红
  const badD = islandsOf({ src: srcA, pluginCode: '', allow: { 'ghost.mjs': '内核内部消费' } });
  ok('例外理由造假（内部也没人叫）→ 判红', badD.length === 1, JSON.stringify(badD));

  // 例外表写了空理由 → 等于没写，必须红
  const badE = islandsOf({ src: srcA, pluginCode: '', allow: { 'ghost.mjs': '   ' } });
  ok('例外理由为空 → 判红', badE.length === 1, JSON.stringify(badE));

  // 只在注释里出现 → 不算调用
  const badF = islandsOf({ src: srcA, pluginCode: '// phantomThing 以前在这\n', allow: {} });
  ok('只在注释里提到 → 不算有着落', badF.length === 1, JSON.stringify(badF));
}

// ── ③ 例外表本身的质量 ────────────────────────────────────────
{
  ok('例外表每一条都写了理由', Object.entries(INTERNAL_ONLY).every(([, v]) => typeof v === 'string' && v.trim()));
  ok('例外表里没有「还没接上」的借口', Object.values(INTERNAL_ONLY).every((v) => !/还没接|待接|TODO|暂时/i.test(v)));
  // 例外表里写的文件名必须真的存在（改名了要同步改，否则例外在空转）
  const missing = Object.keys(INTERNAL_ONLY).filter((k) => k.endsWith('.mjs') && !SRC[k]);
  ok('例外表里的文件都真实存在', missing.length === 0, missing.join(', '));
}

console.log(`\n==== 孤岛守卫：${pass} 通过 / ${fail} 失败 ====\n`);
process.exit(fail ? 1 : 0);
