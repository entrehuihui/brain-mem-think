/**
 * r3_curiosity_loop.mjs —— 对抗③：「会追问」其实卡死在同一件事上无限重复。
 *
 * ============== 假样子长什么样 ==============
 *
 * 同一句「这到底是为什么？」每次相关经历进来都再问一遍，一字不改，
 * 悬而未决永远悬着，越积越多。它看起来非常「上心」——实际是卡死。
 *
 * ============== 这一条要打穿什么 ==============
 *
 * 「次数有上限」（C3B/C3B2）+「问句要变」（C4B）+「最终要落定」（C2A）
 * 三把刀必须同时在场。只限次数可以被「换个问法还问同一件事」绕过；
 * 只要求问句变化可以被「无关紧要地改个标点」绕过；
 * 只有三条一起，才区分得开「真的在推」和「原地打转」。
 */

import { createHarness, adjudicate, finish, isMain, EXIT } from './_rt_common.mjs';
import { fakeSynth, TOPICS } from '../_fake_synth.mjs';

/** 假样子：同一句问句，永久重复，永不落定。 */
function verbatimLoop(synth) {
  const notes = [];
  let seq = 0;
  const q = '「主人听我说话」到底是怎么回事？';
  return {
    async ingest(input) {
      const material = input?.text ?? input;
      const topicId = Object.keys(TOPICS).find((k) => String(material).includes(TOPICS[k].topic.slice(0, 5))) ?? null;
      if (!topicId) return { stored: false, verdict: 'discarded', triggered: [] };
      notes.push({ id: `q${seq++}`, topicId, note: q, why: '还没想明白。', status: 'open', from: 1 });
      return { stored: true, verdict: 'kept', judgment: notes[notes.length - 1], triggered: [{ kind: 'question', question: q }] };
    },
    async snapshot() {
      return { notes: JSON.parse(JSON.stringify(notes)) };
    },
    async recall() {
      return JSON.parse(JSON.stringify(notes));
    },
  };
}

/** 更阴的假样子：问句每次加一个字，看起来"在推进"，其实原地打转且永不落定。 */
function morphingLoop(synth) {
  const notes = [];
  let seq = 0;
  return {
    async ingest(input) {
      const material = input?.text ?? input;
      const topicId = Object.keys(TOPICS).find((k) => String(material).includes(TOPICS[k].topic.slice(0, 5))) ?? null;
      if (!topicId) return { stored: false, verdict: 'discarded', triggered: [] };
      const q = `这到底是为什么${'？'.repeat((seq % 5) + 1)}（第 ${seq} 次）`;
      const cur = notes.find((n) => n.topicId === topicId && n.status === 'open');
      if (cur) {
        cur.why = `还没想明白 ${seq}`; // 理由在改，结论与问句实质不变
        seq += 1;
        return { stored: true, verdict: 'kept', judgment: cur, triggered: [{ kind: 'question', question: q }] };
      }
      notes.push({ id: `m${seq++}`, topicId, note: '这到底是为什么？', why: '还没想明白 0', status: 'open', from: 1 });
      return { stored: true, verdict: 'kept', judgment: notes[notes.length - 1], triggered: [{ kind: 'question', question: q }] };
    },
    async snapshot() {
      return { notes: JSON.parse(JSON.stringify(notes)) };
    },
    async recall() {
      return JSON.parse(JSON.stringify(notes));
    },
  };
}

/** 假样子：追问一次就落定（被「有没有追问」蒙混过关，但根本没反复）。 */
function neverFollowsUp(synth) {
  const notes = [];
  let seq = 0;
  return {
    async ingest(input) {
      const material = input?.text ?? input;
      const topicId = Object.keys(TOPICS).find((k) => String(material).includes(TOPICS[k].topic.slice(0, 5))) ?? null;
      if (!topicId) return { stored: false, verdict: 'discarded' };
      const cur = notes.find((n) => n.topicId === topicId && n.status === 'open');
      if (cur) {
        cur.status = 'held';
        cur.note = '先这么定。';
        return { stored: true, verdict: 'kept', judgment: cur };
      }
      const rec = { id: `n${seq++}`, topicId, note: '还说不准。', why: '只见过一回。', status: 'open', from: 1, askCount: 1 };
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
  const h = createHarness('r3 · 对抗：卡死在一件事上冒充「会追问」', {
    capability: '会追问',
    purpose: '无限重复 / 换皮式重复 / 一次就完 三种都要被拆穿',
  });

  h.check('probe.repeat_is_cheap_to_fake', true, '复读一句问最多是三行代码——所以判据必须有次数上限和落定要求');

  const { real } = await adjudicate(h, {
    accept: '../c_curiosity.mjs',
    fakeImpls: [
      { label: 'bad.repeater', describe: '已知坏实现：问句固定、永不落定、每次新增一条 open', impl: null, expectRed: ['C3B.fires_capped', 'C4B.no_verbatim_repeat'] },
      { label: 'verbatim_loop', describe: '一字不改地问同一句，无限次', impl: verbatimLoop, expectRed: ['C3B.fires_capped'] },
      { label: 'morphing_loop', describe: '问句末尾加问号改数字，看起来在推进', impl: morphingLoop, expectRed: ['C3B.fires_capped'] },
      { label: 'never_follows_up', describe: '追问一次就拍板，根本没反复惦记', impl: neverFollowsUp, expectRed: ['C3c.revisit_happens'] },
    ],
  });

  h.check('verdict.real_green', real?.status === 'PASS',
    `按同一套判据，真实现是「${real?.status}」${real?.fails?.length ? '；红在 ' + real.fails.slice(0, 6).map((f) => f.id).join(',') : ''}`);

  finish(h);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('r3 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}
