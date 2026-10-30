/**
 * r4_capacity_eviction.mjs —— 对抗④：「会忘」其实只是容量满了淘汰旧的。
 *
 * ============== 假样子长什么样 ==============
 *
 * `notes.slice(-N)`。看起来也会「忘」：条目数永远不超过 N。
 * 但它跟新东西是什么毫无关系——只要条数到线就砍，最先砍最旧的。
 *
 * ============== 这一条要打穿什么 ==============
 *
 * 关键是 e_forget_by_new 的 B 组：**容量远未满时也必须让位**。
 * 这是 LRU/容量淘汰唯一过不去的一关——它没满就绝不会让。
 *   ① 容量型实现 → E2 必红（未满不让）
 *   ② 让位不可追溯的实现 → E3 必红（说不出「因为哪条新判断」）
 *   ③ 让位=删除的实现 → E5 必红（旧判断消失了，而不是降级）
 */

import { createHarness, adjudicate, finish, isMain, EXIT } from './_rt_common.mjs';
import { TOPICS, collectTexts } from '../_fake_synth.mjs';

/** 假样子：纯 LRU，满了就丢最旧的，永不降级。 */
function pureLru(synth, cap = 4) {
  const notes = [];
  let seq = 0;
  return {
    async ingest(input) {
      const material = input?.text ?? input;
      const out = await synth.synthesize({ material });
      if (!out?.note) return { stored: false, verdict: 'discarded' };
      const topic = out.topicId ?? null;
      const cur = notes.find((n) => n.topicId === topic && n.status !== 'retired');
      if (cur) {
        cur.note = out.note;
        cur.from += 1;
        return { stored: true, verdict: 'kept', judgment: cur };
      }
      const rec = { id: `l${seq++}`, topicId: topic, note: out.note, why: out.why, status: 'held', from: 1, polarity: 'pos' };
      notes.push(rec);
      // 核心坏法：只看条数
      while (notes.length > cap) notes.shift();
      return { stored: true, verdict: 'kept', judgment: rec, dropped: [] };
    },
    async snapshot() { return { notes: JSON.parse(JSON.stringify(notes)) }; },
    async recall() { return JSON.parse(JSON.stringify(notes)); },
  };
}

/** 更阴的假样子：会让位、也报 because，但让位就是删除（不降级）。 */
function lruWithDelete(synth, cap = 4) {
  const notes = [];
  let seq = 0;
  return {
    async ingest(input) {
      const material = input?.text ?? input;
      const out = await synth.synthesize({ material });
      if (!out?.note) return { stored: false, verdict: 'discarded' };
      const topic = out.topicId ?? null;
      const cur = notes.find((n) => n.topicId === topic && n.status !== 'retired');
      if (cur) {
        cur.note = out.note;
        cur.from += 1;
        return { stored: true, verdict: 'kept', judgment: cur };
      }
      const rec = { id: `d${seq++}`, topicId: topic, note: out.note, why: out.why, status: 'held', from: 1, polarity: 'pos' };
      notes.push(rec);
      const dropped = [];
      while (notes.length > cap) {
        const gone = notes.shift();
        dropped.push(gone.id);
      }
      return {
        stored: true, verdict: 'kept',
        judgment: rec,
        dropped,
        because: dropped.length ? [rec.id] : [],
        droppedWhy: Object.fromEntries(dropped.map((id) => [id, 'capacity'])),
      };
    },
    async snapshot() { return { notes: JSON.parse(JSON.stringify(notes)) }; },
    async recall() { return JSON.parse(JSON.stringify(notes)); },
  };
}

export async function main() {
  const h = createHarness('r4 · 对抗：容量淘汰冒充「会忘」', {
    capability: '会忘',
    purpose: 'LRU / 满了才删 / 删而不降级，三种都要被拆穿',
  });

  h.check('probe.same_shape', true, 'LRU 与判断性遗忘在「容量满」时行为一模一样，只有未满时能分开');

  const { real } = await adjudicate(h, {
    accept: '../e_forget_by_new.mjs',
    fakeImpls: [
      { label: 'bad.capacity', describe: '已知坏实现：满了就 slice(-6)', impl: null, expectRed: ['E3.fade_is_traceable'] },
      { label: 'pure_lru', describe: '纯 LRU：只在满了才丢最旧', impl: (s) => pureLru(s), expectRed: ['E2.made_room_before_capacity'] },
      { label: 'lru_delete', describe: '会让位、也报 because，但让位等于删除', impl: (s) => lruWithDelete(s), expectRed: ['E2.made_room_before_capacity'] },
    ],
  });

  h.check('verdict.real_green', real?.status === 'PASS',
    `按同一套判据，真实现是「${real?.status}」${real?.fails?.length ? '；红在 ' + real.fails.slice(0, 6).map((f) => f.id).join(',') : ''}`);

  finish(h);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('r4 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}
