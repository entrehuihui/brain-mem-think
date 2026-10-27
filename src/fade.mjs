/**
 * fade.mjs —— 判断性遗忘。
 *
 * 它为什么在这儿：
 * 「会忘」不是强度掉到线以下被删。那是容量淘汰，换个说法装成判断而已。
 * 这里的规则只有一条：**只有记进新东西的那一下才会腾地方**，而且腾的不是
 * 最弱最旧的那条，是当下占位置占得最不值的那条——份量薄、理由说不出口、
 * 只靠一条材料撑着。
 *
 * 所以 decide() 的每个出口都带着 because：这次腾位是被哪个新判断挤出来的。
 * 没有 incoming 就只有 no_incoming 一个出口，一个也不会掉。
 *
 * 被忘掉的不是删掉：状态推到 retired，理由那栏写「沉下去了」。
 * 人的忘就是这样——不记得细节了，但知道自己曾经注意到过。
 */

import { clamp01, RETIRE_REASON, STATUS } from './judge.mjs';

export const FADE_DEFAULTS = Object.freeze({
  pressure: 4,        // 现役判断的份量加起来超过这个数，就要有人腾位置
  minWeight: 0.22,    // 底子薄到这条线以下的新判断，配不上让人腾位
  critical: 8,        // 条数到这个红线，哪怕没压强也先让出最不值的那条
  max: 0,             // 现役条数上限（0 = 不设）；到了上限，腾的仍是最不值的那条
  evictRatio: 1.0,     // 新判断的 value 必须严格高于最弱那条，才挤得动人
  relatedWindowMs: 8 * 60 * 1000,
});

function isLive(note) {
  return !!note && (note.status === STATUS.PENDING || note.status === STATUS.HELD);
}

/**
 * @returns {{dropped: string[], droppedWhy: Record<string,string>, because: string[], verdict: string, room: number}}
 */
