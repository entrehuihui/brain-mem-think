/**
 * smoke_full_shadow.mjs —— 「熔完原文必须一条不剩」的切法测试。
 *
 * 工具：`node tests/smoke_full_shadow.mjs`
 *
 * 为什么单拎出来测：这一段以前埋在插件闭包里，只能靠跑真实宿主验证；
 * 而它切错的代价是「上下文没遮掉」或者「会话被写坏（400 tool mismatch）」。
 * 现在它是个纯函数，每种切法都能钉死。
 */

import { planFullShadow } from '../plugin/shadow-plan.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

// ── ① 普通情形：system + 4 个节点 → 系统之后全遮 ─────────────────────
{
  const seqs = [10, 11, 12, 13, 14];
  const p = planFullShadow(seqs, new Map());
  ok('从 system 之后整段遮', JSON.stringify(p?.shadow) === JSON.stringify([11, 12, 13, 14]), JSON.stringify(p));
  ok('startSeq 是数组里的第一个可见节点', p?.startSeq === 11);
  ok('endSeq 是数组里的最后一个（按数组顺序，不是数值）', p?.endSeq === 14);
}

// ── ② 数值乱序：宿主实测出现过 [108,129,115,123] 这种排布 ─────────────
{
  const seqs = [108, 129, 115, 123, 124, 126];
  const p = planFullShadow(seqs, new Map());
  ok('乱序也按数组顺序切（不信数值大小）', JSON.stringify(p?.shadow) === JSON.stringify([129, 115, 123, 124, 126]), JSON.stringify(p));
  ok('乱序时 startSeq 取数组首、endSeq 取数组尾', p?.startSeq === 129 && p?.endSeq === 126);
}

// ── ③ 只剩 system + 一条记忆：不动 ───────────────────────────────────
{
  ok('只有 system 时返回 null', planFullShadow([10], new Map()) === null);
  ok('空数组返回 null', planFullShadow([], new Map()) === null);
  ok('不是数组也返回 null', planFullShadow(null, new Map()) === null);
}

// ── ④ 未收尾的 tool/call：从它开始不许遮 ─────────────────────────────
{
  const seqs = [10, 11, 12, 13, 14];
  const bySeq = new Map([
    [12, { seq: 12, type: 'tool/call', data: { callId: 'c1' } }],
    // 没有对应的 tool/result → 这一对还没收尾
  ]);
  const p = planFullShadow(seqs, bySeq);
  ok('未收尾的 tool/call 之前就停手', JSON.stringify(p?.shadow) === JSON.stringify([11]), JSON.stringify(p));
  ok('并标记原因', p?.blocked === 'pending-tool-call');
}

// ── ⑤ 配对完整的工具调用：整对一起遮 ──────────────────────────────────
{
  const seqs = [10, 11, 12, 13];
  const bySeq = new Map([
    [12, { seq: 12, type: 'tool/call', data: { callId: 'c1' } }],
    [13, { seq: 13, type: 'tool/result', data: { message: { toolCallId: 'c1' } } }],
  ]);
  const p = planFullShadow(seqs, bySeq);
  ok('成对的工具调用整对进遮蔽范围（不会撕裂）', JSON.stringify(p?.shadow) === JSON.stringify([11, 12, 13]), JSON.stringify(p));
  ok('成对时不标记 pending', p?.blocked === undefined);
}

// ── ⑥ 唯一一个 pending call 就在最前面：什么都不遮 ─────────────────────
{
  const seqs = [10, 11, 12];
  const bySeq = new Map([[11, { seq: 11, type: 'tool/call', data: { callId: 'c1' } }]]);
  const p = planFullShadow(seqs, bySeq);
  ok('最前面的 call 未收尾 → shadow 为空，调用方不许 append', p?.shadow.length === 0 && p?.blocked === 'pending-tool-call', JSON.stringify(p));
}

console.log(`\n==== ${fail === 0 ? '全绿' : '有红'}：${pass} 通过 / ${fail} 失败 ====\n`);
process.exit(fail === 0 ? 0 : 1);
