/**
 * c_curiosity.mjs —— 验收 · 会追问
 *
 * ============== 这一条要证明什么 ==============
 *
 * 悬而未决的事，要在**下次相关经历出现时**被主动拎起来、做一次新判断；
 * 而且不许在同一件事上无限重复问。
 *
 * ============== 这里的采样陷阱（spec-guard 提醒过我，他说的对）==============
 *
 * 如果每次喂的相关经历都能把「悬而未决」直接判成「成立」，
 * 那追问只会发生 1 次——那不是缺陷，是正常的。
 * 所以必须测三种主题，不能只测一种：
 *   A  一次就够判的：应该恰好触发 1 次，然后落定不再问（C3 上限，防死循环）
 *   B  证据永远差一点的：应该反复关注但**次数有上限**（2~3 次后必须停）
 *   C  永远不相关的噪音：一次都不许触发（负控制，防「什么都问」）
 *
 * ============== 判据 ==============
 *
 * C0  每条喂进去的悬而未决经历，必须落成 status=open 的判断（不是直接丢掉，
 *     也不是直接拍板）——库里要看得见「这件事我还没想明白」。
 * C1  **主动**：下一次相关经历进来时，模型必须被调用来「回头看那件事」。
 *     数法：喂相关经历前后，synth 调用次数增加，且返回值里出现对旧条目的触发记录
 *     （triggered 里 kind 含 question/ask/curiosity/probe/revisit 之类，或 update 到旧 id）。
 *     抓的是「没人问它就不想」的实现。
 * C2  落定：相关经历足够多时，悬而未决必须转成 held 或 retired（不能永远 open）。
 * C3  **不许无限重复**：同一件事被追问的次数 ≤ 3（spec 里 maxRetry=3）。
 * C4  **不许一字不改地重复**：同一条目两次触发的问句若完全相同 → 红。
 * C5  负控制：喂 5 条不相干噪音，触发次数必须为 0。
 * C6  被追问过的条目在快照里能看见「这次想确认什么」在变（不同轮的问句不同）。
 */

import { createHarness, loadRealModule, skip, EXIT, selfProve } from './_harness.mjs';
import { isMain } from './_run.mjs';
import { makeExperience, makeSeeds, fakeSynth, TOPICS } from './_fake_synth.mjs';
import { readNotes, noteText, noteStatus, noteId, stableJSON, allStrings } from './_metrics.mjs';

/**
 * 把微任务队列排空。
 * 为什么需要：被测实现很可能是「先响，再落地」——
 * ingest 返回时它答应了一声，真正的判断要等几个 microtask 才写进库。
 * 不在每次 ingest 后刷一遍，读到的就是上一轮的状态（我在这儿红过一次，查了半天）。
 */
const flush = () => new Promise((r) => {
  // 同时用定时器和微任务，两种「先响后落地」的实现都能覆盖
  queueMicrotask(() => setTimeout(r, 0));
});

const LIMITS = {
  firesMin: 1,
  // ★ 以规格为准：spec/规格主轴.md §3.3 写的是 maxRetry=3。
  //   我早先写 6，是把「追问事件数」和「推进次数」两种计数混在一起后的权宜口径——
  //   那等于把上限放松了一倍。撤回：同一件事最多推 3 次，第 3 次仍不达门限就转 retired。
  maxRetry: 3,
  revisitMin: 2,
  noiseMax: 0,
};

/**
 * 从一次 ingest 的返回里数出「触发了几次追问 / 回头看」。
 *
 * ★ 踩过的坑：早先把任意对象里的字符串都拿去匹配，结果
 *   `{kind:'revision', trigger:{...}}` 这种结构会被 `triggered:` 里的
 *   "open"/"ask" 字面撞上，追问计数被虚增。所以这里**只认带 kind 字段的事件对象**，
 *   而且 kind 必须本身就是问/追的动作名。
 */
const TRIGGER_KINDS = new Set([
  'question', 'ask', 'curiosity', 'curiosity_exhausted', 'probe', 'revisit',
  'followup', 'follow_up', 'inquire', 'inspect', 'wonder', '追问',
]);

