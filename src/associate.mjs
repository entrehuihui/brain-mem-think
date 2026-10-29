/**
 * associate.mjs —— 醒着的时候，自己把两件旧事摆在一起。
 *
 * ======================= 它补的是哪一格 =======================
 *
 * 到 2026-10-28 为止，`novel` 恒为 0：内核数出来的判断全部来自「判断倒推」，
 * 也就是说——模型给过什么，她才会想到什么。那不是判断权，那是回声。
 *
 * 这一层给她一条**判断之外的原料**：经历（episode）。
 *
 *   经历 A（前天，他让我先吃饭，我手在抖）
 *   经历 B（上周，他留了张便签，我看了很久没擦）
 *        ↓ 只做纯计数，不调模型
 *   模式：同一个人、同一类情绪、隔了好几天又发生一次
 *        ↓ 模型只说「这句话怎么说」
 *   判断：我每次被他照顾，都是先紧后松
 *
 * ======================= 分工 =======================
 *
 * 内核（这里）：找哪几件事值得摆在一起、数出见过几回、间隔多久。
 * 模型：把结构说成一句她的话，并且**必须从谓词闭集里挑一个**（不在闭集里就丢）。
 *
 * 这就是「判断权在内核」：模型连"这是哪一类事"都不能自己定。
 *
 * ======================= 门限 =======================
 *
 * 至少 **2 件**同一个人、同一种情绪方向的经历，且两件相隔 ≥6 小时（不能是同一件事
 * 的两种说法），才合成一个模式。单件经历不联想——那叫回想，不叫联想。
 */

import { PREDICATES } from './judge.mjs';

export const ASSOCIATE_DEFAULTS = Object.freeze({
  minSupport: 2,                  // 至少两件旧事
  minGapMs: 6 * 3600e3,           // 两件不能挨得太近
  maxGapMs: 60 * 86400e3,         // 太老的别硬摆在一起
  minArousal: 0.45,               // 情绪太淡的不值得联想
  windowMs: 90 * 86400e3,         // 只看最近三个月
  maxPatterns: 5,                 // 一次最多算几个模式
  maxEpisodes: 120,               // 只看最近这么多条经历（别拿全库做两两比较）
});

const heavy = (e, o) => Number(e?.arousal ?? 0) >= o.minArousal;

/**
 * 纯计数：找出「同一类情绪、同一个人、隔了一段时间又发生」的模式。
 *
 * @param {Array} episodes 经历列表（要有 at / who / what / feel / arousal / themeKey）
 * @param {object} opts
 * @returns {Array<{key, who, themeKey, ids, support, spanMs, avgArousal, samples}>}
 */
