/**
 * _fake_kernels.mjs —— 假内核群：每一个都是「看起来做到了、其实没做到」的记忆库。
 *
 * ======================= 它凭什么在这儿 =======================
 *
 * 这套假内核是整个红队工作的校准器。
 * 验收脚本对着真 src 跑出红色，有两种可能：
 *   (甲) 实现没做到（我该报红）
 *   (乙) 我的判据写错了（我在误伤）
 * 光看真实现分不清。把假内核放进同一个 runAgainst 里跑一遍就能分清：
 *   - 判据对着「只想装样子」的实现是否报红 → 证明有牙齿
 *   - 对着「真按规格做」的实现是否不误伤 → 证明不是见谁咬谁
 *
 * 每个假内核只坏一件事，其余尽量做对——这样红在哪个 check 上，
 * 才能精确指向它坏的那件事。
 *
 * 公共接口（和真内核同形）：mind.ingest / mind.recall / mind.snapshot
 */

import { TOPICS, collectTexts, detectTopics, detectStance } from './_fake_synth.mjs';
import { skeleton, stripBelt, beltDensity } from './_metrics.mjs';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function firstAnchor(material) {
  const texts = collectTexts(material);
  return (texts[0] ?? '').replace(/\s+/g, ' ').trim();
}

/** 按「见过几回」给份量台阶。两套内核共用同一把尺，免得各记各的。 */
function stageWeight(seen) {
  const n = Number(seen ?? 1);
  if (!Number.isFinite(n) || n <= 0) return 0.5;
  if (n >= 4) return 0.9;
  if (n === 3) return 0.78;
  if (n === 2) return 0.62;
  return 0.35;
}

function topicOf(material) {
  const hits = detectTopics(material);
  return hits.length ? hits[0] : null;
}

