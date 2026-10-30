/**
 * observe.mjs —— 把「她自己看见的东西」接进账本。
 *
 * ======================= 先纠正一件事 =======================
 *
 * 我之前说「她没有任何第一手观测」，这句话是错的。
 *
 * 她能看见：
 *   · 她的通道是完整 agent（preset: cordis），全套工具都在
 *   · 模型本身有识图能力，截图/看图走同一条 tool/result
 *   · 会话事件流里 `tool/call` / `tool/result` 一条不少，还带 `isError`
 *
 * 真正的断点在 `plugin/collect.mjs`：
 *   `source.kind` 白名单只认 `user / human / owner`，
 *   所以**工具结果一条都进不了熔的材料**。
 *
 * 链路于是变成：
 *   她看见 → 只活在那一轮上下文里 → compact 一遮 → 什么都没留下
 *   记忆里只留下「主人说过什么」，没有「我做过什么、成没成」
 *
 * **不是她没有眼睛，是眼睛看到的东西不入账。**
 *
 * ======================= 那记什么 =======================
 *
 * 不能把 296 条工具结果全记下来。那是过程，不是经历。
 *
 * 判据两条：
 *   1. **失败的** —— 人会记住「这事我搞砸了」，不会记住「我按了 50 次回车」
 *   2. **她特意出去的**（act 期间）—— 那是她主动去看的，正是「想弄明白」的闭环
 *
 * 成功且常规的调用不记。它不改变她对自己的看法。
 */

import { makeEvent } from './event.mjs';

export const OBSERVE_DEFAULTS = Object.freeze({
  /** 失败的调用一律记 */
  recordFailures: true,
  /** 成功的调用只在「她自己出去的」那一轮里记 */
  recordSuccessDuringAct: true,
  /**
   * ★ 2026-10-29 大乔加（主人定：成功也是她自己的记忆）：
   *   上面两条只记失败，等于她的账本里全是败绩——
   *   于是她只认识「我总在最末一步停下」「我总在动手前停住」，
   *   从来不认识「我做到过」。一个只记错的脑子，不是人脑。
   *
   *   但**不能什么成功都记**：她那套工具一分钟能跑几十次，
   *   全记下来就是流水账，而流水账正是这个插件要躲的东西。
   *
   *   所以只记「做成一件事」的那几种：写字、画画、改文件、跑通、看见东西。
   *   读目录、查文件、敲命令这类过程性的，成功不记（失败照记）。
   */
  recordSuccessTools: Object.freeze([
    'write', 'edit', // 她真的落下了一笔
    'read_image', // 她看见了什么
    'skill', // 她学会/用上了一样本事
    'qwen-image21-gen', 'krea2-comfyui-run', // 她真的画出了东西
  ]),
  /** 成功那一条也要有人味：不写「我用write做到了」，写「我写下了」 */
  successText: Object.freeze({
    write: '我写下了',
    edit: '我改好了',
    read_image: '我看清楚了',
    skill: '我学会了一样东西',
    'qwen-image21-gen': '我画出来了',
    'krea2-comfyui-run': '我画出来了',
  }),
  /** 一次最多记多少条（防一次 turn 里 300 个调用把账本淹掉） */
  maxPerBatch: 40,
});

/** 从宿主的会话事件流里，把工具调用配成「跑了什么、成没成」。 */
export function runsFromSessionEvents(events, { sinceSeq = 0 } = {}) {
  const list = Array.isArray(events) ? events : [];
  const calls = new Map();
  for (const e of list) {
    if (e?.type !== 'tool/call') continue;
    const id = e.data?.callId;
    if (!id) continue;
    calls.set(id, { tool: String(e.data?.name ?? 'unknown'), at: Number(e.at) || 0, seq: Number(e.seq) || 0 });
  }
  const runs = [];
  for (const e of list) {
    if (e?.type !== 'tool/result') continue;
    const seq = Number(e.seq) || 0;
    if (seq && seq < sinceSeq) continue;
    const m = e.data?.message;
    const id = m?.toolCallId;
    const c = calls.get(id);
    runs.push({
      tool: c?.tool ?? 'unknown',
      ok: !m?.isError,
      at: Number(c?.at) || Number(e.at) || 0,
      seq,
      callId: id ?? null,
    });
  }
  return runs;
}

/**
 * 把一次「她做了什么」转成观测。
 *
 * @param {object[]} runs
 * @param {object} [opts]
 * @param {boolean} [opts.duringAct] 这一轮是不是她自己出去的那一趟
 * @returns {object[]} event[]
 */
export function eventsFromRuns(runs, { duringAct = false, at = Date.now(), opts = {} } = {}) {
  const o = { ...OBSERVE_DEFAULTS, ...opts };
  const successTools = new Set(o.recordSuccessTools ?? []);
  const successText = o.successText ?? {};
  const out = [];
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!r) continue;
    const tool = String(r.tool ?? 'unknown');
    // 失败照记；成功分两种：
    //   ① 她自己出去那一趟 —— 全记（那是「想弄明白」的闭环）
    //   ② 平常 —— 只记「做成一件事」的那几种（主人定的：成功也是她的记忆）
    const interesting = (o.recordFailures && !r.ok)
      || (o.recordSuccessDuringAct && duringAct)
      || (r.ok && successTools.has(tool));
    if (!interesting) continue;
    const ownLine = r.ok ? successText[tool] : null;
    out.push(makeEvent({
      at: Number(r.at) || at,
      actor: '我',
      action: tool,
      polarity: r.ok ? 1 : -1,
      text: r.ok ? (ownLine ?? `我用${tool}做到了`) : `我用${tool}没成`,
      themeKey: null,
      source: duringAct ? 'act' : 'tool',
      weight: 0,
    }));
    if (out.length >= o.maxPerBatch) break;
  }
  return out;
}

export function createObserve(opts = {}) {
  return {
    ...OBSERVE_DEFAULTS,
    ...opts,
    runs: (events, o = {}) => runsFromSessionEvents(events, o),
    events: (runs, o = {}) => eventsFromRuns(runs, { opts, ...o }),
  };
}
