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
import { addSaw } from '../src/saw.mjs';

export const TOOL_CURSOR_VERSION = 1;

/**
 * ★ 2026-11-02 小乔加（把 `src/saw.mjs` 真正接上）：
 *
 *   `saw.mjs` 写得很完整——166 行、34 条判据、负控制也验过——可它**从来没人调**。
 *   `grep -rn "saw" plugin/` 一个都中不了。判据测的是它自己的纯函数，
 *   测不到「它有没有真的被这个脑子用上」。这跟 README 第 30 条踩坑是同一类病：
 *   **码写着、接口没人接、而且不报错。**
 *
 *   所以这里不是新造一块功能，是把它接到它本来就该在的那条线上：
 *   她出门那一趟里，`tool/result` 成功落地的那一刻，就是一条「我亲手看过」。
 *
 * ★ 三条口径（跟 saw.mjs 的纪律对齐，这里只负责「喂对料」）：
 *
 *   ① 只认「看」的那几种。`read / write / edit / skill / lookup` 之外的工具
 *      （跑命令、抓网页）在 run 上只有一个名字，没有 mount——**宁可不记**。
 *      编一个 mount 出来就等于承认「我看过的东西我自己都说不出在哪」，那不是证据。
 *   ② 只认成功的。失败的那条已经在 `observe()` 里记成「我用X没成」了，
 *      再记一条「我看过」就等于把没看见的东西算成看见。
 *   ③ `target` 是可选的：这次出门是为了哪条判断（`belief:<id>`）。
 *      不知道就不填——`unverifiedOf()` 那边会把它当成「顺手看了一眼」，
 *      宁可多跑一趟，也不假装看过了。
 */
export const SAW_TOOLS = Object.freeze(['read', 'write', 'edit', 'skill', 'lookup']);

export function sawsFromRuns(runs, { target = null, at = Date.now() } = {}) {
  const out = [];
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!r || !r.ok) continue;
    const kind = String(r.tool ?? '');
    if (!SAW_TOOLS.includes(kind)) continue;
    const callId = String(r.callId ?? '').trim();
    out.push({
      kind,
      // mount 必须指向一个**能回去再找一次**的坐标。callId 就是那个坐标。
      mount: callId ? `tool:${callId}` : '',
      saw: `我自己动手${kind === 'read' ? '读了一遍' : kind === 'skill' ? '学会了一样本事' : '写成了一笔'}`,
      target,
      at: Number(r.at) || at,
    });
  }
  return out;
}

/** 读一份 saw 账。坏文件一律当空——这一支是佐证，坏了不该拖垮主路径。 */
export function readSaws(path) {
  if (!path || !existsSync(path)) return [];
  try {
    const o = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(o?.items) ? o.items : [];
  } catch {
    try { renameSync(path, `${path}.bad-${Date.now()}`); } catch { /* 备份不了也继续 */ }
    return [];
  }
}

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
export function observeTools({ session, mind, cursorPath, sessionId, duringAct = false, now = Date.now(), sawPath = null, target = null } = {}) {
  if (!session || !mind?.store?.observe || !sessionId) return { added: 0, runs: 0, cursor: 0, saws: 0 };
  const all = eventsOf(session);
  if (!all.length) return { added: 0, runs: 0, cursor: 0, saws: 0 };

  const cursors = readAll(cursorPath);
  const prev = Number(cursors[sessionId] ?? 0);

  // 用 seq 当游标：宿主事件都有单调 seq
  const maxSeq = all.reduce((m, e) => Math.max(m, Number(e?.seq) || 0), 0);
  if (maxSeq && maxSeq <= prev) return { added: 0, runs: 0, cursor: prev, saws: 0 };

  // ★ 索引整段 events（不是片段）里的 tool/call —— 这是本跳唯一能拿全的地方。
  //   `eventsFromRuns` 回头要用它补回「片段外那个 call」，否则工具名会退成 unknown。
  const knownCalls = new Map();
  for (const e of all) {
    if (e?.type !== 'tool/call') continue;
    const id = e.data?.callId;
    if (!id) continue;
    knownCalls.set(id, { tool: String(e.data?.name ?? 'unknown'), at: Number(e.at) || 0, seq: Number(e.seq) || 0 });
  }

  const runs = runsFromSessionEvents(all, { sinceSeq: prev, knownCalls });
  if (!runs.length) {
    // 没有可记的，但游标还是要走——否则下次会重复扫同一段
    if (maxSeq > prev) {
      cursors[sessionId] = maxSeq;
      writeAll(cursorPath, cursors);
    }
    return { added: 0, runs: 0, cursor: maxSeq, saws: 0 };
  }

  const events = eventsFromRuns(runs, { duringAct, at: now });
  let added = 0;
  for (const e of events) {
    mind.store.observe(e);
    added += 1;
  }

  // ★ 2026-11-02 小乔加：把「我亲手看过」也落一笔。
  //   跟上面那条是**两本账**：上面记的是「我做过什么」（进判断/归纳的粮食），
  //   这里记的是「我看过什么」（只给 verify 管，不进 Belief 库、不进 Event 流）。
  //   只有 she 真的出门那一趟才写（duringAct）——她平常帮主人干活时读的文件不是「我的经历」。
  let saws = 0;
  if (duringAct && sawPath) {
    const picked = sawsFromRuns(runs, { target, at: now });
    if (picked.length) {
      let list = readSaws(sawPath);
      for (const s of picked) {
        const before = list.length;
        list = addSaw(list, s, { now });
        if (list.length !== before) saws += 1;
      }
      try {
        mkdirSync(dirname(sawPath), { recursive: true });
        writeFileSync(sawPath, JSON.stringify({ version: 1, items: list }, null, 1), 'utf8');
      } catch { /* 这一支写不进去，不拖垮上面那本账 */ }
    }
  }

  // ★ 写进去了才推游标（跟 digest-cursor 同一条纪律）
  if (maxSeq > prev) {
    cursors[sessionId] = maxSeq;
    writeAll(cursorPath, cursors);
  }
  return { added, runs: runs.length, cursor: maxSeq, saws };
}

export function defaultToolCursorPath(pluginRoot) {
  return join(pluginRoot, '.mind', 'tool-cursor.json');
}

/**
 * ★ 2026-10-30 小乔加：只读地问一句「这个会话的工具游标走到哪了」。
 *
 * 用处只有一个：她出门那一趟，**到底有没有真的调过工具**。
 *
 * 为什么非要知道这个：实测她出门回来，判断库 55 → 55 条没变，
 * 而那一趟一个工具都没调——她只是坐那儿想了一路，然后写进经历「我去读那张纸」。
 * 记忆里于是长出一片「我去过」，实际一次手都没动。
 *
 * 这笔账从这里读，配合 pending 上记下的 seq，就知道这趟是「做了」还是「想了」。
 */
export function toolCursorOf(cursorPath, sessionId) {
  const all = readAll(cursorPath);
  return Number(all?.[String(sessionId ?? '')] ?? 0) || 0;
}
