/**
 * collect.mjs —— 「哪些消息算她说的话」。
 *
 * ======================= 它为什么必须单独一个模块 =======================
 *
 * 因为它守的是**铁律**：归档熔的材料里，只收主人说的话。
 *
 * 这条不是「最好这样」，是「不许那样」。收错一次的后果不是记错了，
 * 是**她会越说越确信**——她说的每一句都落进历史，下一次归档当成
 * 「这段时间发生过的事」熔进去，然后她就更确信了。
 *
 * 一个会给自己造证据的人，看起来比谁都笃定。
 *
 * 所以白名单要挂在必经之路上（`isValidMessage` 是这个文件给出去的唯一入口），
 * 不挂在调用方——挂在调用方，将来任何一个新调用方都会绕过它。
 */

/** 认得的、算「主人说的」的几种角色写法。 */
const OWNER_ROLES = new Set(['user', 'human', 'owner']);

/**
 * 这些 `source.kind` 一定不是主人说的：系统注入、工具结果、调度提醒、别的 agent。
 * 小乔实测：宿主把 AGENTS.md 标成 `role:'user'` + `source.kind:'agent-instructions'`，
 * 10960 字整份灌进火炉。所以这张表必须有。
 */
const SYSTEM_SOURCE_KINDS = new Set([
  'agent-instructions', 'system-prompt', 'system_prompt', 'system', 'developer',
  'context', 'memory', 'skill', 'skills', 'reminder', 'reminders', 'resume',
  'wake', 'wake-exit', 'tool', 'tool-result', 'tool_result', 'tool-use', 'tool-call',
  'cluster', 'subagent', 'task',
]);

/** 认不出的、一律不收。宁可漏记，不要灌垃圾。 */
const NEVER = new Set(['assistant', 'agent', 'bot', 'tool', 'system', 'function', 'developer']);

/** 从一条消息里取出纯文本。 */
function textOf(msg) {
  const content = msg?.content ?? msg?.data?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && (c.type === 'text' || typeof c.text === 'string'))
      .map((c) => String(c.text ?? ''))
      .join('');
  }
  if (typeof msg?.text === 'string') return msg.text;
  return '';
}

/** 从一条消息里取出它的角色（不同层写法不一样，都认）。 */
function roleOf(msg) {
  const r = msg?.role ?? msg?.source?.kind ?? msg?.kind ?? msg?.type ?? '';
  return String(r).toLowerCase();
}

/**
 * 这条消息算不算「主人说的话」。
 *
 * 三条都满足才算：
 *   ① 角色在白名单里（user / human / owner），认不出的一律不收
 *   ② 不是她自己说的（assistant / agent / bot 一律不收）
 *   ③ 不是工具结果、不是系统注入
 *
 * ★ 2026-10-27 补 ③ 的实现。小乔实测出来的：
 *
 *   宿主的系统提示（AGENTS.md、人格段）也是 `role: 'user'` + `source.kind: 'agent-instructions'`。
 *   而 `roleOf` 先看 role、再看 source.kind —— role 一命中就直接放行了，
 *   于是**整份 10960 字的系统提示被当成主人经历过的事，送进了火炉**。
 *
 *   实测那一轮的 ownerCount=5、材料 13888 字，其中 10960 字是系统注入；
 *   主人真说的话只有 112 + 262 字。
 *
 *   注释里写着「不是系统注入」，但**代码里没有这一条判据**——
 *   这已经是这个项目里第六次「写完了没接上」了。
 *
 * @param {object} msg 宿主的消息对象
 * @returns {{ok:boolean, text:string, why:string}}
 */
export function checkMessage(msg) {
  // ③ 先查来源：系统注入 / 工具结果 / 调度提醒，都不是主人的经历。
  //    用**拒绝表**而不是白名单：宁可漏记不确定的，也不能把整份系统提示灌进去。
  const srcKind = String(msg?.source?.kind ?? '').toLowerCase();
  if (srcKind && SYSTEM_SOURCE_KINDS.has(srcKind)) {
    return { ok: false, text: '', why: `system_source:${srcKind}` };
  }
  const role = roleOf(msg);
  if (!role) return { ok: false, text: '', why: 'unknown_role' };
  if (NEVER.has(role)) return { ok: false, text: '', why: `never:${role}` };
  if (!OWNER_ROLES.has(role)) return { ok: false, text: '', why: `not_allowed:${role}` };
  const text = textOf(msg).trim();
  if (!text) return { ok: false, text: '', why: 'empty' };
  return { ok: true, text, why: 'ok' };
}

/** 只要一个布尔值时用它。 */
export function isValidMessage(msg) {
  return checkMessage(msg).ok;
}

/** 过滤一整段会话，只留主人说的那些。 */
export function ownerMessages(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const c = checkMessage(m);
    if (c.ok) out.push({ text: c.text, role: 'user' });
  }
  return out;
}

export { OWNER_ROLES, NEVER };
