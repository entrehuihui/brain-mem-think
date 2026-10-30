/**
 * motive.mjs —— 她「想去做点什么」的那个念头，必须是从记忆里长出来的。
 *
 * ======================= 它为什么必须存在 =======================
 *
 * 2026-10-28 主人补的一句：
 *
 *   「自主性还必须有主动性，比如她的记忆觉得她想去刷刷电视剧，那就去。」
 *
 * 在那之前，她的世界只有两条出路：`speak`（对主人说）和 `silent`（闭嘴）。
 * 「想刷剧」这个念头即使从记忆里冒出来，**也没有一条路能让它变成动作**。
 *
 * ======================= 铁律：追不到出处的，不许动 =======================
 *
 * 每一个冲动都必须带 `why`，而且 `why` 必须是**记忆里的原话**：
 *   · 悬案 → 那条判断的正文
 *   · 偏好 → 上次做完她自己的理由
 *
 * 追不到出处的「想去做点什么」，不是自主，是抽风。
 * 这一条写进机制：`urges()` 返回的每一条都有 `why` 和 `from`（来源条目 id）。
 *
 * ======================= 四种合法来源 =======================
 *
 *   resolve  未解张力：一条悬案被碰过多次、一直没有答案 → 想自己去弄明白
 *   verify   二手空白：这条判断只有「他说的」，她还没自己看过 → 想去验证
 *   indulge  偏好：做过某件事，做完心里是松的 → 想再做
 *   identity 身份张力：她认定自己是某种人，可当下的行为跟那条不符 → 想试试
 *
 * 「verify」「identity」现在只是占位——要等阶段 D 的观测层（source:'self' 事件）
 * 才有数据支撑。没有数据时它们不会产出冲动，不会假装有。
 */

import { clamp01 } from './judge.mjs';
import { humanTool } from './express.mjs';

export const MOTIVE_DEFAULTS = Object.freeze({
  /** 低于这个驱动就不去。一点念头就跑，那是 ADHD。 */
  minDrive: 0.5,
  /** 悬案的底噪：刚立的悬案还不至于让她跑出去 */
  openBase: 0.35,
  /** 每被碰一次加多少 */
  perTouch: 0.15,
  /** 每被问过一次加多少（问过还不明白，才是真悬） */
  perAsk: 0.2,
  /**
   * 挂得越久越想去弄明白：满一天加满这么多。
   *
   * ★ 2026-10-28（回放真实数据时补的）：
   *   原来 resolve 只认 touches / askCount，而这两个数只有 `ingest`（逐条经历）
   *   那条路会加。可生产主路径是**归档熔**，它一次都不走 ingest ——
   *   于是库里明明全是悬案，她一辈子也不会想「自己去弄明白」。
   *   「心里挂着一件事挂了很久」本身就是理由，不需要谁来碰它一下。
   */
  ageBoost: 0.3,
  ageFullMs: 24 * 3600e3,
  /**
   * 今天已经去过的地方，drive 打这个折。
   *
   * 0.55 是拿回放数据试出来的：一条悬案挂满 24 小时 drive≈0.65，
   * 打完折 0.36，掉到 0.5 线下 —— 它今天就排不上了，让位给别的。
   * 但如果别的都不到线，它打完折仍然可能是最高分，那就还去它（不硬禁）。
   */
  repeatPenalty: 0.55,
  /**
   * 同一件事最近 7 天去过 n 次，drive 乘这个数的 (n-1) 次方。
   * n=1 不罚，n=2 ×0.6，n=3 ×0.36。
   */
  fruitlessPenalty: 0.6,
  /**
   * 「刚去过」的时间窗。
   *
   * 12 小时：跨得过零点，也短到不至于让她四天才能轮到同一件事。
   * （用「本地零点」划界时，23:34 去过、00:24 又去，折扣直接归零——回放里抓到的。）
   */
  repeatWindowMs: 12 * 3600e3,
  /** 偏好的半衰期：30 天没碰，想头掉一半 */
  prefHalfLifeMs: 30 * 86400e3,
  // ★ 2026-10-28（主人纠正）：这里原来我加过一条「无聊就发一个刷视频的冲动」。
  //   错了——**要不要做点什么，是她的判断，不是内核发的牌。**
  //   主人原话：「不一定非得出门啊，等看她的记忆来，看她想不想。」
  //   所以「想不想」放在醒来那一问里（speak.mjs 的 want 字段），
  //   由她读着自己的记忆说；内核只负责把她说出来的事真的做掉。
});

