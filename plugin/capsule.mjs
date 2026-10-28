/**
 * capsule.mjs —— 「她每次醒来想了什么」的读取端。
 *
 * 主人要的：像账号池那样的胶囊，点开能看到她每一拍醒来想了什么、说了什么、想做什么。
 *
 * ======================= 为什么读日志，不另存一份 =======================
 *
 * 这些内容 `mind.log` 里本来就有（wake-silent / wake-speak 的 thoughts / want），
 * 再存一份就是两份真相，早晚对不上。这里只做「读 + 归纳 + 限量」，
 * 不改日志、不写新文件。
 *
 * ======================= 第一铁律管不着它，但也不许寄 =======================
 *
 * 日志里本来就有她的话；这个接口只给**本机的人**看（loopback 才放行），
 * 不进上下文、不进判断库、不喂回模型。它是「看板」，不是记忆。
 */

import { readFileSync, existsSync } from 'node:fs';

export const CAPSULE_DEFAULTS = Object.freeze({
  maxEntries: 40,        // 最多回多少拍
  maxRawBytes: 4 * 1024 * 1024, // 日志超过这个就不全读（只读尾巴）
  tailBytes: 512 * 1024,
});

const KEEP = new Set(['wake-speak', 'wake-silent', 'act-from-want', 'act-exit', 'act-episode', 'act-settle']);

/**
 * 读日志尾巴并解析成事件。日志是逐行 JSON，可能被截断在中间，坏行直接跳过。
 */
export function readLogTail(path, opts = {}) {
  const o = { ...CAPSULE_DEFAULTS, ...(opts ?? {}) };
  const p = String(path ?? '');
  if (!p || !existsSync(p)) return [];
  let text = '';
  try {
    const buf = readFileSync(p);
    const slice = buf.length > o.maxRawBytes ? buf.subarray(buf.length - o.tailBytes) : buf;
    text = slice.toString('utf8');
    // 尾巴切在半个字节/半行里：第一条可能不是完整行，丢掉。
    const firstNl = text.indexOf('\n');
    if (firstNl > 0) text = text.slice(firstNl + 1);
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    if (!KEEP.has(String(e.event ?? ''))) continue;
    out.push(e);
  }
  return out;
}

/** ISO 时间 → 本地「时:分」，给看板用。 */
function hhmm(iso) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 截短，别让看板被一条长句子撑爆。 */
function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 把一串日志事件归纳成「每一拍」。
 *
 * 一拍 = 一次唤醒（wake-speak / wake-silent），她这一拍想做/做了什么挂在后面。
 * @returns {{entries:Array, counts:object, lastAt:string|null}}
 */
export function summarize(events, opts = {}) {
  const o = { ...CAPSULE_DEFAULTS, ...(opts ?? {}) };
  const list = Array.isArray(events) ? events : [];
  const entries = [];
  const acts = [];   // 先收集 act 事件，再挂到最近的一拍上
  const counts = { speak: 0, silent: 0, want: 0, act: 0 };

  for (const e of list) {
    const name = String(e.event ?? '');
    if (name === 'act-from-want' || name === 'act-exit' || name === 'act-episode' || name === 'act-settle') {
      const at = e.at ?? null;
      let kind = 'act';
      if (name === 'act-from-want') kind = 'want-start';
      if (name === 'act-episode') kind = 'episode';
      if (name === 'act-settle') kind = 'settle';
      acts.push({
        at,
        time: hhmm(at),
        kind,
        activity: clip(e.activity ?? e.what ?? '', 40),
        why: clip(e.why ?? '', 60),
        sent: e.sent ?? null,
      });
      if (kind !== 'episode') counts.act += 1;
      continue;
    }
    const isSpeak = name === 'wake-speak';
    const thoughts = Array.isArray(e.thoughts) ? e.thoughts.map((t) => clip(t, 50)).filter(Boolean) : [];
    const want = e.want && e.want.activity
      ? { activity: clip(e.want.activity, 40), why: clip(e.want.why ?? '', 60) }
      : null;
    entries.push({
      at: e.at ?? null,
      time: hhmm(e.at),
      kind: isSpeak ? 'speak' : 'silent',
      byHer: e.byHer ?? null,
      because: clip(e.because ?? e.why ?? '', 80),
      say: isSpeak ? clip(e.say ?? '', 120) : '',
      sent: isSpeak ? e.sent === true : false,
      thoughts,
      want,
    });
    if (isSpeak) counts.speak += 1; else counts.silent += 1;
    if (want) counts.want += 1;
  }

  // 把 act 事件挂到「时间上最近的那一拍」；挂不上的单独列出来（比如重启前后错开）
  for (const a of acts) {
    const t = Date.parse(String(a.at ?? ''));
    let best = null;
    let bestD = Infinity;
    for (const en of entries) {
      const d = Math.abs(Date.parse(String(en.at ?? '')) - t);
      if (Number.isFinite(d) && d < bestD) { bestD = d; best = en; }
    }
    if (best && bestD <= 15000) {
      (best.acts ??= []).push(a);
    } else {
      entries.push({
        at: a.at, time: a.time, kind: 'act', byHer: 'act', because: '',
        say: '', sent: false, thoughts: [], want: null, acts: [a],
      });
    }
  }

  entries.sort((x, y) => Date.parse(String(y.at ?? '')) - Date.parse(String(x.at ?? '')));
  return {
    entries: entries.slice(0, o.maxEntries),
    counts,
    lastAt: entries[0]?.at ?? null,
  };
}
