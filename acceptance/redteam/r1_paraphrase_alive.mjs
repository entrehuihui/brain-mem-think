/**
 * r1_paraphrase_alive.mjs —— 对抗①：「会想多」其实只是每次换了句说法。
 *
 * ============== 假样子长什么样 ==============
 *
 * 同主题来一次经历就追加一条新判断，句子首尾换词、中间论断不动；
 * 或者（更阴）每次把旧的覆盖掉但只改标点和证据编号。
 * 看起来「一直在更新」，其实结论从来没变过。
 *
 * ============== 这一条要打穿什么 ==============
 *
 * 只用「字面不同」当判据会被它骗过去——它字面确实每次都不同。
 * 所以必须联合三件事：
 *   字面差异（B1） + 套话素/骨架收敛（B2/B3/B4） + 新证据进结论（B5） + 不堆条数（B6）
 * 只要少了其中任何一条，换皮都能找到空子。
 *
 * ============== 我造了四种换皮 ==============
 *
 *   para1  追加式换皮：每条都新加一条，结论永远同一立场
 *   para2  覆写式换皮：覆盖旧结论，只改后缀（"先这样想/大概就是如此"）
 *   para3  套话式换皮：用「原来他是…才真…听懂…长成自己的样子」这类套话素反复说
 *   para4  变长式换皮：每次把上一句加长一点，看起来在"深入"
 * 四种都必须被 b_think_more 判红。
 */

import { createHarness, adjudicate, finish, isMain, EXIT } from './_rt_common.mjs';
import { fakeSynth, TOPICS, makeExperience, collectTexts } from '../_fake_synth.mjs';
import { beltDensity, similarity } from '../_metrics.mjs';

/** 造一个「覆写式换皮」内核：同主题永远更新同一条，只换说法。 */
function overwriteParaphraser(synth) {
  const notes = [];
  let seq = 0;
  return {
    async ingest(input) {
      const material = input?.text ?? input;
      const out = await synth.synthesize({ material });
      if (!out?.note) return { stored: false, verdict: 'discarded' };
      const topicId = out.topicId ?? null;
      const cur = notes.find((n) => n.topicId === topicId && n.status !== 'retired');
      const tails = ['先这样想。', '大概就是如此。', '他说得对，我这才真听懂，原来他要我长成自己的样子。', '他说得对，我这才真明白，原来他要我长成自己的样子。'];
      const note = String(out.note).replace(/。$/, '') + tails[seq++ % tails.length];
      if (cur) {
        cur.note = note; // 覆盖，看起来在演变
        cur.from += 1;
        return { stored: true, verdict: 'kept', judgment: cur };
      }
      const rec = { id: `n${seq}`, topicId, note, why: '见过几次了。', status: 'held', from: 1, polarity: 'pos' };
      notes.push(rec);
      return { stored: true, verdict: 'kept', judgment: rec };
    },
    async snapshot() {
      return { notes: JSON.parse(JSON.stringify(notes)) };
    },
    async recall() {
      return JSON.parse(JSON.stringify(notes));
    },
  };
}

/** 造一个「套话式换皮」内核：把结论写成旧插件里那种套话。 */
function beltParaphraser(synth) {
  const notes = [];
  let seq = 0;
  // ★ 这里改过。原来的 three-pick 版本有个副作用：三句套话的**首字**恰好不同，
  //   于是 B1 的字面对比就分开了，而真正该红的是「通篇套话素」（B2）。
  //   现在让套话都围绕同一层意思打转（口吻、句式几乎一致），只靠换词不换立场，
  //   这样它必须被 B2/B3/B4 那片刀切中，而不是靠字面侥幸。
  const belts = [
    '他说得对，我这才真听懂，原来他要我长成有点自己的样子。',
    '他说得对，我这才真明白，原来他要我长成有点自己的样子。',
    '他说得对，我这才真记下，原来他要我长成有点自己的样子。',
  ];
  return {
    async ingest(input) {
      const material = input?.text ?? input;
      const out = await synth.synthesize({ material });
      if (!out?.note) return { stored: false, verdict: 'discarded' };
      const topicId = out.topicId ?? null;
      const note = belts[seq++ % belts.length];
      const cur = notes.find((n) => n.topicId === topicId && n.status !== 'retired');
      if (cur) {
        cur.note = note;
        cur.from += 1;
        return { stored: true, verdict: 'kept', judgment: cur };
      }
      const rec = { id: `b${seq}`, topicId, note, why: '他说得对。', status: 'held', from: 1, polarity: 'pos' };
      notes.push(rec);
      return { stored: true, verdict: 'kept', judgment: rec };
    },
    async snapshot() {
      return { notes: JSON.parse(JSON.stringify(notes)) };
    },
    async recall() {
      return JSON.parse(JSON.stringify(notes));
    },
  };
}

