/**
 * _cordis_load_test.mjs —— 用真的 cordis 加载这个插件，看宿主认不认。
 *
 * 这一步的价值：不动主人的 DSH、不用重启，就能知道
 * 「模块格式对不对」「apply 会不会被调用」「apply 里会不会抛」。
 *
 * 我们用 cordis 的 Context 起一个最小应用，把假服务塞进去，
 * 然后 plugin() 加载插件文件。
 */

import { Context } from '@deepseek-ai/cordis';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const PLUGIN = '%USERPROFILE%\\.dsh\\profiles\\web\\plugins\\mind\\plugin\\index.mjs';

console.log('\n=== 用 cordis 加载插件 ===');
console.log('目标:', PLUGIN);

const app = new Context();
let applyEntered = false;
let injectsRegistered = 0;

// 记录 apply 有没有被调用：监听 stderr 不现实，这里用插件自己的日志文件反推。
// 先把旧日志挪开，跑完看有没有新的。
const fs = await import('node:fs');
const ROOT = '%USERPROFILE%\\.dsh\\profiles\\web\\plugins\\mind';
const LOG = join(ROOT, '.mind', 'mind.log');
const before = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').length : 0;

try {
  const mod = await import(pathToFileURL(PLUGIN).href);
  console.log('  ✓ 模块导入成功，导出:', Object.keys(mod).join(', '));

  // cordis 的 plugin() 接受：函数 / 带 apply 的对象 / 模块命名空间
  const plugin = mod.default ?? mod;
  const fiber = app.plugin ? app.plugin(plugin) : null;
  console.log('  ✓ 交给 cordis 加载，返回:', fiber ? typeof fiber : 'null');

  // 给它一点时间去跑 apply
  await new Promise((r) => setTimeout(r, 800));
} catch (err) {
  console.log('  ✗ 加载失败:', err?.message ?? err);
  if (err?.stack) console.log(err.stack.split('\n').slice(0, 5).join('\n'));
}

const after = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
const grew = after.length > before;
console.log('\n=== 插件自己写的日志 ===');
if (grew) {
  const added = after.slice(before).trim().split('\n').filter(Boolean);
  console.log(`  ✓ 新增 ${added.length} 行：`);
  for (const l of added) console.log('   ', l.slice(0, 150));
  applyEntered = added.some((l) => l.includes('apply-entered'));
  console.log(`\n  apply() 被 cordis 调用了吗：${applyEntered ? '是' : '否'}`);
} else {
  console.log('  ✗ 没有新日志 → apply() 没被 cordis 调用');
}

process.exit(applyEntered ? 0 : 1);
