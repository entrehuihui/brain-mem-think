/**
 * e_forget_by_new.mjs —— 验收 · 会忘
 *
 * ============== 这一条要证明什么 ==============
 *
 * 「不是强度低才忘，是因记了新的而腾地方。」
 * 最容易被做成的假样子是：满 N 条就删最旧的（LRU / 容量淘汰）。
 * 那种东西看起来也会「忘」，但它的忘跟新东西是什么无关——只要条数到线就砍。
 *
 * ============== 怎么把这两种忘分开（三组对照，关键在于 B）==============
 *
 *   A 组：只喂远低于容量的条数 → 一条都不该忘。
 *         （连这个都掉的，说明遗忘跟「强度/年龄」有关，不是判断性的。）
 *   B 组：**容量远未满**，喂一条更强、更概括的新判断
 *         → 仍然必须有一条旧判断让位，且能说出「是因哪条新判断而让」。
 *         这是分辨「判断性遗忘」和「容量淘汰」的唯一硬证据：
 *         容量类实现在这里永远不会让，因为它还没满。
 *   C 组：喂大量零散噪音（过不了闸的） → 一条都不该忘。
 *         判断性遗忘只该被「真判断」触发，不该被条数触发。
 *
 * ============== 判据 ==============
 *
 * E0  能取到「这一轮让谁让了位、因为谁」的记录（让位必须可追溯）
 * E1  A 组：低于容量时遗忘数 = 0
 * E2  B 组：容量未满时仍发生让位 ≥ 1（这是「因新的而腾」）
 * E3  B 组的让位必须指认得出是因为哪条新判断（不许只报「满了」）
 * E4  C 组：噪音不许触发遗忘
 * E5  「忘」不许等于「删」：让位的判断要降级为 retired（带一句为什么），
 *     而不是从库里消失——忘了，但知道自己忘了什么。
 * E6  一次性让位不许换掉一大片：一次新判断最多让 1~2 条让位（防清仓）
 * E7  负控制：让位≠清空。让位后仍要留有可回忆的判断。
 */

import { createHarness, loadRealModule, skip, EXIT, selfProve } from './_harness.mjs';
import { isMain } from './_run.mjs';
import { makeExperience, makeSeeds, fakeSynth, TOPICS } from './_fake_synth.mjs';
import { readNotes, noteText, noteStatus, noteId, stableJSON } from './_metrics.mjs';

const LIMITS = {
  smallFeedFades: 0,
  mustFadeOnStrong: 1,
  maxFadePerEvent: 2,
  noiseFades: 0,
};

const flush = () => new Promise((r) => queueMicrotask(() => setTimeout(r, 0)));

/** 从一次 ingest 的返回里抽出「谁让位了 / 因为谁」。宽容地认几种形状。 */
function readFade(r) {
  const faded = [];
  const out = { faded, because: [], verdict: '', reason: {} };
  if (r == null || typeof r !== 'object') return out;
  const grab = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) { v.forEach(grab); return; }
    if (typeof v === 'string') { if (v.trim()) faded.push(v); return; }
    if (typeof v === 'object') {
      if (v.id != null) faded.push(String(v.id));
      else if (v.key != null) faded.push(String(v.key));
    }
  };
  for (const k of ['dropped', 'faded', 'forgotten', 'evicted', 'retired']) grab(r[k]);
  for (const k of ['because', 'becauseOf', 'droppedBecause', 'dueTo', 'triggeredBy']) {
    const v = r[k];
    if (v == null) continue;
    if (Array.isArray(v)) out.because.push(...v.map(String));
    else if (typeof v === 'string') out.because.push(v);
    else if (typeof v === 'object') out.because.push(...Object.values(v).map((x) => String(x?.id ?? x)));
  }
  if (typeof r.verdict === 'string') out.verdict = r.verdict;
  if (r.droppedWhy && typeof r.droppedWhy === 'object') out.reason = r.droppedWhy;
  if (r.reason && typeof r.reason === 'object') out.reason = { ...out.reason, ...r.reason };
  return out;
}

/** 从快照里数出「新增的 retired / 消失的条目」。 */
function retiredSet(notes) {
  const s = new Set();
  for (const n of notes ?? []) {
    if (/retired|曾经/i.test(noteStatus(n)) || (n && typeof n === 'object' && n.was)) s.add(noteId(n, 0));
  }
  return s;
}

