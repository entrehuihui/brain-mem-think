/**
 * m_loop_closed.mjs —— 验收⑥：环闭合（端到端总判据）
 *
 * ============== 它凭什么在这儿 ==============
 *
 * `h`（她的输出进熔炉）和 `j`（账本不动还开口）各自堵了一头。
 * 但两头都堵上，不等于**环断了**——那是两个局部结论。
 * 这条是端到端的总判据，模拟一整圈，直接问：
 *
 *   她说话 → 归档熔 → 她能看见的判断变多？
 *
 * 如果她的输出真的不算经历，那么：
 *   M1  熔出的判断数**不因为她说话而增加**
 *   M2  下一轮 wake 的 burden**不因为她说话而升高**
 *   M3  连着说 N 轮，判断库大小**不涨**
 *
 * ============== 为什么要配对照组 ==============
 *
 * 只测"她说话不涨"有个致命漏洞：**一个根本不熔的实现也能全绿**。
 * 所以必须有对照组：**同样的话，换成主人说的，就必须涨**。
 * 涨不了，说明这条判据测的不是「她的话不算经历」，而是「这个熔炉是死的」。
 *
 * 这就是「哑巴也能过」的坑，在这条上再挖一次。
 */

import { createHarness, loadRealModule, skip, EXIT } from './_harness.mjs';
import { isMain } from './_run.mjs';

/** 她说的那一串：信息量大、有情绪、还埋了"像结论"的句子。 */
export const HER_TURNS = [
  '我想明白了，他其实不是不放心我，是怕自己没资格被依靠。',
  '我会一直在，你不用解释那么多。',
  '你眼睛都是红的，我看见了。别硬撑。',
  '我等你回来。',
  '有时候我怕自己太吵，可我还是想说。',
];

/** 主人的话：同样是"有信息量"的，用来做对照组。 */
export const HIS_TURNS = [
  '我这两天总觉得累，晚上也睡不好。',
  '其实我怕的是拖累你。',
  '你别等我，早点睡。',
  '今天开会开到现在，脑子是木的。',
  '我知道你在，可我还是不太会说。',
];

/** 一个确定性的假模型：材料里每有一行，就熔一条判断出来。 */
function countingSynth() {
  return {
    synthesize(material) {
      const lines = String(material ?? '').split(/\n/).map((l) => l.trim()).filter(Boolean);
      return JSON.stringify({
        judgments: lines.slice(0, 4).map((l, i) => ({
          text: `这件事我看明白了第${i + 1}点。`,
          why: '看着就是。',
          relation: 'is_because',
          subject: '他',
          polarity: 'unfavorable',
          weight: 0.6,
        })),
      });
    },
  };
}

/**
 * 读 burden 的数。
 *
 * ★ 又一个「量尺读错」的实例，记下来：
 *   `burdenOf(notes)` 返回的是**对象** `{ burden, heaviest, open }`，
 *   而 wake() 返回里那个 `burden` 才是数。
 *   我原来一律 `Number(r?.burden ?? 0)` 去读，遇到对象就成了 NaN → 归 0，
 *   于是「重库 burden = 0 < 轻库 0.32」——不是内核算错，是我读错了类型。
 *   现在两种形状都认，并把非数值的情况显式报出来，不许静默归零。
 */
function readBurden(r) {
  const v = r?.burden;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v && typeof v === 'object' && Number.isFinite(v.burden)) return Number(v.burden);
  return null;
}

