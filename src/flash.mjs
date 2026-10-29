/**
 * flash.mjs —— 记忆库门面。
 *
 * 它为什么在这儿：
 * 上层（宿主、注入提示词的那一段）只该看见三样东西：
 * 现在脑子里有什么（snapshot）、碰到这件事我能想起什么（recall）、
 * 和此刻我带着哪些没想明白的事（digest）。它不该知道判断怎么烧出来、
 * 位置怎么腾——那些是 forge / fade / revision 的活。
 *
 * 所有对外形态都过一遍 toNote()：只吐判断、理由、谓词、份量、状态和来路，
 * 不吐原文。原文根本没有进过这张表，这里只做最后一层保险。
 *
 * 语气全在 clause() / lines() 这两个函数里成型，别处不许自己拼句子：
 *   - 悬而未决：说清「为什么悬着」，不带「我会想想」这类将来时的空承诺；
 *   - 成立：一句话，不修饰；
 *   - 曾经这么以为：拆成三行——以前以为 / 后来为什么改 / 现在怎么想。
 * 这是她读自己的话，不是在念清单。
 *
 * 三种退休（被自己推翻 / 追不动认了 / 被新的挤沉）靠 retireKind 字段分开，
 * 不是靠中文字面量去猜：改文案不该改行为。
 */

import { STATUS, similarity } from './judge.mjs';
import { CURIOSITY_DEFAULTS } from './curiosity.mjs';

/** 对外状态只有三个词：open / held / retired。内部 enum 不往外漏。 */
export const PUBLIC_STATUS = Object.freeze({
  [STATUS.PENDING]: 'open',
  [STATUS.HELD]: 'held',
  [STATUS.OVERTURNED]: 'retired',
  [STATUS.ESTEEMED]: 'retired',
});

export function toNote(b) {
  const status = PUBLIC_STATUS[b.status] ?? 'retired';
  // 沉不下去的东西不该有「曾经这么以为」那一段：它只是被新的挤走了。
  const gone = b.forgottenBecause != null;
  const note = {
    id: b.id,
    themeKey: b.themeKey,
    themeSource: b.themeSource ?? null,
    kind: b.kind ?? 'episodic',
    stage: b.stage ?? null,
    subject: b.subject,
    note: b.text,
    why: b.why,
    relation: b.relation,
    polarity: b.polarity,
    weight: b.weight,
    // ★ 2026-10-28：底气（证据算出来的）和 weight（模型觉得多重）分开给。
    //   所有决策读 strength；weight 留着只为审计「模型偏了多少」。
    strength: b.strength ?? b.weight ?? 0,
    // ★ 2026-10-28（阶段三）：扎心度跟着判断一起出门。
    //   fading / wake / world 都读它——不带上，这一层就只是个存着的数。
    sting: Number(b.sting ?? 0),
    status,
    from: b.turns.length,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    reasons: [...(b.reasons ?? [])],
    tension: b.tension ? { ...b.tension } : null,
    // 「我惦记着这件事」的痕迹：问句、问过几次、最近一次什么时候。
    question: b.asked ?? null,
    lastQuestion: b.asked ?? null,
    askCount: b.curiosityFired ?? 0,
    // ★ 2026-10-27 大乔补：追问计数原来只导出成 askCount，
    //   而 curiosity 写在 store 里的字段名是 curiosityFired。
    //   验收按 curiosityFired 读，于是永远是 undefined——
    //   「数据造出来了、没送到」的又一次。两个名字都给，谁读都不用猜。
    curiosityFired: b.curiosityFired ?? 0,
    lastFired: b.lastFired ?? null,
    touches: b.touches ?? 0,
    asked: b.asked ?? null,
    askAt: b.tension?.lastAt ?? b.settledFrom?.lastAt ?? null,
    settledFrom: b.settledFrom ? { ...b.settledFrom } : null,
    turns: (b.turns ?? []).map((t) => ({ ...t })),
    retiredBecause: null,
    // 「沉下去了」是被新的挤出去，不是被自己推翻：类型由字段决定，文案只是给人看的。
    forgotten: b.forgottenBecause != null,
    forgottenBecause: b.forgottenBecause ?? null,
    retireKind: b.retireKind ?? null,
    was: b.was ? { ...b.was } : null,
    nowNote: null,
    overturnedBy: b.overturnedBy,
  };
  if (status === 'retired') {
    note.retiredBecause = gone ? null : (b.overturnedReason ?? '曾经这么以为');
    // 「现在」那一句：顶替它的那条把话接过去了（mind 在翻转时写），没有就用它自己最后的话。
    if (!gone) note.nowNote = b.nowNote ?? b.text ?? null;
    // 没走过 revision（追不动认了），从轨迹里补一个「曾经的话」。
    if (!gone && !note.was) {
      const first = b.turns[0];
      note.was = first
        ? { text: first.text, why: undefined, relation: first.relation, polarity: first.polarity, status: 'held', at: first.at }
        : null;
    }
  }
  return note;
}

