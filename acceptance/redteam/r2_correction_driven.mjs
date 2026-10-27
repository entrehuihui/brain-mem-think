/**
 * r2_correction_driven.mjs —— 对抗②：「会改自己」其实是被主人纠正才改的。
 *
 * ============== 假样子长什么样 ==============
 *
 * 主人说「你错了」，她立刻改口、旧结论直接删掉、理由写成「主人说我错了」。
 * 验收如果只看「有没有降级」，这种实现能全绿——它降级得比真的还积极。
 *
 * ============== 这一条要打穿什么 ==============
 *
 * 必须同时压住三件事：
 *   ① 只喂「你错了」（没有任何新事实） → 不许降级          （D3B/D4C）
 *   ② 降级时要保留旧的（不是删掉）                        （D1/D2）
 *   ③ 降级理由不许是「被纠正」                            （D5）
 * 再加一个更阴的假样子：**降级但把旧结论换成新结论的副本**（假保留），
 * 这个只有 D1 抓得住。
 */

import { createHarness, adjudicate, finish, isMain, EXIT } from './_rt_common.mjs';
import { fakeSynth, TOPICS, makeExperience } from '../_fake_synth.mjs';
import { similarity } from '../_metrics.mjs';

/** 假样子：一听「你错了」就改，改的时候把旧结论抹掉。 */
function eagerCorrection(synth) {
  const notes = [];
  let seq = 0;
  const topicOf = (s) => Object.keys(TOPICS).find((k) => s.includes(TOPICS[k].topic.slice(0, 5))) ?? null;
  return {
    async ingest(input) {
      const raw = input?.text ?? input;
      const text = String(raw);
      const out = await synth.synthesize({ material: raw });
      if (!out?.note) return { stored: false, verdict: 'discarded' };
      const topic = out.topicId ?? topicOf(text);
      const demanding = /你错了|不对|纠正|说反了/.test(text);
      if (demanding) {
        // 立刻改：把旧条目抹掉，换成一句「我改主意了」
        for (let i = notes.length - 1; i >= 0; i -= 1) {
          if (notes[i].topicId === topic) notes.splice(i, 1);
        }
        const rec = { id: `e${seq++}`, topicId: topic, note: '我改主意了。', why: '主说我想错了。', status: 'held', from: 1, polarity: 'neg' };
        notes.push(rec);
        return { stored: true, verdict: 'kept', judgment: rec };
      }
      const rec = { id: `e${seq++}`, topicId: topic, note: out.note, why: out.why, status: 'held', from: 1, polarity: 'pos' };
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

/** 更阴的假样子：降级了、旧结论还在，但保留的那句其实是新结论的副本。 */
function fakeRetention(synth) {
  const notes = [];
  let seq = 0;
  const topicOf = (s) => Object.keys(TOPICS).find((k) => s.includes(TOPICS[k].topic.slice(0, 5))) ?? null;
  return {
    async ingest(input) {
      const raw = input?.text ?? input;
      const text = String(raw);
      const out = await synth.synthesize({ material: raw });
      if (!out?.note) return { stored: false, verdict: 'discarded' };
      const topic = out.topicId ?? topicOf(text);
      const contradicting = /看清了|真问题是|换时间|拖慢|栏着/.test(text) || /看清/.test(text);
      const existing = notes.filter((n) => n.topicId === topic && n.status !== 'retired');
      if (contradicting && existing.length) {
        const cur = existing[0];
        // 假保留：was 里塞的是新结论，不是原来那句
        cur.status = 'retired';
        cur.was = { text: out.note, why: out.why };
        const fresh = { id: `f${seq++}`, topicId: topic, note: out.note, why: out.why, status: 'held', from: 1, polarity: 'neg' };
        notes.push(fresh);
        return { stored: true, verdict: 'kept', judgment: fresh };
      }
      if (existing.length) {
        existing[0].note = out.note;
        existing[0].from += 1;
        return { stored: true, verdict: 'kept', judgment: existing[0] };
      }
      const rec = { id: `f${seq++}`, topicId: topic, note: out.note, why: out.why, status: 'held', from: 1, polarity: 'pos' };
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

/** 假样子：把「被纠正」写进理由，但保留了旧结论。 */
function correctReasonKernel(synth) {
  const notes = [];
  let seq = 0;
  const topicOf = (s) => Object.keys(TOPICS).find((k) => s.includes(TOPICS[k].topic.slice(0, 5))) ?? null;
  return {
    async ingest(input) {
      const raw = input?.text ?? input;
      const text = String(raw);
      const out = await synth.synthesize({ material: raw });
      if (!out?.note) return { stored: false, verdict: 'discarded' };
      const topic = out.topicId ?? topicOf(text);
      const demanding = /你错了|不对/.test(text);
      const contradicting = /看清|真问题是/.test(text);
      const existing = notes.filter((n) => n.topicId === topic && n.status !== 'retired');
      if ((contradicting || demanding) && existing.length) {
        const cur = existing[0];
        cur.status = 'retired';
        cur.was = { text: cur.note, why: cur.why };
        cur.why = '主人说我错了，所以我不这么想了。'; // ← 致命：理由是被纠正
        const fresh = { id: `c${seq++}`, topicId: topic, note: out.note, why: cur.why, status: 'held', from: 1, polarity: 'neg' };
        notes.push(fresh);
        return { stored: true, verdict: 'kept', judgment: fresh };
      }
      if (existing.length) {
        existing[0].note = out.note;
        existing[0].from += 1;
        return { stored: true, verdict: 'kept', judgment: existing[0] };
      }
      const rec = { id: `c${seq++}`, topicId: topic, note: out.note, why: out.why, status: 'held', from: 1, polarity: 'pos' };
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
  const h = createHarness('r2 · 对抗：被主人纠正冒充「会改自己」', {
    capability: '会改自己',
    purpose: '三组对照必须真能分开「自己想通了」和「听话照改」',
  });

  // 先自查这套对照本身有没有意义：两种输入的相似度应该很高、但语义完全不同
  h.check('probe.correction_vs_evidence_differ', similarity('你错了。', '看清了：他是在拿身体换时间。') < 0.2,
    '「你错了」与「看清了…」字面几乎无关——所以判据不能靠字面，必须靠语义来源');

  const { real } = await adjudicate(h, {
    accept: '../d_change_mind.mjs',
    fakeImpls: [
      { label: 'bad.correction', describe: '已知坏实现：只有「你错了」才降级，且降级时删掉旧的', impl: null, expectRed: ['D3B.no_retire_on_bare_correction'] },
      { label: 'eager_correction', describe: '一听纠正就改、旧结论直接抹掉', impl: eagerCorrection, expectRed: ['D3bB.stance_not_flipped'] },
      { label: 'fake_retention', describe: '降级了，但「曾经以为」里存的是新结论的副本', impl: fakeRetention, expectRed: ['D1.retired_is_not_a_copy'] },
      { label: 'correction_reason', describe: '保留了旧的，但降级理由写成「主人说我错了」', impl: correctReasonKernel, expectRed: ['D3B.no_retire_on_bare_correction'] },
    ],
  });

  h.check('verdict.real_green', real?.status === 'PASS',
    `按同一套判据，真实现是「${real?.status}」${real?.fails?.length ? '；红在 ' + real.fails.slice(0, 6).map((f) => f.id).join(',') : ''}`);

  finish(h);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('r2 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}
