/**
 * _patch_entry.mjs —— 一次性把五个验收脚本的「对真实现」入口换成适配层。
 *
 * 为什么单独写一个补丁脚本而不是手改五遍：
 * 五个脚本的 main() 长得一样，手改容易只改四个；
 * 而且「怎么连真实现」这件事以后还会变（接口一换就得重连），
 * 集中在 _real_mind.mjs 一处开关，谁改都只改那里。
 *
 * 幂等：已经是新写法的脚本会被跳过。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = ['a_seed_discard', 'b_think_more', 'c_curiosity', 'd_change_mind', 'e_forget_by_new'];

// 旧写法：直接拿 createMind 拼
const OLD = /const createMind = rel\.mod\.createMind \?\? rel\.mod\.default;\n(\s*)if \(typeof createMind !== 'function'\) return skip\('[a-z_]+', '[^']*'\);\n\n\s*const h = await runAgainst\(async \(synth, opts\) => createMind\(\{ synth, \.\.\.opts \}\)\);/;

// 新写法：走适配层（_real_mind.buildMind），fake synth 会被翻成真内核要的形状
const NEW = (name) =>
  `// 真实现入口统一走 _real_mind：它负责把假模型的话翻译成真内核要的 JSON 形状。\n` +
  `  // 判据不在这里，也不该在这里——这里只接线。\n` +
  `  const { buildMind } = await import('./_real_mind.mjs');\n` +
  `  const h = await runAgainst(async (_synthIgnored, opts) => buildMind(rel.mod, { ...opts, brain: 'thinker' }));`;

let patched = 0;
for (const name of FILES) {
  const p = resolve(HERE, `${name}.mjs`);
  let s = readFileSync(p, 'utf8');
  if (s.includes('_real_mind.mjs')) {
    console.log(`skip  ${name}（已是新写法）`);
    continue;
  }
  const before = s;
  s = s.replace(OLD, (m) => NEW(name));
  if (s === before) {
    console.log(`WARN  ${name}：没匹配上，需要人工看`);
    continue;
  }
  writeFileSync(p, s, 'utf8');
  patched += 1;
  console.log(`patch ${name}`);
}
console.log(`done, patched=${patched}`);
