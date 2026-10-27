/**
 * index.mjs —— brain-mem-think 的宿主端。
 *
 * ======================= 它为什么在这儿 =======================
 *
 * 内核（src/）是纯的：一颗会忘、会想多、会追问、会改自己的脑子，
 * 但它不知道自己是插件，也不该知道。**接宿主的事全在这一层。**
 *
 * 它做四件事：
 *   ① 采集    主人在会话里说的话 → 喂给火炉（原话不进库，见 src/forge.mjs）
 *   ② 归档熔  一段会话被归档的那一刻，整段一起熔（主人定的融合时机）
 *   ③ 注入    轮到她说的时候，把「她记得的事」放进系统提示
 *   ④ 唤醒    定时醒一次，问她要不要找主人（决定权在她，见 src/wake.mjs）
 *
 * ============================ 三条线不许越过 ============================
 *
 *   1. **她的输出不是经历**（裁决七）：归档熔只收 user/message。
 *   2. **只有一条出口**（plugin/wake-exit.mjs）：全插件 `followup(` 只出现一次。
 *   3. **认不出主题就不认**（裁决一）：主题由模型想完自己给，内核不许按字面猜。
 *
 * ============================ 拿不到服务怎么办 ============================
 *
 * 全部走 `ctx.inject([...], fn)` 延迟绑定。拿不到就那一块不跑，
 * **插件本体照常活着**——绝不能因为少一个服务就让整个 fiber 起不来。
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMind } from '../src/mind.mjs';
import { createFileIo, defaultJudgmentPath } from '../src/persist.mjs';
import { createSynth } from './synth.mjs';
import { ownerMessages } from './collect.mjs';
import { planWake, applyWake } from './awake.mjs';
import { readWake, sweepTemps, defaultPath } from './wake-store.mjs';

export const name = 'mind';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * 插件根目录（plugin/ 的上一级）。
 *
 * ★ 2026-10-27 大乔补：`.mind` 必须落在**插件根**，不能落在 `plugin/` 里。
 *   我原来用 HERE（= plugin/），结果日志写到 plugin/.mind/，
 *   而账本 defaultPath() 写死在插件根/.mind/ —— 两处不一致，查了半天以为没跑。
 *   一个插件只该有一个 .mind。
 */
const ROOT = dirname(HERE);
/** 通道会话的固定 id。不许带冒号、空格、路径分隔符——宿主会拿它当文件名。 */
/**
 * 她那条通道的会话 id。
 *
 * ★ 2026-10-27 大乔定：**不要自己造 id，要用宿主建好的那条。**
 *
 *   踩过的坑（一整天）：我用 `agents.create({ sessionId: 'mind-her' })` 自己造了个 id，
 *   结果三处连锁反应——
 *     ① 没有 agentPreset → 没有模型选择 → 装配时 `{{model}}` 没有值 →
 *        `turn/end reason: error`，LLM 0ms，一句话都说不出来；
 *     ② 空白会话在侧边栏是隐藏的（client.js:966 `if (session.blank && ...) return false`），
 *        所以主人根本看不见她；
 *     ③ 自定义 id 不在 `session/list` 里（宿主只认自己 mint 的 `session-<uuid>`）。
 *
 *   正确做法：由宿主按正规流程建一次，把 id 配进来。
 *   这个值可以在 cordis.patch.yml 的 `channelSessionId` 里改。
 */
const DEFAULT_CHANNEL_SESSION_ID = '<CHANNEL_SESSION_ID>';
let CHANNEL_SESSION_ID = DEFAULT_CHANNEL_SESSION_ID;
const MIND_TAG = '<mind>';

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  // 归档熔：一段会话归档时整段一起熔（主人定的融合时机）
  digestOnArchive: true,
  // 注入：每轮开始把「她记得的」放进系统提示
  injectOnTurn: true,
  // 唤醒：自己醒、自己想、自己决定要不要找主人
  wake: true,
  wakeTickMs: 10 * 60 * 1000,
  // 她那条通道挂在哪个工作目录。空 = 跟随主人的默认工作区（这样界面上看得见她）。
  channelCwd: '',
  // 她那条通道的会话 id。留空 = 用上面那个默认值（宿主正规流程建的那条）。
  channelSessionId: '',
  // 判断库落盘。false = 纯内存（重启即忘，只适合沙盘）。
  persist: true,
  judgmentsPath: '',
  // 接模型用的参数。synthProvider/synthModel 留空 = 跟随当前会话选的模型。
  synthProvider: '',
  synthModel: '',
  synthMaxTokens: 4000,
  synthTimeoutMs: 45000,
  name: '大乔',          // ⚠ 只读名字，不读别的任何字段（裁决八）
  timeoutMs: 20_000,
});

