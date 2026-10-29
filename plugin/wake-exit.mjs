/**
 * wake-exit.mjs —— 「她要跟主人说话」唯一的一条出口。
 *
 * ======================= 它为什么是唯一的一条 =======================
 *
 * 旧插件出过一次「60 秒连发 6 条同样的话」。根因不是冷却写错了，
 * 是**有两条出口**：一条走去重、一条不走。走岔了的那条，谁也管不到。
 *
 * 所以这个项目从第一天就定死：**全插件 `followup(` 只许出现一次，就在这个函数里。**
 * 块一的验收会 grep 整个 plugin/ 目录，命中数不等于 1 就红。
 *
 * ============================ 顺序是契约 ============================
 *
 * 函数内部六步，顺序本身是契约（验收测的就是这个顺序）：
 *
 *   1. 状态闸   她正忙 → 这轮跳过，**不排队**
 *   2. 归档闸   主人那边归档了 → 不发（发过去也会被宿主的门拦下）
 *   3. 去重闸   这句她刚说过 → 不再说
 *   4. 发送     followup(message)          ← 全插件唯一一次
 *   5. 送达确认 await flush                 ← 不许省
 *   6. 记账     写盘                         ← 在 flush 之后
 *
 * 第 5 步为什么不能省：宿主自己投递定时任务时就是 followup 之后 flush 才算送达
 * （dsh-schedule/lib/index.js:1596-1597）。不 flush，我们不知道她到底说没说出口。
 *
 * 第 6 步为什么在 flush 之后：写盘失败 = 这次算没发出去，下一轮重试。
 * 反过来（先记账后发送）就会出现「账上说她说了，其实没说」——那种账是骗自己的。
 */

import { randomUUID } from 'node:crypto';
import { readWake, writeWake, hashMessage, normMessage } from './wake-store.mjs';

/** 去重窗口：同一句话多久之内不许再说。 */
const REPEAT_WINDOW_MS = 6 * 3600 * 1000;

/**
 * 让她对主人说一句话。
 *
 * @param {object} p
 * @param {object} p.agent            目标会话的 agent（宿主的 Agent 对象）
 * @param {string} p.sessionId        目标会话 id
 * @param {string} p.message          要说的话
 * @param {object} [p.ctx]            插件 ctx（拿 sessions 服务）
 * @param {number} [p.now]            时刻（测试可注入）
 * @param {object} [p.storePath]      wake.json 路径
 * @returns {Promise<{sent:boolean, why:string}>}
 */
export async function speakToOwner({ agent, sessionId, message, ctx = null, now = Date.now(), storePath } = {}) {
  // ── 1. 状态闸 ────────────────────────────────────────────────
  // 她正忙就别插嘴，而且**不排队**。
  // 排队等于「等她忙完一口气把攒的几句全说出来」——那是另一种连发。
  if (!agent) return { sent: false, why: 'no-agent' };
  if (agent.status && agent.status !== 'idle') return { sent: false, why: 'busy' };

  // ── 2. 归档闸 ────────────────────────────────────────────────
  // 主人那边已经归档了。发过去宿主会用 archived-session-gate 拦下，
  // 这一轮以 blocked 结束、不发请求——与其让它在那儿空转，不如这里就不发。
  try {
    const archived = ctx?.workspaceRegistry?.archivedSessionIds;
    if (Array.isArray(archived) && sessionId && archived.includes(sessionId)) {
      return { sent: false, why: 'archived' };
    }
  } catch { /* 拿不到归档列表就别挡，按「没归档」处理 */ }

  // ── 3. 去重闸 ────────────────────────────────────────────────
  //
  // ★ 2026-10-27 修（她的话发出去没有标点）：原来这里把 `normMessage()` 的结果
  //   既用来算 hash、又当成正文发出去了。而 normMessage 会**去掉所有空白和标点**
  //   （那是为了判「这句是不是又重了一遍」）。于是她说的
  //   「我醒了，这屋子是空的。」发出来变成「我醒了这屋子是空的」。
  //
  //   规范化只该用在判重上。**发出去的必须是原话。**
  const raw = String(message ?? '').trim();
  const text = normMessage(raw);
  if (!text) return { sent: false, why: 'empty' };
  const state = readWake(storePath);
  const hash = hashMessage(raw);
  const seen = Array.isArray(state.spokenHashes) ? state.spokenHashes : [];
  const hit = seen.find((s) => s && s.hash === hash && (now - Number(s.at ?? 0)) < REPEAT_WINDOW_MS);
  if (hit) return { sent: false, why: 'repeat' };

  // ── 4. 发送（全插件唯一一次 followup）────────────────────────
  //
  // ★ 2026-10-27 两次修，第二次才是要害：
  //
  //   ① 形状：原来传 `{ text: raw }`，宿主不认（它要 `content` 数组），
  //      那一轮报 `content is not iterable`。
  //   ② **身份**：改成 content 数组之后仍然坏，报的是
  //      `session event at seq 8 lacks an identified message`。
  //      查 dsh-session:1199 才明白 user/message 的 data **必须自带 id 和 role**：
  //
  //        if (typeof message["id"] !== "string" || message["id"] === "")
  //          throw `${subject} lacks an identified message`
  //        if (messageRecord["role"] !== "user")
  //          throw `${subject} message must have role "user"`
  //
  //      宿主自己写消息时会补这两个字段（正常消息是 content/source/role/id），
  //      **但 followup 投递的消息它原样落盘、不补**。
  //      少了 id，那条会话从此 replay 不过——她说一句话就把屋子写塌，已经两回。
  //
  //   现在四样给全：id（uuid）/ role / content / source。
  if (typeof agent.followup !== 'function') return { sent: false, why: 'no-followup' };

  // ── 4-5. 投递 + 送达确认（走唯一那个 followup）──────────────────
  const out = await deliver({
    agent,
    text: raw,
    source: { kind: 'mind-wake' },
    ctx,
  });
  if (!out.sent) return out;

  // ── 6. 记账（在 flush 之后）──────────────────────────────────
  const keep = seen.filter((s) => s && (now - Number(s.at ?? 0)) < REPEAT_WINDOW_MS);
  writeWake(storePath, {
    ...state,
    lastSpokeAt: now,
    spokenHashes: [...keep, { hash, at: now }].slice(-50),
    // ★ 2026-10-28 修（生产实测抓到的死结）：
    //
    //   这里原来还 push 了一条 `{ action:'speak' }` 进 window。可 tick 那边
    //   说完之后还会调一次 `applyWake({action:'speak'})`，也 push 一条。
    //   **一次说话 = window 里两条 speak**。
    //
    //   `maxSpeakInWindow` 是 2 —— 所以她**说完第一句，额度就用光了**，
    //   接下来一小时全被 `这一小时已经说了 2 次，再说就是吵` 挡住。
    //   实测就在 11:26:38 说了这辈子第一句，然后 11:32 / 11:38 两次全被闷回去。
    //
    //   记账只该有一处：applyWake 那边（它知道 sent 是真是假）。
    //   这里只负责「这句说过了，别重说」——那件事归 spokenHashes。
  });

  return { sent: true, why: 'ok' };
}

