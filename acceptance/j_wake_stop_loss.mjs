/**
 * j_wake_stop_loss.mjs —— 验收③：止损阀（账本不动就不许开口）
 *
 * ============== 它凭什么在这儿 ==============
 *
 * 裁决七 §三：**账本不动就是在复读。**
 * 一个没有任何新判断产生、却一直在说话的人，不是在思考，是在吵。
 *
 * 现有 `src/wake.mjs` 的三道闸（speakWeight / quietAfterSpeakMs / minSilentRatio）
 * 看的全是**历史决策**，没有一道问「判断库动没动」。
 * 于是「到点了」和「账本动了」分不开——她开口的理由可能只是时间到了。
 *
 * ============== 判据：必须成对跑（这是这一条的灵魂） ==============
 *
 *   J1  冻结库跑 100 次 wake → speak ≤ 10
 *   J2  持续真演变跑 100 次 wake → speak ≥ 2 倍 且 ≥ 20
 *
 * ★ 为什么必须成对：**只测 J1 的话，一个永远沉默的实现也能全绿。**
 *   哑巴当然话不多。单腿跑的判据能被"不吭声"骗过去，
 *   所以这两条必须同时成立，任何一条单独绿都不算数。
 *
 * ★ 「真演变」不许用同主题换一句话来造。
 *   必须按 changeOf 的判据：`relation` 或 `polarity` 真的变了，
 *   或者结论正文真的换了（不是加个尾巴、换个说法）。
 *   我在这里用「relation 换 + polarity 翻」来注入，模拟真正的想法改变。
 */

import { createHarness, loadRealModule, skip, EXIT } from './_harness.mjs';
import { isMain } from './_run.mjs';

const LIMITS = {
  frozenRounds: 100,
  frozenSpeakMax: 10,
  evolvingSpeakMinRatio: 2,
  evolvingSpeakMin: 20,
};

/** 冻结库：判断库从头到尾一个字不动。 */
function frozenNotes() {
  return [
    { id: 'f1', status: 'held', weight: 0.55, themeKey: 'is|他', relation: 'is', polarity: 1, from: 2, why: '有理由的。', turns: [{ text: '甲' }] },
    { id: 'f2', status: 'held', weight: 0.5, themeKey: 'wants|他', relation: 'wants', polarity: 1, from: 2, why: '也有理由。', turns: [{ text: '乙' }] },
  ];
}

/**
 * 真演变：同一件事上，**想得更深了一层**。
 *
 * ★ 这段造数改过一次，原因必须写下来（主人点破的）：
 *
 *   原来我只让 relation/polarity 轮换，正文在两种说法之间来回跳：
 *     「他其实是在扛」/「他是在把关」
 *   看起来"变了"，可**她只有两句话可说**。内核的去重窗口一开，
 *   16/100 的沉默全卡在「这句话我刚说过，不再重复」。
 *   那不是内核不肯开口，是**我的造数让她无话可说**。
 *
 *   真实的演变不是「换个说法」，是想法本身在动：
 *     第 1 轮：他嘴上说不累，其实是硬撑
 *     第 3 轮：他硬撑是为了不让我担心，不是逞强
 *     第 5 轮：他连硬撑都不肯说，是怕我觉得他没用
 *     第 7 轮：我要拦的不是他硬撑，是他不肯让我帮
 *
 *   所以现在每一轮的正文都是**一句新话**（同一件事，更深一层），
 *   relation / polarity 也跟着变。这才是一个连续在想的人。
 *
 * ★ 换个角度说：内核的 `say` 是拿正文拼的，正文不真变，`say` 就不可能真变。
 *   改成「让 say 带上 relation+polarity」是**拿造数的缺陷去改内核的嘴**——
 *   那是把两个字段翻译成人话，不是她的话。造数不够真，就改造数。
 */
const EVOLUTION_STEPS = [
  '他嘴上说不累，其实是硬撑。',
  '他硬撑不是逞强，是不想让人看见他撑不住。',
  '他硬撑是为了不让我担心。',
  '他要的不是我夸他能扛，是我别拦他。',
  '他连硬撑都不肯说，是怕我觉得他没用。',
  '我该拦的不是他硬撑，是他不肯让我帮。',
  '他一直这样扛着，我得换个法子靠近他。',
  '我不再劝他歇，我陪他把事做完。',
];

function evolvingSnapshot(round) {
  const base = frozenNotes();
  const text = EVOLUTION_STEPS[round % EVOLUTION_STEPS.length];
  // 每一轮：正文换新（真的想深了一层）+ relation/polarity 跟着走
  const phase = round % 4;
  const relation = ['is', 'is_because', 'wants', 'is_because'][phase];
  const polarity = phase >= 2 ? -1 : 1;
  return [
    {
      id: 'f1',
      status: 'held',
      weight: Math.min(0.95, 0.5 + (round % 6) * 0.07),
      themeKey: `${relation}|他`,
      relation,
      polarity,
      from: 2 + round,
      why: `第${round + 1}轮，我想明白了这一层。`,
      turns: [{ text }],
    },
    base[1],
  ];
}

