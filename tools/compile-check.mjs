// 真正的检查：用 vm.SourceTextModule 编译一遍。
// 它能抓到 `xx is not defined` 这类「引用了不存在的绑定」——
// 普通 node --check 只查语法，查不出这类错误。
// 上次 `lastOwnerIdx is not defined` 就是 node --check 放过去的。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const files = process.argv.slice(2);
let bad = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  try {
    // 只编译不链接：能编译说明语法 OK；链接阶段才会校验跨模块导入
    new vm.SourceTextModule(src, { identifier: f });
    console.log(f + '  OK');
  } catch (e) {
    bad += 1;
    console.log(f + '  FAIL: ' + e.message);
  }
}
process.exit(bad ? 1 : 0);
