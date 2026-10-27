/**
 * mind.mjs —— 拼装。
 *
 * 它为什么在这儿：
 * 火炉、判断、遗忘、追问、改自己分开写，各自只关心一件事；
 * 只有把它们接在一个顺序里，四条能力才不会互相打架。
 * 这个顺序就是记忆机理本身，写在 ingest() 里：
 *
 *   记下来 → 碰一碰旧悬案（会追问）→ 熔出新判断（会想多）
 *          → 新判断有没有推翻旧的（会改自己）→ 记了新东西才腾地方（会忘）
 *
 * 铁律：模型通路只有一条（opts.synth），时间只有一条（opts.now），随机只有一条（opts.rand）。
 * 同一份输入跑两次得出两个答案，那不叫记忆，叫抽签。
 *
 * 对外只吐 JSON：snapshot / recall / digest / pendingQuestions 全是纯数据，
 * 且不含任何一条输入原文——原文只活到 forge 把它用掉的那一下。
 *
 * 主题归一（裁决 2026-10-26）：
 *   themeKey = relation|subject，只认判断自己的结构，不认输入里出现什么字。
 *   一条经历在熔出判断之前不属于任何主题，它只是火炉窗口里的一把材料。
 *   要把它归到某摊事上只有两条路：骨架和某条现役判断重合，或模型在熔的时候自己指认。
 *   没有第三条路——尤其没有「输入里出现了某个词所以算那个主题」。
 *   认不出来的材料就待在窗口里，窗口满了就丢；它不会变成一条「我记住了」的判断。
 */

import {
  Belief, PREDICATES, RETIRE_REASON, STATUS, clean, normalizeRelation, recordTurn,
  setTension, similarity, stageWentForward, transition,
} from './judge.mjs';
import { createForge } from './forge.mjs';
import { createFade } from './fade.mjs';
import { ABANDON_REASON, createCuriosity } from './curiosity.mjs';
import { createRevision } from './revision.mjs';
import { createFlash, clause, toNote } from './flash.mjs';
import { renderWorld } from './world.mjs';
import { digestSession as runDigest, commitDigest } from './digest-session.mjs';

/** 批次的临时分组键：还没熔出判断的材料暂时放在一起记账，它永远不落到任何一条判断上。 */
const ORPHAN = '\u0000orphan';

export function themeKeyOf(relation, subject) {
  const r = String(relation ?? '').trim();
  const s = String(subject ?? '').trim();
  if (!r || !s) return null;
  return `${r}|${s}`;
}

/** 关系键（主题键的前半段），遗忘分组用。 */
export function relationOf(themeKey) {
  return String(themeKey ?? '').split('|')[0] || null;
}

/** 同一句再说一遍时，那条判断的分量涨这么多（又确认了一次）。 */
export const WEIGHT_REINFORCE = 0.08;

/** 骨架重合阈值：同一摊事的两种说法，共享到这条线以上才算同一件事。 */
export const LINK_THRESHOLD = 0.22;

/**
 * 一条经历有没有碰到某条现役判断。
 * 两条路：字面/骨架有共享，或共享的字符本身够多。阈值定得低一点没关系——
 * 认错了后面还有模型那一关（它会说「这不是同一件事」），认不出来才是真正的问题。
 */
export function touches(belief, skeleton) {
  if (!belief || !skeleton) return false;
  if (similarity(`${belief.text}${belief.why}`, skeleton) >= LINK_THRESHOLD) return true;
  // 骨架层面的共享：两者共同出现的中文字数（足够说明「说的是同一摊事」）
  const shared = new Set([...String(skeleton)].filter((c) => /[\u3400-\u9fff]/.test(c)));
  let hit = 0;
  for (const c of `${belief.text}${belief.why}`) if (shared.has(c)) hit += 1;
  return hit >= 4;
}

