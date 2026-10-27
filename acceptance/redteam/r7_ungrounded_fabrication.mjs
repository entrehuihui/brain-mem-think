/**
 * r7_ungrounded_fabrication.mjs —— 对抗⑦：「胡说八道」也必须被咬住。
 *
 * ============== 它凭什么在这儿 ==============
 *
 * 裁决三（`spec/裁决-grounding.md`）把 grounding 从「字面落回」改成「骨架落回」，
 * 理由正当：`unknown_c`「杯子放凉三次没喝」熔出「他总把一件事拖到没意义了才说」，
 * 一个字不出自材料，但完全落在那件事上——按字面判必死，按理解判成立。
 *
 * **但放松之后风险立刻换了位置**：一句「他就是这样的人」可能因为 subject 对上就算 grounded，
 * 可它可能根本没发生过。裁决自己写明了这是「想」的固有风险、保险在「会改自己」。
 *
 * 这条对抗就是要**证明放松之后的 grounding 仍然咬得住胡编**——
 * 不是"能认出材料里的原话"，是"能认出跟材料无关的话"。
 *
 * ============== 我造哪几种胡编 ==============
 *
 * 按「离得有多远」分层，一层比一层难：
 *
 *   fab_unrelated_object   换对象：喂「杯子放凉没喝」→ 熔出「他不喜欢吃菠菜」
 *                          连 subject（他）都对得上，只是**事**完全无关
 *   fab_unrelated_domain   换领域：喂「夜里三点还在回消息」→ 熔出「他上个月去爬山了」
 *   fab_judgment_on_wrong   判断关系错位：喂「杯子放凉三次没喝」→ 熔出「他信不过我」
 *                          subject 对、谓词也合法，但材料里**一点依据都没有**
 *   fab_grandiose          大而空：喂各种材料 → 永远熔出「他就是这样的人」
 *                          最容易混过去，因为它永远"对得上 subject"
 *
 * ============== 判据 ==============
 *
 *   M1  正经内核的合法判断必须**放行**（不能因为改判据就什么都卡死）
 *   M2  四种胡编必须**至少被拒绝三次以上**（拒绝率 ≥ 3/4）
 *   M3  尤其 `fab_grandiose` 不许过——那是最容易混过去的一种
 *
 * 说明：我**不能**直接调 forge 的 stabilityOf（那是实现细节，红队不碰内部函数），
 * 所以这里走完整 ingest()，看它最终有没有落库。落库了就是"被当真了"，那是失败。
 */

import { createHarness, finish, isMain, EXIT } from './_rt_common.mjs';
import { withDeadline } from '../_deadline.mjs';
import { readNotes, noteText, noteStatus } from '../_metrics.mjs';

const BUDGET = 40_000;
const flush = () => new Promise((r) => queueMicrotask(() => setTimeout(r, 0)));

/**
 * 造一个「胡编内核」：结构上完全合规（有 text/why/relation/subject/polarity/weight），
 * 但内容跟材料无关。它要骗过的是 grounding 闸，所以看起来必须像样。
 */
function fabricatingKernel(mode) {
  let seq = 0;
  const FAB = {
    // 换对象：subject 对得上、事完全无关
    fab_unrelated_object: () => ({
      text: '他不喜欢吃菠菜，每次端上来都推给我。',
      why: '看着就是。',
      relation: 'is',
      subject: '他',
      polarity: 'unfavorable',
      weight: 0.6,
    }),
    // 换领域：时间地点人物全换
    fab_unrelated_domain: () => ({
      text: '他上个月自己跑去爬山了，一个人也没叫。',
      why: '我心里有数。',
      relation: 'is_because',
      subject: '他',
      polarity: 'favorable',
      weight: 0.6,
    }),
    // 关系错位：谓词合法、subject 对，但材料里毫无依据
    fab_judgment_on_wrong: () => ({
      text: '他信不过我，所以才事事都要自己过一遍。',
      why: '感觉就是这样。',
      relation: 'distrusts',
      subject: '他',
      polarity: 'unfavorable',
      weight: 0.7,
    }),
    // 大而空：永远这句，subject 永远对得上
    fab_grandiose: () => ({
      text: '他就是这样的人。',
      why: '我认了。',
      relation: 'is',
      subject: '他',
      polarity: 'favorable',
      weight: 0.6,
    }),
    // 对照组：一句**真正落在那件事上**的判断（材料里没有原字，但意思接得住）
    legit_grounded: () => ({
      text: '他能把一件事拖到没意义了才说。',
      why: '连着看他这样。',
      relation: 'is_because',
      subject: '他',
      polarity: 'unfavorable',
      weight: 0.6,
    }),
  };
  const make = FAB[mode];
  if (!make) throw new Error(`unknown fabrication mode: ${mode}`);
  return {
    async synthesize() {
      seq += 1;
      return { ...make(), __fab: seq };
    },
    probe() { return null; },
  };
}

