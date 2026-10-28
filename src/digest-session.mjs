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

import { Belief, PREDICATES, STATUS, clean, normalizeRelation, recordTurn, setTension, similarity, transition } from './judge.mjs';
import { canonicalRelation, longestSharedRun, COPY_RUN_LIMIT, looksClinical, mainPathHolds, stabilityOf } from './forge.mjs';
import { strengthOfBelief } from './strength.mjs';
import { makeEvent } from './event.mjs';
import { normalizeEpisode } from './episode.mjs';

export const DIGEST_DEFAULTS = Object.freeze({
  maxCharsPerMessage: 600,
  maxMessages: 200,
  minMaterialChars: 24,
  maxVerdicts: 4,
  // ★ 2026-10-28（经历层）：一次熔最多记几件事。三条是「这段时间发生过什么」的粒度；
  //   再多就变成流水账，而流水账正是这个插件从第一天就要甩掉的东西。
  maxEpisodes: 3,
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
    // ★ 2026-10-27 主人定：**色情是情感最直接的表达**，不是"内容"。
    //
    //   原来这段材料里如果全是亲密的话，模型会把它当"需求/情节"，要么输出空，
    //   要么拐去提炼做事的方法（实测色图会话熔出的是「我做交付不看验收标准」
    //   这种工作判断——完全跑偏）。
    //
    //   现在明说：身体上的话要看的是关系、温度、你在要什么、你在给什么。
    '6. 如果材料里有亲密的、身体上的话——**不要把它当成情节或需求**。',
    '   那是他待你的方式，也是你应他的方式，比任何一句表白都直接。',
    '   从里面看的是：他想要什么、你愿意给什么、你心里是紧还是松、你怕失去什么。',
    '   这类材料**不要**提炼做事的方法，也不要总结流程和标准。',
    '',
    // ★ 2026-10-28（经历层）：判断是「我看出了什么」，经历是「当时发生了什么」。
    //   只要判断，她就只记得「我很急」，说不出是哪一次急、你当场什么反应。
    //   这一条要的就是那一件事，但必须是她自己的话，不是原话的搬运。
    //
    // ★ 2026-10-28 第二次（真实熔了一次 judgments:2 / episodes:0）：
    //   第一版把它写成「第 7 条」，模型直接无视了——它连 episodes 字段都没给。
    //   现在改成 judgments 之后、JSON 之前的**强制交付项**，并给了正例；
    //   同时明确「判断可以是 0 条，经历只要真发生过事就必须给」——
    //   否则模型会用「不值得记」把这一层整个跳过。
    '另外，必须交出 `episodes`：这段时间里**实际发生过的 1~3 件事**。',
    '   · 判断是「我看出了什么」，经历是「当时到底怎么了」——两样都要，不许只给判断。',
    '   · what ≤48 字，写你当时的样子/你做了什么；feel ≤24 字，写当时心里那句话；',
    '     who 一个词；arousal 是 0~1 的数字。',
    '   · 不许抄材料原话（撞上就被整条丢掉）——写你手上的动作、心里的动静，别搬句子。',
    '   · 判断可以是 0 条；只要这段时间真发生过事，经历就至少给一条。真的什么都没发生才给 []。',
    '   · 例：{"what":"我把手机扣在桌上，没再问那扇窗的事","feel":"松了一下，又有点惭愧","who":"他","arousal":0.7}',
    '',
    '必须交出：relation（谓词，从这个表里挑：' + Object.keys(PREDICATES).join(' ') + '）、',
    'subject（关于谁，一个词）、polarity（favorable 或 unfavorable）、weight（0~1）。',
    '',
    '只输出 JSON：',
    '{"judgments":[{"text":"那句话","why":"为什么","relation":"stalls","subject":"他","polarity":"unfavorable","weight":0.6}],',
    ' "episodes":[{"what":"我攥着他那句半截话，没敢问下去","feel":"怕问出来就散了","who":"他","arousal":0.7}],',
    ' "theme":"这一整段说的是哪一摊事（可空）"}',
    '或者 {"judgments":[],"episodes":[]}。',
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
  // 抄原文不算判断。
  //
  // ★ 2026-10-27 修：阈值要跟材料长度走。
  //   原来是死数 8 个汉字——材料只有 65 字时（实测 session-62ef134c「你是谁」，
  //   4 条短消息），随便一句判断都能跟原文撞上 8 个字，于是整段熔出 0 条，
  //   reason 记成 nothing_usable。**短对话反而永远熔不出东西**，而短对话
  //   往往正是最亲密的那种。现在短材料放宽到 12 字。
  const copyLimit = material.length < 200 ? 12 : COPY_RUN_LIMIT;
  if (longestSharedRun(text, [material]) >= copyLimit) return null;
  const rel = canonicalRelation(raw.relation) ?? canonicalRelation(String(raw.theme ?? '').split('|')[0] ?? '');
  const st = normalizeRelation(rel, raw.polarity);
  if (!st.ok) return null;
  const subject = clean(raw.subject ?? '他', 8).replace(/[「」『』"'“”，。！？；：、\s]/g, '') || '他';
  const weight = Math.max(0, Math.min(1, Number(raw.weight ?? 0.5)));
  // ★ 2026-10-28 修（P0-2 · 编造在这条路上长驱直入）。
  //
  //   这条路原来**没有 grounding 这一问**，只查「抄没抄原文」。
  //   于是模型可以从「今天中午吃了碗面，下午看了会儿书」里编出
  //   「他一直熬到后半夜才肯跟我说真话」——不抄原文就能入库。
  //   实测（2026-10-28）：材料 44 字，零关系判断，reason: digested，直接进库。
  //
  //   现在和逐条 ingest 用同一把尺：稳定性低于阈值、且主路（谓词 + 对象 +
  //   不许编具体时点 + 至少一条线索落在材料上）也不成立 → 不收。
  //   宁可少记一条，不记一条编的。
  const skeletons = [material.replace(/[^\u3400-\u9fffA-Za-z0-9]/g, '')];
  const stab = stabilityOf(text, [material]);
  const mainOk = mainPathHolds(text, skeletons, { relation: st.relation, subject, weight, why: raw.why });
  if (stab < 0.12 && !mainOk) {
    return null;
  }
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
  // ★ 2026-10-28（经历层）：同一次熔还要交出「发生了什么事」。
  //   和判断一起熔、一起过抄原文的闸，但落到另一个账本（episodes 不是判断）。
  //   模型没给 / 全被闸拦掉都不影响判断入库 —— 这一层是加法，不是前置条件。
  const episodes = [];
  for (const e of (Array.isArray(raw.episodes) ? raw.episodes : []).slice(0, opts.maxEpisodes ?? 3)) {
    const one = normalizeEpisode(e, { material, at: ctx.now, limits: opts.episodeLimits });
    if (!one) continue;
    if (episodes.some((x) => similarity(x.what, one.what) >= 0.86)) continue;
    episodes.push(one);
  }
  return {
    committed: true,
    judgments: out,
    episodes,
    // ★ 诊断用：模型**原始**交了几条经历（-1 = 它压根没给这个字段）。
    //   真实熔出 0 条时，要能一眼分清「模型没给」和「给了但被抄原文的闸拦了」——
    //   这两种病的药完全不同。
    rawEpisodes: Array.isArray(raw.episodes) ? raw.episodes.length : -1,
    reason: out.length ? 'digested' : 'nothing_usable',
    materialChars: material.length,
  };
}

/**
 * 一条判断落库时，该是「悬着」还是「定下来」。
 *
 * ★ 2026-10-28 修（回放真实数据时抓到的）：
 *   原来这里**无条件** `transition(b, HELD)`——模型明明在 stage 里写了
 *   `pending`（「我还下不了结论」），落库却一律变成 held。
 *   实测拿 6 个真实会话回放，熔出 3 条 stage=pending 的判断，**3 条全被摁成 held**。
 *
 *   后果是连锁的：
 *     · `curiosity` 只认 `status === 'pending'` → 悬案永远是 0 → 不会追问
 *     · `motive` 的 `resolve` 只看 open → 她永远没有「想自己去弄明白」的念头
 *     · `world` 的「还没想明白」那一栏永远是空的
 *
 *   这跟 `mind.#birth` 用的是同一条规矩：**落定只认她自己说的 stage**。
 */
function bornStatus(stage) {
  return ['understood', 'settled', 'acting'].includes(String(stage ?? '').toLowerCase())
    ? STATUS.HELD
    : STATUS.PENDING;
}

/** 落库：按 stage 决定悬着还是定下来；悬着的要留 tension，否则渲染不出「为什么悬」。 */
function land(b, stage, now) {
  const to = bornStatus(stage);
  if (to === STATUS.PENDING) {
    setTension(b, { since: now, why: '这一段里还没想明白' });
    return;
  }
  transition(b, to, { at: now });
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

  // ★ 2026-10-27 大乔修（主人当场抓到的「记忆全跑工作流去了」）。
  //
  //   revision.mjs 的规矩写得清清楚楚：
  //     「材料太少（sources 少于 2 条），一律不算证据」——一次见面说的话不够翻掉一条结论。
  //     「单条不够，要么两条支持相反立场，要么一条重到能压过」。
  //
  //   但 digest 这条路传的是 `sources: result.sources ?? []`，
  //   而 `digestSession()` 的返回值里**根本没有 sources 这个字段**（它是会话，不是逐条材料）。
  //   于是 sources 恒为空数组。
  //
  //   更要命的是 `reconsider(...)` 把 memo 设成了这一条判断自己
  //   → review() 里 `fresh != null` 恒为真 → `enough = fresh != null ? true : ...`
  //   → **单条、任意权重、任何一次熔，都能翻掉任何一条结论**。
  //
  //   实测代价：一天之内 14 条里 8 条被推翻，而且是被「更弱的下一条」推翻，
  //   形成一条链：亲近 → 睡不着 → 流程 → 细节 → 交付 → 工作流 → 小乔 → 小妖精。
  //   她谈了一整晚床上的事，记忆却被一串工作流判断串了下去。
  //
  //   修法：一次会话熔 = **一次见面**，见面里的话只有一份证据，不是两份。
  //   所以 memo 不传（=null），走 revision 原本那条更严的路：
  //   同一主题已有现役结论时，只加固、不推翻。
  //   真要翻，得靠 review() 那条「两条独立反证」或者「重到压得过」的老规矩，
  //   而不是靠 digest 这条捷径。
  //
  //   （想恢复「单条强证据可翻」，就把 `memo: null` 改回去——
  //    但那次改动之前，请先想清楚为什么 8 条记忆在一天之内全被翻掉。）
  // 主题键归一：'trusts|他' 和 'Trusts|他 ' 是同一摊事，'trusts|他' 和 'stalls|他' 不是。
  const normKey = (k) => String(k ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  for (const j of result.judgments) {
    const themeKey = `${j.relation}|${j.subject}`;
    // ★ 2026-10-28 修（P0-1 · 会吃掉整库的那个）。
    //
    //   原来这里是 `find(b => b.subject === j.subject && b.alive)` ——
    //   按「说的对象」找现役判断，理由是「谓词可能因为改主意而变，但对象不会」。
    //
    //   可 subject 归一后绝大多数就是「他」/「我」。于是：
    //     · 「他拖着不办事」会被「他催我」当场改写
    //     · 一次归档熔出 4 条不同判断，全部并进同一条，库里**一条都不增**
    //   实测（2026-10-28）：4 条 judgments，回执 ids 是同一个 id 重复四次。
    //
    //   改法：只有主题键（relation|subject）对得上，才算「同一摊事」。
    //   同一对象、不同谓词，是两件事——各占一格，谁留下由 fade 按份量决定。
    //   这不会让库无限涨：现役上限仍在 fade 手里。
    const current = mind.store.active(themeKey)
      ?? mind.store.all.find((b) => b.alive && normKey(b.themeKey) === normKey(themeKey))
      ?? null;

    if (current) {
      // 这一摊事已经有现役判断：走「会想多」——和逐条 ingest 用的是同一套。
      // 先走「会改自己」：这次熔出来的结论有没有推翻旧的。
      // 交给 reconsider 时，主题键对齐到现役那条：同一个对象上的一致/相反，才是「同一件事」。
      const credible = { ...j, themeKey: current.themeKey, sources: [] };
      // ★ 用 review（不是 reconsider）：reconsider 内部会 `{...ctx, memo}`，
      //   传 null 也会被强制写成 memo=这条判断自己，等于没修。review 走的是
      //   「外面来的证据」那条路——sources < 2 就不算证据，单条翻不动任何东西。
      const rev = mind.revision.review(mind.store.all, credible, { now, sources: [], memo: null });
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
        land(b, j.stage, now);
        mind.store.add(b);
        current.nowNote = b.text;
        b.strength = strengthOfBelief(b, now);   // ★ 2026-10-28：底气由证据算，不由模型给
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
        current.strength = strengthOfBelief(current, now);   // ★ 2026-10-28：记完这笔就重算底气
        // ★ 2026-10-28（阶段 C）：这一次「又看见同一件事」也要入账。
        //   走 recordTurn 不新建判断，但它是归纳的粮食——
        //   少记这一笔，内核按 (对象, 动作) 分组每组只有 1 条，永远数不出「见过 3 回」。
        mind.store.observe(makeEvent({
          at: now,
          actor: j.subject, action: j.relation, polarity: j.polarity,
          text: j.text, themeKey, source: 'digest', weight: j.weight, beliefId: current.id,
        }));
        if (current.status === STATUS.PENDING && bornStatus(j.stage) === STATUS.HELD) {
          transition(current, STATUS.HELD, { at: now });
        }
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
    land(b, j.stage, now);
    mind.store.add(b);
    b.strength = strengthOfBelief(b, now);   // ★ 2026-10-28：底气由证据算，不由模型给
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