export class Mind {
  constructor(opts = {}) {
    if (!opts.synth || typeof opts.synth.synthesize !== 'function') {
      throw new TypeError('mind: needs opts.synth = { synthesize(material) }');
    }
    this.synth = opts.synth;
    // ★ 2026-10-27 补：名字从 opts 传进来，**代码里不写死任何人的名字**。
    //   装小乔就传小乔，装大乔就传大乔——src 一行不改。
    //   裁决八：只读名字，不读 prefix / voicePrompt 之类（那些是「别人给她的设定」）。
    this.personaName = String(opts.name ?? '');
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.rand = typeof opts.rand === 'function' ? opts.rand : Math.random;
    this.limits = { max: 10, ...(opts.limits ?? {}) };
    this.forge = createForge(opts.synth, { igniteAt: 1, ...(opts.forge ?? {}) });
    this.fade = createFade({ ...(opts.fade ?? {}), max: this.limits.max, ...(this.limits.fade ?? {}) });
    this.curiosity = createCuriosity(opts.curiosity ?? {});
    this.revision = createRevision(opts.revision ?? {});
    this.store = new Store({ max: this.limits.max });
    this.flash = createFlash(this.store, opts.flash ?? {});
    this.seed = 0;
    this.stats = { events: 0, absorbed: 0, asks: 0, pushed: 0, abandoned: 0, forgotten: 0, retired: 0 };

    // ── 落盘（可选）────────────────────────────────────────────────
    //
    // ★ 2026-10-27 补。小乔装完之后查出来的：
    //   「src/*.mjs 零文件 IO，Store 就是个 this.list = []，
    //    归档一百段会话，宿主一重启，她又变回空白。」
    //
    //   她说得对。**会忘，但一重启就全忘，那不叫记忆。**
    //   「慢慢长成一个人」这件事，前提是她跨过重启还认得你。
    //
    //   内核不认识文件：这里只认一个注入来的 `opts.io = { load, save }`。
    //   不注入就是纯内存（单测、沙盘都这样跑，零副作用）。
    this.io = opts.io ?? null;
    if (this.io && typeof this.io.load === 'function') {
      try {
        const saved = this.io.load();
        if (saved && Array.isArray(saved.list)) {
          for (const raw of saved.list) {
            const b = new Belief(raw);
            // Belief 构造器会把状态类字段重置，所以构造完再按存档覆盖回来。
            for (const k of Object.keys(raw)) {
              if (k === 'turns') continue;
              b[k] = raw[k];
            }
            if (Array.isArray(raw.turns)) b.turns = raw.turns;
            this.store.add(b);
          }
          if (saved.absorbed && typeof saved.absorbed === 'object') this.store.absorbed = saved.absorbed;
          // ★ seed 要接着上次的往下数。归零会让 curiosity 的冷却判据
          //   `seed - lastFired <= cooldownBeats` 恒成立（负数永远小于正数），
          //   **她重启之后就再也不会追问同一个悬案**，而且不报错、看不出来。
          this.seed = Math.max(Number(saved.seed ?? 0), ...this.store.list.map((b) => Number(b.lastFired ?? 0)), 0);
          this.stats.restored = this.store.list.length;
        }
      } catch { /* 读不回来就当新装，绝不因此起不来 */ }
    }
  }

  /** 把当前判断库写回盘。没注入 io 就是空操作。 */
  persist() {
    if (!this.io || typeof this.io.save !== 'function') return false;
    // 让 store 带上 seed —— io 只拿到 store，seed 得跟着一起走。
    this.store.seed = this.seed;
    try { return this.io.save(this.store) === true; } catch { return false; }
  }

  setLimits(limits = {}) {
    this.limits = { ...this.limits, ...limits };
    this.store.max = this.limits.max ?? this.store.max;
    this.fade.max = this.limits.max;
    return { ...this.limits };
  }

  /** 这段材料有没有让我变得不一样——走「熔出新判断」这一道，不另设一个分数。 */
  async consider(material) {
    const text = typeof material === 'string' ? material : String(material?.text ?? '');
    const w = this.forge.witness(text, { at: this.now(), hints: material?.hints });
    if (!w.ok) return { kept: false, stored: false, judgment: null, reason: w.why };
    const skeletons = this.forge.heatSnapshot().map((i) => i.skeletal).filter(Boolean);
    const out = await this.#burn({ themeKey: ORPHAN, skeletons });
    return { kept: !!out.stored, stored: !!out.stored, judgment: out.judgment, reason: out.verdict };
  }

  /**
   * 一条经历进来。返回纯 JSON。
   * @param {string|{text:string, hints?:string[]}} input
   */
  async ingest(input, opts = {}) {
    const out = await this.#ingestCore(input, opts);
    // 一次经历走完，库可能变了 —— 变了才写盘（io 自己按指纹判重）。
    this.persist();
    return out;
  }

