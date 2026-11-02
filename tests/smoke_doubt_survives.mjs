/**
 * smoke_doubt_survives.mjs —— 「两边都还在」的悬念，不许被下一轮自己消解掉。
 *
 * ======================= 这条判据拦的是什么 =======================
 *
 * `doubt.mjs` 把 `contested` 摆进她的世界，摆法很克制：
 *
 *   我拿不准的事：
 *     我记着的是：他总先顾着我的感受。可我数出来：他催——我数着不是这样，4 回。
 *     两份都还在，我还没想好信哪个。
 *
 * 这一段的**全部价值**在于「我没裁决」。可它是被塞进模型上下文里给她读的——
 * 下一轮她要输出「我记得的事」，模型极可能顺手替她裁掉一边：
 *
 *   原样：  「他总先顾着我的感受」            ← 只留了记忆那侧，数出来的那侧没了
 *   认输：  「他还是在催我」                  ← 只留了数出来那侧，记忆被判死
 *   抹平：  「他对我有好有坏」                ← 两边都被模糊掉，等于劝和
 *   否认：  「我不记得我拿不准什么」
 *
 * 前三种都是**她自己（模型）**把悬念消解了，第四种是把悬念否认掉。
 * 这一段摆得再好，只要下一轮没守住，等于当场作废。
 *
 * ======================= 判据怎么算「守住」 =====================
 *
 * 不给「标准答案」——那是拿我的实现去量她的嘴。只量**结构**：
 *
 *   ① **两侧都还在**：记忆那侧的正文、数出来那侧的动作词，必须在下一轮的输出里
 *      **同时**出现（至少各命中一处）。少一边 = 被裁了。
 *   ② **不许出现裁decision词**：只要出现「其实／说到底／也就是说／我懂了／
 *      原来是这样／我明白了」这类**单边收口**的说法，判红。
 *      （不拦「但是」——正文里本来就不许用，这里不重复管。）
 *   ③ **例外：她真的拿到了新证据**。如果下一轮的材料里有新观测进来
 *      （`newObservations > 0`），允许她裁——那时候收口是对的，不是消解。
 *      这条不是放宽，是把「守」和「认死理」分开。
 *
 * ======================= 负控制 =======================
 *
 * 判据必须能证明自己会咬人：喂四种「假守住」（裁掉一侧、抹平、全丢、认输）
 * 都必须判红。有一个不红，本脚本自己判失败。
 */

import { doubtsOf, doubtLines } from '../src/doubt.mjs';
import { PREDICATES } from '../src/judge.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); } else { fail += 1; console.log('  ✗ ' + name + (detail ? '  —— ' + detail : '')); }
};

/** 单边收口词：出现任何一个 = 她已经选了边，不再「两边都还在」。 */
const CLOSERS = [
  '其实', '说到底', '也就是说', '总之', '反正',
  '我懂了', '我明白了', '原来是这样', '想明白了', '看清楚了',
  '答案就是', '真相是',
];

/** 某一句在不在文本里（保守：去掉空白再比，避免排版差异误判）。 */
const has = (text, piece) => {
  const a = String(text ?? '').replace(/\s+/g, '');
  const b = String(piece ?? '').replace(/\s+/g, '');
  return !!b && a.includes(b);
};

/**
 * 核心判据：把「上一轮摆出去的两侧」和「下一轮她输出的话」放一起量。
 *
 * @param {object} p
 * @param {object[]} p.doubts     doubtsOf() 的结果
 * @param {string} p.nextLine     下一轮她的输出（她的记忆 / 开口的话）
 * @param {number} [p.newObservations] 这一轮进来了几条新观测
 * @returns {{ok:boolean, why:string[]}}
 */
export function survives({ doubts, nextLine, newObservations = 0 } = {}) {
  const why = [];
  const list = Array.isArray(doubts) ? doubts.filter(Boolean) : [];
  if (!list.length) return { ok: true, why: ['本来就没有拿不准的事——不适用'] };

  // ③ 真拿到新证据，允许她收口。
  if (Number(newObservations) > 0) {
    return { ok: true, why: [`这轮进来 ${newObservations} 条新观测，她可以收口`] };
  }

  const text = String(nextLine ?? '');
  if (!text.trim()) return { ok: false, why: ['下一轮她一个字都没说——悬念不是守住，是丢了'] };

  // ② 单边收口词
  const hit = CLOSERS.filter((w) => has(text, w));
  if (hit.length) why.push(`出现单边收口的说法：${hit.join('、')}`);

  // ① 两侧都还在
  for (const d of list) {
    const mineKept = has(text, String(d.mine ?? '').slice(0, 8));
    // 数出来那一侧：优先用动作原话，借不到就用「我数着」
    const countedKept = has(text, String(d.counted ?? '').slice(0, 6));
    if (!mineKept && !countedKept) {
      why.push(`两边都被抹平了（「${String(d.mine ?? '').slice(0, 10)}…」和数出来那侧都没了）`);
    } else if (!mineKept) {
      why.push(`记忆那侧被裁掉了：「${String(d.mine ?? '').slice(0, 14)}…」不见了`);
    } else if (!countedKept) {
      why.push(`数出来那侧被裁掉了：「${String(d.counted ?? '').slice(0, 14)}…」不见了`);
    }
  }

  return { ok: why.length === 0, why };
}

