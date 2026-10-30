/**
 * _run.mjs —— 「这个脚本是直接跑的，还是被别人 import 的」统一判定。
 *
 * 为什么要单独一个小文件：五个验收脚本都要能被 tests/ 和 selfProof 直接 import
 * （拿假的坏实现去跑同一套判据），同时也要能被 `node acceptance/x.mjs` 直接跑。
 * 自己写 `import.meta.url === 'file://' + argv[1]` 在 Windows 上十次九次错
 * （盘符、反斜杠、大小写），错了就会「静默 exit 0」——那正是假绿。
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export function isMain(metaUrl) {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return metaUrl === pathToFileURL(resolve(arg)).href;
  } catch {
    return false;
  }
}
