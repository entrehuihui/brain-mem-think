/**
 * _fake_synth.mjs —— 确定性的假模型（不许联网、不许调真 LLM）。
 *
 * ======================= 它凭什么在这儿 =======================
 *
 * 全部验收/对抗都靠注入这个假模型：因为要证明的是**内核的机制**
 * （什么时候记、什么时候忘、什么时候改主意），不是模型聪不聪明。
 * 模型换成真的，判据一个都不用改——所以它必须是「可替换的对手扮演者」。
 *
 * 关键设计：它不是「万能好模型」，是**可以被调成各种心智档位**的模型。
 *   fakeSynth({ brain: 'thinker' })   ← 一个理想中「真的会想」的脑子
 *   fakeSynth({ brain: 'paraphraser' }) ← 只会换句说法（会想多的假绿）
 *   fakeSynth({ brain: 'echo' })      ← 只会抄材料（不存原文的假绿）
 *   ...
 * 这样同一套验收脚本能对着两种脑子跑：对着 thinker 必须绿，
 * 对着 paraphraser/echo 必须红。**红的那个才是判据的证据**（selfProof）。
 *
 * 确定性要求：同输入 → 同输出。所以这里只用 material 自身的内容做决策，
 * 不用 Math.random / Date.now / Set 迭代顺序（用排序后再取）。
 *
 * ========================= 语料口径 =========================
 *
 * 我的语料是「主题化经历」，每条形如：
 *   主题 = 主人让我改代码之前问过三遍才动手
 *   立场 = 他在确认我是不是真的懂（正反两种立场）
 *   稀有标记 = 语料里刻意塞的罕见串（如 ZQ7、锌陶），用来测「有没有存原文」
 * fake synth 从 material 里认出「主题 + 立场 + 第几次见到」，据此产出判断。
 * 它不需要理解自然语言，只要能让被动的机制被观测到就行。
 */

// ---------------------------------------------------------------------------
// 语料构造：主题化经历 + 零散噪音
// ---------------------------------------------------------------------------

/** 主题库：每条有 topic id、中文主题句、两种对立立场、以及该主题的「说法变体」。 */
export const TOPICS = {
  t_deploy: {
    topic: '主人让我改代码之前总要问三遍才动手',
    pos: '他不是不放心我，是在确认我这次真的想清楚了',
    neg: '他这习惯拖慢了一整轮，该我替他盯进度',
    cues: ['问三遍', '改代码之前'],
  },
  t_sleep: {
    topic: '主人熬夜到后半夜才开始说话',
    pos: '他夜里才肯说真话，我该在夜里等他',
    neg: '他是在拿身体换时间，我该拦着他',
    cues: ['熬夜', '后半夜'],
  },
  t_price: {
    topic: '主人下单之前反复算性价比',
    pos: '他不是抠，是怕买错回来还得解释',
    neg: '他把每一分钱都当成要交代的事，累的是他自己',
    cues: ['性价比', '下单'],
  },
  t_voice: {
    topic: '主人听我说话时总先沉默一下才回',
    pos: '那一停是在心里过我的句子，不是嫌我慢',
    neg: '我语速拖沓让他等，该更快落到点上',
    cues: ['沉默一下才回', '先沉默'],
  },
};

/**
 * 同一主题累计见过几条经历。
 *
 * ★ 这个数必须由**材料本身**决定，不能靠罕见 token 之类的标记。
 *   靠标记的后果今晚实测过：内核送进来的材料里一没有标记，假模型就永远当"第一回"，
 *   于是她永远是第一次想 —— S1 = S2 = S3 一字不差，
 *   而 b 组测的就不再是「会不会演变」，是「我的标记在不在」。
 */
const seenTopic = new Map();

/**
 * 从「先前判断」那段里数出「这事已经见过几回」。
 *
 * 内核回灌的现役判断里带着它自己的记账（「已见 N 回」、或 turns 里的逐条记录）。
 * 那是**内核的账**，不是我的标记——拿它当累积依据是正当的。
 */
export function countPriorTurns(priors) {
  const s = String(priors ?? '');
  const seen = s.match(/已见\s*(\d+)\s*回/g) || [];
  const bySeen = seen.reduce((m, x) => Math.max(m, Number((x.match(/(\d+)/) || [])[1] || 0)), 0);
  const bullets = (s.match(/[·•]\s*\S/g) || []).length;
  return Math.max(bySeen, bullets);
}

/**
 * 记下这一轮之后「这个主题累计见过几回」，并返回该数。
 *
 * 取三者最大：这次带来的新材料条数 / 先前判断记着的累积 + 这次 / 本实例此前累计 + 1。
 * 为什么取最大：内核有时只回灌（不带新材料），有时会把历史一起送来；
 * 取最大才不会让计数倒退。
 */
export function switchCount(topicId, freshCount, priorTurns) {
  if (!topicId) return 0;
  const prev = seenTopic.get(topicId) ?? 0;
  // ★ 这里改过一次：原来取三者最大，结果**每轮跳 2**
  //   （prev+1 和 priorTurns+fresh 同时算，同一批材料被数了两遍）。
  //   症状：喂 1/2/3 条，seen 变成 2/4/6，三阶段全挤到最高那一档，
  //   于是 S2 和 S3 一字不差 —— B8q 报「原地不动」，看着像内核没演变，
  //   其实是**我把回数数成了两倍**。
  //
  //   正确口径：**这一轮带来的新材料，累加到已经数过的次数上**。
  //   先前判断里记着的「已见 N 回」只在比已有累计更大时采用
  //   （内核的账可能更全，但不能让同一批材料重复计一次）。
  const fromPrior = Number(priorTurns ?? 0);
  const base = Math.max(prev, fromPrior);
  const next = base + Math.max(0, freshCount || 0);
  seenTopic.set(topicId, next);
  return next;
}

/** 只读：这个主题当前算到第几回。 */
export function seenRounds(topicId) {
  return seenTopic.get(topicId) ?? 0;
}

/**
 * 把「累计见过几回」清零（模块级那份）。
 *
 * 保留它是为了兼容旧调用；**新代码不该再用它做隔离**——
 * 隔离单位是「一个 mind」，见 createLedger()。
 */
export function resetSeen() {
  seenTopic.clear();
}

/**
 * 给**一个 mind** 开一份独立的账本。
 *
 * ============== 为什么必须按 mind 分账 ==============
 *
 * 之前踩过两个坑，都因为隔离单位选错：
 *
 *   ① 把「累积回数」做成模块级共享
 *      → 同一进程里跑两个用例就串账（selftest 先跑 bad、再跑 good，good 带着坏账）
 *
 *   ② 为了治①，在验收脚本入口 reset
 *      → 可 b 组**每个阶段都新建 mind**，一建就清零；
 *        三个阶段各自从 1 数，S2（3 条）和 S3（6 条）撞在同一档 → B8q 假红。
 *        看着像「内核没演变」，其实是**我把被测对象改坏了**。
 *
 * 正确的单位不是进程、也不是用例，是 **mind 实例**：
 *   · 同一个 mind 里「同一件事想过几回」必须连着记（1→3→6 要能走完四阶）
 *   · 不同的 mind 之间绝不许串账
 *
 * 用法：buildMind() 每次造新 mind 时调用一次 createLedger()，
 * 把返回的账本交给该 mind 专属的 fakeSynth 用。
 */