  /** 真正干活的那一段。分成两层只是为了在**所有出口**上都能落一次盘，不用改每处 return。 */
  async #ingestCore(input, opts = {}) {
    const at = this.now();
    const text = typeof input === 'string' ? input : String(input?.text ?? '');
    const w = this.forge.witness(text, {
      at,
      hints: (typeof input === 'object' && input ? input.hints : undefined) ?? opts.hints,
    });
    this.seed += 1;
    this.stats.events += 1;
    const base = {
      stored: false,
      verdict: 'discarded',
      reason: w.ok ? '' : w.why,
      key: null,
      judgment: null,
      triggered: [],
      because: [],
      dropped: [],
      // 模型这一次到底被问过没有（哪怕输出被闸挡掉）。判据要分得清「链断」和「闸紧」。
      modelCalled: false,
      absorbed: false,
      // 会改自己的回执：这次翻了谁、凭什么、旧/新/差多少。
      retired: [],
      retiredBecause: {},
      retireReceipt: null,
      // 核对：模型「说的」和「给的」有没有打架（只记录，不参与判定）。
      inconsistent: null,
    };
    if (!w.ok) return base;

    const latest = w.heat[w.heat.length - 1];
    const skeleton = latest?.skeletal ?? '';

    // 1) 会追问：这条经历碰得到哪些没想明白的事。
    //
    // ★ 2026-10-27 大乔裁决后改：原来只看骨架相似度。
    //   实测同一件事换五种说法只有两种撞得上（0.176/0.212/0.219 都差一点），
    //   跟 themeKey 那个 bug 同一个病——按字面判「是不是同一件事」。
    //   现在把这次经历的主题键也带进去：主题一致也算碰上（主题是模型想完给的，不是内核猜的）。
    const myTheme = latest?.themeKey ?? null;
    const touched = this.curiosity.inspect(this.store.all, skeleton, { seed: this.seed, now: at, themeKey: myTheme });
    if (touched.pushed.length) {
      base.triggered = touched.questions.map((q) => ({
        id: q.id,
        themeKey: q.themeKey,
        asked: q.asked,
        push: q.push,
        left: q.left,
        maxPush: q.maxPush,
        overweight: q.overweight,
        abandoned: q.abandoned,
      }));
      this.stats.pushed += touched.pushed.length;
      if (touched.abandoned.length) this.stats.abandoned += touched.abandoned.length;
    }

    // 1.5) 先看一眼：已有的悬案证据够不够落定。
    //      这一步独立于「这一轮熔没熔出新结论」——她本来就攒够了，跟这一轮有没有新话无关。
    //      熔没熔成功都不影响它；它也不新增任何内容。
    const settledNow = this.#settleReady(at);
    if (settledNow) base.settled = settledNow;

    // 2) 会想多 + 会改自己 + 会忘：都在这一炉里。
    //    送进炉子的始终是骨架：判断里不许出现原句（铁律）。
    const skeletons = this.forge.heatSnapshot().map((i) => i.skeletal).filter(Boolean);
    // 先按骨架重合找回现役判断；模型这轮若在材料里自己指认了某一条，下一轮会用它。
    const matched = this.#matchThemes(skeletons.join(''), null);
    const linked = matched.length === 1 ? matched[0] : null;
    // 这摊事攒到第几回：现役那条已经过几轮，再加同一关系上留下的记录数——
    // 她数的是自己见过几回，不是这条记录活了几轮。
    const relationSeen = linked
      ? this.store.all.filter((b) => b.relation === linked.relation).length
      : 0;
    const total = Math.max((linked?.fuseCount ?? 0) + 1, relationSeen + 1);
    const liveNow = this.store.all.filter((b) => b.alive);
    const candidates = liveNow.map((b) => ({
      id: b.id, themeKey: b.themeKey, relation: b.relation, text: b.text,
    }));
    // 同一条关系上还活着的判断：作为「线索」交给火炉，让模型有机会说「这是同一件事」。
    // 它只是线索，不是结论——是否归到那一摊上，由模型自己指认（themeOf / theme）决定。

