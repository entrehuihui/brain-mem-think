/**
 * shadow-plan.mjs —— 「这一刀该从哪里切」。
 *
 * ======================= 它守的那条不变量 =======================
 *
 *   可见 = 未熔；熔过的，原文一律不许再出现在她的上下文里。
 *
 * 之前这条不变量是反的：遮蔽的规则是「永远留住最后几条原文」，
 * 于是她下一轮拿到的仍然是「记忆 + 上一轮你的原话 + 她自己上一轮的回话」。
 * 有记忆，但仍然是基于上下文在想——这跟主人要的「记忆迭代」是两回事：
 *
 *   记忆₀ + 话₁ → 记忆₁          （要的）
 *   记忆₀ + 记忆₀ + 话₁ + 话₂ …  （现在，原文一直在往上叠）
 *
 * 所以遮蔽不再按「留几条」算，而是按**事实**算：熔成功了 → 从 system 之后整段遮掉；
 * 没熔成功 → 一个字都不遮（材料还得留着下一跳重熔）。
 *
 * ======================= 为什么单独一个文件 =======================
 *
 * 这段刀口以前埋在 plugin 的闭包里，只能靠跑真实宿主验证，
 * 而它出错的代价是「会话被写坏 / 上下文没遮掉」这种要命的事。
 * 抽成纯函数，就能拿假数据把每一种切法都钉死（tests/smoke_full_shadow.mjs）。
 */

const isInt = (n) => Number.isInteger(n);

/** 从宿主事件里认出 tool/call 和 tool/result 的配对键。 */
function pairKeys(event) {
  if (event?.type === 'tool/call' && event?.data?.callId) {
    return { role: 'call', key: String(event.data.callId) };
  }
  if (event?.type === 'tool/result' && event?.data?.message?.toolCallId) {
    return { role: 'result', key: String(event.data.message.toolCallId) };
  }
  return null;
}

/**
 * 算「整段遮蔽」的区间：system 节点留着，其余全遮。
 *
 * 三条规矩：
 *   ① 只按 **数组顺序** 切，不按 seq 数值大小——surface.nodes 的数组顺序才是宿主
 *      的可见顺序（实测出现过 [108, 129, 115, 123] 这种数值乱序的排布，
 *      宿主的 replace 用的是 indexOf 下标，按数值排序会切错）。
 *   ② 未收尾的 tool/call（还没有对应 result）不许被遮：遮了 call、留下后面的
 *      result，网关会报 "tool calls and tool results do not match"，整条会话报废。
 *      遇到这种就从那个 call 起整段不遮。
 *   ③ 只剩 system（或 system + 一条记忆）时返回 null，别每跳空转一次 append。
 *
 * @param {number[]} seqs       surface.nodes（宿主给的，顺序即可见顺序）
 * @param {Map<number, object>} bySeq  seq → 会话事件
 * @returns {{shadow:number[], startSeq:number, endSeq:number, blocked?:string} | null}
 */
export function planFullShadow(seqs, bySeq = new Map()) {
  const list = Array.isArray(seqs) ? seqs.filter(isInt) : [];
  if (list.length < 2) return null;
  // ★ 节点 0 是宿主保护的 system prompt，永远不进范围。
  const rest = list.slice(1);
  if (rest.length < 1) return null;

  // ② 未收尾的 tool/call：找最早的那个，从它开始不遮。
  const calls = new Map();
  for (const [seq, e] of bySeq) {
    const p = pairKeys(e);
    if (!p) continue;
    if (!calls.has(p.key)) calls.set(p.key, {});
    calls.get(p.key)[p.role] = seq;
  }
  let cut = rest.length;
  for (const [, v] of calls) {
    const half = v.call != null && v.result == null;
    if (!half) continue;
    const idx = rest.indexOf(v.call);
    if (idx >= 0) cut = Math.min(cut, idx);
  }
  const shadow = rest.slice(0, cut);
  if (!shadow.length) return { shadow: [], startSeq: null, endSeq: null, blocked: 'pending-tool-call' };
  return {
    shadow,
    startSeq: shadow[0],
    endSeq: shadow[shadow.length - 1],
    blocked: cut < rest.length ? 'pending-tool-call' : undefined,
  };
}
