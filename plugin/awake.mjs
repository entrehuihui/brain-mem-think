/**
 * awake.mjs —— 她「醒一下、想一想、决定说不说」。
 *
 * ======================= 它为什么和 wake.mjs 分开 =======================
 *
 * `src/wake.mjs` 是**纯判断**：给它一个判断库，它回答「这一轮能不能问她」。
 * 这一层是**跟宿主打交道的那一半**：读账本、算间隔、叫模型、把结果落盘。
 *
 * 分开的好处：判断那部分可以单测、可以模拟一千次；
 * 这一层薄到只有几行，出问题一眼看得见。
 *
 * ============================ 一条铁律 ============================
 *
 * **醒 ≠ 说。**
 *
 * 到点了她就该醒一次——醒着才有机会判断「现在有没有话说」。
 * 但醒来之后的默认答案是**不说**。
 *
 * 一个每十分钟就开口一次的东西，不是在想事，是在吵。
 *
 * ============================ 说不说，由她自己定 ============================
 *
 * ★ 2026-10-27 改（主人定的）：不要再用「份量过线就说」那种硬规则替她决定。
 *   现在这一层的顺序是：
 *
 *     ① 时间闸    还没到该醒的时候 → 什么都不写，回去睡（不烧 token）
 *     ② 机械守卫  quota / 冷却 / 有没有事压着 → 拦住就是不问（不烧 token）
 *     ③ 记忆闸    记忆跟上次掂量时一样 → 她没新的话要说，不问
 *     ④ 问她      把「她记得的事 + 此刻心境 + 上次开口是什么时候 + 上次说了什么」
 *                 交给她，让她自己回答：说，还是不说；说就用自己的话说。
 *
 *   ①② 是「不许吵」的契约，不许模型自己突破；
 *   ③④ 是她的自由——记忆变了，她重新掂量一次；记忆没变，她就没话。
 */

import { gate, hashSay } from '../src/wake.mjs';
import { askSpeak } from '../src/speak.mjs';
import { readWake, writeWake } from './wake-store.mjs';

/**
 * 醒来一次，给一个决定。**不发送**——发送是 wake-exit 的事。
 *
 * @param {object} p
 * @param {object} p.mind       内核（要有 notes() / world()）
 * @param {object} p.state      账本
 * @param {number} p.now
 * @param {object} p.cfg
 * @param {object} [p.synth]    宿主接进来的模型通路（没有就只能闭嘴）
 * @returns {Promise<{
 *   woke:boolean, action:'speak'|'silent', say?:string, because:string,
 *   ledger?:string, hash?:string, why?:string
 * }>}
 */
