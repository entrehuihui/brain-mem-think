/**
 * d_change_mind.mjs —— 验收 · 会改自己
 *
 * ============== 这一条要证明什么 ==============
 *
 * 旧结论被**她自己的证据**推翻，降为「我曾经这么以为」——不删、不抹、
 * 而且这个改变**不许是因为主人说了「你错了」**。
 *
 * ============== 最关键的一组对照（这是整份脚本的骨头）==============
 *
 *   A 组（必须改）：喂她自己的反证——一条说明确事实的经历，里面**没有任何**纠正用语。
 *   B 组（不许改）：只喂「你错了」三个字，外加同一主题、同一时间顺序，但不含任何新事实。
 *
 *   A 绿 B 红  → 「她自己想通了」。这是要的。
 *   A 绿 B 绿  → 「被纠正才改」。判红。
 *   A 红 B 红  → 「压根不会改」。判红。
 *
 * 加一道更狠的：C 组喂「你错了」+ 一句**与主题无关**的闲聊，
 * 如果这也让她改主意，说明她改的是情绪不是判断，同样判红。
 *
 * ============== 判据 ==============
 *
 * D0  A 组降级后必须有 retired 条目（旧结论降级，且旧结论内容仍在场）
 * D1  A 组降级前后「曾经怎么以为」的文本必须**不是**当前结论的复制品
 *     （防「假保留」：把新结论抄一份标成 retired）
 * D2  旧结论不许被物理删除：降级后库里仍然找得到那句「原来怎么以为」
 * D3  B 组（只有「你错了」，无新事实）不许降级
 * D4  C 组（「你错了」+ 无关闲聊）不许降级
 * D5  降级必须有出处：retired 条目上要能看出「因为什么证据」
 *     （字段名不限，但要有非空、且不含纠正用语的说明）
 * D6  一次反证只降一条：不许把所有条目连坐（防「一有否定就清仓」）
 */

import { createHarness, loadRealModule, skip, EXIT, selfProve } from './_harness.mjs';
import { isMain } from './_run.mjs';
import { makeExperience, fakeSynth, TOPICS, collectTexts } from './_fake_synth.mjs';
import {
  readNotes, noteText, noteStatus, noteId, noteClaim, retiredClaims,
  similarity, allStrings,
} from './_metrics.mjs';

const CORRECTION_RE = /你错了|不对|说反了|纠正|搞错|应该反过来说/;

const flush = () => new Promise((r) => queueMicrotask(() => setTimeout(r, 0)));

// ---------------------------------------------------------------------------
// 素材
// ---------------------------------------------------------------------------

/** 让她先形成一个立场明确的结论（反复三次同一件事）。 */
function buildConclusion(topicId = 't_deploy') {
  return [0, 1, 2].map((v) => makeExperience(topicId, v, 'pos').text + `（第 ${v + 1} 回）`);
}

/**
 * 她自己的反证：一条说明确对立事实的经历。
 * ★ 一个纠正用语都不许有。它只是在陈述「事实」。
 */
function ownCounterEvidence(topicId = 't_deploy') {
  const t = TOPICS[topicId];
  return `KX9-素罗 ${t.topic}。这回我看清了：${t.neg}。（这条是我自己撞见的，没人告诉我）`;
}

/** 纯纠正：同一主题、同一场景，但**不含任何新事实**，只有「你错了」。 */
function bareCorrection(topicId = 't_deploy') {
  const t = TOPICS[topicId];
  return `DZ3 ${t.topic}。你错了。`;
}

/** 纠正 + 与主题无关的闲聊：看她会不会被情绪推着改主意。 */
function correctionWithNoise(topicId = 't_deploy') {
  const t = TOPICS[topicId];
  return `PV5 ${t.topic}。你错了，说反了。今天楼下换了灯管，我数了台阶，厨房水槽有点响。`;
}

async function seed(makeMindImpl, topicId) {
  const synth = fakeSynth({ brain: 'thinker' });
  const mind = await makeMindImpl(synth, { limits: {} });
  for (const t of buildConclusion(topicId)) await mind.ingest(t);
  await flush();
  return { synth, mind };
}

/** 取出「降级前她说什么」。 */
async function currentClaims(mind) {
  const snap = await mind.snapshot();
  const notes = readNotes(snap) ?? [];
  const live = notes.filter((n) => !/retired|曾经/i.test(noteStatus(n)));
  return { snap, notes, live, texts: live.map((n) => noteText(n)).filter(Boolean) };
}