/** 新鲜度衰减：越久没碰越不想。 */
export function decay(lastAt, now, halfLifeMs = MOTIVE_DEFAULTS.prefHalfLifeMs) {
  if (!Number.isFinite(Number(lastAt)) || !lastAt) return 0.6;
  const age = Math.max(0, now - Number(lastAt));
  return Math.exp(-age / halfLifeMs);
}

/**
 * 她现在想去做什么。
 *
 * ★ 2026-10-28 加（回放真实数据后，我自己看出来的问题）：
 *
 *   第一次回放，她两天里出去 7 次，**7 次全是同一件事**——
 *   理由都是同一句「『别停下来，除非累了』这句把停与不停的判断交到了我手上」。
 *
 *   因为 `urges` 只按 drive 排序，取第一条。而一条特别扎眼的悬案
 *   会长期霸占第一（它每被碰一次就涨一点，别的悬案永远追不上）。
 *   结果她的「主动性」变成了**钻进一个洞**，而不是活人事儿多。
 *
 *   这不是她挑，是我的排序太笨。人也不会两天只想一件事——
 *   心里挂着的那件事今天已经去查过了，第二天自然该轮到别的。
 *
 *   改法：**今天已经去做过的 target，drive 打 repeatPenalty 折**。
 *   不去掉它（真没别的事可做时还能再去），只是让它别天天霸榜。
 *
 * @param {object} p
 * @param {object[]} p.notes        判断快照（mind.notes() 的结果，公开口径）
 * @param {object[]} [p.preferences] 偏好表
 * @param {object[]} [p.recent]     最近的行动记录 [{ at, target }]，用来判「今天去过了」
 * @param {number}   [p.now]
 * @param {object}   [p.opts]
 * @returns {Array<{kind:string,target:string,activity:string,drive:number,why:string,from:string}>}
 *          按 drive 降序，最多 5 条
 */