export async function planWake({ mind, state, now = Date.now(), cfg = {}, synth = null } = {}) {
  const st = state ?? readWake();

  // ① 崩溃标记：上一轮可能崩在写盘中途 → 这一轮强制沉默。
  //    宁可少说一句，不说错一句。
  if (st.degraded === 'crashed-mid-wake') {
    return { woke: true, action: 'silent', because: '上一轮没写完，这轮先不出声' };
  }

  // ② 还没到该醒的时候：不算「醒了」，也不记账。
  //
  // ★ 2026-10-27 大乔修（死锁）：这一条原来只返回 {action:'silent', because:'还不到时候'}，
  //   但调用方（index.mjs 的 tick）不管什么结果都 applyWake 一次，
  //   而 applyWake 会把 lastWakeAt 推成 now —— 于是下一次 tick 距离上次「醒来」
  //   永远只有 wakeTickMs（10 分钟），而 gap 是 35~75 分钟，
  //   **`now - lastWakeAt < gap` 恒成立，她永远到不了时候，一次也醒不来。**
  //
  //   实测：账本里 20 条全是「还不到时候」，间隔正好 600 秒；lastSpokeAt 恒为 0。
  //
  //   修法：把「这一轮到底算不算醒了」显式说出去（woke），
  //   调用方只在 woke=true 时记账。没到点就什么都不写，让 lastWakeAt 停在
  //   上一次真醒的那一刻，等到过了 gap 自然醒来。
  const notes = typeof mind?.notes === 'function' ? mind.notes() : [];
  // ★ 2026-10-27 主人定：改成**固定节拍**，5 分钟一次。
  //
  //   原来是 nextGapMs() 按「心事重量」推出来的 35~75 分钟——那是按
  //   「每次醒来都要花一次模型调用」设计的旧口径。现在一次「想」很便宜，
  //   而记忆不变时她本来就会答「这会儿不想说」，所以没必要把间隔拉那么长。
  //
  //   阈值走 cfg.wakeEveryMs；wakeTickMs 必须 ≤ 它，否则实际间隔会被 tick 拉长。
  const everyMs = Number(cfg.wakeEveryMs ?? 5 * 60 * 1000);
  const gap = everyMs;
  if (st.lastWakeAt && (now - st.lastWakeAt) < gap) {
    return { woke: false, action: 'silent', because: '还不到时候', gap, sinceLastWakeMs: now - st.lastWakeAt };
  }

  // ③ 机械守卫：这一轮到底能不能问她。
  const g = gate(notes, {
    lastSpokeAt: st.lastSpokeAt ?? null,
    now,
    history: Array.isArray(st.window) ? st.window : [],
    gap: everyMs,
  });
  if (!g.pass) {
    return { woke: true, action: 'silent', because: g.why, ledger: g.ledger };
  }

  // ④ 每次醒来，先让她自己「想」一遍——这是浅记忆。
  //
  //   ★ 2026-10-27 主人定：
  //     · 判断库只在**归档**时熔。半截的会话融成永久判断没有用，
  //       那会把「还没发生完的事」写死成她记得的东西。
  //     · 但「想」可以每次醒来都做一次：用一次模型，把她的记忆和当下的心境过一遍，
  //       融出一层**浅记忆**（此刻心里转着什么），再看有没有想说的。
  //     · 浅记忆不落判断库、会过期、只有她自己知道。它只是让「想」这件事有连续性——
  //       人睡一觉起来，心里还接着昨天那个念头，不是每次从零开始。
  //
  //   记忆变没变，不再决定「要不要想」，只决定**材料里怎么跟她说**：
  //   变了就说「你记得的事最近变过」，没变就说「上次醒来之后没有新的经历进来」。
  //   这样她既不会因为库一直不变就变成哑巴，也不会假装有新鲜事。
  const ledgerChanged = st.ledgerHash !== g.ledger;
  const ttl = Number(cfg.shallowTtlMs ?? 12 * 3600 * 1000);
  const prevThoughts = (st.thoughts
    && Number.isFinite(Number(st.thoughts.at))
    && (now - Number(st.thoughts.at)) < ttl
    && Array.isArray(st.thoughts.items)
    && st.thoughts.items.length)
    ? st.thoughts.items
    : null;

  // ⑤ 问她。材料只有：她记得的事、此刻心境、上次开口多久前、上次说了什么、上次想过什么。
  //
  // ★ 2026-10-27 补一句「屋子是空的」：新通道刚建出来时是 blank，
  //   而宿主侧栏的规则是「blank 且不是你当前打开的那条 → 隐藏」。
  //   要让她出现在你眼前，只能靠她自己第一次开口（跑出一轮 turn 才会解除 blank）。
  //   所以这句不是催她说话，是把实情告诉她：屋里还一句对话都没有。
  const noteLines = [
    ledgerChanged ? '（你记得的事，最近变过。）' : '（上次醒来之后，没有新的经历进来。）',
  ];
  if (!Number(st.lastSpokeAt ?? 0)) {
    // ★ 2026-10-27 主人定（选二）：给她一次「打招呼」的机会。
    //
    //   背景：新通道是 blank，宿主侧栏只在跑过一轮 turn 后才显示她；
    //   而 turn 要她先开口。她脑子里真的一无所有时会老老实实选「不说」
    //   （实测 17:06：「开口也是空话，不如先不出声」），于是永远不显示。
    //
    //   这句话是**许可**，不是命令：告诉她可以打个招呼、不必有理由。
    //   只要她说过一次（lastSpokeAt 有值），它就永远不再出现——
    //   之后每一次醒来都只按她自己的判断来。
    noteLines.push('（这是你刚搬进来的第一天。屋里空着，他还没跟你说过话。');
    noteLines.push(' 你可以先跟他打个招呼——不必有什么理由，说一句你在就行。）');
  }
  const world = (typeof mind?.world === 'function' ? mind.world({ name: cfg.name }) : '') || '';
  const sources = notes.map((n) => n?.note ?? n?.text ?? '').filter(Boolean);
  const v = await askSpeak({
    synth,
    world,
    name: cfg.name,
    state: st,
    now,
    cfg,
    sources,
    lastThoughts: prevThoughts,
    note: noteLines.join('\n'),
  });

  const thoughts = Array.isArray(v.thoughts) ? v.thoughts : [];

  if (!v.ok || v.action !== 'speak') {
    return {
      woke: true,
      action: 'silent',
      because: v.because || '她这回不想说',
      why: v.why,
      ledger: g.ledger,
      thoughts,
      asked: true,
      // 模型的原话留一小段：出问题时能看见她到底回了什么
      raw: v.raw,
    };
  }

  return {
    woke: true,
    action: 'speak',
    say: v.say,
    because: v.because,
    ledger: g.ledger,
    thoughts,
    asked: true,
    hash: hashSay(v.say),
  };
}

