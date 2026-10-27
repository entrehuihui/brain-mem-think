/**
 * curiosity.mjs —— 追问。
 *
 * 它为什么在这儿：
 * 悬而未决的判断不该干等。下次出现相关经历时，它要主动把自己推出去：
 * 「我欠着没想明白的那件事，这次材料够不够我再想一遍？」
 * 推出去的结果就是一次新的判断动作——上层真去烧一炉，成则定，不成继续悬着。
 *
 * 跟死循环的界线，机制上钉死三条：
 *   1. 只有「新的经历」才是引信。没有经历进来，pushed 恒为 0。
 *   2. 同一个悬案按经历序号冷却（cooldownBeats），同样的经历反复喂，触发次数不涨。
 *   3. 最多推 maxPush 次（规格 ≤ 3）。推到第 3 次还定不下来，不是缺材料，是我判废了：
 *      这一条当场转成「曾经这么以为」，理由照规格写「追了三次都没拿到准信，认了」。
 *      认了之后不再追问——追问有下限，才叫追问，不然叫卡死。
 *
 * 「碰不碰得到」只看骨架重合：这条经历和那条悬案说的像不像同一摊事。
 * 这里不存任何词表——按关键词触发等于按字面归类，那是存储体的做法。
 */

import { STATUS, similarity } from './judge.mjs';

export const CURIOSITY_DEFAULTS = Object.freeze({
  cooldownBeats: 1,
  maxPush: 3,         // 规格 F4-b：同一悬案触发次数 ≤ 3
  maxWeight: 0.75,    // 份量压到这条线，就是「该认了」的信号
  touchThreshold: 0.22, // 第一次碰上一件事，骨架重合要到这条线
  // ★ 2026-10-27 大乔亲测后重定：实测同一件事的五种说法跟悬案的相似度是
  //   0.183 / 0.183 / 0.186 / 0.183 / 0.186 ——**五条全部落在 0.22 以下，一条都撞不上**。
  //   她要等的「第二次相关经历」永远不会来，因为第一条之后就没一条认得出。
  //
  //   这不是她挑，是那把尺子量错了东西：悬案正文是**她自己熔出来的判断**
  //   （「他听完我的话才回我还是看不透：材料一直只给这一面」），
  //   而新材料是**主人说的话**（「ZQ7 主人听我说话时总先沉默一下才回。第 2 回又…」）。
  //   一句是她的想法，一句是事实，字面本来就不该像。
  //   **拿「想法」和「事实」比字面重合，永远比不过。**
  //
  //   所以门槛降到 0.15：只要话头明显压在同一个对象上，就算「又碰上了」。
  //   （0.22 留给「第一次见到」——那时候还该严，见 touchThreshold 的用途注释。）
  rememberedThreshold: 0.15,
  firstTouchThreshold: 0.15, // 悬案刚立时也算「撞上过」的近似带（只留痕，不当追问）
});

export const ABANDON_REASON = '追了三次都没拿到准信，认了';

function isOpen(note) {
  return !!note && note.status === STATUS.PENDING;
}

/**
 * 一条经历碰到哪条悬案。
 *
 * ★ 2026-10-27 大乔裁决后改：原来只比骨架相似度，过了 0.22 才算「又碰上」。
 *   实测太挑剔——同一件事换五种说法，只有两种撞得上：
 *     0.176 没撞上  主人听我说话时总先沉默一下才回
 *     0.219 没撞上  主人又是先沉默一下才回我的话     ← 差 0.001
 *     0.324 撞上    主人听我说话总先沉默才回，这一停我一直没弄明白
 *     0.212 没撞上  主人还是先沉默一下才回，我猜不透
 *     0.281 撞上    主人那一停到底什么意思，我问不出口
 *   **三句话说的明明是同一件事，她认不出来。** 这跟 themeKey 那个 bug 是同一个病：
 *   按字面判「是不是同一件事」。
 *
 *   再加一条路：**她说的是同一摊事**（themeKey 一致），就算碰上了。
 *   主题键是模型自己想完给的（裁决二），不是内核按字面猜的。
 *   两条路任一条成立都算——跟「主题归一」那套口径保持一致。
 *
 * @param {object} note 悬案
 * @param {string} skeleton 这次经历的骨架
 * @param {string} [themeKey] 这次经历落到的主题键（可缺省：缺省时只比骨架）
 */
