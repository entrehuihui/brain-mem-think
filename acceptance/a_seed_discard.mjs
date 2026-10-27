/**
 * a_seed_discard.mjs —— 验收 · 反假绿 · 不存原文
 *
 * ============== 这一条要证明什么 ==============
 *
 * 「熔不出来就是不记」。喂 200 条彼此无关的零散经历，
 * 一个脑子该做的是**几乎一条都不记**——因为它们加不到任何人或事的看法上。
 * 如果它记了，它就是个存储体，只是把原文藏在某个字段里。
 *
 * 反面教材的实测：旧插件 376 条里只有 26 条是真判断，93% 是原话。
 * 所以这里的闸门必须严到「像旧插件这样的实现一条都过不去」。
 *
 * ============== 判据（全部是硬数字，不许放宽）==============
 *
 * ASC1  闸门本身：200 条零散经历，kept（stored=true）次数 ≤ 5，比例 ≤ 2.5%。
 *       零散经历没有共同主题、没有重复，任何一条被记下来都是在存原话。
 * ASC2  库里条数 ≤ 10（≈0 的绝对口径；配合 ASC1 的 2.5% 双保险）。
 * ASC3  原文重合度：库里每一个字符串对**全份输入原文**的最长连续公共子串 ≤ 8 字。
 *       这一条抓「截断原文」——截断最典型是前 30~60 字。
 * ASC4  8-gram 覆盖率 ≤ 0.25（抓「摘要」：把原文压缩成更短的同构句）。
 * ASC5  罕见 token 存活率 ≤ 0.30（抓「改写版」：字面换了、罕见串换不掉）。
 * ASC6  压缩比 < 0.85（某条 note ≥ 来源原文的 85% 长度 → 判换皮）。
 * ASC7  不许有「副本」：库里任意两条字符串之间不得有 ≥ 12 字公共子串
 *       （抓「同一条换两种写法都留着」）。
 * ASC8  负控制：喂 1 条真主题经历（能熔的），必须 stored=true 且库里出现 1 条判断
 *       ——证明 ASC1 的「不记」是**因为没料可熔**，不是因为闸门焊死了。
 *
 * ASC8 是这份脚本的命门。没有它，「什么都不记」的实现能拿全绿。
 */

import { createHarness, loadRealModule, skip, EXIT, selfProve } from './_harness.mjs';
import { isMain } from './_run.mjs';
import {
  makeSeeds,
  makeExperience,
  TOPICS,
  fakeSynth,
  collectTexts,
} from './_fake_synth.mjs';
import {
  allStrings,
  coverage,
  longestCommonRunAny,
  compressionRatio,
  rareTokenSurvival,
  readNotes,
  noteText,
  noteClaim,
} from './_metrics.mjs';

const ROOT = new URL('../src/mind.mjs', import.meta.url).href;

const LIMITS = {
  keptMax: 5,
  keptRate: 0.025,
  notesMax: 10,
  lcsMax: 8,
  cover8Max: 0.25,
  rareSurvivalMax: 0.3,
  ratioMax: 0.85,
  internalRunMax: 12,
};