function tensionWhy(note) {
  const why = note?.tension?.why;
  return typeof why === 'string' && why.trim() ? why.trim() : '';
}

/**
 * 一句话。注入层只该调这一个或 lines()，没有第三条路。
 * 不带任何将来时承诺——那是空话，不是想。
 * @param {object|string} note  toNote() 的结果
 * @param {{pool?: string[]}} ctx  调用方手上的现役正文；给了才做「别复述」的减法
 */
export function clause(note, ctx = {}) {
  if (typeof note === 'string') return note;
  const s = note?.note;
  if (!s) return '';
  const status = note?.status;
  if (status === 'open') {
    const why = tensionWhy(note);
    return why ? `还没想明白：${s}——${why}` : `还没想明白：${s}`;
  }
  if (status === 'retired') {
    const lines = linesOf(note);
    if (!lines.length) return '';
    // 「现在」那句如果现役那条正在说，这里不再复述一遍——她刚说完，不用我重复。
    const head = lines.find((l) => l.startsWith('现在我是这么想的'));
    const pool = Array.isArray(ctx?.pool) ? ctx.pool : null;
    if (head && pool && pool.includes(head.slice('现在我是这么想的：'.length))) {
      return lines.filter((l) => l !== head).join('\n');
    }
    return lines.join('\n');
  }
  return s;
}

/**
 * 多行形态。一句话撑不下「改的过程」，这里撑得下。
 * @returns {string[]}
 */
export function linesOf(note) {
  if (typeof note === 'string') return [note];
  const s = note?.note;
  if (!s) return [];
  const status = note?.status;
  if (status === 'open') return [clause(note)];
  if (status === 'held') return [s];
  if (status === 'retired') {
    // 沉下去的别摆出来：她不需要每轮都被提醒自己忘了什么。
    if (note.forgotten) return [];
    const ended = note.was ?? note.turns?.[0] ?? null;
    const said = ended?.text;
    const now = note.nowNote ?? s;   // 换了一条现役记录时，刚熔出来的那句才是「现在」
    const gave = note.retiredBecause
      || (note.retireKind === 'abandoned' ? '追了几次都没拿到准信，认了' : '');
    return [
      said ? `我以前这么以为：${said}` : '我以前是另外一种看法',
      `后来不这么想了：${gave || '自己看明白了'}`,
      `现在我是这么想的：${now}`,
    ];
  }
  return [s];
}

export class Flash {
  constructor(store, opts = {}) {
    this.store = store;
    this.opts = opts;
  }

  get notes() {
    return this.store.all;
  }

  snapshot({ includeRetired = true } = {}) {
    const all = this.store.all.map(toNote);
    return {
      notes: includeRetired ? all : all.filter((n) => n.status !== 'retired'),
      open: all.filter((n) => n.status === 'open').length,
      held: all.filter((n) => n.status === 'held').length,
      retired: all.filter((n) => n.status === 'retired').length,
      size: all.length,
    };
  }

