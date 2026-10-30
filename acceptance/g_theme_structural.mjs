/**
 * g_theme_structural.mjs —— 结构断言：主题归一不许再回到「关键词表」
 *
 * ============== 它防什么 ==============
 *
 * Lead 的裁决（`spec/裁决-主题归一.md`）把主题键改成从判断结构取：
 *   themeKey = `${relation}|${subject}`
 * 并明确删掉两层词表：
 *   · `src/mind.mjs`  的 `THEME_SIGNALS`
 *   · `src/curiosity.mjs` 的 `THEME_HINT_WORDS`
 *
 * 这条验收要防的是**回潮**：改完之后总会有人（包括 Lead 自己）想
 * 「加一个关键词兜底吧，稳一点」——加一次前功尽弃，因为一旦有兜底，
 * 主题又会按字面归类，「陌生说法」那条验收立刻失去意义。
 *
 * 所以这里不是「测功能」，是**测禁令**：让回潮在测试里就过不去。
 *
 * ============== 判据 ==============
 *
 * G1  src/ 下不许出现 `THEME_SIGNALS`
 * G2  src/ 下不许出现 `THEME_HINT_WORDS`
 * G3  src/ 下不许出现「中文字符串数组 + includes 命中当主题」这种写法
 *     （即：一个数组里装的全是短中文词，然后拿它去 `some(...includes...)` 决定 key）
 * G4  `loose` 不许再作为主题兜底常量出现在返回路径上
 * G5  豁免名单：本文件自己、以及注释里提到这些词的地方不算（只查代码行，不查注释）
 *
 * 说明：这是**静态扫描**，读的是 src 源码文本。
 * 红队原则里「不做源码 grep」是为了防「靠读源码去猜实现行为」，
 * 但这一条测的恰恰是「源码里有没有这句禁令」，扫描是唯一手段，所以单列一条并写清理由。
 */

import { createHarness, EXIT } from './_harness.mjs';
import { isMain } from './_run.mjs';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../src');

/** 递归列出 src/ 下所有 .mjs */
function listSources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listSources(p));
    else if (name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

/** 去掉注释与字符串外的噪音：只留「可能是代码」的行，避免注释里提到这个词就误报。 */
function codeLines(text) {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlock
    .split(/\r?\n/)
    .map((l, i) => ({ i: i + 1, s: l.replace(/\/\/.*$/, '') }))
    .filter((x) => x.s.trim());
}

export async function runAgainst() {
  const h = createHarness('g_theme_structural · 结构断言：主题归一不许回潮成关键词表', {
    capability: '防回潮（Lead 裁决：删除两层词表，主题键改成 relation|subject）',
    purpose: '让「加个关键词兜底」这件事在测试里过不去，而不是靠人记着',
  });
  h.armWatchdog();

  const files = listSources(SRC);
  h.atLeast('G0.scanned_files', files.length, 5, `扫了 ${files.length} 个 src 文件`);

  const hits = { signals: [], hints: [], loose: [], wordlist: [] };
  for (const f of files) {
    const rel = f.slice(resolve(SRC).length + 1);
    const text = readFileSync(f, 'utf8');
    for (const { i, s } of codeLines(text)) {
      if (/THEME_SIGNALS/.test(s)) hits.signals.push(`${rel}:${i}  ${s.trim().slice(0, 90)}`);
      if (/THEME_HINT_WORDS/.test(s)) hits.hints.push(`${rel}:${i}  ${s.trim().slice(0, 90)}`);
      // 兜底大口袋：`loose` 被**当成返回值或默认值**用，才算回潮。
      //
      // ★ 2026-10-27 大乔裁决后收紧：原来只要行里出现 'loose' 就报。
      //   可 `!== 'loose'` 是**排除**兜底（「主题不是兜底才认」），
      //   恰恰是在执行裁决一，不该被判违规——它红过一轮，是冤枉。
      //   现在只抓三种「真当兜底用」的写法：
      //     return 'loose'  /  ?? 'loose'  /  = 'loose'（赋值默认值）
      if (/(return|=>)\s*['"]loose['"]/.test(s)
        || /\?\?\s*['"]loose['"]/.test(s)
        || /=\s*['"]loose['"]\s*[;)]/.test(s)) {
        hits.loose.push(`${rel}:${i}  ${s.trim().slice(0, 90)}`);
      }
      // wordlist 形态：一个数组里连续出现 ≥3 个 1~3 字的中文短词，
      // 而且这串词是**拿来判主题的**（在同一行或紧邻上下文里出现 includes/some 且变量名带 theme/hint/key）。
      //
      // ★ 这条判据修过一次。上一版只看「有没有一串短中文词 + includes」，
      //   结果把 judge.PREDICATES 里的谓词词表（'信得过'/'信'/'靠得住'……）全判成违规——
      //   那是**谓词闭集**，是裁决明确要求保留的东西，不是主题词表。
      //   判据太粗，就要冤枉正确实现；现在收紧成「必须是主题判定语境」。
      const cjkWords = s.match(/['"][\u4e00-\u9fff]{1,3}['"]/g) || [];
      const looksTheming = /theme|THEME|hint|HINT/i.test(s);
      if (cjkWords.length >= 3 && looksTheming && /(\[|some\(|includes\()/.test(s)) {
        hits.wordlist.push(`${rel}:${i}  ${s.trim().slice(0, 90)}`);
      }
    }
  }

  h.equal('G1.no_THEME_SIGNALS', hits.signals.length, 0,
    `src/ 里不许再有 THEME_SIGNALS：${hits.signals.slice(0, 3).join(' | ') || '无'}`);
  h.equal('G2.no_THEME_HINT_WORDS', hits.hints.length, 0,
    `src/ 里不许再有 THEME_HINT_WORDS：${hits.hints.slice(0, 3).join(' | ') || '无'}`);
  h.equal('G3.no_cjk_wordlist_theming', hits.wordlist.length, 0,
    `不许用「一串短中文词 + includes」来定主题（那就是词表法）：${hits.wordlist.slice(0, 3).join(' | ') || '无'}`);
  h.equal('G4.no_loose_fallback', hits.loose.length, 0,
    `loose 不许再当兜底大口袋：${hits.loose.slice(0, 3).join(' | ') || '无'}`);

  if (hits.signals.length || hits.hints.length || hits.wordlist.length || hits.loose.length) {
    h.info('清单', '以上是回潮证据；删掉它再谈功能');
  }

  return h;
}

async function main() {
  const h = await runAgainst();
  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('g_theme_structural 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}

export default main;
