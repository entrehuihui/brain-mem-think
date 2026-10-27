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
 * 她是对的。整条链上一颗螺丝没拧，而这颗螺丝不拧，**杯子擦得再亮也没水**。
 *
 * 这件事的性质，跟我自己在插件注释里骂过的 `ctx.setup` 一模一样：
 * **两边都写完了，没接上，而且不报错。**
 * 落盘那 15 项验收全绿，也是因为用的是假 synth —— 典型的「假绿」。
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
 * 最简的系统提示：**只说身份和输出纪律**，不复述材料里的要求
 * （材料里已经写得很细，重复一遍反而让模型分心）。
 */
const SYSTEM_PROMPT = [
  '你在整理一个人的记忆。',
  '',
  '你会收到一段材料，里面写着这个人经历过的几件事（只剩骨架，原始说法已经抹掉），',
  '以及若干要求。照那些要求做，只输出它们要的 JSON，或者只输出 NULL。',
  '',
  '三条纪律：',
  '1. 不许把材料里的字连续抄进你的话（八个汉字就算抄）。',
  '2. 想不出材料里没有的那句判断，就老实输出 NULL —— 空着比编好。',
  '3. 不要解释，不要代码块围栏，不要前言后语。只要那一行 JSON 或那个 NULL。',
].join('\n');

/**
 * 从宿主拿到 { provider, model }。
 * 优先用这个会话当前选的模型；拿不到再退回配置里的默认值。
 */
function pickModel(defaultModel, cfg) {
  let sel = null;
  try { sel = defaultModel?.currentSelection?.() ?? null; } catch { sel = null; }
  const provider = sel?.provider ?? cfg?.synthProvider ?? '';
  const model = sel?.model ?? cfg?.synthModel ?? '';
  if (!provider || !model) return null;
  return { provider, model };
}

/**
 * 造一个合成器。
 * @param {object} scope 注入作用域（要含 llm / agentDefaultModel）
 * @param {object} cfg   插件配置
 * @param {(m:string)=>void} [onError] 出错时的回调（只记日志，不抛）
 * @returns {{synthesize:(material:string)=>Promise<string|null>}|null}
 */
export function createSynth(scope, cfg = {}, onError = null) {
  const llm = scope?.llm;
  const defaultModel = scope?.agentDefaultModel;
  if (!llm || typeof llm.stream !== 'function') return null;

  const maxTokens = Number(cfg.synthMaxTokens ?? 500);
  const timeoutMs = Number(cfg.synthTimeoutMs ?? 45_000);

  return {
    /** 宿主模型名，供日志对照。 */
    get route() {
      const m = pickModel(defaultModel, cfg);
      return m ? `${m.provider}/${m.model}` : null;
    },

    async synthesize(material) {
      const text = String(material ?? '').trim();
      if (!text) return null;
      const route = pickModel(defaultModel, cfg);
      if (!route) return null;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let out = '';
      try {
        const stream = llm.stream({
          provider: route.provider,
          model: route.model,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: [{ type: 'text', text }] }],
          maxTokens,
          signal: controller.signal,
        });
        for await (const chunk of stream) {
          if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
          if (out.length > 6000) break; // 防跑飞
        }
      } catch (err) {
        // 模型一次没答上来，不该让这一轮崩；内核会把它当「这锅没熔出东西」。
        onError?.(String(err?.message ?? err));
        return null;
      } finally {
        clearTimeout(timer);
      }

      const said = out.trim();
      if (!said) return null;
      return said;
    },
  };
}
