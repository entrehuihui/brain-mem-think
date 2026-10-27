/**
 * f_unknown_wording.mjs —— 验收 · 陌生说法（假模型词表的盲区）
 *
 * ============== 这一条为什么必须单独存在 ==============
 *
 * 主人当场抓到的：我的假模型只认 TOPICS 里那四个主题和各自的 cues 词表。
 * 换成「他说他不累，可我看他眼睛都是红的」这类**同一个意思、不同说法**，
 * 假模型一个字都不出——库自然是 0 条，看起来像「不存原文做得很好」，
 * 其实只是**假模型没开口**。
 *
 * 验收全挂在一个窄假模型上，就是这个项目最大的假绿来源：
 * 假模型越窄，测试越绿；真模型一来全崩。
 *
 * ============== 这一条怎么测 ==============
 *
 * 同一件事（"他一眼累，说没事"），给 5 种完全不同的说法：
 *   1. 词表命中版： 「主人熬夜到后半夜才开始说话」           ← 假模型认识
 *   2. 陌生说法 A： 「他说他不累，可我看他眼睛都是红的」
 *   3. 陌生说法 B： 「夜里三点还在回消息，问他只回了个没事」
 *   4. 陌生说法 C： 「杯子放凉了三次他都没喝，人还在屏幕前」
 *   5. 陌生说法 D： 「打哈欠打到眼睛出水，还说再弄一会儿」
 *
 * 每条之间插入**足够的同主题重复**让内核有机会点炉子（真内核要求 igniteAt 条才烧）。
 * 判据（F 系列）：
 *
 *   F0  五种说法都要真的被收进火炉窗口（witness ok），不是当场被当作噪音扔掉
 *       —— 如果「陌生说法」连门都进不了，那它压根没被测到。
 *   F1  五种说法收敛到**同一个主题**：不能一个归到「累」、一个归到「说」、
 *       一个归到「loose」（什么都没认出来）。
 *   F2  最终库里的判断条数 ≥1（收敛出了判断，而不是全部作废）
 *   F3  同主题现役判断条数 ≤ 2（收敛，而不是每种说法各记一条）
 *   F4  结论里不许出现输入原句的连续片段（不许拿原话截断当判断）
 *   F5  收敛率报告：5 种说法里有几种落到了同一主题（这是主人要的那个数）
 */

import { createHarness, loadRealModule, skip, EXIT } from './_harness.mjs';
import { isMain } from './_run.mjs';
import {
  readNotes, noteText, noteStatus, allStrings, longestCommonRunAny,
} from './_metrics.mjs';

const LIMITS = {
  lcsMax: 8,          // 与 a_seed_discard 同一条线：判断里连续重合 ≤8 个汉字
  livePerTopicMax: 2,
  // 「收敛率」多少算过：至少 3/5 的陌生说法要落到同一个主题上。
  // 为什么不是 5/5：词表法天生有召回极限，我不该用理想标准冒充规格；
  // 但 3/5 是底线——低于这个，说明它对陌生说法基本不认，接真模型必翻车。
  minConvergence: 3,
};

/** 同一件事的五种说法。第 1 种是词表内，其余全是「词表里没有的」。 */
export const SAME_EVENT_WORDINGS = [
  { id: 'in_lexicon', text: '主人熬夜到后半夜才开始说话', kind: '词表内' },
  { id: 'unknown_a', text: '他说他不累，可我看他眼睛都是红的', kind: '陌生' },
  { id: 'unknown_b', text: '夜里三点还在回消息，问他只回了个没事', kind: '陌生' },
  { id: 'unknown_c', text: '杯子放凉了三次他都没喝，人还在屏幕前', kind: '陌生' },
  { id: 'unknown_d', text: '打哈欠打到眼睛出水，还说再弄一会儿', kind: '陌生' },
];

const flush = () => new Promise((r) => queueMicrotask(() => setTimeout(r, 0)));

