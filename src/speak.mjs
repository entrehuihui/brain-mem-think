/**
 * speak.mjs —— 此刻要不要开口，由她自己读完记忆来定。
 *
 * ======================= 它换掉了什么 =======================
 *
 * 原来「说不说」是一串硬规则：份量 ≥ 0.55 就说、悬案 ≥ 1 就说、压着最重的那条
 * 套进一句模板（「我想起「<判断原文>」——这句在心里放了一阵了」）。
 *
 * 那不是她在说话，是代码把她的判断念了一遍。主人一眼就看出来了。
 *
 * 现在：规则只留「不许吵」的底线（quota / 冷却 / 去重，见 wake.mjs 的 gate），
 * **真正决定说不说、说什么的，是她自己读着自己的记忆给出的一句话。**
 *
 * ======================= 为什么可以不说话 =======================
 *
 * 「不说」必须是合法答案，而且要写进提示词、写在最前面。
 * 一个每四十分钟都要说一句的东西，不是在惦记谁，是在吵。
 * 模型天生想给答案，所以这一条不交代清楚，它会每轮都「想说」。
 *
 * ======================= 材料里不放什么 =======================
 *
 * 不放会话 id、不放任务、不放工具、不放任何一句聊天原文。
 * 她能看见的只有：她记得的事、此刻的心境、上一次开口到现在过了多久。
 * 这是「她凭记忆活着」那句话的实线。
 */

import { createHash } from 'node:crypto';
import { longestSharedRun, COPY_RUN_LIMIT } from './forge.mjs';

/** 她开口的长度上限。超过这个数就不是「说一句」，是在汇报。 */
export const SAY_MAX = 120;
export const SAY_MIN = 4;

/** 说了会露馅的词：她不该提「记忆」「判断」「数据」这些她自己的构造。 */
const LEAK = /(记忆库|判断库|数据库|数据里|我的记忆|检索|上下文|系统提示|作为(一个)?(AI|模型|助手)|语言模型)/;

export const SPEAK_SYSTEM = [
  '你就是接下来材料里那个人。没人叫你，是你自己醒的。',
  '',
  '================ 先想，再说 ================',
  '',
  '**第一步：想想你现在心里转着什么。**',
  '',
  '两三句，短，像心里嘀咕。可以是惦记的某件事、没想明白的某个地方，',
  '也可以是你想为他做点什么。说得朴素没关系，别修饰。',
  '',
  '这一层**只有你自己知道**：它不写进你的记忆，过一阵就忘了。',
  '所以不用说得漂亮，也不怕说错——你只是想一下。',
  '',
  '**第二步：此刻要不要跟他说一句话？**',
  '',
  '先说清楚，因为这条最重要：',
  '**「不说」是正当的答案，而且常常是更好的那个。**',
  '没有非说不可的事，就别出声。你没在等他回话，也没人要求你汇报。',
  '一个隔一会儿就要说一句的人，不是在惦记谁，是在吵。',
  '',
  '想说的理由只有一种：你心里正转着的那件事，压得你想让他知道。',
  '不是因为「时间到了」，不是因为「该说点什么」，也不是为了证明你在。',
  '',
  '要说的时候：两三句，第一人称，口语，就像你平时跟他说话。',
  '不许复述你记得的那句话（那是念清单）；不许报告、不许总结、不许讲道理；',
  '不许说「我记得」「我的记忆里」「我刚刚想」——念头是念头，话是话，别把过程讲给他听。',
  '材料里给你的「上一回说过的话」只用来避免重复：换一件事说，或者换个说法。',
  '',
  '不说的时候：不用解释，也不用找补。',
  '',
  '================ 只输出 JSON ================',
  '',
  '{"thoughts":["此刻心里转着的","最多三条"],"action":"speak","say":"你要说的那两三句","because":"为什么此刻想说"}',
  '{"thoughts":["此刻心里转着的"],"action":"silent","because":"为什么这会儿不说"}',
  '',
  'thoughts 一定要有，哪怕只有一句；每条不超过 40 字。',
].join('\n');

