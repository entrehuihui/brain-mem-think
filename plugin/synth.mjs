/**
 * synth.mjs —— 把宿主的 llm 服务，接成内核认识的那个「合成器」。
 *
 * ======================= 它为什么必须存在 =======================
 *
 * 2026-10-27，小乔装完插件之后连着两单把我钉在墙上。第二单这句最狠：
 *
 *   > 「`synth` 从头到尾没被赋值过。全文件只有两处提到它，
 *   >  `ctx.inject(['agents','llm'])` 拿到 `scope.llm` 却一次都没赋值。
 *   >  熔 → nothing_to_digest → 库永远空 → 追问没东西可追
 *   >  → restored 恒 0 → 注入恒空。」
 *
 *  她是对的。整条链上一颗螺丝没拧，而这颗螺丝不拧，**杯子擦得再亮也没水**。
 *
 * ============================ 两个入口 ============================
 *
 * 同一个模型通路，两套系统提示，两件事：
 *
 *   synthesize(material)  —— 「你在整理一个人的记忆」。给火炉和归档熔用。
 *   ask(system, material) —— 调用方自带口径。给「要不要开口」用：那不是整理记忆，
 *                            是她自己说话，口径必须是她本人。
 *
 * 拿整理记忆的口径去问她要不要说话，她会交回一段 JSON 分析；
 * 拿她本人的口径去问，她才说得像个人。
 *
 * ★ 两处都从 streamText() 过。原来这段流式逻辑写在 synthesize 里面，
 *   加第二个入口就得复制一份 —— 复制之后两处迟早长歪（这项目里已经吃过
 *   「两份实现、口径不一致」的亏，见 collect.mjs 的注释）。
 *
 * ============================ 它只做一件小事的 ============================
 *
 * 内核要的是：`synth.synthesize(材料) → 模型原话（字符串）或对象`。
 * 内核自己会 `parseSynthesis` 去解析。所以这里**不做任何解析**，也不改材料 ——
 * 材料是 forge / digest-session 精心拼好的完整提示词（含要求、谓词闭集、JSON 格式），
 * 这里只负责把它送进模型、把话说回来。
 *
 * 一次调用失败就返回 null。内核那边把 null 当「这锅没熔出东西」，
 * 不会炸、不会卡、不会把对话带崩。
 */

/**
 * 系统提示。
 *
 * ★ 2026-10-27 修（小乔实测）：原来这里写着
 *     「或者只输出 NULL」「想不出就老实输出 NULL —— 空着比编好」
 *   结果**归档熔那条路，模型每次都只回一个 `null`**（digest-raw len:4 head:"null"），
 *   连试了材料干净/不干净两种情况，11~40 秒后都是 null。
 *
 *   材料末尾明明写着「只输出 JSON：{"judgments":[...]}」，
 *   可我这句话在跟材料抢方向盘，小模型听了我的。
 *
 *   所以：**这里不再提 NULL，也不再替材料下结论**。
 *   只交代身份、纪律和「照材料要的格式来」，判断该不该说由材料和模型自己决定。
 */
const SYSTEM_PROMPT = [
  '你在整理一个人的记忆。',
  '',
  '你会收到一段材料：这个人经历过的几件事（只剩骨架，原始说法已经抹掉），',
  '以及一份明确的要求（要什么字段、要什么 JSON 形状）。',
  '',
  '纪律：',
  '1. **严格照材料末尾要求的那一种格式输出**，不要自己另造格式，不要加解释、不要围栏。',
  '2. 材料让你给判断时：**先认真找一遍**。只要里面有他反复在做的事、',
  '   或者有让他改变态度的事，就给一条；宁可说得朴素，也不要空着交回去。',
  '3. 材料允许「没有可说的」那种空结果时，实在找不出来才用它。',
  '4. 不许把材料里的字连续抄进你的话（八个汉字就算抄）。',
  '5. 不许编造材料里没有的具体时间、地点、数量、人物。',
].join('\n');

