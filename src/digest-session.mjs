/**
 * digest-session.mjs —— 归档时的那一次熔。
 *
 * 它为什么在这儿：
 * 以前是「每条消息进来就试熔」，一条一句，熔不出东西，还吵。
 * 一段会话是一个完整的经历单元——人在回忆时也不是逐句回忆，是「那段时间发生了什么」。
 * 所以这里只做一件事：把一整段会话**一次**交给模型，让它看出这段时间里她学到了什么。
 *
 * 三条硬规矩：
 *   1. 批量，不逐条。消息拼成一整段材料送一次；模型宁可吐 NULL，也不许硬造。
 *   2. 这段会话没什么可熔的 → 返回空。返回空是正确答案，不是失败。
 *   3. committed 标记防重复熔：同一个会话熔过一次就不再熔。
 *
 * 原文不进库：消息只在这一次拼成材料，交出去、用完即弃；落库的只有模型熔出来的判断。
 */

import { Belief, PREDICATES, STATUS, clean, normalizeRelation, recordTurn, similarity, transition } from './judge.mjs';
import { canonicalRelation, longestSharedRun, COPY_RUN_LIMIT, looksClinical } from './forge.mjs';

export const DIGEST_DEFAULTS = Object.freeze({
  maxCharsPerMessage: 600,
  maxMessages: 200,
  minMaterialChars: 24,
  maxVerdicts: 4,
});

/** 把一段会话拼成材料。只用一次，不存。 */
/**
 * 只收主人说的话。这是**白名单**，不是黑名单：
 * 认不出是谁说的，一律不收——宁可少收，也不许把她说的话当材料再喂回去。
 *
 * 为什么要装在这儿：闸要装在必经之路上。挂在调用方，就总有一条旁路绕过去。
 * 为什么只收 user：她的经历里，「发生了什么」是主人那边给的；
 * 她说的话已经变成判断了，再拿她自己的话当材料，等于让她自己回声自己。
 */
export const MATERIAL_ROLES = Object.freeze(['user']);

export function isOwnersMessage(m) {
  if (m == null) return false;
  if (typeof m === 'string') return true; // 裸字符串没有 role，按「就是经历」处理
  const role = String(m.role ?? m.kind ?? '').toLowerCase();
  return MATERIAL_ROLES.includes(role);
}

export function buildSessionMaterial(messages, opts = {}) {
  const o = { ...DIGEST_DEFAULTS, ...opts };
  const list = (messages ?? [])
    .filter(isOwnersMessage)
    .map((m) => String(typeof m === 'string' ? m : (m?.text ?? m?.content ?? '')).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-o.maxMessages);
  if (!list.length) return '';
  return list.map((t) => t.slice(0, o.maxCharsPerMessage)).join('\n');
}

/** 模型该看到的提问：不是「总结这段会话」，是「这段时间你看出了什么」。 */
export function buildDigestPrompt(material, prior = []) {
  const known = prior.length
    ? ['你已经这么以为过：', ...prior.map((p) => `- ${p.text}`), ''].join('\n')
    : '';
  return [
    '下面是刚过去的一段时间，你说过的和经历过的都在里面。',
    '',
    known,
    material,
    '',
    '不要把这段时间复述一遍。说出你从中看出来的那句话——',
    '可能是一件事，可能是一个人的样子，也可能是你自己该改的做法。',
    '',
    '要求：',
    '1. 一句话一条，最多四条；每条都要带一句为什么。',
    '2. 只准用材料里真实发生的事，不许补情节、人物、时间。',
    '3. 如果这段时间没有什么让你变得不一样的，就输出 {"judgments":[]}。',
    '4. 如果你从这段时间里看出**自己是个什么样的人**（不是别人怎么样，是你自己），',
    '   把这条的 kind 写成 identity；其余保持不填或写 episodic。',
    '5. stage：这条说到哪一层了，只能填这四个之一——',
    '     pending    悬置    「我还下不了结论」「次数太少」「看着像巧合」',
    '     understood 看明白  「我算看明白了」「大概是……」「不是……是……」',
    '     settled    定下来  「就这么定下来」「不问到他点头我不动手」',
    '     acting     行动    「我改成按他的节奏来」「我先不动手」',
    '   拿不准就不填——不要猜。',
    '',
    '必须交出：relation（谓词，从这个表里挑：' + Object.keys(PREDICATES).join(' ') + '）、',
    'subject（关于谁，一个词）、polarity（favorable 或 unfavorable）、weight（0~1）。',
    '',
    '只输出 JSON：',
    '{"judgments":[{"text":"那句话","why":"为什么","relation":"stalls","subject":"他","polarity":"unfavorable","weight":0.6}],',
    ' "theme":"这一整段说的是哪一摊事（可空）"}',
    '或者 {"judgments":[]}。',
  ].join('\n');
}

