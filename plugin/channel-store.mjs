/**
 * channel-store.mjs —— 她那条通道的会话 id，落在盘上。
 *
 * ======================= 为什么要单独存 =======================
 *
 * 会话 id 原来是写死在代码里的一个常量（`DEFAULT_CHANNEL_SESSION_ID`）。
 * 换一条干净的通道就得改代码、重新打包、重启——而它其实只是一行数据。
 *
 * 更要紧的是：**id 只能由宿主 mint**。
 * 自己编一个 `mind-her` 那种 id 会连锁出三件事（10-27 踩了一整天）：
 *   ① 不在 session/list 里 → 侧边栏看不见她；
 *   ② 没有 agentPreset → 装配时 `{{model}}` 没值 → 一回合都走不完；
 *   ③ 空白会话在界面上是隐藏的（client.js 里 `session.blank` 那条）。
 *
 * 所以这里只做两件事：记住宿主给的那个 id，以及下一次换通道时能被覆盖。
 * 不造 id，不猜 id。
 *
 * ============================ 坏状态怎么办 ============================
 *
 * 文件不存在 → 返回 null（等于「还没有通道」，上层去建一条）。
 * JSON 坏了   → 备份成 .bad-<时间戳>，返回 null，同样当没建过。
 * 写不进去     → 返回 false，上层照旧用内存里的 id（这一轮别崩）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CHANNEL_SCHEMA = 1;

export function defaultChannelPath(pluginRoot) {
  return join(pluginRoot, '.mind', 'channel.json');
}

/** 读她那条通道的账。没有 / 坏了都返回 null。 */
export function readChannel(path) {
  const p = String(path);
  if (!existsSync(p)) return null;
  let raw;
  try { raw = readFileSync(p, 'utf8'); } catch { return null; }
  let obj;
  try { obj = JSON.parse(raw); } catch {
    try { renameSync(p, `${p}.bad-${Date.now()}`); } catch { /* 备份不了也继续 */ }
    return null;
  }
  if (!obj || typeof obj !== 'object' || typeof obj.sessionId !== 'string' || !obj.sessionId) return null;
  return obj;
}

/** 原子写。写不进去返回 false，不抛。 */
export function writeChannel(path, { sessionId, createdAt = Date.now(), note = '' } = {}) {
  const p = String(path);
  if (!sessionId) return false;
  try {
    mkdirSync(dirname(p), { recursive: true });
    const body = { version: CHANNEL_SCHEMA, sessionId: String(sessionId), createdAt, note: String(note).slice(0, 120) };
    const text = JSON.stringify(body, null, 1);
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    const fd = openSync(tmp, 'w');
    try { writeFileSync(fd, text, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}