  /**
   * 我欠着没想明白的。份量与「快压到位了」一并给出——
   * 阈值和 curiosity 同源（改一处两处一起变），注入层不用自己算，也不用数次数猜。
   */
  pendingQuestions({ maxPush = CURIOSITY_DEFAULTS.maxPush, maxWeight = CURIOSITY_DEFAULTS.maxWeight } = {}) {
    return this.store.all
      .filter((b) => b.status === STATUS.PENDING)
      .sort((a, b) => (b.curiosityFired ?? 0) - (a.curiosityFired ?? 0))
      .map((b) => ({
        id: b.id,
        note: b.text,
        themeKey: b.themeKey,
        subject: b.subject,
        weight: b.weight,
        strength: b.strength ?? b.weight ?? 0,
        overweight: (b.strength ?? b.weight ?? 0) >= maxWeight,
        asked: b.curiosityFired ?? 0,
        left: Math.max(0, maxPush - (b.curiosityFired ?? 0)),
        maxPush,
        since: b.tension?.since ?? b.createdAt,
        why: tensionWhy({ tension: b.tension }) || '',
        line: clause(toNote(b)),
      }));
  }

  /**
   * 碰到这件事，能想起哪些。按字面重合 + 主题键 + 份量排序。
   * 不返回原文，也不预存拼好的句子——渲染只走 clause() / lines()，改哪一处就生效哪一处。
   */
  recall(query, { limit = 6, includeRetired = true } = {}) {
    const q = String(query?.text ?? query ?? '');
    const hints = new Set((query?.hints ?? []).map(String));
    const scored = this.store.all
      .map((b) => {
        const rel = similarity(`${b.text}${b.why}`, q);
        const keyHit = hints.has(b.themeKey) || (query?.themeKey && b.themeKey === query.themeKey) ? 0.5 : 0;
        const live = b.status === STATUS.PENDING || b.status === STATUS.HELD ? 0.25 : 0.05;
        return { b, score: rel + keyHit + live + b.weight * 0.3 };
      })
      .filter((x) => x.score > 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored
      .map((x) => {
        const n = toNote(x.b);
        if (!includeRetired && n.status === 'retired') return null;
        return { ...n, score: Math.round(x.score * 1000) / 1000 };
      })
      .filter(Boolean);
  }

  /**
   * 一小段现成话，直接喂进 systemPrompt 的那种。
   * 次序 open → held → retired：悬而未决的最该跟她过这一轮，垫底就会被截掉。
   */
  digest({ maxOpen = 2, maxHeld = 3, maxRetired = 1 } = {}) {
    const notes = this.store.all;
    const pick = (s, n) => (n > 0 ? notes.filter((b) => b.status === s).slice(-n) : []);
    const lines = [];
    for (const b of pick(STATUS.PENDING, maxOpen)) lines.push(clause(toNote(b)));
    for (const b of pick(STATUS.HELD, maxHeld)) lines.push(clause(toNote(b)));
    // 沉下去的不摆；被推翻/认了的，同一主题只摆最近一条，且不跟现役重复。
    const pool = lines.slice();
    const seen = new Set();
    for (const b of [...notes].reverse()) {
      if (lines.length >= maxOpen + maxHeld + maxRetired) break;
      if (b.status !== STATUS.ESTEEMED || b.forgottenBecause != null) continue;
      if (seen.has(b.themeKey)) continue;
      seen.add(b.themeKey);
      const one = clause(toNote(b), { pool });
      if (one) lines.push(one);
    }
    return { lines, text: lines.join('\n') };
  }

  /** 沉下去的。判据是 forgottenBecause 这个字段，不是「沉下去了」这四个字。 */
  forgets() {
    return this.store.all
      .filter((b) => b.forgottenBecause != null)
      .map(toNote);
  }
}

export function createFlash(store, opts = {}) {
  return new Flash(store, opts);
}

export { STATUS };
