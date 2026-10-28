# 2026-10-28 改动清单（给接手的人）

> 这份文档是**交接用**的。按「改了什么 → 为什么 → 验证到哪一步 → 还有什么没做完」排列。
>
> 分支：`main`　提交范围：`6e8655c` 之后

---

## 一、总览

一句话：**把「判断权」从模型手里拿回来，让它从记忆自己数出来；再把「主动性」这条路接上，让她能自己出去做事。**

改动规模：26 个文件，约 +2400 行。新增 11 个模块。

---

## 二、五个 P0（数据完整性，必须先看这些）

| # | 文件 | 原来是什么病 | 现在 |
|---|---|---|---|
| A1 | `src/digest-session.mjs` | `find(b => b.subject === j.subject && b.alive)` —— 按**对象**找现役判断，而对象归一后几乎都是「他」。**一次归档熔 4 条判断能全并进同一条，库里一条都不增** | 只认 `themeKey`（relation\|subject）精确匹配 |
| A2 | `src/digest-session.mjs` `normalizeOne` | 这条路**没有 grounding 那一问**，模型能从「今天吃了碗面」里编出「他熬到后半夜」 | 补上 `stabilityOf` + `mainPathHolds` |
| A3 | `src/forge.mjs` `mainPathHolds` | 两处无条件放行：第④问「长度≥6 → true」、HABIT 分支「以 subject 开头 + 有恒常词 → true」 | 两处都要求**理由贴着材料**（共享≥1 个二字实词） |
| A4 | `src/forge.mjs` `stabilityOf` | 「可识别率」算的是 `去重字数/总字数`，恒 ≈1，这一维从没生效 | 拆成 `ground` + `repetition` 惩罚 |
| A5 | `src/persist.mjs` `fingerPrint` | 手挑 7 个字段算指纹，落盘却是 30+ 字段。只改 `lastFired/why/turns/tension/...` 时指纹不变 → `save()` 跳过 → **修改永远丢** | 指纹直接哈希 `beliefToJson` 全量 |

### 复现数据（改前 → 改后）

```
4 条归档判断 → 库 1 条（全并进一条）   →  库 5 条（各自成条）
编造判断「他熬到后半夜」（材料「今天中午吃碗面」）→ 入库  →  被拦
只改 lastFired/why/turns/tension/settledFrom/asked → 六项全不落盘  →  六项全落盘
```

---

## 三、新增：底气可算（`src/strength.mjs`）

`weight`（模型给的）与 `strength`（证据算的）**分开存**，所有决策只认 `strength`。

```
support 0.45（见过几回，5 条撑满）
consistency 0.30（同方向占比；只 1 条时算"不知道"=0.5）
variety 0.10（来源数）
recency 0.15（30 天半衰）
× 反例惩罚 1/(1+反例×0.6)
```

校准点：

| 证据 | strength |
|---|---|
| 1 条 | 0.35（对齐原来默认 0.30） |
| 3 条一致 | 0.725 |
| 5 条一致 | 0.95 |
| 5 条 3正2反 | 0.377 |

接入点：`mind.#birth`、`mind.#burn`、`commitDigest`。读取点：`fade.value`、`wake.burdenOf`、`world.moodOf`、`flash.toNote`。

`explainStrength()` 能回答「她为什么这么想」。

---

## 四、新增：内核自己归纳（阶段 C）

| 文件 | 作用 |
|---|---|
| `src/event.mjs` | 观测结构 `{actor, action, polarity, text, themeKey, source, beliefId}` |
| `src/induct.mjs` | 纯统计归纳 + 四分类对账 |

**关键纪律**：每一次熔出一个结论就记一条观测（不管有没有新建判断）。
只记新建判断的话，38 条判断只对应 38 条观测，按 `(对象,动作)` 分组每组 1 条，`minSupport=3` 永远达不到——**归纳能力等于没装**。

`reconcile()` 四分类：`confirmed`（一致）/ `contested`（冲突）/ `novel`（内核独立发现）/ `thin`（证据不足）。

### 真数据结果（42 条判断 → 85 条观测）

```
✓ 我/checks_first  support=11  一致率=1.000
✓ 他/wants         support=8   一致率=1.000  「他要的是一个会自己起念头的记忆」
✓ 他/checks_first  support=7   一致率=0.857
✓ 我/learns_from   support=6   一致率=0.833
✓ 我/stalls        support=4   一致率=0.750
冲突 2 条
```

**已知限制**：`novel` 恒为 0，因为 event 只有「从判断倒推」一个来源。要让它出东西，event 必须有判断之外的来源（她自己的行为 / 工具结果）。

---

## 五、新增：第一手观测 + 表达（阶段 D）

### 断点