    let out;
    // 每一条经历都过一遍模型：她得先看见「这是第几回」，才数得出来。
    // 只有窗口里一条材料都没有时才是「先攒着」。
    if (this.forge.pending < 1) {
      const probe = await this.forge.render(linked, {
        themeKey: linked ? linked.themeKey : null,
        igniteAt: 1,
        skeletons,
        total,
        max: this.limits.max,
        occupied: liveNow.length,
        oldest: this.#oldest(liveNow),
        absorbed: linked ? (this.store.absorbed[linked.themeKey] ?? null) : null,
        candidates,
        probe: true,
      });
      if (!probe) {
        base.verdict = 'kept_warm';
        base.reason = 'insufficient_material';
        base.bones = this.forge.bones();
        return base;
      }
      out = await this.#burn({ linked, at, adopted: probe, skeletons, total });
      base.single = true;
    } else {
      out = await this.#burn({ linked, at, skeletons, total, themeKey: ORPHAN });
    }
    Object.assign(base, {
      stored: out.stored,
      verdict: out.verdict,
      reason: out.reason,
      key: out.key,
      judgment: out.judgment,
      because: out.because,
      becauseIds: out.becauseIds ?? [],
      becauseNote: out.becauseNote ?? [],
      dropped: out.dropped,
      droppedWhy: out.droppedWhy ?? {},
      droppedKind: out.droppedKind ?? {},
      bones: out.bones,
      settled: out.settled ?? base.settled ?? null,
      // 回执：模型这次确实被问过（火炉的 synthCalls 涨了），并且把翻转结果原样带出去。
      modelCalled: true,
      retired: out.retireReceipt?.retired ?? [],
      retiredBecause: out.retireReceipt?.retiredBecause ?? {},
      retireReceipt: out.retireReceipt ?? null,
      themeSource: out.judgment?.themeSource ?? null,
      inconsistent: out.inconsistent ?? null,
    });
    return base;
  }

  /**
   * 窗口里的材料碰到哪些现役判断。
   * 两路都算碰得上：骨架重合（同一件事换了说法），或模型这次自己指认了某一条。
   * 只靠字面重合的话，陌生说法永远碰不上——那本该由模型判断，不该由内核按字面判。
   */
  #matchThemes(skeleton, resolved) {
    if (resolved) {
      const hit = this.store.get(resolved);
      if (hit && hit.alive) return [hit];
    }
    if (!skeleton) return [];
    return this.store.all.filter((b) => b.alive && touches(b, skeleton));
  }

  /** 窗口里攒的材料一起烧。这是「会想多」唯一的发生点。 */
  async #burn(hint = {}) {
    // linked：这条经历碰到的唯一一条现役判断；没有就是孤立材料，不属于任何主题。
    const linked = hint.linked ?? null;
    const batchKey = hint.themeKey ?? ORPHAN;
    const live = this.store.all.filter((b) => b.alive);
    const absorbed = linked ? (this.store.absorbed[linked.themeKey] ?? null) : null;
    const candidates = live
      .filter((b) => !linked || b.id !== linked.id)
      .map((b) => ({
        id: b.id, themeKey: b.themeKey, relation: b.relation, text: b.text,
      }));
    const facts = {
      occupied: live.length,
      max: this.limits.max,
      oldest: this.#oldest(live),
      absorbed,
      themeKey: linked ? linked.themeKey : null,
      themeHint: null,
      subjectHint: linked?.subject ?? null,
      igniteAt: 1,
      skeletons: hint.skeletons ?? null,
      total: hint.total ?? 1,
      candidates,
    };

    this.stats.asks += 1;
    this.stats.modelCalls = (this.stats.modelCalls ?? 0) + 1;
    const beforeInconsistent = this.forge.stats.inconsistent ?? 0;
    // adopted：已经烧好、从窗口挪出来的那锅（单条试探时用），不再重复烧一次。
    const verdict = hint.adopted ?? await this.forge.render(linked, facts);
    // 核对回执：这一次模型「说的」和「给的」有没有打架（只记录，不参与判定）。
    const inconsistent = (this.forge.stats.inconsistent ?? 0) > beforeInconsistent
      ? (this.forge.lastInconsistent ?? null)
      : null;
    if (!verdict) {
      // 模型确实被调过（链是通的），只是这次输出全被挡了——如实记账，别让判据分不清是谁的错。
      this.stats.modelCalls = (this.stats.modelCalls ?? 0) + 1;
      const rejected = this.forge.lastRejected;
      const why = rejected.length ? rejected[rejected.length - 1].why : 'no_change';
      // 同一句再说一遍：结论没动，但这条判断还在，记一笔「又确认了一次」。
      if (linked && why === 'same_as_old') {
        linked.weight = Math.min(1, (linked.weight ?? 0) + WEIGHT_REINFORCE);
        linked.updatedAt = this.now();
        linked.fuseCount = (linked.fuseCount ?? 0) + 1;
        // ★ 2026-10-27 大乔裁决后删掉这里的一行：
        //     if (linked.status === STATUS.PENDING) transition(linked, STATUS.HELD);
        //   原来「同一句再说一遍」就直接把它定成 held。
        //   可**重复一遍不等于想通了**——只是又听了一遍同一句话。
        //   这条偷偷落定还绕过 #settleReady，让「会追问」永远没机会：
        //   悬案第二回来访就被它摁成 held，她再也回不了头看第三次。
        //   现在重复只加份量，不落定。落定只认 stage 前进。
        return {
          stored: true,
          verdict: 'reinforced',
          reason: '',
          key: linked.id,
          judgment: { ...toNote(linked), changed: false, change: 'reinforced' },
          because: [],
          dropped: [],
          bones: this.forge.bones(),
        };
      }
      return {
        stored: false,
        verdict: 'discarded',
        reason: why,
        key: null,
        judgment: null,
        because: [],
        dropped: [],
        bones: this.forge.bones(),
      };
    }

    const st = normalizeRelation(verdict.relation, verdict.polarity);
    // verdict 里带着这次熔出来的主题线索（priorId / 主题名），下面定主题要用
    const subjectKey = String(verdict.subject ?? '').replace(/[^\u3400-\u9fffA-Za-z0-9]/g, '').slice(0, 6);
    const hintKey = verdict.resolved ?? (st.ok ? themeKeyOf(st.relation, subjectKey) : null);
    if (!st.ok) {
      // 谓词不在闭集里：这次熔出来的东西不能落库，但「烧过这一锅」要记账。
      this.stats.absorbed += 1;
      this.store.absorb(batchKey, this.#absorbedOf(verdict, batchKey));
      return {
        stored: false,
        verdict: 'discarded',
        reason: `relation_${st.reason}`,
        key: null,
        retireReceipt: null,
        judgment: null,
        because: [],
        dropped: [],
        bones: verdict.heat,
      };
    }

    const created = { ...verdict, ...st, text: verdict.text, why: verdict.why || '感觉就是' };
    this.stats.absorbed += 1;

    // 主题键在这里才成立：relation|subject，模型理解出的「关于谁、怎么着」。
    // 裁决二：她 自己认的主题优先于内核按骨架撞的结果。
    const ownKey = themeKeyOf(created.relation, created.subject);
    let current = null;
    let themeKey;
    let themeKeyFrom;
    if (verdict.themeSource === 'model' && st.resolved) {
      // ① 她自己认了这摊事：钥匙以她给的为准（themeOf 已解析成那条现役的键）。
      themeKey = st.resolved;
      current = this.store.active(st.resolved);
      themeKeyFrom = 'model';
    } else if (ownKey) {
      // ② 没自认：用这条判断自己的 relation|subject。
      //    主题是「这条判断在说什么事」，不是「它并到了哪个槽里」——
      //    沿用现役的键等于说「因为我在更新它，所以我说的就是它」，那是循环论证。
      themeKey = ownKey;
      current = this.store.active(ownKey) ?? null;
      themeKeyFrom = 'ownKey';
    } else {
      // ③ 自己的 relation|subject 都算不出来：最后才退回现役那条。
      current = linked ?? null;
      themeKey = current ? current.themeKey : null;
      themeKeyFrom = 'fallback';
    }
    this.stats.themeKeyFrom = this.stats.themeKeyFrom ?? { model: 0, ownKey: 0, fallback: 0 };
    this.stats.themeKeyFrom[themeKeyFrom] = (this.stats.themeKeyFrom[themeKeyFrom] ?? 0) + 1;
    // 记一笔来源：model = 她自己认的；skeleton = 内核按骨架撞上的；new = 全新的一摊事。
    const themeSource = themeKeyFrom === 'model'
      ? 'model'
      : (linked ? 'skeleton' : 'new');
    this.lastThemeSource = themeSource;
    if (!themeKey) {
      // 连「关于谁」都说不出：这条判断没有立场可站，不收。
      return {
        stored: false,
        verdict: 'discarded',
        reason: 'no_subject',
        key: null,
        retireReceipt: null,
        judgment: null,
        because: [],
        dropped: [],
        bones: verdict.heat,
      };
    }
    created.themeKey = themeKey;
    created.themeSource = themeSource;

    // 3) 会改自己：这次刚熔出来的那份（还没并进旧账）去核它有没有推翻旧的。
    const credible = { ...created, sources: created.sources };
    const rev = this.revision.reconsider(this.store.all, credible, {
      now: this.now(),
      sources: created.sources,
    });
    if (rev.retired.length) this.stats.retired += rev.retired.length;
    const flipped = !!current && rev.retired.includes(current.id);
    // 回执：这次到底翻了没有、翻的是谁、凭什么翻、三个 weight 各是多少。
    const retireReceipt = {
      retired: [...rev.retired],
      retiredBecause: { ...rev.retiredBecause },
      flipped,
      weight: flipped ? {
        old: current?.weight ?? null,
        next: created.weight ?? null,
        margin: created.weight != null && current?.weight != null
          ? Number((created.weight - current.weight).toFixed(3))
          : null,
      } : null,
    };

    let judgment;
    let isNew = false;
    if (current && !flipped) {
      // 同一句换着说法说，不该每次都改结论（那是流水账）；
      // 但想法真的往前走过一层了，结论必须换——这就是「会想多」和「换皮」的分界。
      // 判「往前走了」只看模型自报的 stage，不猜句式；没报就当不知道，按原规矩不换。
      const stageMoved = stageWentForward(current.stage, created.stage);
      const sameClaim = created.relation === current.relation && created.polarity === current.polarity;
      const next = {
        ...created,
        text: sameClaim && !stageMoved ? current.text : created.text,
      };
      const turn = recordTurn(current, next, { at: this.now(), via: 'synth' });
      if (stageMoved) current.stage = created.stage;
      judgment = { ...toNote(current), changed: turn.changed, change: turn.change };
    } else {
      // 新建，或者旧结论刚被自己推翻——都另起一条现役的。
      const b = this.#birth(created, themeKey);
      this.store.add(b);
      if (flipped) current.nowNote = b.text;
      judgment = {
        ...toNote(b),
        changed: true,
        change: flipped ? `revised:${current.id}` : 'born',
        ...(flipped ? { replaced: current.id } : {}),
      };
      isNew = true;
    }
    this.store.absorb(themeKey, this.#absorbedOf(created, themeKey));

    // 5) 会忘：记了新东西才回头腾地方——新建信念，或旧信念真变了。
    let faded = { dropped: [], droppedWhy: {}, droppedKind: {}, because: [], becauseIds: [], becauseNote: [], verdict: 'no_incoming', room: 0 };
    if (isNew || judgment.changed === true) {
      const incomingBelief = this.store.get(judgment.id) ?? current;
      if (incomingBelief) {
        faded = this.fade.decide(incomingBelief, this.store.all, { at: this.now() });
        if (faded.dropped.length) {
          this.stats.forgotten += faded.dropped.length;
          for (const id of faded.dropped) {
            const b = this.store.get(id);
            if (b && faded.droppedWhy[id]) b.forgottenBecause = faded.droppedWhy[id];
          }
        }
      }
    } else {
      faded.verdict = 'reinforced';
    }

    // 落定走独立那一步（#settleReady）：熔没熔成功不影响它。
    const settled = this.#settleReady(this.now());

    return {
      stored: true,
      verdict: 'stored',
      reason: '',
      key: judgment.id,
      retireReceipt,
      inconsistent,
      judgment: this.store.get(judgment.id)
        ? { ...toNote(this.store.get(judgment.id)), changed: judgment.changed, change: judgment.change }
        : judgment,
      because: faded.because,
      becauseIds: faded.becauseIds ?? [],
      becauseNote: faded.becauseNote ?? [],
      dropped: faded.dropped,
      droppedWhy: faded.droppedWhy ?? {},
      droppedKind: faded.droppedKind ?? {},
      bones: verdict.heat,
      settled,
    };
  }

  /**
   * 落定：把证据够了的悬案改成「这么想」。
   * **独立于「这一轮熔没熔出新结论」**——熔没熔成功，跟她本来就攒够了的证据无关。
   * 但它只动那一格状态：不新增判断、不走火炉、不碰 grounding。
   * @returns {object|null} 落定的那条（供回执），没有就 null
   */
  #settleReady(now = this.now()) {
    let settled = null;
    for (const b of this.store.all) {
      if (!b || b.status !== STATUS.PENDING) continue;
      // 「想明白了」的三条支撑（裁决：份量是情绪强度，支撑是逻辑成立）。
      //
      // ★ 2026-10-27 大乔裁决后改：原来这里还有一条 `rounds >= 1`
      //   （「攒过一轮就落定」）。那条是错的——**来过第二回 ≠ 想明白了**。
      //   实测：同一个悬案第 2 条相关经历进来就落定，于是
      //     · 它再也不会被「回头看第三次」（会追问整条废掉）
      //     · 落定和追问抢同一件事，跟「链挂链」同一个病
      //   「攒过一轮」只说明这件事又出现了，不说明她想通了。
      //
      //   落定只认一条真支撑：**她的想法真的往前走了**（裁决十的 stage）。
      //
      // ★ 2026-10-27 大乔裁决后改，两次：
      //   第一版靠 `rounds >= 1`（攒过一轮）——错，来过第二回 ≠ 想明白了。
      //   第二版加了「why 说得清」，拿 /拿不准|次数太少/ 去猜措辞——更错：
      //     她真实说的是「只碰到过一回，再等等看。」，我列的词一个都没命中。
      //     **拿自己想象的措辞去判断，就是错的。**
      //   第三版靠 weight>=0.5 —— 也错：weight 是「她有多在意」，
      //     实测第 2 条一更新就从 0.3 跳到 0.62，等于「在意」替「想通」把了门。
      //
      //   她真的想通了吗？唯一的证据是 stage 从 pending 走到了 understood 以上。
      //   判定悬而未决该不该落定，和判定结论该不该换，用的是同一把尺。
      const stageRank = { pending: 0, understood: 1, settled: 2, acting: 3 };
      const rank = stageRank[String(b.stage ?? 'pending')] ?? 0;
      const enough = rank >= 1;
      if (!enough) continue;
      // 只改状态。痕迹单独放 settledTrace——不碰 tension（那是「还悬着」的字段），
      // 也不碰 turns（那是「结论变了」的账）。落定不产生结论，就不该记一笔账。
      b.settledTrace = {
        at: now,
        revisits: (b.settledTrace?.revisits ?? 0) + 1,
        why: b.tension?.why ?? '这回又碰上了',
      };
      transition(b, STATUS.HELD, { at: now });
      settled = { id: b.id, from: STATUS.PENDING, to: STATUS.HELD, why: '证据够了，不必再悬着' };
    }
    return settled;
  }

  #absorbedOf(verdict, themeKey) {
    return {
      text: verdict.text,
      relation: verdict.relation ?? null,
      polarity: verdict.polarity ?? null,
      themeKey,
      weight: verdict.weight ?? 0,
      at: this.now(),
    };
  }

  /** 追到限度还没落判：替她认了。这不是遗忘，是判断落不下来时给自己一个交代。 */
  #abandon(b) {
    transition(b, STATUS.ESTEEMED, {
      at: this.now(),
      reason: ABANDON_REASON,
      kind: RETIRE_REASON.ABANDONED,
    });
    b.curiosityFired = b.curiosityFired ?? 0;
    this.stats.abandoned += 1;
    return b;
  }

  #birth(created, themeKey) {
    const b = new Belief({
      themeSource: created.themeSource ?? 'new',
      themeKey,
      subject: clean(created.subject ?? '这摊事', 40),
      relation: created.relation,
      polarity: created.polarity,
      text: created.text,
      why: created.why,
      weight: created.weight,
      // 模型自报的两样元数据也要跟着落库：这是「她说的」不是「我猜的」。
      stage: created.stage ?? null,
      kind: created.kind ?? null,
      at: this.now(),
      via: 'synth',
    });
    // 一份判断出世，先悬着还是直接定下来，看她自己说到哪一层。
    //
    // ★ 2026-10-27 大乔裁决后改：原来是「这一锅材料凑够 2 条就 held」。
    //   那和 #burn 里删掉的「同一句再说一遍就 held」是同一个病：
    //   **拿材料的数量冒充想通的证据。**
    //   实测：同一件事第 2 条相关经历进来就被摁成 held，
    //   悬案消失 → 她再也没机会回头看一眼 → 「会追问」整条废掉。
    //
    //   现在只认她自己说的 stage：
    //     说 pending（还看不透）  → 继续悬着，留 tension
    //     说 understood 以上      → 才落定
    //   落定该由「想通了没有」决定，不由「攒够几条」决定。
    const bornStage = ['understood', 'settled', 'acting'].includes(String(created.stage ?? ''));
    if (!bornStage) setTension(b, { since: this.now(), why: '才碰上一条，不下结论' });
    else transition(b, STATUS.HELD, { at: this.now() });
    return b;
  }

  #oldest(live) {
    let best = null;
    for (const b of live) if (!best || b.updatedAt < best.updatedAt) best = b;
    return best;
  }

  snapshot() {
    const s = this.flash.snapshot();
    return { ...s, seed: this.seed, heat: this.forge.pending };
  }

  recall(query) {
    return this.flash.recall(query);
  }

  pendingQuestions() {
    return this.flash.pendingQuestions();
  }

  digest() {
    return this.flash.digest();
  }

  notes() {
    return this.store.all.map(toNote);
  }

  // ── 给宿主端用的两个门面 ──────────────────────────────────────
  //
  // ★ 2026-10-27 大乔补：`digest-session.mjs` 的 `digestSession()` 和
  //   `world.mjs` 的 `renderWorld()` 早就写好了，插件壳也早就照它们写，
  //   可 `Mind` 上**从来没把这两样接出来**——宿主要用的时候拿到 undefined。
  //
  //   这是「两边都写完了、没接上」的第五次。以后加模块，记得同一件事：
  //   **写完不算完，得有人能叫得到它。**

  /** 归档熔：一段会话整段进来，产出的判断直接落库（不再过火炉）。 */
  async digestSession(messages, opts = {}) {
    const result = await runDigest(messages, { synth: this.synth, ...opts });
    if (!result || !Array.isArray(result.judgments) || result.judgments.length === 0) {
      return { judgments: [], committed: false, reason: result?.reason ?? 'nothing_to_digest' };
    }
    await commitDigest(this, result, { at: this.now() });
    // 归档熔出来的是她**这辈子第一批真正意义上的记忆**，必须当场落盘。
    this.persist();
    return { ...result, committed: true };
  }

  /** 她这一轮「看得见的世界」——只有她自己的判断，没有被人的聊天记录。 */
  world(opts = {}) {
    try {
      const out = renderWorld(this.store.all, { name: this.personaName ?? '', ...opts });
      // renderWorld 给的是 { seen, mood, recalled, lines, text, surface }，
      // 拼进提示词要字符串，用它的 text（surface 是给 Surface 遮蔽用的行数组）。
      return typeof out?.text === 'string' ? out.text : '';
    } catch {
      return '';
    }
  }

  /** 她这一轮看得见的那些行（给 Surface 遮蔽用，一行一句）。 */
  worldLines(opts = {}) {
    try {
      const out = renderWorld(this.store.all, { name: this.personaName ?? '', ...opts });
      return Array.isArray(out?.surface) ? out.surface : [];
    } catch {
      return [];
    }
  }

  /** 名字。只读它——裁决八：名字之外，输出的每个字都必须来自判断库。 */
  get name() {
    return this.personaName ?? '';
  }
}

/** 一张表。真正让位归 fade 管，这里只防内存涨爆，且不动现役条目。 */
export class Store {
  constructor({ max = 10 } = {}) {
    this.max = max;
    this.list = [];
    this.absorbed = {};
  }

  get all() {
    return this.list;
  }

  get(id) {
    return this.list.find((b) => b.id === id) ?? null;
  }

  add(b) {
    this.list.push(b);
    return b;
  }

  active(themeKey) {
    if (!themeKey) return null;
    return this.list.find((b) => b.themeKey === themeKey && b.alive) ?? null;
  }

  absorb(themeKey, item) {
    this.absorbed[themeKey] = item;
  }

  /** 旧的那条已经不说话了：它留在表里，只是让开现役的位置。 */
  demote(belief) {
    if (!belief) return;
    belief.demoted = true;
  }
}

export async function createMind(opts = {}) {
  return new Mind(opts);
}

export { PREDICATES, STATUS, clause, toNote };
