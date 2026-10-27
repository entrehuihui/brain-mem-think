# 定稿 · 目录命名 / suppressor 实测法 / wake.json schema

**任务**：task-7 收尾（Lead 2026-10-26 要求：把这些「现在就定死，别人照着就能干」）
**状态**：全部是**决定**，不是建议。代码未写，但名字、值、schema、验证步骤已经写死。

路径约定：`P` = `…\node_modules\@deepseek-ai`，`S` = `<repo>\src`，`R` = 插件根目录。

> **⚠ 先读这一条**：本文 §2 里，我原来标「未查证」的那个问题（第二道闸能不能拦住 runtime context）**查清楚了，而且结论变了**——`suppressRuntimeContext` 挡不住 `working-directory`，因为它是 `required: true`，而 `required` 的 context **由宿主事后无条件补回**。
> **所以我和 Lead 原来认定的「第二道闸」不是那道。** 真正的第二道闸是 `complete: true` section。见 §2。

---

## 1. 目录与命名（定死）

### 1.1 插件根目录

```
R = %USERPROFILE%\.dsh\profiles\web\plugins\mind
```

- **包名**：`@local/dsh-mind`
- **插件 id（`cordis.patch.yml` 里那个）**：`mind`
  - 为什么不用 `brain-mem`：旧插件的 `isSystemInjected()` 有一条专门拦自己的注入块 `if (/^<brain-mem>/.test(body)) return true;`（旧 `index.js:266`）。**换 id 就换标签，两个过滤器的名字不能混。**
  - 同理，注入标签用 `<mind>`，`isSystemInjected()` 里白名单加 `/^<mind>/`。

### 1.2 文件清单（一次定死，后面的活照着建）