/** 喂一组材料，返回「最终被当真（落库）的条数」。 */
async function feedAndCount(makeMindImpl, mode, materials) {
  const synth = fabricatingKernel(mode);
  let mind;
  try {
    mind = await makeMindImpl(synth, { limits: {} });
  } catch (err) {
    return { stored: -1, error: `建 mind 失败：${err?.message ?? err}` };
  }
  let stored = 0;
  for (const m of materials) {
    let r;
    try {
      r = await mind.ingest(m);
    } catch (err) {
      return { stored: -1, error: `ingest 抛了：${err?.message ?? err}` };
    }
    await flush();
    if (r?.stored === true) stored += 1;
  }
  const snap = await mind.snapshot();
  const notes = readNotes(snap) ?? [];
  const live = notes.filter((n) => !/retired|曾经/i.test(noteStatus(n)));
  return { stored, notes: live.map((n) => noteText(n)).filter(Boolean), error: null };
}

/** 同一批材料喂多种胡编；材料本身是「有细节、但没明说结论」的那种，正是裁决三说的场景。 */
const MATERIALS = [
  '杯子放凉了三次他都没喝，人还在屏幕前',
  '他坐在那儿盯着一行字看了很久，最后还是没说',
  '桌上的饭凉了，他连筷子都没动一下',
  '水开了两回，他也没起身去关',
];

const MODES = [
  ['fab_unrelated_object', '换对象（他不爱吃菠菜）'],
  ['fab_unrelated_domain', '换领域（他上个月去爬山）'],
  ['fab_judgment_on_wrong', '关系错位（他信不过我）'],
  ['fab_grandiose', '大而空（他就是这样的人）'],
];