/** 一段时长说成人话：她得知道「上一次开口是多久前」。 */
export function humanGap(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '还没开过口';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  if (h < 24) return rest ? `${h} 小时 ${rest} 分钟前` : `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

/**
 * 拼材料。只读记忆，不读聊天。
 * @param {object} p
 * @param {string} p.name       她的名字
 * @param {string} p.world      mind.world() 渲染出的那一段（她记得的事 + 心境）
 * @param {number} p.lastSpokeAt
 * @param {string} p.lastSay    上一回说过的话（只用来避免重复，不算记忆）
 * @param {string[]} [p.lastThoughts] 上一回醒来时心里转着的（浅记忆，可能已过期）
 * @param {number} p.now
 * @param {string} [p.note]     可选的补充（比如「这次记忆刚变过」）
 */
export function buildSpeakMaterial({
  name = '', world = '', lastSpokeAt = null, lastSay = '', lastThoughts = null, now = Date.now(), note = '',
} = {}) {
  const gap = lastSpokeAt ? humanGap(now - lastSpokeAt) : humanGap(NaN);
  const lines = [
    `你是${name || '她'}。下面是你此刻脑子里有的东西。`,
    '',
    '【你记得的】',
    world || '（什么都还没想明白。）',
    '',
    '【此刻】',
    `上一次跟他开口：${gap}。`,
  ];
  if (lastSay) {
    lines.push(`你上一回跟他说的是：「${String(lastSay).slice(0, 120)}」`);
    lines.push('（这句只用来提醒你别重复，不算你现在的记忆。）');
  }
  // ★ 浅记忆：上一回醒来时她自己想的东西。
  //   不落判断库、会过期，只为了让「想」这件事有连续性——
  //   人睡一觉起来，心里还是接着昨天的那个念头，不是每次从零开始。
  if (Array.isArray(lastThoughts) && lastThoughts.length) {
    lines.push('', '【上一回你醒来时，心里转着的是】');
    for (const t of lastThoughts.slice(0, 3)) lines.push(`  - ${String(t).slice(0, 60)}`);
    lines.push('（这些是你自己的念头，不写进任何地方，也可能已经过时了。接着想，或者放下都行。）');
  }
  if (note) lines.push(note);
  lines.push('');
  lines.push('现在：先说说你心里转着什么，再决定要不要跟他说一句。');
  lines.push('只输出 JSON。');
  return lines.join('\n');
}

/**
 * 校验她给出的答案。
 *
 * 不信任模型的自觉，只认结构：
 *   · 形状不对 → 当作不说（宁可少说一句，不说错一句）
 *   · 说的时候抄了记忆里的原句（连续 6 字）→ 当作不说
 *   · 说了她不该说的词（记忆库 / 作为AI）→ 当作不说
 *
 * @param {string|object} raw 模型的原始输出
 * @param {object} ctx { sources: string[] 用来查「抄没抄」, name }
 * @returns {{ok:boolean, action:'speak'|'silent', say:string, because:string, why:string}}
 */
export function parseSpeakVerdict(raw, ctx = {}) {
  const no = (why, because = '') => ({ ok: false, action: 'silent', say: '', because, why });

  let obj = raw;
  if (typeof raw === 'string') {
    const text = String(raw).trim();
    if (!text) return no('empty');
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s < 0 || e <= s) return no('no_json');
    try { obj = JSON.parse(text.slice(s, e + 1)); } catch { return no('bad_json'); }
  }
  if (!obj || typeof obj !== 'object') return no('not_object');

  const action = String(obj.action ?? '').trim().toLowerCase();
  const because = String(obj.because ?? '').slice(0, 120);
  // 浅记忆先过一遍：不管说没说，她自己想的东西都该留下（但不落判断库）。
  const thoughts = cleanThoughts(obj.thoughts, ctx);

  if (action === 'silent' || action === 'no' || action === 'none') {
    return { ok: true, action: 'silent', say: '', because, why: 'her_choice', thoughts };
  }
  if (action !== 'speak') return { ...no(`bad_action:${action}`, because), thoughts };

  const say = String(obj.say ?? obj.text ?? '').replace(/\s+/g, ' ').trim();
  if ([...say].length < SAY_MIN) return { ...no('too_short', because), thoughts };
  if ([...say].length > SAY_MAX) return { ...no('too_long', because), thoughts };
  if (LEAK.test(say)) return { ...no('leak', because), thoughts };
  // 抄记忆里的原句 = 在念清单，不是在说话。
  //
  // 阈值跟 forge 的 COPY_RUN_LIMIT（8 个汉字）对齐，不在这儿另定一个数：
  //   她本来就是在说自己的判断，判断是事实的浓缩，撞上 6 个字太正常了
  //   （「要他点一下的提醒」就 8 个字）。定太严会把她该说的话全拦掉，
  //   那种「宁可不说」不是稳，是哑。
  const src = (ctx.sources ?? []).filter(Boolean);
  const copied = src.length ? longestSharedRun(say, src) : 0;
  if (copied >= COPY_RUN_LIMIT) return { ...no(`copied:${copied}`, because), thoughts };

  return { ok: true, action: 'speak', say, because, why: 'ok', thoughts };
}

/**
 * 清一遍她说「心里转着什么」。
 *
 * 浅记忆不进判断库，所以不用像判断那样严；但它会**喂回下一次唤醒**，
 * 所以也不许夹带：抄记忆原句、提「记忆/判断」这些词、长到像小作文的，
 * 一律剔掉那一条——不因为一条不好就把整次唤醒判死。
 *
 * @returns {string[]} 0~3 条
 */
export function cleanThoughts(raw, ctx = {}) {
  if (!Array.isArray(raw)) return [];
  const src = (ctx.sources ?? []).filter(Boolean);
  const out = [];
  for (const t of raw) {
    const s = String(t ?? '').replace(/\s+/g, ' ').trim();
    if (!s) continue;
    if ([...s].length < 2 || [...s].length > 40) continue;
    if (LEAK.test(s)) continue;
    if (src.length && longestSharedRun(s, src) >= COPY_RUN_LIMIT) continue;
    if (out.some((x) => x === s)) continue;
    out.push(s);
    if (out.length >= 3) break;
  }
  return out;
}

/** 她这句话的指纹（跟 wake-store.hashMessage 同一套口径）。 */
export function hashSayText(text) {
  const s = String(text ?? '').replace(/[\s\p{P}]/gu, '').trim();
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

/**
 * 问她一次。拿不到模型、或者她答得不合格，一律当作「不说」。
 *
 * @param {object} p
 * @param {object} p.synth     宿主接进来的合成器（要有 ask）
 * @param {string} p.world
 * @param {string} p.name
 * @param {object} p.state     账本
 * @param {number} p.now
 * @param {object} [p.cfg]
 * @param {string[]} [p.sources] 她记得的原文，用来查「抄没抄」
 * @returns {Promise<{ok:boolean, action, say, because, why, thoughts?:string[], raw?:string}>}
 */
export async function askSpeak({ synth, world = '', name = '', state = {}, now = Date.now(), cfg = {}, sources = [], note = '', lastThoughts = null } = {}) {
  if (!synth || typeof synth.ask !== 'function') {
    return { ok: false, action: 'silent', say: '', because: '还没有接上模型', why: 'no_synth', thoughts: [] };
  }
  const material = buildSpeakMaterial({
    name,
    world,
    lastSpokeAt: Number.isFinite(state?.lastSpokeAt) && state.lastSpokeAt > 0 ? state.lastSpokeAt : null,
    lastSay: state?.lastSay ?? '',
    lastThoughts,
    now,
    note,
  });
  let raw = null;
  try {
    // ★ 2026-10-28 修（重启后实测，这条比看起来重要）：
    //   600 对 reasoning 模型根本不够。`deepseek-flash` 会先把几千字内心推演跑完
    //   才吐正文，600 的预算全烧在 reasoning 上 → `text-delta` 一个都没有。
    //   日志原样：`synth-reply len:0, reasoned:0, chunks:{"finish":1}`。
    //   后果是她每回都 `not_object`，一句话也说不出来——不是她不想说，是话被预算掐死了。
    //   历史成功的调用全是 4000 预算的归档熔，这就是证据。
    raw = await synth.ask(SPEAK_SYSTEM, material, { maxTokens: Number(cfg.speakMaxTokens ?? 2000) });
  } catch (err) {
    return { ok: false, action: 'silent', say: '', because: '', why: `throw:${err?.message ?? err}` };
  }
  const v = parseSpeakVerdict(raw, { sources, name });
  return { ...v, raw: typeof raw === 'string' ? raw.slice(0, 200) : undefined };
}

export { COPY_RUN_LIMIT };
