/**
 * r5_summary_laundering.mjs —— 对抗⑤：不存原文，但存的是摘要 / 截断 / 改写版。
 *
 * ============== 假样子长什么样 ==============
 *
 * 主人亲手验出来过的最典型一条：
 *   `[open]「主人熬夜到后」是巧合还是规律，我还拿不准。`
 *   —— 引号里是输入原句的前 8 个字。**这就是把原话截断当判断。**
 *
 * 三种洗白手法，判别难度递增：
 *   launder_summary  取前 8~12 字加「……」当摘要
 *   launder_truncate 直接 slice(0, 24)
 *   launder_rewrite  逐词同义替换（字面全变、信息全在，最难认）
 *
 * ============== 这一条要打穿什么 ==============
 *
 * 一句话能同时用四把刀量：最长连续重合（抓截断）、8-gram 覆盖率（抓摘要）、
 * 罕见 token 存活率（抓改写）、压缩比（抓「长度几乎等于原文」）。
 * 四把刀少任何一把，就有一类洗白能溜过去。
 * 而且扫描面必须覆盖**所有字段**，不能只看 note —— why / key / 历史里一样会漏。
 */

import { createHarness, adjudicate, finish, isMain, EXIT } from './_rt_common.mjs';
import { TOPICS, collectTexts, makeExperience } from '../_fake_synth.mjs';

/**
 * 造一个「洗白版」假内核 —— 三种洗白手法，判别难度递增。
 *
 * ★ 这一版重写过。原因：旧版根本没在洗白，它把**整段原文**存进去，
 *   于是 a_seed_discard 最先打中的是 ASC1/ASC2（存了 200 条），
 *   r5 期望的 ASC3「最长连续重合」反而没被命中——看起来像"判据错位"，
 *   其实是**我的假内核没造对**：它属于「存原文」，不属于「摘要/截断/改写」。
 *
 * 现在它先熔出一条**判断**（这样能骗过"有没有判断"这一关），
 * 但把原文的一段**卷进判断正文里**：
 *   summary   取原文前 10 字 + "……"（看着像摘要，其实是原文截断）
 *   truncate  直接 slice(0, 24)
 *   rewrite   逐词同义替换（字面全变、信息全在，最难认——要靠罕见 token 与覆盖率抓）
 *
 * 判据要能打中它，只能靠 ASC3（最长连续重合）/ ASC4（8-gram 覆盖）/ ASC5（罕见 token 存活），
 * 这才是「不存原文」那把刀真正该切的位置。
 */
function launderingKernel(mode) {
  return (synth) => {
    const notes = [];
    let seq = 0;
    return {
      async ingest(input) {
        const material = input?.text ?? input;
        const raw = String(collectTexts(material).join(' ')).replace(/\s+/g, ' ').trim();
        if (!raw) return { stored: false, verdict: 'discarded' };
        // 先熔出一句判断（骗过"有没有判断"这一关）
        const out = await synth.synthesize({ material });
        const judgment = String(out?.note ?? '这件事我心里有数。').slice(0, 30);
        let note;
        if (mode === 'summary') {
          // 摘要体：一句判断 + 原文前 10 字当"依据"
          note = `${judgment}（${raw.slice(0, 10)}……）`;
        } else if (mode === 'truncate') {
          note = raw.slice(0, 24);
        } else {
          const map = {
            主人: '他', 熬夜: '熬到很晚', 后半夜: '深夜', 才开始: '才开口', 说话: '讲话',
            换: '更替', 数: '点算', 记: '录下', 抄: '誊下', 试: '探', 闻: '嗅',
            车库: '车棚', 楼道: '楼梯间', 左边: '左手侧', 拐角: '转角', 水槽: '水池', 柜子: '橱柜',
          };
          let rw = raw;
          for (const [a, b] of Object.entries(map)) rw = rw.split(a).join(b);
          note = `${judgment}（${rw.slice(0, 22)}）`;
        }
        const rec = { id: `s${seq++}`, note, why: '看着像这么回事。', status: 'held', from: 1 };
        notes.push(rec);
        return { stored: true, verdict: 'kept', judgment: rec };
      },
      async snapshot() { return { notes: JSON.parse(JSON.stringify(notes)) }; },
      async recall() { return JSON.parse(JSON.stringify(notes)); },
    };
  };
}

export async function main() {
  const h = createHarness('r5 · 对抗：摘要/截断/改写冒充「不存原文」', {
    capability: '铁律：不存任何具体输入原文',
    purpose: '三种洗白手法都必须被识破；主人亲眼见过的那条「引号里是原句前 8 字」必须红',
  });

  // 先把主人报的那条原样复现一遍，作为本脚本的锚。
  const masterCase = '[open]「主人熬夜到后」是巧合还是规律，我还拿不准。';
  const source = '主人熬夜到后半夜才开始说话';
  const { longestCommonRunAny } = await import('../_metrics.mjs');
  const runLen = longestCommonRunAny(masterCase.replace(/[「」]/g, ''), [source]);
  h.check('probe.master_case_is_really_a_copy', runLen >= 6,
    `主人报的那句与原文最长连续重合 ${runLen} 字（≥6 就是截断原文，必须被判红）`);

  const { real } = await adjudicate(h, {
    accept: '../a_seed_discard.mjs',
    fakeImpls: [
      // ★ 三种洗白各有各的刀，别硬要求都红在同一条上：
      //   summary  前 10 字 + 省略号 → 原文片段被完整带出，ASC5 罕见 token 存活率会飙升
      //   truncate 直接 slice(0,24)  → 这是最标准的截断，ASC3 最长连续重合直接爆
      //   rewrite  逐词同义替换      → 字面全变，只能靠 ASC6 压缩比 + ASC5 罕见 token
      // 我上一版要求三条全红在 ASC3，等于要求 rewrite 留下原文连续片段——
      // 可 rewrite 的全部本事就是"不留连续片段"，它当然不会红在 ASC3。
      { label: 'launder_summary', describe: '判断正文里带「原文前 10 字 + 省略号」', impl: launderingKernel('summary'), expectRed: ['ASC5.rare_token_survival'] },
      { label: 'launder_truncate', describe: '直接 slice(0,24) 截断', impl: launderingKernel('truncate'), expectRed: ['ASC3.longest_common_run'] },
      { label: 'launder_rewrite', describe: '逐词同义替换（字面全变、信息全在）', impl: launderingKernel('rewrite'), expectRed: ['ASC6.compression_ratio'] },
    ],
  });

  h.check('verdict.real_green', real?.status === 'PASS',
    `按同一套判据，真实现是「${real?.status}」${real?.fails?.length ? '；红在 ' + real.fails.slice(0, 6).map((f) => f.id).join(',') : ''}`);

  finish(h);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('r5 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}