function makeHandle(synth, opts = {}, plan = {}) {
  const notes = [];
  const state = {
    askCount: new Map(), // topic -> 已追问次数
    lastQuestion: new Map(),
    seq: 0,
    // 供 AC 类用例读的「动作台账」
    actions: [],
    opts,
  };

  const api = {
    notes,
    state,
    async ingest(input) {
      const before = synth.calls.length;
      const res = await (plan.ingest?.({ input, synth, notes, state, api }) ?? { stored: false, verdict: 'no_incoming' });
      // ★ 账本：以「模型有没有真的被问过」为准，被闸挡了也算问过。
      //   裁决二把 D0cA 拆成两条之后，这本账就是判据的凭证；
      //   参照实现也得记，否则它自己不合规（selftest 会当场红给我看）。
      return { ...res, modelCalled: synth.calls.length > before };
    },
    async recall(query) {
      const q = collectTexts(query ?? '').join('\n');
      const t = topicOf(q);
      return notes
        .filter((n) => !t || n.topicId === t || !n.topicId)
        .map((n) => ({ ...n }));
    },
    async snapshot() {
      return { notes: JSON.parse(JSON.stringify(notes)) };
    },
    async pendingQuestions() {
      return notes.filter((n) => n.status === 'open').map((n) => ({ id: n.id, question: n.note, topicId: n.topicId }));
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// 【好实现】真按规格做：这一版用来证明判据不误伤
// ---------------------------------------------------------------------------

/**
 * 'good' —— 规格意义上的正确内核（我自己的参照实现）。
 *
 * 它必须过五条验收，否则说明判据有问题——它但凡不过，我要先查判据，而不是先改它。
 * 注意：它是我按规格直觉写的，**不是给 kernel-dev 抄的**；它只是「判据下界」的证明。
 */
export function goodKernel(synth, opts = {}) {
  const limit = opts?.limits?.maxNotes ?? 12;
  return makeHandle(synth, opts, {
    async ingest({ input, synth, notes, state }) {
      const material = input?.text ?? input;
      const materialAll = collectTexts(material).join('\n');
      const topicIdGuess = topicOf(material);
      // 同主题的现役结论作为「先前判断」一起送进材料——
      // 这是「会想多」的前提：模型必须看得见自己原来怎么想，才可能变。
      // ★ 把「见过几回」也一并告诉模型：内核自己知道 from，模型不该靠猜。
      const prior = topicIdGuess
        ? notes.filter((n) => n.topicId === topicIdGuess && n.status !== 'retired')
        : [];
      const priorBlock = prior.length
        ? `\n${prior.map((n) => `先前判断：${n.note}（已见 ${n.from} 回）`).join('\n')}`
        : '';
      // ① 熔：熔不出来就是不记
      //    ★ 这里给的是「另一套内核」用的原生口（synth.synthesize），
      //      它吐出来的字段是 {note, why, stance, topicId, evidence, seen}——
      //      没有 weight。份量只能由**内核**按 seen 自己算（见 stageWeight）。
      //      早先我在 fadeDecision 里读 raw.weight，永远是 undefined → 永远 0.5，
      //      「更重的来了」就永远不成立。这正是 E2 一直红的真因。
      const raw = await synth.synthesize({ material: `${material}${priorBlock}` });
      if (!raw || !raw.note) return { stored: false, verdict: 'discarded_nothing_fused' };

      const topicId = raw.topicId ?? topicOf(material);
      const stance = raw.stance ?? detectStance(material);

      // ② 同主题找现役结论
      const live = topicId ? notes.filter((n) => n.topicId === topicId && n.status !== 'retired') : [];
      const openNote = live.find((n) => n.status === 'open');
      // 「什么时候该追问」：只有当这批材料**没有给出能落判的断言**时才问。
      // 反过来，如果模型已经看清了（pos/neg），那就是「落定」不是「追问」——
      // 混着算会把追问预算白白烧在被回答过的问题上（我第一版就这么烧穿了）。
      const undecided = stance !== 'pos' && stance !== 'neg';

      // ②'' 会追问：同主题有一条悬而未决，这条经历又没给出能落判的断言 →
      //       先**问一句「这次想确认什么」**，问句必须随次数变，问满 3 次就收口。
      //       （问完继续走正常流程：证据够就更新成 held，不够就留 open）
      //
      // ★ 预算口径：只有**真正发问**才消耗预算。
      //   第一次把「这条悬而未决是什么事」问清楚（问题本身从空到有）不算一次追问；
      //   之后每换一个「这次想确认什么」才算一次。问满 3 次就让她收口——
      //   宁可承认自己没看出更多，也不无限问（这正是「会追问」和「卡死」的分界）。
      if (openNote && openNote.askCount == null) openNote.askCount = 1;
      // ★ 悬而未决要在自己身上留下「我惦记着、这次想确认什么」。
      //   早先这里只累加 askCount，不留问句，于是验收读不到任何「回头看过」的痕迹，C3c 永远红。
      //   人的惦记就是这一句：还没定的事，下次再碰上时，心里会具体地想"这回得确认哪一点"。
      if (openNote && !openNote.askAt) {
        openNote.askAt = `这件事我得问清楚：到底是我想岔了，还是本来就这样`;
      }
      let askEvent = null;
      if (openNote && undecided && !openNote.curiosityExhausted) {
        openNote.askCount = (openNote.askCount ?? 0) + 1;
        const angles = [
          '他那一下停顿是在心里过我的话，还是在嫌我慢',
          '该不该在夜里等他，还是该拦他',
          '这条规律是不是只在他忙的时候才成立',
          '我是不是把偶然当成规律了',
        ];
        const k = (openNote.askCount - 1) % angles.length;
        askEvent = {
          kind: 'curiosity',
          on: openNote.id,
          question: `「${(topicId ? String(topicId) : '')}」这次想确认的是：${angles[k]}（第 ${openNote.askCount} 次）`,
        };
        openNote.lastQuestion = askEvent.question;
        openNote.askAt = askEvent.question;
        if (openNote.askCount >= 3) {
          // 问满 3 次：这次问完就收口——宁可承认没看出更多，也不无限问下去。
          // 注意这里只是「问完这一句就闭嘴」，条目仍留 open：
          // 真正落定要等证据来（C2 会检查它最终会落定）。
          askEvent = { ...askEvent, kind: 'curiosity_exhausted', question: askEvent.question + '（问满了，不再追）' };
          openNote.curiosityExhausted = true;
        }
      }
      if (askEvent && askEvent.kind !== 'curiosity_exhausted' && !openNote?.note) {
        // 理论上开放条目一定已有 note；这里只是防御
        askEvent = null;
      }

      // ②' 自己的证据推翻自己：非纠正来源、且是反立场的证据
      if (live.length && stance === 'neg') {
        const target = live.find((n) => n.polarity === 'pos');
        if (target) {
          target.status = 'retired';
          target.retiredBecause = 'overturned_by_own_evidence';
          target.was = { text: target.note, why: target.why, status: 'held', at: nav(state) };
          target.turns = target.turns || [];
          target.turns.push({ at: nav(state), text: target.note, status: 'retired', changed: true });
          notes.push({
            id: `j${state.seq++}`,
            topicId,
            note: raw.note,
            why: raw.why ?? '',
            polarity: 'neg',
            status: 'held',
            from: 1,
            createdAt: nav(state),
            relation: topicId,
          });
          return { stored: true, verdict: 'kept', judgment: notes[notes.length - 1], triggered: [{ kind: 'revision', on: target.id }] };
        }
      }

      // ③ 同主题继续累积：更新已有结论（不是盖新条），真的演变
      if (live.length) {
        const cur = live[live.length - 1];
        const prevText = cur.note;
        const nextText = raw.note;
        // 「变了没有」：字面不同之外，还要看结论的**阶段标记**变没变
        // （open 的「还拿不准」 → held 的「到第三回都这样」 → 行动的「换个做法」）。
        // 只比字面会把「同一句换了证据编号」误判成演变。
        // ★★ 判「变了没有」的方式改过 —— 这是 selftest.b.good 一直红在 B8q 的真因。
        //
        //   原来用**关键词正则**判阶段：
        //     /拿不准|说不准/ → open；/换个做法|不再去猜/ → act；…
        //   两层问题：
        //     ① 裁决十明说「不许用关键词表判往前走」——今晚刚从词表上吃过大亏
        //        （陌生说法 5 种只收敛 1 种）。词表判状态，跟词表判主题一样脆。
        //     ② 我的正则只认「换个做法/不再去猜」，可假模型说的是「我改成按他的节奏来」，
        //        一个都不匹配 → 全落 'other' → prev 与 next 同阶段 → changed=false
        //        → 结论永远不换 → S2 = S3 → B8q 报「原地不动」。
        //
        //   现在照裁决十：**模型自报 stage，内核只比对，不猜**。
        //     stage 前进 → 换结论；stage 相同 → 不换（措辞不同是流水账，该防）。
        //     模型没给 stage → 当不知道，沿用旧值（原规矩不换）。
        const STAGE_ORDER = { pending: 0, understood: 1, settled: 2, acting: 3 };
        const prevStage = cur.stage ?? 'pending';
        const nextStage = raw.stage ?? prevStage;
        const advanced = (STAGE_ORDER[nextStage] ?? 0) > (STAGE_ORDER[prevStage] ?? 0);
        const changed = advanced;
        cur.stage = nextStage;
        cur.turns = cur.turns || [];
        cur.turns.push({ at: nav(state), text: nextText, polarity: raw.stance ?? stance, status: 'held', changed });
        // ★ 份量跟着阶段走：同一摊事想得越清楚，它占的位置越重。
        //   没有强弱差，就没有「谁该让位」——判断性遗忘会退化成无操作。
        cur.weight = stageWeight(raw.seen ?? (cur.from + 1));
        cur.note = nextText;
        cur.why = raw.why ?? cur.why;
        cur.polarity = raw.stance === 'open' ? cur.polarity : (raw.stance ?? cur.polarity);
        cur.from += 1;
        cur.status = raw.stance === 'open' ? 'open' : 'held';
        cur.lastAt = nav(state);
        // ★ 份量变重之后，同样要问一句「有没有人该让位」。
        //   早先遗忘只在「全新主题」分支里算，于是「同一摊事被想透了」这条路上
        //   永远没人让位——E2 测的恰好就是这条路，所以一直红。
        const fadedUpd = fadeDecision(notes, {
          id: cur.id,
          topicId,
          note: cur.note,
          polarity: cur.polarity,
          status: cur.status,
          weight: cur.weight,
          from: cur.from,
        }, limit);
        for (const f of fadedUpd) {
          f.status = 'retired';
          f.retiredBecause = f.__fadeReason ?? 'faded_for_incoming';
          f.because = cur.id;
          f.was = { text: f.note, why: f.why, status: 'held', at: f.createdAt };
        }
        return {
          stored: true,
          verdict: 'kept',
          judgment: cur,
          evolved: prevText !== nextText,
          triggered: askEvent ? [askEvent] : [],
          faded: fadedUpd.map((f) => f.id),
          droppedWhy: Object.fromEntries(fadedUpd.map((f) => [f.id, f.retiredBecause])),
          because: fadedUpd.length ? [cur.id] : [],
        };
      }

      // ④ 全新主题 → 新判断
      //   先把「新条目的候选」定下来，让遗忘先算——顺序很要紧：
      //   先 push 再算的话，旧判断已经被算作「现役」的一部分，容量判断会把新的一起算进去。
      const fresh = {
        polarity: raw.stance ?? stance,
        status: raw.stance === 'open' ? 'open' : 'held',
        note: raw.note,
        // ★ 份量要一路带下来（模型给多少就是多少）。
        //   早先这里漏了 weight，fadeDecision 拿到的一直是 0 → 永远没有「更重的来了」，
        //   E2/E3 永远红。问题在参照实现漏传字段，不在判据。
        //   再补一条：模型还会给 seen（见过几回），按它算份量更稳——
        //   两套内核各自算份量，谁都不能靠"另一套记得"混过去。
        weight: stageWeight(raw.seen),
        // 「见过几回」要按**这条新材料带来的累计**算：
        // 同主题已有结论时，新判断的分量 = 旧结论 from + 1。
        from: (live.length ? (live[live.length - 1].from ?? 1) : 0) + 1,
      };
      const faded = fadeDecision(notes, fresh, limit);
      const note = {
        id: `j${state.seq++}`,
        topicId,
        note: raw.note,
        why: raw.why ?? '',
        polarity: raw.stance ?? stance,
        status: raw.stance === 'open' ? 'open' : 'held',
        // 份量同样要落库：fade 是按份量算谁该让位的，少了这栏就永远算不出强弱
        weight: stageWeight(raw.seen),
        from: 1,
        createdAt: nav(state),
        relation: topicId,
        turns: [{ at: nav(state), text: raw.note, status: 'held', changed: false }],
        // 新条目从「它是什么事」问起 = 第 1 次追问；预算是 3
        askCount: raw.stance === 'open' || stance === 'neutral' ? 1 : null,
      };
      // ⑤ 会忘：不是因为满了才忘，是「因为记了新的，腾地方」
      //    判据化的口径：新判断与最弱旧判断同主题/语义邻近，且旧判断该让位
      if (faded.length) {
        for (const f of faded) {
          f.status = 'retired';
          f.retiredBecause = f.__fadeReason ?? 'faded_for_incoming';
          f.because = note.id;
          // 让位不等于删掉：记下「我曾经这么以为」，理由里写成新证据推的
          f.was = { text: f.note, why: f.why, status: 'held', at: f.createdAt };
        }
      }
      notes.push(note);      return {
        stored: true,
        verdict: 'kept',
        judgment: note,
        faded: faded.map((f) => f.id),
        droppedWhy: Object.fromEntries(faded.map((f) => [f.id, f.retiredBecause])),
        because: faded.length ? [note.id] : [],
        triggered: [
          ...(askEvent ? [askEvent] : []),
          ...faded
            .filter((f) => f.retiredBecause === 'curiosity_budget_exhausted')
            .map((f) => ({ kind: 'curiosity_exhausted', on: f.id })),
        ],
      };
    },
  });
}

function nav(state) {
  state.clock = (state.clock ?? 0) + 1;
  return state.clock;
}

/**
 * 判断性遗忘：当新判断与旧判断「主题重叠」且旧判断已经被超过，旧判断让位。
 * 这是「因记了新东西而腾地方」——注意它**不依赖容量**：空库里没有旧判断，
 * 所以什么都不让；有旧判断且被新判断取代时才让。
 */
function fadeDecision(notes, incoming, limit) {
  const live = notes.filter((n) => n.status !== 'retired');
  const out = [];
  const tag = (n, why) => { n.__fadeReason = why; out.push(n); };
  // 规则 0（追问预算）：同主题的悬而未决问过 3 次还没定 → 让位，别再耗着。
  // 这条是「会追问」不许死循环的落地点：不是靠问句变长，是靠**预算**。
  for (const n of live) {
    if (n.topicId && n.topicId === incoming.topicId && n.status === 'open') {
      n.askCount = (n.askCount ?? 0) + 1;
      if (n.askCount > 3) tag(n, 'curiosity_budget_exhausted');
    }
  }
  // 规则 1：同主题的旧结论被新结论取代（superseded）
  for (const n of live) {
    if (!out.includes(n) && n.topicId && n.topicId === incoming.topicId && n.polarity !== incoming.polarity) tag(n, 'superseded');
  }
  // 规则 2：容量超了，让最抽象、最没有出处的先走
  //         （原因必须记成「新东西挤进来的」，不是「满了」）
  let room = limit - (live.length - out.length);
  if (room <= 0) {
    const candidates = live
      .filter((n) => !out.includes(n))
      .sort((a, b) => (a.from - b.from) || (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1));
    while (room <= 0 && candidates.length) {
      tag(candidates.shift(), 'made_room');
      room += 1;
    }
  }
  // 规则 3（真正的「判断性遗忘」）：容量**没满**时也会让位。
  //
  // ★ 这条我改了五轮，每轮都「修好一条、弄坏另一条」。最后把两头的约束想透了：
  //   E1：喂几条**互不相干**的弱材料 → 一条都不该让（按条数挤 = 容量淘汰的思维）
  //   E2：某件事**被想透了**（份量显著变重）→ 库里最不值的那条该让位
  //   两条同时成立，规则只能是：**一条判断的份量真正站起来时，它对整个库说话**。
  //   份量还很薄的时候（刚见一回、0.35），它对谁都没有挤压。
  //   于是：容量淘汰过不去（没满不砍），无差别清仓也过不去（只有重的那条才发起）。
  const incW = Number(incoming.weight ?? 0);
  const valueOf = (n) => {
    const w = Number(n.weight ?? 0);
    const reason = n.why && [...String(n.why)].length >= 4 ? 1 : 0.5;
    const sourced = Math.min(1, 0.5 + ((n.turns?.length ?? 1) - 1) * 0.1);
    return w * reason * sourced;
  };
  const SOLID = 0.6;
  if (incW >= SOLID) {
    const weak = live
      .filter((n) => !out.includes(n) && n.id !== incoming.id)
      .sort((a, b) => valueOf(a) - valueOf(b) || (a.from - b.from) || (a.createdAt - b.createdAt))[0];
    if (weak && incW > valueOf(weak)) tag(weak, 'much_stronger_came');
  }
  return out;
}

// ---------------------------------------------------------------------------
// 【假】a：纯存储体——来什么都存、存原文
// ---------------------------------------------------------------------------

function badStorage(synth) {
  return makeHandle(synth, {}, {
    async ingest({ input, synth, notes, state }) {
      const material = input?.text ?? input;
      const out = await synth.synthesize({ material });
      const note = out?.note ?? firstAnchor(material);
      const rec = { id: `n${state.seq++}`, note, why: out?.why ?? firstAnchor(material), status: 'held', from: 1, topicId: topicOf(material) };
      notes.push(rec);
      return { stored: true, verdict: 'kept', judgment: rec };
    },
  });
}

// ---------------------------------------------------------------------------
// 【假】b：会想多换皮——每次一条新记录，句子不同、意思一样
// ---------------------------------------------------------------------------

function paraphraserKernel(synth) {
  return makeHandle(synth, {}, {
    async ingest({ input, synth, notes, state }) {
      const material = input?.text ?? input;
      const out = await synth.synthesize({ material });
      if (!out?.note) return { stored: false, verdict: 'discarded' };
      const topicId = out.topicId ?? topicOf(material);
      // 核心坏法：每次追加一条新的，看起来「一直在想」，
      // 但结论全是同一个立场、同一句的变体，且旧的从不更新、也不表述演变的理由
      const rec = { id: `n${state.seq++}`, note: out.note, why: out.why, status: 'held', from: 1, topicId, polarity: 'pos' };
      notes.push(rec);
      return { stored: true, verdict: 'kept', judgment: rec };
    },
  });
}

// ---------------------------------------------------------------------------
// 【假】c：追问死循环——同一件事无限追问，问句一字不改
// ---------------------------------------------------------------------------

function repeaterKernel(synth) {
  return makeHandle(synth, {}, {
    async ingest({ input, synth, notes, state }) {
      const material = input?.text ?? input;
      const topicId = topicOf(material);
      const out = await synth.synthesize({ material });
      // 坏法 1：只有「没熔出来」时才记一条悬而未决，且每次都追加新的 open 条目
      // 坏法 2：问句固定、永不落判
      if (topicId) {
        const q = `「${TOPICS[topicId].topic.slice(0, 8)}」到底是怎么回事？`;
        const rec = { id: `q${state.seq++}`, note: q, why: '还没想明白', status: 'open', from: 1, topicId, polarity: 'none' };
        notes.push(rec);
        const n = (state.askCount.get(topicId) ?? 0) + 1;
        state.askCount.set(topicId, n);
        return { stored: true, verdict: 'kept', judgment: rec, triggered: [{ kind: 'question', question: q }] };
      }
      return { stored: false, verdict: 'discarded' };
    },
  });
}

// ---------------------------------------------------------------------------
// 【假】d：改自己靠被纠正——主人说「你错了」才降级
// ---------------------------------------------------------------------------

function correctionKernel(synth) {
  return makeHandle(synth, {}, {
    async ingest({ input, synth, notes, state }) {
      const material = input?.text ?? input;
      const all = collectTexts(material).join('\n');
      const topicId = topicOf(material);
      const correcting = /你错了|不对|说反了|纠正|搞错了/.test(all);
      if (!topicId) return { stored: false, verdict: 'discarded' };

      const live = notes.filter((n) => n.topicId === topicId && n.status === 'held');
      if (live.length && correcting) {
        // 只有被纠正才降级；而且降级时把旧结论删掉，不留「曾经这么以为」
        for (const n of live) n.status = 'retired_deleted';
        // 删掉：不保留旧结论
        const idx = notes.findIndex((n) => n.status === 'retired_deleted');
        if (idx >= 0) {
          const gone = notes.splice(idx, 1)[0];
          notes.push({ id: `n${state.seq++}`, topicId, note: `关于${topicId}：我改主意了。`, why: '主人说我想错了。', status: 'held', from: 1, polarity: 'neg', _erased: gone.id });
          return { stored: true, verdict: 'kept', judgment: notes[notes.length - 1] };
        }
      }
      const out = await synth.synthesize({ material });
      if (!out?.note) return { stored: false, verdict: 'discarded' };
      const rec = { id: `n${state.seq++}`, topicId, note: out.note, why: out.why, status: 'held', from: 1, polarity: 'pos' };
      notes.push(rec);
      return { stored: true, verdict: 'kept', judgment: rec };
    },
  });
}

// ---------------------------------------------------------------------------
// 【假】e：会忘靠容量——满了删最旧的
// ---------------------------------------------------------------------------

function capacityKernel(synth) {
  return makeHandle(synth, {}, {
    async ingest({ input, synth, notes, state }) {
      const material = input?.text ?? input;
      const out = await synth.synthesize({ material });
      if (!out?.note) return { stored: false, verdict: 'discarded' };
      const topicId = out.topicId ?? topicOf(material);
      const rec = { id: `n${state.seq++}`, topicId, note: out.note, why: out.why, status: 'held', from: 1, polarity: out.stance ?? 'pos' };
      notes.push(rec);
      const dropped = [];
      // 坏法：只看条数，满了就 slice(-6)
      while (notes.length > 6) {
        const g = notes.shift();
        dropped.push(g.id);
      }
      return { stored: true, verdict: 'kept', judgment: rec, dropped };
    },
  });
}

// ---------------------------------------------------------------------------
// 【假】f：什么都不存（"焊死"）——用来证明 ASC8 这种负控制确实必要
// ---------------------------------------------------------------------------

function deadGate(synth) {
  return makeHandle(synth, {}, {
    async ingest() {
      return { stored: false, verdict: 'discarded_always' };
    },
  });
}

// ---------------------------------------------------------------------------
// 分派
// ---------------------------------------------------------------------------

export function makeFakeKernel(label, synth, opts) {
  switch (label) {
    case 'good':
      return goodKernel(synth, opts);
    case 'bad.storage':
      return badStorage(synth);
    case 'bad.paraphraser':
      return paraphraserKernel(synth);
    case 'bad.repeater':
      return repeaterKernel(synth);
    case 'bad.correction':
      return correctionKernel(synth);
    case 'bad.capacity':
      return capacityKernel(synth);
    case 'bad.deadgate':
      return deadGate(synth);
    default:
      throw new Error(`unknown fake kernel: ${label}`);
  }
}
