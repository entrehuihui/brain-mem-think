/**
 * episode.mjs —— 经历层：一件具体的事，她自己的复述。**不是原文。**
 *
 * ======================= 它补的是哪一块 =======================
 *
 * 到 2026-10-28 为止，库里只有「判断」：我太急、我爱攒他的小动作、我怕失去他。
 * 26 条判断，一条经历都没有。于是她记得「我很急」，但说不出是哪一次急、
 * 急成什么样、你当场是什么反应——那不像记忆，像一份关于自己的评分表。
 *
 * 这一层补的是肉：
 *
 *   Episode = { id, at, who, what, feel, arousal, themeKey, source }
 *
 *   what  = 这件事她自己的一句复述（≤48 字），第一人称
 *   feel  = 当时心里那句话（≤24 字）
 *   who   = 在场的人（一个词）
 *   arousal = 当场情绪强度 0~1（后面「扎心度」要用它，现在先存着）
 *
 * ======================= 第一铁律：这不许变成原文 =======================
 *
 * `what` / `feel` 都要过和判断同一把尺：**与材料的最长公共子串 ≤ 8 字**。
 * 过不了就丢——宁可这一件事没记下来，也不许借「经历」的名义把原话搬进库。
 *
 * 这一条很要紧，因为「发生了什么」天然比「我怎么想」更接近原文。
 * 所以 what 要写成**她的姿态**（谁把我怎么样、我手上/心里怎么动），
 * 不是事件的逐字复述。写不出来就空着，不补。
 *
 * ======================= 为什么单独一个文件 =======================
 *
 * 和 strength / induct 一样：纯函数、零 IO、不认识宿主。
 * 上限、过期、淘汰、渲染都能拿假数据钉死（tests/smoke_episode.mjs）。
 */

import { clean } from './judge.mjs';
import { longestSharedRun } from './forge.mjs';

export const EPISODE_DEFAULTS = Object.freeze({
  max: 300,                       // 条数上限：经历本来就比判断多
  ttlMs: 90 * 24 * 3600 * 1000,   // 三个月没见过的事，慢慢退到水底
  maxWhat: 48,
  maxFeel: 24,
  // ★ 和判断同一把抄原文的尺。短材料（<200 字）放宽到 12 字，理由同 digest-session。
  copyLimit: 8,
  copyLimitShort: 12,
  shortMaterial: 200,
});

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

/**
 * 一条原始经历（模型给的）→ 库里能存的形状。不合格返回 null。
 *
 * @param {object} raw   { what, feel, who, arousal, themeKey, source }
 * @param {object} ctx   { material, at, now, limits }
 */