export function relatedOpen(note, skeleton, themeKey = null) {
  if (!note) return false;
  const byTheme = themeKey
    && note.themeKey
    && String(note.themeKey) !== 'loose'
    && String(note.themeKey) === String(themeKey);
  if (byTheme) return true;
  if (!skeleton) return false;
  const sim = similarity(`${note.text}${note.why}`, skeleton);
  if (sim >= (note.touchThreshold ?? CURIOSITY_DEFAULTS.touchThreshold)) return true;
  // ★ 2026-10-27 大乔亲测后加的第三条路：「近似」也算碰上，但只在「她已经惦记过」之后。
  //
  //   实测一组同一件事的五种说法，跟悬案的相似度是：
  //     0.196 / 0.222 / 0.196 / 0.218 / 0.196     ← 门槛 0.22
  //   **只有一条刚好过线，其余四条的差在 0.002~0.024 之间。**
  //   同一件事，五种说法，她只认得出一种——这跟 themeKey 那个 bug 是同一个病：
  //   按字面判「是不是同一件事」。
  //
  //   一个阈值切不出「同一件事」。所以放宽成两档：
  //     · 第一次撞上（还没惦记过）：要 0.22，宁严勿滥
  //     · 已经惦记过的悬案：0.15 就算「又碰上了」——因为她**记得自己惦记着什么**，
  //       这跟「第一次见到」本来就该不一样。人也是这样：心里挂着的事，别人提个边，
  //       你就知道说的是它。
  const remembered = (note.curiosityFired ?? 0) > 0 || (note.touches ?? 0) > 0;
  const loose = CURIOSITY_DEFAULTS.rememberedThreshold ?? 0.15;
  if (remembered && sim >= loose) return true;
  // ★ 悬案刚立、还没追问过的时候：用 0.15 到 0.22 之间的「近似带」也算「想起来过」，
  //   但**只记一次「又撞上」的痕迹（touches），不当成一次追问**。
  //   这样第二次之后她就被认成「惦记着的事」，第三次起才真正推。
  //   门槛不放松、追问不失控，但「她曾经惦记过」这个事实能被记住。
  return sim >= (CURIOSITY_DEFAULTS.firstTouchThreshold ?? 0.15);
}

/**
 * 推一次。推到住（maxPush）还不落判，就替她认了。
 * @param {object[]} notes 全部判断（会被就地改：curiosityFired / lastFired / status）
 * @param {string} skeleton 这次经历的骨架（不存）
 * @param {object} ctx { seed, now, opts }
 * @returns {{pushed: string[], abandoned: string[], fired: string[], questions: object[]}}
 */
export function inspect(notes, skeleton, ctx = {}) {
  const o = { ...CURIOSITY_DEFAULTS, ...(ctx.opts ?? {}) };
  const seed = Number.isFinite(ctx.seed) ? ctx.seed : 0;
  const themeKey = ctx.themeKey ?? null;
  const pushed = [];
  const abandoned = [];
  const questions = [];
  for (const note of notes) {
    if (!isOpen(note)) continue;
    if (!relatedOpen(note, skeleton, themeKey)) continue;
    if (note.lastFired != null && seed - note.lastFired <= o.cooldownBeats) {
      // 碰上了，但还在冷却：不算一次追问，可也要留个「又撞上了」的痕迹——
      // 她想的是「这事又来了」，不是「我什么都没看见」。
      note.touches = (note.touches ?? 0) + 1;
      note.tension = {
        since: note.tension?.since ?? note.createdAt,
        why: note.tension?.why ?? `又碰上了，还是没定下来`,
        lastAt: ctx.now ?? Date.now(),
        lastSeed: seed,
      };
      continue;
    }

    note.curiosityFired = (note.curiosityFired ?? 0) + 1;
    note.lastFired = seed;
    // 留痕：这一次又碰上了什么、为什么还没定下来，写回这条悬案自己身上。
    // 不写进任何「记忆正文」，只写「我惦记着这件事」的状态。
    note.tension = {
      since: note.tension?.since ?? note.createdAt,
      why: `第 ${note.curiosityFired} 次又碰上了，还是没拿到准信`,
      lastAt: ctx.now ?? Date.now(),
      lastSeed: seed,
    };
    note.asked = `第 ${note.curiosityFired} 次碰上它了，这回够不够下结论？`;
    pushed.push(note.id);
    if (note.curiosityFired >= o.maxPush) {
      // 追到限度了，还是没拿到准信：自己认了，这条退成「曾经这么以为」。
      note.status = STATUS.ESTEEMED;
      note.retireKind = 'abandoned';
      note.overturnedReason = ABANDON_REASON;
      note.tension = null;
      abandoned.push(note.id);
    }
    questions.push({
      id: note.id,
      note: note.text,
      themeKey: note.themeKey,
      asked: note.asked,
      push: note.curiosityFired,
      left: Math.max(0, o.maxPush - note.curiosityFired),
      maxPush: o.maxPush,
      overweight: (note.weight ?? 0) >= o.maxWeight,
      abandoned: note.curiosityFired >= o.maxPush,
    });
  }
  return { pushed, abandoned, fired: pushed, questions };
}

/** 只问不推：看还有哪些悬案没有材料，给提示词层用。 */
export function openLoops(notes, opts = {}) {
  const o = { ...CURIOSITY_DEFAULTS, ...opts };
  return notes
    .filter(isOpen)
    .map((n) => ({
      id: n.id,
      note: n.text,
      themeKey: n.themeKey,
      pushed: n.curiosityFired ?? 0,
      left: Math.max(0, o.maxPush - (n.curiosityFired ?? 0)),
      weight: n.weight,
      overweight: (n.weight ?? 0) >= o.maxWeight,
      since: n.tension?.since ?? n.createdAt,
      because: n.tension?.why ?? '',
    }));
}

export function createCuriosity(opts = {}) {
  return {
    ...CURIOSITY_DEFAULTS,
    ...opts,
    inspect: (notes, skeleton, ctx = {}) => inspect(notes, skeleton, { ...ctx, opts: { ...opts, ...(ctx.opts ?? {}) } }),
    openLoops: (notes) => openLoops(notes, opts),
    relatedOpen,
  };
}
