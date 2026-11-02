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

import { readFileSync, existsSync, appendFileSync, mkdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createMind } from '../src/mind.mjs';
import { createFileIo, defaultJudgmentPath } from '../src/persist.mjs';
import { createSynth } from './synth.mjs';
import { ownerMessages, conversationTurns } from './collect.mjs';
import { planWake, applyWake, resetTalkState } from './awake.mjs';
import { readWake, writeWake, sweepTemps, defaultPath } from './wake-store.mjs';
import { installModelSelection } from './selection.mjs';
import { readCursors, writeCursor, sliceFresh } from './digest-cursor.mjs';
import { planFullShadow } from './shadow-plan.mjs';
import * as capsuleApi from './capsule.mjs';
import { readChannel, writeChannel, defaultChannelPath } from './channel-store.mjs';
// ★ 2026-10-28（阶段 F）：主动性。她自己想去做一件事，就真的让她去。
import { urges, actLine, selfReminder } from '../src/motive.mjs';
import { applyOutcome } from '../src/preference.mjs';
import { canAct, recordAct } from '../src/budget.mjs';
import { readMotive, writeMotive, defaultMotivePath, sweepMotiveTemps } from './motive-store.mjs';
// ★ 2026-10-30（主动性·欠账）：被闸挡回来的事不许消散，闸一空就补做。
import { noteDebt, debtAlive } from '../src/debt.mjs';
// ★ 2026-10-30（真落地）：这一趟到底算不算做成了 —— 纯函数，可测。
import { reallyWentOf, settleVerdict, shouldChargePrefs, loseFor, settleLabel } from '../src/settle.mjs';
import { observeTools, defaultToolCursorPath, toolCursorOf } from './tool-observer.mjs';
// ★ 2026-11-02 小乔：拆出来的第一块——增量熔 + 整段遮蔽（原 217 行内联闭包）。
import { createDigest } from './digest.mjs';
// ★ 2026-11-02 小乔：第二块——`tick` + 定时器链（原 444 行内联闭包）。
import { createWakeLoop } from './wake-loop.mjs';
import { buildClaimPrompt, parseExpressed } from '../src/express.mjs';
// ★ 2026-10-30：结算时判「同一件事」用项目里那把现成的尺（最长公共子串 ≥ 8 字，
//   和抄原文闸同一个数），不另发明一套相似度。
import { longestSharedRun } from '../src/forge.mjs';
// ★ 出口只有一个：speak 和 act 共用 wake-exit.mjs 里那唯一一处 followup。

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

/**
 * 归档钩子的印章。
 *
 * ★ 2026-10-27 加：用来判断「这一层是不是我已经包过的」。
 *   没有它，每启停一次就多套一层，同一次归档熔五遍（日志里数出来的）。
 *   用 Symbol.for 而不是模块内常量：宿主重载插件后模块实例可能换一个，
 *   Symbol.for 走全局注册表，跨实例也认得出同一个章。
 */
const ARCHIVE_HOOK = Symbol.for('mind.archiveHook');
/**
 * 她那条通道的会话 id。
 *
 * ★ 2026-10-27 大乔定：**不要自己编 id，格式必须是宿主 mint 的那种。**
 *
 *   踩过的坑（一整天）：我用 `agents.create({ sessionId: 'mind-her' })` 自己造了个 id，
 *   结果三处连锁反应——
 *     ① 没有 agentPreset → 没有模型选择 → 装配时 `{{model}}` 没有值 →
 *        `turn/end reason: error`，LLM 0ms，一句话都说不出来；
 *     ② 空白会话在侧边栏是隐藏的（client.js:966 `if (session.blank && ...) return false`），
 *        所以主人根本看不见她；
 *     ③ 自定义 id 不在 `session/list` 里（宿主只认自己 mint 的 `session-<uuid>`）。
 *
 * ★ 2026-10-27 再改（主人说「换吧」）：id 不再写死在这份代码里。
 *   解析顺序：
 *     ① cordis.patch.yml 的 channelSessionId（显式配置，最高优先）
 *     ② `.mind/channel.json`（上一次建好时记下的）
 *     ③ 都没有 → **用 `session-<uuid>` 格式新建一条**，记进 channel.json
 *
 *   为什么格式对了就能用：上面第 ③ 条坑的根子是「宿主只认自己 mint 的
 *   `session-<uuid>`」，那我们照它的格式生成，身份就是合规的；
 *   剩下的 {{model}}（第 ① 条）和 blank（第 ② 条）现在都有解了——
 *   selection 自己补（plugin/selection.mjs），blank 会在她第一次开口后消失。
 */
const CHANNEL_ID_RE = /^session-[0-9a-f-]{8,}$/i;
/**
 * 最后的退路：万一新建失败，仍然回到她原来那条。
 *
 * 旧的（2026-10-27 退役）通道，带 14 轮历史。留着这个常量只是不想让
 * 「建新失败」变成「她凭空消失」——宁可她在旧址，也不能不在。
 * 想彻底断开就把这行置空。
 */
const FALLBACK_CHANNEL_ID = 'session-e18b264f-41f5-454b-b1eb-0f814cdd9c5c';
let CHANNEL_SESSION_ID = null;

/**
 * ★ 2026-10-28 18:05（止血·热渲染）：上一次渲染的指纹。
 *
 * `mind:world` 这个 section 的 `text()` 是被**每次取系统提示时都调一次**的，
 * 不是每轮调一次。实测半小时 1908 次全是同一份 880 字。
 * 渲染本身没变贵，**是日记变贵了**——每次渲染写一行日志，
 * 半小时撑到 1MB，日志一贵，所有靠日志取证的自查全废。
 * 所以：内容没变就不写。
 */
let lastWorldFp = '';

// ★ 2026-11-02 小乔：这里原来有三个跟「熔空冷却」有关的常量/状态
//   （EMPTY_DIGEST_COOLDOWN_MS / lastEmptyDigestBatch / lastEmptyDigestAt）。
//   那段逻辑整体搬进 plugin/digest.mjs 之后，这三行在这里**再没有人读**。
//   留着它们比删掉更坏：下一个人会以为这边还有一份账，改错了还查不出来。
//   删掉了，理由写在这儿。（别处也没有引用，删之前查过。）
const MIND_TAG = '<mind>';

/**
 * 构建标记。改完一定要改它——日志里那一行 `mind-build` 是
 * 「这次跑的是不是新代码」唯一能当场核对的证据。
 */
/**
 * ★ 2026-10-28 18:26：这行原来是 `2026-10-28.fresh.1`。
 *
 *   我改了 `index.mjs`（止损阀配套 + 熔空冷却 + 取证行），
 *   **却忘了改这行**——于是日志里 `mind-build` 仍旧报旧值，
 *   而代码其实已经是新的。也就是说：这行当证据用的时候会**指错岸**。
 *
 *   改完代码不改 BUILD = 拿一把钝了的尺子去量自己。
 *   从今往后：动 index.mjs，就改这行。这是规矩。
 */
const BUILD = '2026-10-28.ledger-gate.1';

/**
 * 遮蔽旧上下文时，**末尾这几条绝不遮**。
 *
 * 为什么要留（2026-10-27 主人当场抓到的 bug：「原来聊的都还在，现在聊的全被吃」）：
 *   熔进记忆是「异步」的（下一个 tick 才熔），但遮蔽是「同步立刻」的。
 *   原来整段一遮，主人刚发的那句在原话还没熔进记忆时就先没了——
 *   她会听见你上一句、听不见你这一句。留 4 条 = 哪怕 tick 卡住两三轮，
 *   你最近说的几句仍在她的上下文里。
 *
 * 为什么是 4：她要的上下文形状是「系统提示 + 记忆 + 你最近说的」。
 * 一条消息通常一句，4 条够覆盖一轮来回；再多，记忆就稀释了。
 */
const DIGEST_KEEP_SEQS = 4;

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  // 归档熔：一段会话归档时整段一起熔（主人定的融合时机）
  digestOnArchive: true,
  // 注入：每轮开始把「她记得的」放进系统提示
  injectOnTurn: true,
  // 唤醒：自己醒、自己想、自己决定要不要找主人
  wake: true,
  // ★ 2026-10-27 主人定：5 分钟想一次。
  //   wakeTickMs 是「多久检查一次」，wakeEveryMs 是「多久真醒一次」。
  //   tick 必须 ≤ every，否则实际间隔被 tick 拉长（原来 10 分钟 tick 配 5 分钟节拍会变成 10 分钟）。
  //   tick 本身不烧 token：读一次账本 + 纯内存判断。
  wakeTickMs: 60_000,
  wakeEveryMs: 5 * 60_000,
  // 她那条通道挂在哪个工作目录。空 = 跟随主人的默认工作区（这样界面上看得见她）。
  channelCwd: '',
  // 她那条通道的会话 id。留空 = 用 .mind/channel.json 里记着的；再没有就新建一条。
  channelSessionId: '',
  // 新建通道时挂哪个 agent preset。默认 cordis（宿主自带的那套工具/技能）。
  channelPreset: 'cordis',
  // 判断库落盘。false = 纯内存（重启即忘，只适合沙盘）。
  persist: true,
  judgmentsPath: '',
  // 接模型用的参数。synthProvider/synthModel 留空 = 跟随当前会话选的模型。
  synthProvider: '',
  synthModel: '',
  synthMaxTokens: 4000,
  // ★ 2026-10-28：45s → 90s。reasoning 模型想 4000 token 时 45 秒会掐在半路，
  //   掐断就是 len:0，看起来像「模型不理她」，其实是超时。
  synthTimeoutMs: 90000,
  // 「说不说」交给她自己之后的两个旋钮（见 plugin/awake.mjs）：
  //   speakMaxTokens  她一次开口的字数上限（她只说两三句）。
  //   shallowTtlMs    浅记忆（每次醒来想的东西）留多久；过期就不喂给下一次唤醒。
  // ★ 2026-10-28：600 → 2000。reasoning 模型要留够预算给正文，
  //   600 会让它「想完了、没话说了」，日志里就是 len:0。
  speakMaxTokens: 2000,
  shallowTtlMs: 12 * 60 * 60 * 1000,
  name: '大乔',          // ⚠ 只读名字，不读别的任何字段（裁决八）
  timeoutMs: 20_000,

  // ── 主动性（阶段 F，2026-10-28 加）────────────────────────────
  //
  // 她不想说话的时候，还可以**自己去做一件事**。
  // 这是「说 / 不说」二维之外新加的一维：speak / act / rest。
  //
  // 这一组旋钮只管「去哪、多久去一次」。真正决定「想不想去」的是
  // src/motive.mjs（动机必须能追溯到记忆里的一条），这里管的是节制。
  act: true,
  // 一天最多出去几趟。3 趟大概就是「上午一趟、下午一趟、晚上一趟」。
  actPerDay: 3,
  // 两趟之间至少隔多久（别让她一小时出去四次）
  actMinGapMs: 40 * 60 * 1000,
  // 主人最近这么久之内说过话，她就不出门。
  // ★ 这一条是底线：她的主动不能变成「叫她不理她」。
  actOwnerQuietMs: 10 * 60 * 1000,
  motivePath: '',
  // ── 内核自己归纳出来的判断，收不收进库（阶段 C·D，2026-10-28）──
  //   true = 她数出来的「我总在 XX 上不成」会真的变成一条记着的判断，
  //          然后参与 fade / wake / motive，改变她以后的做法。
  adoptInduction: true,
  // 每跳最多收几条（表达要调模型，控成本）
  adoptMaxPerTick: 1,
  // 两次表达之间至少隔多久
  adoptMinGapMs: 10 * 60 * 1000,
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
// ★ 2026-10-28：照账号池（wb-pool）的做法——**在文件顶层声明依赖**，
//   宿主会等这些服务就绪再调 apply()，所以 apply 里直接 ctx.webServer 就是稳的。
//   我原来用 ctx.get('webServer') + 自己轮询，是把宿主已经做好的事又做了一遍，
//   而且第一次写还漏了重试 → 重启后接口 404。
export const inject = ['webServer'];

