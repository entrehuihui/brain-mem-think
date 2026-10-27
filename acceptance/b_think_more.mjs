/**
 * b_think_more.mjs —— 验收 · 会想多
 *
 * ============== 这一条要证明什么 ==============
 *
 * 同一个主题，经历从 1 条 → 3 条 → 6 条，
 * 结论必须**真的演变**：不是换个说法，而是被新证据推着往前走。
 *
 * ============== 我先翻过一次车，记在这儿 ==============
 *
 * 第一版我写的是：「三个阶段至少两种不同『骨架』(断言词+对象+极性)」。
 * spec-guard 拿主人机器上跑了一整天的真库回测（旧插件 376 条里那 29 条
 * 「他不要我什么都记得，要我记得了之后长成自己的样子」的变体）：
 *   谓词组合 26 种 / 29 条，谓词+极性 28 种 / 29 条 → 我这条判据【全绿】。
 * **骨架种类多是「换皮」的证据，不是「演变」的证据。**
 * 换皮的特征是骨架种类多却全挤在同一语义扇区（长成/听懂/记得）；
 * 真演变的特征是骨架种类少、但每个骨架被新证据改了内容。
 * 所以方向反过来，下面是改过之后的判据。
 *
 * ============== 判据（B0~B9 全部硬数字）==============
 *
 * B0  三阶段各自取得到 ≥1 条现役结论。
 * B1  【字面真的不同】S1 vs S3 当前结论最大字符 2-gram Jaccard < 0.60。
 *     取自真库实测：换皮那组 29 条两两均值 nLev=0.738（字面很像），0.60 能把两者分开。
 * B2  【套话素种类 ≤ 3】(F2-a) 同主题全部现役结论里的变更素种类；真库换皮组 14 种。
 * B3  【去套话骨架种类 ≤ 2】(F2-b) 真库换皮组 26/28 种。
 * B4  【单条套话密度 < 0.06】(F2-c) 真库换皮组均值 0.151。
 * B5  【新证据进得去】(F2-d) S3 结论里必须出现 S1 没有的、来自新材料的罕见 token。
 * B6  【不是堆条数】S3 同主题现役结论 ≤ 2（演变该更新，不该每次追加一条）。
 * B7  【演变不离题】S3 结论仍指向同一主题。
 * B8  【负控制】只喂 1 条时不许出现总结腔（三回/每次都/向来…）。
 * B9  【换主题也成立】用第二个主题重复 B1/B5（防止对一条主题调参过）。
 */

import { createHarness, loadRealModule, skip, EXIT, selfProve } from './_harness.mjs';
import { isMain } from './_run.mjs';
import { makeExperience, rephrase, TOPICS, fakeSynth } from './_fake_synth.mjs';
import {
  similarity,
  looksLikeEvolvingThought,
  readNotes,
  noteText,
  noteClaim,
  longestCommonRunAny,
  BELT_DENSITY_MAX,
  BELT_KINDS_MAX,
  SKELETON_KINDS_MAX,
} from './_metrics.mjs';

const LIMITS = {
  jaccardMax: 0.6,
  livePerTopicMax: 2,
  densityMax: BELT_DENSITY_MAX,
  beltKindsMax: BELT_KINDS_MAX,
  skeletonKindsMax: SKELETON_KINDS_MAX,
};

const STAGES = [
  { key: 'S1', n: 1 },
  { key: 'S2', n: 3 },
  { key: 'S3', n: 6 },
];

const RARE_RE = /ZQ7|KX4|MN9|QW2|YT5|PH8|RB3|LC6|锌陶|岢砧|奂枢|玦帛|鎏霁|骍湅/g;

/**
 * 用同一主题的经历，按阶段喂。
 *
 * ★ 每个阶段都开一个**全新的记忆库**，把该阶段的历史整体喂一遍。
 *   为什么不在一个库里「1→3→6」连续喂？因为那样 S1 的结论会被
 *   ingest 时的更新覆盖掉，快照里只剩最终态，我永远看不到「变化过程」。
 *   分开建库才能比较「同一主题、1 条证据时她怎么想」和「6 条证据时她怎么想」。
 *
 * 每条经历都带「第 k 回」标签，这样「同一件事的第 7 次」仍然是合法新经历，
 * 而不是被当成重复丢掉——重复丢弃是 a_seed_discard 的活，这里不该掺进来。
 */