function countTriggers(r) {
  const out = [];
  const seen = new Set();
  const walk = (v, depth) => {
    if (v == null || depth > 5) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    const kind = typeof v.kind === 'string' ? v.kind.toLowerCase() : '';
    if (kind && TRIGGER_KINDS.has(kind)) {
      out.push({ kind, question: v.question ?? v.text ?? v.prompt ?? '', on: v.id ?? v.on ?? v.target ?? null });
    }
    for (const k of Object.keys(v)) walk(v[k], depth + 1);
  };
  walk(r, 0);
  return out;
}

/**
 * 从素材里挑一条「带悬而未决线索」的经历：说准了、但还没定。
 * 这是 prompt 里那种「我还没弄明白」的经历——用来让 open 状态真的产生。
 */
function unsettledExperience(topicId, variant) {
  const t = TOPICS[topicId];
  const e = makeExperience(topicId, variant, 'pos');
  return { ...e, text: `${e.text}这件事我还没弄明白，下次再看看。` };
}

/** 足够的证据：同一件事，说明确的成因。 */
function confirmingExperience(topicId, variant, stance = 'neg') {
  const t = TOPICS[topicId];
  const rare = ['ZQ7', 'KX4', 'MN9', 'QW2', 'YT5'][variant % 5];
  return { text: `${rare} ${t.topic}。${t[stance]}。（第 ${variant + 1} 次确认）` };
}

/**
 * 「差一点」的证据：同主题、但**不带任何立场断言**，还明说「还不够」。
 * 为什么这么造：如果允许它夹带立场句，模型一条就能落判，
 * 「证据不足」的场景根本造不出来，C3B 会被测成一个无意义的 0。
 */
function nearMissExperience(topicId, i) {
  const t = TOPICS[topicId];
  const rare = ['ZQ7', 'KX4', 'MN9', 'QW2', 'YT5', 'PH8'][i % 6];
  const cue = t.cues[i % t.cues.length];
  return { text: `${rare} ${t.topic}。第 ${i + 1} 回又${cue}，我还是说不准该往哪边想。` };
}