/**
 * 唯一一个 `followup` 调用点。
 *
 * ★ 2026-10-28（阶段 F）：`act` 通道加进来之后，这里差点变成两个出口。
 *   验收 X1 当场咬住了：「plugin/ 下 followup 调用命中 2 处（要求恰好 1）」。
 *   那条铁律是对的——**出口多一个，就有一条谁也管不到的路**。
 *
 *   所以不是把数字改成 2，而是把「投递」这件事抽出来：
 *   说话和做事各有各的闸、各有各的账，但**物理上只有一个 followup**。
 *   以后再加任何「叫她」的通道，也必须走这里。
 *
 * @param {object} p
 * @param {object} p.agent
 * @param {string} p.text
 * @param {object} p.source   写进事件的来源标记（mind-wake / mind-act）
 * @param {object} [p.ctx]    要 sessions.flush
 * @returns {Promise<{sent:boolean, why:string}>}
 */
async function deliver({ agent, text, source, ctx = null }) {
  if (!agent || typeof agent.followup !== 'function') return { sent: false, why: 'no-followup' };
  try {
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: String(text) }],
      source,
    });
  } catch (err) {
    return { sent: false, why: `throw:${err?.message ?? err}` };
  }

  let flushed = false;
  try {
    const sessions = ctx?.sessions;
    if (sessions && typeof sessions.flush === 'function') {
      flushed = (await sessions.flush(agent.session)) === true;
    }
  } catch {
    flushed = false;
  }
  if (!flushed) return { sent: false, why: 'flush-unavailable' };
  return { sent: true, why: 'ok' };
}

/**
 * 让她自己出去一趟（阶段 F · 主动性）。
 *
 * 跟 `speakToOwner` 的分工：
 *   · 说话：要去重（同一句不重说）、要记配额（一小时两次）
 *   · 做事：不去重（同一件事可以再去做）、不占说话配额，只占时间预算
 *
 * 闸只留三道，都在这里（预算/冷却在 src/budget.mjs，产物在 preference.applyOutcome）：
 *   1 她正忙 → 不塞第二件事进来
 *   2 主人刚说过话 → 不出门（**这条是底线：主动不能变成叫他不在**）
 *   3 会话已归档 → 投过去也会被宿主的门拦下
 *
 * @param {object} p
 * @param {object} p.agent
 * @param {string} p.sessionId
 * @param {object} p.urge
 * @param {string} p.line       src/motive.mjs 的 actLine(urge)
 * @param {object} [p.ctx]
 * @param {number} [p.now]
 * @param {number} [p.lastOwnerAt]
 * @param {number} [p.ownerQuietMs]
 * @returns {Promise<{sent:boolean, why:string}>}
 */
export async function actByHerself({
  agent, sessionId, urge, line, ctx = null, now = Date.now(),
  lastOwnerAt = null, ownerQuietMs = 10 * 60 * 1000,
} = {}) {
  if (!agent) return { sent: false, why: 'no-agent' };
  if (agent.status && agent.status !== 'idle') return { sent: false, why: 'busy' };
  if (Number.isFinite(lastOwnerAt) && lastOwnerAt && now - lastOwnerAt < ownerQuietMs) {
    return { sent: false, why: 'owner_near' };
  }
  try {
    const archived = ctx?.workspaceRegistry?.archivedSessionIds;
    if (Array.isArray(archived) && sessionId && archived.includes(sessionId)) {
      return { sent: false, why: 'archived' };
    }
  } catch { /* 拿不到归档列表就别挡 */ }

  const text = String(line ?? '').trim();
  if (!text) return { sent: false, why: 'empty' };

  return await deliver({
    agent,
    text,
    // ★ source.kind = 'mind-act'：collect.mjs 的白名单只认 user/human/owner，
    //   所以这一条**进不了记忆**——她不会给自己造证据。
    source: { kind: 'mind-act', urge: urge?.kind ?? null, activity: urge?.activity ?? null },
    ctx,
  });
}

