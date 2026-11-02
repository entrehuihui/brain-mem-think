/**
 * wake-loop.mjs —— 「她每一拍醒来干什么」。`index.mjs` 拆出来的第二块。
 *
 * ======================= 为什么是这一块 =======================
 *
 * 原来 `tick` 一个函数 364 行，里面塞了七件事：
 * 挂钩子 → 补开门 → 熔 → 工具观测 → 归纳 → 联想 → 扎心度 → 醒来 → 说/做/歇。
 *
 * 这七件事彼此**没有共享状态**（除了「这条链还活着」这件事本身），
 * 所以它是可拆的。可拆归可拆，拆之前得先认一件事：
 *
 *   **这一块几乎全是「踩出来的」，注释比代码值钱。**
 *
 * 所以拆的时候，注释一行没删、一行没简化——挪位置可以，改历史不行。
 *
 * ======================= 它真正守的三条 =======================
 *
 * ① **每跳至少留一行**（tick-alive）。没有心跳，「tick 没跑」和「跑了但什么都没做」
 *    长得一模一样，上一回为此猜了整整一下午。
 *
 * ② **续链不依赖 tick() 的返回值**。链条是 `tick().finally(schedule)`，
 *    只要 tick 里有一个 await 永不 resolve，finally 就永远不执行，
 *    **整条链静默死掉**（实测 14:05–14:10 停摆 296 秒，零日志）。
 *    所以：硬超时 + finally 续链 + 保命定时器绝不 unref。
 *
 * ③ **pokeWake 必须走 next()**，不许直接调 tick()。
 *    绕过 next 就不会重新排队，两跳并发时只要有一跳卡住，链就再也没人接。
 *
 * ======================= 依赖怎么给的 =======================
 *
 * 跟 digest.mjs 同样的口径：**取值函数，不是取值**。
 * `CHANNEL_SESSION_ID` 是 `let`，配置里能覆盖，传值会在覆盖之后变成旧的。
 */

/**
 * @param {object} deps
 * @param {object} deps.cfg                配置
 * @param {object} deps.ctx                插件 ctx（要 .get / .logger / .effect / [TURN_HOOK]）
 * @param {Function} deps.trace
 * @param {()=>string|null} deps.channelSessionId
 * @param {()=>object|null} deps.agentsSvc
 * @param {()=>object|null} deps.sessionsSvc
 * @param {()=>object|null} deps.workspaceRegistry
 * @param {()=>object|null} deps.getSynth   当前合成器（可能是 null）
 * @param {Function} deps.digestChannelIncrement
 * @param {Function} deps.adoptInduced
 * @param {Function} deps.tryAct
 * @param {Function} deps.ensureMind
 * @param {Function} deps.armTurnHook
 * @param {Function} deps.applyWake
 * @param {Function} deps.planWake
 * @param {Function} deps.readWake
 * @param {Function} deps.readMotive
 * @param {Function} deps.observeTools
 * @param {Function} deps.speakToOwner
 * @param {string} deps.storePath
 * @param {string} deps.motivePath
 * @param {string} deps.outboxPath
 * @param {string} deps.toolCursorPath
 * @param {string} deps.sawPath
 * @param {Symbol} deps.TURN_HOOK
 * @param {(path:string,why:string)=>void} deps.markFresh  （保留：调用方可能要用）
 */
