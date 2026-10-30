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
 * ★ 2026-10-27 第二修（小乔实测，这条很重要）：
 *
 *   第一版用的是**拒绝表**，只列了 agent-instructions / system-prompt / tool / cluster …
 *   她把宿主的实际取值 dump 出来，当场打脸：
 *
 *     探针会话里主人真话只有 1 条 / 25 字，材料却有 12291 字 ——
 *       user(25) + agent-instructions(1642) + **runtime-context(1044)**
 *       + **skill-catalog(10960)** + **time-context(262)**
 *
 *   `runtime-context` / `skill-catalog` / `time-context` 三个全漏了。
 *   owners 报 4 条、真话只有 1 条 —— **水位线虚高 2.5 倍**；
 *   她那边两次归档熔出 0 条判断，八成就是被这堆垃圾稀释掉的。
 *
 *   教训：**拒绝表天生会漏**。宿主以后加一种新 kind，我们就再漏一次。
 *   所以改成**白名单**：source.kind 只认这几个，其余一律不算主人说的。
 *   宁可漏记，不许灌垃圾 —— 这是 collect.mjs 开头就写着的那句话。
 */
const OWNER_SOURCE_KINDS = new Set(['user', 'human', 'owner']);

/** 她自己说的话可能的角色写法（白名单，认不出一律不收）。 */
const HER_ROLES = new Set(['assistant', 'agent', 'bot', 'model']);

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
  // ③ 先查来源。**白名单**：source.kind 只认 user / human / owner。
  //    没有 source.kind 的老消息放行（拿不到来源时按 role 判）。
  //    拒绝表会漏——宿主加一种新 kind 我们就再漏一次，这次不赌了。
  const srcKind = String(msg?.source?.kind ?? '').toLowerCase();
  if (srcKind && !OWNER_SOURCE_KINDS.has(srcKind)) {
    return { ok: false, text: '', why: `source_not_owner:${srcKind}` };
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

/**
 * ★ 2026-10-29 主人亲口改的口径：「我说的话 —— 这个也要进」。
 *
 *   原来的铁律是「只收主人说的」，理由是防她给自己造证据（她说一句 → 落进历史
 *   → 下次归档当成「发生过的事」熔进去 → 越说越确信）。
 *   那条顾虑是真的，但代价也真的发生了：一段来回里「她怎么应的、后来怎么变的」
 *   全在她那一半，只喂主人的话，熔出来的判断永远缺半边事。
 *
 *   折中做法——**她的话进材料，但打上标记、降权、并且明令不许单独当证据**：
 *     · 主人说的话：原样进去，是证据
 *     · 她说的话：缩到 HER_TURN_MAX 字、附在它要回应的那次主人发言下面，
 *       前缀 `〔她〕`，提示词里明写「只能解释上下文，不能作为判断的根据」
 *
 *   这样「说过什么、应了什么」的脉络留住了，
 *   而「她在给自己造证据」这条缝隙用提示词 + 截断堵上。
 *
 * @returns {Array<{text:string, role:'user'|'model'}>}
 */
export const HER_TURN_MAX = 120;

export function conversationTurns(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    // 主人说的：走原来的白名单，一个字都不改。
    const c = checkMessage(m);
    if (c.ok) {
      out.push({ text: c.text, role: 'user' });
      continue;
    }
    // 她说的话：只认「明确是她/是模型」的，其余（工具结果、系统注入）照旧不收。
    const role = roleOf(m);
    const srcKind = String(m?.source?.kind ?? '').toLowerCase();
    const hers = HER_ROLES.has(role)
      || HER_ROLES.has(srcKind)
      || srcKind === 'mind-wake';
    if (!hers) continue;
    // 工具调用、系统注入混在 her 里的，再滤一道。
    if (srcKind && NEVER.has(srcKind)) continue;
    const text = textOf(m).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({ text: text.slice(0, HER_TURN_MAX), role: 'model' });
  }
  return out;
}

export { OWNER_ROLES, NEVER };