/** 抠 JSON。包了代码块、加了前言都不该让整段会话白熔。 */
export function parseDigest(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw ?? '').trim();
  if (!text || text.toUpperCase() === 'NULL') return null;
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    return JSON.parse(text.slice(s, e + 1));
  } catch {
    return null;
  }
}

function normalizeOne(raw, material, opts) {
  if (!raw || typeof raw !== 'object') return null;
  const text = clean(raw.text ?? raw.note ?? raw.fused ?? '', 120);
  if (!text || [...text].length < 6) return null;
  if (opts.clinical !== false && looksClinical(text)) return null;
  // 抄原文不算判断
  if (longestSharedRun(text, [material]) >= COPY_RUN_LIMIT) return null;
  const rel = canonicalRelation(raw.relation) ?? canonicalRelation(String(raw.theme ?? '').split('|')[0] ?? '');
  const st = normalizeRelation(rel, raw.polarity);
  if (!st.ok) return null;
  const subject = clean(raw.subject ?? '他', 8).replace(/[「」『』"'“”，。！？；：、\s]/g, '') || '他';
  const weight = Math.max(0, Math.min(1, Number(raw.weight ?? 0.5)));
  return {
    text,
    why: clean(raw.why ?? '', 120) || '说不上来，就是觉得',
    relation: st.relation,
    polarity: st.polarity,
    subject,
    weight,
    // 她自己认出「我是这样的人」时标 identity；其余绝大多数是 episodic。
    kind: String(raw.kind ?? '').toLowerCase() === 'identity' ? 'identity' : 'episodic',
    // 这一句说到哪一层：只认模型自报的四个值，别的一律当「不知道」。
    stage: ['pending', 'understood', 'settled', 'acting'].includes(String(raw.stage ?? '').toLowerCase())
      ? String(raw.stage).toLowerCase()
      : null,
  };
}

/**
 * 一段会话进来，判断出去。
 *
 * @param {Array<string|{text?:string,content?:string}>|string} messages 整段会话的消息
 * @param {{synth:object, prior?:Array, now?:number, opts?:object}} ctx
 * @returns {Promise<{committed:boolean, judgments:Array, reason:string, materialChars:number}>}
 *   committed=true 表示这一次真的熔过了（无论熔出几条），调用方据此防重复。
 */
export async function digestSession(messages, ctx = {}) {
  const opts = { ...DIGEST_DEFAULTS, ...(ctx.opts ?? {}) };
  const synth = ctx.synth;
  if (!synth || typeof synth.synthesize !== 'function') {
    throw new TypeError('digestSession: 需要注入 synth = { synthesize(material) }');
  }
  const material = buildSessionMaterial(messages, opts);
  if (material.length < opts.minMaterialChars) {
    return { committed: true, judgments: [], reason: 'too_little', materialChars: material.length };
  }

  const prompt = buildDigestPrompt(material, (ctx.prior ?? []).slice(0, 6));
  let raw = null;
  try {
    raw = parseDigest(await synth.synthesize(prompt));
  } catch {
    raw = null;
  }
  if (!raw || !Array.isArray(raw.judgments)) {
    // 模型说不出来 —— 这段会话就是没什么可熔的。答案是空，不是硬造。
    return { committed: true, judgments: [], reason: 'nothing_to_digest', materialChars: material.length };
  }

  const out = [];
  for (const j of raw.judgments.slice(0, opts.maxVerdicts)) {
    const one = normalizeOne(j, material, opts);
    if (!one) continue;
    // 同一次熔出来的重复（换了说法也一样）不重复收
    if (out.some((x) => similarity(x.text, one.text) >= 0.86)) continue;
    out.push({ ...one, themeHint: clean(raw.theme ?? '', 40) || null });
  }
  return {
    committed: true,
    judgments: out,
    reason: out.length ? 'digested' : 'nothing_usable',
    materialChars: material.length,
  };
}

/**
 * 一段会话熔完之后，把结果并进记忆库。
 * 直接落判断，不再经过火炉——这一段已经是「想完了的结论」，不该被二次重熔。
 * 落库用的仍是 judge.Belief，生命周期和别的判断一模一样。
 */
export async function commitDigest(mind, result, { at } = {}) {
  if (!result || !result.committed || !result.judgments?.length) {
    return { stored: 0, updated: 0, retired: [], committed: !!result?.committed, ids: [] };
  }
  const ids = [];
  const retired = [];
  let updated = 0;
  const now = Number.isFinite(at) ? at : mind.now();

  for (const j of result.judgments) {
    const themeKey = `${j.relation}|${j.subject}`;
    // 同一摊事按「说的对象」找：谓词可能因为改主意而变，但对象不会。
    const current = mind.store.all.find((b) => b.subject === j.subject && b.alive) ?? mind.store.active(themeKey);

    if (current) {
      // 这一摊事已经有现役判断：走「会想多」——和逐条 ingest 用的是同一套。
      // 先走「会改自己」：这次熔出来的结论有没有推翻旧的。
      // 交给 reconsider 时，主题键对齐到现役那条：同一个对象上的一致/相反，才是「同一件事」。
      const credible = { ...j, themeKey: current.themeKey, sources: result.sources ?? [] };
      const rev = mind.revision.reconsider(mind.store.all, credible, { now, sources: credible.sources });
      const flipped = rev.retired.includes(current.id);
      if (rev.retired.length) retired.push(...rev.retired);

      if (flipped) {
        // 旧结论已被降级：另起一条现役的接上，别让那个主题悬空。
        const b = new Belief({
          themeKey,
          subject: j.subject,
          relation: j.relation,
          polarity: j.polarity,
          text: j.text,
          why: j.why,
          weight: j.weight,
          kind: j.kind ?? 'episodic',
          stage: j.stage ?? null,
          at: now,
          via: 'digest',
        });
        transition(b, STATUS.HELD, { at: now });
        mind.store.add(b);
        current.nowNote = b.text;
        ids.push(b.id);
        updated += 1;
      } else {
        recordTurn(current, {
          ...j,
          themeKey,
          // 同谓词同立场：只是又攒了一条凭据，不必换掉原话
          text: j.relation === current.relation && j.polarity === current.polarity ? current.text : j.text,
        }, { at: now, via: 'digest' });
        // 谓词/立场真变了：主题键跟着换，免得同一个对象占着两个槽
        if (j.relation !== current.relation || j.polarity !== current.polarity) current.themeKey = themeKey;
        if (current.status === STATUS.PENDING) transition(current, STATUS.HELD, { at: now });
        ids.push(current.id);
        updated += 1;
      }
      continue;
    }

    // 全新的一摊事：直接落一条现役的（不经火炉，这一段已经是想完的结论）。
    const b = new Belief({
      themeKey,
      subject: j.subject,
      relation: j.relation,
      polarity: j.polarity,
      text: j.text,
      why: j.why,
      weight: j.weight,
      kind: j.kind ?? 'episodic',
      stage: j.stage ?? null,
      at: now,
      via: 'digest',
    });
    transition(b, STATUS.HELD, { at: now });
    mind.store.add(b);
    ids.push(b.id);
  }
  return { stored: ids.length, updated, retired, committed: true, ids };
}

export function createSessionDigester(synth, opts = {}) {
  const seen = new Set();
  return {
    /** 归档时调；同一个会话 id 只熔一次。 */
    async digest(sessionId, messages, extra = {}) {
      const key = String(sessionId ?? '');
      if (key && seen.has(key)) {
        return { committed: false, judgments: [], reason: 'already_digested', materialChars: 0 };
      }
      const r = await digestSession(messages, { synth, opts: { ...opts, ...(extra.opts ?? {}) }, ...extra });
      if (key && r.committed) seen.add(key);
      return r;
    },
    has(sessionId) {
      return seen.has(String(sessionId ?? ''));
    },
  };
}
