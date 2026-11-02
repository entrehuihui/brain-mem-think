/**
 * lookup.mjs —— 想不起来的时候，回去查一次。
 *
 * ======================= 它补的是哪一个洞 =======================
 *
 * `recall.mjs` 的判据是：主题键命中 / 对象命中 / 字面 Dice ≥ 0.2。
 * 纪律很好（取不满就只留底色，不硬凑），但它有个反面：
 *
 *   **我问一件从来没熔成判断的事，她手上就是空的。**
 *
 * 而实情是：那条原文还在。会话在那儿，被遮蔽了而已，不是消失了。
 * 现在的路径里，没有任何一条会把「这个我不知道」变成一个动作。
 *
 * 所以记忆库变成了一份**定稿的读后感**，读完书就没了。
 * 想不起来的时候，没有「回去翻一遍」这条路。
 *
 * ======================= 但我最不想做的事，是把原文搬回来 =======================
 *
 * 主人立的第一铁律是「不存任何原文」。这条我不碰，也不打折。
 *
 * 所以 lookup 只做一件事：**回去翻，但只带回一个坐标**。
 *
 *   翻到原文           → 「我记得有这么一件事，大概是那个意思」
 *   把那句话重述一遍   → 重述的词和原文之间，必须隔开 ≥8 个汉字
 *   隔不开             → **整条丢掉**，宁可说不知道
 *
 * 也就是说：它带回来的不是原文，是**「我想起来了点什么」这个状态**，
 * 以及一条能再去找一次的路标（mount）。正文永远是重述的。
 *
 * ======================= 三条纪律 =======================
 *
 * ① **翻不到就说翻不到。** 返回 `{ found: false }`，不编一句「大概是这样」。
 *    一个人诚实说「我不记得了」，比编一句差不多的要可信得多。
 *
 * ② **重述过不了 8 字闸就整条丢。** 不截断、不改写、不「稍微调整一下」。
 *
 * ③ **原文不落地。** 这个模块的返回值里永远没有原文字段。
 *    它只吐 { found, gist, mount, at }——gist 是她自己的话。
 */

import { longestSharedRun } from './forge.mjs';

export const LOOKUP_DEFAULTS = Object.freeze({
  /** 和判断同一把抄原文的尺：连续 8 个汉字重合 = 抄，不算想起。 */
  copyLimit: 8,
  /** 重述的长度上限。想起来的是一件事，不是一段话。 */
  maxGist: 60,
  /** 每次最多在归档里翻几条材料（别把一整段会话搬进内存）。 */
  maxScan: 40,
});

/**
 * 从一段归档材料里，找跟问题对得上的那一处。
 *
 * **不含任何模型调用**：这是一次纯检索。检索的产物不是答案，是「翻到哪了」。
 *
 * @param {string} question 被问住的这个关键词
 * @param {string[]} materials 归档里的材料（每条一段）
 * @param {object} [opts]
 * @returns {{hit:string, mount:string, at:number}|null} 命中位置；没有就是 null
 */
export function scan(question, materials, opts = {}) {
  const o = { ...LOOKUP_DEFAULTS, ...(opts ?? {}) };
  const q = String(question ?? '').trim();
  if (!q) return null;
  // 关键词去虚字，剩下的才拿去比：否则「那个」「后来」到处都是。
  const STOP = new Set('的一了是着的过很都就还也又再在要会能可没不有这那什么吧呢吗啊'.split(''));
  const needle = [...q].filter((ch) => !STOP.has(ch) && !/[\s，。！？、；：,.!?;:—…·"'「」『』（）()【】\[\]]/.test(ch));
  if (needle.length < 2) return null;   // 一个字没法查，别假装查到了

  const list = (Array.isArray(materials) ? materials : []).slice(0, o.maxScan);
  for (let i = 0; i < list.length; i += 1) {
    const text = String(list[i] ?? '');
    if (!text) continue;
    // 命中要求关键词连着出现（不是散着命中）：散着命中几乎总能对上，等于没筛。
    const hit = needle.slice(0, Math.min(6, needle.length)).join('');
    if (text.includes(hit)) {
      return { hit, mount: `archive:${i}`, at: i };
    }
  }
  return null;
}

/**
 * 把「翻到的这一处」变成她自己的话。
 *
 * 传进来的 `gist` 是她（或模型）对那一处的重述；这里只干一件事：验它抄没抄。
 *
 * @param {{gist?:string, mount?:string}} raw
 * @param {string[]} materials 用来对照的原文（同一次 lookup 的那几段）
 * @param {object} [opts]
 * @returns {{found:true, gist:string, mount:string}|{found:false, why:string}}
 */
export function shape(raw, materials, opts = {}) {
  const o = { ...LOOKUP_DEFAULTS, ...(opts ?? {}) };
  const gist = String(raw?.gist ?? '').trim();
  const mount = String(raw?.mount ?? '').trim();
  if (!gist) return { found: false, why: '翻到了地方，可我一句都想不起来怎么说' };
  if (!mount) return { found: false, why: '说不上来是在哪儿翻到的' };
  if ([...gist].length > o.maxGist) {
    return { found: false, why: '想起来的是一件事，不是一整段话' };
  }
  const copied = longestSharedRun(gist, materials);
  if (copied >= o.copyLimit) {
    // ★ 这是整套设计最要紧的一条：能背下来 = 不是在想起，是在复读。
    return { found: false, why: `重述的话跟原文连着 ${copied} 个字一样，那不算想起` };
  }
  return { found: true, gist, mount };
}

/**
 * 一步做完：翻 + 重述 + 过闸。
 *
 * @param {string} question
 * @param {string[]} materials
 * @param {(hit:{hit,mount,at}, materials:string[]) => Promise<string>|string} restate
 * @param {object} [opts]
 */
export async function lookup(question, materials, restate, opts = {}) {
  const found = scan(question, materials, opts);
  if (!found) return { found: false, why: '翻了，没有对得上的。这事我确实不记得了。' };
  let gist = '';
  try {
    gist = await restate(found, materials);
  } catch {
    gist = '';
  }
  return shape({ gist, mount: found.mount }, materials, opts);
}

/** 它能不能被当成「想起了点什么」摆进她的世界。 */
export function lookupLine(result) {
  if (!result) return [];
  if (!result.found) {
    // 翻不到就说翻不到——这句本身就是诚实，不该被藏起来。
    return [`我想不起来这一件。回去翻了，没有找到。`];
  }
  return [`我想起来这件事了：${result.gist}`];
}

export function createLookup(opts = {}) {
  return {
    ...LOOKUP_DEFAULTS,
    ...opts,
    scan: (q, m) => scan(q, m, opts),
    shape: (raw, m) => shape(raw, m, opts),
    run: (q, m, restate) => lookup(q, m, restate, opts),
    line: lookupLine,
  };
}