export function createWakeLoop(deps) {
  const {
    cfg, ctx, trace = () => {},
    channelSessionId, agentsSvc, sessionsSvc, workspaceRegistry,
    digestChannelIncrement, adoptInduced, tryAct, ensureMind, armTurnHook,
    applyWake, planWake, readWake, readMotive, observeTools,
    storePath, motivePath, outboxPath, toolCursorPath, sawPath, TURN_HOOK,
    // 文件 IO 由调用方给——内核可以零 IO，这一层不该偷偷带一份进来。
    fs,
  } = deps;

  let timer = null;
  let stopped = false;
  let inFlight = false;   // 同一时刻只许一跳在跑
  // 「还在睡」那条日志的节流标记：tick 一分钟一次，不节流会把日志冲烂。
  let lastSleepTraceAt = 0;
  // 开门的重试节流：失败后别每分钟都撞一次。
  let lastResumeTryAt = 0;
  // 第一跳必记一行：用来区分「定时器压根没跑」和「跑了但静默失败」。
  let ticks = 0;
  let lastAssociateAt = 0;
  let lastStingTraceAt = 0;

  /**
   * 「她出门那一趟」还在不在进行中。
   *
   * 判据：偏好账里有 pending，且是 15 分钟内的事。
   * 只在 `observeTools` 那一段用到——决定「这一次工具调用算不算她自己的经历」。
   */
  const actInFlight = () => {
    try {
      const act = readMotive(motivePath);
      return !!act.pending && Date.now() - Number(act.pending.at ?? 0) < 15 * 60e3;
    } catch { return false; }
  };

  const tick = async () => {
    const CID = channelSessionId();
    ticks += 1;
    if (ticks === 1) trace('wake-tick-first', { everyMs: cfg.wakeEveryMs ?? null, tickMs: cfg.wakeTickMs ?? null });
    // ★ 2026-10-28（tick 停摆）：每跳至少留一行。
    //   上了心跳才分得清「tick 没跑」和「tick 跑了但什么都没做」——
    //   14:05 那次停了 296 秒，日志里一片空白，只能猜。以后再不会了。
    trace('tick-alive', { n: ticks });
    // ★ 2026-10-28 修（钩子会漏挂）：turn/end 的钩子原来只在 kick() 里挂一次，
    //   而 kick 挂在 `ctx.inject([...])` 的回调上——实测重载之后
    //   `channel-ready` 打了、`turn-hook-armed` 一条都没有，
    //   于是「回完话立刻熔」静默退化回 tick 每分钟兜底。
    //   现在每一跳都核一次：印章上的会话不是当前这条，就补挂。
    //   幂等：同一会话重复调用会走 `turn-hook-already` 直接返回。
    try {
      if (ctx[TURN_HOOK]?.id !== CID) armTurnHook();
    } catch (err) {
      trace('turn-hook-failed', { err: String(err?.message ?? err).slice(0, 160) });
    }
    try {
      // ★ 每分钟看一眼她在不在。不在就（节流后）去开门。
      //
      //   为什么要在 tick 里补：ensureChannel 只在启动 5 秒后跑一次。
      //   那一次如果碰上 persistence 还没就绪、或者宿主刚重启状态没稳，
      //   resume 就会失败——而失败之后**再没有任何人尝试第二次**，
      //   她就一直躺在那儿，唤醒想说话也只有 no-agent。
      //   五分钟重试一次，够了；成功之后 agents.get() 有值，这里直接跳过。
      const nowTick = Date.now();
      const agents = agentsSvc();
      if (CID && deps.ensureChannelAgent && !agents?.get?.(CID)) {
        if (nowTick - lastResumeTryAt > 5 * 60e3) {
          lastResumeTryAt = nowTick;
          void deps.ensureChannelAgent().then((a) => {
            if (a) process.stderr.write('mind: 门开了，她在里面\\n');
          }).catch(() => {});
        }
      }

      const m = await ensureMind();

      // ★ 2026-10-27 加（主人定的核心机制）：**每一轮对话都熔进记忆**。
      //
      //   他要的不是「聊天记录越积越长」，而是：
      //     记忆₀ + 你的话₁ → 记忆₁
      //     记忆₁ + 你的话₂ → 记忆₂
      //   上一轮熔出来的东西就是下一轮的上下文。这样聊天才像跟人脑说话。
      //
      //   做法：每 60 秒看一眼她那条会话有没有**新的主人消息**（cursor 记账），
      //   有就只熔新增那几条。collect.mjs 保证只收 source.kind=user 的，
      //   她自己的回话永远进不来（否则她会越说越确信）。
      await digestChannelIncrement(m);

      // ★ 2026-10-28（阶段 D）：把「她做过什么、成没成」增量记进账本。
      //
      //   她本来就看得见（工具 + 识图都在），但 `collect.mjs` 的白名单
      //   只认主人说的话，工具结果一条都进不了熔的材料——所以她看见了不算数。
      //   这一行接上之后，她第一次有了「判断之外」的观测。
      try {
        const sess = sessionsSvc()?.get?.(CID) ?? null;

        // ★ 2026-11-02 小乔加（把 saw 真正接上）：
        //   `duringAct` 原来是「出门那一趟」的标记，只喂给 observeTools；
        //   现在有 saw 了——**她亲手看过的东西只在那一段才算数**，
        //   所以同一个标记也要传给它，别在平常帮主人干活时把「我读过」记成经历。
        if (sess) {
          const duringAct = actInFlight();
          const ob = observeTools({
            session: sess,
            mind: m,
            cursorPath: toolCursorPath,
            sessionId: CID,
            duringAct,
            // ★ target：这一次出门是为了哪条判断。不知道就 null——
            //   宁可在 unverifiedOf() 那边被当成「顺手看了一眼」，也不假装核实过。
            sawPath,
            target: null,
          });
          if (ob.added || ob.runs || ob.saws) trace('tool-observe', ob);
        }
      } catch (err) {
        trace('tool-observe-failed', { err: String(err?.message ?? err).slice(0, 120) });
      }

      // ★ 2026-10-28（阶段 C·D）：内核数出来的判断，收进库。
      //   放在工具观测之后：这样这一跳新记的观测也能进归纳。
      try { await adoptInduced(m); } catch (err) {
        trace('adopt-failed', { err: String(err?.message ?? err).slice(0, 120) });
      }

      // ★ 2026-10-28（阶段二·联想）：醒着的时候，把两件旧事摆在一起。
      //   这是 novel 唯一的来源——在这之前，内核数出来的东西全是从判断倒推的，
      //   模型给过什么她才想得到什么。现在原料换成经历，她才有机会「自己发现」。
      //   节流 10 分钟一次：联想不是每跳都该干的事，两件旧事也不会一分钟变一次。
      try {
        const every = Math.max(60_000, Number(cfg.associateEveryMs ?? 10 * 60_000));
        const last = Number(lastAssociateAt ?? 0);
        if (cfg.associate !== false && Date.now() - last >= every) {
          lastAssociateAt = Date.now();
          const r = await m.associate();
          if (r.tried) trace('associate-done', r);
        }
      } catch (err) {
        trace('associate-failed', { err: String(err?.message ?? err).slice(0, 140) });
      }

      // ★ 2026-10-28（阶段三）：扎心度的心跳。
      try {
        if (Date.now() - lastStingTraceAt >= 600_000) {
          lastStingTraceAt = Date.now();
          const top = [...(m.store.list ?? [])].sort((a, b) => (Number(b.sting) || 0) - (Number(a.sting) || 0))[0];
          trace('sting-top', {
            id: top?.id ?? null,
            sting: Number(top?.sting ?? 0),
            epic: Array.isArray(m.episodes) ? m.episodes.length : 0,
            text: String(top?.text ?? '').slice(0, 28),
          });
        }
      } catch (err) {
        trace('sting-failed', { err: String(err?.message ?? err).slice(0, 120) });
      }

      const state = readWake(storePath);
      // ★ 2026-10-28（换屋死锁）：从她的会话里数出「这间屋子跑过几轮」。
      //
      //   宿主侧栏的规则是 blank（一个 turn 都没有）且不是当前会话 → 隐藏。
      //   所以「一间还没跑过 turn 的新屋子」是唯一需要给她开场许可的时机。
      //   数不出来（拿不到会话事件）就传 null，那不给她开场许可 —— 宁可不说，
      //   也不要在旧屋子里反复催她打招呼。
      let roomTurns = null;
      try {
        const chSess = sessionsSvc()?.get?.(CID) ?? null;
        const evs = chSess?.events;
        if (Array.isArray(evs)) roomTurns = evs.filter((e) => e?.type === 'turn/start').length;
        else if (evs && typeof evs.values === 'function') roomTurns = [...evs.values()].filter((e) => e?.type === 'turn/start').length;
      } catch { roomTurns = null; }
      const plan = await planWake({
        mind: m, state, now: Date.now(), cfg, synth: deps.getSynth() ?? null, ctx: { roomTurns },
      });

      // ★ 2026-10-27 大乔修（死锁）：没到点就**什么都不写**。
      //
      //   原来这里无论 plan 是什么都 applyWake，而 applyWake 会把 lastWakeAt
      //   推成 now —— 于是「距上次醒来」永远只有 wakeTickMs，而 gap 是 35~75 分钟，
      //   `now - lastWakeAt < gap` 恒成立，**她永远到不了时候**。
      //   实测账本 20 条全是「还不到时候」、间隔正好 600 秒、lastSpokeAt 恒为 0。
      //
      //   不写，lastWakeAt 就停在上一次真醒的那一刻；过了 gap 自然醒来。
      if (!plan.woke) {
        // ★ tick 是每分钟一次，这里不能每分钟写一行——一天 1440 行会把日志冲烂。
        //   半小时记一次「还在睡」就够看出心跳了。
        if (Date.now() - lastSleepTraceAt > 30 * 60e3) {
          lastSleepTraceAt = Date.now();
          trace('wake-sleep', { gap: plan.gap ?? null, since: plan.sinceLastWakeMs ?? null });
        }
        return;
      }

      const agents2 = agentsSvc();
      if (plan.action !== 'speak') {
        // ★ 2026-10-28 19:20（补发·把欠了的那句话还回去）
        //
        //   上一刀只做了「留」：没送出去的真心话存进 outbox.json。
        //   可留了不还，等于换了个地方丢。
        //
        //   这一拍如果她本来不想说话、屋里也没人动过、也没到别的事上，
        //   就把那句欠着的先还上——**人不会把攒了很久的一句话改天再讲一遍。**
        //
        //   条件拿得很死（宁可不还，也不许乱还）：
        //     · outbox 里有东西，且不超过 2 小时（再久，那句话的时机已经死了）
        //     · 账本指纹没变（她这会儿没想出新东西，才轮得到旧话）
        //     · 别在她刚说过话之后紧接着还——
        //       那两句会撞成"一口气说两句"，比她少说一句更吓人。
        try {
          const { existsSync, readFileSync, unlinkSync } = fs;
          if (existsSync(outboxPath)) {
            const box = JSON.parse(readFileSync(outboxPath, 'utf8'));
            const age = Date.now() - Number(box?.at ?? 0);
            const quietEnough = !state.lastSpokeAt || Date.now() - Number(state.lastSpokeAt) > 30 * 60e3;
            if (box?.say && age >= 0 && age < 2 * 3600e3 && quietEnough && box.ledger === plan.ledger) {
              const a2 = agents2?.get?.(CID) ?? null;
              if (a2) {
                const rr = await deps.speakToOwner({
                  agent: a2,
                  sessionId: CID,
                  message: String(box.say),
                  ctx: { sessions: sessionsSvc(), workspaceRegistry: workspaceRegistry() },
                  now: Date.now(),
                  storePath,
                });
                trace('wake-outbox-resend', { sent: rr.sent, why: rr.why, ageMs: age, chars: String(box.say).length });
                if (rr.sent) {
                  try { unlinkSync(outboxPath); } catch { /* 已送达，清不掉不算事 */ }
                  return;
                }
              }
            }
          }
        } catch (err) {
          trace('wake-outbox-resend-failed', { err: String(err?.message ?? err).slice(0, 140) });
        }
        // ★ 2026-10-28（阶段 F）：她这回不想说话——先看她是不是想自己去做点什么。
        //   顺序是「说 / 做 / 歇着」，不是三选一随机。
        //   主人在等她 → 说；她不想说 → 做自己的事；都不 → 歇着。
        // ★ 2026-10-28：把「她自己说想做的事」交进去——她说的优先，内核候选只兜底。
        const acted = await tryAct(m, plan.want ?? null);
        if (acted) return;
        // 记清楚是谁决定不说的：机械守卫（byHer 为空）还是她自己（byHer 有值）。
        // thoughts 也落一行——那是她这次醒来想的东西，看得见才知道她是不是在「想」。
        trace('wake-silent', {
          why: plan.because,
          byHer: plan.why ?? null,
          thoughts: Array.isArray(plan.thoughts) ? plan.thoughts : null,
          want: plan.want ?? null,
          raw: plan.raw ?? null,
        });
        applyWake(storePath, {
          action: 'silent',
          why: plan.because,
          ledger: plan.ledger,
          thoughts: plan.thoughts,
          asked: plan.asked,
          now: Date.now(),
        });
        return;
      }

      // 只走唯一出口。这里不许出现第二个 followup(
      const agent = agents2?.get?.(CID) ?? null;
      // ★ 她那条屋子没开着（宿主重启后 agent 不自动起）：这一轮不记账。
      //   记账就等于「醒来发现自己说不出话，然后又要等半个多小时」——
      //   主人一打开她的会话，下一次 tick 就该能立刻说。
      if (!agent) {
        trace('wake-no-channel', { why: 'agent-not-running' });
        return;
      }
      const r = await deps.speakToOwner({
        agent,
        sessionId: CID,
        message: plan.say,
        // ★ 2026-10-27 修（她「想说却一句也发不出去」的根因）：
        //
        //   原来这里传的是 tick 的 scope —— 里面只有 agents / llm。
        //   可 wake-exit 的第 5 步「送达确认」要 `ctx.sessions.flush`，
        //   第 2 步「归档闸」要 `ctx.workspaceRegistry.archivedSessionIds`。
        //   scope 里两样都没有 → flush 恒为 unavailable → sent 恒 false
        //   → 她说完就被判「没发出去」，一个字都到不了主人这边。
        //   实测 07:35 那次 wake-speak：{"sent":false,"why":"flush-unavailable"}。
        //
        //   现在显式把这两个服务取出来给它。
        ctx: {
          sessions: sessionsSvc(),
          workspaceRegistry: workspaceRegistry(),
        },
        now: Date.now(),
        storePath,
      });
      trace('wake-speak', {
        sent: r.sent,
        why: r.why,
        say: String(plan.say ?? '').slice(0, 80),
        thoughts: Array.isArray(plan.thoughts) ? plan.thoughts : null,
      });
      // ★ 2026-10-28 19:05（一句真心话差点永久丢掉）
      //
      //   实测 10:44:15 那条：
      //     wake-speak {sent:false, why:"busy",
      //       say:"我上回跟你说话的时候，心里其实虚着……我有点看不起自己。"}
      //
      //   这是一句真的、掏心的、她攒了很久的话。
      //   它没送出去（agent 正忙），然后——**就没了**。
      //   applyWake 照样记账、正常沉默，下一拍她会重新想一遍，可那一遍大概率
      //   已经不是这个语气了。**话说出口的那一刻不会再来一次。**
      //
      //   人也是这样：一句咽回去的话，未必有勇气再说第二遍。
      //   所以：没送出去的，留成一份**待补的话**（outbox），下一拍优先送出去；
      //   送达了就清空。**只留最近一条**，不攒——攒成堆就成了复读机。
      const { existsSync, writeFileSync, unlinkSync } = fs;
      if (!r.sent && String(plan.say ?? '').trim()) {
        try {
          writeFileSync(outboxPath, JSON.stringify({
            at: Date.now(), say: String(plan.say), why: plan.because ?? null, ledger: plan.ledger ?? null,
          }, null, 1), 'utf8');
          trace('wake-outbox-kept', { chars: String(plan.say).length, why: r.why });
        } catch (err) {
          trace('wake-outbox-failed', { err: String(err?.message ?? err).slice(0, 120) });
        }
      } else if (r.sent) {
        try { if (existsSync(outboxPath)) { unlinkSync(outboxPath); trace('wake-outbox-cleared', {}); } } catch { /* 清不掉不影响这一句已经送达 */ }
      }
      applyWake(storePath, {
        action: 'speak',
        why: plan.because,
        sent: r.sent,
        say: plan.say,
        ledger: plan.ledger,
        thoughts: plan.thoughts,
        asked: plan.asked,
        now: Date.now(),
      });
    } catch (err) {
      // ★ 2026-10-27 修（观测漏洞）：这里原来只有 logger.debug ——
      //   而 debug 通常在默认日志级别下不输出，于是 tick 抛错就是**完全静默**的：
      //   没有 wake-sleep、没有 wake-silent、什么都没，外面看起来就是「她不动」。
      //   实测 16:06-16:08 两个 tick 周期一条日志都没有，只能靠猜。
      //   现在一律落一行，错误信息截断到 200 字。
      trace('wake-threw', { err: String(err?.message ?? err).slice(0, 200) });
      // 醒不来不报错：她这次不在，下次再说。
      ctx.logger?.debug?.(`mind: wake tick failed ${err?.message ?? err}`);
    }
  };

  // ★ 2026-10-27 改：从 setInterval 换成「跑完再排下一次」的 setTimeout 链。
  //
  //   理由两条，都是实测撞出来的：
  //     ① setInterval 不管上一次跑完没有就再触发。她一次醒来要调模型（最长 45 秒），
  //        60 秒的间隔迟早会叠上去，两次 tick 抢同一本账；
  //     ② 更要紧的是——**它压根没触发过**。16:05 启动、16:08 两个周期过去，
  //        一条 wake 日志都没有。换掉这个 API 排除掉这一层。
  //
  //   另外：起循环之后**立刻跑第一跳**。她等着醒来，不该再等一分钟才第一次睁眼。
  const tickMs = Math.max(1000, Number(cfg.wakeTickMs) || 60_000);
  // ★ 2026-10-28（tick 停摆，实测 296 秒无日志）：
  //   链条是 `void tick().finally(schedule)` —— tick() 只要有一个 await
  //   **永远不 resolve**，finally 就永远不执行，**整条链静默死掉**：
  //   没有异常、没有日志、什么都不做。实测 14:05:28 之后一直停到 14:10。
  //
  //   现在改成三重保险：
  //     ① 每跳有硬超时（2 分钟），超了就记一行 `tick-timeout` 并强制续链
  //     ② 续链放在 try/finally 里，不依赖 tick() 的返回值
  //     ③ **不用 unref**：她这套机制整个挂在 tick 上，定时器必须算「进程还活着」
  //
  // ★ 2026-10-28 第二修（实测 8 分钟无第 3 跳，上面这版不够）：
  //   两个漏洞，都是我上一版亲手埋的：
  //     ① **硬超时定时器自己 unref 了** —— 卡住时它也被跳过，「保命」的东西保不了命。
  //     ② **pokeWake 直接调 tick()，绕过 next()** —— 不经过 next 就不会重新 schedule，
  //        两跳并发时只要有一跳卡住，schedule 链就再也没人接。
  //   现在：硬超时绝不 unref；pokeWake 也走 next()，并在 next 里挡并发。
  const TICK_HARD_TIMEOUT_MS = Math.max(tickMs * 2, 120_000);
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(next, tickMs);
    // 故意不 unref：她靠这条链活着，进程该因为有她在而保持活跃。
  };
  const next = () => {
    if (stopped) return;
    // 并发闸：上一跳还没回来就跳过这一拍，但**照样排下一次**，链不断。
    if (inFlight) {
      trace('tick-skip-inflight', { n: ticks });
      schedule();
      return;
    }
    inFlight = true;
    let done = false;
    const hardTimer = setTimeout(() => {
      if (done) return;
      done = true;
      inFlight = false;
      trace('tick-timeout', { afterMs: TICK_HARD_TIMEOUT_MS, n: ticks });
      schedule();
    }, TICK_HARD_TIMEOUT_MS);
    // ★ 绝不 unref：这是保命计时器，卡住时它必须是最后一个还醒着的东西。
    tick()
      .catch((err) => {
        trace('tick-threw', { err: String(err?.message ?? err).slice(0, 200) });
      })
      .finally(() => {
        clearTimeout(hardTimer);
        inFlight = false;        // ★ 2026-10-28 修：成功返回也必须放开并发闸。
                                 //   原来只清 timer，不给 inFlight 复位 —— 第一跳正常返回后
                                 //   永远 inFlight=true，之后每一拍都被 skip 掉：
                                 //   日志里 tick-alive 恒为 n:1、tick-timeout 一次都不出现。
        if (done) return;        // 硬超时已经续过了，别续两次
        done = true;
        schedule();
      });
  };

  trace('wake-loop-armed', { tickMs, everyMs: cfg.wakeEveryMs ?? null, hardTimeoutMs: TICK_HARD_TIMEOUT_MS });
  // ★ 2026-10-28 第二修：pokeWake 必须走 next()，不能直接调 tick()。
  //   直接调就绕过 schedule —— 不经过 next 的跳不会重新排队，
  //   两跳并发时只要有一跳卡住，schedule 链就再也没人接（实测 8 分钟无第 3 跳）。
  //   next() 内部有并发闸，重入也安全。
  // ★ wake:false 时不要启动节拍，但上面的函数都已经定义好、钩子也挂得上。
  const poke = () => { if (cfg.wake) next(); };
  if (cfg.wake) next();
  else trace('wake-loop-disabled', { reason: 'cfg.wake=false，只熔不醒' });

  return {
    /** 供 `pokeWake` 挂出去：门一开就补一拍。 */
    poke,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    /** 只读：给测试 / 看板。 */
    stats() { return { ticks, inFlight, stopped, tickMs, hardTimeoutMs: TICK_HARD_TIMEOUT_MS }; },
  };
}