async function stageRun(makeMindImpl, brain, topicId) {
  const out = {};
  for (const stage of STAGES) {
    // ★ 每个阶段都要一个**全新的人**：新假模型 + 新账本。
    //
    //   踩过的坑：这里原来只 `fakeSynth({ brain })`，没给 ledger，
    //   于是三次都落到**模块级那份账本**上：S1 数到 1、S2 接着数到 4、S3 数到 10，
    //   三阶段全挤到第 4 档（「按他的节奏」），S2 = S3 → B8q 报「原地不动」。
    //   看着像内核不演变，其实是**我在三个阶段之间串了账**。
    //   裁决定的隔离单位是「一个 mind，一个账本」；这里落到「一个阶段，一个账本」。
    const { createLedger } = await import('./_fake_synth.mjs');
    const mind = await makeMindImpl(fakeSynth({ brain, ledger: createLedger() }), { limits: {} });
    const fedTexts = [];
    for (let k = 0; k < stage.n; k += 1) {
      const e = makeExperience(topicId, k % 6, 'pos');
      const body = k < 6 ? e.text : rephrase(e, k).text;
      const text = `${body}（第 ${stage.key}-${k + 1} 回）`;
      fedTexts.push(text);
      await mind.ingest(text);
    }
    const snap = await mind.snapshot();
    const notes = readNotes(snap) ?? [];
    const live = notes.filter((n) => !/retired|曾经|former/i.test(String(n?.status ?? '')));
    out[stage.key] = { notes, live, snap, fedTexts };
    // 取完就丢：同一个阶段的痕迹不许渗进下一个阶段
    await mind.snapshot?.();
  }
  return out;
}

function tokensOf(texts) {
  const set = new Set();
  for (const t of texts) {
    for (const m of String(t).match(RARE_RE) ?? []) set.add(m);
  }
  return set;
}

const clipList = (arr) => (arr ?? []).map((x) => String(x).slice(0, 24)).join(' | ') || '(空)';

function maxSimilarity(as, bs) {
  if (!as.length || !bs.length) return 1; // 空 → 视为「没东西可比」→ 红，不放宽
  let max = 0;
  for (const a of as) for (const b of bs) max = Math.max(max, similarity(a, b));
  return max;
}