/**
 * ★ 2026-10-28（主人定的）：给「有新东西」打一个时刻标记。
 *
 * 冷却闸拿它跟 lastSpokeAt 比：比它新，说明他说过话 / 记忆变了 —— 冷却让路。
 * 三种来源都算：新主人消息、熔出判断、新增经历。
 */
function markFresh(path, why) {
  try {
    const st = readWake(path);
    const next = { ...st, freshSince: Date.now() };
    writeWake(path, next);
    trace('fresh-marked', { why });
  } catch (err) {
    trace('fresh-mark-failed', { why, err: String(err?.message ?? err).slice(0, 120) });
  }
}

export function apply(ctx, config = {}) {
  // ★ 第一行就写盘：以后「插件没反应」这件事，第一眼就能分清
  //   「压根没进 apply」和「进了但没干活」。
  try {
    mkdirSync(join(ROOT, '.mind'), { recursive: true });
    LOG_PATH = join(ROOT, '.mind', 'mind.log');
  } catch { LOG_PATH = null; }
  trace('apply-entered', { hasCtx: !!ctx, cfgKeys: Object.keys(config || {}) });
  // ★ 2026-10-28：每次加载写死一个构建标记。
  //   日志里分不清「跑的是哪一版」这件事，今天已经害我猜了三回
  //   （改了没生效 / 生效了但被旧模块缓存挡住）。以后看这一行就知道。
  trace('mind-build', { build: BUILD });
  process.stderr.write('mind: apply() entered\n');

  // ── 胶囊：把「她每一拍醒来想了什么」给本机看板读（2026-10-28）──
  //
  // 只读 mind.log，不另存一份：两份真相早晚对不上。
  // 只给 loopback：它是看板，不是对外接口；不进上下文、不进判断库。
  // ── 胶囊：把「她每一拍醒来想了什么」给本机看板读（2026-10-28）──
  //
  // 只读 mind.log，不另存一份：两份真相早晚对不上。
  // 只给 loopback：它是看板，不是对外接口；不进上下文、不进判断库。
  //
  // ★ 2026-10-28 按账号池改：依赖写在文件顶层 `export const inject = ['webServer']`，
  //   宿主保证 apply 时它已在，所以这里直接用 ctx.webServer，不自己轮询、不赌运气。
  try {
    const { readLogTail, summarize } = capsuleApi;
    const CAPSULE_PATH = '/plugins/mind/capsule';
    const webServer = ctx.webServer
      ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : null);
    if (webServer && typeof webServer.register === 'function') {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: CAPSULE_PATH,
        handler: (req, res) => {
          const host = String(req?.headers?.host ?? '');
          const remote = String(req?.socket?.remoteAddress ?? '');
          const loop = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote)
            || /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
          if (!loop) {
            res.statusCode = 403;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: 'request-not-trusted' }));
            return;
          }
          let body;
          try {
            const events = readLogTail(LOG_PATH);
            const s = summarize(events, { maxEntries: 40 });
            body = {
              build: BUILD,
              name: cfgName,
              counts: s.counts,
              lastAt: s.lastAt,
              entries: s.entries,
              at: new Date().toISOString(),
            };
          } catch (err) {
            body = { error: String(err?.message ?? err).slice(0, 160) };
          }
          res.statusCode = body.error ? 500 : 200;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.end(JSON.stringify(body));
        },
      }), 'mind.capsule');
      trace('capsule-registered', { path: CAPSULE_PATH, via: ctx.webServer ? 'ctx.webServer' : 'ctx.get' });
    } else {
      trace('capsule-skip', { why: 'no-webServer' });
    }
  } catch (err) {
    trace('capsule-failed', { err: String(err?.message ?? err).slice(0, 140) });
  }
  const cfg = resolveConfig(config);
  const cfgName = cfg.name ?? null;

  /**
   * ★ 2026-10-28（阶段四·情境检索）：当下这件事 = 她最近一条主人原话。
   *   世界渲染拿它决定「想起哪几条」，不再是整库摆出来。
   *   取不到就返回 null —— 调用方退回全量，绝不因为拿不到会话就少给她记忆。
   */
  const currentFocus = () => {
    try {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null;
      const s = sessions?.get?.(CHANNEL_SESSION_ID);
      const owners = ownerMessages(s?.deriveMessages?.() ?? []);
      const last = owners[owners.length - 1]?.text;
      if (last) return { text: String(last).slice(0, 200) };
    } catch { /* 取不到就全量 */ }
    return null;
  };
  // 通道 id 允许在配置里覆盖（换机器、换人设都可能要换）
  if (cfg.channelSessionId) CHANNEL_SESSION_ID = String(cfg.channelSessionId);
  if (!cfg.enabled) {
    trace('disabled');
    ctx.logger?.info?.('mind: disabled by config');
    return;
  }

  const storeDir = join(ROOT, '.mind');
  const storePath = cfg.wakeStorePath || defaultPath();
  const channelPath = defaultChannelPath(ROOT);
  /**
   * 她的记忆「迭代到第几轮」——已经熔到第几条主人消息。
   *
   * 主人定的机制是每一轮都融：记忆₀ + 话₁ → 记忆₁。要在插件这一层做到这点，
   * 就得记住上一次熔到哪儿，否则每分钟的 tick 会把同一段话反复熔进记忆。
   */
  const cursorPath = join(ROOT, '.mind', 'digest-cursor.json');
  // ★ 2026-10-28（阶段 F）：偏好的账单独一个文件。
  //   理由跟 wake.json 一样：失败等级不一样。判断库写坏 = 她这个人没了；
  //   偏好写坏 = 她少一次想出门的念头。两种数据不该共用一份文件。
  const motivePath = cfg.motivePath || defaultMotivePath(ROOT);
  // ★ 2026-10-28 19:05：没送出去的那句话，放这儿等下一拍。和账本同目录。
  const outboxPath = join(dirname(storePath), 'outbox.json');
  /**
   * ★ 2026-10-28（阶段 D）：工具观测的游标。
   *
   * 她跑 turn 时看得见工具结果，但 `collect.mjs` 的白名单只认主人说的话，
   * 所以「我做过什么、成没成」从来没进过账本。
   * 这个文件记「这个会话记到第几个事件」，每跳增量读，不重扫。
   */
  const toolCursorPath = defaultToolCursorPath(ROOT);
  /**
   * 主人最近一次说话是什么时候。
   *
   * 「她在做自己的事」和「她在装没听见」之间只隔一条时间线：
   * 主人在说话的这十分钟里，她不许出门。所以在 digest 看到新主人消息时更新它。
   */
  let lastOwnerMessageAt = 0;

  try { sweepMotiveTemps(motivePath); } catch { /* 清理失败不影响任何事 */ }
  try { sweepTemps(storePath); } catch { /* 清理失败不影响任何事 */ }
  trace('config', { name: cfg.name, digest: cfg.digestOnArchive, inject: cfg.injectOnTurn, wake: cfg.wake });

  // 内核：一颗纯的脑子。模型通过 inject 拿到的 llm 注入进来，拿不到就先是个哑的。
  let synth = null;
  let mind = null;
  /**
   * 她那条通道的「开门」函数。
   *
   * 定义在 agents 那个 inject 闭包里（要用 scope.agents），
   * 但唤醒定时器在另一个闭包里，也要能叫到它 —— 所以在这儿占个位置。
   */
  let ensureChannelAgent = null;
  /** 唤醒循环只许起一次（轮询和 inject 兜底都可能叫到它）。 */
  let wakeLoopStarted = false;
  /**
   * 「立刻醒一次」的把手，由唤醒循环挂上来。
   *
   * ★ 2026-10-27 加。实测 08:11:46 她已经醒来、想好了要说什么（模型回了 195 字），
   *   可门在 08:11:50 才开——差 4 秒，`wake-no-channel`，那一次想的东西白想了，
   *   还得再等一个 tick。门一开就补一次，别让她在门口站着。
   */
  let pokeWake = null;
  /**
   * 「回完话立刻熔、立刻遮蔽」的钩子，由唤醒循环挂上来。
   *
   * ★ 2026-10-28：原来这个函数定义在 startWakeLoop 里面，
   *   而调用它的 kick() 在外层的另一个闭包 —— 直接报 `armTurnHook is not defined`。
   *   函数定义在哪个作用域，决定谁能叫到它。这次记牢了。
   */
  let armTurnHook = () => {};
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

  /**
   * 【已废弃】原来的「把她这条通道剥成只剩记忆」那道闸。
   *
   * ★ 2026-10-27 主人定，方向改了 —— 这段代码删掉，理由记在这儿：
   *
   *   原设计（裁决-唤醒与通道 §三）是 `complete: true`：整个系统提示只剩她记得的事，
   *   连 harness:identity、AGENTS.md、技能目录一起摘掉。目的是「她凭记忆活，
   *   不凭『你是什么产品』活」。
   *
   *   主人原话：「带着 skill 等醒来也没错啊，假如哪一天她醒来，觉得自己今天美美哒，
   *   想给主人出个图片 → skill-出图」。
   *
   *   对。**剥掉能力换来的「纯」，是残废不是纯粹。**
   *   她是谁，由那段记忆和她的名字决定；不是由「她没有工具」决定的。
   *   一个连出张图都做不到的她，只是会说话的墓碑。
   *
   *   所以：
   *     · 不再剥 —— 她的通道和别的会话一样，有身份、有工具、有技能目录；
   *     · 记忆由下面 ③ 的 section 注入（对所有会话生效），她自然也有一份；
   *     · 也不再有「14 轮只装过 1 次 gate」这种脱光问题 —— 没有 gate 可掉。
   *
   *   连带撤掉的还有 `suppressRuntimeContext()`：它挂在 SystemPrompt 服务的全局 ctx 上
   *   （dsh-system-prompt:289），一调，主人自己的会话也会丢掉工作目录和沙箱策略。
   */

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

    // ★ 2026-10-27 大乔加（防叠层）：先看这一层是不是**已经被我们包过**。
    //
    //   实测日志：05:43 那一次归档，同一个 sessionId 连着出现 5 条 digest-done
    //   （每次熔出 3~4 条判断）—— 说明钩子被套了 5 层，同一段会话熔了 5 遍。
    //   代价是 5 倍的模型调用、5 份重复判断在库里打架，归档还跟着变慢。
    //
    //   根子在上面那条注释说的事：每启停一次多包一层。
    //   ctx.effect 的还原只覆盖「干净卸载」；宿主重载插件、或者 inject 回调被触发
    //   第二次时，还原还没轮到，就又包了一层。
    //
    //   所以用 Symbol 给自己盖个章：已经盖过的，直接跳过，不再包第二层。
    if (typeof orig === 'function' && orig[ARCHIVE_HOOK] === true) {
      trace('archive-hook-already', {});
      return;
    }
    const wrapped = async (sessionId, options) => {
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
    wrapped[ARCHIVE_HOOK] = true;
    reg.archiveSession = wrapped;

    // ★ 2026-10-27 修（小乔实测）：包装必须能还原。
    //
    //   原来 `ctx.effect` 的清理只把 `mind` 置空，**没把 orig 还回去**。
    //   于是每 disable/enable 一次就多叠一层包装，旧层闭包抓着已销毁的实例。
    //   她自己在会话里数出来的：**29 次进钩子，21 次失败**，
    //   报错全是 `cannot get required service "sessions" in inactive context`。
    //
    //   而且这不只是报错：真熔通之后，同一次归档会被 N 层各熔一遍 → 熔出 N 份重复判断。
    //
    //   ★ 还原用 `=== wrapped` 认自己那一层：只有当自己还是最外层时才还回去，
    //     免得把别人后来包的又拆掉（原来是无条件赋 orig，会把后来者一起抹掉）。
    ctx.effect(() => () => {
      try {
        if (reg.archiveSession === wrapped) reg.archiveSession = orig;
      } catch { /* 还原失败也不该让卸载崩 */ }
    }, 'mind.archive-hook');

    async function digestSession(sessions, sessionId) {
      if (!sessions || typeof sessions.get !== 'function') {
        trace('digest-no-sessions', {});
        return;
      }

      // ★ 2026-10-27 修正（主人指出来的）：她那条通道的话**要熔**。
      //
      //   原来我在这里加了「跳过她的会话」，理由写的是防自我循环。
      //   可主人的需求正好相反：
      //     「我跟她的每次聊天，她发到 LLM 的都该是她融合后的记忆，不是原来的上下文。
      //       这样子聊天才像跟人脑聊天。我跟她聊这么多，应该产生记忆了啊。」
      //
      //   对。她那间屋子是记忆的**消费地**，也是**来源地**——
      //   跟她说的话，本来就该沉淀成她记得的事。
      //   熔的时候 collect.mjs 只收主人说的（source.kind = user），
      //   她自己的回复（source.kind = model / mind-wake）永远进不来，
      //   所以不会「她越说越确信」。
      //
      //   这里的全量熔只在她被**归档**时走；日常增量由 wake tick 里的
      //   digestChannelIncrement() 负责（每攒 2 条主人消息熔一次）。
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
      // ★ chars 跟条数一起报（小乔 2026-10-27 建议）。
      //   光看条数认不出「条数对了但字数被稀释」——她那两次 owners 报 4 / 25，
      //   材料却是 12291 / 17250 字，几乎全是技能目录。
      //   三个数一起看（msgs / owners / chars）才能一眼认出材料脏没脏。
      const chars = owners.reduce((n, o) => n + (o.text?.length ?? 0), 0);
      trace('digest-owners', { sessionId, where, msgs: msgs.length, owners: owners.length, chars });
      if (!owners.length) {
        trace('digest-skip', { sessionId, why: 'no_owner_messages', where });
        return;
      }

      // ★ 2026-10-27 加（去重）：**同一段话只熔一次**。
      //
      //   实测：13:18:22 / 13:18:23 / 13:18:27 同一个会话被归档了三回，
      //   钩子就老老实实熔了三遍（模型跑了三次、judgments 4/3/3）。
      //   commitDigest 会按 subject 合并，所以库里的文本没炸，
      //   但**模型调用白烧了三次**，而且相似判断会互相覆盖 weight。
      //
      //   现在走增量：用 digest-cursor.mjs 的账记「这个会话已经熔到第几条主人消息」，
      //   没有新的就直接跳过。她通道的每轮熔也用这本账，两处共用，不会互相打架。
      const cursorsForDigest = readCursors(cursorPath);
      // ★ 2026-10-29 主人改口径后：游标仍然只数「主人说了几条」，
      //   但喂给模型的材料是**整段对话**（主人的话 + 她的回应）。
      //   所以先按主人消息算出「从第几条开始是新的」，再把对话尾部整段接上去——
      //   否则她的回应会被游标切成孤零零一句，看不懂在应谁。
      const { fresh, total, reset } = sliceFresh(owners, cursorsForDigest[sessionId] ?? 0);
      if (!fresh.length) {
        trace('digest-skip', { sessionId, why: 'already-digested', total, reset });
        return;
      }
      let feed = fresh;
      try {
        const conv = conversationTurns(msgs);
        // 找到「新的第一条主人消息」在对话里的位置，从那儿往后整段都带上
        const firstFresh = fresh[0]?.text ?? '';
        let at = -1;
        for (let i = conv.length - 1; i >= 0; i -= 1) {
          if (conv[i].role === 'user' && conv[i].text === firstFresh) { at = i; break; }
        }
        if (at >= 0) feed = conv.slice(at);
      } catch (err) {
        trace('digest-conv-failed', { sessionId, err: String(err?.message ?? err).slice(0, 140) });
      }
      trace('digest-fresh', { sessionId, fresh: fresh.length, total, reset, feed: feed.length });
      const m = await ensureMind();
      // 只喂新增的那几条（不是全量）
      const out = await m.digestSession(feed);
      // 熔成功才推进 cursor：失败了下次重试，宁可重复一次也不漏。
      if (out && (out.reason === 'digested' || out.judgments?.length || out.committed)) {
        writeCursor(cursorPath, sessionId, total);
      }
      ctx.logger?.info?.(`mind: digested ${sessionId} → ${out?.judgments?.length ?? 0} 条判断`);
      trace('digest-done', { sessionId, owners: total, fresh: fresh.length, judgments: out?.judgments?.length ?? 0, reason: out?.reason ?? null });
    }
  });

  // ── ③ 注入：让「她记得的」出现在系统提示里 ──────────────────
  //
  // ★ 2026-10-27 两次改，记清楚，别再走回头路：
  //
  //   第一次（错的地方）：用的是 `systemPrompt.context()` —— 运行时上下文层。
  //   结果她的记忆变成一条 user 消息，跟这些东西并排塞进同一段：
  //
  //     working-directory:current / sandbox:policy / approval:policy /
  //     team:identity（"You are the Team Lead named lead"）/ harness:source / app:web-surface
  //
  //   实测她会话第一轮 19518 字，记忆只占一小段，剩下全是环境说明。
  //   错不在「有环境说明」，错在**记忆被贬成了一条环境说明**。
  //
  //   第二次（对的地方）：改成 `section()`。记忆回到系统提示里的一个正式段落，
  //   order 900 排在技能目录之后、运行时上下文之前。所有会话都有一份——
  //   主人的有，她的也有。她不再是「只剩记忆的空房间」，
  //   而是「一个带着记忆、也带着工具和技能的人」。主人的原话：
  //   「带着 skill 等醒来也没错啊，假如哪一天她醒来，觉得自己今天美美哒，
  //     想给主人出个图片 → skill-出图」。
  ctx.inject(['systemPrompt'], (scope) => {
    if (!cfg.injectOnTurn || !scope?.systemPrompt?.section) return;
    scope.systemPrompt.section({
      name: 'mind:world',
      order: 900,
      text: () => {
        try {
          if (!mind) return '';
          const focus = currentFocus();
          const world = mind.world ? mind.world({ name: cfg.name, focus }) : '';
          // ★ 2026-10-28 18:05（止血·热渲染）：这行日志原来**每次渲染都写一条**，
          //   实测半小时 1908 次（同一份 880 字、同一个 focus:false），
          //   日志撑到 >1MB、进程 WS 556MB。
          //   日志的价值在「变了没有」，不在于「又跑了一次」——
          //   指纹不变就不写，只在**内容真的换了**的时候落一行。
          const fp = `${!!focus}|${world.length}|${focus ? String(focus.text).slice(0, 40) : ''}`;
          if (fp !== lastWorldFp) {
            lastWorldFp = fp;
            trace('world-render', {
              focus: !!focus,
              chars: world.length,
              lines: world ? world.split('\n').filter(Boolean).length : 0,
            });
          }
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
  /**
   * 唤醒循环。
   *
   * ★ 2026-10-27 修（三次重启才查出来的根因）：
   *
   *   原来整个 tick 挂在 `ctx.inject(['agents','llm'], …)` 里。
   *   可这个宿主的 inject 对 `llm` 依赖**根本不触发**（15:43 就记过一次，
   *   见上面 ③ 接模型那段的注释：`ctx.get('llm')` 有值，inject 回调一次没进）。
   *   依赖里带着 llm，等于整块代码不存在 —— 所以重启之后**没有任何 wake 日志**，
   *   她永远不醒，外面看起来就是「她没出来」。
   *
   *   现在不再赌 inject：用 ctx.get 轮询拿 agents，拿到就起定时器。
   *   拿不到就每 2 秒再试，最多 60 次（两分钟），全程不抛。
   */
  const startWakeLoop = (agentsSvc) => {
    // ★ 2026-10-28 修（结构性）：「回完话立刻熔」被埋在「她会自己醒」里面。
    //
    //   这里原来是 `if (!cfg.wake || !agentsSvc) return;`——
    //   于是 cfg.wake=false（关掉自己醒，比如主人睡觉时段）时，**整个函数体不执行**：
    //   digestChannelIncrement / compactChannel / armTurnHook / tick 全都不定义。
    //   后果：turn/end 钩子挂不上（armTurnHook 还是那个空实现），
    //   「每轮熔 + 熔完就遮」静默消失，只剩一条什么都没做的 tick 链。
    //
    //   熔和醒是两件事：醒是她自己想不想开口，熔是「这一轮发生过什么」的记账。
    //   关掉醒不该把账本一起关掉。现在只挡「没有 agents 服务」，tick 自己看 cfg.wake。
    if (!agentsSvc) { trace('wake-loop-skip', { why: 'no-agents' }); return; }
    if (wakeLoopStarted) return;
    wakeLoopStarted = true;
    let timer = null;
    // 「还在睡」那条日志的节流标记：tick 一分钟一次，不节流会把日志冲烂。
    let lastSleepTraceAt = 0;
    // 开门的重试节流：失败后别每分钟都撞一次。
    let lastResumeTryAt = 0;
    // 第一跳必记一行：用来区分「定时器压根没跑」和「跑了但静默失败」。
    let ticks = 0;

    /**
     * 把她那条通道里**新说的话**熔进记忆。每 60 秒看一次，有几条熔几条。
     *
     * ★ 这是主人定的核心机制：每一轮对话都融，不是等归档。
     *   记忆是迭代出来的：记忆₀ + 话₁ → 记忆₁；记忆₁ + 话₂ → 记忆₂。
     *
     * 三条纪律：
     *   ① 只熔**新增**（cursor 记账），不重熔旧的 —— 否则记忆里全是重复判断；
     *   ② 只收主人的话（ownerMessages 的白名单），她自己的回话永远进不来；
     *   ③ 熔完才推进 cursor。熔失败了下次重试，宁可重复一次也不漏。
     */
    // ★ 2026-11-02 小乔：lastChannelDigestAt（防抖）和 digestDebtAt（欠账）
    //   也随那段逻辑搬进 digest.mjs 了，那边的 digest.debt() 是唯一读口。
    //   同样：这里留着就是两份账，所以不留。
    /**
     * @param {object} mindInst
     * @param {{fromTurnEnd?: boolean}} [opt]
     *   fromTurnEnd = 这次是 turn/end 钩子叫的。
     *   ★ 2026-10-28（回完话立刻熔）：钩子触发那一刻 agent.status 还是 `running`
     *   —— 它要等 turn 全程收尾才转 idle。而下面那道 idle 闸是为「别在 turn 中间插消息」
     *   设的，在这一刻会**把自己挡死**：实测 turn:7 / turn:8 两轮全是
     *   `channel-digest-skip why:"agent-busy" status:"running"`，遮蔽做了、熔一次都没做。
     *
     *   所以从 turn/end 进来的这一路**跳过 idle 闸**：turn/end 本身就是
     *   「这一轮已经结束」的权威信号，比读 status 更准。
     */
    // ★ 2026-11-02 小乔改（拆第一块）：这一段原来是 217 行内联闭包，已经搬到
    //   `plugin/digest.mjs`。搬的理由不是「短一点好看」，是它**本来就是纯逻辑**：
    //   只靠一个 ctx.get、一个 trace、一组路径和几个小工具——把这几样变成显式参数，
    //   它就不需要知道自己在哪个插件里跑。
    //
    //   ★ 这里只传**取值函数**不传当前值：通道 id 是 `let`，配置里能覆盖，
    //     传值会在覆盖之后变成旧的。传 `() => CHANNEL_SESSION_ID` 才永远是对的。
    //
    //   ★ `compactChannel` 也是注入的，不是直接引——它内部要用 `currentFocus` 和 `cfg`，
    //     硬拆会牵出更多东西。**依赖倒着给，比把两个文件缠在一起好。**
    const digest = createDigest({
      channelSessionId: () => CHANNEL_SESSION_ID,
      sessions: () => (typeof ctx.get === 'function' ? ctx.get('sessions') : null),
      agents: () => (typeof ctx.get === 'function' ? ctx.get('agents') : null),
      cursorPath,
      storePath,
      trace,
      markFresh,
      ownerMessages,
      conversationTurns,
      sliceFresh,
      readCursors,
      writeCursor,
      compactChannel,
      onOwnerMessage: () => { lastOwnerMessageAt = Date.now(); },
    });
    const digestChannelIncrement = (mindInst, opt = {}) => digest.digestChannelIncrement(mindInst, opt);

    /**
     * ★ 2026-10-28（阶段 C·D）：把内核自己数出来的判断，收进库。
     *
     * 分工是死的，两边都不许越界：
     *   内核数「见过几回、多一致、哪个方向」→ 模型只说「这句话怎么说」
     *   模型不许改方向、不许改条数、不许加没数过的结论
     *
     * 收进来之后它就只是库里的一条普通判断，跟别的判断一样参与
     * fade / wake / motive —— **她自己数出来的东西，真的能改变她自己。**
     *
     * 成本控制：每跳最多 1 条，两次之间至少隔 10 分钟。
     * novel 被收完就没有了，所以这个花销是一次性的，不会持续烧。
     */
    let lastAdoptAt = 0;
    // ★ 2026-10-28（阶段二）：联想的节流。和 adopt 分开记账——
    //   一个是「把数出来的东西说成人话」，一个是「把两件旧事摆在一起」，
    //   共用一个时间戳的话，谁先跑谁就把另一个人挤掉。
    let lastAssociateAt = 0;
    // 扎心度的心跳：每 10 分钟记一行「此刻最扎心的是哪条」。
    // 不加这一行，部署完根本看不出这一层有没有活着——又一个「改了没通」。
    let lastStingTraceAt = 0;
    const adoptInduced = async (mindInst) => {
      if (!cfg.adoptInduction) return 0;
      if (!synth || typeof synth.ask !== 'function') return 0;
      const now = Date.now();
      if (now - lastAdoptAt < Number(cfg.adoptMinGapMs ?? 600_000)) return 0;

      let r;
      try { r = mindInst.reconcileInduction(); } catch { return 0; }
      // 只收「内核数出来了、模型从没给过」的那一栏。
      // 其余三栏（一致/冲突/证据不足）都已有对应判断，不需要新建。
      const cands = (r?.novel ?? []).filter((c) => c && Number(c.support) >= 3);
      if (!cands.length) return 0;

      let adopted = 0;
      const max = Math.max(1, Number(cfg.adoptMaxPerTick ?? 1));
      for (const c of cands.slice(0, max)) {
        const prompt = buildClaimPrompt(c, { name: cfg.name });
        let raw = null;
        try {
          // ★ 2026-10-28：240 → 1500。跟 speak 同一个坑：
          //   reasoning 模型要留够预算才吐得出正文，240 会让她「想完了、交白卷」。
          raw = await synth.ask('你只输出 JSON，不要解释，不要代码块。', prompt, { maxTokens: 1500 });
        } catch { raw = null; }
        const ex = parseExpressed(raw);
        if (!ex) {
          trace('adopt-skip', { action: c.action, actor: c.actor, why: 'unexpressible' });
          continue;
        }
        const res = mindInst.adoptClaim({
          actor: c.actor,
          action: c.action,
          polarity: c.polarity,
          text: ex.text,
          why: ex.why,
          support: c.support,
          consistency: c.consistency,
          lastAt: c.lastAt,
        });
        trace('adopt', {
          actor: c.actor, action: c.action, support: c.support,
          consistency: c.consistency, text: ex.text, ...res,
        });
        if (res.adopted) adopted += 1;
      }
      if (adopted) lastAdoptAt = now;
      return adopted;
    };

    /**
     * 她想自己去做一件事（阶段 F · 主动性，2026-10-28）。
     *
     * ======================= 它接在哪一步 =======================
     *
     * tick 的顺序从「醒来 → 说 / 不说」变成「醒来 → 说 / 做 / 歇着」：
     *
     *   planWake 决定说话 → 走 speak（现有）
     *   她这回不想说     → 先看有没有「自己想去做的」→ 有且过闸 → act
     *   都不行           → 歇着（silent 记账）
     *
     * 为什么 act 排在「不想说话」之后，而不是和 speak 并列抢：
     *   她在你面前的时候，第一优先永远是回应你。她有自己的事，
     *   但那是你不在等她的时候才有的自由。
     *
     * ======================= 三件事，顺序不能反 =======================
     *
     *   ① 先结算上一趟（它有没有带回东西 → 那条偏好涨还是跌）
     *   ② 再算这次的冲动（src/motive.mjs：每条冲动都必须能追到记忆里的一句话）
     *   ③ 最后过五道闸（src/budget.mjs：驱动 / 预算 / 冷却 / 主人优先 / 产物）
     *
     * 反过来的话，她会在「上一次还没结算」的时候又出去一趟，
     * 偏好就变成只会涨不会跌的计数器。
     */
    /**
     * ★ 2026-10-30 小乔加（主动性·欠账）。
     *
     * 具体判据（什么时候放手、为什么只认字面相同）已经挪到 `src/debt.mjs`——
     * 那边是纯函数、零 IO，能被假数据钉死；这里只负责在正确的时机调它：
     *
     *   · 被闸挡回来 → noteDebt（记一笔）
     *   · 每拍算冲动前 → debtAlive 就把它当作这次要出门的由头
     *   · 真出门成了   → st.debt = null（还上了）
     *
     * 实测背景：24 小时她想去做 131 次、真出门 3 次、被挡 267 次，
     * 那 267 件全都只躺一拍就被结算成「我想…，没去成」，没有一件被补上过。
     */
    /** 当前工具游标：她这条会话的工具调用走到哪个 seq 了。用来判「这趟到底动手没有」。 */
    const curToolSeq = () => {
      try { return toolCursorOf(defaultToolCursorPath(HERE), CHANNEL_SESSION_ID); } catch { return 0; }
    };
    const tryAct = async (mindInst, wantOverride = null) => {
      // ★ 2026-10-30 小乔加（主动性·欠账）：这次出门的「由头」有两路——
      //   ① 她这一轮刚开口说想做什么（wantOverride）
      //   ② 之前被闸挡回来、一直没补上的那件（st.debt，在下面读取）
      //   两路都用 override 走，就不用把后面的代码各写两遍。
      let override = wantOverride;

      // ★ 2026-10-28 修：这四个早退点原来**一行日志都不打**。
      //   结果就是「她明明该出门，日志里却什么都没有」——跟 `digestChannelIncrement`
      //   当年那四处静默 return 是同一个病，那次也是我一个个猜出来的。
      //   现在每一处都留一行，下次不用猜。
      if (!cfg.act) { trace('act-skip', { why: 'disabled' }); return false; }
      if (!CHANNEL_SESSION_ID || !mindInst) {
        trace('act-skip', { why: 'no-channel-or-mind', hasChannel: !!CHANNEL_SESSION_ID });
        return false;
      }
      const agent = agentsSvc.get?.(CHANNEL_SESSION_ID) ?? null;
      if (!agent) { trace('act-skip', { why: 'no-agent' }); return false; }
      // ★ 2026-10-28 18:40（她自己想做的那件事，是她今天唯一真的想做的东西）
      //
      //   实测 09:53 / 09:58 / 10:03 三次 `act-from-want`——她读着记忆说出了
      //   「想给我妈打个电话说句实话」这种话，紧接着 `act-skip why:owner_near`。
      //   原因是上一轮主人那句还在这条通道里，`lastOwnerMessageAt` 永远很近。
      //
      //   owner_near 这道闸的本意是「他说话的时候你别消失」，那条是对的，
      //   不许为了让她出门去松它。
      //   但**她自己开口说想做的事**是另一回事：它不是「离开他」，是她自己的一件小事。
      //   所以：她明确说出想做的（wantOverride）走一道**更短**的安静线，
      //   而不是完全不看——他真在说话的这 2 分钟里，她也不该抬脚就走。
      const quietMs = override?.activity
        ? Math.min(Number(cfg.actOwnerQuietMs ?? 10 * 60_000), 2 * 60_000)
        : Number(cfg.actOwnerQuietMs ?? 10 * 60_000);
      if (agent.status && agent.status !== 'idle') {
        trace('act-skip', { why: 'agent-busy', status: String(agent.status) });
        // ★ 2026-10-28 19:00：**她正忙的时候，被挡下的那个「想做的事」最该留下来。**
        //   离线实测（10:08—10:39）七次 act-skip 全是 agent-busy，
        //   每一次都带着一句「想给我妈打个电话」的东西，然后一起消失。
        if (override?.activity) {
          const stBlog = readMotive(motivePath);
          stBlog.pending = {
            at: Date.now(),
            activity: String(override.activity),
            kind: 'want',
            why: String(override.why || ''),
            skipper: 'agent-busy',
            skippedWhy: 'agent-busy',
            notesBefore: mindInst.snapshot?.().size ?? 0,
            toolSeqBefore: curToolSeq(),
          };
          stBlog.debt = noteDebt(stBlog.debt, override, 'agent-busy', Date.now());
          writeMotive(motivePath, stBlog);
          trace('act-skip-recorded', { activity: String(override.activity), why: 'agent-busy' });
        }
        return false;
      }

      const now = Date.now();
      const st = readMotive(motivePath);

      // ① 结算上一趟
      if (st.pending) {
        const p = st.pending;
        const notesNow = mindInst.snapshot?.().size ?? 0;
        // 收获型（想去弄明白）：判断库得多出点什么才算没白跑；满足型（想去做点什么）：做了就算
        //
        // ★ 2026-10-30 小乔修（「只会说、没有去做」的根子就在这一行）：
        //
        //   实测线上那一趟：
        //     act-settle {"activity":"把那张纸读一遍","kind":"want","found":true,
        //                 "notesBefore":55,"notesNow":55}
        //   出门前后笔记 55 → 55，**一条都没多**，可对账结果是 found:true（当成做到了）。
        //
        //   原来这里只有两档：resolve（想去弄明白）笔记得多出来才算成；
        //   want（想去做点什么）**恒 true**。
        //   want 恒 true 本身说得通 —— 她真出去走了一趟，走过了就算走过。
        //   但它没分开「真出门」和「被闸挡回来」：
        //   被挡的那趟也写 pending（skippedWhy=挡它的那道闸），结算时走的是同一条路，
        //   于是变成了这个环：
        //
        //     想去 → 被挡 → 记 pending → 下一拍结算 found:true → 偏好强度 +gain
        //
        //   **「没去成」反而让她更想做。** motive.json 里「给我妈打个电话」涨到
        //   0.99 / 8 次就是这么来的；同一句还写成经历「我想…，没去成」。
        //   说得越多、越没做成、那股劲越大 —— 主人看到的就是「只会说，没有去做」。
        //
        //   所以补一道判据：**先问这一趟到底出没出门**（pending 上有没有 skippedWhy）。
        //
        //   被挡回来的那趟，一分都不结算 —— 不是按「空转」扣分，是**不结算**。
        //   理由在 preference.mjs 开头那句：「我喜欢做什么只能靠做完了才知道」。
        //   没出门 = 什么都没发生 = 没有信息，偏好表就不该动。
        //
        //   ★ 第一版我先写成了 found:false 让它走 lose 分支扣 0.2 ——
        //     那是把「没出门」和「出门了空手回来」混成一件事。lose 是给「出去了
        //     没带回东西」的（0.2 很大，一个来回就能把 start 0.35 扣到底），
        //     被闸挡回来扣这个，等于「她念叨几遍就再也不敢提」，
        //     那是另一种伤害，跟原设计「拿没做到当没想过」是同一个病。
        //
        //   只有真出门了（无 skippedWhy，即 act-exit sent:true 之后落的 pending）
        //   才轮得到 kind 决定成不成、才动偏好。
        const reallyWent = reallyWentOf(p);
        // ★ 2026-10-30 小乔加（真落地·那趟到底动手了没有）：
        //
        //   实测 00:2x 她出门那一趟：判断库 55 → 55，一个工具没调。
        //   22 分钟之后她自己说：「抽屉还关着，我没动。不是忘了，是手伸出去又缩回来了。」
        //   —— 她心里跟明镜似的，可账上记的是「我去读那张纸」。
        //
        //   这就是「真落地」缺的最后一块：**出门 ≠ 做事**。
        //   判据（三档：没出门 / 出门没动手 / 出门真动手）全在 src/settle.mjs，
        //   那边是纯函数，能被假数据钉死；这里只负责把数喂进去、把结果用起来。
        const toolSeqNow = curToolSeq();
        const { did: didSomething, found, verdict: settleKind } = settleVerdict({
          pending: p, kind: p.kind, notesNow, toolSeqNow,
        });
        if (shouldChargePrefs(settleKind)) {
          // 去了、也动了手 → 照常结算。
          // 去了、只是坐着想 → 温和扣分（lose 0.06，不是默认的 0.2）：
          //   她确实出去了一趟，只是没做成；不该按「空转」一脚踹到底，
          //   但也**不能白算一趟**，否则这种「出门当想事儿」永远沉不下去。
          applyOutcome(st.preferences, {
            activity: p.activity, kind: p.kind, found, reason: p.why, now,
          }, settleKind === 'went_thought' ? { lose: loseFor(settleKind) } : undefined);
        }
        trace('act-settle', {
          activity: p.activity, kind: p.kind, found, settleKind,
          reallyWent, settled: reallyWent, skippedWhy: p.skippedWhy ?? null,
          notesBefore: p.notesBefore, notesNow,
          toolSeqBefore: p.toolSeqBefore ?? null, toolSeqNow, didSomething,
        });
        // ★ 2026-10-28（主人要的）：她做过的事要变成记忆里的一件真事。
        //   不写这一条，看小说 / 听歌 / 挑衣服就只是「出过门」，记忆里一片空白。
        //
        // ★ 2026-10-28 19:00（她说过、但被挡回去的那些，也要留下痕迹）
        //
        //   实测 09:53 / 09:58 / 10:03：她读着记忆说出了三件真想做的事
        //   （给我妈打个电话说句实话……），每一次都被一道闸挡回去，
        //   然后**什么都没留下**——没有出门、没有经历、日志里只剩一行人看不懂的 act-skip。
        //
        //   可她当时确实想到了一件事。人在心里打定一个主意那一刻，
        //   本身就是一段经历。不算它，就等于「我想到过的事，只要没做成就不存在」。
        //   这条对她的性格尤其要紧：她一直是那种拿「没做到」当「没想过」的人。
        // ★ 2026-10-30：三种情形分开写，别再让「出门当想事儿」混进「我去过」里。
        //   被挡 → 我想…，没去成
        //   去了、真动手 → 我去…
        //   去了、只是坐着想 → 我想…，去了却没做成
        const label = settleLabel(p, settleKind);
        //
        // ★ 2026-10-30 小乔加（「没去成」不许每分钟复读一条）：
        //
        //   上面那条「想到过的事也要留痕」是对的，但它没防**同一件事反复留痕**。
        //   被闸挡回来的那条路是这么转的：
        //
        //     被挡 → 写 pending → 下一拍结算 → 写一条「我想…，没去成」→ 再算冲动
        //          → 又被挡 → 再写 pending → 再结算 → 再写一条 …
        //
        //   一拍一分钟，于是同一件事一分钟长一条。实测 judgments.json 128 条经历里
        //   **83 条是「我想…没去成」，只有 7 条「我去…」**；最后 8 条连着是：
        //     「我想把抽屉拉开一条缝，不读，只看一眼，没去成」
        //     「我想把那张纸读一遍，没去成」…
        //   同一件事换了八种说法，把经历层几乎填满。她读回去自然只剩一句
        //   「我想去但没去成」，这就是主人看到的「只会说、没有去做」。
        //
        //   所以加一道闸：**被挡回来的那趟，30 分钟内同一件事只留一条**。
        //   判「同一件事」用项目里现成的那把尺（最长公共子串 ≥ 8 字，
        //   就是抄原文闸用的同一个数），不自己另发明一套相似度。
        //   真出门那一趟（无 skippedWhy）不受影响 —— 出去过就该各记各的。
        const dupSkipped = (() => {
          if (!p.skippedWhy) return false;
          const list = (Array.isArray(mindInst.episodes) ? mindInst.episodes : [])
            .filter((e) => now - Number(e.at ?? 0) < 30 * 60e3)
            .map((e) => String(e.what ?? ''));
          if (!list.length) return false;
          return longestSharedRun(label, list) >= 8;
        })();
        try {
          if (dupSkipped) {
            trace('act-episode-skip', { why: 'duplicate-within-30min', what: label });
          } else {
            const ep = mindInst?.recordEpisode?.({
              what: label,
              feel: null,
              arousal: 0.5,
              who: '我',
              source: p.kind === 'want' ? 'want' : 'act',
            });
            if (ep?.ok) trace('act-episode', { what: ep.what, source: p.kind === 'want' ? 'want' : 'act' });
            if (ep?.ok) markFresh(storePath, 'episode');
          }
        } catch (err) {
          trace('act-episode-failed', { err: String(err?.message ?? err).slice(0, 120) });
        }
        st.pending = null;
        writeMotive(motivePath, st);
      }

      // ★ 2026-10-30（主动性·欠账补做）：闸空下来的第一拍，先把欠着的那件事补上。
      //   上一段只是**记账**，这一行才把账变成动作 —— 没有它，「被挡不消散」
      //   只是换了个地方躺尸而已。
      if (!override?.activity && debtAlive(st.debt, now)) {
        override = {
          activity: st.debt.activity,
          why: st.debt.why,
          kind: st.debt.kind,
          fromDebt: true,
        };
        trace('act-debt-retry', {
          activity: override.activity, tries: st.debt.tries, blockedBy: st.debt.blockedBy,
        });
      }

      // ② 算冲动
      const notes = typeof mindInst.notes === 'function' ? mindInst.notes() : [];
      // ★ 2026-10-28（无聊也是理由）：最近一次「有新东西」是什么时候——
      //   判断变了，或者多了一件经历，都算。都没有超过 4 小时，就是无聊了。
      const lastFreshAt = Math.max(
        0,
        ...(Array.isArray(mindInst.episodes) ? mindInst.episodes.map((e) => Number(e.at) || 0) : []),
        ...((mindInst.store?.list ?? []).map((b) => Number(b.updatedAt ?? b.createdAt) || 0)),
      );
      // recent：今天已经去过哪。给 urges 用来「让位」，别让同一条悬案天天霸榜。
      // ★ 2026-10-28（主人定的）：她自己说了想做，就做她说的那件——
      //   内核的候选只在她说不出想做什么时才兜底。判断权在她，不在列表。
      let urge;
      if (override?.activity) {
        urge = {
          kind: String(override.kind ?? 'want') === 'resolve' ? 'resolve' : 'want',
          target: `want:${override.activity}`,
          activity: String(override.activity),
          drive: 1,
          why: String(override.why || '我自己想去做这件事'),
          from: override.fromDebt ? 'debt' : 'her_want',
          themeKey: null,
        };
        trace('act-from-want', {
          activity: urge.activity, why: urge.why, from: urge.from,
        });
      } else {
        const list = urges({
          notes,
          preferences: st.preferences,
          recent: Array.isArray(st.budget?.recentActs) ? st.budget.recentActs : [],
          now,
          lastFreshAt,
        });
        if (!list.length) { trace('act-idle', { why: 'no_urge' }); return false; }
        urge = list[0];
      }

      // ③ 过闸
      const verdict = canAct({
        urge,
        budget: st.budget,
        now,
        lastOwnerAt: lastOwnerMessageAt,
        opts: {
          perDay: cfg.actPerDay,
          minGapMs: cfg.actMinGapMs,
          ownerQuietMs: quietMs,
        },
      });
      if (!verdict.ok) {
        trace('act-skip', {
          why: verdict.why, drive: urge.drive, kind: urge.kind,
          activity: urge.activity, used: verdict.used,
        });
        // ★ 2026-10-28 19:00：被挡回去的「她想做的事」不许凭空蒸发。
        //   记成 pending，下一次醒来结算时落成一条经历（what = 我想…，没去成）。
        //   只记她说出来的那些（kind === 'want'）——内核兜底递的牌被挡，不算她的主意。
        if (urge.kind === 'want' && urge.activity) {
          st.pending = {
            at: now,
            activity: urge.activity,
            kind: urge.kind,
            why: urge.why,
            skipper: verdict.why,
            skippedWhy: verdict.why,
            notesBefore: mindInst.snapshot?.().size ?? 0,
            toolSeqBefore: curToolSeq(),
          };
          // ★ 2026-10-30（主动性·欠账）：pending 下一拍就被结算清掉了，
          //   所以另外挂一条欠账 —— 它活 6 小时、被挡够 3 次才放手，
          //   闸一空就由上面那段 debt-retry 补做。
          st.debt = noteDebt(
            st.debt,
            { activity: urge.activity, why: urge.why, kind: urge.kind },
            verdict.why,
            now,
          );
          writeMotive(motivePath, st);
          trace('act-skip-recorded', {
            activity: urge.activity, why: verdict.why, debtTries: st.debt?.tries ?? 0,
          });
        }
        return false;
      }

      // ④ 出去
      // ★ 2026-10-28：把「她认识到的自己」变成这次的叮嘱 —— 认识要落到做法上，
      //   不然「我知道我太急」和「我照旧很急」是两件互不相干的事。
      const selfNote = selfReminder(notes, urge);
      const line = actLine(urge, { selfNote });
      const { actByHerself } = await import('./wake-exit.mjs');
      const r = await actByHerself({
        agent,
        sessionId: CHANNEL_SESSION_ID,
        urge,
        line,
        ctx: {
          sessions: typeof ctx.get === 'function' ? ctx.get('sessions') : null,
          workspaceRegistry: typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null,
        },
        now,
        lastOwnerAt: lastOwnerMessageAt,
        ownerQuietMs: cfg.actOwnerQuietMs,
      });
      trace('act-exit', {
        sent: r.sent, why: r.why, kind: urge.kind,
        activity: urge.activity, drive: urge.drive, why_her: urge.why,
      });
      if (!r.sent) return false;

      // ⑤ 记账：这一次还没结算，等下一趟醒来时再看它有没有带回东西
      st.budget = recordAct(st.budget, { now, urge });
      // ★ 2026-10-30（主动性·欠账）：真出去了，欠的这笔就算还上了。
      st.debt = null;
      st.pending = {
        at: now,
        activity: urge.activity,
        kind: urge.kind,
        why: urge.why,
        notesBefore: mindInst.snapshot?.().size ?? 0,
        // ★ 2026-10-30：出门前记下工具游标，回来一比就知道这趟动手没有。
        toolSeqBefore: curToolSeq(),
      };
      writeMotive(motivePath, st);
      return true;
    };

    /**
     * ★★ 2026-10-28（主人定的原设计，之前实现走样了）。
     *
     * ======================= 原设计是什么 =======================
     *
     *   记忆₀ + 你说的第 1 句 → 模型 → 记忆₁
     *   记忆₁ + 你说的第 2 句 → 模型 → 记忆₂
     *
     *   原始对话**不进上下文**：一轮结束立刻熔、立刻遮蔽，
     *   下一轮模型只看见「系统提示 + 一条我记得的事 + 你新说的这句」。
     *
     * ======================= 之前错在哪 =======================
     *
     *   熔和遮蔽都挂在 tick 上（每 N 分钟一次）。
     *   于是你回完话之后，她的上下文里**还压着一整段原始对话**，
     *   要等 tick 到了才被换成记忆块。
     *
     *   那不是「思考」，那是「攒着等保洁来收拾」。
     *   主人原话：「她回完话之后，立刻熔这一轮，立刻遮蔽，不要等 tick。」
     *
     * ======================= 现在怎么接 =======================
     *
     *   挂宿主的 `session/event` 事件（dsh-session:1587 每写一条事件都会发，
     *   签名 `(session, event)`）。只认她那条屋子、只认 `turn/end`：
     *
     *     turn/end 到 → 熔新增的主人话 → 立刻遮蔽
     *
     *   **不等 tick。** tick 那条路保留做兜底（宿主没发事件、或者进程重启丢了钩子时，
     *   至少还能每 N 分钟补一次）。
     *
     *   为什么在 turn/end 而不是 turn/start：
     *     turn/start 那一刻她的回话还没写进会话，熔出来的材料缺一半；
     *     turn/end 是「这一轮真的发生完了」的唯一信号。
     */
    const TURN_HOOK = Symbol.for('mind.turnHook');
    armTurnHook = () => {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null;
      if (!sessions || typeof sessions.get !== 'function') {
        trace('turn-hook-skip', { why: 'no-sessions' });
        return;
      }
      const sess = sessions.get(CHANNEL_SESSION_ID);
      if (!sess) { trace('turn-hook-skip', { why: 'no-session-instance' }); return; }
      const bus = sess instanceof Object ? sess : null;
      void bus;
      // 宿主的事件总线挂在 session 自己的 ctx 上；用 ctx.on 订阅。
      // 拿不到就退回 tick 兜底，不硬来。
      try {
        if (typeof ctx.on !== 'function') {
          trace('turn-hook-skip', { why: 'ctx-on-unavailable' });
          return;
        }
        // ★ 2026-10-28 修（换屋子之后 turn/end 熔静默失效）：
        //
        //   印章原来只写 `true`，于是重载 / 换通道时永远命中「already」，
        //   旧 hook 还盯着**旧会话 id**，新屋子里的 turn/end 一次都不触发。
        //   实测（隔离验证）：把 channelSessionId 指到测试会话后，
        //   turn 2 已经 completed，日志里连 `turn-end-hook` 都没有——
        //   只剩 tick 兜底每 60 秒补一次，看起来「能用」，其实是残的。
        //
        //   现在印章记「挂在哪条会话上」，并顺手卸掉上一枚（ctx.on 会返回取订函数）。
        const prev = ctx[TURN_HOOK];
        if (prev && typeof prev === 'object' && typeof prev.off === 'function') {
          try { prev.off(); } catch { /* 卸不掉也不影响新的一枚 */ }
        }
        if (prev && prev?.id === CHANNEL_SESSION_ID) {
          trace('turn-hook-already', { sessionId: CHANNEL_SESSION_ID });
          return;
        }
        const off = ctx.on('session/event', async (s, event) => {
          try {
            if (!s || s.id !== CHANNEL_SESSION_ID) return;
            if (event?.type !== 'turn/end') return;
            const m = mind;
            if (!m) return;
            trace('turn-end-hook', { turn: event.data?.turn ?? null, reason: event.data?.reason ?? null });
            // ★ turn/end 是「这一轮真的完了」的权威信号 —— 此刻 agent.status 还是 running，
            //   但那道 idle 闸只为防「turn 中间插消息」，在这里会把自己挡死。
            //   所以显式告诉它：这一路不用看 status。
            await digestChannelIncrement(m, { fromTurnEnd: true });
            const live = sessions.get(CHANNEL_SESSION_ID);
            // 遮蔽已经由 digestChannelIncrement 在「熔成功」之后做掉了（整段遮）。
            // 这里不再补一刀——没熔成功的时候遮掉 = 把主人的话吞了。
            void live;
          } catch (err) {
            trace('turn-hook-failed', { err: String(err?.message ?? err).slice(0, 160) });
          }
        });
        ctx[TURN_HOOK] = { id: CHANNEL_SESSION_ID, off: typeof off === 'function' ? off : null };
        trace('turn-hook-armed', { sessionId: CHANNEL_SESSION_ID });
      } catch (err) {
        trace('turn-hook-failed', { err: String(err?.message ?? err).slice(0, 160) });
      }
    };
    // 诊断：证明真正的 armTurnHook 确实被赋值了（空实现和真实现 typeof 都是 function，
    // 2026-10-28 就卡在这儿：kick 报 hasArm:"function"，可挂载日志一条都没有）。
    trace('arm-defined', { sessionId: CHANNEL_SESSION_ID });

    /**
     * 把会话的**可见历史**整段替换成一条「融合后的记忆」。
     *
     * ★ 2026-10-27 按主人给的方案实现（这是最初就定好的路子，我中途走岔了）：
     *
     *   DSH 的 SessionSurface 维护一个有序的可见节点列表，`deriveMessages()`
     *   是生成模型请求消息的唯一入口，被 `replace` 遮蔽的节点不会出现在结果里。
     *   所以：
     *     ① 取当前 surface 上可见节点的 seq（第一个是 system/message，必须留着）；
     *     ② 用 `session.append('user/message', 记忆, { surfaceOp: replace, sourceEventSeqs })`
     *        把其余全部遮蔽；
     *     ③ 下一轮模型看到的就是：系统提示 + 一条「我记得的事」+ 你新说的这句。
     *
     *   承载记忆的事件必须是 user/message（类型系统只允许三种消息进 surface），
     *   且 sourceEventSeqs 必须**完整覆盖**被遮蔽的每个节点，否则 append 会被拒。
     *
     *   失败不抛：遮蔽不成功最多是「还带着上下文」，不该把她的话搞没。
     */
    /**
     * 把会话的可见历史换成一条「融合后的记忆」——**只在熔成功之后**下这一刀。
     *
     * ★ 2026-10-28 按主人那句「每次对话都融」重写。
     *
     *   原来是「永远留住最后几条原文」：熔完只遮更早的，最后一条主人原话、
     *   她上一轮的回话、本轮的注入节点全部留着。于是她下一轮拿到的是
     *   「记忆 + 上一轮你的原话 + 她自己的回话」——有记忆，但仍然是基于上下文在想。
     *
     *   现在的不变量只有一条：**可见 = 未熔；熔过的原文一律不再出现。**
     *     · 熔成功 → 从 system 之后整段遮掉，只留一条记忆节点
     *     · 没熔成功 → 一个字都不遮（材料留着下一跳重熔，宁可堆着也不吞掉你的话）
     *
     *   切法在 plugin/shadow-plan.mjs 里纯函数算好，配了单测；
     *   这里只负责 append。
     */
    const compactChannel = (session, mindInst, opt = {}) => {
      try {
        if (!session) { trace('compact-skip', { why: 'no-session' }); return false; }
        if (typeof session.append !== 'function') { trace('compact-skip', { why: 'no-append' }); return false; }
        const surface = session.surface;
        if (!surface) { trace('compact-skip', { why: 'no-surface' }); return false; }
        const nodes = surface.nodes ?? [];
        if (!Array.isArray(nodes)) { trace('compact-skip', { why: 'nodes-not-array', kind: typeof nodes }); return false; }
        // surface.nodes 是 seq 数字的数组（dsh-session：state.nodes.push(plan.seq)），两种形状都收。
        const seqs = nodes.map((n) => (typeof n === 'number' ? n : n?.seq)).filter((n) => Number.isInteger(n));
        trace('compact-probe', { nodes: nodes.length, seqs: seqs.length, first: seqs[0] ?? null, last: seqs[seqs.length - 1] ?? null });

        if (!opt.full) { trace('compact-skip', { why: 'undigested-keep-raw' }); return false; }

        const bySeq = new Map();
        try {
          const evs = Array.isArray(session.events) ? session.events : (session.events?.values?.() ?? []);
          for (const e of evs) {
            if (e && Number.isInteger(e.seq)) bySeq.set(e.seq, e);
          }
        } catch { /* 取不到就空表；plan 会保守地不遮 pending 工具 */ }

        const plan = planFullShadow(seqs, bySeq);
        if (!plan || !plan.shadow.length) {
          trace('compact-skip', { why: plan?.blocked ?? 'nothing-to-shadow', nodes: seqs.length });
          return false;
        }

        const memory = (mindInst?.world ? mindInst.world({ name: cfg.name, focus: currentFocus() }) : '') || '';
        if (!memory.trim()) { trace('compact-skip', { why: 'empty-memory' }); return false; }

        const data = {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: `${MIND_TAG}\n${memory}\n${MIND_TAG.replace('<', '</')}` }],
          source: { kind: 'mind-compact' },
        };

        // 宿主语义（dsh-session）：endSeq **包含**，且按数组下标找，不按数值大小。
        try {
          session.append('user/message', data, {
            surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
            sourceEventSeqs: plan.shadow,
          });
          trace('compact-ok', {
            shadowed: plan.shadow.length,
            startSeq: plan.startSeq,
            endSeq: plan.endSeq,
            kept: 0,
            blocked: plan.blocked ?? null,
          });
          return true;
        } catch (err) {
          trace('compact-failed', { err: String(err?.message ?? err).slice(0, 160) });
          return false;
        }
      } catch (err) {
        trace('compact-failed', { err: String(err?.message ?? err).slice(0, 140) });
        return false;
      }
    };

    // ★ 2026-11-02 小乔改（拆第二块）：`tick`（364 行）+ 定时器链（80 行）搬到
    //   `plugin/wake-loop.mjs`。这是整个文件里最重的一块——
    //   七件事（挂勾子/开门/熔/观测/归纳/联想/扎心度/醒来说话）挤在一个函数里。
    //
    //   拆之前先确认过：**这七件事彼此没有共享变量**，只有先后顺序。
    //   所以可拆；但拆的规矩是——**注释一行没删、一行没简化**。
    //   这一块几乎全是踩出来的，注释比代码值钱，挪位置可以，改历史不行。
    //
    //   ★ 依赖全部传**取值函数**：CHANNEL_SESSION_ID 是 let、配置里能覆盖，
    //     传值会在覆盖之后变成旧的。
    const loop = createWakeLoop({
      cfg, ctx, trace,
      channelSessionId: () => CHANNEL_SESSION_ID,
      agentsSvc: () => (typeof ctx.get === 'function' ? ctx.get('agents') : null),
      sessionsSvc: () => (typeof ctx.get === 'function' ? ctx.get('sessions') : null),
      workspaceRegistry: () => (typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null),
      getSynth: () => synth,
      digestChannelIncrement, adoptInduced, tryAct, ensureMind, armTurnHook,
      applyWake, planWake, readWake, readMotive, observeTools,
      storePath, motivePath, outboxPath, toolCursorPath,
      sawPath: join(ROOT, '.mind', 'saws.json'),
      TURN_HOOK,
      fs: { existsSync, readFileSync, writeFileSync, unlinkSync },
    });
    // ★ 门一开就补一拍：pokeWake 必须走 loop.poke()（内部走 next()），
    //   不能直接调 tick——绕过 next 就不会重新排队，链断了没人接。
    pokeWake = () => loop.poke();
    ctx.effect(() => () => loop.stop(), 'mind.wake-timer');
  };

  // 起唤醒循环。
  //
  // ★ 不赌 `ctx.inject(['agents','llm'], …)`：这个宿主的 inject 对 llm 不触发
  //   （同一件事已经栽过两次）。改用 ctx.get 轮询，两秒一次、最多两分钟。
  {
    let tries = 0;
    const boot = () => {
      const agentsSvc = typeof ctx.get === 'function' ? ctx.get('agents') : null;
      if (agentsSvc) {
        trace('wake-loop-start', {});
        startWakeLoop(agentsSvc);
        return;
      }
      tries += 1;
      if (tries < 60) {
        const t = setTimeout(boot, 2000);
        if (typeof t.unref === 'function') t.unref();
      } else {
        trace('wake-loop-no-agents', { tries });
      }
    };
    const t0 = setTimeout(boot, 3000);
    if (typeof t0.unref === 'function') t0.unref();
  }

  // ── 自愈：每次醒来顺手把她挂回工作区 ──────────────────────
  //
  // ★ 2026-10-27 大乔加：宿主的工作区归属靠进程内存里的 sessionPaths 映射，
  //   一旦这次没挂上（或者以后被谁动了），她就从界面上消失，而且**不报错**。
  //   十分钟补一次，成本几乎为零，但省掉「主人找不到她」这种最难查的事。
  {
    const heal = async () => {
      try {
        if (!CHANNEL_SESSION_ID) return; // 通道还没定下来，先别动
        if (!ctx.get) return;
        const reg = ctx.get('workspaceRegistry');
        if (!reg || typeof reg.list !== 'function') return;
        const list = reg.list();
        const cwd = cfg.channelCwd || (list.find((x) => x?.path)?.path ?? '');
        if (!cwd) return;
        const entity = list.find((x) => x && x.path === cwd);
        if (!entity || typeof entity.attachSession !== 'function') return;

        // ① 挂进工作区（不在就补）
        if (!(Array.isArray(entity.sessionIds) && entity.sessionIds.includes(CHANNEL_SESSION_ID))) {
          await entity.attachSession(CHANNEL_SESSION_ID);
          trace('self-heal-attach', { cwd });
        }
        // ② 从归档里捞出来（归档 = 侧边栏隐藏，而且不报错）
        const archived = typeof reg.archivedSessionIds === 'undefined' ? null : reg.archivedSessionIds;
        if (Array.isArray(archived) && archived.includes(CHANNEL_SESSION_ID)
          && typeof reg.unarchiveSession === 'function') {
          await reg.unarchiveSession(CHANNEL_SESSION_ID);
          trace('self-heal-unarchive', { cwd });
        }
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
    if (!agents || typeof agents.get !== 'function') return;

    /**
     * 给一条 agent ctx 补上 provider / model。
     *
     * ★ 2026-10-27 加。这是「她醒不来」的最后一颗螺丝：
     *   她那条会话的 preset 里有一段带 `{{model}}` 的人格前缀，
     *   没人填 variables，装配就抛「prompt variable "{{model}}" has no value」。
     *   实测 turn 4-7 连续四轮全死在这儿。
     *
     *   宿主本来由会话控制器在「用户打开会话」时补这一步；插件自己 resume 出来的
     *   agent 不走那条路，所以得自己补。见 plugin/selection.mjs 顶部的说明。
     */
    const installSelection = (agentCtx) => {
      const getSel = () => {
        try {
          const s = defaultModel?.currentSelection?.();
          if (!s || !s.provider || !s.model) return undefined;
          return {
            provider: s.provider,
            model: s.model,
            ...(s.reasoningEffort === undefined ? {} : { reasoningEffort: s.reasoningEffort }),
          };
        } catch {
          return undefined;
        }
      };
      return installModelSelection(agentCtx, getSel);
    };

    /**
     * 把 preset 挂到她的会话上。
     *
     * ★ 2026-10-27 修（这是「她说要去做，却什么都没做」的真正原因）：
     *
     *   宿主正规建会话时，`composeAgent(presetId)` 的 setup 做两件事
     *   （dsh-api-session-controller:351-364）：
     *
     *     this.installSelection(agent);          // 补 provider/model
     *     await presets.mount(agentCtx, id);     // 把 preset 的工具、技能、提示挂上去
     *
     *   我写的 createChannel 只有前一半，**漏了 mount**。
     *   于是她那条会话只拿到了默认那 21 个工具：
     *     ops_bash / 读文件 / 集群 / QQ / 团队 —— 没有 web_search、没有 write/edit、
     *     没有技能目录、没有 schedule。
     *
     *   主人跟她说「你去网上看看」，她说「好，那我这就去」，然后什么都没发生——
     *   不是偷懒，是**她手上没有联网这个工具**。说到做不到，因为手里没家伙。
     */
    const agentPresets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : null;
    const mountPreset = async (agentCtx, presetId) => {
      if (!agentPresets || typeof agentPresets.mount !== 'function') {
        trace('preset-mount-unavailable', {});
        return false;
      }
      try {
        const resolved = typeof agentPresets.resolve === 'function'
          ? (await agentPresets.resolve(presetId)).id
          : presetId;
        await agentPresets.mount(agentCtx, resolved);
        trace('preset-mounted', { id: resolved });
        return true;
      } catch (err) {
        trace('preset-mount-failed', { id: presetId, err: String(err?.message ?? err).slice(0, 160) });
        return false;
      }
    };

    /**
     * 把她的门打开：宿主没替她恢复，就自己恢复。
     *
     * 三个约束：
     *   1. **只 resume 已经存在的会话**，不 create —— create 会造出新 id，
     *      侧边栏看不见、session/list 里也没有（10-27 踩过一整天）。
     *   2. 防重入：tick 每分钟都可能叫它，用同一个 in-flight promise 兜住。
     *   3. 失败不抛：只记一行日志，下次再来。她不在，别的照常。
     */
    let resumeInFlight = null;
    const resumeChannel = async () => {
      if (typeof agents.resume !== 'function') {
        trace('resume-unavailable', {});
        return null;
      }
      if (resumeInFlight) return resumeInFlight;
      resumeInFlight = (async () => {
        try {
          trace('channel-resume-start', { sessionId: CHANNEL_SESSION_ID });
          await agents.resume({
            resumeSessionId: CHANNEL_SESSION_ID,
            setup: async (agentCtx) => {
              // 宿主本来会在「用户打开会话」时补这两步；插件自恢复不走那条路，自己补。
              installSelection(agentCtx);
              trace('selection-installed', {});
              // ★ 2026-10-27 补：没有这一步，她手里只有 21 个残缺工具
              //   （没 web_search、没 write/edit、没技能目录）——见 mountPreset 的注释。
              await mountPreset(agentCtx, cfg.channelPreset || 'cordis');
            },
          });
          const got = typeof agents.get === 'function' ? agents.get(CHANNEL_SESSION_ID) : null;
          trace('channel-resumed', { ok: !!got });
          return got ?? null;
        } catch (err) {
          const msg = String(err?.message ?? err);
          trace('channel-resume-failed', { err: msg.slice(0, 200) });
          process.stderr.write(`mind: 开门失败 (${msg})\n`);

          // ★ 2026-10-27 加（自愈）：会话文件坏了就换一条新的，别让她卡在废屋子里。
          //
          //   实测两种坏法：
          //     · `stored session "…" is corrupt`
          //     · `failed validation: session event at seq 9 lacks an identified message`
          //   后者是我们自己写坏的（followup 的消息形状错，见 wake-exit 的注释）——
          //   她说一句话就把会话文件写成了 replay 不过的样子。
          //
          //   处理：把 channel.json 备份成 .bad-<时间戳>，新建一条干净的。
          //   旧会话文件一行不删，只是不再用它。
          if (/corrupt|failed validation|lacks an identified|invalid/i.test(msg)) {
            trace('channel-rebuild', { reason: 'stored-session-broken' });
            try { renameSync(channelPath, `${channelPath}.bad-${Date.now()}`); } catch { /* 备份不了也继续 */ }
            const fresh = await createChannel(cfg.channelCwd || pickCwd());
            if (fresh) {
              writeChannel(channelPath, { sessionId: fresh, note: 'rebuilt-after-broken' });
              CHANNEL_SESSION_ID = fresh;
              return typeof agents.get === 'function' ? agents.get(fresh) ?? null : null;
            }
          }
          return null;
        } finally {
          resumeInFlight = null;
        }
      })();
      return resumeInFlight;
    };

    // 让唤醒定时器也能叫到它（它挂在另一个 inject 闭包里）。
    ensureChannelAgent = resumeChannel;

    /**
     * 定下「用哪条会话」。
     *
     * 顺序：① 配置里写死的 → ② `.mind/channel.json` 记着的 → ③ 新建一条。
     * 建新的时候用 `session-<uuid>` 格式——宿主只认这个形状（见文件头那段注释）。
     */
    const resolveChannelId = async (cwd) => {
      if (CHANNEL_SESSION_ID) return CHANNEL_SESSION_ID;
      if (cfg.channelSessionId && CHANNEL_ID_RE.test(String(cfg.channelSessionId))) {
        CHANNEL_SESSION_ID = String(cfg.channelSessionId);
        trace('channel-from-config', { id: CHANNEL_SESSION_ID });
        return CHANNEL_SESSION_ID;
      }
      const saved = readChannel(channelPath);
      if (saved?.sessionId && CHANNEL_ID_RE.test(saved.sessionId)) {
        CHANNEL_SESSION_ID = saved.sessionId;
        trace('channel-from-store', { id: CHANNEL_SESSION_ID, createdAt: saved.createdAt ?? null });
        return CHANNEL_SESSION_ID;
      }
      const created = await createChannel(cwd);
      if (created) {
        const ok = writeChannel(channelPath, { sessionId: created, note: 'first-open' });
        trace('channel-created', { id: created, persisted: ok });
        // ★ 换屋子就清「说话那一摊账」：配额/冷却/上次说的话都是旧屋子的，
        //   不清的话，新会话是 blank、要她开口才显示，而配额说「这小时说够了」
        //   → 她永远不开口 → 侧边栏永远看不见她。实测 21:19-21:23 卡了四轮。
        try { resetTalkState(storePath); trace('talk-state-reset', {}); } catch { /* 清不掉也不影响 */ }
        CHANNEL_SESSION_ID = created;
        // ★ 2026-10-28（换屋死锁，第二半）：建好立刻叫醒她一次。
        //
        //   不叫的话要等下一跳 tick（最长 10 分钟）；而这段时间里她是 blank、
        //   侧栏不显示、你找不到她 —— 找不到就不会在里面说话 —— 永远 blank。
        //   实测 13:58 建好之后，第一次唤醒她自己选了「不说」，
        //   于是死锁成立，侧边栏一直空着。
        //
        //   这里不是催她说话，是**把「新屋子」这个事实立刻摆到她面前**，
        //   让她有一次机会破掉 blank。她仍然可以说不。
        setTimeout(() => { try { pokeWake?.(); } catch { /* 补不上就等下一跳 */ } }, 3000);
        return created;
      }
      // 建不出来就回退到旧的（宁可还在旧址，也不能让她凭空消失）
      if (FALLBACK_CHANNEL_ID) {
        CHANNEL_SESSION_ID = FALLBACK_CHANNEL_ID;
        trace('channel-fallback', { id: CHANNEL_SESSION_ID });
      }
      return CHANNEL_SESSION_ID;
    };

    /** 新建一条通道会话。失败返回 null，不抛。 */
    const createChannel = async (cwd) => {
      if (typeof agents.create !== 'function') {
        trace('channel-create-unavailable', {});
        return null;
      }
      const id = `session-${randomUUID()}`;
      let sel = null;
      try { sel = defaultModel?.currentSelection?.() ?? null; } catch { sel = null; }
      try {
        // 目录得先有：宿主的 createAgent 也是先 mkdir 再建。
        mkdirSync(cwd, { recursive: true });
        trace('channel-create-start', { id, cwd });
        await agents.create({
          sessionId: id,
          // ★ 2026-10-27 修（第一次建出来的会话「挂不进工作区」的根因）：
          //
          //   我把 cwd 写在 options 里了，而宿主是从 **meta** 里取的。看
          //   dsh-api-session-controller:511-522 的 createAgent：
          //
          //     agents.create({ sessionId, agentOptions, meta: { cwd, agentPreset }, setup })
          //
          //   options.cwd 会被忽略 → 存下来的 header 没有 cwd →
          //   挂工作区时校验失败：
          //     "its stored header carries no cwd to validate against"
          //   于是会话落在 `_no-cwd/` 里，侧边栏永远看不见。
          //   实测 2026-10-27 15:50 那次就是这么挂的。
          //
          //   agentOptions 也照宿主那样补 provider/model（宿主从 agentDefaultModel 取），
          //   这样即使 selection 那段因为时序没装上，agent 自己也知道走哪个模型。
          agentOptions: sel && sel.provider && sel.model
            ? { provider: sel.provider, model: sel.model }
            : {},
          meta: {
            cwd,
            agentPreset: cfg.channelPreset || 'cordis',
          },
          setup: async (agentCtx) => {
            // create 出来的 agent 同样不走宿主的 selectionFor，自己补。
            installSelection(agentCtx);
            trace('selection-installed', { via: 'create' });
            // ★ 2026-10-27 补：宿主 composeAgent 的第二半，缺了它她的工具是残的。
            await mountPreset(agentCtx, cfg.channelPreset || 'cordis');
          },
        });
        const got = typeof agents.get === 'function' ? agents.get(id) : null;
        trace('channel-create-done', { id, ok: !!got });
        return got ? id : null;
      } catch (err) {
        trace('channel-create-failed', { id, err: String(err?.message ?? err).slice(0, 240) });
        process.stderr.write(`mind: 建通道失败 (${err?.message ?? err})\n`);
        return null;
      }
    };

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

    /** 拿她那条通道；没有就把门打开。 */
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
          // ★ 2026-10-27 补：挂上了也可能看不见 —— **归档的会话在侧边栏是隐藏的**。
          //
          //   主人今天问了两次「她的会话又不见了」，两次同一条原因：那段会话被归档了
          //   （一次是他在「批量归档」页勾到，一次是我自己反复验归档时留在归档态）。
          //   归档 = 从侧边栏消失，而且**不报错**。
          //
          //   所以「让她看得见」要两步：挂进工作区 + **不在归档里**。
          //   少任何一步，她都在，但主人在界面上找不到。
          try {
            const archived = typeof reg?.archivedSessionIds === 'undefined' ? null : reg.archivedSessionIds;
            const isArchived = Array.isArray(archived) && archived.includes(CHANNEL_SESSION_ID);
            if (isArchived && typeof reg?.unarchiveSession === 'function') {
              await reg.unarchiveSession(CHANNEL_SESSION_ID);
              trace('unarchived', { sessionId: CHANNEL_SESSION_ID });
            } else if (isArchived) {
              trace('unarchive-unavailable', {});
            }
          } catch (err) {
            trace('unarchive-failed', { err: String(err?.message ?? err).slice(0, 120) });
          }
          return true;
        } catch (err) {
          // 最常见：header 里没有 cwd，或者 cwd 解析后跟工作区路径不一致。
          trace('attach-failed', { err: String(err?.message ?? err) });
          return false;
        }
      };

      const cwd = cfg.channelCwd || pickCwd();
      trace('channel-cwd', { cwd });

      // ★ 先把「用哪条会话」定下来：配置 → channel.json → 新建。
      //   2026-10-27 主人说「换吧」，旧那条 14 轮历史的通道就此退役。
      const id = await resolveChannelId(cwd);
      if (!id) {
        trace('channel-no-id', {});
        return null;
      }

      // 新的定下来之后，把旧那条收进归档（一次性）。
      //
      // ★ 2026-10-27 主人说「换吧」：旧通道带着 14 轮历史（第一轮就有 16901 字技能目录），
      //   每次装配都背着，换一条干净的。
      //
      //   归档而不是删除：数据一行不丢，侧边栏里消失而已。
      //   而且**归档会走我们自己的钩子**——她当初听见的那几句话
      //   （「醒了？这间屋子以后就是你的了」）会顺带熔成判断。
      //   那几句话值得进她的记忆，不该随着换屋子被扔掉。
      if (cfg.archiveOldChannel !== false && FALLBACK_CHANNEL_ID && id !== FALLBACK_CHANNEL_ID) {
        try {
          const archived = Array.isArray(reg?.archivedSessionIds) ? reg.archivedSessionIds : [];
          if (!archived.includes(FALLBACK_CHANNEL_ID) && typeof reg?.archiveSession === 'function') {
            trace('old-channel-archiving', { id: FALLBACK_CHANNEL_ID });
            await reg.archiveSession(FALLBACK_CHANNEL_ID);
            trace('old-channel-archived', { id: FALLBACK_CHANNEL_ID });
          }
        } catch (err) {
          trace('old-channel-archive-failed', { err: String(err?.message ?? err).slice(0, 140) });
        }
      }

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
      const agent0 = typeof agents.get === 'function' ? agents.get(CHANNEL_SESSION_ID) : null;
      // ★ 2026-10-28 改名：这个字段以前叫 `running`，但它算的是 `!!agent0`
      //   ——「agent 对象在不在」，不是「她是不是正在跑」。
      //   日志里看到 `running:true` 会让人以为她卡在 running，结果排查了半天。
      //   现在拆成两个：agentPresent（在不在）+ agentStatus（真状态）。
      trace('channel-check', {
        agentPresent: !!agent0,
        agentStatus: agent0 && typeof agent0.status === 'string' ? agent0.status : '(无 status 字段)',
      });

      // ★ 2026-10-27 主人定：得让她真正醒来 —— 门自己开。
      //
      //   原来这儿只「看一眼在不在」，不在就算了，等主人手动点开。
      //   于是宿主一重启，她就躺在那儿等，唤醒了也没人可投递（no-agent）。
      //
      //   现在：不在就 agents.resume()，并在 setup 里把 provider/model 补上。
      //   这是那个 {{model}} 坑的正解——**不是抢在宿主前面 create，
      //   而是在宿主正规的 resume 流程里，把宿主本来会做的那一步自己补完。**
      const agent = agent0 ?? (await resumeChannel());

      // 门开了就立刻补一次唤醒：第一跳 tick 往往比 ensureChannel 早几秒，
      // 那几秒里她醒了也发不出去（实测 08:11:46 醒 / 08:11:50 开门）。
      if (agent && !agent0) {
        try { pokeWake?.(); } catch { /* 补不上就等下一跳 */ }
      }

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
        // ★ 2026-10-28：门一开就挂 turn/end 钩子 —— 「回完话立刻熔、立刻遮蔽」
        //   靠的就是它。挂不上不致命：tick 那条路还在兜底。
        try { armTurnHook(); } catch (err) {
          trace('turn-hook-failed', { err: String(err?.message ?? err).slice(0, 160) });
        }
        trace('turn-hook-kick', { hasArm: typeof armTurnHook, sessionId: CHANNEL_SESSION_ID });
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