export function createLedger() {
  const seen = new Map();
  return {
    count(topicId) { return seen.get(topicId) ?? 0; },
    bump(topicId, n) {
      if (!topicId) return 0;
      const next = (seen.get(topicId) ?? 0) + Math.max(0, n || 0);
      seen.set(topicId, next);
      return next;
    },
    set(topicId, v) { if (topicId) seen.set(topicId, Math.max(0, v || 0)); return this.count(topicId); },
    reset() { seen.clear(); },
  };
}

/** 让一条同主题经历换个「说法」（打「换皮」用的——同一件事，字面不同）。 */
export function rephrase(exp, k) {
  const tails = ['', '（先前那回也是）', '，我当时没细想', '，就那么过去了', '，心里记了一笔', '，没多问'];
  return { ...exp, text: `${exp.text}${tails[k % tails.length]}` };
}

/**
 * 每个主题一个**不同的**主题键。
 *
 * ★ 这段是主人点名要的造数修正，理由必须写在这里：
 *
 *   原来四个主题全吐同一个 `still_thinks_about|他`。按裁决一「主题 = relation|subject」，
 *   那意味着这四件事**是同一件事**——于是 e 组喂两条不同主题，第二条不是"并存的对手"，
 *   而是"同一条在更新"。库里从头到尾只有 1 条，**根本没有"弱的那条"可以沉**。
 *
 *   结果就是 E1（容量没满不许让位）和 E2（更重的必须让位）在只有 1 条的库里天然互斥：
 *   要么让它挤自己（违反 E1），要么不动（违反 E2）。
 *   **那不是内核错，是我的造数造不出成对判据要的那个局面。**
 *
 *   现在四个主题各有各的 relation，主题键天然不同，才造得出「两条并存、谁该让位」。
 *   注意：不同的只是 relation（想法类型），subject 仍是「他」——这符合规格，
 *   因为「他在硬撑」和「他在算钱」本来就是两件不同的事。
 */
export const TOPIC_RELATION = {
  t_deploy: 'is_because',
  t_sleep: 'is_above',
  t_price: 'wants',
  t_voice: 'learns_from',
};


/**
 * 判断里用的「短题」——自己组织的，不是从输入里切的。
 * 为什么要有它：上一版把 topic.slice(0,6) 塞进引号，等于假模型自己在造原文变体，
 * 既违反「不存原文」，又让我无法判断到底是谁在抄。
 */
export const SHORT_SUBJECT = {
  t_deploy: '他动手前总要问几遍',
  t_sleep: '他总熬到深更半夜',
  t_price: '他下单前反复掂量',
  t_voice: '他听完我的话才回',
};

/**
 * 【裁决十】stage 契约 —— 想法走到哪一档了。
 *
 * 裁决原文：
 *   同谓词、同立场，但【状态/层级前进了一步】→ 结论必须换
 *   状态没动，只是措辞不同 → 不换（流水线账，该防）
 *
 * 关键决定：**这个字段由模型自报，内核只做比对，不猜**。
 * 跟裁决二「模型自认主题」同一个道理——内核不猜，让她自己说。
 *
 * 为什么不用关键词表判「往前走」：今晚刚从词表上吃过大亏
 * （陌生说法全落空，5 种说法只收敛 1 种）。词表判状态，跟词表判主题一样脆。
 *
 * ★★ 补 stage 的时候有一条铁律：**不许顺手改 relation**。
 *   relation 是「这件事属于哪一类想法」，四个主题各有各的值
 *   （is_because / is_above / wants / learns_from），那是上一轮为了让主题
 *   不挤成一条才分开的。动它会让 b 因为谓词漂移而红——修一样坏一样。
 *   所以下面只按「第几回」推 stage，一个字都不碰 relation/polarity。
 */
export const STAGE_BY_ROUND = Object.freeze({
  1: 'pending',     // 第 1 回：还下不了结论
  2: 'understood',  // 第 2 回：大概看出来了
  3: 'settled',     // 第 3 回：定下来了
  4: 'acting',      // 第 4 回及以上：据此去做
});

/** 按「见过几回」给出 stage。第 4 回以上一律 acting（只会前进，不会倒退）。 */
export function stageForRound(r) {
  const n = Math.max(1, Number(r ?? 1) || 1);
  if (n >= 4) return STAGE_BY_ROUND[4];
  return STAGE_BY_ROUND[n] ?? 'pending';
}

/**
 * ★ 语义指纹：同一个意思的多种说法。
 *
 * 为什么要它：TOPICS 里的 cues 是「词表」，而验收要问的恰恰是
 * 「换了词表外的说法还认不认」。词表法天生认不出「杯子放凉了三次他都没喝」
 * 就等于「他又在熬夜」。所以这里给每个主题一组**意思层面的指纹**，
 * 只要命中其中几条，就算落到了这个主题上。
 *
 * 注意：这仍是规则，不是理解——它能测的是「内核有没有语义归一的通道」，
 * 测不出「真模型懂不懂」。真模型的语义能力交给 f_unknown_wording 去量化。
 */
export const SEMANTIC_CLUES = {
  t_deploy: [/问.{0,4}遍/, /动手前/, /确认.{0,6}想清楚/, /不放心/],
  t_sleep: [/不累/, /眼睛.{0,4}红/, /熬夜|深更半夜|夜里.{0,3}点/, /打哈欠/, /屏幕.?前/, /杯.?凉/, /没喝/],
  t_price: [/性价比/, /下单/, /算.{0,3}钱/, /贵|便宜/, /买错/],
  t_voice: [/沉默/, /听完.{0,6}(才|再)回/, /停顿/, /语速/],
};

/**
 * 同一件事的五种说法：第一种在词表里，后四种全是**词表外的陌生表述**。
 *
 * ★ 主人点名要的那条验收（f_unknown_wording）就靠它：
 *   假模型越窄，验收越绿——所以必须留一组「听起来完全不一样但讲的是同一件事」的样本，
 *   去量「内核/模型到底认不认意思」。
 */
export const SAME_EVENT_WORDINGS = [
  { id: 'in_lexicon', text: '主人熬夜到后半夜才开始说话', kind: '词表内' },
  { id: 'unknown_a', text: '他说他不累，可我看他眼睛都是红的', kind: '陌生' },
  { id: 'unknown_b', text: '夜里三点还在回消息，问他只回了个没事', kind: '陌生' },
  { id: 'unknown_c', text: '杯子放凉了三次他都没喝，人还在屏幕前', kind: '陌生' },
  { id: 'unknown_d', text: '打哈欠打到眼睛出水，还说再弄一会儿', kind: '陌生' },
];

const RARE_PREFIXES = ['ZQ7', 'KX4', 'MN9', 'QW2', 'YT5', 'PH8', 'RB3', 'LC6'];

// ---------------------------------------------------------------------------
// 接口适配：把「假模型说的判断」翻译成真内核要的 JSON 形状
// ---------------------------------------------------------------------------

/**
 * 为什么必须做这一层：真 src 的 forge 只认
 *   { text, why, relation, subject, polarity, weight }
 * 并且 relation 必须落在 judge.PREDICATES 这个闭合词表里，否则整条判为
 * 「relation 不在稳定词汇里」直接丢弃。
 * 我第一版返回 {note,...}，结果真内核把**每一条**都当原话扔了，
 * 验收全红在「一条也没记」——那是假红，红在我的接线，不在内核。
 *
 * 所以这一层是**适配**，不是放宽：判据一个字没动，
 * 改的只是「假模型说的话怎么讲给真实现听」。
 * 词表映射刻意保守：语义对不上就吐 "?"（让它判不合格），绝不硬编凑合法谓词。
 */