`plugin/collect.mjs:92` 的白名单只认 `user/human/owner`，**工具结果一条都进不了熔的材料**。她看得见（有工具、有识图），但看见的不入账。

### 接法

| 文件 | 作用 |
|---|---|
| `src/observe.mjs` | `tool/call` + `tool/result` → `(我, 工具, 成/败)` |
| `plugin/tool-observer.mjs` | 每跳增量读（`tool-cursor.json` 记账） |
| `src/express.mjs` | 把数字说成一句话——**模型只能说，不许改数字** |

`Mind.adoptClaim()` 收进库，之后参与 fade/wake/motive。

### 真数据结果（12 个会话 → 2237 次工具调用 → 30 条失败）

```
held 0.95  edit|我        「我做事总太急，没细看就上手，难怪改不成。」
held 0.95  read_image|我  「我看图总弄不成，才发觉自己手太急，没看仔细。」
held 0.72  bash|我        「我跑命令老是不成，才看见自己手太急，没弄明白就上手。」
```

### 表达层护栏

`parseExpressed()` 丢掉：带数字/「统计」「数据」等词、长度不在 4~48、说不出就 NULL。
**宁可让判断停在数字状态，不要一句编的。**

---

## 六、新增：主动性（阶段 F）

| 文件 | 作用 |
|---|---|
| `src/motive.mjs` | 冲动生成（四种来源，每条必须带 `why` 且出自记忆） |
| `src/preference.mjs` | 偏好学习（收获型 vs 满足型两把尺） |
| `src/budget.mjs` | 五道闸 |
| `plugin/motive-store.mjs` | 偏好与预算的账 |

tick 从「说/不说」变成「说 / 做 / 歇着」。

### 五道闸

驱动 ≥0.5 / 一天 ≤3 趟 / 间隔 ≥40 分钟 / **主人安静 ≥10 分钟** / 收获型回来要有产出。

### 轮转（三次迭代才调对）

| 迭代 | 问题 | 数据 |
|---|---|---|
| 初版 | 任一条悬案霸榜 | 7 次出去，**7 次全是同一件** |
| 第一修 | 按本地零点划界，跨零点失效 | 7 次 → 3 件 |
| 第二修 | 12 小时滑动窗 + 7 天内去过 n 次降权 | 4 件 / 7 次，**每天之内不重复** |

### practice 话术（两次迭代）

初版 `把cannot_say练熟` —— **不可执行**，她 turn 跑完、一句话没说、一个工具没调。
改成「想清楚『X』为什么老办砸 → 回来记一条我定的规矩」。

---

## 七、运行时的几个坑（都是生产实测踩出来的）

### 7.1 tick 链断掉

```js
void tick().finally(schedule);   // tick() 有一个 await 永不 resolve → 链静默死掉
```

修法：
- `next()` 里加 `inFlight` 并发闸，跳过这一拍但**照样排下一次**
- 硬超时 2 分钟，**绝不 unref**（它就是保命的）
- `pokeWake` 走 `next()`，不直接调 `tick()`
- 每跳 `tick-alive {n}` 心跳

### 7.2 模型流挂死

`for await` 卡在「等下一个 chunk」时，循环内判断超时救不出来（**实测过**）。

修法：把消费过程塞进 Promise，和「到点 reject 的定时器」赛跑：

```js
await Promise.race([consume(), wall]);
```

### 7.3 遮蔽撕裂 tool 配对

```
[call] [call] │ [result] [result]
 遮     遮        留        留     ← 网关 400，会话报废
```

修法：切完再检查，配对两半落在切痕两侧的，**整对往「留下」那侧挪**。

### 7.4 配额双计

`wake-exit` 和 `applyWake` 各 push 一条 speak → `maxSpeakInWindow=2` 一次就满。
修法：只留 `applyWake` 记账。

### 7.5 token 预算

reasoning 模型 600 token 全烧在思考上，正文一个字不出（`len:0`）。
`speakMaxTokens: 600 → 2000`，表达调用 `240 → 1500`，`synthTimeoutMs: 45s → 90s`。

### 7.6 换屋死锁

新会话 blank → 侧栏不显示 → 找不到 → 没人说话 → 永远 blank。
修法：`roomTurns === 0` 时给一次开场许可，措辞改成「搬进新屋子，记得的事都在」；建好 3 秒后 `pokeWake()`。

---

## 八、**没做完的（接手重点）**

### 8.1 熔和遮蔽的时序 ⚠️ 最重要

主人的原设计：

```
记忆₀ + 你说的第 1 句 → 模型 → 记忆₁
```

**要的是「回完话立刻熔、立刻遮蔽」，不等 tick。**

现状：