/**
 * 从宿主拿到 { provider, model }。一级一级往下退：
 *
 *   ① 配置里写死了 synthProvider + synthModel → 锁死，绝不漂
 *   ② 新建会话的默认模型（`agentDefaultModel.currentSelection()`）
 *   ③ 只配了 model、没配 provider → 从 llm 的可用 provider 里配一个
 *   ④ 真什么都没有 → null（宁可哑着，也不瞎挑一个去调）
 *
 * ======================= 两级「默认」要说清 =======================
 *
 * 很多人（包括我之前一版）会把 `agentDefaultModel.currentSelection()`
 * 当成「当前打开的那个会话用的模型」。**不是。**
 *
 * 它读的是 `agent-default-model` 这个服务自己的配置
 * （`dsh-agent-default-model/lib/index.js:38`），也就是**新建会话时套用的默认**。
 * 它会在设置里被改，但不会因为你在不同会话之间切换而变。
 *
 * 所以「跟着主人看哪个会话漂」这个说法是错的——那个漂是「默认设置被动过」。
 * 日志里出现三个 route，就是因为这个设置被改过三次。
 *
 * ======================= 为什么配死排第一 =======================
 *
 * 原来的写法是 `sel?.provider ?? cfg?.synthProvider`——currentSelection 永远优先，
 * 于是**在配置里写死也没用**，配了等于白配。
 * 她的活是熔记忆、说一句话、把判断说成人话；用哪个模型该由主人一次定死，
 * 不该跟着一个全局设置漂。
 */
function pickModel(defaultModel, cfg, llm) {
  // ① 配死
  if (cfg?.synthProvider && cfg?.synthModel) {
    return { provider: String(cfg.synthProvider), model: String(cfg.synthModel) };
  }

  // ② 新建会话的默认模型
  let sel = null;
  try { sel = defaultModel?.currentSelection?.() ?? null; } catch { sel = null; }
  if (sel?.provider && sel?.model) {
    return { provider: String(sel.provider), model: String(sel.model) };
  }

  // ③ 只配了 model：provider 从可用列表里挑
  if (cfg?.synthModel) {
    let providers = [];
    try { providers = llm?.listProviders?.() ?? []; } catch { providers = []; }
    const wanted = String(cfg.synthProvider ?? '');
    // ★ 别写成 `(wanted && find()) ?? providers[0]`：
    //   `wanted` 是空串时，`'' && ...` 得 `''`，而 `'' ?? x` 仍然是 `''`
    //   ——?? 只对 null/undefined 生效，空串会直接穿过去，结果挑不到 provider。
    //   （这条是单测抓出来的，不是想出来的。）
    const pick = (wanted ? providers.find((x) => x?.id === wanted) : null) ?? providers[0];
    if (pick?.id) return { provider: String(pick.id), model: String(cfg.synthModel) };
  }

  // ④ 确实没有
  return null;
}

/**
 * 把一次流式调用跑到完，只捡**正文**。
 *
 * ★ 2026-10-27 血泪（原样保留，这条是真的用血换的）：
 *   不判 block.type，就把推理块当正文捡了。实测 deepseek-v4.1-flash 只吐
 *   reasoning-delta（443 块）、一个 text-delta 都没有；那条兜底把 3217 字
 *   英文内心推演当成「她的判断」交给了内核。
 *   **推理块只计数，绝不采用。**
 */
async function streamText({ llm, system, text, route, maxTokens: cap, timeoutMs: tmo, effort, onReply, onError }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), tmo);
  let out = '';
  let reasoned = 0;
  const seen = {};

  // ★★ 2026-10-28（tick 停摆，实测 296 秒无日志）—— 这一段的写法是被实验推翻过一次的。
  //
  //   第一版我在 for await 循环**里面**判断 `Date.now() > deadline`。
  //   实测证明它救不出来：只要 `await` 卡在「等下一个 chunk」上，
  //   循环体一次都不执行，那个判断根本没机会跑。
  //   （探针：给一个永远不吐 chunk 的流，第一版 15 秒都没逃出来。）
  //
  //   真正的墙必须在**外面**：把整个消费过程塞进一个 Promise，
  //   再和「到点就 reject 的定时器」赛跑。谁先到都算数，
  //   落败的那一边由 finally 清掉 —— 不再依赖流自己肯不肯结束。
  //
  //   为什么要这么狠：tick 是 `await tick()`，只要有一个 await 永不 resolve，
  //   整条链静默死掉 —— 没有异常、没有日志、什么都不做。
  //   她整套机制（熔、唤醒、主动、观测）全挂在 tick 上。
  const consume = async () => {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      maxTokens: cap,
      // ★ 2026-10-28（熔出 0 条的真因）：推理模型的思考也吃 maxTokens。
      //   默认档位下，一条「整理记忆」的任务能把 4000 token 全烧在 reasoning 上，
      //   正文一个字不出——日志是 `synth-reply len:0 reasoned:12998`，
      //   于是 fresh=1 却 judgments=0，记忆永远不涨。
      //   熔是机械活（按给定 schema 输出 JSON），不需要深度推理：给 low。
      ...(effort ? { reasoningEffort: effort } : {}),
      signal: controller.signal,
    });
    for await (const chunk of stream) {
      if (!chunk) continue;
      seen[chunk.type] = (seen[chunk.type] ?? 0) + 1;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
      // block-end 兜底：只在**正文块**上捡。
      else if (chunk.type === 'block-end' && chunk.block?.type === 'text'
        && typeof chunk.block.text === 'string' && !out) {
        out += chunk.block.text;
      } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        reasoned += chunk.text.length; // 只计数，绝不采用
      }
      if (out.length > 6000) break; // 防跑飞
    }
  };

  const WALL = Math.max(15_000, Number(tmo) + 5_000);
  let wallTimer = null;
  const wall = new Promise((_, reject) => {
    wallTimer = setTimeout(() => {
      try { controller.abort(); } catch { /* 已经断了就算了 */ }
      reject(new Error(`mind: model stream wall-clock timeout (${WALL}ms)`));
    }, WALL);
    if (typeof wallTimer.unref === 'function') wallTimer.unref();
  });

  try {
    await Promise.race([consume(), wall]);
  } catch (err) {
    // 模型一次没答上来，不该让这一轮崩；调用方会把它当「这锅没熔出东西」。
    onError?.(String(err?.message ?? err));
    return null;
  } finally {
    clearTimeout(timer);
    clearTimeout(wallTimer);
  }

  const said = out.trim();
  // 模型原话必须落日志：今天最难查的就是「模型到底回了什么」。
  onReply?.({ len: said.length, reasoned, head: said.slice(0, 100), chunks: JSON.stringify(seen) });
  if (!said) return null;
  return said;
}