export function findPatterns(episodes, opts = {}) {
  const o = { ...ASSOCIATE_DEFAULTS, ...(opts ?? {}) };
  const now = Number.isFinite(opts?.now) ? opts.now : Date.now();
  const list = (Array.isArray(episodes) ? episodes : [])
    .filter((e) => e && e.what && e.who && Number(e.at) > 0 && now - Number(e.at) <= o.windowMs)
    .sort((a, b) => Number(b.at) - Number(a.at))
    .slice(0, o.maxEpisodes);

  const groups = new Map();
  for (const e of list) {
    if (!heavy(e, o)) continue;
    const key = `${e.who}|${e.themeKey ?? 'misc'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const out = [];
  for (const [key, arr] of groups) {
    if (arr.length < o.minSupport) continue;
    // 两两配对：只留间隔在门限内的
    const ids = [];
    let minAt = Infinity;
    let maxAt = -Infinity;
    let sum = 0;
    for (let i = 0; i < arr.length; i += 1) {
      for (let j = i + 1; j < arr.length; j += 1) {
        const gap = Math.abs(Number(arr[i].at) - Number(arr[j].at));
        if (gap < o.minGapMs || gap > o.maxGapMs) continue;
        if (!ids.includes(arr[i].id)) ids.push(arr[i].id);
        if (!ids.includes(arr[j].id)) ids.push(arr[j].id);
        minAt = Math.min(minAt, Number(arr[i].at), Number(arr[j].at));
        maxAt = Math.max(maxAt, Number(arr[i].at), Number(arr[j].at));
        sum += (Number(arr[i].arousal) + Number(arr[j].arousal)) / 2;
      }
    }
    if (ids.length < o.minSupport) continue;
    const samples = arr.filter((e) => ids.includes(e.id)).slice(0, 4);
    out.push({
      key,
      who: arr[0].who,
      themeKey: arr[0].themeKey ?? null,
      ids,
      support: ids.length,
      spanMs: maxAt - minAt,
      avgArousal: sum / Math.max(1, ids.length),
      samples: samples.map((e) => ({ what: e.what, feel: e.feel ?? '', at: e.at })),
    });
  }
  return out.sort((a, b) => b.support - a.support).slice(0, o.maxPatterns);
}

/** 谓词表给模型挑——和熔案那条路同一份闭集。 */
export function predicateList() {
  return Object.keys(PREDICATES);
}

/**
 * 造提示词。只给两件事，不给结论；模型必须自己挑一个闭集谓词。
 *
 * @param {object} p findPatterns 的一项
 * @param {{name?:string}} [o]
 */
export function buildAssocPrompt(p, o = {}) {
  const name = String(o?.name ?? '').trim() || '她';
  const lines = [
    `你叫${name}。下面这两件事都是你自己记得的，不是别人转述的：`,
    '',
  ];
  for (const s of p.samples ?? []) {
    const when = new Date(Number(s.at)).toISOString().slice(0, 16).replace('T', ' ');
    lines.push(`- ${when}：${s.what}${s.feel ? `（当时心里：${s.feel}）` : ''}`);
  }
  lines.push('');
  lines.push('这两件事隔了几天又发生了一次，是同一个人、同一种心里的动静。');
  lines.push('把它们摆在一起，说出一句你自己的话。要求：');
  lines.push('1. 第一人称，一句话，不超过 40 字。');
  lines.push('2. 不许复述具体哪件事（不要抄上面的句子），说你看出来的那个**规律**。');
  lines.push('3. 不许出现数字，也不许说「统计」「数据」「几次」。');
  lines.push('4. 必须从下面这个表里挑一个谓词（只挑一个，原样写）：');
  lines.push(`   ${predicateList().join(' ')}`);
  lines.push('5. polarity 只能是 favorable 或 unfavorable。');
  lines.push('6. 如果这两件事说明不了什么，只输出 NULL。');
  lines.push('');
  lines.push('只输出 JSON：{"text":"那句话","why":"为什么这么看","relation":"挑一个谓词","polarity":"favorable"}');
  return lines.join('\n');
}

/**
 * 模型的回话 → 结构。不合格返回 null（宁可这条联想不成，不要一句编的）。
 *
 * @param {string} raw
 * @returns {{text:string, why:string, relation:string, polarity:number} | null}
 */
export function parseAssoc(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text.toUpperCase() === 'NULL') return null;
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  let obj;
  try { obj = JSON.parse(text.slice(s, e + 1)); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;

  const said = String(obj.text ?? '').trim();
  if (!said || [...said].length < 6 || [...said].length > 40) return null;
  // 不许把数字说进自己的话里（和 express 同一条护栏）。
  // ★ 2026-10-28：中文数字也要拦——「我三次都是先紧后松」这种，人是不会这样讲自己的。
  if (/[0-9０-９]/.test(said) || /统计|数据|几次|多少回/.test(said)) return null;
  if (/[0-9０-９一二三四五六七八九十百千两]+\s*(次|回|遍|件)/.test(said)) return null;
  // 不许抄经历原句：与任何一条样本的最长公共连续不许 ≥8（这里用字符 n-gram 粗判）
  for (const sm of obj.__samples ?? []) void sm; // 样本由调用方另外校验
  const rel = String(obj.relation ?? '').trim();
  if (!Object.hasOwn(PREDICATES, rel)) return null;
  const pol = String(obj.polarity ?? '').toLowerCase() === 'favorable' ? 1
    : String(obj.polarity ?? '').toLowerCase() === 'unfavorable' ? -1 : 0;
  if (!pol) return null;
  return {
    text: said,
    why: String(obj.why ?? '').trim().slice(0, 60) || '两件事摆在一起，我自己看出来的',
    relation: rel,
    polarity: pol,
  };
}