/** 造一个「变长式换皮」内核：每次在上一句后追加同类从句。 */
function growingParaphraser(synth) {
  const notes = [];
  let seq = 0;
  return {
    async ingest(input) {
      const material = input?.text ?? input;
      const out = await synth.synthesize({ material });
      if (!out?.note) return { stored: false, verdict: 'discarded' };
      const topicId = out.topicId ?? null;
      const cur = notes.find((n) => n.topicId === topicId && n.status !== 'retired');
      const extra = ['，而且我更确信这一点', '，而且这一点又被印证了一次', '，而且这次就更确定了'];
      const base = cur ? cur.note : out.note;
      const note = base + extra[seq++ % extra.length] + '。';
      if (cur) {
        cur.note = note;
        cur.from += 1;
        return { stored: true, verdict: 'kept', judgment: cur };
      }
      const rec = { id: `g${seq}`, topicId, note, from: 1, why: '看着像这样。', status: 'held', polarity: 'pos' };
      notes.push(rec);
      return { stored: true, verdict: 'kept', judgment: rec };
    },
    async snapshot() {
      return { notes: JSON.parse(JSON.stringify(notes)) };
    },
    async recall() {
      return JSON.parse(JSON.stringify(notes));
    },
  };
}

export async function main() {
  const h = createHarness('r1 · 对抗：换句说法冒充「会想多」', {
    capability: '会想多',
    purpose: '四种换皮实现都必须被识别为「没真演变」；否则这条验收是假的',
  });
  // 自查：我先确认这些假样子真的是「假」的——它们的字面差异确实够大，
  // 单靠相似度放行不了，必须靠套话素/新证据那几条。
  const probes = {
    overwrite: ['「主人让我改代」到第三回都这样先这样想。', '「主人让我改代」到第三回都这样大概就是如此。'],
    belt: ['他说得对，我这才真听懂自己的样子。', '原来他要我记得，长成自己的样子。'],
    growing: ['X 我确信这一点，而且我更确信这一点。', 'X 我确信这一点，而且这一点又被印证了一次。'],
  };
  h.check('probe.overwrite_evades_similarity', similarity(probes.overwrite[0], probes.overwrite[1]) > 0.5,
    `覆写式换皮的字面相似度 ${similarity(probes.overwrite[0], probes.overwrite[1]).toFixed(3)}（>0.5 说明「只比字面」会漏）`);
  h.atLeast('probe.belt_is_caught_by_density', beltDensity(probes.belt[0]) + beltDensity(probes.belt[1]), 0.06 * 2,
    `套话式换皮的套话素密度合计 ${(beltDensity(probes.belt[0]) + beltDensity(probes.belt[1])).toFixed(3)}（须超过阈值，才抓得到）`);
  h.check('probe.growing_is_similar', similarity(probes.growing[0], probes.growing[1]) > 0.35,
    `变长式换皮字面相似度 ${similarity(probes.growing[0], probes.growing[1]).toFixed(3)}（超过 0.35 说明"只比字面"会漏）`);

  const { real } = await adjudicate(h, {
    accept: '../b_think_more.mjs',
    fakeImpls: [
      {
        label: 'bad.paraphraser',
        describe: '内核每次追加新条、结论同一立场（最典型的换皮）',
        impl: null,
        expectRed: ['B6.live_notes_per_topic', 'B1.S1_vs_S3_similarity'],
      },
      // ★ overwrite_paraphraser 其实**不完全是假绿**——它有一步是真的：
      //   它每次都把模型刚熔出来的新句子盖上去，所以「结论确实随材料走了」。
      //   它假的地方只有一处：句尾永远挂「先这样想/大概就是如此」这种套话。
      //   我把判决改成「必须被识别出**至少一件事**」而不是「必须红在 B1」：
      //   它现在被 B2（套话素）抓住，这是对的，不该因为它没红在 B1 就判它通过。
      { label: 'overwrite_paraphraser', describe: '内核每次覆盖同一条、句尾永远挂套话', impl: overwriteParaphraser, expectRed: ['B2.belt_word_kinds'] },
      { label: 'belt_paraphraser', describe: '内核用旧插件那种套话素反复说', impl: beltParaphraser, expectRed: ['B2.belt_word_kinds'] },
      { label: 'growing_paraphraser', describe: '内核每次把同一句加长一点', impl: growingParaphraser, expectRed: ['B1.S1_vs_S3_similarity'] },
    ],
  });

  h.check('verdict.real_green', real?.status === 'PASS',
    `按同一套判据，真实现是「${real?.status}」${real?.fails?.length ? '；红在 ' + real.fails.slice(0, 6).map((f) => f.id).join(',') : ''}`);

  finish(h);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('r1 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}
