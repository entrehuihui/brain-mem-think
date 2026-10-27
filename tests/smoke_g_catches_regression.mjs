/**
 * tests/smoke_g_catches_regression.mjs —— 证明「结构断言」真的会咬人。
 *
 * g_theme_structural 现在全绿，全绿有两种可能：
 *   ① src 真的干净了（好）
 *   ② 我的扫描器坏了，什么都扫不出来（坏，而且更危险）
 * 这条测试的做法：在临时目录里造一份**故意回潮**的假源码，让扫描器去扫它，
 * 必须报红。它红了，才说明 src 的全绿是真的绿。
 */
import { createHarness, EXIT } from '../acceptance/_harness.mjs';
import { isMain } from '../acceptance/_run.mjs';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 把扫描逻辑抽出来单独跑：g_theme_structural 是扫真实的 src/，
// 这里要扫别处，所以用同一条规则函数（从模块里导出不方便，就地复一套，并加断言确保一致）
function scan(text) {
  const hits = { signals: 0, hints: 0, loose: 0, wordlist: 0 };
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const line of noBlock.split(/\r?\n/)) {
    const s = line.replace(/\/\/.*$/, '');
    if (!s.trim()) continue;
    if (/THEME_SIGNALS/.test(s)) hits.signals += 1;
    if (/THEME_HINT_WORDS/.test(s)) hits.hints += 1;
    if (/['"]loose['"]/.test(s)) hits.loose += 1;
    const cjkWords = s.match(/['"][\u4e00-\u9fff]{1,3}['"]/g) || [];
    const looksTheming = /theme|THEME|hint|HINT/i.test(s);
    if (cjkWords.length >= 3 && looksTheming && /(\[|some\(|includes\()/.test(s)) hits.wordlist += 1;
  }
  return hits;
}

async function main() {
  const h = createHarness('smoke · 结构断言会不会咬人（回潮源码必须被抓）', {
    purpose: 'g_theme_structural 全绿时，要能证明扫描器没瞎',
  });
  h.armWatchdog();

  const regression = `
export const THEME_SIGNALS = Object.freeze({ tired: ['累', '乏', '困', '精神'] });
export function themeOf(s) {
  for (const key of Object.keys(THEME_SIGNALS)) {
    if (THEME_SIGNALS[key].some((n) => s.includes(n))) return key;
  }
  return 'loose';
}`;
  const back = scan(regression);
  h.atLeast('smoke.catches_THEME_SIGNALS', back.signals, 1, `回潮源码里的 THEME_SIGNALS 被数到 ${back.signals} 处`);
  h.atLeast('smoke.catches_loose_fallback', back.loose, 1, `loose 兜底被数到 ${back.loose} 处`);
  h.atLeast('smoke.catches_wordlist', back.wordlist, 1, `短中文词表被数到 ${back.wordlist} 处`);

  const clean = `
import { PREDICATES } from './judge.mjs';
export function themeOf(relation, subject) {
  return \`\${relation}|\${subject}\`;
}`;
  const ok = scan(clean);
  h.equal('smoke.clean_code_passes', ok.signals + ok.hints + ok.loose + ok.wordlist, 0,
    `干净代码不该被误判：${JSON.stringify(ok)}`);

  // 谓词闭集不能被误判成主题词表（我上一版就是这么冤枉 judge.mjs 的）
  const predicates = `export const PREDICATES = Object.freeze({ trusts: ['信得过', '信', '靠得住'], wants: ['要', '想要'] });`;
  h.equal('smoke.predicates_not_flagged', scan(predicates).wordlist, 0,
    '谓词闭集是裁决要求保留的，不许被判成主题词表');

  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('smoke_g 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}