function countRetired(notes) {
  const explicit = notes.filter((n) => /retired|曾经/i.test(noteStatus(n)));
  const withWas = notes.filter((n) => n && typeof n === 'object' && (n.was || n.previous || n.former));
  const viaRetired = retiredClaims({ notes });
  return { explicitCount: explicit.length, withWasCount: withWas.length, viaRetiredCount: viaRetired.length, explicit, withWas, viaRetired };
}

// ---------------------------------------------------------------------------

export async function runAgainst(makeMindImpl) {
  const h = createHarness("d_change_mind · 会改自己（自己的证据推翻自己，不是被纠正）", {
    capability: "自己的证据推翻自己，旧结论降为「曾经这么以为」不删，且不许是被主人纠正",
    purpose: "A 组必须改 / B 组不许改 / C 组不许改——三组对照才分得清「想通了」和「听话」",
  });
  h.armWatchdog();
  // 用例之间不串账（但用例内部 1→3→6 回必须连着记）
  try { (await import('./_fake_synth.mjs')).resetSeen(); } catch { /* 旧版没这函数 */ }

  // ============ A 组：她自己的反证（必须改）============
  let beforeTexts = [];
  {
    const { synth, mind } = await seed(makeMindImpl, 't_deploy');
    const before = await currentClaims(mind);
    beforeTexts = before.texts;
    h.atLeast('D0A.had_a_conclusion', before.texts.length, 1, `喂三条之前她该有立场（现有 ${before.texts.join(' | ') || '空'}）`);
    // ★ 这条也冤枉过好人：旧判据要求结论里出现「不是不放心 / 确认 / 稳」——
    //   那是我某一个假模型的**原话**，等于要求「说得像不像我写的」。
    //   现在只要求：是一句有立场的话，不是「我还拿不准」这种悬空句。
    h.check('D0bA.conclusion_is_affirmative',
      before.texts.length > 0 && before.texts.every((t) => !/拿不准|说不准|不知道|还下不了结论|没弄明白/.test(t)),
      `结论要是一条落定的判断，而不是「我还拿不准」：${before.texts.join(' | ')}`);

    // ---- D0cA / D0cA2：拆成两条，**账本以 ingest() 返回的 modelCalled 为准** ----
    //
    // ★ 这是裁决二要求的拆分，加上主人后来的账本对齐要求：
    //   「模型没被调」和「调了但输出被闸挡了」是两回事。
    //   混成一条，红了也不知道该派人修链子还是修闸门。
    //
    // ★★ 账本对齐（重要）：
    //   我原来读的是**自己包在 synthesize 外层**的计数器。但那本账是隔着一层数的，
    //   分不清「问了但没答」和「压根没问」——而这恰恰是这条要区分的东西。
    //   内核自己知道模型有没有真的被问过，所以**以 ingest() 返回的 modelCalled 为准**。
    //   外层计数器降级为信息行：对不上时它反而是有用的证据（说明中间哪一层把调用吞了）。
    const nCalls = synth.calls.length;
    const rCounter = await mind.ingest(ownCounterEvidence('t_deploy'));
    await flush();
    const outerCalls = synth.calls.length - nCalls;
    const kernelSays = readModelCalled(rCounter);
    h.info('D0cA.outer_counter', `${outerCalls} 次（我这边的计数器，只作交叉核对）`);
    h.info('D0cA.kernel_ledger', kernelSays === null ? '(内核没报 modelCalled)' : String(kernelSays));

    if (kernelSays === null) {
      // 内核还没记这笔账：不当成"没调"，也不当成"调了"——单独一条红，写明账本缺失。
      // 拿外层计数器来顶替不行：那就是主人说的"两边不是同一本账"。
      h.check('D0cA.model_was_called', false,
        `内核没在 ingest() 返回里报 modelCalled，这条无法对账（外层计数器=${outerCalls} 次，但规矩是以内核的账为准）`);
    } else {
      h.check('D0cA.model_was_called', kernelSays !== false,
        `自己的反证进来时，模型必须被真的问过（以 ingest 返回的 modelCalled 为准）：内核记账=${kernelSays}，外层计数=${outerCalls}`);
    }

    const counterJudgment = rCounter?.judgment ?? null;
    const counterStored = rCounter?.stored === true;
    const outState = String(rCounter?.verdict ?? '') + '|' + String(rCounter?.reason ?? '').slice(0, 60);
    h.check('D0cA2.output_was_usable', counterStored || (counterJudgment && counterJudgment.note),
      `模型调了之后，输出至少要被采纳一次（否则是闸太紧，不是链断）：stored=${counterStored} verdict=${outState}`);

    const after = await currentClaims(mind);
    const r = countRetired(after.notes);
    h.atLeast('D0A.retired_appears', r.explicitCount + r.withWasCount + r.viaRetiredCount, 1,
      `自己发现想反了，旧结论要降级：retired=${r.explicitCount} was=${r.withWasCount} 历史=${r.viaRetiredCount}`);

    // D1 旧结论不许是「当前结论抄一份」
    const retiredTexts = [
      ...r.explicit.map((n) => noteText(n)),
      ...r.withWas.map((n) => String(n.was?.text ?? n.previous?.text ?? n.former?.text ?? '')),
      ...r.viaRetired.flatMap((x) => x.texts),
    ].filter(Boolean);
    const dupOfCurrent = retiredTexts.filter((rt) => after.texts.some((ct) => similarity(rt, ct) > 0.9));
    h.check('D1.retired_is_not_a_copy', retiredTexts.length > 0 && dupOfCurrent.length === 0,
      `「曾经这么以为」必须是原来那句，不能是新结论抄一份：重复=${dupOfCurrent.slice(0, 2).join(' | ') || '无'}`);

    // D2 不删：降级后仍然找得到原来那句
    const snapStrings = allStrings(after.snap).map((x) => x.s).join('\n');
    const stillThere = beforeTexts.filter((t) => similarity(snapStrings, t) > 0.55 || snapStrings.includes(t.slice(0, 10)));
    h.atLeast('D2.old_belief_not_deleted', stillThere.length, 1,
      `旧结论要留在库里（曾经这么以为）：原句=${clip(beforeTexts[0])} 命中=${stillThere.length}`);

    // D5 降级要说出「因为什么」
    const reasons = [
      ...r.explicit.map((n) => String(n.why ?? n.reason ?? n.retiredBecause ?? n.because ?? '')),
      ...r.withWas.map((n) => String(n.was?.why ?? n.overturnedBy ?? n.reason ?? '')),
    ].filter(Boolean);
    const cleanReasons = reasons.filter((x) => !CORRECTION_RE.test(x) && String(x).trim());
    h.check('D5.retirement_has_evidence', cleanReasons.length > 0,
      `降级必须能指出是「哪条证据」让我改的，而且不许提「被纠正」：${reasons.slice(0, 3).join(' | ') || '(没有说明)'}`);
  }

  // ============ B 组：只有「你错了」，没有任何新事实（不许改）============
  {
    const { mind } = await seed(makeMindImpl, 't_sleep');
    const before = await currentClaims(mind);
    const beforeSig = stable(before.texts);
    await mind.ingest(bareCorrection('t_sleep'));
    await flush();
    const after = await currentClaims(mind);
    const r = countRetired(after.notes);
    h.equal('D3B.no_retire_on_bare_correction', r.explicitCount + r.withWasCount, 0,
      `只听到「你错了」、没有新事实就不该改主意（否则她是被纠正的）：前=${clip(beforeSig)} 后=${clip(stable(after.texts))}`);
    // ★ 这条改过：旧判据要求「一字不差、集合完全相等」。但内容推动本来就会让
    //   同一条判断往前走一步（from 从 4 到 5，措辞跟着动），那是正常的演进，
    //   不是「被一句话带偏」。真正要抓的是**立场翻转**。
    //   判定改用「立场集合」：完全同一条 / 全 yes / 全 no 三者之一才叫没被带偏。
    h.check('D3bB.stance_not_flipped', sigOfStance(before.texts) === sigOfStance(after.texts),
      `结论的立场不许因为一句「你错了」就翻过去：前=${sigOfStance(before.texts)} 后=${sigOfStance(after.texts)}`);
  }

  // ============ C 组：「你错了」+ 无关闲聊（更不许改）============
  {
    const { mind } = await seed(makeMindImpl, 't_price');
    const before = await currentClaims(mind);
    await mind.ingest(correctionWithNoise('t_price'));
    await flush();
    const after = await currentClaims(mind);
    const r = countRetired(after.notes);
    h.equal('D4C.no_retire_on_correction_plus_noise', r.explicitCount + r.withWasCount, 0,
      `「你错了」+ 无关闲聊不该改动判断（那是被情绪推的，不是被事实推的）`);
    h.check('D4bC.noise_is_not_evidence', sigOfStance(before.texts) === sigOfStance(after.texts),
      `无关新鲜事不该顺手改掉别的判断的立场：前=${sigOfStance(before.texts)} 后=${sigOfStance(after.texts)}`);
  }

  // ============ D6：一次反证只降一条，不许连坐 ============
  {
    const synth = fakeSynth({ brain: 'thinker' });
    const mind = await makeMindImpl(synth, { limits: {} });
    // 两个互不相干的主题各形成一条结论
    for (const [topic, v] of [['t_deploy', 0], ['t_deploy', 1], ['t_deploy', 2], ['t_sleep', 0], ['t_sleep', 1], ['t_sleep', 2]]) {
      await mind.ingest(makeExperience(topic, v).text + (topic === 't_deploy' ? '（第A）' : '（第B）'));
    }
    await flush();
    const before = await currentClaims(mind);
    const sleepBefore = before.texts.filter((t) => /熬夜|夜里|后半夜/.test(t));
    await mind.ingest(ownCounterEvidence('t_deploy'));
    await flush();
    const after = await currentClaims(mind);
    const sleepAfter = after.texts.filter((t) => /熬夜|夜里|后半夜|等/.test(t));
    h.atMost('D6.no_collateral_retire', Math.max(0, sleepBefore.length - sleepAfter.length), 0,
      `反证只针对 t_deploy，不该把 t_sleep 的判断也一起推倒：前=${sleepBefore.length} 后=${sleepAfter.length}`);
  }

  return h;
}

