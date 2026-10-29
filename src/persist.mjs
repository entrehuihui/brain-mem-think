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
  'text', 'why', 'weight', 'strength', 'imprint', 'status', 'createdAt', 'updatedAt', 'reasons',
  'tension', 'overturnedBy', 'overturnedReason', 'retireKind', 'forgottenBecause',
  'was', 'nowNote', 'curiosityFired', 'lastFired', 'fuseCount', 'touches',
  'asked', 'settledFrom', 'settledTrace', 'critical', 'pinned', 'preserve',
  // ★ 2026-10-28（生产实测抓到）：origin 漏了。
  //   她第一次自己收进来的那条判断（adoptClaim 设的 origin='induction'），
  //   落盘后这个字段就丢了 —— 重启之后没人分得清「这条是她自己数出来的」
  //   还是「模型熔给她的」。这正是这个项目最该记住的差别之一。
  'origin',
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

/**
 * 存一个「有没有变」的指纹：用来避免每次 tick 都写盘。
 *
 * ★ 2026-10-28 修（P0-6 · 只盯着七个字段的指纹）。
 *
 *   原来这里手挑了 7 个字段（id/status/text/weight/updatedAt/curiosityFired/fuseCount）
 *   去算哈希，而 `beliefToJson` 实际落盘 30+ 个字段。实测（2026-10-28）：
 *   只改下面任何一项，指纹**一个字都不变** → `save()` 直接跳过 → 这次修改永远不落盘：
 *
 *     lastFired · why · turns · tension · settledFrom · asked
 *
 *   现在没暴雷，是因为 `seed` 每轮 +1、`updatedAt` 每轮刷新，把漏洞盖住了。
 *   那是运气，不是设计——下次加字段一定踩。
 *
 *   改法：指纹就是对**真正要落盘的那份内容**取哈希。要存什么就哈希什么，
 *   两边永远对齐，加字段不用再回来改这里。
 *   （代价：每次 ingest 全量序列化一遍。条目数几百，可以接受。）
 */
export function fingerPrint(store) {
  const h = createHash('sha1');
  h.update(`seed:${Number(store?.seed ?? 0)}\n`);
  for (const b of store?.list ?? []) {
    h.update(JSON.stringify(beliefToJson(b)));
    h.update('\n');
  }
  h.update(JSON.stringify(store?.absorbed ?? {}));
  // ★ 2026-10-28（阶段 C）：观测流也要进指纹。
  //   不然「只有新观测、没有新判断」的那种变化永远不落盘，归纳就少数据。
  for (const e of store?.events ?? []) h.update(`${e.seq}|${e.at}|${e.actor}|${e.action}|${e.polarity}\n`);
  // ★ 2026-10-28（经历层）：经历也进指纹。
  //   踩过的坑就在上一行写着——「只改新加的字段，指纹不变，save 直接跳过」。
  //   经历往往一天只涨一条、判断一条没变，漏了它就成了「明明写了，重启就没了」。
  for (const e of store?.episodes ?? []) h.update(`${e.id}|${e.at}|${e.what}|${e.arousal}\n`);
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
      return {
        list: obj.list,
        absorbed: obj.absorbed ?? {},
        seed: Number(obj.seed ?? 0),
        // ★ 2026-10-28（阶段 C）：观测流
        events: Array.isArray(obj.events) ? obj.events : [],
        // ★ 2026-10-28（经历层）：经历和判断同一次原子写，一起回。
        episodes: Array.isArray(obj.episodes) ? obj.episodes : [],
      };
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
          // ★ seed 必须一起存。重启后 seed 从 0 开始，而 lastFired 还是旧值，
          //   curiosity 那句 `seed - lastFired <= cooldownBeats` 会恒成立 →
          //   **她再也不会追问同一个悬案**，而且一声不响。
          seed: Number(store?.seed ?? 0),
          count: (store?.list ?? []).length,
          list: (store?.list ?? []).map(beliefToJson),
          absorbed: store?.absorbed ?? {},
          // ★ 2026-10-28（阶段 C）：内核数判断要靠这条流，丢了就归零。
          events: (store?.events ?? []).map((e) => ({
            seq: e.seq, at: e.at, actor: e.actor, action: e.action, polarity: e.polarity,
            text: e.text, themeKey: e.themeKey, source: e.source, weight: e.weight, beliefId: e.beliefId,
          })),
          // ★ 2026-10-28（经历层）：经历原样存，只存她自己的话。
          //   KEEP 那套字段白名单是给 Belief 的；经历结构不同，单独写。
          episodes: (store?.episodes ?? []).map((e) => ({
            id: e.id, at: e.at, who: e.who, what: e.what, feel: e.feel,
            arousal: e.arousal, themeKey: e.themeKey, source: e.source, counts: e.counts,
          })),
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