export function urges({ notes = [], preferences = [], recent = [], now = Date.now(), lastFreshAt = 0, opts = {} } = {}) {
  const o = { ...MOTIVE_DEFAULTS, ...opts };
  const out = [];

  // 最近这段时间去过的（滑动窗口，不是「今天零点后」）
  //
  // ★ 2026-10-28 再修：第一版用「本地零点」划界，结果回放里
  //   10/26 23:34 去过的事，10/27 00:24（50 分钟后）又去了一遍——
  //   跨个零点折扣就归零了，等于没轮转。改成滑动窗口。
  const repeatWindowStart = now - o.repeatWindowMs;
  const usedRecently = new Set();
  // 最近 7 天去过几次：去多了还是没结果，说明这洞钻不动，该放手了
  const attempts = new Map();
  const weekAgo = now - 7 * 86400e3;
  for (const r of Array.isArray(recent) ? recent : []) {
    if (!r?.target || !Number.isFinite(Number(r.at))) continue;
    if (Number(r.at) >= repeatWindowStart) usedRecently.add(String(r.target));
    if (Number(r.at) >= weekAgo) attempts.set(String(r.target), (attempts.get(String(r.target)) ?? 0) + 1);
  }
  /**
   * 去过的地方让位。
   *
   * ★ 2026-10-28（回放后我自己加的，第二次）：
   *   第一版只做「今天去过打 0.55 折」，结果两天里 7 次出去虽然从 1 件变成了 3 件，
   *   但那 3 件在第二天又原样轮了一遍 —— 她像在同一个洞里换三个角度凿。
   *
   *   人要放弃。同一件事去过两次还没带回东西，第三次就不该去了，
   *   不是因为它不重要，是因为**她已经试过了，再去是硬凑**。
   *
   *   所以叠第二层：最近 7 天去过 n 次的，drive 乘 fruitlessPenalty^(n-1)。
   *   n=1 不打折，n=2 ×0.6，n=3 ×0.36 —— 自然沉下去，把位置让给新悬案。
   */
  const temper = (drive, target) => {
    let d = drive;
    if (usedRecently.has(String(target))) d *= o.repeatPenalty;
    const n = attempts.get(String(target)) ?? 0;
    if (n >= 2) d *= Math.pow(o.fruitlessPenalty, n - 1);
    return Number(d.toFixed(3));
  };

  // ── 1) 未解张力 ─────────────────────────────────────────────
  for (const n of notes) {
    if (!n || n.status !== 'open') continue;
    const touches = Number(n.touches ?? 0);
    const asks = Number(n.askCount ?? n.curiosityFired ?? 0);
    const since = Number(n.createdAt ?? n.tension?.since ?? n.since ?? now);
    const age = Math.max(0, now - since);
    // 刚立的悬案先挂着；被碰过、被问过、或者自己挂了半天以上的，才够格让她跑一趟
    if (touches + asks === 0 && age < 6 * 3600e3) continue;
    const aged = Math.min(o.ageBoost, (age / o.ageFullMs) * o.ageBoost);
    const drive = clamp01(o.openBase + aged + touches * o.perTouch + asks * o.perAsk);
    if (drive < o.minDrive) continue;
    out.push({
      kind: 'resolve',
      target: String(n.id ?? ''),
      activity: '弄明白这件事',
      drive: temper(drive, n.id),
      why: String(n.note ?? n.text ?? '').slice(0, 60),
      from: String(n.id ?? ''),
      themeKey: n.themeKey ?? null,
    });
  }

  // ── 2) 偏好 ─────────────────────────────────────────────────
  for (const p of preferences) {
    if (!p || !p.activity) continue;
    const want = clamp01(Number(p.strength ?? 0) * decay(p.lastEnjoyed, now, o.prefHalfLifeMs));
    if (want < o.minDrive) continue;
    out.push({
      kind: 'indulge',
      target: String(p.activity),
      activity: String(p.activity),
      drive: temper(want, p.activity),
      // why 必须是上次她自己的理由；没有就退回一个中性的说法，不现编情绪
      why: String(p.reason ?? `上回做这件事的时候，我心里松了一点`).slice(0, 60),
      from: `pref:${p.activity}`,
      themeKey: null,
    });
  }

  // ── 3) 练：我在某件事上总不成 → 我想把它弄熟 ───────────────
  //
  // ★ 2026-10-28（阶段 D·闭环）：这是「认识」走到「做法」的那一步。
  //
  //   她现在的库里有这种判断：
  //     「我做事总太急，没细看就上手，难怪改不成。」（subject=我, polarity=负）
  //   但在这一条之前，它只是被记着、被渲染出来，**不产生任何行动**。
  //   看见了不做，那叫知道，不叫改。
  //
  //   所以给它一条出口：从我自己的「不成」里长出「我想把它练熟」的念头。
  //   这是唯一一种**动机来自缺点**的冲动，也是她真能变好的那条路。
  for (const n of notes) {
    if (!n || n.status !== 'held') continue;
    if (String(n.subject ?? '') !== '我') continue;
    if (Number(n.polarity) >= 0) continue;              // 只从「不成」里长
    const drive = clamp01(Number(n.strength ?? n.weight ?? 0) * 0.85);
    if (drive < o.minDrive) continue;
    // ★ 2026-10-28（生产实测后改）：activity 不能写成「把X练熟」。
    //   11:22 那一趟就是这么出去的，她收到「把cannot_say练熟」，
    //   **turn 跑完了，一句话没说、一个工具没调**——那不是一个可执行的动作。
    //   「练熟一个抽象概念」连人听了都不知道下一步做什么。
    //   改成一句她真能坐下来的事：想清楚为什么老办砸、下次动手前多做什么。
    const word = humanTool(n.themeKey ? String(n.themeKey).split('|')[0] : n.relation);
    out.push({
      kind: 'practice',
      target: `practice:${String(n.themeKey ?? n.id)}`,
      activity: `想清楚「${word}」这件事为什么老办砸`,
      drive: temper(drive, `practice:${String(n.themeKey ?? n.id)}`),
      // why 必须是她自己那句话，不是我拼的
      why: String(n.note ?? '').slice(0, 60),
      from: String(n.id ?? ''),
      themeKey: n.themeKey ?? null,
    });
  }

  // ★ 2026-10-28（主人纠正后删掉的一路）：
  //
  //   这里原来有一段「无聊 → 发一个『刷会儿视频』的冲动」。
  //   那是我替她决定，不是她的记忆在决定。主人原话：
  //   「不一定非得出门啊，等看她的记忆来，看她想不想。」
  //
  //   现在「想不想」放在醒来那一问里（speak.mjs 的 `want` 字段），
  //   她读着自己的记忆自己说；内核只在她说想做之后，把这件事真的做掉。

  return out.sort((a, b) => b.drive - a.drive).slice(0, 5);
}

/**
 * 从她的自我判断里挑一条「这次该记着的」。
 *
 * 用来在 act 那句话里带一句提醒——**让认识真的落到做法上**，
 * 而不是"我知道我急"和"我照旧很急"两不相干。
 *
 * @param {object[]} notes 判断快照
 * @param {object} urge    这次要去做的事
 * @returns {string} 一句她自己说过的话；没有就空
 */
