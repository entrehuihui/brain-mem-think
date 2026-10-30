/**
 * settle.mjs —— 「这一趟到底算不算做成了」。纯函数，零 IO。
 *
 * ======================= 它为什么单独一个文件 =======================
 *
 * 这段判断原来写在 `plugin/index.mjs` 的 tryAct 里面，被 `found = ... : true`
 * 一行糊过去，糊出两个大问题（都是 2026-10-30 线上取证抓到的）：
 *
 *   ① **没去成也算做到了**：被闸挡回来的那趟也写 pending，结算时 want 恒 true，
 *      于是「想去 → 被挡 → found:true → 偏好 +gain → 更想做」成了闭环。
 *      motive.json 里「给我妈打个电话」涨到 0.99 / 8 次，就是这么涨的。
 *
 *   ② **出门当想事儿也算做到了**：真出门那趟判断库 55 → 55、一个工具没调，
 *      22 分钟后她自己说「抽屉还关着，我没动」——可账上记的是「我去读那张纸」。
 *      128 条经历里 83 条是「没去成」、7 条「我去」，其余全混在这儿。
 *
 * 提出来是为了能被假数据钉死（acceptance/s_settle_honest.mjs），
 * 而不是靠正则去抠源码——抠源码的测试，改个换行就假绿了。
 *
 * ======================= 三档，别混 =======================
 *
 *   didn't_go   没出门（被闸挡回来）  → 不算做，也**不结算偏好**（调用方决定）
 *   went_thought 出门了但没动手       → 算「去了没做成」：温和扣分
 *   went_did    出门且真动手          → 算做成
 */

/** 这一趟出门了没有。 */
export function reallyWentOf(pending) {
  return !pending?.skippedWhy;
}

/**
 * 这一趟动手了没有。只认两样硬的：
 *   ① 判断库变多了（notesNow > notesBefore）
 *   ② 工具游标往前走了（toolSeqNow > toolSeqBefore）
 * 两样都没有，就是坐那儿想了一路 —— 不算做事。
 */
export function didSomethingOf({ pending, notesNow, toolSeqNow } = {}) {
  if (!reallyWentOf(pending)) return false;
  const gained = Number(notesNow ?? 0) > Number(pending?.notesBefore ?? 0);
  const called = Number.isFinite(Number(pending?.toolSeqBefore))
    && Number(toolSeqNow ?? 0) > Number(pending?.toolSeqBefore ?? 0);
  return gained || called;
}

/**
 * 结算裁定。
 *
 * @param {object} p
 * @param {object} p.pending     这一趟的 pending（带 skippedWhy / notesBefore / toolSeqBefore）
 * @param {string} p.kind        'resolve' | 'want' | 'indulge' | 'practice'
 * @param {number} p.notesNow    现在判断库多少条
 * @param {number} p.toolSeqNow  现在工具游标走到哪
 * @returns {{went:boolean, did:boolean, found:boolean, verdict:'didnt_go'|'went_thought'|'went_did'}}
 */
export function settleVerdict({ pending, kind, notesNow = 0, toolSeqNow = 0 } = {}) {
  const went = reallyWentOf(pending);
  if (!went) {
    return { went: false, did: false, found: false, verdict: 'didnt_go' };
  }
  const did = didSomethingOf({ pending, notesNow, toolSeqNow });
  // 收获型（想去弄明白）必须带回东西；满足型（想去做点什么）走完整一趟就算，
  // 但「完整一趟」现在有了硬判据：真的动手了才算，不是出门就算。
  const found = kind === 'resolve'
    ? Number(notesNow ?? 0) > Number(pending?.notesBefore ?? 0)
    : did;
  return { went: true, did, found, verdict: did ? 'went_did' : 'went_thought' };
}

/** 这一趟该不该动偏好：没出门就不动（没做过的事，没有喜不喜欢可言）。 */
export function shouldChargePrefs(verdict) {
  return verdict !== 'didnt_go';
}

/** 该扣多少：去了没动手是温和扣，别按「空转」的 0.2 一脚踹到底。 */
export function loseFor(verdict, defaults = {}) {
  if (verdict === 'went_thought') return 0.06;
  return Number(defaults.lose ?? 0.2);
}

/** 这一趟在经历里怎么写（她自己的口吻，不许含糊）。 */
export function settleLabel(pending, verdict) {
  const activity = String(pending?.activity ?? '');
  if (!activity) return '';
  if (verdict === 'didnt_go') return `我想${activity}，没去成`;
  if (verdict === 'went_thought') return `我想${activity}，去了却没做成`;
  return `我去${activity}`;
}
