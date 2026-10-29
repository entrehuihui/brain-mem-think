/**
 * wake-store.mjs —— 她「开过几次口」的那本账，落在盘上。
 *
 * ======================= 为什么必须落盘 =======================
 *
 * 旧插件在这上头栽过：它的配额存在内存里，而插件当时是「每条消息一个进程」，
 * 一重启就归零 → 冷却永远成立 → 等于没有冷却。
 *
 * 现在的宿主是常驻进程，那条根子不存在了。但还有两个真问题：
 *   · 主人重启 DSH，这些账不能跟着没；
 *   · 一个插件崩了重启，不能靠「忘了自己刚说过」蒙混过去。
 *
 * ========================== 为什么单独一个文件 ==========================
 *
 * 不和判断库同文件。理由不是整齐，是**失败等级差一个数量级**：
 *   判断库写坏 = 她这个人没了；
 *   配额写坏   = 她少说两句话。
 * 两种数据不该共用一份文件——写坏一次，代价不一样。
 *
 * ============================ 坏状态一律往「不说」倒 ============================
 *
 * 文件不存在      → 当作刚装好，能说（全新安装不该一上来就哑）
 * JSON 坏了      → **当作「刚说完话」**，进冷却；原文件备份成 .bad-<时间戳>
 * schema 不对    → 同上
 * 写入失败        → 这次就不说（记不住就别开口）
 * 崩在写盘中间    → 看到 crashedMidWake 标记 → 这轮强制沉默
 *
 * 反制：不能因为读不到账本就成了哑巴。所以每过 maxGapMs 至少醒一次——
 * **醒 ≠ 说，不烧 token。**
 *
 * ============================ 写入用两次原子写 ============================
 *
 * 先写带 crashedMidWake:true 的临时文件 → fsync → rename，
 * 再写正式版。这样磁盘上任何时刻要么是上次成功的完整状态，
 * 要么是带崩溃标记的完整状态，**不会是半份**。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SCHEMA_VERSION = 1;
export const DEFAULT_GAP_MS = 30 * 60 * 1000; // 每 30 分钟至少醒一次（醒 ≠ 说）

/** 一个空的账本（刚装好的样子）。 */
export function emptyState(now = Date.now()) {
  return {
    version: SCHEMA_VERSION,
    lastWakeAt: 0,
    lastSpokeAt: 0,
    spokenHashes: [],
    window: [],
    crashedMidWake: false,
    _loadedAt: now,
  };
}

/** 消息归一化：去空白、去标点，用来算「这句是不是又说了一遍」。 */
export function normMessage(text) {
  return String(text ?? '').replace(/[\s\p{P}]/gu, '').trim();
}

/** 归一化之后的短哈希。不存原文——账本里不该留她说过的话。 */
export function hashMessage(text) {
  return createHash('sha1').update(normMessage(text)).digest('hex').slice(0, 16);
}

export function defaultPath() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.';
  return join(home, '.dsh', 'profiles', 'web', 'plugins', 'mind', '.mind', 'wake.json');
}

/** 原子写一个文件：临时文件 → fsync → rename。 */
function atomicWrite(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * 读账本。**坏状态一律往「不说」倒。**
 * @returns {{version,lastWakeAt,lastSpokeAt,spokenHashes,window,crashedMidWake,degraded?:string}}
 */
export function readWake(storePath = defaultPath()) {
  const path = storePath || defaultPath();
  if (!existsSync(path)) return emptyState();

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // 读不出来：当作「刚说完话」，闭嘴一阵。
    return { ...emptyState(), lastSpokeAt: Date.now(), degraded: 'unreadable' };
  }

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    // JSON 坏了：备份原文件，然后当作刚说完话。
    try { renameSync(path, `${path}.bad-${Date.now()}`); } catch { /* 备份不了也要继续 */ }
    return { ...emptyState(), lastSpokeAt: Date.now(), degraded: 'corrupt-json' };
  }

  const okSchema = obj && typeof obj === 'object'
    && obj.version === SCHEMA_VERSION
    && Array.isArray(obj.spokenHashes)
    && Array.isArray(obj.window);
  if (!okSchema) {
    try { renameSync(path, `${path}.bad-${Date.now()}`); } catch { /* 同上 */ }
    return { ...emptyState(), lastSpokeAt: Date.now(), degraded: 'bad-schema' };
  }

  return { ...emptyState(), ...obj, degraded: obj.crashedMidWake ? 'crashed-mid-wake' : undefined };
}

/**
 * 写账本。两次原子写：
 *   ① 先落一份「我可能崩在写盘中间」的标记版
 *   ② 再落正式版
 * 这样磁盘上永远不会是半份。
 *
 * ★ crashOnly = true 时只做第 ① 步——那是「我正要开始写，先留个记号」。
 *   如果进程在这之后、第 ② 步之前死了，重启时读到的就是带标记的那份，
 *   她会强制沉默一轮（宁可少说一句，不说错一句）。
 */
export function writeWake(storePath = defaultPath(), state = {}, { crashOnly = false } = {}) {
  const path = storePath || defaultPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const body = { ...emptyState(), ...state, version: SCHEMA_VERSION };
    delete body._loadedAt;
    // ① 崩溃标记版
    atomicWrite(path, JSON.stringify({ ...body, crashedMidWake: true }, null, 1));
    if (crashOnly) return true;
    // ② 正式版
    atomicWrite(path, JSON.stringify({ ...body, crashedMidWake: false }, null, 1));
    return true;
  } catch {
    // 写不进去 → 调用方会当这次没说（记不住就别开口）
    return false;
  }
}

/** 清理临时文件（插件启动时顺手做，免得越积越多）。 */
export function sweepTemps(storePath = defaultPath()) {
  const path = storePath || defaultPath();
  const dir = dirname(path);
  if (!existsSync(dir)) return 0;
  let n = 0;
  try {
    for (const f of readdirSync(dir)) {
      if (f.startsWith('wake.json.tmp-')) {
        try { unlinkSync(join(dir, f)); n += 1; } catch { /* 删不掉就算了 */ }
      }
    }
  } catch { /* 目录读不了就算了 */ }
  return n;
}
