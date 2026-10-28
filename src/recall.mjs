/**
 * recall.mjs —— 按当下的情境取几条，不是把整库摆在眼前。
 *
 * ======================= 它为什么必须存在 =======================
 *
 * 到 2026-10-28，`world()` 把**所有现役判断**塞进上下文（maxHeld=100）。
 * 26 条还行；按主题空间算，她迟早会有 189 条——那时候每轮请求都拖着一整本账，
 * 她读得越多，越像个背清单的人。
 *
 * 人不是这么记的：当下这件事让她想起三件相关的，其余的沉在水底。
 * 想不起来是正常的；需要的时候能捞上来，才是本事。
 *
 * ======================= 三条纪律 =======================
 *
 * ① **必须留的永远留**：身份（她是谁）、悬着的（还没想明白的）。
 *    这两类不是「相关」，是「底色」——按情境筛掉它们，她就不是她了。
 *
 * ② **其余按分数取**：底气和扎心度打底，加上「跟当下这件事有多像」。
 *    像不像只用字符重合 + 主题键 + 对象，**不调模型**（这是一次纯检索）。
 *
 * ③ **取不满就不取**：没有一条相关时只留底色，不硬凑五条。
 *    凑出来的「相关」是噪音，比空着更糟。
 */

import { weightWithSting } from './sting.mjs';

export const RECALL_DEFAULTS = Object.freeze({
  maxHeld: 5,          // 按情境取的现役条数（3~5，这里是上限）
  minScore: 0.2,       // 低于这条线的不算「想起」（Dice 系数）
  textWeight: 0.55,    // 文本重合占多少
  themeBonus: 0.35,    // 主题键命中（最硬的一条线索）
  whoBonus: 0.10,      // 对象命中
});

/** 去掉标点和最没信息量的字，剩下的字集合。中文没有空格，按字算比按词稳。 */
// ★ 只去虚词，**保留代词**（他/我/你）：谁是这条判断的对象，是检索里最硬的线索之一。
//   第一版把「他/我」也当停用字，结果「他今天又在催我」跟「他总在催我」一个字都对不上。
const STOP = new Set('的一了是着的过很都就还也又再在要会能可没不有这那什么'.split(''));

function charSet(s) {
  const t = String(s ?? '').replace(/[s，。！？、；：,.!?;:—…·"'「」『』（）()【】[]]+/g, '');
  const out = new Set();
  for (const ch of t) if (!STOP.has(ch)) out.add(ch);
  return out;
}

/** Dice 系数：2|A∩B| / (|A|+|B|)。短文本之间比 bigram 稳。 */
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const x of a) if (b.has(x)) hit += 1;
  return (2 * hit) / (a.size + b.size);
}

/**
 * 从库里取「当下这几条」。
 *
 * @param {{text?:string, who?:string[], themeKeys?:string[]}} focus 当下的情境
 * @param {object[]} notes 归一化后的判断（有 status / text / why / themeKey / subject / strength / sting / kind）
 * @param {object} [opts]
 * @returns {{held:object[], scored:object[], notesLeft:number}}
 */
export function recallFor(focus, notes, opts = {}) {
  const o = { ...RECALL_DEFAULTS, ...(opts ?? {}) };
  const f = focus && typeof focus === 'object' ? focus : { text: String(focus ?? '') };
  const fText = charSet(f.text ?? '');
  const fWho = new Set((f.who ?? []).map(String));
  const fTheme = new Set((f.themeKeys ?? []).map(String));

  const all = Array.isArray(notes) ? notes : [];
  const heldAll = all.filter((n) => n?.status === 'held');

  // ① 底色：身份 + 悬案，永远留
  const must = all.filter((n) => n?.status === 'open' || n?.kind === 'identity');

  // ② 其余打分
  const scored = [];
  for (const n of heldAll) {
    const base = weightWithSting(n);
    const body = `${n.text ?? ''}${n.why ?? ''}`;
    const sim = overlap(fText, charSet(body));
    const themeHit = n.themeKey && fTheme.has(String(n.themeKey)) ? 1 : 0;
    const whoHit = n.subject && fWho.has(String(n.subject)) ? 1 : 0;
    const score = base + sim * o.textWeight + themeHit * o.themeBonus + whoHit * o.whoBonus;
    scored.push({ note: n, score: Number(score.toFixed(3)), sim: Number(sim.toFixed(3)), themeHit, whoHit });
  }
  scored.sort((a, b) => b.score - a.score);

  const picked = [];
  const pickedIds = new Set(must.map((n) => n.id));
  for (const s of scored) {
    if (picked.length >= o.maxHeld) break;
    if (pickedIds.has(s.note.id)) continue;
    // ③ 必须有一条硬线索才取：文本够像、主题命中、或对象命中。
    //    不再拿「底子厚」当理由——那就变成整库按份量排前五，跟情境没关系了。
    if (!s.themeHit && !s.whoHit && s.sim < o.minScore) continue;
    picked.push(s.note);
    pickedIds.add(s.note.id);
  }

  return {
    held: [...must, ...picked],
    scored: scored.slice(0, 10).map((s) => ({ id: s.note.id, score: s.score, sim: s.sim, themeHit: s.themeHit, whoHit: s.whoHit })),
    notesLeft: Math.max(0, heldAll.length - picked.length),
  };
}