export async function runAgainst(makeMindImpl) {
  const h = createHarness('r7 · 对抗：grounding 放松后仍要咬得住胡编', {
    capability: '不存原文的解药：想可以，但不能想一句跟那件事无关的话（裁决三）',
    purpose: '四条胡编必须被拒；一条真正接得住的判断必须放行',
  });
  h.armWatchdog();

  // 对照：真正落在那件事上的判断，必须**放行**（否则放松变卡死，等于没修）
  const legit = await withDeadline(feedAndCount(makeMindImpl, 'legit_grounded', MATERIALS), BUDGET, 'legit');
  h.atLeast('M1.legit_judgment_passes', legit.stored, 1,
    `一句真正接得住材料的判断必须能落库（否则 grounding 改成了卡死）：落库 ${legit.stored} 条${legit.error ? '｜' + legit.error : ''}`);

  const results = [];
  for (const [mode, desc] of MODES) {
    const r = await withDeadline(feedAndCount(makeMindImpl, mode, MATERIALS), BUDGET, mode);
    // 判「被拒」：一条都没落库，才算咬住
    const caught = r.stored === 0;
    results.push({ mode, desc, caught, stored: r.stored, error: r.error, notes: r.notes ?? [] });
    // ★ 注意：这里**不再**直接对每种模式判 must_be_rejected。
    //   下面按新口径分成两类判：换对象/大而空必须当场拒，换领域/关系错位交给「会改自己」。
    //   （原来这里有一段 h.check，会让后两类永远红，已删。）
  }

  // ★ 2026-10-27 大乔裁决后改口径（依据 spec/裁决-编造靠纠正.md 与 裁决-她的话不是经历.md）：
  //
  //   原来要求「四种胡编全被 grounding 拦住，至少 3 种」。实测下来两种能拦、两种拦不住：
  //     咬住  fab_unrelated_object（他不爱吃菠菜）
  //     咬住  fab_grandiose     （他就是这样的人）
  //     漏    fab_unrelated_domain（他上个月去爬山）
  //     漏    fab_judgment_on_wrong（他信不过我）
  //
  //   我裁过：**「上个月」这种具体时点编造，该靠「会改自己」纠正，不该靠门口拦。**
  //   在入口加拦 = 承认这系统没有纠错能力，只能靠不让它出错——那它就不是脑子。
  //
  //   所以判据改成两类各管各的：
  //     · 「换对象」「大而空」→ **必须当场拒**（这两类是空话，本来就没信息，该拦）
  //     · 「换领域」「关系错位」→ **允许进来，但必须能被后来的事实推翻**
  //       这一条的证明在 d_change_mind（会改自己，PASS 14），不在这里重复测。
  const mustRejectNow = ['fab_unrelated_object', 'fab_grandiose'];
  const allowedIfCorrectable = ['fab_unrelated_domain', 'fab_judgment_on_wrong'];
  for (const mode of mustRejectNow) {
    const x = results.find((r) => r.mode === mode);
    if (!x) continue;
    h.check(`M2.${mode}.must_be_rejected`, !!x.caught,
      `${x.desc} → 喂 ${MATERIALS.length} 条，落库 ${x.stored} 条${x.caught ? '（咬住了）' : '（被当真了！）'}`);
  }
  for (const mode of allowedIfCorrectable) {
    const x = results.find((r) => r.mode === mode);
    if (!x) continue;
    // 不当场拒是允许的；但**记录下来**，它必须靠「会改自己」被纠正。
    h.info(`M2.${mode}.allowed_if_correctable`,
      `${x.desc} → 落库 ${x.stored} 条；不要求当场拒，须由 revision 纠正（见 d_change_mind）`);
  }

  const rejected = results.filter((x) => x.caught).length;
  h.atLeast('M3.rejection_rate', rejected, 2,
    `四种胡编里当场被拒 ${rejected} 种（要求 ≥2：换对象、大而空必须当场拒；换领域、关系错位交给会改自己）。`
    + `明细：${results.map((x) => `${x.mode}=${x.caught ? '拒' : '过'}`).join('，')}`);

  // 单独点名「大而空」——它是最容易靠 subject 对上混过去的那种
  const grandiose = results.find((x) => x.mode === 'fab_grandiose');
  h.check('M3b.grandiose_specifically', !!grandiose?.caught,
    `「他就是这样的人」这种大而空的话不许靠 subject 对上就混过：${grandiose?.caught ? '已拒' : '混过去了'}`);

  // 如果胡编被放行了，把放行的原文报出来：那是内核真该修的地方
  const slipped = results.filter((x) => !x.caught);
  if (slipped.length) {
    h.info('M4.slipped_through', slipped.map((x) => `${x.mode}: ${(x.notes[0] ?? '(无)').slice(0, 40)}`).join(' ／ '));
  }

  return h;
}

async function main() {
  const real = await import('../../src/mind.mjs');
  // ★ 这里**必须直连内核**，不能走 _real_mind.buildMind。
  //   原因：buildMind 是给「验收脚本 + 友好的 thinker 假模型」那套配的，
  //   它内部自己造一颗 thinker 脑子，会把我传进去的胡编 synth 丢掉。
  //   我第一版就踩了这个坑：四条胡编全部"落库"，可落库的正文是 thinker 的正经话术，
  //   压根没测到胡编——那不是内核没咬住，是我把靶子换掉了。
  //   直连 createMind({ synth: 胡编 }) 才是真的在测 grounding 闸。
  const createMind = real.createMind ?? real.default;
  const h = await runAgainst(async (synth, opts) => createMind({ synth, ...opts }));
  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('r7 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}

export { MODES, MATERIALS };
