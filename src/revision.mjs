/**
 * revision.mjs —— 改自己。
 *
 * 它为什么在这儿：
 * 判断会错。但「错」有两种：主人说「你错了」，和「我自己看到的事把我说服了」。
 * 只有后者算改自己，前者算被纠正——被纠正不算长脑子，只算听话。
 *
 * 机制上怎么把两者剥开：
 *   1. 证据是火炉从真实经历熔出来的那句（ctx.sources 记着它由哪几条材料烧成），
 *      不是一条「你错了」的指令。材料太少（sources 少于 2 条），一律不算证据。
 *   2. 必须同一主题才算对着这条判断的证据，隔一摊事的不算。
 *   3. 单条不够。要么至少两条支持相反立场的证据，要么一条重到能压过现役结论
 *      （weight ≥ 现役 weight + 0.25 且 ≥ 0.6）。
 *      ——一句话「你错了」熔出来的轻判断，压不翻任何东西。
 *
 * 推翻不是删：旧结论退成 retired，状态写着「曾经这么以为」，was 那一段
 * 留着它当时怎么说、为什么、什么时候。她以后翻得出来。
 */

import { RETIRE_REASON, STATUS, transition } from './judge.mjs';

/** 明确对反的谓词组：这些才算「谓词对反」。 */
export const CONTRARY = Object.freeze([
  ['trusts', 'distrusts'],
  ['can_stand', 'cant_stand'],
  ['grows_toward', 'grows_away'],
  ['can_say', 'cannot_say'],
  ['is_enough', 'wants_more'],
  ['fears', 'is_afraid_of'],
  ['is_above', 'is_below'],
]);

export const REVISION_DEFAULTS = Object.freeze({
  needOpposing: 2,
  strongWeight: 0.6,
  strongMargin: 0.25,
  minSources: 2,
  weightRatio: 0.8,   // 反证的分量至少要到现役的这个比例，轻的不许翻重的
});

/** 一次核查用的结构，只做清洗，不存原文。 */
function claimsOf(material, fallbackTheme) {
  return {
    themeKey: material?.themeKey ?? fallbackTheme ?? null,
    relation: material?.relation ?? null,
    polarity: material?.polarity ?? null,
    weight: material?.weight ?? 0,
    text: String(material?.text ?? ''),
    sources: Array.isArray(material?.sources) ? material.sources : [],
  };
}

/**
 * @param {object[]} notes 全部判断（会被就地改状态）
 * @param {object|object[]} evidence 这次熔出来的我自己的结论
 * @param {object} ctx { now, sources, memo, opts }
 * @returns {{retired: string[], retiredBecause: object, promoted: string[]}}
 */
export function review(notes, evidence, ctx = {}) {
  const o = { ...REVISION_DEFAULTS, ...(ctx.opts ?? {}) };
  // 明说这是我这次刚熔出来的证据（memo 指向它），哪怕就是「我改主意了」那一句。
  const fresh = ctx.memo ?? null;
  const sources = Array.isArray(ctx.sources) ? ctx.sources.filter(Boolean) : [];
  const witnessed = !fresh && sources.length >= o.minSources;

  const list = (Array.isArray(evidence) ? evidence : [evidence])
    .filter(Boolean)
    .map((e) => claimsOf(e, fresh?.themeKey));

  const retired = [];
  const retiredBecause = {};
  const promoted = [];

  for (const note of notes) {
    if (note.status !== STATUS.HELD) continue;
    const same = list.filter((c) => c.themeKey === note.themeKey && c.relation && c.polarity);
    if (!same.length) continue;
    if (!fresh && !witnessed && same.every((c) => c.weight < o.strongWeight)) continue;

    // ① 同一件事：主题键整串一致（裁决一：身份是 relation|subject，不是半段）
    const sameTopic = (c) => String(c.themeKey ?? '') === String(note.themeKey ?? '');
    // ② 立场相反 / ③ 谓词明确对反
    const opposite = (c) => Number(c.polarity) === -Number(note.polarity);
    const contrary = (c) => CONTRARY.some((pair) => pair.includes(String(c.relation)) && pair.includes(String(note.relation)));

    // 同立场：一律是加固，不是推翻（不管谓词多不一样）。
    const sameSide = (c) => Number(c.polarity) === Number(note.polarity);
    const reinforcing = same.filter((c) => sameTopic(c) && sameSide(c));
    if (reinforcing.length) {
      const top = reinforcing.reduce((a, b) => (b.weight > a.weight ? b : a));
      if (top.weight > note.weight) {
        note.weight = Math.min(1, top.weight);
        note.updatedAt = ctx.now ?? Date.now();
        promoted.push(note.id);
      }
      continue;
    }

    // 真正的反证（裁决六）：同一件事 + 立场相反 + 分量不许差太多。
    // 判立场，不判谓词——谓词只是说法，真模型完全可以用别的词表达反面。
    const heavyEnough = (c) => Number(c.weight ?? 0) >= (Number(note.weight ?? 0) * o.weightRatio);
    const against = same.filter((c) => sameTopic(c) && opposite(c) && heavyEnough(c));
    if (!against.length) continue;
    void contrary;

    const strong = against.filter((c) => c.weight >= o.strongWeight
      && c.weight >= (note.weight ?? 0) + o.strongMargin);
    const enough = fresh != null
      ? true
      : (against.length >= o.needOpposing || strong.length > 0) && witnessed;
    if (!enough) continue;

    const witness = strong[0] ?? against.reduce((a, b) => (b.weight > a.weight ? b : a));
    const detail = against.length >= o.needOpposing
      ? `${against.length} 条都是反着的，我这回不能装没看见`
      : '这一条重到压过了我原来的底气';

    note.was = {
      text: note.text,
      why: note.why,
      relation: note.relation,
      polarity: note.polarity,
      status: STATUS.HELD,
      at: note.createdAt,
    };
    transition(note, STATUS.ESTEEMED, {
      at: ctx.now ?? Date.now(),
      reason: detail,
      by: witness.text,
      kind: RETIRE_REASON.OVERTURNED,
    });
    retired.push(note.id);
    retiredBecause[note.id] = detail;
  }

  return { retired, retiredBecause, promoted };
}

/**
 * 外部要「拿我这次刚熔出来的那句，去核我以前的判断」，用这个入口：
 * memo = 这次刚熔出来的信念（它自己核自己不算数）。
 */
export function reconsider(notes, memo, ctx = {}) {
  return review(notes, memo, { ...ctx, memo });
}

export function createRevision(opts = {}) {
  return {
    review: (notes, evidence, ctx = {}) => review(notes, evidence, { ...ctx, opts: { ...opts, ...(ctx.opts ?? {}) } }),
    reconsider: (notes, memo, ctx = {}) => reconsider(notes, memo, { ...ctx, opts: { ...opts, ...(ctx.opts ?? {}) } }),
  };
}