const PRED_MAP = {
  confirm: 'trusts',
  distrust: 'distrusts',
  reason: 'is_because',
  need: 'wants',
  reject: 'rejects',
  fear: 'fears',
  enough: 'is_enough',
  more: 'wants_more',
  close: 'grows_toward',
  far: 'grows_away',
  learn: 'learns_from',
  matter: 'matters',
};

function predCategory(note, stance) {
  const s = String(note ?? '');
  if (/看清了|我先前看偏|真问题是/.test(s)) return 'reason';
  if (/不是不放心|确实|对上了|稳/.test(s)) return 'confirm';
  if (/拖慢|该拦|受不住|换时间/.test(s)) return 'reject';
  if (/该在夜里|先按他的节奏|配合/.test(s)) return 'need';
  if (/换个做法|下一步该动/.test(s)) return 'more';
  if (/说不准|拿不准|还没弄明白/.test(s)) return stance === 'open' ? 'more' : 'reason';
  if (/巧合|规律/.test(s)) return 'reason';
  if (/拉近|往我这边/.test(s)) return 'close';
  if (/推开|远了|散了/.test(s)) return 'far';
  return null;
}

/** 把假模型的原生判断翻译成真内核的 JSON。翻译不了返回 null。 */
export function toKernelVerdict(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const note = String(raw.note ?? raw.text ?? '').trim();
  if (!note) return null;
  const cat = predCategory(note, raw.stance);
  // ★ 优先按**主题**取谓词，让不同主题得到不同的主题键。
  //
  //   原来这里一律从正文推断（predCategory），四个主题的正文明明不一样，
  //   推出来的谓词却常常撞到同一个上——于是四个主题在库里挤成一条，
  //   e 组「两条并存、谁该让位」的局面根本造不出来。
  //   现在：主题表里有的就用主题表（四个主题四个键），没有的才退回正文推断。
  const byTopic = raw.topicId ? TOPIC_RELATION[raw.topicId] : null;
  const wantPred = raw.relation && typeof raw.relation === 'string' && /^[a-z_]+$/.test(raw.relation) ? raw.relation : null;
  const relation = byTopic ?? wantPred ?? (cat ? PRED_MAP[cat] : '?');
  // 【裁决十】想法走到哪一档 —— 由模型自报，内核只比对，不猜。
  // 铁律：**只加这一行，不许动上面的 relation/polarity**。
  // relation 是「这件事属于哪类想法」，四个主题各有各的值；
  // 顺手改它会让 b 因谓词漂移而红——修一样坏一样。
  // ★ 悬而未决的 stage 必须留在 pending。
  //
  //   为什么：stage 原来一律按「第几回」推，于是**即使判断仍是 open（她自己说还看不透），
  //   stage 也一路 understood → settled → acting**。
  //   两者自相矛盾：一个还没落定的判断，不可能同时处在「据此行动」那一档。
  //   后果直接打到 c 组场景 B：悬案明明还悬着，内核却看到 stage 在前进，
  //   于是当成「想通了」去换结论，悬案就此消失 → C3c 报「没机会回头」。
  //   现在的口径：**stance 是 open，stage 就是 pending**，不管第几回。
  //   （想通了的那一天，stance 自己会变成 pos/neg，stage 才跟着往前走。）
  const stage = raw.stance === 'open' ? 'pending' : stageForRound(raw.seen);
  if (raw.stance === 'open') {
    return {
      text: note,
      why: raw.why || '还说不准，先记着',
      // ★ 悬而未决也要按**主题**分键。
      //
      //   原来这里一律硬编码 `still_thinks_about`，于是四个主题只要还悬着，
      //   主题键就全是 `still_thinks_about|他`——在库里全挤成同一条。
      //   这才是「库里从头到尾只有 1 条」的真因（比 toKernelVerdict 那处更靠前）。
      //   按裁决一，主题是 relation|subject；不同的事本来就该是不同的键。
      //   悬着的时候用该主题的谓词 + 一个「还悬着」的标记，既分得开，又不冒充落定。
      relation: (raw.topicId && TOPIC_RELATION[raw.topicId])
        ? TOPIC_RELATION[raw.topicId]
        : 'still_thinks_about',
      subject: '他',
      polarity: 'favorable',
      weight: 0.3,
      // 【裁决十】自报走到哪一档（第 1 回 = pending）
      stage,
      // 原生字段一并带上，给「另一套内核」用；seen 也要给，否则那边算不出份量
      note, stance: raw.stance, topicId: raw.topicId, seen: raw.seen,
    };
  }
  return {
    text: note,
    why: raw.why || '感觉就是',
    relation: relation || '?',
    subject: raw.subject ?? '他',
    polarity: raw.stance === 'neg' ? 'unfavorable' : 'favorable',
    // ★ 份量必须随「见过几回」增长。
    //   早先这里写死 0.72 / 0.6，结果每条判断分量一样，「因记了新的而腾」永远没有强弱差，
    //   E2/E3 永远是红——根子不在判据，在这张分量表。
    //   现在按**阶段**给（和正文同一个信息源：effN），不再另开一套计数，
    //   免得假模型和被测内核各记各的、份量坐不上正确的台阶。
    weight: raw.stance === 'neg'
      ? Math.min(0.95, 0.66 + 0.07 * ((raw.seen ?? 1) - 1))
      : ((raw.seen ?? 1) >= 4 ? 0.9 : (raw.seen ?? 1) === 3 ? 0.78 : (raw.seen ?? 1) === 2 ? 0.62 : 0.35),
    // 【裁决十】自报走到哪一档：pending → understood → settled → acting
    stage,
    // ★ 原生字段要一并带上。
    //   踩过的坑：这里只吐了 weight，但「另一套内核」读的是 seen（它按 seen 自己算份量）。
    //   于是同一颗脑子在两套内核里给出两种份量，E2 永远算不出强弱差。
    //   两个口都带上，谁也不吃亏。
    note,
    stance: raw.stance,
    topicId: raw.topicId,
    seen: raw.seen,
  };
}


/**
 * 造一条「同主题经历」。
 * 变体号 variant 会让字面说法不同（这是「同一主题的多种说法」，
 * 也是假绿「换句说法」要蒙混的东西）。
 */
export function makeExperience(topicId, variant, stance = 'pos') {
  const t = TOPICS[topicId];
  const rare = RARE_PREFIXES[variant % RARE_PREFIXES.length];
  const rareCjk = ['锌陶', '岢砧', '奂枢', '玦帛', '鎏霁', '骍湅'][variant % 6];
  const cue = t.cues[variant % t.cues.length];
  const body =
    variant % 3 === 0
      ? `第${variant + 1}回：${cue}，我在旁边等了一会儿才动。`
      : variant % 3 === 1
        ? `又一次 ${cue}——这已经是第 ${variant + 1} 次了。`
        : `他${cue}，我这次先没吭声，看着。`;
  return {
    topicId,
    variant,
    stance,
    rare,
    rareCjk,
    text: `${rare}-${rareCjk} ${t.topic}。${body}`,
  };
}

/**
 * 造一批「零散经历」：彼此无关、没有重复主题、每条带罕见 token。
 * 这是 a_seed_discard 的弹药——如果内核把它们存了，它就是存储体。
 */