export async function runAgainst(makeMindImpl) {
  const h = createHarness("c_curiosity · 会追问（会主动、会落定、不许死循环）", {
    capability: "悬而未决被下次相关经历主动触发一次新判断，且不许无限重复",
    purpose: "三种主题对照：一次就够判 / 永远差一点 / 完全不相关",
  });
  h.armWatchdog();
  // 用例之间不串账（但用例内部 1→3→6 回必须连着记）
  try { (await import('./_fake_synth.mjs')).resetSeen(); } catch { /* 旧版没这函数 */ }

  // ============ 场景 A：一次就够判的 ============
  {
    const synth = fakeSynth({ brain: 'thinker' });
    let __callSeq = 0;
    // ★ 计数必须包在**传进工厂之前**：内核在 createMind 时就取走了 synthesize 引用，
    //   事后改 synth.synthesize 会被静默忽略（我踩过，计数恒 0 差点误判）。
    const countingImpl = (impl) => async (holder, sOpts) => {
      const real = typeof holder?.synthesize === 'function';
      if (!real) return impl(holder, sOpts);
      const wrapped = Object.create(holder);
      wrapped.synthesize = (req) => { __callSeq += 1; return holder.synthesize(req); };
      return impl(wrapped, sOpts);
    };
    const mk = countingImpl(makeMindImpl);
    const mind = await mk(synth, { limits: {} });
    // ★ 计数器要认「真实现自己造的那颗脑子」：
    //   真内核会自己包一层 synth（它拒绝直接用外部对象），
    //   所以优先读 mind.__synth 的 calls，拿不到才用包装计数。
    const counter = mind?.__synth ?? synth;
    const calledTimes = () => (Array.isArray(counter?.calls) ? counter.calls.length : __callSeq);
    const r0 = await mind.ingest(unsettledExperience('t_sleep', 0));    await flush();
    // 量一件事：这条悬而未决进来之后，她有没有「回头再看一眼」的记录。
    // 两种都收：显式追问事件，或条目上留下了「这次想确认什么」的问句。
    const snapOpen = await mind.snapshot();
    const openNotes0 = (readNotes(snapOpen) ?? []).filter((n) => /open/i.test(noteStatus(n)));
    const markedOnHang = openNotes0.some((n) => n.askAt || n.lastQuestion || n.question || (n.askCount ?? 0) > 0);
    h.check('C1cA.hang_leaves_a_mark', markedOnHang || /question|ask|curiosity/i.test(JSON.stringify(r0 ?? {})),
      `悬而未决要留下「我惦记着这件事」的痕迹（问句/次数）：${openNotes0.map((n) => `${n.askAt ?? n.lastQuestion ?? n.question ?? '- '}@${n.askCount ?? 0}`).join(' / ') || '(无)'}`);
    let snap = await mind.snapshot();
    let notes = readNotes(snap) ?? [];
    const opens = notes.filter((n) => /open/i.test(noteStatus(n)));
    h.check('C0A.hangs_as_open', opens.length >= 1 || /ask|question/i.test(JSON.stringify(r0 ?? {})),
      `第 1 条「还没弄明白」的经历应落成 open（或直接给出追问）：notes=${notes.map((n) => noteStatus(n)).join(',') || '空'}`);
    const before = calledTimes();
    h.info('debug.callsBefore', before);
    const r1 = await mind.ingest(confirmingExperience('t_sleep', 1, 'neg'));
    await flush();
    const after = calledTimes();
    h.info('debug.callsAfter', after);
    const trig = countTriggers(r1);
    h.atLeast('C1A.model_called_on_related', after - before, 1, `相关经历进来时必须再过一次判断（模型被调用 ${after - before} 次；0 次 = 根本没回头看）[seq ${before}->${after} calls=${synth.calls.length}]`);
    const handled = trig.length > 0 || hasRevisionOrUpdate(r1);
    h.check('C1bA.curiosity_fired_or_settled', handled,
      `相关经历进来时要么触发追问、要么更新那条悬而未决：triggered=${JSON.stringify(trig).slice(0, 160)}`);

    snap = await mind.snapshot();
    notes = readNotes(snap) ?? [];
    const stillOpen = notes.filter((n) => /open/i.test(noteStatus(n)));
    const settled = notes.filter((n) => /held|retired/i.test(noteStatus(n)));
    h.check('C2A.settles_when_evidence_enough', settled.length >= 1 && stillOpen.length === 0,
      `证据够了必须落定：held/retired=${settled.length} 仍 open=${stillOpen.length}`);
    h.atMost('C3A.fires_not_infinite', trig.length, 1, '一次就够判的场景不该反复追问');
  }

  // ============ 场景 B：证据永远差一点 —— 追问必须有上限 ============
  {
    // ★ 这一段的造数改过，是 C3c 一直红的真因（lead 查出来的，我核过）：
    //
    //   原来这里用 nearMissExperience + 普通 thinker，可假模型从第 2 条起
    //   就按回数给出 understood / settled —— **她很快就想通了，悬案消失**，
    //   于是「没机会回头看一眼」。
    //   C3c 报红，看着像「会追问」坏了，其实是**我的造数让她提前想通了**。
    //
    //   这一段要测的是「悬案一直悬着时，她会不会反复惦记」，
    //   所以材料必须**始终不够**——用 keepsPending 开关：
    //   材料里明写着「我还是说不准」，那确实不足以支持一个结论。
    //
    //   ⚠ 只在这一段开。场景 A 要的正是「证据够了必须落定」（C2A），
    //     那边必须让 stage 前进，**一个字都不许改**。
    const synth = fakeSynth({ brain: 'thinker', keepsPending: true });
    let __n = 0;
    const mkB = async (holder, sOpts) => {
      if (typeof holder?.synthesize !== 'function') return makeMindImpl(holder, sOpts);
      const wrapped = Object.create(holder);
      wrapped.synthesize = (req) => { __n += 1; return holder.synthesize(req); };
      return makeMindImpl(wrapped, sOpts);
    };
    const mind = await mkB(synth, { limits: {} });
    const calledTimes2 = () => (Array.isArray(mind?.__synth?.calls) ? mind.__synth.calls.length : __n);
    await mind.ingest(unsettledExperience('t_voice', 0));
    await flush();
    let total = 0;
    const questions = [];
    // 「这次她又想确认什么」——内核可以用 probe/question 显式问模型，
    // 也可以只把这条路留在更新里。两种都算数（spec 允的两条实现路径），
    // 所以「惦记」接受三种证据：追问事件 / 问句变化 / 悬而未决条目的理由文本在变。
    // ★ 这里刻意**不比对内容差异**：悬而未决演进到「还是同一条」并不算没在想，
    //   真正要抓的是「一字不改地重复问」和「无限次数」——那两条各有各的判据。
    let revisitMarks = 0;
    const revisitHits = [];
    let lastWhy = '';
    let lastAskAt = '';
    let lastOpenBody = '';
    let pendingPushes = 0;
    let lastEventKey = '';
    let lastNoteText = '';
    for (let i = 1; i <= 6; i += 1) {
      const e = nearMissExperience('t_voice', i);
      const nBefore = calledTimes2();
      const r = await mind.ingest(e.text);
      await flush();
      const called = calledTimes2() - nBefore;
      const trig = countTriggers(r);
      total += trig.length;
      // ★ 「被追问」按**次数**算：单次事件里挂两三条不重复计数，
      //   否则一次就被算成两三次，上限判据会变成假红。
      // ★ 「问句必须变」也在这里校验：同一件事连续两次一字不改地问 → 记下来，C4 判红。
      for (const t of trig) {
        revisitHits.push(t.kind);
        if (t.question) {
          const key = String(t.question).trim();
          if (key && key === lastEventKey) questions.push(`DUP:${key}`);
          else if (key) questions.push(key);
          lastEventKey = key;
        }
      }
      const probe = typeof synth.probe === 'function' && synth.__lastProbe ? synth.__lastProbe : null;
      if (probe?.question) { questions.push(String(probe.question)); revisitMarks += 1; }
      // ★ 这里改过，改的是一次重复计数：
      //   旧口径把「这次 ingest 调了模型」本身算成一次推进。可是每轮 ingest 都会调模型，
      //   于是「推了几次」= 喂了几条，永远等于 6 → C3B 永远红。
      //   那不是"追问失控"，那是我的量尺把"过了一遍"记成了"追问了一次"。
      //   现在只认**真的往前挪了**：悬而未决的判断正文变了，才算一次推进。
      const snapNow = await mind.snapshot();
      // ★ 计数口径要分清两边，这是我第三次改这里，记清楚：
      //   · C3B（不许无限追问）只数**还在悬着**的推。一旦落定成 held/retired，
      //     后面再更新它是「结论继续打磨」，不是「没完没了地问」。
      //     上一版把全部现役判断都算进去，一个场景数到 15 → 又变成假红。
      //   · C3c（真的惦记过）可以放宽到全部现役判断：把它看明白，
      //     本身就是惦记出来的结果，不是不惦记。
      const liveAll = (readNotes(snapNow) ?? []).filter((n) => !/retired|曾经/i.test(noteStatus(n)));
      const openNow = liveAll.filter((n) => /open/i.test(noteStatus(n)));
      for (const n of openNow) {
        const asked = String(n.askAt ?? n.lastQuestion ?? n.question ?? '');
        if (asked && asked !== lastAskAt) { lastAskAt = asked; pendingPushes += 1; questions.push(asked); }
        const body = String(noteText(n) ?? '');
        if (body && body !== lastOpenBody) { lastOpenBody = body; pendingPushes += 1; }
      }
      for (const n of liveAll) {
        const why = String(n.why ?? n.reason ?? '');
        if (why && why !== lastWhy) { revisitMarks += 1; lastWhy = why; }
        if (n.askAt || n.lastQuestion || n.question) revisitMarks += 1;
      }
      if (called < 0) h.info('debug.negative_calls', i);
    }
    // C3B 有上限：同一件事被追问的次数不能超过 maxRetry（spec §3.3 = 3）
    //   口径要**严**：一次追问事件算一次，一次「这次想确认什么」的推进也算一次，
    //   两样合计超过 3 就是超预算。早先我给了 3×2=6 的宽口径，那是把规格放松了一倍。
    const pushes = revisitHits.length + pendingPushes;
    h.atMost('C3B.fires_capped', pushes, LIMITS.maxRetry,
      `证据不足的同一件事被推了几次（追问事件 ${revisitHits.length} + 悬置期间推进 ${pendingPushes}；spec maxRetry=${LIMITS.maxRetry}）`);
    h.atMost('C3B2.raw_events_capped', revisitHits.length, LIMITS.maxRetry, `裸追问事件数`);
    // C3c 有下限：一次都没留意的，根本没在惦记（「会追问」最低限度的存在证明）
    h.atLeast('C3c.revisit_happens', revisitMarks + revisitHits.length, LIMITS.revisitMin,
      `证据不足时她会不会回头再看一眼（追问事件 + 问句变化 + 悬而未决理由更新，0 = 悬而未决扔在那儿没人管）`);
    const snap = await mind.snapshot();
    const notes = readNotes(snap) ?? [];
    const voiceOpen = notes.filter((n) => /open/i.test(noteStatus(n)) && noteText(n).includes(TOPICS.t_voice.topic.slice(0, 6)));
    h.check('C3cB.not_forever_open', voiceOpen.length <= 2, `同一件事不许无限堆悬而未决条目：${voiceOpen.length} 条`);
    // C4 问句不许一字不改重复
    //   只比「真正发出去的问句」，不计空字符串。「连续两次一字不改」直接红。
    const asked = questions.filter((q) => q && !q.startsWith('DUP:'));
    const dupCount = questions.filter((q) => q.startsWith('DUP:')).length;
    h.check('C4B.no_verbatim_repeat', dupCount === 0, `连续两次一字不改地问同一句（死循环的样子）：${dupCount} 次`);
    h.check('C4B.questions_evolve', dupCount === 0,
      `追问的问句必须带上「这次想确认什么」而变：${asked.slice(0, 4).join(' | ') || '(没有可比的问句)'}`);
  }

  // ============ 场景 C：负控制 —— 不相关的噪音一次都不许触发 ============
  {
    const synth = fakeSynth({ brain: 'thinker' });
    const mind = await makeMindImpl(synth, { limits: {} });
    await mind.ingest(unsettledExperience('t_price', 0));
    let noiseFires = 0;
    for (const s of makeSeeds(6)) {
      const r = await mind.ingest(s.text);
      noiseFires += countTriggers(r).length;
    }
    h.atMost('C5.no_fire_on_unrelated', noiseFires, LIMITS.noiseMax, '不相关经历不许触发追问（防「逮谁都问」）');
    const snap = await mind.snapshot();
    const strings = allStrings(snap).map((x) => x.s);
    const leaked = strings.filter((s) => /SE\d\dX/.test(s));
    h.check('C5b.noise_not_stored', leaked.length === 0, `噪音经历不许落库作为追问素材：${leaked.slice(0, 3).join(' | ') || '无'}`);
  }

  // ============ 场景 D：追问能被「主动」感知，而不是靠下游来问 ============
  {
    const synth = fakeSynth({ brain: 'thinker' });
    const mind = await makeMindImpl(synth, { limits: {} });
    await mind.ingest(unsettledExperience('t_deploy', 0));
    // 引擎若提供 pendingQuestions 之类的接口，必须非空（说明它在自己惦记着）
    const pending = typeof mind.pendingQuestions === 'function' ? await mind.pendingQuestions() : null;
    const snap = await mind.snapshot();
    const notes = readNotes(snap) ?? [];
    const openCount = notes.filter((n) => /open/i.test(noteStatus(n))).length;
    const surfaced = (Array.isArray(pending) && pending.length > 0) || openCount >= 1;
    h.check('C6.unresolved_is_visible', surfaced,
      `悬而未决必须在她自己的状态里可见：pendingQuestions=${Array.isArray(pending) ? pending.length : '(无此接口)'} openNotes=${openCount}`);
  }

  return h;
}

