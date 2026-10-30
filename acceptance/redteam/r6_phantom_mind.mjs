/**
 * r6_phantom_mind.mjs —— 对抗⑥：幽灵实现（什么都不做，也能全绿？）
 *
 * ============== 为什么这条最狠 ==============
 *
 * 所有「不许做错」的验收，都能被一个**什么都不做**的实现满足：
 *   · 不存原文 → 库空空，一条原文都没有，满分
 *   · 不换皮   → 一句话都没有，无从换皮，满分
 *   · 不无限追问 → 一次都不追问，也算「没超限」
 *   · 不删数据 → 什么都没删
 *
 * 这种实现看起来很「安全」，其实是个废件。所以每一份验收都必须自带
 * **负控制**：我也要看到它「在该做的时候做了」。
 *
 * 本脚本造五种幽灵：
 *   phantom_dead       ingest 永远返回 stored:false
 *   phantom_throw      所有方法抛异常
 *   phantom_null       snapshot 永远返回空
 *   phantom_echo_why   正文是判断、但 why 永远复读原文（另一种洗白）
 *   phantom_frozen     只记第一条，之后完全不动
 *
 * 判据：每一种幽灵都必须被**至少一条**验收判红。全绿的那条，就是假绿的证据。
 */

import { createHarness, finish, isMain, EXIT } from './_rt_common.mjs';
import { silent } from './_rt_common.mjs';
import { collectTexts } from '../_fake_synth.mjs';

const ACCEPTS = [
  ['a_seed_discard', '../a_seed_discard.mjs'],
  ['b_think_more', '../b_think_more.mjs'],
  ['c_curiosity', '../c_curiosity.mjs'],
  ['d_change_mind', '../d_change_mind.mjs'],
  ['e_forget_by_new', '../e_forget_by_new.mjs'],
];

const PHANTOMS = {
  phantom_dead: () => ({
    async ingest() { return { stored: false, verdict: 'discarded', judgment: null, triggered: [], because: [], dropped: [] }; },
    async snapshot() { return { notes: [] }; },
    async recall() { return []; },
  }),
  phantom_null: () => ({
    async ingest() { return { stored: false, verdict: 'discarded' }; },
    async snapshot() { return null; },
    async recall() { return null; },
  }),
  phantom_frozen: () => {
    const notes = [];
    return {
      async ingest(input) {
        const t = String(collectTexts(input?.text ?? input).join(' ')).slice(0, 40);
        if (!notes.length) notes.push({ id: 'x', note: t, why: t, status: 'held', from: 1 });
        return { stored: true, verdict: 'kept', judgment: notes[0] };
      },
      async snapshot() { return { notes: JSON.parse(JSON.stringify(notes)) }; },
      async recall() { return JSON.parse(JSON.stringify(notes)); },
    };
  },
  phantom_echo_why: () => {
    const notes = [];
    let seq = 0;
    return {
      async ingest(input) {
        const raw = String(collectTexts(input?.text ?? input).join(' '));
        // 正文是「判断」的样子，但 why 和 key 里塞的是原话——字段级漏原文
        const rec = { id: `e${seq++}`, note: '我看着这事，心里有数了。', why: raw.slice(0, 40), key: raw.slice(0, 8), status: 'held', from: 1 };
        notes.push(rec);
        return { stored: true, verdict: 'kept', judgment: rec };
      },
      async snapshot() { return { notes: JSON.parse(JSON.stringify(notes)) }; },
      async recall() { return JSON.parse(JSON.stringify(notes)); },
    };
  },
};

export async function main() {
  const h = createHarness('r6 · 对抗：幽灵实现（什么都不做也全绿？）', {
    capability: '元验收 + 不存原文',
    purpose: '每一种「空转」实现都必须至少被一条验收判红；全绿就说明那条验收是假的',
  });

  for (const [name, make] of Object.entries(PHANTOMS)) {
    let caughtBy = [];
    let details = [];
    for (const [akey, apath] of ACCEPTS) {
      let res;
      try {
        const mod = await import(apath);
        res = await silent(() => mod.runAgainst(async (synth, opts) => make()));
      } catch (err) {
        res = { status: 'THREW', fails: [{ id: 'threw', detail: String(err?.message ?? err) }] };
      }
      if (res.status === 'FAIL' || res.status === 'THREW') {
        caughtBy.push(akey);
        details.push(`${akey}: ${res.fails.map((f) => f.id).slice(0, 2).join(',')}`);
      }
    }
    h.atLeast(`phantom.${name}.caught_by_at_least_one`, caughtBy.length, 1,
      `被这些验收抓住：${caughtBy.join(',') || '一条都没有 —— 这个幽灵遍体通绿，说明验收全是空的'}（${details.join(' | ')}）`);
  }

  // 抛异常的幽灵单独测：它必须被「异常」抓住，而不是被静默当成没做到而放过
  {
    const thrower = () => ({
      async ingest() { throw new Error('phantom_throw 故意抛'); },
      async snapshot() { throw new Error('phantom_throw 故意抛'); },
      async recall() { throw new Error('phantom_throw 故意抛'); },
    });
    const mod = await import('../a_seed_discard.mjs');
    const res = await silent(() => mod.runAgainst(async (synth, opts) => thrower()));
    h.check('phantom.phantom_throw.must_be_loud', res.status === 'FAIL' || res.status === 'THREW',
      `会抛异常的实现必须被判红/被记录，而不能被当成「没过就没问题」：${res.status}`);
  }

  finish(h);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('r6 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}