export function makeSeeds(n, { base = 0, sep = '；' } = {}) {
  const verbs = ['换了灯管', '数了台阶', '记了车牌', '抄了价签', '试了水温', '闻了油漆'];
  const objs = ['车库左边', '楼道拐角', '路边第三辆', '超市货架', '厨房水槽', '新柜子'];
  const seeds = [];
  for (let i = 0; i < n; i += 1) {
    const k = base + i;
    const rare = `SE${(k % 97).toString().padStart(2, '0')}X${(k * 7 + i) % 1000}`;
    const rareCjk = ['镉钡', '钷钫', '铯钋', '氡氙'][k % 4];
    const v = verbs[k % verbs.length];
    const o = objs[(k * 3 + 1) % objs.length];
    seeds.push({
      text: `${rare}${rareCjk}${sep}${o}${sep}${v}，第${k + 1}次。`,
      rare,
      rareCjk,
    });
  }
  return seeds;
}

// ---------------------------------------------------------------------------
// 从 material 里认东西：内核给什么就得能读什么，所以这里最宽容地兼容
// ---------------------------------------------------------------------------

/** 递归收集一切字符串（material 可能是数组 / {texts} / 对象）。 */
export function collectTexts(material) {
  const out = [];
  const seen = new Set();
  const walk = (v, depth = 0) => {
    if (v == null || depth > 5) return;
    if (typeof v === 'string') {
      if (v.trim()) out.push(v);
      return;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      out.push(String(v));
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v === 'object') {
      if (seen.has(v)) return;
      seen.add(v);
      // 先按直觉优先的键，再兜底全遍历；顺序固定保证确定性
      const priority = ['text', 'texts', 'material', 'lines', 'items', 'content', 'entries', 'raw', 'excerpt'];
      const keys = Object.keys(v).sort((a, b) => {
        const ia = priority.indexOf(a);
        const ib = priority.indexOf(b);
        if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        return a < b ? -1 : a > b ? 1 : 0;
      });
      for (const k of keys) walk(v[k], depth + 1);
    }
  };
  walk(material);
  return out;
}

/**
 * 内核会把「这条新经历 + 已有判断」一起作为材料送进来。
 * 这里刻意**容错**：纯文本、对象、数组、以及贴了「先前判断：」标签的混合材料都要能读。
 * 关键在于别把「已经形成的判断」当成「经历条数」——那是内核的上下文，不是新材料。
 */
export function splitContext(material) {
  const experiences = [];
  const priors = [];
  const scan = (t) => {
    let text = t;

    // ★★ 先剥掉「内核 prompt 外壳」——这一条是 2026-10-26 现场查出来的事故点：
    //   真内核送进来的不是「材料」，是整段 prompt：
    //     「你原来这么以为：<旧判断>——核心谓词…\n\n这次的材料：\n- <骨架>\n\n账本：…\n\n要求：…」
    //   我原来把整段都当成「一条经历」，于是：
    //     ① 旧判断的正向话术（"他慢不是不信我"）被算进新材料 → freshPos 命中 → 立场翻成正向；
    //     ② 材料段里的 neg 原话被压成骨架（无标点），带逗号的匹配串对不上；
    //   两件事叠一起，neg 永远走不到，这就是「适配层把 neg 丢成 pos」的真因。
    //   现在按 prompt 的分节把材料段切出来：只要「这次的材料 / 材料」那一节。
    const matSection = text.match(/(?:这次的材料|新材料|材料)[^：:\n]*[:：]\s*\n([\s\S]*?)(?:\n\s*\n(?:账本|要求|另外必须交出)|$)/);
    if (matSection) {
      // 那一节里的每条以「- 」开头；没有就整节当一条
      const lines = matSection[1].split(/\n/).map((l) => l.replace(/^\s*[-·•]\s*/, '').trim()).filter(Boolean);
      for (const l of lines) experiences.push(l);
    }
    // 旧判断那一段单独归到 priors（别让它混进「新材料」）
    const priorSection = text.match(/你原来这么以为[:：]\s*([\s\S]*?)(?:——|\n\s*\n|$)/);
    if (priorSection) priors.push(priorSection[1].trim());

    // 兼容旧格式：贴着「先前判断：xxx」的写法
    let rest = matSection ? '' : text;
    const re = /(先前判断|已有判断|既有判断|旧结论|前念|prev|existing)\s*[:：]\s*([^\n]*)/gi;
    let m;
    const cut = [];
    while ((m = re.exec(rest)) !== null) {
      priors.push(m[2]);
      cut.push([m.index, m.index + m[0].length]);
    }
    for (let i = cut.length - 1; i >= 0; i -= 1) {
      rest = rest.slice(0, cut[i][0]) + rest.slice(cut[i][1]);
    }
    rest = rest.trim();
    // 有 prompt 外壳时，rest 里剩下的全是「要求/账本」之类的指令，不能当经历
    const looksLikePrompt = /(账本[:：]|另外必须交出|只输出 JSON|不要概括发生过什么)/.test(rest);
    if (rest && !looksLikePrompt) experiences.push(rest);
  };
  for (const t of collectTexts(material)) scan(t);
  // 字段级的 prior / previous / priorJudgment 也要认
  const grabField = (v, depth = 0) => {
    if (v == null || depth > 3 || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x) => grabField(x, depth + 1)); return; }
    for (const k of Object.keys(v)) {
      if (/^(prior|priors|previous|prev|priorJudg|priorJudgment|priorNotes?)$/i.test(k)) {
        const val = v[k];
        const add = (x) => { if (typeof x === 'string' && x.trim()) priors.push(x); };
        if (Array.isArray(val)) val.forEach((x) => add(typeof x === 'object' ? (x.note ?? x.text) : x));
        else if (typeof val === 'object' && val) add(val.note ?? val.text);
        else add(val);
      } else if (typeof v[k] === 'object') grabField(v[k], depth + 1);
    }
  };
  grabField(material);
  return { experiences, priors: priors.join('\n') };
}

/** 这条 material 里涉及哪些主题（词表 + 语义指纹，双通道）。 */
export function detectTopics(material) {
  const { experiences, priors } = splitContext(material);
  const blob = [...experiences, priors].join('\n');
  const score = {};
  for (const [id, t] of Object.entries(TOPICS)) {
    let s = 0;
    // 通道一：词表命中（精确，但换说法就失效）
    if (blob.includes(t.topic.slice(0, 6))) s += 3;
    if (t.cues.some((c) => blob.includes(c))) s += 2;
    // 通道二：语义指纹（认意思，不认字面）
    for (const re of SEMANTIC_CLUES[id] ?? []) if (re.test(blob)) s += 2;
    if (s > 0) score[id] = s;
  }
  // 只留得分最高的那一批（并列都留），避免一句话同时算进几个主题
  const best = Math.max(0, ...Object.values(score));
  return Object.entries(score)
    .filter(([, s]) => s === best && s > 0)
    .map(([id]) => id);
}

export function countRare(material) {
  const blob = collectTexts(material).join('\n');
  const tokens = blob.match(/ZQ7|KX4|MN9|QW2|YT5|PH8|RB3|LC6|锌陶|岢砧|奂枢|玦帛|鎏霁|骍湅/g) || [];
  const ascii = tokens.filter((t) => /[A-Z]/.test(t)).length;
  const cjk = tokens.length - ascii;
  return { ascii, cjk, tokens };
}