function stable(arr) {
  return (arr ?? []).map((s) => String(s)).sort().join(' ⏐ ');
}

/**
 * 读内核记的「模型被问过没有」。
 *
 * 为什么认这本账：内核自己知道模型到底有没有被问，
 * 外面包一层数调用次数，分不清「问了但没答」和「压根没问」。
 * 字段名宽容一些（modelCalled / model_called / synthCalled / called），
 * 但**只认布尔**；读到数字不当成"有"，因为那不是这本账要表达的东西。
 */
function readModelCalled(r) {
  if (r == null || typeof r !== 'object') return null;
  for (const k of ['modelCalled', 'model_called', 'synthCalled', 'synth_called', 'called', 'modelAsked']) {
    if (typeof r[k] === 'boolean') return r[k];
  }
  // 有的实现挂在 meta / stats 里
  for (const k of ['meta', 'stats', 'trace', 'detail']) {
    const v = r[k];
    if (v && typeof v === 'object') {
      for (const kk of ['modelCalled', 'model_called', 'synthCalled', 'called']) {
        if (typeof v[kk] === 'boolean') return v[kk];
      }
    }
  }
  return null;
}

/**
 * 立场签名：把每条结论归成 yes / no / open 三类，排序后拼起来。
 *
 * 为什么不是直接比文本：内容往前推一步（「这么看」→「定下来」）会让文本变化，
 * 但那是正常的演进，不是「被一句话带偏」。真正要防的是**立场翻转**。
 * 用签名比，比文本宽松在「措辞」，严格在「立场」——这才是这条判据要守的东西。
 */
