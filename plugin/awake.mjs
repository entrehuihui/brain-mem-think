/**
 * awake.mjs —— 她「醒一下、想一想、决定说不说」。
 *
 * ======================= 它为什么和 wake.mjs 分开 =======================
 *
 * `src/wake.mjs` 是**纯判断**：给它一个判断库，它说「该说 / 该闭嘴」。
 * 这一层是**跟宿主打交道的那一半**：读账本、算间隔、把结果落盘。
 *
 * 分开的好处：判断那部分可以单测、可以模拟一千次；
 * 这一层薄到只有几行，出问题一眼看得见。
 *
 * ============================ 一条铁律 ============================
 *
 * **醒 ≠ 说。**
 *
 * 到点了她就该醒一次——醒着才有机会判断「现在有没有话说」。
 * 但醒来之后的默认答案是**不说**。
 *
 * 一个每十分钟就开口一次的东西，不是在想事，是在吵。
 */

import { wake as decideWake, nextGapMs as computeGap } from '../src/wake.mjs';
import { readWake, writeWake } from './wake-store.mjs';

/**
 * 醒来一次，给一个决定。**不发送**——发送是 wake-exit 的事。
 *
 * @param {object} p
 * @param {object} p.mind       内核（要有 notes() / snapshot()）
 * @param {object} p.state      账本
 * @param {number} p.now
 * @param {object} p.cfg
 * @returns {Promise<{action:'speak'|'silent', say?:string, because:string}>}
 */
export async function planWake({ mind, state, now = Date.now(), cfg = {} }) {
  const st = state ?? readWake();

  // ① 崩溃标记：上一轮可能崩在写盘中途 → 这一轮强制沉默。
  //    宁可少说一句，不说错一句。
  if (st.degraded === 'crashed-mid-wake') {
    return { action: 'silent', because: '上一轮没写完，这轮先不出声' };
  }

  // ② 还没到该醒的时候：不算「醒了」，也不记账。
  const notes = typeof mind?.notes === 'function' ? mind.notes() : [];
  const gap = Number(computeGap?.(notes) ?? cfg.wakeTickMs ?? 600_000);
  if (st.lastWakeAt && (now - st.lastWakeAt) < gap) {
    return { action: 'silent', because: '还不到时候' };
  }

  // ③ 让她自己掂量。
  const verdict = decideWake(notes, {
    lastSpokeAt: st.lastSpokeAt ?? null,
    now,
    history: Array.isArray(st.window) ? st.window : [],
    said: Array.isArray(st.spokenHashes) ? st.spokenHashes : [],
  });

  return {
    action: verdict?.action === 'speak' ? 'speak' : 'silent',
    say: verdict?.say ?? '',
    because: String(verdict?.because ?? ''),
  };
}

/** 把这次决定落盘。**只记事实，不记她的原话。** */
export function applyWake(storePath, { action, why, sent, now = Date.now() } = {}) {
  const st = readWake(storePath);
  const window = [...(Array.isArray(st.window) ? st.window : []),
    { at: now, action: action ?? 'silent', why: String(why ?? '').slice(0, 60), sent: !!sent }].slice(-20);
  writeWake(storePath, {
    ...st,
    lastWakeAt: now,
    // 只有真说出去了才推 lastSpokeAt。说了没说成（busy / repeat / flush 失败）不算。
    lastSpokeAt: sent ? now : (st.lastSpokeAt ?? 0),
    window,
  });
  return true;
}