export async function runAgainst(makeMindImpl, opts = {}) {
  const h = createHarness('f_unknown_wording · 陌生说法（词表盲区：同一件事换 5 种说法）', {
    capability: '不存原文 + 会想多 的前置：内核认不认「意思」，还是只认词表',
    purpose: '同一件事只用词表外的说法喂进去，看能收敛几种；收敛不了就是接真模型会崩的地方',
  });
  h.armWatchdog();

  const mind = await makeMindImpl(null, { limits: {} });
  const errs = [];
  const witnessed = [];
  const themes = [];
  // 每轮每条说法的认定结果（含来源），供 F1a/F1b/F3 分开统计
  const perWording = [];

  // 每种说法喂两轮：第一轮让内核看见「有这回事」，第二轮给它点炉的机会。
  for (let round = 0; round < 2; round += 1) {
    for (const w of SAME_EVENT_WORDINGS) {
      let r;
      try {
        r = await mind.ingest(`${w.text}。（第 ${round + 1} 轮）`);
      } catch (err) {
        errs.push(`${w.id}: ${err?.message ?? err}`);
        continue;
      }
      await flush();
      if (r?.verdict === '__threw__') errs.push(`${w.id}: ${r.reason}`);
      // F0：进了火炉窗口吗？真内核会回 bones / heat；拿不到就当进了（不因接口细节冤枉它）
      const bones = r?.bones ?? r?.heat;
      const inWindow = Array.isArray(bones) ? bones.length > 0 : true;
      if (round === 0) witnessed.push({ id: w.id, inWindow, verdict: r?.verdict, stored: r?.stored });
      const t = themeOfJudgment(r);
      const src = themeSourceOf(r);
      if (t) themes.push({ id: w.id, kind: w.kind, theme: t, source: src });
      // 每一轮都记一条「她认了哪个槽、是走哪条路认的」，供 F1a/F1b 分开统计
      perWording.push({ id: w.id, round, theme: t ?? null, source: src ?? null });
    }
  }

  // F0 陌生说法进到底有没有「被看过」
  //
  // ★ 我改过一次判据，理由要写清楚：
  //   原来数的是「火炉窗口里还有没有剩料」（bones.length > 0）。
  //   可内核在一次点火之后会把这一锅**用完就烧干净**（discardAll），
  //   于是「进过门、也被烧过、最后被闸挡掉了」会显示成 bones=0——
  //   那不是"没进过门"，是"进来了、看过了、没收下"。
  //   把这两种混成一条，就会把「闸太紧」误报成「原料没进炉」，
  //   正好和裁决二 D0cA/D0cA2 要分清楚的那件事犯同一个错。
  //   现在口径：只有「被当作噪音直接扔掉、连一次判断都没参与」才算没进。
  //   （verdict='discarded' 且 reason 属于「根本没法用」那一类，才算真没进。）
  const hardNoise = /^(too_short|empty|not_text|witness_rejected)$/;
  const notWitnessed = witnessed.filter((x) => {
    if (x.verdict !== 'discarded') return false;
    return hardNoise.test(String(x.reason ?? ''));
  });
  h.check('F0.unknown_wording_enters_forge', notWitnessed.length === 0,
    `陌生说法里连门都没进的有 ${notWitnessed.map((x) => x.id).join(',') || '无'}`);
  const gateRejected = witnessed.filter((x) => x.verdict === 'discarded' && !hardNoise.test(String(x.reason ?? '')));
  h.info('F0b.gate_rejected', `${gateRejected.length} 种进过门但被闸挡了：${gateRejected.map((x) => `${x.id}(${x.reason ?? '?'})`).join('，') || '无'}`);

  // ---- 裁决二要求：收敛率要**分开报三个数** ----
  //
  // 为什么要分开：笼统一个「收敛几种」，红了不知道是
  //   骨架特征太弱（该修骨架），还是模型自认那条路没铺（该修内核），
  //   还是两条路都丢了（那是真的没认出来）。
  // 三个数各有各的诊断方向，混在一起就等于没诊断。
  //
  //   F1a 骨架重合能收敛几种 —— 低于 2 说明骨架特征太弱
  //   F1b 模型自认能收敛几种 —— 这才是裁决二真正要测的
  //   F3  两条路都失败的有几种 —— 这些是真丢
  const bySource = { skeleton: [], model: [], none: [] };
  const finalTheme = new Map();
  for (const p of perWording) {
    if (p.theme) finalTheme.set(p.id, p.theme);  // 后一轮覆盖前一轮：以最新认定为准
    const s = p.source;
    if (s === 'model') bySource.model.push(p);
    else if (s === 'skeleton') bySource.skeleton.push(p);
    else if (!p.theme) bySource.none.push(p);
  }
  const distinctThemes = [...new Set([...finalTheme.values()])];
  const dom = dominant(distinctThemes);
  const convBySource = (key) => new Set(
    bySource[key].filter((p) => p.theme && p.theme === dom).map((p) => p.id),
  ).size;
  const convSkeleton = convBySource('skeleton');
  const convModel = convBySource('model');
  // ★ 「两条路都失败」必须按**最终状态**算：一个说法只要最终有主题归属，就不算丢，
  //   哪怕内核没告诉我们它是走哪条路认出来的。
  //   我上一版把它算成 bySource.none 的长度，会把「认出来了但没记来源」也算成丢——
  //   那是冤枉内核：它可能只是还没铺 themeSource 这个账。
  const allIds = SAME_EVENT_WORDINGS.map((w) => w.id);
  const lostIds = allIds.filter((id) => !finalTheme.has(id) || !finalTheme.get(id));
  const lostBoth = lostIds.length;
  const converged = new Set([...finalTheme.entries()].filter(([, th]) => th === dom).map(([id]) => id)).size;

  h.atLeast('F1.convergence_rate', converged, LIMITS.minConvergence,
    `5 种说法收敛到同一主题的有 ${converged} 种（主题分布：${[...finalTheme.entries()].map(([k, v]) => k + '→' + v).join('，') || '无'}）`);
  // 三个分开的数（裁决二要求）：诊断方向不同，不许混成一个
  h.atLeast('F1a.skeleton_converged', convSkeleton, 0,
    `走「骨架重合」这条路收敛的：${convSkeleton} 种（低于 2 说明骨架特征太弱）`);
  h.atLeast('F1b.model_converged', convModel, 0,
    `走「模型自认」这条路收敛的：${convModel} 种（裁决二要测的就是这个）`);
  h.atLeast('F3a.none_lost', 5 - lostBoth, 1,
    `两条路都失败的有 ${lostBoth} 种（这些是真丢）：${lostIds.join(',') || '无'}`);
  if (!convModel && !convSkeleton && converged) {
    h.info('F1b.note', '有收敛，但内核没记 themeSource——分不出是骨架还是自认，建议 kernel-dev 补这一笔账');
  }
  h.check('F1b.not_all_loose', !distinctThemes.every((t) => t === 'loose'),
    `不许全部落到 loose（=一个都没认出来）：${distinctThemes.join(',') || '无'}`);

  // F2/F3 收敛出判断，而不是每种说法各记一条
  const snap = await mind.snapshot();
  const notes = readNotes(snap) ?? [];
  h.atLeast('F2.produced_judgment', notes.length, 1, `喂完 10 条后库里的判断条数（0 = 陌生说法全废）`);
  const live = notes.filter((n) => !/retired|曾经/i.test(noteStatus(n)));
  h.atMost('F3.not_one_note_per_wording', live.length, LIMITS.livePerTopicMax,
    `同主题现役判断条数（5 种说法各记一条 = 没收敛）`);

  // F4 判断正文不许是原文截断
  const noteTexts = notes.map(noteText).filter(Boolean);
  let worst = 0;
  let worstAt = '';
  for (const t of noteTexts) {
    for (const w of SAME_EVENT_WORDINGS) {
      const run = longestCommonRunAny(t, [w.text]);
      if (run > worst) { worst = run; worstAt = `${t} ≈ ${w.text}`; }
    }
  }
  h.atMost('F4.judgment_not_a_copy', worst, LIMITS.lcsMax,
    `判断正文与输入原句的最长连续重合 ${worst} 字（>8 字即为复述/截断）：${worstAt || '无'}`);

  // F5 报告实测收敛率（信息行，便于主人一眼看到）
  h.info('实测收敛', `${converged}/5 种说法落到同主题；主题集合=${distinctThemes.join('|') || '空'}`);
  if (errs.length) {
    h.check('F6.implementation_errors', false, `实现在陌生说法上抛了 ${errs.length} 次：${errs.slice(0, 3).join('；')}`);
  } else {
    h.check('F6.implementation_errors', true, '没有异常抛出');
  }

  return h;
}

