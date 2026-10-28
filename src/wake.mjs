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
import { weightWithSting } from './sting.mjs';
import { hashSayText } from './speak.mjs';

export const WAKE_DEFAULTS = Object.freeze({
  // 醒来之后，多久之内不再醒（由心事重量决定，不由时间表决定）
  minGapMs: 3 * 60 * 1000,
  maxGapMs: 75 * 60 * 1000,
  // 说话的门槛：压着的事得够重、且确实有想说的
  speakWeight: 0.55,
  speakOpenCount: 1,
  // 刚说完话，短时间内不该再说
  //
  // ★ 2026-10-27 改（主人把唤醒调成 5 分钟一次之后）：
  //   原来 18 分钟是按「40 分钟醒一次」配的节奏。5 分钟一醒之后，
  //   18 分钟的冷却等于「一小时内最多还能说三句」，太密了。
  //   想得勤是好事，说得勤是打扰——这两个频率现在分开调。
  quietAfterSpeakMs: 45 * 60 * 1000,
  // 说话频率：**按时间窗算，不按唤醒次数算**。
  //
  // ☆ 为什么要改：原来这里写的是「最近 9 次唤醒里 speak 占比 ≤70%」。
  //   9 次在 40 分钟节奏下是 6 小时，是合理的；可 5 分钟一醒，9 次只有 45 分钟，
  //   等于「45 分钟内最多说 6 次」——那不是惦记，是刷屏。
  //   唤醒频率一变，按次数算的配额就自动失真了。所以改成按时间。
  speakWindowMs: 60 * 60 * 1000,   // 一小时的窗口
  maxSpeakInWindow: 2,             // 一小时内最多说 2 次（想 12 次，说 2 次）
  // 沉默的配额：至少这个比例要闭嘴（留着，给 simulate 和旧路径做对照）
  minSilentRatio: 0.3,
  // 同一句话在这么久之内不许再说第二次
  repeatWindowMs: 6 * 60 * 60 * 1000,
});

/**
 * ★ 2026-10-27 大乔修（状态口径错配）：
 *
 *   这里原来只认内部枚举 `pending` / `held`，可**送进来的 notes 是 `mind.notes()`
 *   给的结果，而那一路已经过 `toNote()`，状态被归一成公开口径 `open` / `held` / `retired`**
 *   （见 flash.mjs 的 PUBLIC_STATUS）。两套口径一撞，`status === 'pending'` 恒 false：
 *
 *     · burdenOf：悬案（open）一条都数不进去 → 「想不明白的事越多越想找人」永远不成立
 *     · hashLedger：open 条目不进指纹 → 守卫「想的事跟上一回一样就闭嘴」失效
 *
 *   两个口径都收，谁给的都认。这也是 world.mjs 早就做过的那一层归一，
 *   只是 wake 这层当时不知道。
 */
const LIVE_STATES = new Set([
  STATUS.PENDING, STATUS.HELD,   // 内部枚举
  'open', 'held',                // toNote() 的公开口径
]);
const OPEN_STATES = new Set([STATUS.PENDING, 'open']);

function isLive(n) {
  return !!n && LIVE_STATES.has(String(n?.status ?? ''));
}

function isOpen(n) {
  return !!n && OPEN_STATES.has(String(n?.status ?? ''));
}

/**
 * 判断库的指纹：只用「有意义的那几样」算。
 * relation / polarity / weight（取整档）/ 条数 / open 的 id 集合。
 * **不算**时间戳、from、计数器和任何会自己动的字段——
 * 否则「库其实没变」会被算成「在变」，判据就废了。
 */