| 项 | 状态 |
|---|---|
| `turn/end` 钩子挂上 | ✅ `turn-hook-armed` |
| 钩子触发 | ✅ `turn-end-hook` |
| 立刻遮蔽 | ✅ `compact-ok`（2026-10-28 15:30 已改成「整段遮、原文一条不留」） |
| **立刻熔** | ✅ **2026-10-28 15:30 真跑通**（见 §十一） |

原因：`turn/end` 那一刻 `agent.status` 还是 `running`，而 `digestChannelIncrement` 入口有 idle 闸，把自己挡死：

```
channel-digest-skip  why:"agent-busy" status:"running"
```

**已修**（`fromTurnEnd: true` 跳过 idle 闸），**并于 2026-10-28 15:30 实测跑通**（§十一）。

重启后应看到：

```
turn-end-hook
channel-digest-from-turn-end {"skipIdleGate":true}
channel-digest-start  fresh:1
channel-digest-done   judgments:N
compact-ok
```

**四行齐了才算成。**

### 8.2 其他

| 项 | 状态 |
|---|---|
| 记忆闸（`j` 那条红） | 未做。`wake()` 收了 `lastLedgerHash` 但 `gate()` 从没读过 → 账本不动照样开口 100/100 |
| 时序验证（`k` 那条红） | 未做，缺宿主 adapter |
| `novel` 恒为 0 | event 需要判断之外的来源才能出结果 |
| 偏好真实情绪源 | 现在只按「有没有产出」判涨跌 |
| `revision.mjs` 的 `fresh != null` 捷径 | 还开着（`reconsider` 这条路），`commitDigest` 已绕开 |

---

## 九、测试

```
node tools/verify.mjs         8 绿（含用真实记忆的渲染检查）
node tests/smoke_induct.mjs   14 绿
node acceptance/run_all.mjs   25 绿 / 2 红（j 记忆闸、k 宿主 adapter）
```

两条红是**已知未完成**，不是回归。

### 复现脚本

`replay/replay.mjs` —— 拿 `~/.dsh/sessions` 的真实会话回放：

```
node replay.mjs 2 54          熔 + 模拟
node replay.mjs 2 54 reuse    跳过熔，只跑模拟
```

注意：会话是**多帧 zstd**，`zstdDecompressSync` 一次只能解第一帧，需要按 magic `28 B5 2F FD` 逐帧解。

---

## 十、排查手册（这次踩过的）

| 现象 | 先看哪 |
|---|---|
| 她不动 | `mind.log` 最后修改时间 vs 现在；`tick-alive` 有没有在涨 |
| 熔了没 | `channel-digest-skip` 的 `why` |
| 话发不出 | `wake-speak sent:false` 的 `why` |
| 模型空回复 | `synth-reply len:0`，看 `chunks` 里有没有 `text-delta` |
| 会话 400 | 查 `tool/call` 和 `tool/result` 的 `callId` 是否成对 |
| 记忆没长 | `digest-owners` 的 `owners` / `chars` |

**PS 5.1 的坑**：`Get-Content` 按 GBK 读 UTF-8 文件会把中文变乱码，`ConvertTo-Json` 可能写出空文件。**改带中文的 JSON 一律用 node。**

---

## 十一、2026-10-28 晚：每轮熔真跑通 + 原文一条不留

> 主人原话：「先动那个每次对话都融的——那才是自由思考的关键，而不是基于上下文。」
>
> 改动文件：`plugin/index.mjs`、`plugin/synth.mjs`、新增 `plugin/shadow-plan.mjs`、
> `tools/verify.mjs`、新增 `tests/smoke_full_shadow.mjs`、`tests/smoke_tick_inflight.mjs`。
> 构建标记：`mind-build: 2026-10-28.full-shadow.4`。

### 11.1 三个真问题（都不是"看着像"的问题）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 她看起来活着，其实**装好之后只醒过一次** | `next()` 里 tick 成功返回时，finally 只 `schedule()`，**没给 `inFlight` 复位** → 之后每一拍都被并发闸跳过（日志 `tick-alive` 恒为 n:1、`tick-timeout` 从不出现） | finally 里补 `inFlight = false`。A/B 实测：修前 n=1、修后 n=1,2 |
| 2 | 熔完她还在拿上一轮原文当上下文 | 遮蔽规则是「永远留住最后几条原文」；实测 surface = `[system, 记忆, 两条 assistant, 一条主人原话, 注入]` | 不变量改成 **可见 = 未熔**：熔成功 → system 之后整段遮；没熔 → 一个字不遮 |
| 3 | 熔出来 **0 条**（`synth-reply len:0 reasoned:12998`） | 推理模型的思考也吃 `maxTokens`；默认档位下 4000 token 全烧在 reasoning 上，正文一个字不出 | 熔这一问降档 `reasoningEffort: 'low'`（她自己说话不降档） |

