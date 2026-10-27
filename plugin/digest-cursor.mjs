/**
 * digest-cursor.mjs —— 「她已经熔到哪一条了」的一本小账。
 *
 * ======================= 它为什么必须存在 =======================
 *
 * 主人要的是：**每次跟她说话，都把这一轮融进她的记忆。**
 *
 *   「她把自己的融合的记忆当上下文 + 我的话 → 请求 LLM → 返回他的记忆」
 *   「我再问：上一次返回（就是经过 LLM 融合的）+ 我的问题 → 返回他的记忆」
 *
 * 也就是说她的对话不是「聊天记录累积」，而是**记忆的迭代**：
 *   记忆₀ + 你的话₁ → 记忆₁
 *   记忆₁ + 你的话₂ → 记忆₂
 *
 * 要做到这一点，就得知道「上一次熔到第几条主人消息」——否则每分钟的 tick
 * 会把同一段对话反复熔，记忆里灌满重复的判断（这个坑 10-27 已经踩过：
 * 同一次归档被熔了五遍）。
 *
 * ======================= 只记条数，不记内容 =======================
 *
 * 这里只有 { sessionId: ownerCount }，不存一个字。
 * 主人消息本身活在会话里，熔完就过；这本账只回答「新的从第几条开始」。
 * 条数变少 = 会话被压缩/重写 → 归零重熔，宁可重复一次也不要漏。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

export const CURSOR_VERSION = 1;

export function readCursors(path) {
  const p = String(path);
  if (!existsSync(p)) return {};
  let raw;
  try { raw = readFileSync(p, 'utf8'); } catch { return {}; }
  let obj;
  try { obj = JSON.parse(raw); } catch {
    try { renameSync(p, `${p}.bad-${Date.now()}`); } catch { /* 备份不了也继续 */ }
    return {};
  }
  if (!obj || typeof obj !== 'object' || obj.version !== CURSOR_VERSION) return {};
  return obj.cursors && typeof obj.cursors === 'object' ? obj.cursors : {};
}

export function writeCursor(path, sessionId, ownerCount) {
  const p = String(path);
  const cursors = readCursors(p);
  cursors[sessionId] = Math.max(0, Number(ownerCount) || 0);
  try {
    mkdirSync(dirname(p), { recursive: true });
    const text = JSON.stringify({ version: CURSOR_VERSION, cursors }, null, 1);
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    const fd = openSync(tmp, 'w');
    try { writeFileSync(fd, text, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

/** 这次该熔哪一段：返回 { fresh, cursor, total }，没有新的就 fresh 为空。 */
export function sliceFresh(ownerMessages, cursor = 0) {
  const list = Array.isArray(ownerMessages) ? ownerMessages : [];
  const total = list.length;
  const from = Number(cursor) > total ? 0 : Math.max(0, Number(cursor) || 0);
  return { fresh: list.slice(from), cursor: from, total, reset: Number(cursor) > total };
}
