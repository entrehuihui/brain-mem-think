/**
 * persist.mjs —— 判断库落盘。
 *
 * ======================= 它为什么必须存在 =======================
 *
 * 2026-10-27，小乔装完这个插件之后查出一件事，当场把我钉住了：
 *
 *   > 「`src/*.mjs` 零文件 IO，`Store` 就是个 `this.list = []`。
 *   >  归档一百段会话，宿主一重启，她又变回空白。」
 *
 * 她是对的。**一个会忘、但一重启就全忘的记忆体，不叫记忆。**
 * 「她慢慢长成一个人」这件事，前提是她跨过重启还认得你。
 *
 * ============================ 放在这一层，不放内核 ============================
 *
 * 内核（mind.mjs）必须保持纯净：不 import node:fs，不认识文件，不知道自己在哪。
 * 所以这里只给一个**接口**，由调用方注入：
 *
 *   opts.io = { load(): {list, absorbed} | null, save({list, absorbed}): void }
 *
 *   · 不注入 → 纯内存（单测、假模型、沙盘都这样跑，零副作用）
 *   · 注入文件适配器 → 跨重启活着
 *
 * 这也正好接住项目开头定的那条纪律：**内核一行不动，只换适配器。**
 *
 * ============================== 写入用原子写 ==============================
 *
 * 先写 `.tmp` → fsync → rename。这样磁盘上任何时刻要么是上一次成功的完整状态，
 * 要么根本还是旧的；**不会是半份**。半份的记忆比没有更糟：读的时候解析失败，
 * 一慌就把整库当空的，她就又白了。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const PERSIST_VERSION = 1;

/** 一条 Belief 里**该存**的字段。turns 只留最近若干条，防止文件越长越大。 */
const KEEP = [
  'id', 'themeKey', 'themeSource', 'kind', 'stage', 'subject', 'relation', 'polarity',
  'text', 'why', 'weight', 'imprint', 'status', 'createdAt', 'updatedAt', 'reasons',
  'tension', 'overturnedBy', 'overturnedReason', 'retireKind', 'forgottenBecause',
  'was', 'nowNote', 'curiosityFired', 'lastFired', 'fuseCount', 'touches',
  'asked', 'settledFrom', 'settledTrace', 'critical', 'pinned', 'preserve',
];

const MAX_TURNS = 40;

/** Belief → 纯 JSON。**不含任何原文材料**，只有她自己想出来的东西。 */
export function beliefToJson(b) {
  const out = {};
  for (const k of KEEP) {
    const v = b?.[k];
    if (v === undefined) continue;
    out[k] = v;
  }
  out.turns = Array.isArray(b?.turns) ? b.turns.slice(-MAX_TURNS) : [];
  return out;
}

/** 存一个「有没有变」的指纹：用来避免每次 tick 都写盘。 */
export function fingerPrint(store) {
  const h = createHash('sha1');
  for (const b of store?.list ?? []) {
    h.update(`${b.id}|${b.status}|${b.text}|${b.weight}|${b.updatedAt}|${b.curiosityFired}|${b.fuseCount}\n`);
  }
  h.update(JSON.stringify(store?.absorbed ?? {}));
  return h.digest('hex').slice(0, 16);
}

/**
 * 造一个文件适配器。
 * @param {string} path 判断库文件路径（建议 …/plugins/mind/.mind/judgments.json）
 */
export function createFileIo(path) {
  const p = String(path);
  let lastFp = null;

  return {
    path: p,

    /**
     * 读回上次存下的判断。
     * @returns {{list: object[], absorbed: object} | null} 文件不存在或坏了都返回 null（当新装）
     */
    load() {
      if (!existsSync(p)) return null;
      let raw;
      try { raw = readFileSync(p, 'utf8'); } catch { return null; }
      let obj;
      try { obj = JSON.parse(raw); } catch {
        // 坏文件不删——改名留证据，然后当新装。
        try { renameSync(p, `${p}.bad-${Date.now()}`); } catch { /* 改不了就算了 */ }
        return null;
      }
      if (!obj || obj.version !== PERSIST_VERSION || !Array.isArray(obj.list)) return null;
      lastFp = obj.fp ?? null;
      return { list: obj.list, absorbed: obj.absorbed ?? {} };
    },

    /**
     * 存。跟上次一样就不写（省 IO，也省得把 mtime 刷成「她一直在变」）。
     * @returns {boolean} 真的写了没有
     */
    save(store) {
      const fp = fingerPrint(store);
      if (fp === lastFp) return false;
      try {
        mkdirSync(dirname(p), { recursive: true });
        const body = {
          version: PERSIST_VERSION,
          savedAt: Date.now(),
          fp,
          count: (store?.list ?? []).length,
          list: (store?.list ?? []).map(beliefToJson),
          absorbed: store?.absorbed ?? {},
        };
        const text = JSON.stringify(body, null, 1);
        const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
        const fd = openSync(tmp, 'w');
        try { writeFileSync(fd, text, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(tmp, p);
        lastFp = fp;
        return true;
      } catch {
        // 写不进去不该让这一轮崩：记忆丢了是遗憾，把对话搞崩是事故。
        return false;
      }
    },
  };
}

/** 默认路径（插件根/.mind/judgments.json）。 */
export function defaultJudgmentPath(pluginRoot) {
  return join(pluginRoot, '.mind', 'judgments.json');
}