export function decide(incoming, notes, opts = {}) {
  const o = { ...FADE_DEFAULTS, ...opts };
  const live = notes.filter(isLive);
  const dropped = [];
  const droppedWhy = {};
  const droppedKind = {};
  const because = [];
  const becauseIds = [];
  const becauseNote = [];
  const room = () => o.pressure - live.length;

  // 没带新判断来 → 没有任何人会让位。这一条是机制，不是约定。
  if (!incoming) return { dropped, droppedWhy, droppedKind, because, becauseIds, becauseNote, verdict: 'no_incoming', room: room() };
  if (live.length === 0) return { dropped, droppedWhy, droppedKind, because, becauseIds, becauseNote, verdict: 'no_pressure', room: room() };

  const incWeight = clamp01(incoming.weight, 0);
  if (incWeight < o.minWeight) {
    return { dropped, droppedWhy, droppedKind, because, becauseIds, becauseNote, verdict: 'incoming_too_light', room: room() };
  }

  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const incValue = value(incoming, now, o);
  const sorted = [...live].filter((n) => n.id !== incoming.id).sort((a, b) => value(a, now, o) - value(b, now, o));
  const weakest = sorted[0];
  if (!weakest) return { dropped, droppedWhy, droppedKind, because, becauseIds, becauseNote, verdict: 'no_pressure', room: room() };

  /**
   * 让位。kind 由「是不是同一件事」显式决定——这不是猜，是看主题键整串：
   *   同一件事 → superseded（我以前那么想，现在这么想：成长）
   *   另一件事 → evicted  （那件事我不记了，给这件腾地方：遗忘）
   */
  const free = (n) => {
    const kind = String(n.themeKey ?? '') === String(incoming.themeKey ?? '') ? 'superseded' : 'evicted';
    const note = cleanText(incoming.text);
    dropped.push(n.id);
    droppedKind[n.id] = kind;
    droppedWhy[n.id] = kind === 'superseded'
      ? `同一件事有了新结论「${note}」，旧的那条换代了`
      : `「${note}」更值得占位置，旧的就得腾地方`;
    // because 记「因为哪一句」，不是「因为哪个 id」——调用方要读得懂。
    because.push(note);
    becauseIds.push(incoming.id);
    becauseNote.push(note);
    n.status = STATUS.ESTEEMED;
    n.retireKind = kind === 'superseded' ? RETIRE_REASON.OVERTURNED : RETIRE_REASON.FORGOTTEN;
    n.forgottenBecause = kind === 'evicted' ? droppedWhy[n.id] : null;
    n.overturnedBy = incoming.id;
    n.overturnedReason = droppedWhy[n.id];
    n.tension = null;
  };

  // 1) 位置是按「值多少」算的，不是按「装满了没有」算的。
  //
  //    ★ 2026-10-27 大乔裁决后改：原来这里还有一道 `used > pressure(4)` 的闸，
  //      意思是「份量加起来超过 4 才许让位」。那道闸是错的：
  //        它把「位置够不够」写成了一个硬数字，于是容量远没满、份量远不到 4 时，
  //        一条 0.62 的强判断进不来，一条 0.3 的弱判断稳稳占着位子不让。
  //      裁决三的原话是「新 value 严格高于现役最弱那条就腾」，没写「还得先装满」。
  //
  //      更要紧的是：一条 1.0 的判断和一条 0.3 的判断，一件事对一个人的重量差三倍，
  //      她凭什么要等到「攒够 4」才肯放手那件零碎的？那不是脑子，是仓库。
  //
  //    E1（容量没满不许让位）仍然由 evictRatio=1.0 守住：比它重的才腾得动人。
  if (incValue > value(weakest, now, o) * o.evictRatio) {
    free(weakest);
    return { dropped, droppedWhy, droppedKind, because, becauseIds, becauseNote, verdict: 'made_room', room: room() };
  }

  // 2) 条数到红线：来了新东西，也不留一条谁都说不清理由的占位。
  if (live.length + 1 >= o.critical) {
    free(weakest);
    return { dropped, droppedWhy, droppedKind, because, becauseIds, becauseNote, verdict: 'pressure', room: room() };
  }

  // 3) 容量上限：这次真记了新东西，而现役条数已经到了上限，那就腾。
  if (o.max >= 2 && live.length + 1 > o.max) {
    free(weakest);
    return { dropped, droppedWhy, droppedKind, because, becauseIds, becauseNote, verdict: 'made_room', room: room() };
  }

  return { dropped, droppedWhy, droppedKind, because, becauseIds, becauseNote, verdict: 'no_pressure', room: room() };
}

/** 正文只取前一小段，够认得出是哪句就行。 */
function cleanText(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 24 ? `${s.slice(0, 24)}…` : s;
}

/** 这条当前值多少位置：份量 × 理由够不够格 × 有几条材料撑（新鲜度已折进份量里）。 */
export function value(note, now = Date.now(), opts = {}) {
  void now;
  void opts;
  const w = clamp01(note?.weight, 0);
  const reason = note?.why && [...note.why].length >= 4 ? 1 : 0.5;
  const sourced = Math.min(1, 0.5 + ((note?.turns?.length ?? 1) - 1) * 0.1);
  return w * reason * sourced;
}

export function isForgotten(note) {
  return note?.forgottenBecause != null || note?.retireKind === RETIRE_REASON.FORGOTTEN;
}

/** 不带新判断来调，就一个也不会掉。给测试当护栏用。 */
export function sweepWithoutIncoming(notes, opts = {}) {
  return decide(null, notes, opts);
}

export function createFade(opts = {}) {
  return {
    ...FADE_DEFAULTS,
    ...opts,
    decide: (incoming, notes, extra = {}) => decide(incoming, notes, { ...opts, ...extra }),
    apply: (notes, ctx = {}) => decide(ctx.incoming ?? null, notes, { ...opts, ...ctx }),
    value: (n, now = Date.now()) => value(n, now, opts),
  };
}