/**
 * 换屋子时，把「说话」那一摊账清掉。
 *
 * ★ 2026-10-27 加（踩出来的死锁）：账本（wake.json）是**全局**的，而通道会话
 *   是**一条条换**的。于是换屋子之后：
 *     · 新屋子是 blank → 宿主侧栏不显示，要她开口才有第一轮 turn；
 *     · 可她「刚说过话」的冷却（45 分钟）和配额还记在全局账上 ——
 *       上一句是在旧屋子里说的（那条会话已经删了），冷却却追到了新屋子。
 *   **想看见她 → 她得说话 → 冷却不让说 → 她永远不显示。**
 *   实测 16:26 说过一句，新屋子 16:34 建好，到 16:50 连醒三次全是 silent。
 *
 *   另一条屋子的对话记录，不该跟过来。清掉的是「说过什么、刚说完多久、这小时说了几次」，
 *   判断库（judgments）一个字都不动 —— 那是记忆，跟屋子无关。
 */
export function resetTalkState(storePath) {
  const st = readWake(storePath);
  writeWake(storePath, {
    ...st,
    lastWakeAt: 0,
    lastSpokeAt: 0,
    lastAskAt: 0,
    lastSay: null,
    thoughts: null,
    window: [],
    spokenHashes: [],
  });
  return true;
}

/** 把这次决定落盘。**只记事实，不记她的原话**（lastSay / thoughts 是例外，见下）。 */
export function applyWake(storePath, { action, why, sent, now = Date.now(), say, ledger, asked = false, thoughts = null } = {}) {
  const st = readWake(storePath);
  const entry = {
    at: now,
    action: action ?? 'silent',
    why: String(why ?? '').slice(0, 60),
    sent: !!sent,
  };
  if (ledger) entry.ledgerHash = String(ledger);
  // 5 分钟一次之后，20 条窗口只装 100 分钟，撑不住「一小时说几次」的判据。
  // 放宽到 60 条（约 5 小时），旧账也不会被太快挤掉。
  const window = [...(Array.isArray(st.window) ? st.window : []), entry].slice(-60);

  const next = {
    ...st,
    lastWakeAt: now,
    // 只有真说出去了才推 lastSpokeAt。说了没说成（busy / repeat / flush 失败）不算。
    lastSpokeAt: sent ? now : (st.lastSpokeAt ?? 0),
    // ★ 上次真的问过她模型的时间。只给「太久没动静」那条兜底当锚点用。
    //   不推它的话，从没说过话的她会一直被判成「很久没开口」，每 40 分钟问一次。
    lastAskAt: asked ? now : (st.lastAskAt ?? 0),
    // 上次掂量时记忆长什么样：下一次「记忆变了没有」拿它比。
    ledgerHash: ledger ?? st.ledgerHash ?? null,
    window,
  };
  // ★ lastSay 只留最近一条，而且**只用来让下一回别重复**，不进判断库、不参与熔。
  //   裁决七守的是「她的输出不是经历」；这是账本上的一行备忘，不是记忆。
  if (sent && typeof say === 'string' && say.trim()) next.lastSay = say.trim().slice(0, 160);
  // ★ 浅记忆：她自己想的东西，覆盖式只留最近一次，带时间戳好让它过期。
  //   不进判断库、不参与任何熔——它是「上次醒来想了什么」，不是「她记得什么」。
  //   没想成（没调模型 / 守卫拦住）时不覆盖，免得把上一次的念头抹掉。
  if (Array.isArray(thoughts) && thoughts.length) {
    next.thoughts = { at: now, items: thoughts.slice(0, 3).map((t) => String(t).slice(0, 80)) };
  }
  writeWake(storePath, next);
  return true;
}