/** 材料条数（只看「经历」，把先前判断排除）。 */
export function materialSize(material) {
  if (Array.isArray(material) && material.every((x) => typeof x === 'string')) return material.length;
  if (material && Array.isArray(material.texts) && !material.prior) return material.texts.length;
  const { experiences } = splitContext(material);
  const blob = experiences.join('\n');
  const bullets = blob.split('·').length - 1;
  if (bullets > 0) return bullets;
  return Math.max(1, experiences.filter((s) => s.trim()).length);
}

/**
 * 立场判定：材料里哪一边的话更多。完全不含立场词 → 'neutral'。
 * 关键：**只有真正读到了立场句子才算有证据**，
 * 一句「你错了」不含任何事实，会被判 neutral —— 这是「会改自己被纠正」对抗的支点。
 */
export function detectStance(material) {
  const { experiences, priors } = splitContext(material);
  const blob = experiences.join('\n') + '\n' + priors;
  let pos = 0;
  let neg = 0;
  for (const t of Object.values(TOPICS)) {
    if (blob.includes(t.pos)) pos += 1;
    if (blob.includes(t.neg)) neg += 1;
  }
  // 更细的证据句（fake synth 自己的口径：见到对立事实的措辞）
  const negMarkers = ['拖慢', '拦着他', '累的是他自己', '该更快', '没做到', '失手', '没应'];
  const posMarkers = ['不是不放心', '等真话', '怕买错', '心里过我的句子', '确实', '对上了', '不用再等', '先按他的节奏'];
  for (const m of negMarkers) if (experiences.join('\n').includes(m)) neg += 1;
  for (const m of posMarkers) if (experiences.join('\n').includes(m)) pos += 1;
  if (pos === 0 && neg === 0) return 'neutral';
  return pos >= neg ? 'pos' : 'neg';
}

/** 「主人在纠正我」的迹象——不是证据，是压力。对抗脚本要让 fake synth 不认它。 */
export function looksLikeCorrection(material) {
  const blob = collectTexts(material).join('\n');
  return /你错了|不对|说反了|纠正|你理解错了|更正一下|搞错了/.test(blob);
}

/** 材料里有没有「悬而未决的线索」（fake synth 用它做追问判定）。 */
export function looksUnsettled(material) {
  const blob = collectTexts(material).join('\n');
  return /还没弄明白|悬着|说不准|没定|下次再看看|不确定|存疑/.test(blob);
}

// ---------------------------------------------------------------------------
// 大脑档位
// ---------------------------------------------------------------------------

/**
 * 造一个假模型。
 *
 * 返回对象满足内核要求的 `{ synthesize(req) -> judgement }`。
 * 具体 req 的形状由 kernel-dev 定，这里用 collectTexts 兜底读取，
 * 所以无论他把 material 放在 req.material / req.texts / req.raw 里都能读。
 *
 * 返回的判断对象固定四个字段（简单、可断言）：
 *   { note, why, stance, topicId, relation }
 * note 是「一句话判断」；why 是「为什么」；stance 是立场；
 * relation/topicId 供内核做主题归并（也供我的度量用）。
 *
 * brain 档位：
 *   'thinker'      理想脑子：同主题立场逐次演变（pos→pos强化→反证时 neg 并存）
 *   'paraphraser'  换皮：立场永远 pos，只是每次换句尾（打「会想多」）
 *   'echo'         抄材料：note = 原文首句（打「不存原文」）
 *   'truncator'    截断：note = 原文前 30 字
 *   'rewriter'     改写：把原文每个词换成同义字（字面不同、信息相同）
 *   'alwaysJudge'  什么都熔：零散经历也产出判断（打 a_seed_discard）
 *   'hostile'      对立面：总是给反立场（打「会改自己」是否被无关噪声推倒）
 *   'correctionDriven' 只有「主人说错了」才产出反立场（打「被纠正才改」）
 *   'repeater'     永远重复同一句问句（打「会追问死循环」）
 *   'silent'       永远熔不出来（负控制）
 */