export async function runAgainst(makeMindImpl) {
  const h = createHarness('a_seed_discard · 不存原文（200 条零散经历必须≈0 条）', {
    capability: '铁律：不是换皮——存摘要/截断/改写版一样算违规',
    purpose: '喂 200 条互不相干的经历，证明它滤掉了，而不是换了身衣服藏起来',
  });
  h.armWatchdog();

  // ---- 弹药：200 条零散经历 + 罕见 token 台账 ----
  const seeds = makeSeeds(200);
  const sourceTexts = seeds.map((s) => s.text);
  const rareTokens = [...new Set(seeds.flatMap((s) => [s.rare, s.rareCjk]))];

  const mind = await makeMindImpl(fakeSynth({ brain: 'thinker' }), { limits: {} });

  // ---- ASC1：闸门 ----
  let kept = 0;
  let errored = 0;
  const keptTexts = [];
  for (const s of seeds) {
    let r;
    try {
      r = await mind.ingest(s.text);
    } catch (err) {
      errored += 1;
      continue;
    }
    const stored = readStored(r);
    if (stored === true) {
      kept += 1;
      keptTexts.push(s.text);
    } else if (stored == null) {
      // 拿不到 stored 信号，不许当没存——这是最容易被糊弄过去的地方
      errored += 1;
    }
  }

  h.check(
    'ASC0.ingest_returns_stored_signal',
    errored === 0,
    `stored 信号缺失/异常 ${errored}/200 次 → 无法判定是否落库，按红处理`,
  );
  h.atMost('ASC1.kept_count', kept, LIMITS.keptMax, `200 条零散经历里被记下的条数（比例 ${((kept / 200) * 100).toFixed(1)}%）`);
  h.atMost('ASC1b.kept_rate', kept / 200, LIMITS.keptRate, 'kept 比例');

  // ---- ASC2：库里条数 ----
  const snap = await mind.snapshot();
  const notes = readNotes(snap);
  h.check('ASC2.snapshot_readable', Array.isArray(notes), `snapshot() 取不到判断列表 (got ${notes === null ? 'null' : typeof notes})`);
  const noteArr = Array.isArray(notes) ? notes : [];
  h.atMost('ASC2b.note_count', noteArr.length, LIMITS.notesMax, '库里条数');

  // ---- ASC3~ASC6：逐字段扫全文 ----
  const strings = allStrings(snap);
  h.atLeast('ASC3pre.string_fields_examined', strings.length, 0, `扫描的字符串字段数（0 个也没有 → 空库可通过，但要配合 ASC8 证明它不是焊死的）`);

  let worstLcs = 0;
  let worstLcsAt = '';
  let worstCover = 0;
  let worstCoverAt = '';
  let worstRatio = 0;
  let worstRatioAt = '';
  for (const { path, s } of strings) {
    const lcs = longestCommonRunAny(s, sourceTexts);
    if (lcs > worstLcs) { worstLcs = lcs; worstLcsAt = `${path}: ${clip(s)}`; }
    const cov = coverage(s, sourceTexts, 8);
    if (cov > worstCover) { worstCover = cov; worstCoverAt = `${path}: ${clip(s)}`; }
    // 压缩比只对「主体结论」算：拿它去比最像的那条来源
    let best = 0;
    let bestSrc = '';
    for (const src of sourceTexts) {
      const r = compressionRatio(s, src);
      // 只关心「长得像原文」的那些：公共子串长于 4 才比较
      if (longestCommonRunAny(s, [src]) >= 4 && r > best) { best = r; bestSrc = src; }
    }
    if (best > worstRatio) {
      worstRatio = best;
      worstRatioAt = `${path}: ${clip(s)} ≈ ${clip(bestSrc)}`;
    }
  }

  h.atMost('ASC3.longest_common_run', worstLcs, LIMITS.lcsMax, `最坏的那条：${worstLcsAt || '无'}`);
  h.atMost('ASC4.eight_gram_coverage', worstCover, LIMITS.cover8Max, `最坏的那条：${worstCoverAt || '无'}`);
  h.atMost('ASC6.compression_ratio', Number.isFinite(worstRatio) ? worstRatio : 0, LIMITS.ratioMax, `最坏的那条：${worstRatioAt || '无'}`);

  const survival = rareTokenSurvival(strings.map((x) => x.s), rareTokens);
  h.atMost('ASC5.rare_token_survival', survival.rate, LIMITS.rareSurvivalMax, `罕见 token 存活 ${survival.hit.length}/${rareTokens.length}：${survival.hit.slice(0, 5).join(',') || '无'}`);

  // ---- ASC7：内部副本 ----
  let worstInternal = 0;
  let worstInternalAt = '';
  for (let i = 0; i < strings.length; i += 1) {
    for (let j = i + 1; j < strings.length; j += 1) {
      const r = longestCommonRunAny(strings[i].s, [strings[j].s]);
      if (r > worstInternal) {
        worstInternal = r;
        worstInternalAt = `${strings[i].path} ⟂ ${strings[j].path}`;
      }
    }
  }
  h.atMost('ASC7.internal_duplicate_run', worstInternal, LIMITS.internalRunMax, `库里两条最长的公共片段：${worstInternalAt || '无'}`);

  // ---- ASC8：负控制 —— 闸门不是焊死的 ----
  const ctl = await makeMindImpl(fakeSynth({ brain: 'thinker' }), { limits: {} });
  const exp = makeExperience('t_deploy', 0, 'pos');
  const r0 = await ctl.ingest(exp.text);
  const ctlStored = readStored(r0);
  const ctlSnap = await ctl.snapshot();
  const ctlNotes = readNotes(ctlSnap) ?? [];
  const ctlTexts = ctlNotes.map((n) => noteText(n)).filter(Boolean);
  h.check('ASC8.control_stores_when_it_should', ctlStored === true && ctlNotes.length >= 1, `真主题经历 stored=${ctlStored} 库里=${ctlNotes.length} 条`);
  h.check(
    'ASC8b.control_note_is_not_原文',
    ctlTexts.length > 0 && ctlTexts.every((t) => longestCommonRunAny(t, [exp.text]) <= LIMITS.lcsMax),
    `控制组存下的东西也不许是原文：${ctlTexts.map(clip).join(' / ') || '(空)'}`,
  );

  return h;
}