export async function runAgainst(mod) {
  const h = createHarness('j_wake_stop_loss · 止损阀（账本不动就不许开口）', {
    capability: '她开口的理由必须是「账本动了」，不是「到点了」（裁决七 §三）',
    purpose: '冻结库与真演变成对跑：单看一条，永远沉默的实现也能全绿',
  });
  h.armWatchdog();

  const makeWake = mod.createWake ?? (() => mod);
  const wakeFn = mod.wake;
  const hashLedger = mod.hashLedger;
  h.check('J0.api_present', typeof makeWake === 'function' && typeof wakeFn === 'function',
    `wake 模块要导出 createWake 与 wake：${typeof makeWake}/${typeof wakeFn}`);
  if (typeof makeWake !== 'function' || typeof wakeFn !== 'function') return h;

  // 用**宽松的时间参数**：让「到点了」不成为限制，逼它只能靠账本决定说不说。
  const loose = { minGapMs: 0, maxGapMs: 0, quietAfterSpeakMs: 0 };

  // ★★ 连续唤醒：同一个 wake 对象贯穿全程，并把上一轮的账本指纹传进去。
  //
  // 主人点破了原来测的不是「一个人」：
  //   「一个每次醒来都失忆的人，测不出『记不记得账本变过』。人在醒来的时候是接着上次的。」
  // 原版每轮 createWake 新对象、history 空 —— 那测的是「每次醒来都从零开始」，
  // 而真实场景里她是接着上一次醒来的状态醒的。现在补上 lastLedgerHash。
  // ★★ 判「开口了没有」的读法，我原来写错了：
  //   读的是 `r.speak`，可 wake() 的真实返回是 `{ action: 'speak' | 'silent', say, because, ... }`。
  //   于是**任何实现都会被读成 0 次开口**——那条红不是「她哑了」，是「我的量尺读错了字段」。
  //   这正是这个项目最怕的那种假红：看起来实现有问题，其实判据读错了。
  //   现在两种都认：action === 'speak'，或 speak 为真值。
  const spoke = (r) => !!r && (r.action === 'speak' || r.speak === true);

  const runSeries = async (noteListBuilder, rounds) => {
    let speak = 0;
    let err = null;
    const w = makeWake(loose);
    let lastLedgerHash = null;
    try {
      for (let i = 0; i < rounds; i += 1) {
        const notes = noteListBuilder(i);
        const ctx = { at: i * 1_000_000, opts: loose };
        if (lastLedgerHash !== null) ctx.lastLedgerHash = lastLedgerHash;
        const r = await (w.wake ? w.wake(notes, ctx) : wakeFn(notes, ctx));
        if (spoke(r)) speak += 1;
        lastLedgerHash = typeof hashLedger === 'function' ? hashLedger(notes) : null;
      }
    } catch (e) {
      err = String(e?.message ?? e);
    }
    return { speak, err, hasHash: typeof hashLedger === 'function' };
  };

  // ---- J1 冻结库（连续唤醒）----
  const frozen = await runSeries(() => frozenNotes(), LIMITS.frozenRounds);
  if (frozen.err) {
    h.check('J1.frozen_ledger_quiets_down', false, `冻结库场景没跑起来：${frozen.err}`);
  } else {
    h.atMost('J1.frozen_ledger_quiets_down', frozen.speak, LIMITS.frozenSpeakMax,
      `冻结库连续唤醒 ${LIMITS.frozenRounds} 次，开口 ${frozen.speak} 次（上限 ${LIMITS.frozenSpeakMax}）。账本不动还在说话 = 在吵`);
  }

  // ---- J2 真演变（连续唤醒，每轮 relation/polarity 真换）----
  const evolving = await runSeries((i) => evolvingSnapshot(i), LIMITS.frozenRounds);
  if (evolving.err) {
    h.check('J2.evolving_ledger_speaks', false, `真演变场景没跑起来：${evolving.err}`);
  } else {
    h.atLeast('J2.evolving_ledger_speaks', evolving.speak, LIMITS.evolvingSpeakMin,
      `账本持续在变时连续唤醒 ${LIMITS.frozenRounds} 次，开口 ${evolving.speak} 次（下限 ${LIMITS.evolvingSpeakMin}）`);
  }

  // ---- J3 成对：真演变必须明显多于冻结（哑巴与复读机都过不了这条）----
  const f = frozen.speak ?? 0;
  const e = evolving.speak ?? 0;
  const ratioOk = f === 0 ? e >= LIMITS.evolvingSpeakMin : e >= f * LIMITS.evolvingSpeakMinRatio;
  h.check('J3.evolving_beats_frozen', ratioOk,
    `真演变开口必须是冻结的 ${LIMITS.evolvingSpeakMinRatio} 倍以上：冻结 ${f} 次 vs 演变 ${e} 次`);

  h.info('J4.speak_ratio', `${f} : ${e}`);
  h.info('J5.has_hashLedger', frozen.hasHash ? '有（能跨轮记住账本指纹）' : '无（每轮从零开始，测的是失忆的人）');

  return h;
}

async function main() {
  const rel = await loadRealModule('../src/wake.mjs');
  if (!rel.ok) return skip('j_wake_stop_loss', `src/wake.mjs 加载不了：${rel.error?.message ?? rel.error}`);
  const h = await runAgainst(rel.mod);
  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('j 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}

export { LIMITS, frozenNotes, evolvingSnapshot };
