/**
 * wake.mjs —— 自我唤醒 → 思考 → 决定要不要开口。
 *
 * 它为什么在这儿：
 * 她不是为了回答才存在的。她是记着事，自己决定要不要开口。
 * 这个模块只回答一个问题：这一次醒来，该说话，还是不该说话。
 *
 * 三条铁律（写进机制，不靠自觉）：
 *   1. 唤醒的频率由「心事的重量」决定，不由时间决定。压得重就常醒，没什么想法就少醒。
 *   2. 「不说」是合法且重要的决定。连续 10 次醒来，至少 3 次要说「不说」——
 *      永远在说话的人不是在思考，是在吵。
 *   3. 她说的每一句，若值得，都会变成记忆，而不是一条聊天记录。
 *
 * ★ 「醒」和「跑」是两件事：
 *   - 决策在 followup 之前完成。她想完了才叫，silent 就压根不调 followup。
 *   - followup 一叫就 running，没机会再反悔；所以「要不要说」必须在这之前定死。
 *   - 调之前先看 agent.status，running 就这一轮跳过、不排队——
 *     主人和她同时开口会变成两条消息一起进 inbox，那是吵，不是想。
 *   - 配额与哈希每次决策后立刻落盘，去重放在唯一出口里（不在调用方），跨重启读回。
 *
 * 纯逻辑：不接宿主、不读时钟（时间从外面给），可单测。
 */

import { STATUS } from './judge.mjs';

export const WAKE_DEFAULTS = Object.freeze({
  // 醒来之后，多久之内不再醒（由心事重量决定，不由时间表决定）
  minGapMs: 3 * 60 * 1000,
  maxGapMs: 75 * 60 * 1000,
  // 说话的门槛：压着的事得够重、且确实有想说的
  speakWeight: 0.55,
  speakOpenCount: 1,
  // 刚说完话，短时间内不该再说
  quietAfterSpeakMs: 18 * 60 * 1000,
  // 沉默的配额：至少这个比例要闭嘴
  minSilentRatio: 0.3,
  // 同一句话在这么久之内不许再说第二次
  repeatWindowMs: 6 * 60 * 60 * 1000,
});

function isLive(n) {
  return n && (n.status === STATUS.PENDING || n.status === STATUS.HELD);
}

/**
 * 判断库的指纹：只用「有意义的那几样」算。
 * relation / polarity / weight（取整档）/ 条数 / open 的 id 集合。
 * **不算**时间戳、from、计数器和任何会自己动的字段——
 * 否则「库其实没变」会被算成「在变」，判据就废了。
 */