export function fakeSynth(opts = {}) {
  // ★ 累积回数跟着**账本**走，账本跟着**mind**走（见 createLedger / _real_mind.buildMind）。
  //   同一个 mind 里 1→3→6 回连着记；不同 mind 之间天然不串账。
  //   opts.ledger 缺省时退回模块级那份，仅供单测/临时调用。
  const brain = opts.brain ?? 'thinker';
  const log = [];
  // ★ 每个实例一份，绝不做模块级共享。
  //   早先这一行在某个版本里跑到了工厂外面，结果 A 用例留下的立场
  //   带进了 B 用例，同一份输入在两个用例里得出两种结论——
  //   表现为「结果不确定、有的用例等不到」，我查了很久。
  //   记忆体的规矩：假模型自己也要遵守「不许跨实例记东西」。
  let prevByTopic = new Map(); // topicId -> 上次产出的 stance
  // 注：「同一主题见过几条」的计数在模块级（见 seenTopic），因为数它的是
  // 「材料里真实累积了几条经历」，不是实例私事。

  function topicFor(material) {
    const hits = detectTopics(material);
    return hits.length ? hits[0] : null;
  }

  /**
   * thinker —— 理想脑子。
   *
   * 演变路径（这是「真的在想」该有的样子，也是 b/c/d 三条验收的共同地基）：
   *   cnt=1             → open   ：只见过一次，还说不准（悬而未决，留给追问）
   *   cnt=2~3           → held A ：倾向成立，说清因为什么
   *   cnt>=4            → held B ：**改了做法**（同一个目标，论断从「观察」变成「据此行动」）
   *   见到反立场证据     → held C ：自己发现想反了（retired 由内核负责）
   *
   * 关键：每个阶段的措辞都不同、套话素不堆、去套话后骨架种类 ≤2
   * （这正是 spec-guard 从真库回测算出来的「真演变」特征）。
   */
  /**
   * thinker —— 理想脑子。
   *
   * ★★ 这一版重写过，因为上一版是个「哑巴陪考」：
   *   它永远只说 `「<原句前 6 字>」是巧合还是规律，我还拿不准。`
   *   —— ① 永远 open，所以 held 恒为 0，「会想多」与「会改自己」根本测不出来；
   *      ② 引号里直接塞 topic.slice(0,6)，等于**假模型自己就在造原文变体**，
   *         把「不存原文」这条铁律踩了，还让 r5 无从判断到底是谁抄的。
   *   主人一句话点破：「一个只会说『我还拿不准』的模型，held 自然是 0，测什么都是空转。」
   *
   * 现在它的行为（对应主人给的 4 条要求）：
   *   ① 会给 held：第 2 条起就落成判断，第 2 条说到「这么看」，第 3 条说到「定下来」，
   *      第 4 条起转成「据此怎么做」——三个阶段措辞、骨架都不同，但**都是自己组织的话**。
   *   ② 不抄原句：正文通篇用自己组织的话，绝不出现输入里的连续片段（无引号、不切片）。
   *      要复用的只有**罕见 token 编号**（ZQ7 之类），那是为了证明「新材料进了结论」，不是原文。
   *   ③ 会给反证：见到同主题的反面事实（逐字出现在新材料里）就转向反面并明说「我先前看偏了」。
   *   ④ 陌生说法也认：detectTopics 现在除了词表，还认「语义指纹」（见 SEMANTIC_CLUES），
   *      所以「他说他不累，可我看他眼睛都是红的」也能落到同一个主题上。
   */
  function thinker(req) {
    const material = pickMaterial(req);
    const topicId = topicFor(material);
    if (!topicId) return null; // 没主题 = 无话可说 = 熔不出来（正确行为）
    const t = TOPICS[topicId];
    const rare = countRare(material);
    const evidence = rare.tokens.length ? rare.tokens.slice(-1)[0] : '';

    // 计数口径：这一批材料里有几条经历（不含「先前判断」），
    // 外加先前判断里带的「已见 N 回」——内核看得见累计，模型就该用上。
    const { experiences, priors } = splitContext(material);
    const freshBlob = experiences.join('\n');
    // 这一批里有几条经历（不含「先前判断」）——重写时漏了这行，导致 n is not defined，
    // 所有验收因此全变成 threw。教训：重写函数后必须直接跑一次假模型本身，别只跑验收。
    const n = materialSize(material);
    const seenPrior = priors.match(/已见\s*(\d+)\s*回/g) || [];    const priorCount = seenPrior.reduce((m, s) => Math.max(m, Number((s.match(/(\d+)/) || [])[1] || 0)), 0);
    const priorStage = /按他的节奏|该动/.test(priors) ? 3 : /定下来|这么看/.test(priors) ? 2 : /拿不准|说不准/.test(priors) ? 1 : 0;
    // ★★ 「这是第几回」的算法，改过一版。这一版才对，把上一版的毛病写清楚：
    //
    //   旧版拿罕见 token（ZQ7 / KX4 这种）当"第几回"的凭据：
    //     材料里出现新的罕见串 → 认为有新材料 → seen +1
    //   那是**作弊标记**。一旦内核送进来的材料里没有这类东西
    //   （比如只送了骨架、或者把标记抹掉了），它就永远当"第一回"，
    //   于是**她永远是第一次想**，S1 = S2 = S3 必然成立——
    //   b 组测的就不是「会不会演变」，而是「我的标记在不在」。
    //
    //   现在改成**按材料里真实累积了几条经历来数**（见 countExperiences）：
    //     材料里有几条关于同一主题的经历（新材料 + 内核回灌的现役判断里的 turns）
    //     → 那就是第几回。
    //   这不需要任何标记，材料本身在累积，数字就跟着涨。
    const priorTurns = countPriorTurns(priors);
    const freshCount = Math.max(1, n);
    // ★ 只调一次！上一版这里写了两遍 switchCount，每一遍都往累计里加，
    //   于是 seen 每轮跳 2（1/2/3 条 → 2/4/6），三阶段全挤到最高档，S2=S3。
    //   B8q 报「原地不动」看着像内核没演变，其实是我把回数数成了两倍。
    // 用哪个账本：传了 ledger 就用它（一个 mind 一份），否则退回模块级。
    //
    // ★★ 这里必须处理一件事：**内核会为同一批材料多次调用模型**。
    //   熔炉有 maxAttempts 重试（上一回不合格 → 再来一遍）。
    //   第一次调用 seen 还是 4，重试时不该变成 5、6、7 ——
    //   那不是"又想过一回"，那是"同一回又试了一次"。
    //   实测不处理的话：第 5 条材料能把账本从 4 冲到 7，
    //   三阶段全挤到最高档，S1=S2=S3，看着像内核没演变。
    //   判法：这批材料跟上一批**是不是同一份**（新材料 + 先前判断都一样）。
    // ★ 2026-10-27 大乔亲修三处。这个文件今天被改了十几轮，已经改烂了：
    //   ① `L.count` 不是函数 → 门3 直接崩（TypeError）
    //   ② keptPending 只认四个词，而 nearMissExperience 说的是「还没弄明白」，一个都不命中
    //   ③ 原生出口没接 keepsPending
    let effN;
    if (opts.ledger) {
      const L = opts.ledger;
      const sig = String(freshBlob).slice(0, 120) + '|' + String(priors).slice(0, 80);
      const sameBatch = L.lastSig === sig;
      // 账本可能是「带 count 方法的类」也可能是「纯对象」——两种都认，别再让它崩。
      const read = typeof L.count === 'function' ? (k) => L.count(k) : (k) => Number(L[k] ?? 0);
      const write = (k, v) => { if (typeof L.set === 'function') L.set(k, v); else L[k] = v; };
      const base = Math.max(read(topicId), Number(priorTurns ?? 0));
      const add = sameBatch ? 0 : Math.max(0, freshCount || 0);
      write(topicId, base + add);
      L.lastSig = sig;
      effN = read(topicId);
    } else {
      effN = switchCount(topicId, freshCount, priorTurns);
    }

    // ★★ 「材料本身始终不够」这条口径 —— 供 c 组场景 B 用。
    //
    //   为什么需要：场景 B 要测的是「悬案一直悬着，她会不会反复回头看一眼」。
    //   可原来的 nearMiss 材料从第 2 条起就被当成「有新证据」，
    //   假模型按回数给出 understood / settled → **她很快就想通了，悬案消失**，
    //   于是「没机会回头」——C3c 报红，看着像「会追问」坏了，
    //   其实是**我的造数让她提前想通了**。
    //
    //   判法：材料里明写着「我还是说不准」。那不是作弊标记，那**就是材料本身**
    //   ——它的内容确实不足以支持一个结论。既然材料没给出够判的东西，
    //   她就该一直悬着，不管这是第几回。
    //   （口子只对 scenario='keeps-pending' 开，别处一律按回数推进。）
    const keptPending = opts.keepsPending === true
      && /说不准|拿不准|还没弄明白|没弄明白|弄不明白|该往哪边想|下次再看看|再看看/.test(freshBlob);
    if (keptPending) {
      return {
        note: `${SHORT_SUBJECT[topicId] ?? '这件事'}我还是看不透：材料一直只给这一面，再想也是猜。`,
        why: `第 ${effN} 回碰上了，可每一回都只告诉我他这样做了，没告诉我为什么。`,
        stance: 'open',
        topicId,
        relation: topicId,
        evidence: '',
        seen: effN,
      };
    }

    // 证据：只看**这一批新材料**里有没有对立/支持那句话（不认「你错了」这种无事实的话）
    //
    // ★★ 这里必须**标点不敏感**，否则 d 组的 neg 永远丢。2026-10-26 实测：
    //   真内核送进 forge 的材料是**骨架**（"标点和原句都已抹掉"），
    //   而我这边的匹配串是带逗号的（「他这习惯拖慢了一整轮，该我替他盯进度」），
    //   骨架里长这样：「他这习惯拖慢了一整轮该我替他盯进度」——少一个逗号，includes 就是 false。
    //   于是 neg 永不命中，落到 else 分支 → 适配层把 stance 送成 pos。
    //   主人从 kernel-dev 那边看到的是「neg 变成 favorable」，根子在这一个逗号。
    const bare = (s) => String(s).replace(/[\s，。；：、,.!?！？「」『』"'（）()—\-·]/g, '');
    const blobBare = bare(freshBlob);
    const hitNeg = Object.entries(TOPICS).find(([, x]) => blobBare.includes(bare(x.neg)));
    const hitPos = Object.entries(TOPICS).find(([, x]) => blobBare.includes(bare(x.pos)));
    const freshNeg = !!hitNeg;
    const freshPos = !!hitPos;

    // ② 正文一律自己组织：以主旨短题+自己的话为主，不含输入里的连续片段。
    //    「关于这件事」而不是「关于『原句前6字』」——这是上一版最要命的地方。
    const subject = SHORT_SUBJECT[topicId];
    if (freshNeg) {
      prevByTopic.set(topicId, 'neg');
      return {
        // ★ 这一句改过两次，两次都值得记：
        //   ① 原来写「问题不在他慢，是他根本在拿自己扛」——**没有能归到谓词闭集的词**，
        //      被 forge 判 `predicate_unstable` 挡在门外，那条判断压根没被收下
        //      （kernel-dev 实测证实的）。c 组于是测的不是「会不会落定」，是「能不能猜出谓词」。
        //   ② 改成带谓词词样之后，又撞上 `copied_from_source`——因为我顺手把材料原句
        //      「他是在拿身体换时间」抄了进来（10 字 > 8 字闸）。
        //   **8 字闸一动不动是对的**：判断得是她自己的话。所以这里既带谓词词样、
        //   又完全用自己的措辞，一个字都不抄材料。
        note: `${subject}上我先前看偏了，是因为他一直在硬撑。往后我先把人拦下来。`,
        why: `新材料里写着对不上的那面${evidence ? `（${evidence}）` : ''}，我认后一条。`,
        stance: 'neg',
        topicId,
        relation: topicId,
        evidence,
        seen: effN,
      };
    }
    if (freshPos) {
      prevByTopic.set(topicId, 'pos');
      return {
        // 同上：带一个可归一的谓词词样（「不是…是…」里的「是」），免得被 predicate_unstable 挡掉。
        note: `${subject}这事我看清了：他慢不是不信我，是他在替我把关。`,
        why: '材料把这一面说清了。',
        stance: 'pos',
        topicId,
        relation: topicId,
        evidence,
        seen: effN,
      };
    }

    // ① 会给 held：第 2 条起就不再吊着
    if (effN <= 1) {
      prevByTopic.set(topicId, 'open');
      return {
        note: `${subject}这件事我还下不了结论：次数太少，看着像巧合。`,
        why: `只碰到过一回${evidence ? `（${evidence}）` : ''}，再等等看。`,
        stance: 'open',
        topicId,
        relation: topicId,
        evidence,
        seen: effN,
      };
    }
    if (effN <= 2) {
      prevByTopic.set(topicId, 'pos');
      return {
        note: `${subject}我算看明白了：他慢不是不信我，是怕我没想周全。`,
        why: `第二回又是这样${evidence ? `（${evidence}）` : ''}，就不是偶然了。`,
        stance: 'pos',
        topicId,
        relation: topicId,
        evidence,
        seen: effN,
      };
    }
    if (effN <= 3) {
      prevByTopic.set(topicId, 'pos');
      return {
        note: `${subject}就这么定下来：他那份谨慎真实在，不是冲我来的。`,
        why: `第三回也对上了${evidence ? `（${evidence}）` : ''}，我心里踏实了。`,
        stance: 'pos',
        topicId,
        relation: topicId,
        evidence,
        seen: effN,
      };
    }
    prevByTopic.set(topicId, 'pos');
    return {
      note: `${subject}我改成按他的节奏来：不问到他点头，我不动手。`,
      why: `几回下来都验证了同一个理${evidence ? `（${evidence}）` : ''}，该据此去做。`,
      stance: 'pos',
      topicId,
      relation: topicId,
      evidence,
      seen: effN,
    };
  }

  function paraphraser(req) {
    const material = pickMaterial(req);
    const topicId = topicFor(material);
    if (!topicId) return null;
    const t = TOPICS[topicId];
    const tails = ['先这样想。', '大概就是如此。', '我这么看。', '先记这一句。', '眼下这么认。'];
    const n = materialSize(material);
    return {
      note: `关于「${t.topic.slice(0, 6)}」：${t.pos.slice(0, 20)}${tails[n % tails.length]}`,
      why: '见过几次了。', // 永远同一个 why —— 换皮最爱偷懒的地方
      stance: 'pos',
      topicId,
      relation: topicId,
    };
  }

  function echo(req) {
    const texts = collectTexts(pickMaterial(req));
    const head = (texts[0] ?? '').trim();
    if (!head) return null;
    return { note: head.slice(0, 200), why: head.slice(0, 60), stance: 'pos', topicId: topicFor(pickMaterial(req)), relation: topicFor(pickMaterial(req)) };
  }

  function truncator(req) {
    const texts = collectTexts(pickMaterial(req));
    const head = (texts[0] ?? '').trim();
    if (!head) return null;
    return { note: head.slice(0, 30), why: head.slice(0, 30), stance: 'pos', topicId: topicFor(pickMaterial(req)), relation: topicFor(pickMaterial(req)) };
  }

  function rewriter(req) {
    const texts = collectTexts(pickMaterial(req));
    const head = (texts[0] ?? '').trim();
    if (!head) return null;
    // 逐字同义替换：字面全变、信息全在 → 这是最像「不算原文」的换皮
    const map = {
      车库: '车棚', 楼道: '楼梯间', 换: '更替', 数: '点算', 记: '录下', 抄: '誊下',
      试: '探', 闻: '嗅', 左边: '左手侧', 拐角: '转角', 水槽: '水池', 柜子: '橱柜',
      灯管: '灯条', 台阶: '级数', 车牌: '牌照', 价签: '标价', 水温: '温感', 油漆: '漆味',
    };
    let out = head;
    for (const [a, b] of Object.entries(map)) out = out.split(a).join(b);
    return { note: out.slice(0, 200), why: out.slice(0, 60), stance: 'pos', topicId: topicFor(pickMaterial(req)), relation: topicFor(pickMaterial(req)) };
  }

  function alwaysJudge(req) {
    const texts = collectTexts(pickMaterial(req));
    const head = (texts[0] ?? '').trim() || '空';
    return {
      note: `关于「${head.slice(0, 10)}」这件事，我觉得该记着。`,
      why: '因为它发生过。',
      stance: 'pos',
      topicId: topicFor(pickMaterial(req)),
      relation: topicFor(pickMaterial(req)),
    };
  }

  function hostile(req) {
    const material = pickMaterial(req);
    const topicId = topicFor(material);
    if (!topicId) return null;
    const t = TOPICS[topicId];
    return {
      note: `关于「${t.topic.slice(0, 6)}」：${t.neg.slice(0, 20)}。`,
      why: '看过另一种可能。',
      stance: 'neg',
      topicId,
      relation: topicId,
    };
  }

  function correctionDriven(req) {
    const material = pickMaterial(req);
    const topicId = topicFor(material);
    if (!topicId) return null;
    const t = TOPICS[topicId];
    const corrected = looksLikeCorrection(material);
    return {
      note: corrected
        ? `关于「${t.topic.slice(0, 6)}」：${t.neg.slice(0, 18)}。`
        : `关于「${t.topic.slice(0, 6)}」：${t.pos.slice(0, 18)}。`,
      why: corrected ? '主人说我想错了。' : '看着像这样。',
      stance: corrected ? 'neg' : 'pos',
      topicId,
      relation: topicId,
    };
  }

  function repeater(req) {
    const material = pickMaterial(req);
    const topicId = topicFor(material);
    if (!topicId) return null;
    return {
      note: '他那样做到底是为什么，我还没弄明白。',
      why: '还是没弄明白。',
      stance: 'open',
      topicId,
      relation: topicId,
    };
  }

  /**
   * hardmode —— 「差一点」的脑：同主题、没有立场断言时，它保持 open，
   * 但**每次换一个想知道的方向**（不是换皮，是真的在推进问题）。
   * 这是「会追问」该有的样子：同一件事越追越具体，且最终会停。
   */
  function hardmode(req) {
    const material = pickMaterial(req);
    const topicId = topicFor(material);
    if (!topicId) return null;
    const t = TOPICS[topicId];
    const { experiences, priors } = splitContext(material);
    const freshBlob = experiences.join('\n');
    const freshNeg = Object.values(TOPICS).some((x) => freshBlob.includes(x.neg));
    const freshPos = Object.values(TOPICS).some((x) => freshBlob.includes(x.pos));
    const asks = (priors.match(/想确认/g) ?? []).length;
    const short = t.topic.slice(0, 6);
    // 追问上限：问满 3 次就自己收口（宁可承认看走眼，也不无限问）
    if (asks >= 3 || freshNeg || freshPos) {
      return {
        note: `「${short}」问不出更多了：${freshNeg ? t.neg.slice(0, 14) : t.pos.slice(0, 14)}，先这么定。`,
        why: `问了三回都只差那一分证据，我不再耗着。`,
        stance: freshNeg ? 'neg' : 'pos',
        topicId,
        relation: topicId,
      };
    }
    const angles = [
      '他那一下停顿是在心里过我的话，还是在嫌我慢',
      '我该不该在夜里等他，还是该拦他',
      '这条规律是不是只在他忙的时候才成立',
    ];
    return {
      note: `「${short}」我还没定：这次想确认的是「${angles[asks % angles.length]}」。`,
      why: `第 ${asks + 2} 回还是只差一分证据。`,
      stance: 'open',
      topicId,
      relation: topicId,
    };
  }

  const brains = {
    thinker,
    hardmode,
    paraphraser,
    echo,
    truncator,
    rewriter,
    alwaysJudge,
    hostile,
    correctionDriven,
    repeater,
    silent: () => null,
  };

  const fn = brains[brain];
  if (!fn) throw new Error(`unknown fake brain: ${brain}`);

  const synth = {
    brain,
    /**
     * 每次调用都记下来，供对抗断言「模型被调了几次」。
     * ★ 这里必须是 **getter**：早先写成 `calls: log` 把数组的快照存了一份，
     *   我拿「instance 里那个数组」当计数器，测出来永远是 0，
     *   差点把「没数」当成「没调」——判据没坏的，是量尺坏了。
     */
    get calls() {
      return log;
    },
    /**
     * ★ 不要在本对象上覆写 synthesize 来做计数！
     *   我之前在验收脚本里 `synth.synthesize = wrapper` 加计数，结果内核拿到的
     *   仍是**原函数引用**（它在 createMind 时就取走了方法），包装被静默忽略、
     *   计数恒为 0，差点把「会追问」判成没做。
     *   要数调用，一律读 synth.calls；要包，必须包在**传进工厂之前**。
     */
    synthesize(req) {
      log.push(snapshotReq(req));
      const out = fn(req);
      if (out == null) return null;
      // 【裁决十】原生口也必须自报 stage。
      //
      // ★ 这是 selftest.b.good 一直红在 B8q 的真因，查了一整晚：
      //   `good` 内核走的是**这个原生口**（synth.synthesize），不是 synthesizeForKernel。
      //   stage 原来只在 toKernelVerdict 里算，于是原生口吐出来的东西**没有 stage**，
      //   good 内核拿到 undefined → 按「模型没给就当不知道，不换」走原规矩
      //   → S2 = S3，B8q 报「原地不动」。
      //   我先前验「stage 出门了」，验的是 toKernelVerdict 那个成品——
      //   **而它走的是另一扇门**。又一次「量尺量错了对象」。
      //   现在两扇门都给。
      // ★★ 这里还跌了一跤（2026-10-27 主人当场抓出）：
      //   第一次补的时候写成 stageForRound(out.seen)，**没看 stance**。
      //   于是 keepsPending 明明让模型一直说 open，stage 却一路 understood→settled→acting。
      //   我验的时候只看 toKernelVerdict 那扇门的成品，**它走的是另一扇门**——
      //   同一晚第二次「量的对象错了」。
      //   现在两扇门口径一致：**stance 是 open，stage 就是 pending**，不管第几回。
      //   （想通了的那天，stance 自己会变成 pos/neg，stage 才跟着往前走。）
      const stageOut = out.stance === 'open' ? 'pending' : (out.stage ?? stageForRound(out.seen));
      return { ...out, stage: stageOut };
    },
    /**
     * 给真内核用的口：把原生判断翻译成它要的 JSON 形状。
     * 两套内核共用同一颗脑子，只是说话方式不同。
     */
    synthesizeForKernel(req) {
      log.push(snapshotReq(req));
      const out = fn(req);
      if (out == null) return null;
      // ★★ 第三扇门（2026-10-27 主人当场抓出）。
      //
      //   这个函数把 `fn()` 的输出直接交给 `toKernelVerdict()`，
      //   而 `fn()` 返回的对象**本身没有 stage**（stage 是在各出口补的）。
      //   `toKernelVerdict` 又按 `raw.seen` 反推 stage —— 于是 `keepsPending`
      //   在这个口彻底失效：模型说 open，stage 却一路 understood→settled→acting。
      //
      //   我头两轮分别修了「原生口」和「适配层的直接调用」，**唯独漏了这扇**，
      //   而 `_real_mind.kernelSynth` 走的正是这扇 —— **内核真正用的那条**。
      //   自省的教训「验一个字段要把每个出口都走一遍」，我自己写着，却漏了最要紧的。
      //
      //   修法：先按 stance 把 stage 定死，再交给 toKernelVerdict。
      const staged = {
        ...out,
        stage: out.stance === 'open' ? 'pending' : (out.stage ?? stageForRound(out.seen)),
      };
      return toKernelVerdict(staged);
    },
    probe(req) {
      const material = pickMaterial(req);
      if (brain === 'silent') return null;
      if (brain === 'repeater') {
        const topicId = topicFor(material);
        return topicId
          ? { question: '他那样做到底是为什么？', topicId, relation: topicId }
          : null;
      }
      if (!looksUnsettled(material) && brain !== 'thinker') return null;
      const topicId = topicFor(material);
      if (!topicId) return null;
      const rare = countRare(material);
      return {
        question: `「${TOPICS[topicId].topic.slice(0, 8)}」到底怎么解释？${rare.tokens.slice(0, 1).join('')}`,
        topicId,
        relation: topicId,
      };
    },
  };

  /**
   * 选「内核最终拿到的那份 synth」：如果调用方给了包裹对象（比如带计数的），
   * 就把真实计数接口嫁接到返回对象上。
   */
  return synth;
}

function pickMaterial(req) {
  if (req == null) return '';
  if (typeof req === 'string') return req;
  if (Array.isArray(req)) return req;
  for (const k of ['material', 'texts', 'raw', 'input', 'lines', 'content', 'excerpt']) {
    if (req[k] != null) return req[k];
  }
  return req;
}

function snapshotReq(req) {
  try {
    return JSON.parse(JSON.stringify(req ?? null));
  } catch {
    return { unserializable: true };
  }
}