export function hashLedger(notes) {
  const live = (notes ?? []).filter(isLive);
  const parts = live
    .map((n) => [
      n.themeKey ?? '',
      n.relation ?? '',
      String(n.polarity ?? ''),
      Math.round((Number(n.weight) || 0) * 10),
      n.status ?? '',
    ].join('/'))
    .sort();
  const openIds = live.filter(isOpen).map((n) => n.id ?? '').sort().join(',');
  const blob = `${parts.join('|')}#${parts.length}#${openIds}`;
  let h = 2166136261;
  for (let i = 0; i < blob.length; i += 1) {
    h ^= blob.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * 同一句话的指纹：用来判「这句我说过了」。
 *
 * ★ 2026-10-27 大乔修（口径错配）：原来这里是自己一套 FNV 哈希，
 *   而真正记账/去重的是 `plugin/wake-store.mjs` 的 `hashMessage()`（sha1 前 16 位）。
 *   两个哈希函数算同一句话，结果当然不一样 ——`said` 里存的永远是出口那套 hash，
 *   这里算出来的永远对不上，**「这句我刚说过」这条闸从来没生效过一次**。
 *
 *   现在只有一份实现（src/speak.mjs 的 hashSayText），这里只是换个名字导出。
 *   不要再在别处写第二份：写的那边和读的那边中间不许有小差。
 */
export const hashSay = hashSayText;

/** 一条判断在她心里的份量：strength（证据算出来的）优先，老数据回退 weight。 */
function magnitude(n) {
  // ★ 2026-10-28（阶段三）：扎心的事压得更重。
  //   strength 管「信不信」，sting 管「放不放得下」——burden 是后者该管的事。
  return weightWithSting(n);
}

/** 心事有多重：压着的判断越多越重，悬着的更重（想不明白才惦记）。 */
export function burdenOf(notes) {
  const live = (notes ?? []).filter(isLive);
  if (!live.length) return { burden: 0, heaviest: null, open: 0 };
  const open = live.filter(isOpen);
  const heaviest = [...live].sort((a, b) => magnitude(b) - magnitude(a))[0];
  // 重 = 最重那条的份量 + 悬案带来的挂心
  const burden = Math.max(0, Math.min(1, magnitude(heaviest) * 0.8 + open.length * 0.12));
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
 * 机械守卫：这一轮**允不允许**去问她一次。
 *
 * ======================= 它现在只管「不许吵」 =======================
 *
 * 2026-10-27 之前，这个函数（wake）管的是「说不说 + 说什么」：
 * 份量 ≥ 0.55 就说、悬案 ≥ 1 就说、然后把压着最重的那条判断套进一句模板。
 * 主人一眼看出来：「我想起「<判断原文>」——这句在心里放了一阵了」，
 * 那不是她在说话，是代码把她的判断念了一遍。
 *
 * 现在判断权交出去了（src/speak.mjs：她读着自己的记忆，自己决定）。
 * 这里只剩五条硬底线，它们不是「该不该说」，是**她不许越过的边界**：
 *
 *   1. 她正在跑（办别的事）     → 不插话，也不排队
 *   2. 连着说了两回             → 第三回忍一下
 *   3. 最近九回里已说了 ≥70%    → 歇一歇（铁律 2：沉默至少占 30%）
 *   4. 心里一件事都没压着       → 不用叫醒模型（省一次调用）
 *   5. 刚说完没多久             → 再说就是打扰
 *
 * 「能不能问」和「她会说什么」是两件事。前者是契约，后者是她的。
 *
 * @returns {{pass:boolean, why:string, burden:number, heaviest:object|null, open:number, ledger:string, gap:number}}
 */
export function gate(notes, ctx = {}) {
  const o = { ...WAKE_DEFAULTS, ...(ctx.opts ?? {}) };
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const lastSpokeAt = Number.isFinite(ctx.lastSpokeAt) ? ctx.lastSpokeAt : null;
  const history = Array.isArray(ctx.history) ? ctx.history : [];

  const { burden, heaviest, open } = burdenOf(notes);
  // gap 由调用方给（固定节拍）；没给才按心事重量推。
  const gap = Number.isFinite(ctx.gap) ? ctx.gap : nextGapMs(notes, o);
  const ledger = hashLedger(notes);
  const no = (why) => ({ pass: false, why, burden, heaviest, open, ledger, gap });

  // 守卫 1：她正在跑（在办别的事），这一轮跳过、不排队。
  // 主人和她同时开口 = 两条消息一起进 inbox，那是吵不是想。
  if (String(ctx.agentStatus ?? '') === 'running') {
    return no('她手上还有事，这一轮不插话');
  }

  // 守卫 2：说话频率——**按时间窗，不按唤醒次数**。
  //
  // ☆ 2026-10-27 改。原来是「最近 9 次唤醒里 speak 占比 ≤ 70%」。
  //   9 次在 40 分钟节奏下是 6 小时，合理；主人把唤醒调成 5 分钟一次之后，
  //   9 次只有 45 分钟 → 等于「45 分钟最多说 6 次」，那不是惦记，是刷屏。
  //   **唤醒频率一变，按次数算的配额就自动失真。** 所以改成按时间。
  //
  //   她可以每 5 分钟想一次（想很便宜），但一小时最多说 2 次。
  //   想得多、说得少——这才是「在想事情」和「在吵」的区别。
  const windowStart = now - o.speakWindowMs;
  const recentSpeak = history.filter((h) => h && h.action === 'speak'
    && h.sent !== false                       // 没真发出去的不算「说了」
    && Number(h.at ?? 0) >= windowStart);
  if (recentSpeak.length >= o.maxSpeakInWindow) {
    return no(`这一小时已经说了 ${recentSpeak.length} 次，再说就是吵`);
  }

  // 守卫 3：连着说了两回，第三回忍一下。
  // （5 分钟节奏下几乎不会触发——有一小时窗口兜着；留着是因为它守的是「节奏」不是「频率」）
  const lastTwo = history.slice(-2);
  if (lastTwo.length === 2 && lastTwo.every((h) => h.action === 'speak')) {
    return no('连着说了几回，这一回忍着不说');
  }

  // ★ 2026-10-27 删掉两条守门：「心里没什么压着的」和「没有值得开口的事」。
  //
  //   原本的用意是省一次模型调用：库里一条现役判断都没有时，直接闭嘴。
  //   可这条闸在**空库**上变成了死锁：
  //     · 白纸状态 → 没有压着的事 → 永远不说话
  //     · 她的记忆只能在「归档熔」时增长 → 不说话就没有会话内容 → 没东西可熔
  //     → **她永远是一张白纸**。实测 16:58 清空记忆后，17:01 醒来就是这样被拦下的：
  //         wake-silent {"why":"心里没什么压着的，不用醒来说什么","byHer":null}
  //
  //   「此刻想不想说」是她的判断，不该由代码替她决定。空库就让她自己看一眼
  //   「我还没想明白什么」，然后自己回一句说不说。省 token 不值这个代价值。

  // 刚说完话：时间是空的，话也是空的
  if (lastSpokeAt != null && now - lastSpokeAt < o.quietAfterSpeakMs) {
    return no('刚说过话没多久，再说就是打扰');
  }

  return { pass: true, why: '', burden, heaviest, open, ledger, gap };
}

/**
 * 旧的「规则 + 模板」那一版，**宿主已经不再用它**。
 *
 * 留着两个用处：
 *   ① `simulate()` 还在用它做对照（同样的库，模板版和她的判断差多少）；
 *   ② 出问题时能一眼看出「是守卫拦的，还是她自己决定不说」。
 *
 * 新路径：awake.mjs → gate() → askSpeak()（src/speak.mjs）。
 *
 * @param {object[]} notes 判断库快照
 * @param {object} ctx { now, lastSpokeAt, history, said, opts }
 */
export function wake(notes, ctx = {}) {
  const o = { ...WAKE_DEFAULTS, ...(ctx.opts ?? {}) };
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const said = Array.isArray(ctx.said) ? ctx.said : [];

  const g = gate(notes, ctx);
  const done = (action, because, say) => ({
    action,
    ...(say ? { say } : {}),
    because,
    burden: g.burden,
    nextGapMs: g.gap,
    ledgerHash: g.ledger,
  });

  if (!g.pass) return done('silent', g.why);

  const heaviest = g.heaviest;
  // 正文三种形状都认：text / note / turns[0].text。
  // `mind.notes()` 给的是 toNote() 的结果，正文字段叫 note（flash.mjs: `note: b.text`）。
  const body = heaviest.text ?? heaviest.note ?? heaviest.turns?.[0]?.text ?? '有一件事';
  const say = g.open >= o.speakOpenCount
    ? `有件事我一直没想明白：${body}。`
    : `我想起「${body}」——这句在心里放了一阵了。`;
  const hash = hashSay(say);

  // 去重：同一句话在窗口内不许再说（机制在出口拒，不靠调用方记得）
  if (said.some((x) => x.hash === hash && now - (x.at ?? 0) < o.repeatWindowMs)) {
    return done('silent', '这句话我刚说过，不再重复');
  }

  const because = g.open >= o.speakOpenCount
    ? `有一件还没想明白的事压着（${body}），想跟他说说`
    : `「${body}」一直压在心里，不说一句憋不住`;
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