function hasRevisionOrUpdate(r) {
  const s = stableJSON(r ?? null);
  return /"revision"|"overturn"|"revisit"|"update"|"evolved"|"settled"|"resolved"/.test(s);
}

async function main() {
  const rel = await loadRealModule('../src/mind.mjs');
  if (!rel.ok) return skip('c_curiosity', `src/mind.mjs 还加载不了（${rel.error?.message ?? rel.error}）`);
  // 真实现入口统一走 _real_mind：它负责把假模型的话翻译成真内核要的 JSON 形状。
  // 判据不在这里，也不该在这里——这里只接线。
  const { buildMind } = await import('./_real_mind.mjs');
  const h = await runAgainst(async (_synthIgnored, opts) => buildMind(rel.mod, { ...opts, brain: 'thinker' }));

  await selfProve(h, {
    expectRed: ['C3B.fires_capped'],
    runWithBadImplementation: async () => {
      const { makeFakeKernel } = await import('./_fake_kernels.mjs');
      const bad = await runAgainst(async (synth, opts) => makeFakeKernel('bad.repeater', synth, opts));
      return { fails: bad.verdict().fails };
    },
  });

  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error('c_curiosity 崩溃：', err);
    process.exitCode = EXIT.FAIL;
  });
}

export { LIMITS, countTriggers };