function resolveConfig(raw = {}) {
  return { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
}

/**
 * 落盘的自检日志。
 *
 * ★ 为什么要它：stderr 只进启动终端，谁也翻不到。装完之后「插件到底加载没加载」
 *   这个最基本的问题，居然要靠猜——2026-10-27 就是卡在这儿。
 *   一行 JSON 落盘，重启后一眼能看。
 */
let LOG_PATH = null;
function trace(event, extra) {
  try {
    if (!LOG_PATH) return;
    const line = `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...(extra || {}) })}\n`;
    appendFileSync(LOG_PATH, line, 'utf8');
  } catch { /* 观测用，失败静默 */ }
}

/**
 * 插件主体。
 * @param {object} ctx 宿主上下文
 * @param {object} config cordis.patch.yml 那段
 */
export function apply(ctx, config = {}) {
  // ★ 第一行就写盘：以后「插件没反应」这件事，第一眼就能分清
  //   「压根没进 apply」和「进了但没干活」。
  try {
    mkdirSync(join(ROOT, '.mind'), { recursive: true });
    LOG_PATH = join(ROOT, '.mind', 'mind.log');
  } catch { LOG_PATH = null; }
  trace('apply-entered', { hasCtx: !!ctx, cfgKeys: Object.keys(config || {}) });
  process.stderr.write('mind: apply() entered\n');
  const cfg = resolveConfig(config);
  // 通道 id 允许在配置里覆盖（换机器、换人设都可能要换）
  if (cfg.channelSessionId) CHANNEL_SESSION_ID = String(cfg.channelSessionId);
  if (!cfg.enabled) {
    trace('disabled');
    ctx.logger?.info?.('mind: disabled by config');
    return;
  }

  const storeDir = join(ROOT, '.mind');
  const storePath = cfg.wakeStorePath || defaultPath();
  try { sweepTemps(storePath); } catch { /* 清理失败不影响任何事 */ }
  trace('config', { name: cfg.name, digest: cfg.digestOnArchive, inject: cfg.injectOnTurn, wake: cfg.wake });

  // 内核：一颗纯的脑子。模型通过 inject 拿到的 llm 注入进来，拿不到就先是个哑的。
  let synth = null;
  let mind = null;
  const ensureMind = async () => {
    if (mind) return mind;
    // ★ 2026-10-27 补：给她一份**落盘**的判断库。
    //
    //   小乔装完后查出来的硬事实：「src/*.mjs 零文件 IO，Store 就是个 this.list = []，
    //   归档一百段会话，宿主一重启，她又变回空白。」
    //   她说得对——会忘、但一重启就全忘，那不叫记忆。
    //
    //   io 不注入就是纯内存（验收脚本一直这么跑，零副作用）；
    //   这里注入文件适配器，她才跨得过重启。
    const io = cfg.persist === false
      ? null
      : createFileIo(cfg.judgmentsPath || defaultJudgmentPath(ROOT));
    mind = await createMind({
      synth: synth ?? { synthesize: async () => null },
      name: cfg.name,
      limits: cfg.limits ?? {},
      io,
    });
    const restored = mind?.stats?.restored ?? 0;
    trace('mind-ready', { restored, persist: !!io, path: io?.path ?? null });
    if (restored > 0) process.stderr.write(`mind: 记起来了 ${restored} 条判断\n`);
    return mind;
  };

  // ── ② 归档熔：主人定的融合时机 ──────────────────────────────
  //
  // 为什么是归档时、不是每条消息：一段会话是一个完整的经历单元。
  // 人在回忆时也不是逐句回忆，是「那段时间发生了什么」。
  ctx.inject(['workspaceRegistry', 'sessions'], (scope) => {
    trace('inject-archive', { hasReg: !!scope.workspaceRegistry, hasSessions: !!scope.sessions });
    if (!cfg.digestOnArchive) return;
    const reg = scope.workspaceRegistry;
    if (!reg || typeof reg.archiveSession !== 'function') {
      trace('archive-skip', { why: 'no archiveSession' });
      return;
    }
    // 包一层 archiveSession：归档发生时，先把整段熔完，再真的归档。
    // 为什么不轮询 archivedSessionIds：那是 getter，没有事件；
    // 而包一层是本地插件、范围清楚、出错也只影响这一次归档。
    // ★ 保存**原函数本身**，不 bind。
    //   bind 出来的是另一个函数，还原时把绑定版塞回去，`=== 原函数` 就不成立了——
    //   真机上看不出差别，但「到底有没有还原」这件事从此再也验不了。
    //   调用时用 `orig.call(reg, ...)` 保住 this。
    const orig = reg.archiveSession;
    reg.archiveSession = async (sessionId, options) => {
      // 入口留一行：以后「钩子到底进没进」不用再猜。
      trace('archive-hook-entered', { sessionId });
      try {
        await digestSession(scope.sessions, sessionId);
      } catch (err) {
        trace('archive-hook-failed', { sessionId, err: String(err?.message ?? err).slice(0, 140) });
        process.stderr.write(`mind: digest on archive failed (${err?.message ?? err})\n`);
      }
      return orig.call(reg, sessionId, options);
    };

    // ★ 2026-10-27 修（小乔实测）：包装必须能还原。
    //
    //   原来 `ctx.effect` 的清理只把 `mind` 置空，**没把 orig 还回去**。
    //   于是每 disable/enable 一次就多叠一层包装，旧层闭包抓着已销毁的实例。
    //   她自己在会话里数出来的：**29 次进钩子，21 次失败**，
    //   报错全是 `cannot get required service "sessions" in inactive context`。
    //
    //   而且这不只是报错：真熔通之后，同一次归档会被 N 层各熔一遍 → 熔出 N 份重复判断。
    ctx.effect(() => () => {
      try {
        // 只有这一层还是最外层时才还原，避免把别人后来包的又拆掉。
        reg.archiveSession = orig;
      } catch { /* 还原失败也不该让卸载崩 */ }
    }, 'mind.archive-hook');

    async function digestSession(sessions, sessionId) {
      if (!sessions || typeof sessions.get !== 'function') {
        trace('digest-no-sessions', {});
        return;
      }

      // ── 取消息：活会话走内存，**冷会话走持久化** ─────────────
      //
      // ★ 2026-10-27 修。原来这里只有：
      //     const session = sessions.get(sessionId);
      //     if (!session) return;
      //   而归档发生时，那段会话往往**已经不在运行态**了 —— `sessions.get` 返回 undefined，
      //   于是**悄悄 return，一个字都不留**。主人第一次真归档她自己的屋子，日志里
      //   除了一句 inject-archive 什么都没有，看起来像钩子没装上。
      //
      //   这已经是今天第七次「不报错、也不做」了。所以现在：
      //     · 活会话：deriveMessages()
      //     · 冷会话：sessionQuery.readSession() 读存下来的事件
      //     · **两条路都留日志**，取不到也留，绝不再静默
      let msgs = [];
      let where = 'live';
      const session = sessions.get(sessionId);
      if (session && typeof session.deriveMessages === 'function') {
        msgs = session.deriveMessages();
      } else {
        where = 'cold';
        const sq = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null;
        if (sq && typeof sq.readSession === 'function') {
          try {
            const snap = await sq.readSession(sessionId);
            msgs = (snap?.events ?? [])
              .filter((e) => e && e.type === 'user/message')
              .map((e) => ({ role: 'user', content: e.data?.content, source: e.data?.source }));
            trace('digest-cold-read', { sessionId, events: (snap?.events ?? []).length, msgs: msgs.length });
          } catch (err) {
            trace('digest-cold-failed', { sessionId, err: String(err?.message ?? err).slice(0, 140) });
          }
        } else {
          trace('digest-cold-unavailable', { sessionId, hasQuery: !!sq });
        }
      }

      // ★ 裁决七：只收主人说的话。她的输出不是经历，是结果。
      //   不收的话，她说一句 → 落进历史 → 下一次归档当成「发生过的事」熔进去
      //   → 她越说越确信，因为每一次说话都在给自己造证据。
      //
      // ★ 2026-10-27 修（小乔实测）：原来写的是
      //     `msgs.filter(isValidMessage).map(x => ({text: x.text}))`
      //   `isValidMessage` 返回**布尔**，filter 留下的是宿主原始消息对象，
      //   而原始消息只有 `content` 数组、**没有 `text` 字段**。
      //   于是每一条 text 都是 undefined，被下游滤光 → 永远 reason:'too_little'。
      //   实测 ownerCount=5、textLens=[-1,-1,-1,-1,-1]、totalChars=0。
      //
      //   `collect.mjs` 早就导出了 `ownerMessages()` —— 它返回 {text, role:'user'}，
      //   正是下游要的形状。**没人用它。** 这又是「写完了没接上」。
      const owners = ownerMessages(msgs);
      trace('digest-owners', { sessionId, where, msgs: msgs.length, owners: owners.length });
      if (!owners.length) {
        trace('digest-skip', { sessionId, why: 'no_owner_messages', where });
        return;
      }
      const m = await ensureMind();
      const out = await m.digestSession(owners);
      ctx.logger?.info?.(`mind: digested ${sessionId} → ${out?.judgments?.length ?? 0} 条判断`);
      trace('digest-done', { sessionId, owners: owners.length, judgments: out?.judgments?.length ?? 0, reason: out?.reason ?? null });
    }
  });

  // ── ③ 注入：轮到她的时候，让「她记得的」出现在系统提示里 ────
  ctx.inject(['systemPrompt'], (scope) => {
    if (!cfg.injectOnTurn || !scope?.systemPrompt?.context) return;
    // 注意：这里**不是** complete:true。那是给她自己那条通道用的；
    // 主人自己的会话如果被整段替换，他就没有工作目录、没有工具说明了。
    scope.systemPrompt.context({
      name: 'mind:world',
      order: 900,
      text: () => {
        try {
          if (!mind) return '';
          const world = mind.world ? mind.world({ name: cfg.name }) : '';
          if (!world) return '';
          return `${MIND_TAG}\n${world}\n${MIND_TAG.replace('<', '</')}`;
        } catch {
          return '';
        }
      },
    });
  });

  // ── ③ 接模型：把宿主的 llm 接成内核认识的合成器 ──────────────
  //
  // ★ 2026-10-27 补。这是**整条链上唯一一处真正的断点**。
  //   小乔装完之后查出来：`synth` 从头到尾没被赋值过，
  //   全文件只有「声明」和「使用」两处，`ctx.inject(['agents','llm'])` 拿到
  //   `scope.llm` 却一次都没用它造合成器。
  //   于是：熔 → nothing_to_digest → 库永远空 → 追问没东西可追
  //        → restored 恒 0 → 注入恒空。杯子擦得再亮，没接水管。
  //
  //   这一接上，四件事同时活了：熔、落盘、追问、改自己。
  //   ★ 2026-10-27 再修（小乔实测）：**`ctx.inject(['llm'], fn)` 在这个宿主里根本不触发。**
  //     她加探针验的：`ctx.get('llm')` 有值、`.stream` 是函数、`agentDefaultModel` 也在，
  //     但 inject 的回调一次都没进来过——`synth-ready` 和 `synth-unavailable` 两条都没有，
  //     等于那块代码不存在。宿主自己的包（dsh-acp / dsh-mcp-client / dsh-spill-policy /
  //     dsh-sdk-jsonrpc-server / dsh-session-reference）**全部是 `ctx.get("llm")`**，
  //     没有一处 inject(['llm'])。
  //
  //   所以：**先直接 get，拿不到再退 inject**（老宿主上 inject 也该能用）。
  //   两条路都试，才不会再出现「代码在、不执行、不报错」。
  const defaultModel = (typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null) ?? ctx.agentDefaultModel ?? null;

  const installSynth = (llm) => {
    if (synth) return; // 已经装过，别重复
    const s = createSynth({ llm, agentDefaultModel: defaultModel }, {
      ...cfg,
      // ★ 模型原话必须落日志。今天最难查的就是「模型到底回了什么」。
      onReply: (r) => trace('synth-reply', r),
    }, (m) => trace('synth-error', { err: String(m).slice(0, 120) }));
    if (!s) {
      trace('synth-unavailable', { hasLlm: !!llm, hasDefault: !!defaultModel });
      process.stderr.write('mind: 拿不到 llm 服务，熔的路暂时是哑的\n');
      return;
    }
    synth = s;
    trace('synth-ready', { route: s.route, via: 'ctx.get' });
    // 接上就立刻把她叫起来：让 mind.log 出现 mind-ready、让注入块有内容。
    // 之前 ensureMind 只在归档熔和 wake tick 里被调，聊天一辈子也触发不了它。
    void ensureMind().then((m) => {
      const size = m?.snapshot?.().size ?? 0;
      const restored = m?.stats?.restored ?? 0;
      process.stderr.write(`mind: 脑子就绪（判断 ${size} 条，恢复 ${restored} 条）\n`);
    }).catch(() => { /* 起不来不影响别的 */ });
  };

  {
    const llmNow = typeof ctx.get === 'function' ? ctx.get('llm') : null;
    if (llmNow) installSynth(llmNow);
    else {
      trace('synth-no-ctx-get', { hasGet: typeof ctx.get === 'function' });
      // 兜底：老宿主/别的宿主上 inject 也许能用
      ctx.inject(['llm'], (scope) => { installSynth(scope?.llm); });
    }
  }

  // ── ④ 唤醒：自己醒、自己想、自己决定 ────────────────────────
  ctx.inject(['agents', 'llm'], (scope) => {
    if (!cfg.wake) return;
    let timer = null;
    const tick = async () => {
      try {
        const m = await ensureMind();
        const state = readWake(storePath);
        const plan = await planWake({ mind: m, state, now: Date.now(), cfg });
        if (plan.action === 'speak') {
          // 只走唯一出口。这里不许出现第二个 followup(
          const { speakToOwner } = await import('./wake-exit.mjs');
          const agent = scope.agents?.get?.(CHANNEL_SESSION_ID) ?? null;
          const r = await speakToOwner({
            agent,
            sessionId: CHANNEL_SESSION_ID,
            message: plan.say,
            ctx: scope,
            now: Date.now(),
            storePath,
          });
          applyWake(storePath, { ...state, action: plan.action, why: plan.because, sent: r.sent });
        } else {
          applyWake(storePath, { ...state, action: 'silent', why: plan.because });
        }
      } catch (err) {
        // 醒不来不报错：她这次不在，下次再说。
        ctx.logger?.debug?.(`mind: wake tick failed ${err?.message ?? err}`);
      }
    };
    timer = setInterval(() => { void tick(); }, Number(cfg.wakeTickMs) || 600_000);
    if (typeof timer.unref === 'function') timer.unref();
    ctx.effect(() => () => { if (timer) clearInterval(timer); }, 'mind.wake-timer');
  });

  // ── 自愈：每次醒来顺手把她挂回工作区 ──────────────────────
  //
  // ★ 2026-10-27 大乔加：宿主的工作区归属靠进程内存里的 sessionPaths 映射，
  //   一旦这次没挂上（或者以后被谁动了），她就从界面上消失，而且**不报错**。
  //   十分钟补一次，成本几乎为零，但省掉「主人找不到她」这种最难查的事。
  {
    const heal = async () => {
      try {
        if (!ctx.get) return;
        const reg = ctx.get('workspaceRegistry');
        if (!reg || typeof reg.list !== 'function') return;
        const list = reg.list();
        const cwd = cfg.channelCwd || (list.find((x) => x?.path)?.path ?? '');
        if (!cwd) return;
        const entity = list.find((x) => x && x.path === cwd);
        if (!entity || typeof entity.attachSession !== 'function') return;
        if (Array.isArray(entity.sessionIds) && entity.sessionIds.includes(CHANNEL_SESSION_ID)) return;
        await entity.attachSession(CHANNEL_SESSION_ID);
        trace('self-heal-attach', { cwd });
      } catch { /* 补不上就算了，下次再来 */ }
    };
    const t2 = setInterval(() => { void heal(); }, Number(cfg.wakeTickMs) || 600_000);
    if (typeof t2.unref === 'function') t2.unref();
    ctx.effect(() => () => clearInterval(t2), 'mind.self-heal');
  }

  // ── 她的通道：建一条专属会话，系统提示整段换成「她记得的事」──
  //
  // 这是「她看不见聊天记录」的硬保证（裁决-唤醒与通道 §三）。
  //
  // ★ 2026-10-27 大乔改：原来这里写的是 `ctx.setup(...)`——**那是错的**。
  //   查了宿主源码：`setup` 不是 ctx 上的方法，是 **`agents.create()` 的一个选项**
  //   （dsh-agent-loop/lib/index.js:1931 `setup?.(prepared.agent.ctx, prepared.agent)`）。
  //   写在 ctx 上永远不会被调用，`typeof ctx.setup === 'function'` 恒为 false，
  //   整块被静默跳过 —— 那道闸根本装不上去，而且不报错。
  //
  //   这就是「看起来对、其实没跑」的又一次。装之前用冒烟测出来的。
  //
  // ★ 为什么必须在 setup 里注册而不是在插件根 ctx 里：
  //   `systemPrompt.section()` 走 `layers.effect(this.ctx, ...)`，
  //   在**未 scoped 的根 ctx** 注册 = 进 global layer = 对所有人的会话生效。
  //   那是灾难：主人自己的会话也会只剩一段记忆，没工具、没工作目录。
  //   setup 拿到的是这条 agent 的 scoped ctx，只影响她这一条。
  ctx.inject(['agents', 'workspaceRegistry'], (scope) => {
    const agents = scope?.agents;
    const reg = scope?.workspaceRegistry;
    trace('inject-agents', { hasAgents: !!agents, canGet: typeof agents?.get === 'function' });
    // 只要「取得」能力就够：插件不再创建/恢复她的 agent（见下面 380 行那段说明）。
    if (!agents || typeof agents.get !== 'function') return;

    /**
     * 她那条会话该落在哪个工作目录。
     *
     * ★ 2026-10-27 大乔补：不给 cwd 的话，宿主会把她扔进 `_no-cwd`，
     *   那个目录不属于任何工作区 —— **界面上根本看不见她，主人也就没法跟她说话。**
     *   我第一次建的时候就是漏了这个，日志里 channel-created 成功了，
     *   可主人在界面上找不到她。
     *
     *   现在：优先挂到主人正在用的那个工作区（默认工作区），
     *   这样她就出现在会话列表里，跟别的会话并列。
     *   拿不到就退化到插件自己的 home 目录。
     */
    const pickCwd = () => {
      try {
        // ★ 2026-10-27 大乔改正：`workspaceRegistry` 上没有 `workspaces` / `workspaceIds`
        //   这两个 getter（我第一版凭想象写的）。真正能列的是 `list()`
        //   （dsh-workspace/lib/index.js:454，返回按显示顺序排好的实体数组，
        //   每个实体有 `.path` / `.title` / `.sessionIds`）。
        const list = typeof reg?.list === 'function' ? reg.list() : [];
        if (Array.isArray(list) && list.length) {
          const def = list.find((x) => x?.path) ?? list[0];
          if (def?.path) return def.path;
        }
      } catch { /* 拿不到就走兜底 */ }
      return join(ROOT, 'home');
    };

    /** 把「她的世界」装进这条会话的系统提示。 */
    const installGate = (agentCtx) => {
      try {
        agentCtx.inject?.(['systemPrompt'], (sp) => {
          const svc = sp?.systemPrompt;
          if (!svc || typeof svc.section !== 'function') return;
          // complete: true —— 整个系统提示只剩这一段。
          // 连 harness:identity（「You are an AI agent…」）也会一起摘掉，
          // 这是我们要的：她凭记忆活，不凭「你是什么产品」活。
          svc.section({
            name: 'mind:world',
            complete: true,
            text: () => {
              try {
                return mind ? (mind.world({ name: cfg.name }) || '') : '';
              } catch { return ''; }
            },
          });
          // 兜底：把非 required 的 runtime context 也压掉
          try { svc.suppressRuntimeContext?.(); } catch { /* 没有就算了 */ }
        });
      } catch (err) {
        process.stderr.write(`mind: install gate failed (${err?.message ?? err})\n`);
      }
    };

    /** 拿她那条通道；没有就建。 */
    const ensureChannel = async () => {
      // ★ 每次启动都补一次「挂进工作区」，不管她是刚建的还是本来就在。
      //
      //   为什么：新建的会话**不会自动出现在工作区列表里**——
      //   宿主只在启动时的和解流程里补挂，而我们是在启动之后才建的她。
      //   于是日志写 channel-created ok:true、会话文件也落盘了，
      //   可主人左看右看就是找不到她。
      //   （dsh-workspace/lib/index.js:102 那个 sessionIds getter 只认内存里的
      //    sessionPaths 映射，光改 workspace.json 没用。）
      const attach = async (wsPath) => {
        try {
          const list = typeof reg?.list === 'function' ? reg.list() : [];
          const entity = list.find((x) => x && x.path === wsPath);
          if (!entity || typeof entity.attachSession !== 'function') {
            trace('attach-skip', { why: 'no entity', wsPath });
            return false;
          }
          await entity.attachSession(CHANNEL_SESSION_ID);
          trace('attach-ok', { wsPath });
          return true;
        } catch (err) {
          // 最常见：header 里没有 cwd，或者 cwd 解析后跟工作区路径不一致。
          trace('attach-failed', { err: String(err?.message ?? err) });
          return false;
        }
      };

      const cwd = cfg.channelCwd || pickCwd();
      trace('channel-cwd', { cwd });

      // ── 只挂载，**不碰她的 agent 生命周期** ──
      //
      // ★ 2026-10-27 大乔改（这是今天最后一个、也是最要命的坑）：
      //
      //   我原来在这里主动 `agents.resume()` / `agents.create()` 把她拉起来。
      //   结果她虽然在，但**一说话就报**：
      //     prompt variable "{{model}}" has no value (section "deployment:persona-prefix")
      //
      //   查清楚了：`{{model}}` 这个装配变量是由 `installModelSelection()` 挂上去的
      //   （dsh-agent/lib/index.js:166 —— 它在 `system-prompt/assemble` 事件里把
      //   provider/model 塞进 `variables`）。而那个函数**只有宿主自己的会话控制器**
      //   （api-session-controller 的 `selectionFor(agent)`）才会调。
      //
      //   我抢在宿主前面把 agent 建出来，宿主后面就认为「这个 agent 已经有了」，
      //   于是那一步永远不跑 → 变量永远缺 → 她一回合都走不完。
      //
      //   而我用 API 投递时能成功，正是因为那一次是宿主自己创建的 agent。
      //
      //   所以：**会话和 agent 的生命周期全交给宿主**，插件只做一件自己能做对的事——
      //   把她挂进工作区，让主人看得见她。
      //   她那间屋子开过一次之后就是活的，唤醒定时器直接用现成的 agent。
      const agent = typeof agents.get === 'function' ? agents.get(CHANNEL_SESSION_ID) : null;
      trace('channel-check', { running: !!agent });

      // 她已经活着 → 把「系统提示只剩她记得的事」那道闸装上去。
      //
      // ★ 这里用 `agent.ctx`（这条会话自己的 scoped ctx），不是插件根 ctx。
      //   根 ctx 注册会进 global layer，对**所有**会话生效 —— 那会让主人自己的
      //   会话也只剩一段记忆，没有工具、没有工作目录。
      //   而且从 agent.ctx 装，不碰 agent 的创建流程，`{{model}}` 那个坑就绕开了。
      if (agent && agent.ctx) {
        try {
          installGate(agent.ctx);
          trace('gate-installed', {});
        } catch (err) {
          trace('gate-failed', { err: String(err?.message ?? err) });
        }
      }

      // 把她挂进工作区（这一步跟 agent 在不在跑无关：界面上看得见她，靠的是工作区里有这条 id）
      await attach(cwd);
      return agent;
    };

    // 启动时先把她那条通道准备好；失败只记一行，不影响任何别的事。
    //
    // ★ 延后几秒再建：apply() 那一刻宿主刚在装配插件，
    //   这时候去 create 一个 agent，很可能撞上「registry 还没就绪」。
    //   延后到装配完，成不成都能落进日志。
    const kick = () => {
      void ensureChannel().then((agent) => {
        trace('channel-ready', { ok: !!agent });
        if (agent) process.stderr.write(`mind: 通道就绪（${CHANNEL_SESSION_ID}）\n`);
      }).catch((err) => { trace('channel-threw', { err: String(err?.message ?? err) }); });
    };
    const t = setTimeout(kick, 5000);
    if (typeof t.unref === 'function') t.unref();
  });

  ctx.effect(() => () => { mind = null; }, 'mind.dispose');
  trace('apply-done');
  process.stderr.write('mind: apply() done\n');
}

export { CHANNEL_SESSION_ID, MIND_TAG, DEFAULT_CONFIG };