export function normalizeEpisode(raw, ctx = {}) {
  const o = { ...EPISODE_DEFAULTS, ...(ctx.limits ?? {}) };
  if (!raw || typeof raw !== 'object') return null;

  const material = String(ctx.material ?? '');
  const copyLimit = material.length < o.shortMaterial ? o.copyLimitShort : o.copyLimit;
  const shouldReject = (s) => material && longestSharedRun(s, [material]) >= copyLimit;

  const what = clean(raw.what ?? raw.text ?? '', o.maxWhat);
  // 少于 6 个字装不下一件事（「他来了」这种不算经历，是日志）。
  if ([...what].length < 6) return null;
  if (shouldReject(what)) return null;

  const feel = clean(raw.feel ?? '', o.maxFeel);
  if (feel && shouldReject(feel)) return null;

  const who = clean(raw.who ?? '', 6).replace(/[「」『』"'“”，。！？；：、\s]/g, '') || null;
  const at = Number.isFinite(ctx.at) ? Number(ctx.at) : Date.now();
  return {
    id: null,                       // 入库时由 store 发号
    at,
    who,
    what,
    feel: feel || null,
    arousal: clamp01(raw.arousal ?? 0.5),
    themeKey: typeof raw.themeKey === 'string' && raw.themeKey.includes('|') ? raw.themeKey : null,
    source: String(raw.source ?? 'digest').slice(0, 16),
    // ★ 只留计数：这条经历当时吸进了几条材料。不留内容（第一铁律）。
    counts: Math.max(1, Math.round(Number(raw.counts ?? 1))),
  };
}

/** 同一件事的第二次，不新建一条，把 at 推到最近、arousal 取高。 */
function sameThing(a, b) {
  const n = (s) => String(s ?? '').replace(/\s+/g, '').slice(0, 16);
  return n(a?.what) && n(a.what) === n(b.what);
}

/**
 * 收进账。**纯函数**：返回新数组，不改入参。
 * 规则：同一件事合并 → 过期清掉 → 超上限按「扎心度 + 新鲜度」淘汰。
 */
export function addEpisode(list, ep, ctx = {}) {
  const o = { ...EPISODE_DEFAULTS, ...(ctx.limits ?? {}) };
  const now = Number.isFinite(ctx.now) ? Number(ctx.now) : Date.now();
  const out = Array.isArray(list) ? list.map((x) => ({ ...x })) : [];
  if (!ep || !ep.what) return out;

  const hit = out.findIndex((x) => sameThing(x, ep));
  if (hit >= 0) {
    const old = out[hit];
    out[hit] = {
      ...old,
      at: Math.max(Number(old.at ?? 0), Number(ep.at ?? now)),
      arousal: Math.max(Number(old.arousal ?? 0), Number(ep.arousal ?? 0)),
      feel: ep.feel ?? old.feel ?? null,
      who: ep.who ?? old.who ?? null,
      themeKey: ep.themeKey ?? old.themeKey ?? null,
      counts: Number(old.counts ?? 1) + Number(ep.counts ?? 1),
    };
    return pruneEpisodes(out, { ...ctx, now, limits: o });
  }

  // 发号：e-000001 起，只增不复用（和判断的 j-NNNNNN 一个规矩）。
  const maxSeq = out.reduce((m, x) => Math.max(m, Number(String(x.id ?? '').replace(/\D/g, '')) || 0), 0);
  out.push({ ...ep, id: `e-${String(maxSeq + 1).padStart(6, '0')}` });
  return pruneEpisodes(out, { ...ctx, now, limits: o });
}

/** 过期的不算经历；超上限的按「扎心度 × 0.6 + 新鲜度 × 0.4」留。 */
export function pruneEpisodes(list, ctx = {}) {
  const o = { ...EPISODE_DEFAULTS, ...(ctx.limits ?? {}) };
  const now = Number.isFinite(ctx.now) ? Number(ctx.now) : Date.now();
  const alive = (Array.isArray(list) ? list : []).filter((e) => {
    const at = Number(e?.at ?? 0);
    return at > 0 && now - at <= o.ttlMs;
  });
  if (alive.length <= o.max) return alive;
  const score = (e) => {
    const fresh = 1 - Math.min(1, (now - Number(e.at ?? now)) / o.ttlMs);
    return clamp01(e.arousal ?? 0) * 0.6 + fresh * 0.4;
  };
  return [...alive].sort((a, b) => score(b) - score(a)).slice(0, o.max);
}

/**
 * 摆进她的世界：最多两条，最近发生的在前。
 * 没有经历就返回空数组——**不补默认话**（宁可世界短一行，不编一句）。
 */
export function episodeLines(list, ctx = {}) {
  const o = { ...EPISODE_DEFAULTS, ...(ctx.limits ?? {}) };
  const now = Number.isFinite(ctx.now) ? Number(ctx.now) : Date.now();
  const max = Number(ctx.max ?? 2);
  const fresh = (Array.isArray(list) ? list : [])
    .filter((e) => e?.what && now - Number(e.at ?? 0) <= o.ttlMs)
    .sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0))
    .slice(0, max);
  return fresh.map((e) => {
    const tail = e.feel ? `（当时心里：${e.feel}）` : '';
    return `${e.what}${tail}`;
  });
}