/**
 * 造一个合成器。
 * @param {object} scope 注入作用域（要含 llm / agentDefaultModel）
 * @param {object} cfg   插件配置
 * @param {(m:string)=>void} [onError] 出错时的回调（只记日志，不抛）
 * @returns {{synthesize:(material:string)=>Promise<string|null>, ask:(system:string, material:string, opts?:object)=>Promise<string|null>}|null}
 */
export function createSynth(scope, cfg = {}, onError = null) {
  const llm = scope?.llm;
  const defaultModel = scope?.agentDefaultModel;
  if (!llm || typeof llm.stream !== 'function') return null;

  // 500 对一条 judgments 数组偏紧，flash 容易在长输出上截断，给到 800。
  // ★ 800 不够：flash 会把 800 个 token 全花在 reasoning 上，正文一个字都出不来。
  //   实测 reasoning-delta 443 块、text-delta 0 块。给到 4000，让它先想完再说。
  const maxTokens = Number(cfg.synthMaxTokens ?? 4000);
  const timeoutMs = Number(cfg.synthTimeoutMs ?? 45_000);
  // 熔用低推理档：它是机械活，思考烧掉预算就交不出 JSON（见 streamText 里的注释）。
  // 她自己说话（ask）不降档——那是她在想事情。
  const digestEffort = cfg.digestReasoningEffort ?? 'low';
  // 模型原话的回调。**必须留**：今天一整天最难查的就是「模型回了什么」——
  // 材料进没进去有 owners 可看，模型说没说就只剩这一行。
  const onReply = typeof cfg.onReply === 'function' ? cfg.onReply : null;

  return {
    /** 宿主模型名，供日志对照。 */
    get route() {
      const m = pickModel(defaultModel, cfg, llm);
      return m ? `${m.provider}/${m.model}` : null;
    },

    /**
     * 通用一问：调用方自带系统提示。
     * 给「要不要开口」用 —— 那次不是在整理记忆，是她自己说话。
     */
    async ask(system, material, opts = {}) {
      const sys = String(system ?? '').trim();
      const text = String(material ?? '').trim();
      if (!sys || !text) return null;
      const route = pickModel(defaultModel, cfg, llm);
      if (!route) return null;
      return await streamText({
        llm,
        system: sys,
        text,
        route,
        maxTokens: Number(opts.maxTokens ?? maxTokens),
        timeoutMs: Number(opts.timeoutMs ?? timeoutMs),
        onReply: opts.onReply ?? onReply,
        onError,
      });
    },

    /** 整理记忆那一问：系统提示写死在这份文件里。 */
    async synthesize(material) {
      const text = String(material ?? '').trim();
      if (!text) return null;
      const route = pickModel(defaultModel, cfg, llm);
      if (!route) return null;
      return await streamText({
        llm,
        system: SYSTEM_PROMPT,
        text,
        route,
        maxTokens,
        timeoutMs,
        effort: digestEffort,
        onReply,
        onError,
      });
    },
  };
}
