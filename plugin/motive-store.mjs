/**
 * motive-store.mjs —— 偏好与预算的那本账。
 *
 * 为什么不和判断库同文件：失败等级不一样。
 *   判断库写坏 = 她这个人没了；
 *   偏好写坏   = 她少一次想出门的念头。
 * 跟 wake.json 分两个文件，理由同源。
 *
 * 坏状态一律往「不出门」倒：
 *   文件不存在   → 空账，但偏好为空 = 暂时没有想做的事（合法，不是坏）
 *   JSON 坏了   → 备份成 .bad-<时间戳>，当空账
 *   schema 不对 → 同上
 *   写入失败     → 这一回的 act 不记账（宁可重来一次，不假装做过）
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const MOTIVE_SCHEMA = 1;

export function emptyMotive() {
  return {
    version: MOTIVE_SCHEMA,
    preferences: [],
    budget: { dayKey: '', actsToday: 0, lastActAt: 0, lastActivity: null, lastKind: null, recentActs: [] },
    pending: null,
  };
}

export function defaultMotivePath(pluginRoot) {
  return join(pluginRoot, '.mind', 'motive.json');
}

function atomicWrite(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function readMotive(path) {
  if (!path || !existsSync(path)) return emptyMotive();
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return { ...emptyMotive(), degraded: 'unreadable' }; }
  let obj;
  try { obj = JSON.parse(raw); } catch {
    try { renameSync(path, `${path}.bad-${Date.now()}`); } catch { /* 备份不了也继续 */ }
    return { ...emptyMotive(), degraded: 'corrupt-json' };
  }
  const ok = obj && typeof obj === 'object' && obj.version === MOTIVE_SCHEMA
    && Array.isArray(obj.preferences) && obj.budget && typeof obj.budget === 'object';
  if (!ok) {
    try { renameSync(path, `${path}.bad-${Date.now()}`); } catch { /* 同上 */ }
    return { ...emptyMotive(), degraded: 'bad-schema' };
  }
  return { ...emptyMotive(), ...obj, degraded: undefined };
}

export function writeMotive(path, state) {
  if (!path) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const body = { ...emptyMotive(), ...state, version: MOTIVE_SCHEMA };
    delete body.degraded;
    atomicWrite(path, JSON.stringify(body, null, 1));
    return true;
  } catch {
    return false;
  }
}

/** 启动时顺手清掉上次崩在写盘中间留下的临时文件。 */
export function sweepMotiveTemps(path) {
  if (!path) return 0;
  const dir = dirname(path);
  if (!existsSync(dir)) return 0;
  let n = 0;
  try {
    for (const f of readdirSync(dir)) {
      if (f.startsWith('motive.json.tmp-')) {
        try { unlinkSync(join(dir, f)); n += 1; } catch { /* 删不掉就算了 */ }
      }
    }
  } catch { /* 目录读不了就算了 */ }
  return n;
}