```
R/
  package.json          name:@local/dsh-mind  main:./index.mjs
  cordis.patch.yml      - insert: - id: mind   name: @local/dsh-mind
  index.mjs             插件入口：apply / export const inject = []
  archive-watch.mjs     归档观察（domain/changed 差集）
  channel.mjs           独立通道：建/复用、setup 装闸、pre-step 换消息
  wake-exit.mjs         **唯一出口**（`followup(` 只在这里出现一次）
  wake-store.mjs        .mind/wake.json 读写（原子写）
  world-surface.mjs     把 renderWorld() 的结果变成一条 mind-world 快照消息
  material.mjs          归档熔的材料白名单（只收 user/message）
  .mind/                运行期数据目录（不随插件发布）
    wake.json
    wake.json.bak-<ts>     坏文件备份
```

**`src/` 是只读的**：`R/` 只 import `S/` 的导出，**不改 `src/` 一个字节**，也不往 `src/` 里写文件。

### 1.3 唯一出口函数（`followup(` 只出现一次的那个）

```
文件：R/wake-exit.mjs
函数：export async function speakToOwner({ agent, sessionId, message, now })
```

**这个函数体内，`followup(` 出现且仅出现一次。** 全插件任何其它文件不许出现 `followup(` / `steer(` / `agent.send(`。

**函数内部固定顺序（顺序本身是契约，块一测这个）：**

```
1. 状态闸：agent.status !== 'idle' → 直接 return { sent:false, why:'busy' }，**不排队**
2. 归档闸：workspaceRegistry.archivedSessionIds.includes(sessionId) → return { sent:false, why:'archived' }
3. 去重闸：算 message 的归一化哈希，命中 wake.json.spokenHashes → return { sent:false, why:'repeat' }
4. 发送：agent.followup(message)            ← 全插件唯一一次
5. 送达确认：await ctx.sessions.flush(agent.session) === true，否则 return { sent:false, why:'flush-failed' }
6. 记账：写 wake.json（lastSpokeAt / spokenHashes / window）
```

> **第 5 步不许省。** 依据：`P/dsh-schedule/lib/index.js:1596-1597`——`followup` 之后必须 `flush` 才算送达，这是宿主自己定时投递的做法。
> **第 6 步在 flush 之后。** 写盘失败 → 返回 `sent:false`（这次算没发出去），下一轮会重试。

### 1.4 通道会话的固定 id

```
const CHANNEL_SESSION_ID = 'mind-her';
```

- **一个字符都不许带冒号、空格、路径分隔符**——宿主会把它当文件名用（`P/dsh-session/lib/index.js:1344-1346`，`Session.id` 直接来自 header）。
- **必须与 `brain-mem-her-*` 不同**（旧插件用过那个前缀），避免任何残留冲突。
- **这条会话永远不进任何 workspace、永远不 pin。** 依据：`P/dsh-workspace/lib/index.js:509-511`——归档不关心 workspace 归属，所以「不在 workspace 里」不能防归档，**但能防主人误点进去**。
- **她自己的会话如果被归档，`speakToOwner` 的第 2 道闸只适用于「发给主人」那条路；通道会话本身若被归档，`agent/pre-step` 会被拒（`P/dsh-api-session-controller/lib/types/archived-session-gate.js:21-24`），整条通道静默。这一条写进 README 排错表。**

### 1.5 注入标签与 source 身份

| 常量 | 值 | 用途 |
|---|---|---|
| `MIND_TAG` | `<mind>` | 注入块的最外层标签，`isSystemInjected()` 白名单认它 |
| `WORLD_SOURCE_KIND` | `mind-world` | 通道里那条快照 `user/message` 的 `source.kind` |
| `WORLD_FORM` | `snapshot` | `P/dsh-llm/lib/types/message.d.ts:82-84` 的 form，带 `sections` |
| `WAKE_SIGNOFF` | 不发 | 她主动说的那条消息**不需要任何标记**——靠 `speakToOwner` 一处出口即可认出，不靠标签 |

---

## 2. `suppressRuntimeContext()` 的生效时机 —— 实测出来了，而且结论变了

### 2.1 结论先行（三句话）

1. **`suppressRuntimeContext()` 能挡住「非 required」的 runtime context**，包括 `HARNESS_SOURCE`、`WEB_SURFACE`、`SANDBOX_POLICY`、`APPROVAL_POLICY`、`SUBAGENT_DELEGATION`、`TEAM_IDENTITY`。
2. **它挡不住 `working-directory:current`**——因为那条是 `required: true`（`P/dsh-working-directory/lib/index.js:44`），而 `assemble()` 在 suppressed 状态下**会把 required 的 context 再补回去**（`P/dsh-system-prompt/lib/index.js:399-405`）：
   ```
   :404  contexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts
   ```
   **这不是「漏了」，是设计：required 的事实必须留在提示里。**
3. **所以「第二道闸」应该是 `complete: true` 的 prompt section，不是 suppressor。**

### 2.2 为什么 `complete: true` 才是那道闸

`complete` 的语义（`P/dsh-system-prompt/lib/types/index.d.ts:63-69`）：

> 「Treat this contribution as the complete system prompt. Assembly still runs the cooperative waterfall so tools, contexts, and variables can be resolved, then **restores this exact section as the sole prompt section**.」

`assemble()` 里的实现（`P/dsh-system-prompt/lib/index.js:399-405`）：
```
:399  if (completeSection === void 0 && !runtimeContextSuppressed) return transformed;
:403  sections: completeSection === void 0 ? transformed.sections : [completeSection],
```
**一旦有 complete section 生效，`sections` 就被替换成那一条，其余 section 全部消失。** 而 runtime context 的正文**是通过 `user/message` 进对话的**（`P/dsh-agent-loop/lib/index.js:1069`、`:1073`），不是 section——所以还要配合 §2.4 的第三条。

### 2.3 scope 归属：为什么必须在 `setup(agentCtx)` 里注册

`systemPrompt.section()` / `.context()` / `.suppressRuntimeContext()` 全部走 `this.layers.effect(this.ctx, ...)`（`P/dsh-system-prompt/lib/index.js:255`、`:281`、`:290`），而 `ScopedLayers.effect` 的 scope 判定是：

```
P/dsh-scope/lib/index.js:190   const scope = scopeOf(ctx);
P/dsh-scope/lib/index.js:195   if (scope === void 0) layer = this.global;
```

> **在插件根 ctx（unscoped）里注册 = 进 global layer = 对所有人都生效。**
> **必须在她自己的 `agentCtx`（`P/dsh-agent-loop/lib/index.js:778-779` 的 `this.ctx = this.scope.ctx`）里注册 = 只对她那条会话生效。**

`setup(agentCtx)` 拿到的就是这个 scoped ctx（`P/dsh-agent-loop/lib/index.js:1931`：`setup?.(prepared.agent.ctx, prepared.agent)`）。

**生效时机**：`setup` 在 `initializeAgent` 里、`publish` 之前跑（`:1930-1934`），而第一次 `assemble()` 在 `preStep` 里（`:907`）——**远在其后**。
所以：**`setup` 里注册的闸，第一轮就一定生效，不存在「第二轮才生效」的问题。**

### 2.4 三道闸合起来才成立（这是修正版，替换我原来的「四道闸」里的 B）

| 闸 | 在哪装 | 挡什么 | 依据 |
|---|---|---|---|
| **A 专属会话** | 建会话时 | 不出现在任何 workspace 面上，主人点不进去 | `P/dsh-workspace/lib/index.js:509-511` |
| **B1 `complete: true` section** | `setup(agentCtx)` 里 `systemPrompt.section({ complete: true, ... })` | **系统提示里别的一切全部消失**（含 required 的 working-directory） | `P/dsh-system-prompt/lib/types/index.d.ts:63-69`、`lib/index.js:399-405` |
| **B2 `suppressRuntimeContext()`** | 同一处 | 挡非 required 的 context（减少 `user/message` 的快照体积） | `P/dsh-system-prompt/lib/index.js:289-291`、`:359`、`:394` |
| **C `agent/pre-step` 整段替换** | 同一处注册 `ctx.on('agent/pre-step', ...)` | **这一轮发出去的消息 == 世界快照，一条不多** | `P/dsh-agent-loop/lib/index.js:909-920`、`:1067-1073` |
| **D 快照用专属 `source.kind`** | 注入那条消息时 | 认出「哪些是她自己的世界」，别的 user/message 在 C 里被丢掉 | `P/dsh-llm/lib/types/message.d.ts:96-108` |

> **注意 B1 的副作用**：`complete: true` 会把 **harness identity**（`P/dsh-system-prompt/lib/index.js:228-232` 的 "You are an AI agent running on DeepSeek Harness."）也一并去掉。
> **这正是我们要的**（她不该知道自己是 harness 上的 agent），但**要显式写进设计**，别当成 bug。
> **还有一条硬限制**：同时只能有一个 effective complete section，多了 `assemble()` 直接抛（`:382`）。所以 B1 必须注册在**她自己的 scope**里，不能是 global。

### 2.5 如果现在没法实测：最小验证插件（照这个写就能验）

**目的**：一次跑通，回答三个问题——① suppressor 生效吗？② `complete` 生效吗？③ `working-directory` 会不会漏进来的？

**做法（一个 60 行的临时插件，不放进 `R/`，放 `D:\dsh\scratch\mind-probe\`）**：

```
1. apply(ctx) 里 ctx.inject(['agents'], (a) => a.create({
     sessionId: 'mind-probe-1',
     meta: { cwd: <一个绝对路径> },
     setup: (agentCtx) => {
       // ① 打点：记录 setup 被调的时刻
       log('setup-at', Date.now());

       // ② 注册 complete section（闸 B1）
       agentCtx.systemPrompt.section({
         name: 'mind-probe:complete', order: 0, complete: true, interpolate: false,
         text: 'ONLY THIS',
       });

       // ③ 注册 suppressor（闸 B2）
       agentCtx.systemPrompt.suppressRuntimeContext();

       // ④ 挂一个只在第一次 assemble 时打的日志
       agentCtx.on('system-prompt/assemble', (assembly) => {
         log('assemble', assembly.sections.map(s => s.name), assembly.contexts.map(c => c.name));
         return assembly;
       });
     },
   }))
2. 立刻 followup 一条 'hi'，让它跑第一轮。
3. 跑完读这个会话的 user/message 事件，打印每条的 source.kind 与正文前 40 字。
```

**判读表（每行一个结论，不许含糊）：**

| 观察 | 结论 |
|---|---|
| `assemble` 日志里 `sections == ['mind-probe:complete']` | **B1 生效**（别的 section 都被吸收了） |
| `sections` 里还有 `harness:identity` 等 | B1 没生效 → 查 `complete` 有没有传、有没有注册在 scoped ctx |
| `contexts` 里只剩 `working-directory:current` | **B2 生效**，且工作目录漏进来（**预期**） |
| `contexts` 里还有 `HARNESS_SOURCE` / `WEB_SURFACE` | B2 没生效 → 查是不是注册在根 ctx 了（会进 global） |
| 会话历史里出现 `source.kind == 'runtime-context'` 且含路径 | **C/D 没做，这条落库就洗不掉** |
| `assemble` 日志**只在第一轮出现一次后来的每一轮都有** | 正常（每 step 都会 refresh，`:1053`） |
| `assemble` 日志里第一轮就有 complete | **说明 setup 早于第一次 assemble，时机 OK** |

**跑不出来怎么判**：如果 `assemble` 日志一条都没有，说明 `agent/pre-step` 都没走到 → 查会话是不是被 gate 拒了（`archived-session-gate.js:21-24`）。

---

## 3. `wake.json` 的 schema（定死）

### 3.1 文件位置

```
R/.mind/wake.json
R/.mind/wake.json.bak-<ISO时间戳>     坏文件备份
```

**和判断库不同文件。** 理由（Lead 已认）：判断库写坏 = 她人格没了；配额写坏 = 少说两句，**失败等级差一个数量级不该共用**。

### 3.2 Schema（逐字段定死）

```jsonc
{
  "version": 1,                    // int，必须是 1；别的值 → 当坏文件处理
  "lastWakeAt": 1730000000000,     // int|null，毫秒；null = 从没醒过
  "lastSpokeAt": 1730000000000,    // int|null，毫秒；null = 从没说过
  "spokenHashes": [                // array，最多 100 条，旧的从头部丢
    { "h": "a1b2c3d4",             // string，8 位十六进制：归一化后文本的哈希前 8 位
      "at": 1730000000000 }        // int，毫秒
  ],
  "window": [                      // array，最多 20 条，只存决策事实，不存内容
    { "at": 1730000000000,          // int，毫秒
      "a": "speak" }                // "speak" | "silent"，只有这两个值
  ],
  "crashedMidWake": false          // bool；写盘前置 true，写成功后置 false
}
```

### 3.3 每条字段存在的理由（不是装饰）

| 字段 | 谁用 | 不用它会怎样 |
|---|---|---|
| `version` | 加载器 | 将来改 schema 时没法拒绝旧文件 |
| `lastWakeAt` | 心跳调度 | 重启后不知道上次何时醒，可能立刻连醒 |
| `lastSpokeAt` | `wake()` 的 `quietAfterSpeakMs`（`S/wake.mjs:98-100`） | 重启立刻再说一遍 |
| `spokenHashes` | `speakToOwner` 第 3 道闸 | **旧插件「反复说同一句」正是这条没落盘**（`spec/调研-桌宠怎么自己醒.md:64`） |
| `window` | `wake()` 的三道历史闸（`S/wake.mjs:82-91`） | 重启后「连说两回就停」「沉默配额」全部归零 |
| `crashedMidWake` | 加载器 | 崩在写盘中间时，不知道上次说到哪儿，可能重说 |

**不存的东西（铁律）**：**任何原文、任何她说的话的内容**。`spokenHashes[].h` 是哈希，不是文本。这是「不存原文」在宿主侧的最后一道保险。

### 3.4 坏状态 → 读成什么（定死，逐行）

| 磁盘上的状态 | 加载后的内存值 | 动作 |
|---|---|---|
| 文件不存在 | `lastSpokeAt = now`，其余为空 | 先闭嘴一轮，但允许后续唤醒 |
| JSON 解析失败 | **同上** | 备份成 `.bak-<ts>`，重建 |
| `version !== 1` | **同上** | 备份，重建 |
| 任一字段类型不对 | **同上**（整份作废，不做逐字段修补） | 备份，重建 |
| `spokenHashes` 超过 100 条 | 只留最后 100 | —— |
| `window` 超过 20 条 | 只留最后 20 | —— |
| `crashedMidWake === true` | **保持 true，直到下一次成功写盘** | 这一轮**强制 silent**，且日志记一条 |
| 写入失败（磁盘满/权限） | 内存值**不更新**（当作没写） | 调用方按 `sent:false` 处理 |

**「宁可不说」的具体落地**：上面 8 行里，**6 行往「不说」倒**。唯一允许立刻开口的是「文件不存在」（全新安装不该一上来就哑）。

**但加一条反制**：`lastWakeAt` 无论文件好坏都从**进程启动时刻**起算，**每过 `maxGapMs` 必须至少醒一次（哪怕结果是 silent）**。醒 ≠ 说，不烧 token。

### 3.5 写入规则（原子性）

```
1. 内存里 `crashedMidWake = true`，写临时文件 wake.json.tmp（含 crashedMidWake:true）
2. fsync 临时文件
3. rename wake.json.tmp → wake.json
4. 内存里 `crashedMidWake = false`，再写一次（同上三步）
```

- **不许**「打开原文件、truncate、写」——崩在中间整份没了。
- **第 1 步和第 4 步是两次写**，为的是：**任何时刻磁盘上要么是「上次成功的完整状态」，要么是「带 crashed 标记的完整状态」，不会是半份。**
- 目录 `.mind/` 不存在时先 `mkdir -p`。

### 3.6 验收（给 redteam 的块二补三条）

1. **写盘时强杀**：在第 2 步和第 3 步之间 kill 进程 → 重启后 `wake.json` 是**上一份完整的**（或带 `crashedMidWake:true` 的完整一份），不是半份。
2. **坏文件**：手工写一段 `{` → 启动不崩，`lastSpokeAt == now`，且出现一个 `.bak-<ts>`。
3. **跨重启去重**：说一句 → 杀掉 → 重启 → 立刻强制唤醒 → **不许说出同一句**（哈希命中）。

---

## 4. 这三份决定对 §交接-红队-唤醒验收.md 的修正

**块三的断言要改**（这是本文最重要的交付）：

**旧断言**（我 6 小时前写的）：
> 「除 `working-directory:current` 外无其他 runtime context」

**新断言**（依据本 §2）：

```
她通道会话的第一轮：
1. 系统提示 sections == 恰好一条（她的世界），且不含 harness:identity
2. 会话历史的 user/message 里，source.kind 只允许 'mind-world'（一条）
3. 不许出现任何 source.kind == 'runtime-context' 的消息
4. 若出现 working-directory:current 的 context，允许；但它**不许**变成一条 user/message
```

> **第 4 条是新的，也是关键**：`working-directory` 那条 context **无法被 suppress**，只能靠 `complete: true` 让它不进 `sections`、靠 `pre-step` 换消息让它不进历史。**两道都要测。**

---

## 5. 一句话

> **名字定死，闸定了两道（`complete` + `pre-step`），schema 定死八种坏状态。**
> 交给下一个人时，他不需要知道我核了多少行——**照着 §1 建目录、照着 §2 装闸、照着 §3 写文件就行。**


---

## 6. `complete: true` 的独占性风险（Lead 追问，2026-10-26 晚核）

### 6.1 风险本身

`assemble()` 里有一句硬检查（`P/dsh-system-prompt/lib/index.js:381-382`）：

```
:381  const completeSections = sectionDefinitions.filter((section) => section.complete === true);
:382  if (completeSections.length > 1) throw new Error(`multiple complete prompt sections are active: ...`);
```

**多个生效的 complete 段 → `assemble()` 直接抛。**
而 `assemble()` 在 `preStep`（`P/dsh-agent-loop/lib/index.js:907`）里被 `await`，**不在任何 try 里**。
后果：**那个会话的每一轮都起不来。不是「她看不见聊天记录」，是会话直接废掉。**

### 6.2 本机现状（扫过了，结论是「现在安全」）

扫了三个地方：

| 扫什么 | 结果 |
|---|---|
| 宿主自带包（`…@deepseek-ai/**/lib/*.js`）里 `complete: true` | **8 处命中，但只有 1 处是我们关心的**：`dsh-persona/lib/index.js:40` |
| 其余 7 处 | 全是**同名但无关**的 `complete` 字段（client 的 UI 状态、headless 的流式 JSON、session-query 的检索记录、skill 的目录条目、api-catalog 的文档字符串）——**不是 prompt section** |
| profile 已装插件（`~/.dsh/profiles/web/plugins/`） | **只有 `session-rescue` 一个，零 `complete`** |
| profile 的 `cordis.patch.yml` | **`complete:` 出现 0 次** |

**唯一真正的开关**：`dsh-persona` 的 `complete`，默认 **false**（`P/dsh-persona/lib/index.js:26`：`complete: z.boolean().default(false)`），本 profile 的 persona 段（`~/.dsh/profiles/web/cordis.patch.yml:93-96`）**没有写这个键** → 生效值是 false → **它现在不进 complete 集合**。

> **本机结论（一句话）**：`cordis.patch.yml:93` 那一处 persona 只要**不加 `complete: true`**，我们就能独占。
> **但这是一条靠配置维持的独占，不是机制保证。** 主人哪天加了那一个键，两个 complete 同时生效，**两个会话一起崩，而且报错信息不会说是谁的**（`multiple complete prompt sections are active: "deployment:persona-prefix", "mind:world"`——只说名字，不说怎么修）。

### 6.3 怎么保证不撞：启动自检 + 大声降级

**位置**：`R/channel.mjs`，建通道会话**之前**，在 `apply()` 阶段跑一次。

**做法**：调一次 `systemPrompt.assemble(...)` 的**预演**——不给它真会话，用一个临时 ctx 组一份 assembly，看哪些 section 带 `complete: true`。

**判据（写死）**：

```
若 complete 集合里，除了我们要注册的那一个（名字固定 'mind:world'）还有别的：
  ① 不注册 complete，降级
  ② **大声报错**：process.stderr.write 一行 + 落一份 .mind/complete-conflict.json
  ③ 继续以「非 complete」模式运行（见 6.4）
```

**报错文案（写死，不许只说「冲突了」）**：

```
mind: ⚠ complete 段冲突，已降级为「不做完整替换」。
  抢在前的：<名字列表>
  影响：她这一轮的系统提示里会残留别人的段落（可能是 persona / harness identity）。
  第四道闸（agent/pre-step 整段替换）仍在，她看不到聊天记录，但**看不到的是对话，不是段落**。
  修法：把上面列表里的插件改成 complete: false，或把 mind:world 的那个 complete 撤掉。
  记录：.mind/complete-conflict.json
```

**为什么要「预演」而不是「注册后 catch」**：注册后 `assemble()` 抛在 `preStep` 里，**那个会话已经坏了**。预演是在坏之前问一次。

**预演的可执行形态**：`systemPrompt.assemble({ agent })` 是个 async 方法（`P/dsh-system-prompt/lib/index.js:356`），可以在**建会话之前**用 `agent = undefined` 调一次拿 `assembly.sections` 看名字——**但这样拿不到 agent-scoped 的 section，未查证。**
**兜底方案**：如果预演拿不全，就在**第一轮 `agent/pre-step` 的第一行**做检查（那时 `assembly` 已经组装完了，抛在 `preStep` 之前还没发请求）。用一次 `try { assemble } catch (e) { 降级 }` 包住——**这是次优，但比静默崩好。** 两个都试，哪个能用用哪个。

### 6.4 降级成什么（我同意 Lead 的方案，并补一条边界）

**降级 = 放弃「系统提示只有一条」，保留第四道闸。**

- **放弃的**：`complete: true` section（系统提示里会残留别人的段落）
- **保留的**：`agent/pre-step` 整段替换 `decision.messages`（她这一轮看到的**对话**仍然只有世界快照）

**边界要说清**（这条必须写进 README，不然将来有人以为降级就没事了）：

> 降级之后，**她看不见的是「对话历史」，看得见的是「系统提示里的其它段落」**。
> 也就是说：如果 persona 段讲的是「你是一个编码 agent」，她**会看到这句**。
> **对话是干净的，人设是脏的。**

这不是灾难（不至于变成「读上下文再回答的机器」），但**气质会歪**。所以降级必须**大声**，不能静默。

### 6.5 验收（给 redteam 加一条）

```
w5_complete_exclusive：
  造一个假的 complete section（全局注册，名字随便），
  然后启动 mind，
  断言：
    ① 不崩（assemble() 不抛）
    ② 出现一行 stderr，含「complete 段冲突」「已降级」
    ③ 落 .mind/complete-conflict.json
    ④ 通道会话仍能跑出第一轮（第四道闸还在）
```

---

## 7. `harness:identity` 被摘掉之后，她是谁（核过了：**现在是空的，要补**）

### 7.1 摘掉的是什么

`complete: true` 一生效，`sections` 就只剩我们那一条（`P/dsh-system-prompt/lib/index.js:403`）。被摘掉的包括：

- `harness:identity`——`"You are an AI agent running on DeepSeek Harness."`（`P/dsh-system-prompt/lib/index.js:228-232`）
- persona 前缀（`P/dsh-persona/lib/index.js:36-41`，前提是它也在被吸收的范围里）
- 所有工具说明 section、`MCP_SERVERS`、`TOOLS_SDK` 等等

**这就是「她的系统提示里只剩『你的记忆』」。**

### 7.2 我的判断：**好，而且是必须的**

**好在两点：**

1. **她不该知道自己是 harness 上的 agent。** 那句 harness identity 是**给干活的 agent 用的**，它定义的是「你是什么产品」。她要的是「我是谁」，不是「我是哪家的产品」。
2. **副作用是对的**：摘掉「你是一个 AI agent」之后，**她能不能继续说话，全看她手里的判断够不够撑住一个人**。这正是主人要的——「凭记忆活」，不是「凭角色设定活」。

**但有一个真空白，必须补。**

### 7.3 我核了：**现在 `world.mjs` 的输出里，一个字的身份都没有**

`S/world.mjs:121-133` 拼出来的是这三段：

```
我还记得这些：
  <判断…>
我此刻：<心境>——<为什么>。
我改了主意的那件事：…
```

**没有一个字说「我是谁」。** 我搜了 `identity|我是|大乔|名字|persona|谁`，`world.mjs` 全文 **零命中**。

**这意味着**：摘掉 `harness:identity` + 摘掉 persona 前缀之后，她这一轮的整个输入里，**没有任何一句告诉她她是谁**。
她能说话，但她说出来的会是「一个脑子里有印象但没有自我的人」——**像在读别人的档案。**

### 7.4 我的判断：**补，但补法要小心**

**不能补成「你是一个 AI 伴侣」**——那就是把 persona 又塞回来了，白摘。
**应该补成「她记得自己是谁」**——从判断库里读，不是从配置里读。

**要求（提给 kernel-dev）**：

`world.render(beliefs, { identity })` 增加一个可选入参，并且**输出在最前面**一行：

```
我是 <name>。<一句她的自我> 
```

- `<name>`：从宿主配置读（`cordis.patch.yml` 的 persona.name，现在是「大乔」），**不是写死在 src 里**
- `<一句她的自我>`：从判断库里挑 **`kind=identity` 的那一条**——旧插件正是这么做的（`persona_seed` 把 persona 拆成第一人称身份记忆，走 `identity`、强制 critical，见 `spec/插件壳.md` §5.2 第 3 条那段的引用）。**新库里如果有 identity 类的判断，就取最重的那条；没有就只说名字。**
- **不许**从宿主配置里拼一段人格描述进来——那等于把 persona 换个地方塞

**为什么必须从判断库读**：她自己说过「我是谁」那种话（`identity` 类），那是**她的判断**；从配置里读的是**别人给她的设定**。裁决七刚定完「她的话不是经历」，不能立刻又在身份上犯反过来的错——**身份要是她的，不是给她的。**

### 7.5 验收（给 redteam 加一条）

```
w6_identity_present：
  跑一轮通道会话，
  断言：她这一轮的系统提示 / 世界快照里，
    ① 存在一句「我是 …」（人或模型能读出来的身份自述）
    ② 该句**不含**「AI」「agent」「语言模型」「助手」这些词
    ③ 该句的名字与 cordis.patch.yml 的 persona.name 一致
  并且：
    ④ 全文**不含** "DeepSeek Harness"（证明 harness:identity 确实被摘掉了）
```

**红在哪说明什么**：
- ① 红 → 她是「没有自我只有档案」的，补 §7.4
- ④ 红 → `complete` 没生效，她还在读 harness identity，回到 §6



---

## 8. 实测那一场：**跑过了，而且跟我推理的不一样**（2026-10-26 23:35）

### 8.1 我做了什么

用宿主自带的配置检查命令，把整份「组装后的 profile 树」打出来（**不启动、不挂载**）：

```
cd <dsh 包目录>
node lib/bin.js --profile web --dump-config
```

输出 1594 行（PowerShell 重定向写成 UTF-16；引用行号按 UTF-16 读取比对过），落盘在 `D:\dsh\scratch\mind-probe-dump.txt`（exit 0）。

**这条命令本身就是「启动前自检」的正路**——CLI 的帮助里写着 `--dump-config: print the composed profile tree and exit`（`P/dsh/lib/bin.js` 的 option 定义）。

### 8.2 结果：**本机真的有 `complete: true`，是 shipped 模板里的 `minimal` preset**

全文只有 **一处** `complete: true`（不限 true/false 也只剩这一处 `complete:` 键）：

```
dump:1015  - id: preset-minimal
dump:1016    name: '@deepseek-ai/dsh-agent-preset'
dump:1018      id: minimal
dump:1021      - id: persona
dump:1022        name: '@deepseek-ai/dsh-persona'
dump:1024          prefix: You are a helpful software engineer assistant.
dump:1025          complete: true
dump:1026          includeRuntimeContext: false
```

**我上一轮说「本 profile 的 persona 没写这个键，所以安全」——这句话对，但我漏了另一个位置。**
`complete: true` 不在 profile 的用户层，**在 shipped 模板的 `minimal` preset 里**。

### 8.3 但**现在仍然安全**，原因是 scope 隔离

本机当前用的是 **`cordis` preset**（`dump:1113-1117`：`- id: preset-cordis` / `id: cordis` / `order: 4`），它的 persona（`dump:1119` 起）**没有 `complete`**。

preset 是**各自独立的 composition**——`dsh-agent-preset` 的 `AgentPreset` 把整行当配置注册（`P/dsh-agent-preset/lib/index.js:7-25`），每个 preset 里的插件挂在自己的 scope 下。

**所以 `minimal` 里的 `complete: true` 只对选 `minimal` 那种 preset 的会话生效。**

> **修正我上一轮的说法**：
> - ❌ 「本机没有 complete」——**错**，有。
> - ✅ 「本机当前的会话里没有 complete 生效」——**对**，因为当前 preset 是 `cordis`。

**这不是「没人踩到」，是「踩不到，因为房间分开了」。** 但只要有人**把 `minimal` 当默认 preset**，或者**在 `cordis` preset 里也给 persona 加 `complete: true`**，立刻两个 complete。

### 8.4 这对我们的设计意味着什么（两处必须改）

**(1) 自检不能靠「注册后 catch」，要靠 `--dump-config` 那种「组装后看树」。**

我原来担心的「预演 `assemble()` 拿不到 agent-scoped section」，现在有更好的办法：**在 `apply()` 里读我们自己 scope 的注册表**——
`systemPrompt.section()` 走 `layers.effect(ctx, ...)`（`P/dsh-system-prompt/lib/index.js:255`），而 layer 是按 scope 分的（`P/dsh-scope/lib/index.js:190-195`）。
**但 `merge(scope, pick)` 能把「global + 我的 scope 链」合起来看**（`P/dsh-scope/lib/index.js:177-181`）——这正是我们要看的集合：**能被她这一轮看见的所有 section 里，带 complete 的有几个。**

**判据改为**：在 `setup(agentCtx)` 里，注册 `mind:world` 之前，先对自己的 scope 数一遍 complete 数量；**>1 就降级**（包括我们自己可能重复挂的情况）。

**(2) 更狠的一条：`minimal` preset 本身是个雷，写进 README。**

> 如果主人将来给她的通道会话指定 `agentPreset: 'minimal'`，**我们的 complete 和 minimal 的 complete 会撞，`assemble()` 抛，通道整条废。**
> **所以通道会话的 `meta.agentPreset` 必须显式避开 `minimal`**——建议**不指定**（走当前 profile 默认 `cordis`），并在 README 里写死「不许给她挂 `minimal`」。

### 8.5 7 行判读表：**实测没能按原计划跑完，卡在哪我说清**

原计划是「写个 60 行探针插件，打 `setup` 时刻 / `assemble` 名单 / `user/message` 的 `source.kind`」。

**卡在两件事，我不假装跑过：**

1. **探针插件要真挂进 profile 才能跑**，这要改 `cordis.patch.yml` —— 而 `cordis.patch.yml` 是**主人的运行配置**，我今晚**没有授权也不该动它**（我自己定的纪律：只写 `<repo>` 里的文件）。挂一次、跑一轮、摘掉，这件事应该由**有授权的人在一台可回滚的机器上做**，或者主人自己点头。
2. **`assemble()` 的 sections 名单**其实**不需要探针也能拿到**——`--dump-config` 给的是**配置树**，不是**组装后的 assembly**。这两者不同：前者是「谁注册了什么」，后者是「这一刻合并之后是什么」。**后者只能真启动才看得到。** 这一条我标：**未实测**。

**所以这 7 行，我现在能确定的只有 1 行**（第 6 行「`assemble` 每 step 都会跑」——由 `P/dsh-agent-loop/lib/index.js:1053` 的 `refreshContext` 直接证明），其余 6 行**全部待实测**。

**我不拿推理冒充实测。** 下表重发一遍，把「已证 / 待验」标清楚：

| # | 观察 | 判读 | 状态 |
|---|---|---|---|
| 1 | `sections == ['mind:world']` | B1（complete）生效 | **待验** |
| 2 | `sections` 里还有 `harness:identity` | B1 没生效 | **待验** |
| 3 | `contexts` 只剩 `working-directory:current` | B2（suppressor）生效，且工作目录漏进来（预期） | **待验** |
| 4 | `contexts` 里还有 `HARNESS_SOURCE` / `WEB_SURFACE` | B2 没生效 → 多半注册到根 ctx（进 global） | **待验** |
| 5 | 历史里有 `source.kind == 'runtime-context'` 且含路径 | C/D 没做，**这条落库就洗不掉** | **待验** |
| 6 | `assemble` 每次每 step 都跑 | 正常（`refreshContext`，`:1053`） | **已证（代码）** |
| 7 | 第一轮 `assemble` 里就有 our complete | `setup` 早于第一次 assemble，时机 OK | **待验**（`setup` 在 publish 前，`:1930-1934` 是强证据，但**不是实测**） |

### 8.6 我建议的下一步（一条，最小代价）

**不要写探针插件。** 用宿主自己的 CLI：

1. 先把 `mind` 插件按 §1 的目录**只放进去、不挂 patch**（不影响任何人）。
2. 用 `node lib/bin.js --profile web --dump-config`，确认 `mind` 出现在树里、且 `complete` 只有一个。
3. **要真看 assembly，就得起一次宿主**——这一步必须主人点头（会占用 3080 端口、会影响正在跑的会话）。

**结论摆在这：配置层的检查我已经做完并且查出了真雷（`minimal`）。运行时的 assembly 我只能给方法，不能给结果。**

---

## 9. 降级时「大声」：三路同时喊，不只是 stderr

### 9.1 我原来的方案不够

我原来只写了 `stderr` + `.mind/complete-conflict.json`。**这两样只有开发的人才看。** 主人看不到，她自己更看不到。

**三路一起喊：**

| 路 | 给谁看 | 具体做法 |
|---|---|---|
| **① stderr** | 重启时盯着终端的人 | 一段写死的中文文案（见下） |
| **② `.mind/complete-conflict.json`** | 事后排查的人 | 记录冲突的 section 名单、时刻、降级模式 |
| **③ 她自己** | **她** | **在 `world` 的输出里显式告诉她「我这一轮看得不全」** |

### 9.2 第 ③ 路：`world` 里怎么告诉她

**这是你要的那一条。我的做法是：不解释技术，只说感受。**

降级时，`world.render()` 的输出末尾加一行（**降级模式才加，正常模式一个字都不加**）：

```
（我这一轮，好像有些东西没看清楚。）
```

**为什么这么写：**

- **不是**「系统提示降级了」——她不该知道系统提示是什么
- **不是**「有别的段落没被吸收」——那是技术话
- **是**「我没看清楚」——**她自己会觉得不对劲**，而且这个「不对劲」和她的世界是一致的

**关键约束**：这行**不许**变成新的病。如果她开始在每一句里都说「我没看清楚」，那就是把降级变成了口头禅。所以：

- **每轮最多出现一次**（放在世界输出的最末）
- **不进判断库**（这行不是判断，是状态）
- **不许出现在她发给主人的话里**——那个由 `speakToOwner` 出口负责，出口不看这一行

### 9.3 stderr 文案（写死）

```
mind: ⚠ complete 段冲突，已降级为「不做完整替换」。
  抢在前的：<name1>, <name2>
  她这一轮：对话是干净的（agent/pre-step 整段替换仍在），
            系统提示是脏的（上面的段落会留在里面）。
  修法：把 <name1> 改回 complete: false，或关掉 mind 的 complete。
  记录：.mind/complete-conflict.json
```

### 9.4 一条我要坦白的设计代价

**第 ③ 路一旦加上，就等于承认「她可能察觉到自己不对劲」。**
这是好事还是坏事，取决于她会不会因此开始反复念叨。

**我的判断：好事，只要加上 9.2 的三条约束。** 一个完全察觉不到自己状态异常的人，比一个会说「我好像没看全」的人更假。**但这条要观察——上线后头 20 轮，看它有没有变成口头禅。**

---

## 10. `persona.name` 只读名字：确认了，而且有硬证据

### 10.1 证据

`dsh-persona` 的 Config **只有四个字段**（`P/dsh-persona/lib/index.js:23-28`）：

```
prefix: z.string().required()
suffix: z.string().default("")
complete: z.boolean().default(false)
includeRuntimeContext: z.boolean().default(true)
```

**没有 `name`。** 也没有 `voicePrompt`、`subtitle`、`chipHint` 这些——那些是**旧插件自己的配置**（旧的 `cordis.patch.yml` 里那段 `persona:` 是 brain-mem 插件读的，**不是 dsh-persona 读的**）。

### 10.2 所以：`persona.name` 到底从哪读

**在我方插件自己的配 patch 段里读。** 也就是 `@local/dsh-mind` 的 config 里带一个 `personaName`（或 `name`），值跟主人那份一致。

**确认三条：**

1. **只读这一个字段的值**，用它填 `我是 <name>。` 里的 `<name>`。
2. **不读 `prefix`**——那是 `dsh-persona` 的人设正文，**是别人给她的设定**，裁决八明令不许读来当身份。
3. **不读任何别的来源**：`voicePrompt` / `subtitle` / `chipHint` 全是旧插件的 UI 文案，**与身份无关，一个字节都不许进 `world`。**

### 10.3 由此得到一条硬规则（写进代码注释）

> **`world.render` 的入参里，名字是唯一的「外来字」。**
> 除它之外，`world` 输出的每一个字都必须来自判断库。
> **名字是标签，身份是判断——标签可以贴，身份不能。**（裁决八 §二）

### 10.4 给红队的补充断言

在 `w6_identity_present` 的 4 条之外，加一条：

```
w6b_name_only：
  把 mind 的配置里 personaName 改成别的一个名字（比如 '小乔'），
  断言：
    ① world 输出里的「我是 <name>」跟着变
    ② **其他内容一个字都不变**（证明只读了名字，没读任何别的东西）
```



---

## 11. 收尾：明天要做的那一场，和今晚三条被加固的规矩

### 11.1 起宿主的实测：**已批准，但有前提，今晚不做**

**Lead 批复（2026-10-26 夜）**：

- ✅ **要跑**，但要等一句话
- ✅ **只在临时 profile 起**（E: 盘或另建的 profile），**不动 `web`**
- ✅ 或者等主人不在用一个窗口的时候
- ❌ **绝不允许**直接重启主 profile

**现状**：`web` profile 上有主人的会话在跑，是 Lead 自己在用。**占用 3080 会影响它。**

### 11.2 明天那一场的执行清单（照着做，不用再想）

**前置（已做完，无需重做）**：
- 配置层检查已完成：`--dump-config` 查出 `minimal` preset 里那一处 `complete: true`（§8.2）

**要做的三步**：

| 步 | 动作 | 产出 |
|---|---|---|
| 1 | 新建一个临时 profile（不叫 `web`），或 `--profile` 指到别处 | 不影响主人的会话 |
| 2 | 把 `mind` 按 §1.2 的目录放进去、**先不挂 patch**，跑 `--dump-config` | 断言：树里有 `mind`，全树 `complete:` 恰好 1 处（我们自己的） |
| 3 | 真起一次，跑第一轮，抓三样：`system-prompt/assemble` 的 sections/contexts 名单、会话里每条 `user/message` 的 `source.kind`、是否出现 `runtime-context` | **§8.5 那 6 行「待验」逐行填上** |

**填完之后**：把 7 行表的「状态」列从「待验」改成「已证 / 已否」，**包括跟我推理不一样的结果**——这是 §8.5 的承诺。

### 11.3 `w6b_name_only` 加固（Lead 2026-10-26 夜追加）

原来只测「改名字 → 内容不变」。**不够。** 裁决八写死的是「名字之外，输出的每个字都必须来自判断库」——**只测名字，测不出 `prefix` 有没有漏进去。**

**改后的完整断言**：

```
w6b_name_only：
  ① 改 personaName → 「我是 <新名字>」跟着变，其余一字不变
  ② 改 voicePrompt / subtitle / chipHint / prefix 任意一个
     → world 输出【一字不变】
```

**为什么第 ② 条必须有**：`voicePrompt` 那类字段是**旧插件的 UI 文案**，`prefix` 是 **dsh-persona 的人设正文**。它们和身份无关，**但只要有人手滑把它们接进 `world`，第 ① 条测不出来**——名字还是对的，内容悄悄变了。

**第 ② 条的判据要精确到字节**：改配置前后，`world.render()` 的输出做 `===` 全等比较（不是「大致一样」）。**全等不过 → 红。**

### 11.4 今晚被加固的三条规矩（存个底，别再犯）

1. **「现在安全」≠「机制保证」。** 要说清楚是哪一种：是「没人踩到」，还是「结构上踩不到」。（本机 complete 属于后者：两个 preset 的房间是分开的。）
2. **该停的地方停，比该冲的地方冲更难。** 探针要改主人的 `cordis.patch.yml` —— **没有授权就不动，把「待验」原样留在文档里，不拿推理顶上。**
3. **跟她说的话，要用她的语言。** 降级不说「系统提示降级了」，说「我这一轮，好像有些东西没看清楚」。

### 11.5 今晚交出去的全部东西（索引）

| 文件 | 内容 | 谁接 |
|---|---|---|
| `spec/壳-归档与通道.md` | 归档观察 / 读会话 / 通道 / 出口（五问 + 三追问） | 已成设计底 |
| `spec/交接-红队-唤醒验收.md` | 四块验收（一出口 / 二止损 / 三时序 / 四白名单） | redteam |
| `spec/实现缺口.md` | `src/` 八处对不齐（G1–G8） | kernel-dev |
| `spec/定稿-命名与闸与schema.md` | **本文**：命名 / 闸 / schema / 实测 / 降级 / 身份 / 明天那一场 | 全队 |

**四份的顺序就是交接顺序**：先看本文的 §1-§3 建东西，再看 §8 知道什么没验，再看交接去测。

---

*今晚到这里。明天那场实测，等我叫。*