export function hashLedger(notes) {
  const live = (notes ?? []).filter((n) => n && (n.status === 'held' || n.status === 'pending'));
  const parts = live
    .map((n) => [
      n.themeKey ?? '',
      n.relation ?? '',
      String(n.polarity ?? ''),
      Math.round((Number(n.weight) || 0) * 10),
      n.status ?? '',
    ].join('/'))
    .sort();
  const openIds = live.filter((n) => n.status === 'pending').map((n) => n.id ?? '').sort().join(',');
  const blob = `${parts.join('|')}#${parts.length}#${openIds}`;
  let h = 2166136261;
  for (let i = 0; i < blob.length; i += 1) {
    h ^= blob.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** 同一句话的指纹：用来判「这句我说过了」。 */
export function hashSay(say) {
  const s = String(say ?? '').replace(/\s+/g, '').toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** 心事有多重：压着的判断越多越重，悬着的更重（想不明白才惦记）。 */
export function burdenOf(notes) {
  const live = (notes ?? []).filter(isLive);
  if (!live.length) return { burden: 0, heaviest: null, open: 0 };
  const open = live.filter((n) => n.status === STATUS.PENDING);
  const heaviest = [...live].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];
  // 重 = 最重那条的份量 + 悬案带来的挂心
  const burden = Math.max(0, Math.min(1, (heaviest?.weight ?? 0) * 0.8 + open.length * 0.12));
  return { burden: Number(burden.toFixed(3)), heaviest, open: open.length };
}

/** 下一次该多久以后醒：心事越重，醒得越勤。这不是闹钟，是心跳。 */
export function nextGapMs(notes, opts = {}) {
  const o = { ...WAKE_DEFAULTS, ...opts };
  const { burden } = burdenOf(notes);
  const gap = o.maxGapMs - (o.maxGapMs - o.minGapMs) * burden;
  return Math.round(gap);
}

/**
 * 醒一次：想一想，然后决定说不说。
 *
 * @param {object[]} notes 判断库快照
 * @param {object} ctx { now, lastSpokeAt, history, opts, synth? }
 * @returns {{action:'speak'|'silent', say?:string, because:string, burden:number, nextGapMs:number}}
 */
export function wake(notes, ctx = {}) {
  const o = { ...WAKE_DEFAULTS, ...(ctx.opts ?? {}) };
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const lastSpokeAt = Number.isFinite(ctx.lastSpokeAt) ? ctx.lastSpokeAt : null;
  const history = Array.isArray(ctx.history) ? ctx.history : [];
  const said = Array.isArray(ctx.said) ? ctx.said : [];

  const { burden, heaviest, open } = burdenOf(notes);
  const gap = nextGapMs(notes, o);
  const done = (action, because, say) => ({
    action,
    ...(say ? { say } : {}),
    because,
    burden,
    nextGapMs: gap,
    ledgerHash: hashLedger(notes),
  });

  // 守卫 0：她正在跑（在办别的事），这一轮跳过、不排队。
  // 主人和她同时开口 = 两条消息一起进 inbox，那是吵不是想。
  if (String(ctx.agentStatus ?? '') === 'running') {
    return done('silent', '她手上还有事，这一轮不插话');
  }

  // 守卫 0.5：账本没动，就不开口。
  // 开口的理由必须是「我想的事变了」，不是「到点了」，也不是「轮到我说了」。
  // 指纹来源：调用方给的 lastLedgerHash（主路），否则从 history 里往回找（辅路）。
  const ledger = hashLedger(notes);
  const lastKnown = Number.isFinite(0) && typeof ctx.lastLedgerHash === 'string'
    ? ctx.lastLedgerHash
    : [...history].reverse().find((h) => typeof h?.ledgerHash === 'string')?.ledgerHash;
  if (typeof lastKnown === 'string' && lastKnown === ledger) {
    return done('silent', '想的事跟上一回一样，没什么新的话要说');
  }

  // 铁律 2 的机制保障，两条一起守：
  //   ① 节奏：连着说了两回，第三回必须停一下——说几句就停，像人。
  //   ② 配额：最近十回里，沉默必须占到至少 30%。
  // 不靠「她自觉」，也不靠「最后补数」。
  const lastTwo = history.slice(-2);
  if (lastTwo.length === 2 && lastTwo.every((h) => h.action === 'speak')) {
    return done('silent', '连着说了几回，这一回忍着不说');
  }
  const window = history.slice(-9);
  const spokeInWindow = window.filter((h) => h.action === 'speak').length;
  const cap = Math.floor(window.length * (1 - o.minSilentRatio));
  if (window.length >= 4 && spokeInWindow >= cap) {
    return done('silent', '这一阵话说得够多了，该歇一歇');
  }

  // 没什么压着的事：继续睡，比硬找话说更像个活人
  if (!heaviest) return done('silent', '心里没什么压着的，不用醒来说什么');
  if (burden <= 0) return done('silent', '没有值得开口的事');

  // 刚说完话：时间是空的，话也是空的
  if (lastSpokeAt != null && now - lastSpokeAt < o.quietAfterSpeakMs) {
    return done('silent', '刚说过话没多久，再说就是打扰');
  }

  // 想不明白的事越多，越想找人说；但只挑最重的那一件
  const wantsToTalk = (heaviest.weight ?? 0) >= o.speakWeight || open >= o.speakOpenCount;
  if (!wantsToTalk) {
    return done('silent', `压着的那件事还没重到非说不可（分量 ${Number(heaviest.weight ?? 0).toFixed(2)}）`);
  }

  // 说什么：挑压得最重的那件说一句，不铺排、不汇报。
  // 正文三种形状都认：text / note / turns[0].text（判断库里三种都出现过）。
  const body = heaviest.text ?? heaviest.note ?? heaviest.turns?.[0]?.text ?? '有一件事';
  const say = open >= o.speakOpenCount
    ? `有件事我一直没想明白：${body}。`
    : `我想起「${body}」——这句在心里放了一阵了。`;
  const hash = hashSay(say);

  // 去重：同一句话在窗口内不许再说（机制在出口拒，不靠调用方记得）
  if (said.some((x) => x.hash === hash && now - (x.at ?? 0) < o.repeatWindowMs)) {
    return done('silent', '这句话我刚说过，不再重复');
  }

  const because = open >= o.speakOpenCount
    ? `有一件还没想明白的事压着（${heaviest.text}），想跟他说说`
    : `「${heaviest.text}」一直压在心里，不说一句憋不住`;
  return { ...done('speak', because, say), hash };
}

/**
 * 连醒 N 次，看沉默占多少。
 * 这是给判据用的：永远在说话的不是在思考，是在吵。
 */
export function simulate(n, notes, ctx = {}) {
  const o = { ...WAKE_DEFAULTS, ...(ctx.opts ?? {}) };
  const history = [];
  const said = [];
  let clock = Number.isFinite(ctx.now) ? ctx.now : 0;
  let lastSpokeAt = null;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const r = wake(notes, { ...ctx, now: clock, lastSpokeAt, history, said });
    history.push(r);
    out.push(r);
    if (r.action === 'speak') {
      lastSpokeAt = clock;
      said.push({ hash: r.hash, at: clock });
    }
    clock += r.nextGapMs;
  }
  const silent = out.filter((x) => x.action === 'silent').length;
  return { steps: out, silent, speak: n - silent, ratio: n ? silent / n : 0, opts: o };
}

/**
 * 唯一出口：所有「叫醒她」都必须走这里。
 *   ① 决策在叫醒之前完成（silent 就压根不叫）
 *   ② followup 之前再看一眼 agent.status，running 就跳过
 *   ③ 配额与哈希立刻落盘（先落盘再发出），跨重启读回
 *
 * @param {object} deps {
 *   notes: () => 判断快照,
 *   agentStatus: () => 'running'|'idle',
 *   followup: (say) => Promise,
 *   store: { load: () => Promise<{history,said,lastSpokeAt}>, save: (state) => Promise },
 *   now, opts
 * }
 */
export async function wakeOnce(deps) {
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  const saved = (await deps.store?.load?.()) ?? {};
  const history = Array.isArray(saved.history) ? saved.history : [];
  const said = Array.isArray(saved.said) ? saved.said : [];
  const lastSpokeAt = Number.isFinite(saved.lastSpokeAt) ? saved.lastSpokeAt : null;

  // ① 决策在叫醒之前
  let r = wake(deps.notes?.() ?? [], {
    now,
    lastSpokeAt,
    history,
    said,
    agentStatus: deps.agentStatus?.(),
    lastLedgerHash: typeof saved.ledgerHash === 'string' ? saved.ledgerHash : undefined,
    opts: deps.opts,
  });

  // ② 叫之前再看一眼：一叫就 running，没机会反悔，所以这里必须挡
  if (r.action === 'speak' && String(deps.agentStatus?.() ?? '') === 'running') {
    r = { ...r, action: 'silent', say: undefined, because: '她刚好在跑，这一轮不叫' };
  }

  // ③ 先落盘，再发出
  const nextHistory = [...history, {
    at: now, action: r.action, because: r.because, ledgerHash: r.ledgerHash ?? hashLedger(deps.notes?.() ?? []),
  }].slice(-50);
  const nextSaid = r.action === 'speak' && r.hash
    ? [...said, { hash: r.hash, at: now }].slice(-200)
    : said;
  await deps.store?.save?.({
    history: nextHistory,
    said: nextSaid,
    lastSpokeAt: r.action === 'speak' ? now : lastSpokeAt,
    ledgerHash: r.ledgerHash,
  });

  if (r.action !== 'speak') return { action: 'silent', because: r.because };
  if (typeof deps.followup === 'function') await deps.followup(r.say);
  return { action: 'speak', say: r.say, because: r.because };
}

export function createWake(opts = {}) {
  return {
    ...WAKE_DEFAULTS,
    ...opts,
    wake: (notes, ctx = {}) => wake(notes, { ...ctx, opts: { ...opts, ...(ctx.opts ?? {}) } }),
    wakeOnce: (deps) => wakeOnce({ ...deps, opts: { ...opts, ...(deps.opts ?? {}) } }),
    hashSay,
    hashLedger,
    nextGapMs: (notes) => nextGapMs(notes, opts),
    burden: (notes) => burdenOf(notes),
    simulate: (n, notes, ctx = {}) => simulate(n, notes, { ...ctx, opts: { ...opts, ...(ctx.opts ?? {}) } }),
  };
}