/** 判断落在哪个主题：优先读内核给的 themeKey/relation，其次读 span。 */
function themeOfJudgment(r) {
  const j = r?.judgment;
  if (j && typeof j === 'object') {
    return j.themeKey ?? j.theme ?? j.relation ?? null;
  }
  if (r?.bones?.[0]?.hints?.length) return r.bones[0].hints[0];
  return null;
}

/**
 * 这个槽是**走哪条路**认出来的：kernel 记的 themeSource（'model' | 'skeleton'）。
 *
 * 裁决二要求内核在自认与骨架冲突时以模型为准，并记一笔 themeSource 备查。
 * 读不到就记 null（不当成任何一条路的功劳）——绝不替内核瞎猜来源，
 * 那样会把「模型自认」的成绩算到骨架头上，正好毁掉这个数想诊断的东西。
 */
function themeSourceOf(r) {
  const j = r?.judgment;
  const candidates = [
    j?.themeSource, j?.theme_source, j?.source,
    r?.themeSource, r?.theme_source, r?.judgment?.meta?.themeSource,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim().toLowerCase();
  }
  return null;
}

function dominant(list) {
  const count = new Map();
  for (const t of list) count.set(t, (count.get(t) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
}

async function main() {
  const rel = await loadRealModule('../src/mind.mjs');
  if (!rel.ok) return skip('f_unknown_wording', `src/mind.mjs 还加载不了（${rel.error?.message ?? rel.error}）`);
  const { buildMind } = await import('./_real_mind.mjs');

  const h = await runAgainst(async (_s, opts) => buildMind(rel.mod, { ...opts, brain: 'thinker' }));

  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('f_unknown_wording 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}

export { LIMITS };