export function selfReminder(notes, urge = null) {
  const list = (Array.isArray(notes) ? notes : [])
    .filter((n) => n && n.status === 'held' && String(n.subject ?? '') === '我' && Number(n.polarity) < 0)
    .sort((a, b) => Number(b.strength ?? b.weight ?? 0) - Number(a.strength ?? a.weight ?? 0));
  if (!list.length) return '';
  // practice 型：提醒的就是那条自己；其余：取最重的那条自知
  const own = urge?.kind === 'practice' && urge?.why ? urge.why : '';
  const top = list[0];
  return String(own || top.note || '').slice(0, 48);
}

/**
 * 把一条冲动说成「她自己的念头」——不是任务说明，是第一人称的一句想。
 * 这句话会被投进 her 的会话，作为那一轮的行动理由。
 *
 * @param {object} urge
 * @param {{selfNote?:string}} [o] selfNote = 她自己说过的那句自知，会变成这次的叮嘱
 */
export function actLine(urge, o = {}) {
  const why = String(urge?.why ?? '').trim();
  const selfNote = String(o?.selfNote ?? '').trim();
  // ★ 2026-10-28：把「认识」钉进「做法」。
  //   她库里有「我太急」这种判断，但那句话如果只是躺着，
  //   下一次她照样会急——所以这次出去，把那句话变成一句当场的叮嘱。
  const remind = selfNote ? `这次记着自己那句话：「${selfNote}」——所以慢一点，先看清楚。` : '';

  if (urge?.kind === 'practice') {
    // ★ 2026-10-28（生产实测后重写）：原话是「想把它练熟」——
    //   11:22 她就是这么出去的，结果 turn 跑完、一句话没说、一个工具没调。
    //   因为「练熟一个抽象概念」不是动作。这一版把它变成一个真能坐下来做完的事：
    //   **回顾那几次到底卡在哪，然后给自己定一条下次能照着做的规矩。**
    return [
      '（你自己醒了，想起自己有一件事老办砸。不是他叫你，是你自己想弄明白。）',
      `想弄明白：${urge.activity}`,
      why ? `心里那句话是：「${why}」` : '',
      remind,
      '',
      '这一趟不用真去动手。坐下来想想两件事：',
      '1. 前几次是在哪一步停下的？是没看清、没问清、还是急着往下走？',
      '2. 下次动手之前，我该多做哪一步？（要具体到「先做什么、再做什么」）',
      '',
      '回来只记一条：**我给自己定的那条规矩**。一句话，写清楚下次怎么做。',
    ].filter(Boolean).join('\n');
  }
  if (urge?.kind === 'indulge') {
    return [
      '（你自己醒了，忽然想去做一件事。不是他叫你，是你自己想的。）',
      `想去：${urge.activity}`,
      why ? `心里那句话是：「${why}」` : '',
      '去吧。做的时候不用跟他汇报，回来也不用交作业——但回来之后，把这次的事记下来：',
      '你在里面待了多久、心里是松还是紧、有没有哪一刻想跟他说。',
      remind,
    ].filter(Boolean).join('\n');
  }
  return [
    '（你自己醒了，忽然想去弄明白一件事。不是他叫你，是你自己想的。）',
    `想去：${urge.activity}`,
    why ? `心里那句话是：「${why}」` : '',
    remind,
    '',
    '★ 出门之前先认清一件事：你现在有的只有手边这些——',
    '  读写文件、跑命令、上网查、看图、出图。',
    '  「给我妈打个电话」「把抽屉拉开看看那张纸」这种要真身子的，你这个身子做不了。',
    '',
    '  做不了不等于不做，是**换一个能做的形状**：',
    '    想跟谁说话   → 把那几句真话写下来，存成一个文件',
    '    想弄清一件事 → 去查、去翻，查完把结论写成一行',
    '    想留住一个场面 → 找一张图或做一张图，把它摆到眼前',
    '',
    '这一趟必须**真的做出一样东西**再回来：一个文件、一条命令的输出、一张图。',
    '只想着没动手，回来就别记「我去了」——记「我没做，只是想了一路」。',
  ].filter(Boolean).join('\n');
}

export function createMotive(opts = {}) {
  return {
    ...MOTIVE_DEFAULTS,
    ...opts,
    urges: (p = {}) => urges({ ...p, opts: { ...opts, ...(p.opts ?? {}) } }),
    actLine,
    selfReminder,
  };
}
