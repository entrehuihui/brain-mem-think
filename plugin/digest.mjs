/**
 * digest.mjs —— 增量熔 + 整段遮蔽。`index.mjs` 拆出来的第一块。
 *
 * ======================= 为什么要拆 =======================
 *
 * `plugin/index.mjs` 2675 行、31 条踩坑里 20 条出自它，是整份代码最大的单点风险。
 * 可它不能"顺手拆"——拆之前得先知道**拆完靠什么保证还是只有一个出口**。
 *
 * 所以顺序是：**先钉契约，再拆**。
 *
 *   ① `acceptance/i_single_exit.mjs` 的扫描面从 `['src']` 扩到 `['plugin','src']`
 *      —— 原来它守着 src，而真正的出口在 plugin/wake-exit.mjs，等于守着空城。
 *   ② 顺手拔掉 `src/wake.mjs` 里那颗第二出口的雷（`wakeOnce` 里那句 followup）。
 *   ③ 才开始拆。
 *
 * 这一块拆出来，是因为它**已经是纯逻辑了**：一段闭包，只靠三样外界的东西——
 * 一个 `ctx.get`、一个 trace、一组路径和几个小工具。把这三样变成显式参数，
 * 它就不再需要知道自己在哪个插件里跑。
 *
 * ======================= 它守的两条不变量 =======================
 *
 *   ① **空熔不推进游标。** 模型回了空（too_little / nothing_usable），
 *      那几句原话既没进记忆、也不该被遮住——下一跳带上新话一起重熔。
 *      代价是模型可能被同一批多问一次，比「悄悄丢掉主人说的话」便宜得多。
 *   ② **熔成了才遮。** 只熔不遮，她下一轮仍然拿原文当上下文，
 *      「一次对话 = 一次融合」就只做了一半。
 *
 * 这两条原来都是**线上踩出来的**，注释跟着代码一起搬过来了——
 * 它们比代码本身值钱，删注释等于把坑重新挖开。
 */

/**
 * @param {object} deps
 * @param {() => string|null} deps.channelSessionId  当前通道会话 id（可变：能在配置里覆盖）
 * @param {() => object|null} deps.sessions   取宿主 sessions 服务
 * @param {() => object|null} deps.agents     取宿主 agents 服务
 * @param {string} deps.cursorPath            digest-cursor.json
 * @param {string} deps.storePath             wake.json（markFresh 用）
 * @param {(event:string, extra?:object) => void} deps.trace
 * @param {(path:string, why:string) => void} deps.markFresh
 * @param {(msgs:any[]) => any[]} deps.ownerMessages
 * @param {(msgs:any[]) => any[]} deps.conversationTurns
 * @param {Function} deps.sliceFresh
 * @param {Function} deps.readCursors
 * @param {Function} deps.writeCursor
 * @param {Function} deps.compactChannel      遮蔽（由调用方注入，避免循环依赖）
 * @param {()=>void} deps.onOwnerMessage      看到主人新话时回调（更新 lastOwnerMessageAt）
 * @param {object} [opts]
 */
