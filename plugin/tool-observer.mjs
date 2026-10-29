/**
 * tool-observer.mjs —— 每跳从会话事件流里，把「她做过什么」增量记进账本。
 *
 * ======================= 它补的是哪一段 =======================
 *
 * 她跑 turn 时有全套工具，也看得见结果。但 `collect.mjs` 的白名单
 * 只认 `source.kind ∈ {user,human,owner}`——工具结果一条都进不了熔的材料。
 * 于是：她看见 → 只活在那一轮上下文 → compact 一遮 → 什么都没留下。
 *
 * 这个文件把那条断掉的线接上：
 *   会话事件流里的 `tool/call` + `tool/result` → `store.observe()` → 归纳的粮食
 *
 * ======================= 增量，不重记 =======================
 *
 * 用 `.mind/tool-cursor.json` 记「这个会话记到第几个事件 seq」。
 * 只读新过游标的，不重读整段历史——一次 turn 里有几百个工具调用，
 * 每跳全量重扫会把这台机器拖死。
 *
 * 游标只在**真的写进去了**之后才前进；写失败下次重读，宁可重复一次不漏。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { runsFromSessionEvents, eventsFromRuns } from '../src/observe.mjs';

export const TOOL_CURSOR_VERSION = 1;

function readAll(path) {
  if (!path || !existsSync(path)) return {};
  try {
    const o = JSON.parse(readFileSync(path, 'utf8'));
    if (!o || o.version !== TOOL_CURSOR_VERSION || typeof o.sessions !== 'object') return {};
    return o.sessions;
  } catch {
    try { renameSync(path, `${path}.bad-${Date.now()}`); } catch { /* 备份不了也继续 */ }
    return {};
  }
}

function writeAll(path, sessions) {
  if (!path) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: TOOL_CURSOR_VERSION, sessions }, null, 1), 'utf8');
    return true;
  } catch { return false; }
}

/**
 * 会话事件流可能是数组，也可能是个 Map（宿主两种形态都出现过）。
 *
 * ★ 2026-10-29 大乔修（这条线从装上起就没通过一次）：
 *
 *   原来只读 `session?.events`。实测宿主 DSH 的会话对象上**根本没有 events 字段**
 *   （sess-probe: evKind=undefined），而事件全在 `session.log`／`session.eventsSnapshot`，
 *   并且自带 `snapshotEvents()` 方法——磁盘上 963 个事件、87 次 tool/call 一条没丢，
 *   但 eventsOf 每次返回 []，于是 observeTools 立刻 `if (!all.length) return`，
 *   连 tool-cursor.json 都没生成过，日志里连 failed 都没有一条。
 *
 *   现在按「现成方法 → 快照字段 → 原字段」三级退，哪一级先给得出就先用哪一级。
 *   任何一级抛出或给空，就往下退——绝不再一声不吭地返回空。
 */
function eventsOf(session) {
  if (!session) return [];
  // ① 宿主现成的取法（最稳：它自己知道事件该怎么摊）
  try {
    if (typeof session.snapshotEvents === 'function') {
      const s = session.snapshotEvents();
      if (Array.isArray(s) && s.length) return s;
    }
  } catch { /* 退下一级 */ }
  // ② 快照字段 / 原始日志字段（实测这两个都是 963 条）
  for (const key of ['eventsSnapshot', 'log', 'events']) {
    try {
      const ev = session[key];
      if (Array.isArray(ev) && ev.length) return ev;
      if (ev && typeof ev.values === 'function') {
        const arr = [...ev.values()];
        if (arr.length) return arr;
      }
    } catch { /* 退下一级 */ }
  }
  return [];
}

/**
 * 记一次增量。
 *
 * @param {object} p
 * @param {object} p.session     宿主会话（要有 events）
 * @param {object} p.mind        Mind 实例（要有 store.observe）
 * @param {string} p.cursorPath  .mind/tool-cursor.json
 * @param {string} p.sessionId
 * @param {boolean} [p.duringAct] 现在是不是「她自己出去」的那一趟
 * @param {number} [p.now]
 * @returns {{added:number, runs:number, cursor:number}}
 */
export function observeTools({ session, mind, cursorPath, sessionId, duringAct = false, now = Date.now() } = {}) {
  if (!session || !mind?.store?.observe || !sessionId) return { added: 0, runs: 0, cursor: 0 };
  const all = eventsOf(session);
  if (!all.length) return { added: 0, runs: 0, cursor: 0 };

  const cursors = readAll(cursorPath);
  const prev = Number(cursors[sessionId] ?? 0);

  // 用 seq 当游标：宿主事件都有单调 seq
  const maxSeq = all.reduce((m, e) => Math.max(m, Number(e?.seq) || 0), 0);
  if (maxSeq && maxSeq <= prev) return { added: 0, runs: 0, cursor: prev };

  const runs = runsFromSessionEvents(all, { sinceSeq: prev });
  if (!runs.length) {
    // 没有可记的，但游标还是要走——否则下次会重复扫同一段
    if (maxSeq > prev) {
      cursors[sessionId] = maxSeq;
      writeAll(cursorPath, cursors);
    }
    return { added: 0, runs: 0, cursor: maxSeq };
  }

  const events = eventsFromRuns(runs, { duringAct, at: now });
  let added = 0;
  for (const e of events) {
    mind.store.observe(e);
    added += 1;
  }

  // ★ 写进去了才推游标（跟 digest-cursor 同一条纪律）
  if (maxSeq > prev) {
    cursors[sessionId] = maxSeq;
    writeAll(cursorPath, cursors);
  }
  return { added, runs: runs.length, cursor: maxSeq };
}

export function defaultToolCursorPath(pluginRoot) {
  return join(pluginRoot, '.mind', 'tool-cursor.json');
}