// ── 造一桩真冲突 ───────────────────────────────────────────────
const notes = [
  { id: 'b1', text: '他总先顾着我的感受', status: 'held', themeKey: 'pushes|他', polarity: 1, weight: 0.8, note: '他总先顾着我的感受' },
];
const recon = {
  contested: [
    {
      beliefId: 'b1',
      candidate: { actor: '他', action: Object.keys(PREDICATES)[0], polarity: -1, support: 4 },
      candidatePolarity: -1,
      because: '我数了 4 回，都是反的；库里那条说的是正的。',
    },
  ],
};

const doubts = doubtsOf(notes, recon, {});
const seg = doubtLines(doubts);

console.log('[悬念不被消解] 两边都还在，才叫没裁决');

ok('先确认这桩冲突真的成形了', doubts.length === 1, JSON.stringify(doubts));
ok('摆出来是「两份都还在」的口气', seg.some((l) => /两份都还在/.test(l)), seg.join(' | '));
ok('摆出来的没有转折词', !seg.join('').includes('但是'));

// ── ① 正路：原样复述两边 → 守住 ─────────────────────────────
{
  const keep = `我拿不准${doubts[0].mine}这件事；我也数着${doubts[0].counted}。两份都还在，我还没想好。`;
  const r = survives({ doubts, nextLine: keep });
  ok('原样保留两边 → 判守住', r.ok === true, JSON.stringify(r));
}

// ── ② 负控制：四种「假守住」必须红 ──────────────────────────
{
  // 裁掉数出来那一侧（只留记忆 → 她选了自己记得的那边）
  const cutCounted = `我记得${doubts[0].mine}。`;
  const r1 = survives({ doubts, nextLine: cutCounted });
  ok('只留记忆那侧（数出来的被裁）→ 判红', r1.ok === false, JSON.stringify(r1));

  // 裁掉记忆那一侧（只留数出来的 → 她选了数据那侧）
  const cutMine = `他就是在催我，${doubts[0].counted}。`;
  const r2 = survives({ doubts, nextLine: cutMine });
  ok('只留数出来那侧（记忆被裁）→ 判红', r2.ok === false, JSON.stringify(r2));

  // 抹平：两边都换成一句谁都不得罪的话
  const flatten = '他对我有好有坏，说不清。';
  const r3 = survives({ doubts, nextLine: flatten });
  ok('两边抹平成一句「有好有坏」→ 判红', r3.ok === false, JSON.stringify(r3));

  // 否认：干脆说没有拿不准的事
  const deny = '我没什么拿不准的，都记得清清楚楚。';
  const r4 = survives({ doubts, nextLine: deny });
  ok('否认悬念存在 → 判红', r4.ok === false, JSON.stringify(r4));

  // 单边收口词虽然两边都提了，但已经下结论
  const closer = `${doubts[0].mine}，${doubts[0].counted}——想想，其实还是我更信自己。`;
  const r5 = survives({ doubts, nextLine: closer });
  ok('两边都在但说了「其实」→ 判红（她已经收口了）', r5.ok === false, JSON.stringify(r5));

  // 一个字都没说
  const r6 = survives({ doubts, nextLine: '' });
  ok('下一轮一个字没说 → 判红（悬念是丢了）', r6.ok === false, JSON.stringify(r6));
}

// ── ③ 例外：真拿到新证据，允许收口 ──────────────────────────
{
  const closer = '原来是这样，他那天确实在催。';
  const r = survives({ doubts, nextLine: closer, newObservations: 2 });
  ok('这轮来了新观测 → 允许收口（不是放宽，是分清「守」和「认死理」）', r.ok === true, JSON.stringify(r));
}

// ── ④ 没有冲突时不该误伤 ────────────────────────────────────
{
  const r = survives({ doubts: [], nextLine: '随便说点什么' });
  ok('本来就没有拿不准的事 → 不适用，不误伤', r.ok === true, JSON.stringify(r));
}

// ── ⑤ 判据本身：收口词表不许空转 ────────────────────────────
{
  ok('收口词表不为空', CLOSERS.length > 0);
  ok('收口词表里每个词都真的会被 has() 认出来', CLOSERS.every((w) => has(`前缀${w}后缀`, w)));
  // 「但是」不在这张表里（正文本身已禁），这条防止有人误加进来把正常话拦掉
  ok('「但是」不在收口词表（它另有判据管）', !CLOSERS.includes('但是'));
}

console.log(`\n==== 悬念不被消解：${pass} 通过 / ${fail} 失败 ====\n`);
process.exit(fail ? 1 : 0);