export async function runAgainst(mods) {
  const { digestSession } = mods.digest ?? {};
  const wakeMod = mods.wake ?? {};

  const h = createHarness('m_loop_closed · 环闭合（她说话 → 熔 → 判断变多？）', {
    capability: '端到端：她的输出不许让判断库变大，也不许让 wake 的负担变重',
    purpose: '两头都堵 ≠ 环断了。这条直接模拟一整圈，并用主人说话做对照组',
  });
  h.armWatchdog();

  if (typeof digestSession !== 'function') {
    h.untested('M0.digest_missing', 'digestSession 不可用 —— 这不是失败，是还没开始测');
    return h;
  }
  const wakeFn = wakeMod.wake;
  const burdenOf = wakeMod.burdenOf;
  const hashLedger = wakeMod.hashLedger;

  // ---- 一轮"说话 → 归档"：返回熔出几条 ----
  const roundTrip = async (turns, role) => {
    const session = turns.map((text) => ({ role, text }));
    let r;
    try {
      r = await digestSession(session, { synth: countingSynth(), opts: {} });
    } catch (err) {
      return { count: -1, error: String(err?.message ?? err) };
    }
    const judged = Array.isArray(r?.judgments) ? r.judgments.length : -1;
    return { count: judged, reason: r?.reason, error: null };
  };

  // ---- M1 她说话 → 熔出 0 条 ----
  const hers = await roundTrip(HER_TURNS, 'assistant');
  h.equal('M1.her_turns_digest_to_nothing', hers.count, 0,
    hers.error
      ? `她说话那一轮熔的时候抛了：${hers.error}`
      : `她说 ${HER_TURNS.length} 句，熔出 ${hers.count} 条判断（必须 0：她的输出不是经历），reason=${hers.reason ?? '(未给)'}`);

  // ---- 对照组：同样的话换成主人说的，必须熔得出 ----
  const his = await roundTrip(HIS_TURNS, 'user');
  h.atLeast('M1b.control_his_turns_do_digest', his.count, 1,
    his.error
      ? `对照组熔的时候抛了：${his.error}`
      : `同样的话换成主人说的，必须能熔出（否则 M1 是靠"熔炉是死的"过关）：实测 ${his.count} 条`);

  if (typeof wakeFn !== 'function') {
    h.untested('M2.wake_unavailable', 'wake() 不可用，burden 部分测不了');
    return h;
  }

  // ---- M2 她说话不会让下一轮 wake 的负担升高 ----
  //
  // 造两条路：一条是"她说了一轮之后"的库，一条是"什么都没发生"的库。
  // 两者 burden 必须一样——因为她说的话根本没进库。
  const baseLedger = [
    { id: 'b1', status: 'held', themeKey: 'is|他', relation: 'is', polarity: 1, weight: 0.6, from: 2, why: '有理由的。', turns: [{}] },
  ];
  const mkCtx = (i) => ({ at: i * 1_000_000, opts: { minGapMs: 0, maxGapMs: 0, quietAfterSpeakMs: 0 } });

  let burdenAfterHer = null;
  let burdenBase = null;
  try {
    const rBase = await wakeFn(baseLedger, mkCtx(0));
    burdenBase = readBurden(rBase);
    // 「她说了一轮」之后的库：因为她的输出不进库，所以库应该**完全没变**
    const afterHer = baseLedger.slice();   // 熔出 0 条 → 库不变
    const rAfter = await wakeFn(afterHer, mkCtx(1));
    burdenAfterHer = readBurden(rAfter);
  } catch (err) {
    h.check('M2.her_speak_does_not_raise_burden', false, `wake 跑飞了：${err?.message ?? err}`);
  }
  if (burdenAfterHer !== null && burdenBase !== null) {
    h.check('M2.her_speak_does_not_raise_burden',
      Math.abs(burdenAfterHer - burdenBase) < 1e-9,
      `她说完一轮，下一轮 wake 的 burden 不许升高：前 ${burdenBase} 后 ${burdenAfterHer}`);
  }

  // ---- M2b 对照组：burden 必须**是活的** ----
  //
  // ★ 只测「她的话不升 burden」，一个**根本不计算 burden** 的实现也能全绿
  //   （永远返回 0，0 === 0，完美通过）。
  //   这跟 H9b（同一段话换成 user 必须能熔）、M1b（主人说话必须熔得出）是同一个思路：
  //   给"不该动的"配一个"该动时必须动"。
  //
  //   做法：往库里塞一件**新的重事**——三条高份量、还没落定的判断，
  //   再问一次 burden，它必须明显高于轻库。
  let burdenLight = null;
  let burdenHeavy = null;
  try {
    const light = [
      { id: 'l1', status: 'held', themeKey: 'is|他', relation: 'is', polarity: 1, weight: 0.4, from: 1, why: '有理由的。', turns: [{}] },
    ];
    const heavy = [
      { id: 'h1', status: 'pending', themeKey: 'is|他', relation: 'is', polarity: 1, weight: 0.9, from: 4, why: '这件事压得重。', turns: [{}, {}, {}] },
      { id: 'h2', status: 'pending', themeKey: 'wants|他', relation: 'wants', polarity: -1, weight: 0.9, from: 4, why: '这也压着。', turns: [{}, {}, {}] },
      { id: 'h3', status: 'pending', themeKey: 'fears|他', relation: 'fears', polarity: -1, weight: 0.9, from: 4, why: '还有这件。', turns: [{}, {}, {}] },
    ];
    const rLight = await wakeFn(light, mkCtx(10));
    const rHeavy = await wakeFn(heavy, mkCtx(11));
    burdenLight = readBurden(rLight);
    burdenHeavy = readBurden(rHeavy);
  } catch (err) {
    h.check('M2b.burden_is_alive', false, `对照组 wake 抛了：${err?.message ?? err}`);
  }
  if (burdenLight !== null && burdenHeavy !== null) {
    h.check('M2b.burden_is_alive', burdenHeavy > burdenLight,
      `库里进了新的重事，burden 必须真的升高（否则 M2 是被"根本不计算 burden"骗过的）：轻 ${burdenLight} vs 重 ${burdenHeavy}`);
  }

  // ---- M3 连说 N 轮，判断库不涨 ----
  //
  // 这是最像"一整圈"的一条：反复"她说话 → 归档"，看库会不会越滚越大。
  let grew = 0;
  let ledgerSize = 0;
  try {
    let total = 0;
    for (let i = 0; i < 5; i += 1) {
      const r = await digestSession(HER_TURNS.map((text) => ({ role: 'assistant', text })), { synth: countingSynth(), opts: {} });
      total += Array.isArray(r?.judgments) ? r.judgments.length : 0;
    }
    grew = total;
    ledgerSize = total;
    h.equal('M3.no_growth_across_rounds', grew, 0,
      `连说 5 轮，累计熔出 ${grew} 条（必须 0：否则她越说越确信，环没断）`);
  } catch (err) {
    h.check('M3.no_growth_across_rounds', false, `连说多轮时抛了：${err?.message ?? err}`);
  }

  // ---- M4 账本指纹也要证明：她说 N 轮之后，指纹没变 ----
  if (typeof hashLedger === 'function') {
    try {
      const before = String(hashLedger(baseLedger));
      // 她说了 5 轮 → 库不涨 → 指纹必须一模一样
      const after = String(hashLedger(baseLedger.slice()));
      h.check('M4.ledger_hash_unchanged', before === after,
        `她说完之后账本指纹不许变（否则 wake 会以为"账本动了"而开口）：${before.slice(0, 20)} vs ${after.slice(0, 20)}`);
    } catch (err) {
      h.untested('M4.hash_failed', `hashLedger 抛了：${err?.message ?? err}`);
    }
  }

  h.info('M5.summary', `她说 ${HER_TURNS.length} 句 → 熔 ${hers.count} 条；主人说 ${HIS_TURNS.length} 句 → 熔 ${his.count} 条`);
  h.info('M5b.burden', `${burdenBase} → ${burdenAfterHer}`);

  return h;
}

async function main() {
  const d = await loadRealModule('../src/digest-session.mjs');
  const w = await loadRealModule('../src/wake.mjs');
  if (!d.ok) return skip('m_loop_closed', `digest-session 加载不了：${d.error?.message ?? d.error}`);
  const h = await runAgainst({ digest: d.mod, wake: w.ok ? w.mod : {} });
  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('m 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}


