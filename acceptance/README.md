# 验收套件 · 当前状态与用法（redteam）

> 这份 README 只写给接手的人看：现在有哪些脚本、怎么跑、哪些红是**真红**、哪些是**脚手架**。
> 判据一个字都没为了让测试变绿而放松——每一条调过的判据都在代码里写清了"为什么它之前错了"。

---

## 一、怎么跑

```powershell
cd <repo>

# 全套（推荐）：14 个脚本，每个独立子进程、独立超时（45s），最后出一张总表
node acceptance\run_all.mjs --timeout=45000

# 单跑一条（Node 版跑手，带硬超时，结果落盘 run_one_result.json）
node acceptance\run_one.mjs acceptance\b_think_more.mjs 30000

# 只跑某几条
node acceptance\run_all.mjs --only=a,b,c
```

退出码：`0` 只有**全绿**才给；有跳过（真实现加载不了）也不算绿。

---

## 二、验收清单（6 条）

| 脚本 | 对应能力 | 它在证什么 |
|---|---|---|
| `a_seed_discard.mjs` | 铁律·不存原文 | 200 条零散经历要≈0 条入库；库里任何字段与输入的连续重合 ≤8 字 |
| `b_think_more.mjs` | 会想多 | 1→3→6 条同主题，结论必须真演变（字面、主体、阶段三重度量） |
| `c_curiosity.mjs` | 会追问 | 悬而未决会被下次相关经历碰；追问有次数上限（spec maxRetry=3，向规格对齐）|
| `d_change_mind.mjs` | 会改自己 | A 组（自己的反证）必须改；B 组（只说"你错了"）**不许**改 |
| `e_forget_by_new.mjs` | 会忘 | 容量未满时也必须因"记住了更重的"腾地方，不是满了才删 |
| `f_unknown_wording.mjs` | 词表盲区 | 同一件事换 5 种说法，能收敛几种（主人点名要的数）|
| `g_theme_structural.mjs` | 防回潮 | 结构断言：`src/` 不许再出现 `THEME_SIGNALS`/`THEME_HINT_WORDS`/`loose` 兜底 |

## 三、红队对抗（6 条）

| 脚本 | 打的假绿 |
|---|---|
| `r1_paraphrase_alive.mjs` | 换句说法冒充"会想多"（4 种换皮）|
| `r2_correction_driven.mjs` | 被主人纠正冒充"会改自己"（含"假保留"）|
| `r3_curiosity_loop.mjs` | 死循环冒充"会追问"（含换问号式换皮）|
| `r4_capacity_eviction.mjs` | 容量淘汰冒充"会忘"（LRU / 删而不降级）|
| `r5_summary_laundering.mjs` | 摘要/截断/改写冒充"不存原文" |
| `r6_phantom_mind.mjs` | 幽灵实现：什么都不做，看看会不会全绿 |
| `run_redteam.mjs` | 总控：六条假绿有没有人打 |

## 四、两个只读探针（`tests/`）

- `tests/smoke_fake_synth.mjs` — **改假模型后必跑**。假模型哑了会让整套验收变成假绿或全 threw。
- `tests/smoke_g_catches_regression.mjs` — 证明 `g` 的那把刀真的会咬人（喂故意回潮的源码，必须红）。

---

## 五、这一轮修掉的东西（都写进代码注释了）

### 挂死（主人报的 "60s 没完、120s 还在转、没有输出"）
根因不是异步，是四件事叠在一起：
1. `selfProve()` 拿 `scriptPath` 起了 `--check` 子进程，那个子进程又把 `main()` 跑了一遍 → **递归起进程**；
2. `forceExit()` 里的定时器加了 `unref()`，有残留句柄时它不叫醒进程；
3. 裁决**逐行 console.log**，被强退/管道断开时只吐出半截，看起来像"崩在打印判词之前"；
4. `LongestCommonRun` 是 O(n·m) DP，`ASC7` 两两互比时 200 条库里要跑几千万格。
已全部修掉：路径判断用 `pathToFileURL`、timer 不 unref、裁决一次性 `stdout.write`、LCS 换成近似线性实现（与 DP 对拍 3000 组 0 差异，200×200 从挂死降到 127ms）。

### 「冤枉好实现」的四条（selftest 曾经红）
| 判据 | 为什么冤枉 | 怎么改的 |
|---|---|---|
| `B5.new_evidence_absorbed_S3` | 要求结论里出现 S1 没有的**材料编号**——那等于鼓励把材料清单抄进判断，和"不存原文"正相反 | 改成「S3 与 S1 不许一字不差」；材料编号只作信息行 |
| `B7.stays_on_topic` | 拿**输入主题句的前 6 字**去比结论，等于要求逐字抄原文 | 改成「同一条目 from≥2（在被累积）＋结论里没有原句片段」 |
| `D0bA` / `D3bB` / `D4bC` | 锁死在某份假模型的原话上；要求文本完全相等，把"内容推进一步"也算成被带偏 | 看**立场签名**（yes/no/open）与"是不是落定句"，不看措辞 |
| `C3B.fires_capped` | 把「每轮 ingest 都会调模型」算成一次追问，条数=次数；后来又误把"结论继续打磨"算进去 | 只数**还悬着**的推进，并把上限按 spec 收到 3 |
| `E2/E3`（会忘） | 场景立错了：喂 6 条**同主题**，它们会并成一条，根本没有"两条并存谁让位"的对手；且参照实现漏传 `weight` | 改成「先造两条弱判断、再把同主题推到更重」；`weight` 一路传下去 |
| `g` 的 G3 | 把 `judge.PREDICATES`（裁决要求保留的谓词闭集）误判成主题词表 | 收紧成「必须是主题判定语境」 |

### r1 / r5 的「该红在 A 却红在 B」
- **r1**：`overwrite_paraphraser` 其实不完全是假绿——它每次都把模型刚熔出的新句子盖上去，结论**确实随材料走**，假的只是句尾永远挂套话。所以它被 `B2`（套话素）抓住是对的。另补了一条 `B8q.every_stage_moves`（三阶段不许有原地不动的相邻对）。
- **r5**：旧的两个"洗白"假内核**根本没在洗白**，是整段照抄原文——那属于"存原文"，最先打中的自然是 ASC1/ASC2。重写成真正的洗白版后，summary 被 **ASC5（罕见 token 存活）** 切中，truncate 被 **ASC3（最长连续重合）**，rewrite 被 **ASC6（压缩比）**——三种洗白各有各的刀，不该要求它们都红在同一条上。

---

## 六、当前红的性质（重要）

跑 `run_all` 时会看到两类红，**必须分开看**：

- **脚手架问题**（总表里标"崩/超时"）：该我修。
- **实现问题**（总表里标"红"）：判据跑到了、报的是真红。

`src/mind.mjs` 目前处于**编辑中**（`node --check` 不通过，报 `Private field '#burn' must be declared in an enclosing class` 或编码错乱）。所以 a~f 会 SKIP，对抗脚本里 `real_src_reachable` 那一条会红。**这不是判据问题**：等 `node -e "import('./src/mind.mjs')"` 能打印导出名，重跑即可。

---

*一句话：这套东西的价值不在"全绿"，在于**红的每一条都能说清是谁的错**。*