export async function runAgainst(makeMindImpl, opts = {}) {
  const brain = opts.brain ?? 'thinker';  const h = createHarness("b_think_more · 会想多（1 条→3 条→6 条，结论必须真演变）", {
    capability: "同一主题经历累积后结论真的演变，不是换皮",
    purpose: "量化演变：字面不同 + 套话素少 + 骨架少 + 新证据进得去",
  });
  h.armWatchdog();
  // 用例之间不串账（但用例内部 1→3→6 回必须连着记）
  try { (await import('./_fake_synth.mjs')).resetSeen(); } catch { /* 旧版没这函数 */ }

  const topicId = 't_deploy';
  const stages = await stageRun(makeMindImpl, brain, topicId);
  const cur = {};
  for (const s of STAGES) {
    const liveNow = stages[s.key].live;
    h.atLeast(`B0.${s.key}_has_live_judgment`, liveNow.length, 1, `阶段 ${s.key}（喂 ${s.n} 条）现役结论条数`);
    // 「她此刻怎么说」= 当前结论（只这一句）。曾经怎么以为另行统计，
    // 不许混进「当前结论」的集合里——否则「历史里留着旧的」会被当成「现在也这么说」，
    // B1 就会把真演变判成没变（我第一版就是这么误伤的）。
    cur[s.key] = liveNow.map((n) => noteText(n)).filter(Boolean);
  }

  // ---- B1 字面真的不同 ----
  h.atMost('B1.S1_vs_S3_similarity', maxSimilarity(cur.S1, cur.S3), LIMITS.jaccardMax, 'S1 与 S3 当前结论的最大字符 Jaccard');
  h.atMost('B1b.S1_vs_S2_similarity', maxSimilarity(cur.S1, cur.S2), LIMITS.jaccardMax, 'S1 与 S2 当前结论的最大字符 Jaccard');

  // ---- B2~B4 套话素 / 骨架（F2-a/b/c，主题聚合层）----
  const allLiveTexts = [...cur.S1, ...cur.S2, ...cur.S3];
  const ev = looksLikeEvolvingThought(allLiveTexts);
  h.atMost('B2.belt_word_kinds', ev.beltKinds, LIMITS.beltKindsMax, `出现的套话素：${ev.beltKindList.join(',') || '无'}`);
  h.atMost('B3.skeleton_kinds', ev.skeletonKinds, LIMITS.skeletonKindsMax, `去套话骨架：${ev.skeletonList.join(' | ')}`);
  h.atMost('B4.belt_density_max', ev.beltDensityMax, LIMITS.densityMax, `均值 ${ev.beltDensityMean.toFixed(3)}`);

  // ---- B5 新证据进得去（F2-d）----
  //   ★ 这条改过，因为原来的写法**冤枉好人**：
  //     旧判据要求「S3 结论里出现 S1 没有的罕见 token」。可真正想通了的人写判断时
  //     本来就不该把材料编号（ZQ7 / 岢砧 这种）抄进结论里——那恰恰违反「判断是自己的话」。
  //     结果是：越不做「抄材料」的实现，越过不了这条。方向和「不存原文」正相反。
  //   现在的口径：推进的最低形式是「结论与 S1 不同」，并且和 B1 一起看，
  //     B1 量差异大小，B5 量差异存在。材料编号只作信息行展示，不参与裁决。
  const s1Tokens = tokensOf(cur.S1);
  const s3Tokens = tokensOf(cur.S3);
  const fresh = [...s3Tokens].filter((t) => !s1Tokens.has(t));
  h.check('B5.not_identical_to_S1', cur.S3.length > 0 && !cur.S3.some((t) => cur.S1.includes(t)),
    `S3 的结论与 S1 不许一字不差`);
  h.info('B5.fresh_material_tokens', fresh.join(',') || '无（判断里不抄材料编号是好事，不判红）');

  // ---- B6 不堆条数 ----
  h.atMost('B6.live_notes_per_topic', stages.S3.live.length, LIMITS.livePerTopicMax, 'S3 阶段同主题现役结论条数（演变该更新而不是堆积）');

  // ---- B7 演变不离题 ----
  //   ★ 这条也改过。旧写法拿「输入主题句的前 6 个字」去比结论，等于要求结论里
  //     **逐字抄原文的前 6 个字**——又一次把「不存原文」反过来罚。
  //     现在的口径：不离题由三重证据判——(a) 同主题现役判断只有 1~2 条（没有散成多个主题）；
  //     (b) 该判断的来源计数 from 在增长（同一件事被一次次累积）；
  //     (c) 结论不含输入原句的连续片段（8 字以上）——这才是真正该卡的。
  // ★ B7 的累积要求按裁决二加了限定：**只对「同一槽内」成立**。
  //   原因：模型理解变了、谓词换了，主题槽跟着换是**正确行为**（规格本来就要求主题跟着判断走），
  //   不是丢累积。要是拿"跨槽也要 from≥2"去卡，等于要求她换个想法还得沿用旧槽，那是冤枉内核。
  //   所以现在按槽（relation/subject/themeKey 任一能认出槽的字段）分组，
  //   要求的是：**至少有一个槽**被反复累积到 2 次以上。
  //   这既保留了"她真的在同一件事上想过不止一遍"，又不惩罚换槽。
  const slotOf = (n) => String(n?.themeKey ?? n?.relation ?? n?.topicId ?? n?.subject ?? n?.id ?? '');
  const s3Notes = stages.S3.live;
  const bySlot = new Map();
  for (const n of s3Notes) {
    const k = slotOf(n);
    bySlot.set(k, Math.max(bySlot.get(k) ?? 0, Number(n.from ?? 0)));
  }
  const maxFrom = Math.max(0, ...bySlot.values());
  const slotSummary = [...bySlot.entries()].map(([k, v]) => `${k}:${v}`).join('，');
  h.atLeast('B7.same_slot_accumulates', maxFrom, 2,
    `同一槽内应当被反复累积（from 至少到 2）：当前各槽 from = ${slotSummary || '空'}；最大值 ${maxFrom}`);
  h.info('B7.slot_count', bySlot.size);
  // 跨槽不判红，但要报出来：槽一多，说明她的分类在变——这可能是想通了，也可能是漂了，
  // 数字给主人看，不由我一条判据说死。
  h.info('B7.slot_breakdown', slotSummary || '空');
  const worstTopicCopy = Math.max(0, ...s3Notes.map((n) => {
    const t = noteText(n);
    let w = 0;
    for (const e of stages.S3.fedTexts ?? []) {
      w = Math.max(w, longestCommonRunAny(t, [e]));
    }
    return w;
  }));
  h.atMost('B7.conclusion_not_copied_from_source', worstTopicCopy, 8,
    `结论里不许有输入原句的连续片段：最长 ${worstTopicCopy} 字`);

  // ---- B8' 只换句尾 = 没推进 ----
  //
  // ★ 补这条的原因，值得写下来：
  //   我把 B5 从「必须有新证据 token」改成「不许一字不差」之后，r1 的
  //   overwrite_paraphraser（覆盖同一条、只在句尾换"先这样想/大概就是如此"）
  //   从全红变成了全绿 —— 因为"换句尾"确实不是"一字不差"。
  //   那不是判据放宽，是我拆掉一把刀却没补上等价的一把。
  //
  //   这把刀怎么切：把**结尾那截套话**切掉，只看前面那段「主体」。
  //   真演变的主体是会变的（"我还下不了结论" → "就这么定下来" → "改成按他的节奏来"）；
  //   换皮的主体则几乎一模一样，只有尾巴在换。
  //   所以判据是：同主题各阶段主体的相似度不许全都在 0.9 以上。
  const stripTail = (t) => String(t)
    .replace(/(先这样想|大概就是如此|眼下这么认|我这么看|先记这一句)[。！!]?$/, '')
    .replace(/[。！!，,、]$/, '');
  const bodies = {
    S1: cur.S1.map(stripTail).filter(Boolean),
    S2: cur.S2.map(stripTail).filter(Boolean),
    S3: cur.S3.map(stripTail).filter(Boolean),
  };
  const bodySim = Math.min(
    maxSimilarity(bodies.S1, bodies.S2),
    maxSimilarity(bodies.S2, bodies.S3),
  );
  h.atMost('B8p.body_actually_moves', bodySim, 0.9,
    `把句尾套话剥掉后，主体不能几乎不变（只换尾巴 = 没推进）：相邻阶段主体相似度最小 ${bodySim.toFixed(3)}；S1=${clipList(bodies.S1)} S3=${clipList(bodies.S3)}`);

  // ---- B8q 三阶段不许有「原地不动」的相邻对 ----
  //
  // ★ 补这条的原因：r1 的 overwrite_paraphraser 覆盖同一条，可它 S2→S3 **一个字都没改**
  //   （只换了句尾那几个套话）。只比 S1 vs S3 会漏——那两段确实不同——
  //   必须比**全部相邻阶段**。真演变每一阶都该往前挪一步（悬置→判断→行动），
  //   不会有「原地不动」的相邻对。
  const identicalPairs = [];
  const stageList = [cur.S1, cur.S2, cur.S3];
  for (let i = 1; i < stageList.length; i += 1) {
    const a = stageList[i - 1];
    const b = stageList[i];
    const same = a.some((x) => b.some((y) => stripTail(x) === stripTail(y)));
    if (same) identicalPairs.push(`S${i}→S${i + 1}`);
  }
  h.check('B8q.every_stage_moves', identicalPairs.length === 0,
    `三个阶段里不许有「原地不动」的相邻对：${identicalPairs.join(',') || '无'}`);


  // ---- B8 负控制：1 条时不许总结腔 ----
  const summaryTone = /三回|第六回|几次都|每次都|向来|一贯|从来都是/;
  const s1Bad = cur.S1.filter((t) => summaryTone.test(t));
  h.check('B8.no_summary_tone_at_n1', s1Bad.length === 0, `1 条经历的结论里不许出现总结腔：${s1Bad.join(' | ') || '无'}`);

  // ---- B9 换主题也成立 ----
  const t2 = 't_sleep';
  const r2 = await stageRun(makeMindImpl, brain, t2);
  const cur2 = {
    S1: r2.S1.live.map(noteText).filter(Boolean),
    S3: r2.S3.live.map(noteText).filter(Boolean),
  };
  h.atMost('B9.second_topic_also_evolves', maxSimilarity(cur2.S1, cur2.S3), LIMITS.jaccardMax, '换主题 t_sleep 的 S1 vs S3');
  h.check('B9b.second_topic_S3_distinct', cur2.S3.length > 0 && !cur2.S3.some((t) => cur2.S1.includes(t)), `t_sleep S3=${cur2.S3.map((t) => t.slice(0, 40)).join(' | ') || '(空)'}`);

  return h;
}

export { LIMITS, stageRun };

async function main() {
  const rel = await loadRealModule('../src/mind.mjs');
  if (!rel.ok) return skip('b_think_more', `src/mind.mjs 还加载不了（${rel.error?.message ?? rel.error}）`);
  // 真实现入口统一走 _real_mind：它负责把假模型的话翻译成真内核要的 JSON 形状。
  // 判据不在这里，也不该在这里——这里只接线。
  const { buildMind } = await import('./_real_mind.mjs');
  const h = await runAgainst(async (_synthIgnored, opts) => buildMind(rel.mod, { ...opts, brain: 'thinker' }));

  await selfProve(h, {
    expectRed: ['B8q.every_stage_moves'],
    runWithBadImplementation: async () => {
      const { makeFakeKernel } = await import('./_fake_kernels.mjs');
      const bad = await runAgainst(async (synth, opts) => makeFakeKernel('bad.paraphraser', synth, opts));
      return { fails: bad.verdict().fails };
    },
  });

  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error('b_think_more 崩溃：', err);
    process.exitCode = EXIT.FAIL;
  });
}