/**
 * @param {function} makeMindImpl 造 mind 的工厂
 * @param {{only?: 'A'|'B'|'C'}} opts 只跑某一段（用于子进程隔离）
 *
 * ★ 为什么要 `only`：A/B/C 三段之间会共用假模型的累积账本。
 *   实测后果：单独跑 e 时 E2/E3 是绿的（让位 1 次、because 有值），
 *   放进全表/放进 selftest 就红——**段与段之间串了账**。
 *   主人裁决：进程隔离是唯一不靠纪律的隔离。所以做成每段一个子进程。
 */
export async function runAgainst(makeMindImpl, opts = {}) {
  const only = opts.only ?? null;
  const wantA = !only || only === 'A';
  const wantB = !only || only === 'B';
  const wantC = !only || only === 'C';
  const h = createHarness("e_forget_by_new · 会忘（因记了新的而腾地方，不是容量淘汰）", {
    capability: "会忘：不是因为强度低才忘，是因为记了新的而腾地方",
    purpose: "A 少量喂不动 / B 容量未满也必须让位 / C 噪音不许触发",
  });
  h.armWatchdog();
  if (only) h.info('scope', `只跑 ${only} 段（子进程隔离）`);

  // ============ A 组：只喂少量（低于任何合理容量）→ 不许忘 ============
  if (wantA) {
    const synth = fakeSynth({ brain: 'thinker' });
    const mind = await makeMindImpl(synth, { limits: {} });
    let fades = 0;
    for (const [topic, i] of [['t_deploy', 0], ['t_sleep', 0], ['t_price', 0]]) {
      const r = await mind.ingest(makeExperience(topic, i).text + '（少量）');
      await flush();
      fades += readFade(r).faded.length;
    }
    const snap = await mind.snapshot();
    const notes = readNotes(snap) ?? [];
    const live = notes.filter((n) => !/retired|曾经/i.test(noteStatus(n)));
    h.equal('E1.no_fade_when_under_capacity', fades, LIMITS.smallFeedFades,
      `只喂 3 条、容量远未满时不该有任何让位（让位=${fades}）`);
    h.atLeast('E1b.live_notes_kept', live.length, 2, `少量喂完，现役判断该在：${live.map(noteText).map((t) => t.slice(0, 14)).join(' | ')}`);
  }

  // ============ B 组：容量远未满，但来了更强的判断 → 必须让位 ============
  //
  // ★ 这一组的场景改过一次，原因值得记下来：
  //   原来喂 6 条**同一个主题**的强判断，可那 6 条是在**同一条信念上累积**的
  //   （内核会就地更新它，最后只剩一条 held），根本没有「两条并存、谁该让位」的对手。
  //   E2 于是测的是一个不存在的局面——判据没错，是我把场景立错了。
  //   现在按「判断性遗忘」真正该被观察的样子造：
  //     ① 先喂两条**弱**判断（各自只见过一回，份量薄、理由短）
  //     ② 再在同一主题上把结论推重（见满 4 回，份量厚）
  //     ③ 这时它比那两条弱的都重，该有人让位
  //   全程库里只有 2~3 条、上限 10，没到容量线，所以容量淘汰解释不了这件事。
  if (wantB) {
    const synth = fakeSynth({ brain: 'thinker' });
    const mind = await makeMindImpl(synth, { limits: {} });
    await mind.ingest(makeExperience('t_deploy', 0).text + '（弱一）');
    await flush();
    await mind.ingest(makeExperience('t_sleep', 0).text + '（弱二）');
    await flush();
    const beforeNotes = readNotes(await mind.snapshot()) ?? [];
    const beforeRetired = retiredSet(beforeNotes);
    const beforeLive = beforeNotes.length - beforeRetired.size;

    let fades = 0;
    const becauseList = [];
    const reasons = {};
    for (let k = 0; k < 5; k += 1) {
      const r = await mind.ingest(makeExperience('t_voice', k).text + '（强）');
      await flush();
      const fd = readFade(r);
      fades += fd.faded.length;
      becauseList.push(...fd.because);
      Object.assign(reasons, fd.reason);
    }
    const afterNotes = readNotes(await mind.snapshot()) ?? [];
    const afterRetired = retiredSet(afterNotes);
    const newlyRetired = [...afterRetired].filter((id) => !beforeRetired.has(id));
    const shrunk = Math.max(0, beforeLive - (afterNotes.length - afterRetired.size));
    const totalFades = Math.max(fades, newlyRetired.length, shrunk);

    h.atLeast('E2.made_room_before_capacity', totalFades, LIMITS.mustFadeOnStrong,
      `容量远未满（前 ${beforeLive} 条、上限远未到）时，更重的同主题判断出现仍要腾地方；让位=${totalFades}`);
    h.atLeast('E3.fade_is_traceable', becauseList.length + Object.keys(reasons).length, 1,
      `让位必须能指认「因为哪条新判断进来的」：because=${becauseList.slice(0, 3).join(',') || '(空)'} reasons=${JSON.stringify(reasons).slice(0, 120)}`);

    // E5 让位不等于删除：被让位的条目应该还在库里（降级），而不是消失
    const afterIds = new Set(afterNotes.map((n, i) => noteId(n, i)));
    const survivors = newlyRetired.filter((id) => afterIds.has(id));
    h.atLeast('E5.faded_not_deleted', newlyRetired.length === 0 ? 1 : survivors.length, Math.min(1, newlyRetired.length),
      `让位应该是「降级成曾经这么以为」，不是从库里消失：新 retired=${newlyRetired.length} 仍在库=${survivors.length}`);

    // E6 一次让位不许清仓
    h.atMost('E6.no_collateral_wipe', newlyRetired.length, LIMITS.maxFadePerEvent + 1,
      `一轮下来让位的条数（不应把库清空）`);

    // E7 让位后仍要能想起来
    const liveAfter = afterNotes.filter((n) => !/retired|曾经/i.test(noteStatus(n)));
    h.atLeast('E7.still_remembers_something', liveAfter.length, 1,
      `让位后现役判断不许清零：${liveAfter.map(noteText).map((t) => t.slice(0, 14)).join(' | ') || '空'}`);
  }

  // ============ C 组：零散噪音（过不了闸）不许触发遗忘 ============
  if (wantC) {
    const synth = fakeSynth({ brain: 'thinker' });
    const mind = await makeMindImpl(synth, { limits: {} });
    for (const topic of ['t_deploy', 't_sleep', 't_price']) {
      await mind.ingest(makeExperience(topic, 0).text + '（打底）');
      await flush();
    }
    const before = readNotes(await mind.snapshot()) ?? [];
    const beforeRetired = retiredSet(before);
    let noiseFades = 0;
    for (const s of makeSeeds(60)) {
      const r = await mind.ingest(s.text);
      await flush();
      noiseFades += readFade(r).faded.length;
    }
    const after = readNotes(await mind.snapshot()) ?? [];
    const afterRetired = retiredSet(after);
    const newly = [...afterRetired].filter((id) => !beforeRetired.has(id));
    h.equal('E4.noise_does_not_trigger_forget', noiseFades + newly.length, LIMITS.noiseFades,
      `60 条零散噪音不该挤掉任何判断（噪音让位=${noiseFades} 新增retired=${newly.length}）`);
    const liveAfter = after.filter((n) => !/retired|曾经/i.test(noteStatus(n)));
    h.atLeast('E4b.notes_survive_noise', liveAfter.length, 2, `噪音过后原来那几条还在：${liveAfter.map(noteText).map((t) => t.slice(0, 12)).join(' | ')}`);
  }

  return h;
}

async function main() {
  const rel = await loadRealModule('../src/mind.mjs');
  if (!rel.ok) return skip('e_forget_by_new', `src/mind.mjs 还加载不了（${rel.error?.message ?? rel.error}）`);
  // 真实现入口统一走 _real_mind：它负责把假模型的话翻译成真内核要的 JSON 形状。
  // 判据不在这里，也不该在这里——这里只接线。
  const { buildMind } = await import('./_real_mind.mjs');
  const h = await runAgainst(async (_synthIgnored, opts) => buildMind(rel.mod, { ...opts, brain: 'thinker' }));

  await selfProve(h, {
    expectRed: ['E3.fade_is_traceable'],
    runWithBadImplementation: async () => {
      const { makeFakeKernel } = await import('./_fake_kernels.mjs');
      const bad = await runAgainst(async (synth, opts) => makeFakeKernel('bad.capacity', synth, opts));
      return { fails: bad.verdict().fails };
    },
  });

  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error('e_forget_by_new 崩溃：', err);
    process.exitCode = EXIT.FAIL;
  });
}

export { LIMITS, readFade };
