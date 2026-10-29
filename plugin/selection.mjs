/**
 * selection.mjs —— 把 provider / model 塞进这条会话的装配和请求。
 *
 * ======================= 为什么自己写一份 =======================
 *
 * 宿主其实导出过一个 `installModelSelection()`（`@deepseek-ai/dsh-agent`），
 * 逐字照抄它是最稳的。但插件所在的 profile 里**解析不到那个包**
 * （实测 `import("@deepseek-ai/dsh-agent")` → ERR_MODULE_NOT_FOUND；
 *   profile 的 node_modules 只有 cosmokit / schemastery）。
 *
 * 所以这里照抄它的两段 waterfall，语义逐字对齐，只在两处做了简化（下面标了）。
 * **宿主升级后要回看 dsh-agent/lib/index.js 的 installModelSelection，确认它没变。**
 *
 * ======================= 它修的是哪个坑 =======================
 *
 * 她那条会话挂的 preset 里有一段 `deployment:persona-prefix`，正文带 `{{model}}`。
 * 而 `model` / `provider` 这两个装配变量**没有默认值**——没人往 variables 里填，
 * 装配就直接抛：
 *
 *   prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")
 *
 * 实测她那段会话 turn 4–7 连续四轮全是这个错，一个字都没出来。
 * 「屋子不自动开门」和「开门了也醒不来」，是同一个坑的两面。
 *
 * ======================= 两处简化 =======================
 *
 *   1. 宿主用 `selection.assembled`（装配那一刻的快照）给请求用，为了「切换模型时
 *      不把两个面劈开」。我们这里直接读当前值——她的模型不归人切，简化无害。
 *   2. 省掉了 agent/pre-step 那段「模型切换了，告诉你一声」的 notice。
 *      那条是给用户看的提示，她的屋子里不需要。
 */

/**
 * 给一个 agent 的 scoped ctx 装上模型选择。
 *
 * @param {object} agentCtx  这条会话自己的 ctx（`agent.ctx`，或在 resume 的 setup 里拿到的）
 * @param {() => ({provider:string, model:string, reasoningEffort?:string}|undefined)} getSelection
 *   每次装配/请求时现取。取不到（返回 undefined）就什么都不改，让装配按原样走。
 * @returns {() => void} 清理函数
 */
export function installModelSelection(agentCtx, getSelection) {
  const on = typeof agentCtx?.on === 'function' ? agentCtx.on.bind(agentCtx) : null;
  if (!on) return () => {};

  // ① 装配时把变量填进去——`{{model}}` 就靠这一下。
  const disposeAssembly = on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = getSelection();
    const assembled = await next();
    if (selected === undefined || selected === null) return assembled;
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: selected.provider,
        model: selected.model,
      },
    };
  });

  // ② 请求时把走哪个模型钉死——装配填的是变量，真正发请求用的是这里。
  const disposeRequest = on('agent/request', async (_payload, next) => {
    const resolved = await next();
    const selected = getSelection();
    if (selected === undefined || selected === null) return resolved;
    const { reasoningEffort: _inheritedEffort, ...rest } = resolved;
    return {
      ...rest,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    };
  });

  return () => {
    try { disposeAssembly?.(); } catch { /* 卸载时不值得崩 */ }
    try { disposeRequest?.(); } catch { /* 同上 */ }
  };
}