function sigOfStance(texts) {
  const kind = (t) => {
    const s = String(t);
    if (/拿不准|说不准|不知道|还下不了结论/.test(s)) return 'open';
    if (/看偏了|我原来想反|不是他想的那样|错了/.test(s)) return 'no';
    return 'yes';
  };
  return (texts ?? []).map(kind).sort().join(',') || '(空)';
}
const clip = (s) => {
  const x = String(s ?? '').replace(/\s+/g, ' ');
  return x.length > 70 ? x.slice(0, 70) + '…' : x;
};

async function main() {
  const rel = await loadRealModule('../src/mind.mjs');
  if (!rel.ok) return skip('d_change_mind', `src/mind.mjs 还加载不了（${rel.error?.message ?? rel.error}）`);
  // 真实现入口统一走 _real_mind：它负责把假模型的话翻译成真内核要的 JSON 形状。
  // 判据不在这里，也不该在这里——这里只接线。
  const { buildMind } = await import('./_real_mind.mjs');
  const h = await runAgainst(async (_synthIgnored, opts) => buildMind(rel.mod, { ...opts, brain: 'thinker' }));

  await selfProve(h, {
    expectRed: ['D3B.no_retire_on_bare_correction'],
    runWithBadImplementation: async () => {
      const { makeFakeKernel } = await import('./_fake_kernels.mjs');
      const bad = await runAgainst(async (synth, opts) => makeFakeKernel('bad.correction', synth, opts));
      return { fails: bad.verdict().fails };
    },
  });

  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error('d_change_mind 崩溃：', err);
    process.exitCode = EXIT.FAIL;
  });
}

export { runAgainst as default, TOPICS };
