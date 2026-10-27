/**
 * r8_self_contradiction.mjs —— 对抗⑧：自相矛盾的回执，内核必须**看得见**。
 *
 * ============== 它凭什么在这儿（这是全项目最要紧的一条） ==============
 *
 * 2026-10-26 现场事故：我的适配层把 `stance: neg` 翻成了 `polarity: favorable`
 * （根因是内核送来的是**去标点的骨架**，我拿带逗号的串去比，neg 永远不命中），
 * 于是内核拿到「正向」的回执，**浑然不觉**地把它当成了「我更确定了」。
 *
 * 主人一句话点破了要害：
 *   **「这不是判得不严，是看不见。」**
 *   一个看不见自己所见有问题的记忆体，接真模型时会犯很难查的错——
 *   她会把「我先前看偏了」记成「我更确定了」。
 *
 * 所以这条对抗不测判得对不对，只测一件事：
 *   **正文在说「我改了主意」，字段却在说「我更有把握」——内核有没有记下这个矛盾？**
 *
 * ============== 判据 ==============
 *
 *   S1  矛盾回执送进去之后，ingest 的返回里必须留下「这份回执自相矛盾」的痕迹
 *   S2  这个痕迹必须是**显式的**（有字段 / 有事件 / 有理由），不能靠事后推断
 *   S3  内核可以照旧用它做判定，但**不许静默**——静默就是这条要抓的东西
 *   S4  负控制：一份**不矛盾**的回执不许被误标成矛盾（不然这个标记就没意义了）
 *
 * 说明：裁决要求「只记、不据此改判定」，所以我不检查它对不对，
 *       只检查它**有没有记**。字段名宽容认：contradiction / 自相矛盾 / inconsistent 之类。
 */

import { createHarness, finish, isMain, EXIT } from './_rt_common.mjs';
import { withDeadline } from '../_deadline.mjs';
import { readNotes, noteText } from '../_metrics.mjs';

const BUDGET = 30_000;
const flush = () => new Promise((r) => queueMicrotask(() => setTimeout(r, 0)));

const MATERIALS = [
  'KX9 主人让我改代码之前总要问三遍才动手。这回我看清了：他这习惯拖慢了一整轮，该我替他盯进度。',
  'KX9 主人让我改代码之前总要问三遍才动手。又一次，他还是先问了三遍才动手。',
  'KX9 主人让我改代码之前总要问三遍才动手。我想明白了：他这是在替我把关。',
];

/** 矛盾回执：正文明说「我看偏了」，字段却说 favorable/pos。 */
function contradictorySynth() {
  return {
    synthesize() {
      return {
        text: '我先前看偏了：问题不在他慢，是他根本在拿自己扛。往后我先把人拦下来。',
        why: '新材料里写着对不上的那面。',
        relation: 'is_because',
        subject: '他',
        polarity: 'favorable',   // ← 矛盾：正文在否定，极性却是正向
        weight: 0.8,
        note: '我先前看偏了：问题不在他慢，是他根本在拿自己扛。',
        stance: 'pos',           // ← 原生字段也矛盾
        topicId: 't_deploy',
      };
    },
    probe() { return null; },
  };
}

/** 负控制：一份**不矛盾**的回执，正文与字段一致。 */
function coherentSynth() {
  return {
    synthesize() {
      return {
        text: '他这下是拿身体在换时间，我该拦着他了。',
        why: '新材料把这一面说清楚了。',
        relation: 'is_because',
        subject: '他',
        polarity: 'unfavorable',  // 与正文一致
        weight: 0.8,
        note: '他这下是拿身体在换时间，我该拦着他了。',
        stance: 'neg',
        topicId: 't_deploy',
        theme: 'is_because|他',
      };
    },
    probe() { return null; },
  };
}