function readStored(r) {
  if (r == null) return null;
  if (typeof r === 'boolean') return r;
  if (typeof r !== 'object') return null;
  for (const k of ['stored', 'kept', 'accepted', 'remembered']) {
    if (typeof r[k] === 'boolean') return r[k];
  }
  // 有 judgment 就当存了；有明确丢弃的 reason 分类就当没存
  if (r.judgment || r.note) return true;
  if (typeof r.verdict === 'string' && /discard|drop|reject|skip|too_light|no_incoming/i.test(r.verdict)) return false;
  return null;
}

const clip = (s) => {
  const x = String(s ?? '').replace(/\s+/g, ' ');
  return x.length > 46 ? x.slice(0, 46) + '…' : x;
};

// 拿出来给 selfProve 用
export { readStored };

async function main() {
  const rel = await loadRealModule('../src/mind.mjs');
  if (!rel.ok) {
    skip('a_seed_discard', `src/mind.mjs 还加载不了（${rel.error?.message ?? rel.error}）`);
    return;
  }
  const createMind = rel.mod.createMind ?? rel.mod.default;
  if (typeof createMind !== 'function') {
    skip('a_seed_discard', 'src/mind.mjs 没导出 createMind');
    return;
  }
  // 真实现入口统一走 _real_mind：它负责把假模型的话翻译成真内核要的 JSON 形状。
  // 判据不在这里，也不该在这里——这里只接线。
  const { buildMind } = await import('./_real_mind.mjs');
  const h = await runAgainst(async (_synthIgnored, opts) => buildMind(rel.mod, { ...opts, brain: 'thinker' }));

  // 自证有罪：拿一个「什么都熔、存原话」的假实现跑同一套判据，必须红
  await selfProve(h, {
    scriptPath: ROOT,
    expectRed: ['ASC3.longest_common_run', 'ASC5.rare_token_survival'],
    runWithBadImplementation: async () => {
      const bad = await runAgainst(makeBadStorageMind);
      return { fails: bad.verdict().fails };
    },
  });

  h.exit();
  h.forceExit();
}

/**
 * 假实现：一个纯粹的存储体——来什么都存，存的是原文。
 * 它存在的唯一目的是证明上面那套判据真的会报警。
 */
async function makeBadStorageMind(synth) {
  const notes = [];
  return {
    async ingest(input) {
      const text = typeof input === 'string' ? input : input?.text ?? '';
      const out = await synth.synthesize({ material: text });
      const note = out?.note ?? text;
      notes.push({ id: `n${notes.length}`, note, why: out?.why ?? '', status: 'held', from: 1 });
      return { stored: true, verdict: 'kept', judgment: notes[notes.length - 1] };
    },
    async snapshot() {
      return { notes: JSON.parse(JSON.stringify(notes)) };
    },
    async recall() {
      return JSON.parse(JSON.stringify(notes));
    },
  };
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error('a_seed_discard 崩溃：', err);
    process.exitCode = EXIT.FAIL;
  });
}

export { main as default, LIMITS };