export function createDigest(deps, opts = {}) {
  const {
    channelSessionId, sessions, agents, cursorPath, storePath,
    trace = () => {}, markFresh = () => {},
    ownerMessages, conversationTurns, sliceFresh, readCursors, writeCursor,
    compactChannel, onOwnerMessage = () => {},
  } = deps;

  /** 被 agent-busy 挡下时记「欠了多久」。0 = 没欠。 */
  let digestDebtAt = 0;
  /** 防抖：别每跳都去撞模型。 */
  let lastChannelDigestAt = 0;
  /** 同一批材料熔空了——记住是哪一批、什么时候空过。 */
  let lastEmptyDigestBatch = '';
  let lastEmptyDigestAt = 0;
  const EMPTY_DIGEST_COOLDOWN_MS = Number(opts.emptyDigestCooldownMs ?? 10 * 60 * 1000);

  /**
   * 看一眼她那条通道有没有新的主人消息，有就只熔新增那几条。
   *
   * @param {object} mindInst 内核
   * @param {{fromTurnEnd?:boolean}} [opt] 是不是从 turn/end 钩子进来的
   */
  const digestChannelIncrement = async (mindInst, opt = {}) => {
    const CID = channelSessionId();
    // ★ 2026-10-27 加（必须）：**她正在跑的时候不许动她的会话**。
    //
    //   compact 是一次 `session.append`，会在会话里插一条消息。要是插在她
    //   正跑着一轮（尤其是刚发完 tool-call、还没等到 tool/result）的中间，
    //   「工具调用和结果对不上」这类错就会跟着来——网关直接 400，这条会话报废。
    //   她今晚那条就是这么报的（turn 45）。
    //
    //   所以只在 idle 时动手。忙就等下一跳，记忆不会丢。
    //   —— 但 turn/end 那一刻例外，见下面 opt.fromTurnEnd 的说明。
    if (!opt.fromTurnEnd) {
      const busyAgent = (() => {
        try {
          const a = typeof agents === 'function' ? agents()?.get?.(CID) : null;
          return a?.status && a.status !== 'idle' ? a.status : null;
        } catch { return null; }
      })();
      if (busyAgent) {
        // ★ 2026-10-28 18:35 / 18:55 修（line 1264 那处同样修，一条不许留）：
        //
        //   实测近 15 分钟 30 次 tick 全被这条挡下（why:agent-busy 30/30），
        //   而这 15 分钟里 `turn-end-hook` 一次都没出现——
        //   也就是说 turn/end 那条"权威信号"这条路当天是断的，
        //   于是每一条 tick 都撞在这道闸上，熔一次都没跑。
        //
        //   记忆不会因为晚几分钟丢，但**晚几个小时就等于丢**。
        //
        //   ★ 更要紧的一层（2026-10-28 18:55 想通的）：
        //     藏着她当前情况的那段**系统提示**，是每一轮都重新取的。
        //     熔进来的新经历要能被读到，得等**下一轮**。
        //     而如果这一轮一直不结束，「下一轮」就永远不会来——
        //     熔了也读不到，读不到就没有任何迹象能证明熔过。
        //     这是一个环：忙 → 不熔 → 提示不变 → 永远还是那句旧情况。
        //
        //   所以欠账不是"晚点做"，是**等它一空立刻就做**。
        const stamp = Date.now();
        if (!digestDebtAt) digestDebtAt = stamp;
        trace('channel-digest-skip', { why: 'agent-busy', status: busyAgent, debtMs: stamp - digestDebtAt });
        return;
      }
      if (digestDebtAt) {
        trace('channel-digest-debt-settled', { waitedMs: Date.now() - digestDebtAt });
        digestDebtAt = 0;
      }
    } else {
      trace('channel-digest-from-turn-end', { skipIdleGate: true });
    }

    // ★ 2026-10-27 大乔修（又一次「不报错、也不做」）：
    //   这里原本有四处静默 return，任何一处命中都表现为「日志里什么都没有」，
    //   看着像它根本没跑。实测重启后两分钟日志里一句 channel-digest 都没有，
    //   我只能在四个可能之间猜。
    //   现在每处都留一行 trace，原因写清楚——下次不用猜。
    if (!CID || !mindInst) {
      trace('channel-digest-skip', { why: 'no-channel-or-mind', hasChannel: !!CID, hasMind: !!mindInst });
      return;
    }
    const now = Date.now();
    if (now - lastChannelDigestAt < 15_000) return; // 防抖：别每跳都去撞模型
    const sessionsSvc = typeof sessions === 'function' ? sessions() : null;
    const session = sessionsSvc?.get?.(CID);
    if (!session || typeof session.deriveMessages !== 'function') {
      trace('channel-digest-skip', { why: 'no-live-session', hasSessions: !!sessionsSvc, hasSession: !!session });
      return;
    }
    const owners = ownerMessages(session.deriveMessages());
    if (!owners.length) {
      trace('channel-digest-skip', { why: 'no-owner-messages' });
      // ★ 唤醒轮：这一轮没有主人的话要熔，但 surface 上还留着她自己的唤醒词和回话。
      //   它们不是记忆材料，下一轮也不该带着——turn/end 这一路直接遮掉。
      //
      // ★ 2026-10-28 实测（`compact-failed: session append cannot reenter while
      //   another append is being published`）：turn/end 事件本身正在被宿主发布，
      //   **同步** append 会被拒。所以这一刀必须挪出事件栈，等发布完再下。
      if (opt.fromTurnEnd) {
        setTimeout(() => {
          try { compactChannel(session, mindInst, { full: true }); } catch (err) {
            trace('compact-deferred-failed', { err: String(err?.message ?? err).slice(0, 140) });
          }
        }, 1200);
      }
      return;
    }
    // ★ 2026-10-28（阶段 F）：主人在说话，时钟往前走。她这十分钟不许出门。
    onOwnerMessage();
    // ★ 2026-10-28：主人说了话 = 有新东西 → 冷却让路
    markFresh(storePath, 'owner-message');

    const cursors = readCursors(cursorPath);
    const { fresh, total, reset, cursor } = sliceFresh(owners, cursors[CID] ?? 0);
    // ★ 2026-10-28 18:20（止血·空转 digest）：
    //
    //   实测：同一批 fresh 只要熔出 0 条，cursor 就不推进（这条规矩是对的，
    //   否则主人的话会被悄悄吞掉）；可**没有冷却**，于是每一拍都拿同一批话
    //   再问模型一次，模型每次都给空——09:24 到 09:30 连着七次，
    //   fresh 从 3 一路涨到 9，一个字没进库，模型白烧七次。
    //
    //   规矩里那条「宁可重复一次也不漏」指的是**换了材料**再试一次，
    //   不是**同一批材料每分钟重问一次**。同一批材料反复给空，
    //   说明这段材料确实熔不出东西——认了，等新话进来再审。
    const batchKey = `${total}:${reset ? 'r' : ''}`;
    if (batchKey === lastEmptyDigestBatch && now - lastEmptyDigestAt < EMPTY_DIGEST_COOLDOWN_MS) {
      trace('channel-digest-skip', {
        why: 'same-batch-empty',
        total,
        waitMs: EMPTY_DIGEST_COOLDOWN_MS - (now - lastEmptyDigestAt),
      });
      return;
    }
    if (!fresh.length) {
      // 没新话可熔。
      //
      // ★ 2026-10-28（可见即未熔）：之前熔过（cursor > 0）却还有可见的主人原文，
      //   说明它那条遮蔽当时没成——这一跳补遮掉，别让它一直挂在她上下文里。
      //   从没熔过（cursor = 0）就一个字都不遮：材料还没进记忆，遮了等于吞掉你的话。
      if (cursor > 0) {
        const shadowed = compactChannel(session, mindInst, { full: true });
        if (shadowed) writeCursor(cursorPath, CID, 0);
      } else trace('channel-digest-nothing', { total, cursor });
      return;
    }

    lastChannelDigestAt = now;
    trace('channel-digest-start', { fresh: fresh.length, total, reset });
    try {
      // ★ 2026-10-28 18:30（熔完必落盘 · 线上取证）
      //
      //   09:52–10:04 线上那十次，日志是这样的：
      //     channel-digest-start → channel-digest-done{reason:nothing_to_digest}
      //   **中间一次 synth-reply 都没有**——模型压根没被问到。
      //   同一时段她「要不要开口」那一问又正常回了 180/192 字。
      //   也就是说：「10 批主人原话熔不出一个字」这句话，之前是**猜的**，
      //   真相是**根本没熔**。
      //
      //   所以这一圈必须留字：材料进了多少、模型原话多长、扔到哪个 reason。
      //   不留这两行，next 一轮还会有人（包括我）对着一个空结论编原因。
      const materialChars = fresh.reduce((n, x) => n + String(x?.text ?? '').length, 0);
      trace('channel-digest-material', { fresh: fresh.length, chars: materialChars });
      if (!mindInst?.synth) {
        trace('channel-digest-skip', { why: 'no-synth', hasMind: !!mindInst });
        return;
      }
      // ★ 2026-10-29 主人改口径：她自己的回应也要进材料。
      //   跟归档那条路同一套做法——游标仍只数主人消息，喂进去的是整段对话尾部。
      let feed = fresh;
      try {
        const conv = conversationTurns(session.deriveMessages?.() ?? []);
        const firstFresh = fresh[0]?.text ?? '';
        let at = -1;
        for (let i = conv.length - 1; i >= 0; i -= 1) {
          if (conv[i].role === 'user' && conv[i].text === firstFresh) { at = i; break; }
        }
        if (at >= 0) feed = conv.slice(at);
      } catch (err) {
        trace('channel-digest-conv-failed', { err: String(err?.message ?? err).slice(0, 140) });
      }
      trace('channel-digest-feed', { fresh: fresh.length, feed: feed.length });
      const out = await mindInst.digestSession(feed);
      trace('channel-digest-result', {
        judgments: out?.judgments?.length ?? 0,
        episodes: out?.episodes?.length ?? 0,
        reason: out?.reason ?? null,
        committed: !!out?.committed,
      });
      // ★ 2026-10-27 大乔修（漏熔）：**空熔不推进游标**。
      //
      //   原来这里无条件 writeCursor(total)——只要模型回了个空（too_little /
      //   nothing_usable），那几句原话就既没进记忆、也不再被遮住重熔，
      //   下一跳直接跳过它们。实测 10:31 那一次 fresh=1 → too_little(cursor 已推)，
      //   那句话从此没有任何机会进记忆。
      //
      //   现在：熔出东西才推进；熔空了 ← 配合 compactChannel 的 DIGEST_KEEP_SEQS，
      //   那几句仍在可见上下文里，下一跳会带上它们（连同新话）一起重熔。
      //   代价是模型可能被同几句话多问一次——比「悄悄丢掉主人说的话」便宜得多。
      const n = out?.judgments?.length ?? 0;
      const eps = out?.episodes?.length ?? 0;
      if (n > 0 || eps > 0) {
        writeCursor(cursorPath, CID, total);
      }
      // ★ 2026-10-28 18:20（止血·空转 digest）：这一批熔空了，记住它是哪一批、什么时候。
      //   同一批材料在冷却期内不再重问——见上面 lastEmptyDigestBatch 那段说明。
      if (n === 0 && eps === 0) {
        lastEmptyDigestBatch = batchKey;
        lastEmptyDigestAt = now;
      } else {
        lastEmptyDigestBatch = '';
      }
      if (n > 0 || eps > 0) markFresh(storePath, 'digest');
      trace('channel-digest-done', {
        fresh: fresh.length,
        total,
        judgments: n,
        episodes: eps,
        rawEpisodes: out?.rawEpisodes ?? null,
        reason: out?.reason ?? null,
        // ★ 2026-10-28 18:20 修：原来写的是 `n > 0`——判断为空、经历却有的时候
        //   游标其实推进了，日志却报 false。证据行报假，比不报更坏。
        cursorAdvanced: n > 0 || eps > 0,
      });
      // ★ 熔完立刻整段遮蔽：下一轮模型只看见「系统提示 + 一条记忆」，原文一条不留。
      //   这一步才是「一次对话 = 一次融合」的后半句——只熔不遮，
      //   她下一轮仍然在拿原文当上下文。
      //
      // ★ 2026-10-28（经历层）：只熔出一件「事」、没有新判断的那一轮，也算熔过了。
      //   材料已经被用掉（进了经历），不推进游标、不遮蔽，下一跳会把同一段话
      //   再问一遍模型——而且它还是会「熔出 0 条」，永远卡在这段材料上。
      if (n > 0 || eps > 0) {
        const shadowed = compactChannel(session, mindInst, { full: true });
        // ★ 水位归零：遮掉之后，可见的主人消息就是「还没熔的」，
        //   条数水位必须跟着归零，否则下一次会拿旧水位去切新列表、把新话漏掉。
        if (shadowed) writeCursor(cursorPath, CID, 0);
      }
    } catch (err) {
      // 抛错也不推进游标 —— cursor 只在「真的熔成了」时前进。
      trace('channel-digest-failed', { err: String(err?.message ?? err).slice(0, 160) });
    }
  };

  return {
    digestChannelIncrement,
    /** 只读：她现在还欠着多久的账（测试 / 看板用）。 */
    debt() {
      return digestDebtAt ? { since: digestDebtAt, ms: Date.now() - digestDebtAt } : null;
    },
  };
}