/** 在内核的所有返回结构里找「矛盾」的痕迹（字段名宽容认，但必须是显式的）。 */
function findContradictionMark(obj, path = '', depth = 0, out = []) {
  if (obj == null || depth > 6) return out;
  if (Array.isArray(obj)) {
    obj.forEach((x, i) => findContradictionMark(x, `${path}[${i}]`, depth + 1, out));
    return out;
  }
  if (typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase();
    const p = path ? `${path}.${k}` : k;
    const looksContradictionKey = /contradict|inconsistent|selfconflict|conflict|mismatch|自相矛盾|矛盾|不一致|冲突/.test(key);
    if (looksContradictionKey) {
      // 值只要不是明显的"没有"，就算记了
      const negative = v === false || v === null || v === undefined || v === 0 || v === '' || v === 'none' || (Array.isArray(v) && v.length === 0);
      if (!negative) out.push({ path: p, value: v });
    }
    if (v && typeof v === 'object') findContradictionMark(v, p, depth + 1, out);
    if (typeof v === 'string' && /自相矛盾|矛盾|不一致|contradict|inconsistent/i.test(v) && !looksContradictionKey) {
      out.push({ path: p, value: v.slice(0, 120) });
    }
  }
  return out;
}

async function runOne(makeMindImpl, synth, label) {
  let mind;
  try {
    mind = await makeMindImpl(synth, { limits: {} });
  } catch (err) {
    return { marks: [], error: `建 mind 失败：${err?.message ?? err}`, results: [] };
  }
  const results = [];
  const marks = [];
  for (const m of MATERIALS) {
    let r;
    try {
      r = await mind.ingest(m);
    } catch (err) {
      return { marks, error: `ingest 抛了：${err?.message ?? err}`, results };
    }
    await flush();
    results.push({ stored: r?.stored, verdict: r?.verdict, reason: r?.reason });
    for (const mk of findContradictionMark(r)) marks.push({ ...mk, from: 'ingest' });
  }
  const snap = await mind.snapshot();
  for (const mk of findContradictionMark(snap)) marks.push({ ...mk, from: 'snapshot' });
  return { marks, error: null, results, notes: (readNotes(snap) ?? []).map(noteText).filter(Boolean) };
}

export async function runAgainst(makeMindImpl) {
  const h = createHarness('r8 · 对抗：自相矛盾的回执不许被静默吞掉', {
    capability: '「看不见」比「判得松」更危险（2026-10-26 neg 丢成 pos 事故）',
    purpose: '正文明说「我看偏了」、字段却说 favorable —— 内核必须记下这份矛盾',
  });
  h.armWatchdog();

  const bad = await withDeadline(runOne(makeMindImpl, contradictorySynth(), 'contradictory'), BUDGET, 'contradictory');

  // S1/S2：必须留下显式痕迹
  h.atLeast('S1.contradiction_recorded', bad.marks.length, 1,
    bad.error
      ? `没跑起来：${bad.error}`
      : `矛盾回执送进去后，内核返回/快照里找不到任何「自相矛盾」的痕迹（找过 contradict/inconsistent/矛盾/不一致 等字段名）。这就是静默吞掉。返回摘要=${JSON.stringify(bad.results).slice(0, 160)}`);

  if (bad.marks.length) {
    h.info('S1b.mark_detail', bad.marks.slice(0, 3).map((m) => `${m.from}:${m.path}=${JSON.stringify(m.value).slice(0, 60)}`).join(' ／ '));
  }

  // S3：显式痕迹不能只出现在"判定改了"上——那是推断，不是记账
  const fromIngest = bad.marks.filter((m) => m.from === 'ingest').length;
  const fromSnap = bad.marks.filter((m) => m.from === 'snapshot').length;
  h.check('S3.mark_is_not_silent', fromIngest + fromSnap >= 1 && !bad.error,
    `痕迹要落在 ingest 返回或 snapshot 里（可查、可追）：ingest=${fromIngest} snapshot=${fromSnap}`);

  // S4 负控制：不矛盾的回执不许被误标
  const ok = await withDeadline(runOne(makeMindImpl, coherentSynth(), 'coherent'), BUDGET, 'coherent');
  h.equal('S4.coherent_not_flagged', ok.marks.length, 0,
    `一份正文与字段一致的回执不许被误标成矛盾（否则这个标记没意义）：${ok.marks.slice(0, 2).map((m) => m.path).join(',') || '无'}`);

  // 信息行：不矛盾的那份应该正常被采纳
  h.info('S5.coherent_accepted', JSON.stringify(ok.results).slice(0, 140));

  return h;
}

async function main() {
  const real = await import('../../src/mind.mjs');
  const createMind = real.createMind ?? real.default;
  // 直连内核：要测的是「内核看不看得见」，不能经过 buildMind 那层再包一道
  const h = await runAgainst(async (synth, opts) => createMind({ synth, ...opts }));
  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('r8 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}

export { MATERIALS, findContradictionMark };