### 11.2 顺带修掉的两个坑

- **水位漂移**：cursor 记的是「可见的主人消息条数」，而遮蔽会让这个数变小 → 每轮 `reset:true`。
  现在「遮掉之后水位归零」，可见的即未熔的。
- **append 重入**：`turn/end` 事件正在被宿主发布时同步 append 会被拒
  （`compact-failed: session append cannot reenter while another append is being published`）。
  唤醒轮那一刀改成 `setTimeout(..., 1200)` 挪出事件栈。

### 11.3 实测证据（生产日志 + 会话文件）

```
07:30:13 turn-end-hook            turn:9 aborted(user)
07:30:13 channel-digest-from-turn-end  {"skipIdleGate":true}
07:30:13 channel-digest-start     fresh:1 total:1
07:30:21 channel-digest-done      judgments:1  cursorAdvanced:true
07:30:21 compact-ok               shadowed:67 startSeq:131 endSeq:367 kept:0
```

解开 `session-96c96e2e…` 的会话文件重放 surface：

```
最终 surface 节点数 3：system/message · mind-compact（记忆）· assistant/message（当前轮）
可见的「主人原文」条数：0
```

### 11.4 还有一处已知不一致（留给接手的人）

`compact-ok` 事件里 `sourceEventSeqs` 是 62 条，而宿主自己算出的遮蔽区间是 67 个节点
（差的那几只是本轮的 system/agent-instructions/runtime-context/skill-catalog/time-context 注入节点）。
当前宿主容忍（append 成功、遮蔽生效），但 dsh-session 的 `assertSourceEventReferences`
语义是「必须覆盖每一个被遮蔽的节点」——**宿主升级后这里可能开始报错**，届时要按它报的
missing 列表补齐，别把这一条当成"已经没问题"。

---

## 十二、2026-10-28 16:4x：经历层（阶段一）

> 主人问「为什么不记得具体那件事」。答：库里 26 条判断、0 条经历——
> 她记得「我很急」，却说不出哪一次急。那是评分表，不是记忆。

### 新增

- `src/episode.mjs`：`Episode = { id, at, who, what, feel, arousal, themeKey, source }`
  - `what` ≤48 字 / `feel` ≤24 字，**都过与判断同一把 8 字抄原文闸**（撞了整条丢）
  - 同一件事第二次不新建：`at` 推到最近、`arousal` 取高、`counts` 累加
  - TTL 90 天；上限 300；超限按「扎心度×0.6 + 新鲜度×0.4」淘汰
- `src/world.mjs`：「最近发生的事：」最多两条，没有就整段不出现（**不补默认话**）
- `src/persist.mjs`：经历与判断**同一次原子写**，并且**进指纹**
- 测试：`tests/smoke_episode.mjs`（26）+ `tests/smoke_episode_flow.mjs`（9，端到端含重启读回）
- `tools/verify.mjs` [⑥]：内容断言 + 四处接线静态检查

### 三个结构性 bug（都是静默失效，不报错）

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | `wake:false` 时 turn/end 熔**整条消失** | `startWakeLoop` 开头 `if (!cfg.wake \|\| !agentsSvc) return;` → `digestChannelIncrement`/`compactChannel`/`armTurnHook`/`tick` 全不定义 | 只挡「没有 agents」；tick 自己看 `cfg.wake`。熔是记账，醒是想不想开口，两件事不绑 |
| 2 | 换屋子后钩子永远不重挂 | 印章只写 `true`，旧钩子盯着旧会话 id | 印章 `{ id, off }`，换会话时先卸后挂 |
| 3 | `kick` 那条路漏挂时无人补 | 只挂一次 | tick 每跳核一次印章，不是当前会话就补挂 |

### 真实模型证据（隔离验证：临时会话 + 临时库）

```
turn-end-hook turn:2 → channel-digest-start fresh:2
→ channel-digest-done judgments:3 episodes:2 rawEpisodes:2 → compact-ok shadowed:8 kept:0
```

两条经历（落盘）：

```
那行留言还留在便签上，我看了很久也没去擦    （当时心里：像被点住，又不想认）
他把那页纸翻过去，只让我先坐下吃饭          （当时心里：坐稳后手还颤，才觉得慌）
```

第一铁律复检：与材料最长公共连续 **5 / 6 字**（≤8）→ 通过。
系统提示里已出现「最近发生的事：」——她真的看得见。

### 一条运维教训

同一个 YAML mapping 里写了两个 `channelSessionId`，后写的空串覆盖了前面的临时 id，
于是「配置改了却没生效」。一个 key 只许出现一次，已写进配置注释。
