/**
 * _real_mind.mjs —— 把真 src 的接口，接到验收脚本期望的接口上。
 *
 * ======================= 它凭什么在这儿 =======================
 *
 * 验收脚本是照着**合同**写的（ingest/snapshot/recall）。
 * 真 src 落地后，它的入口是 `Mind` 类，`ingest` 是**同步返回值里带着 async 结果**的
 * `async ingest`，而 snapshot / pendingQuestions / recall 挂在实例上。
 * 两边形状对得上九成，剩下的差是：
 *
 *   1. 真内核只认 `synth.synthesize(str) -> {text, relation, subject, polarity, weight}`，
 *      回 `{note}` 会被当作「熔不出」整条丢。所以这里注入的假模型必须先翻译一遍。
 *   2. 真内核要「攒够 igniteAt 条才点火」——一次 ingest 不一定产出判断。
 *      验收脚本发几条同一主题的经历本来就会触发点火，所以不用改喂法。
 *
 * 这两件都是**接线**，判据一个字没动。这一层存在的意义就是让「接线」和「判据」
 * 物理上分开：以后谁改了接口，只动这里，不动验收。
 */

import { fakeSynth, createLedger } from './_fake_synth.mjs';

/**
 * 判断合成器：包装假模型，只把返回值翻成真内核要的形状。
 *
 * ★ 第二个参数 ledger：**一个 mind 一份账本**。
 *   这是 2026-10-27 定下的隔离单位，踩了两轮才定对：
 *     · 模块级共享 → 同进程跑两个用例就串账
 *     · 用例入口 reset → b 组每阶段新建 mind 一建就清，三阶段各自从 1 数 → B8q 假红
 *   现在：buildMind() 每次造 mind 时新建一份 ledger 传进来，
 *   同 mind 内连着记、不同 mind 之间零共享。
 */
export function kernelSynth(brain = 'thinker', ledger = null, extra = {}) {
  const inner = fakeSynth({ brain, ledger: ledger ?? createLedger(), ...extra });
  return {
    brain,
    get calls() {
      return inner.calls;
    },
    synthesize(material) {
      // 注意：这里必须走 synthesizeForKernel，否则真内核会因为 shape 不对全部丢弃
      return inner.synthesizeForKernel(material);
    },
    /** 原生口也留着：有的验收路径想知道「没翻译的原始判断」 */
    raw(req) {
      return inner.synthesize(req);
    },
    probe(req) {
      return inner.probe(req);
    },
  };
}

/**
 * 造一个「和验收脚本合同一致」的 mind。
 * @param {object} mod  src/mind.mjs 的命名空间
 */
export async function buildMind(mod, { brain = 'thinker', limits = {}, now, rand, keepsPending = false } = {}) {
  const createMind = mod.createMind ?? mod.default;
  if (typeof createMind !== 'function') throw new Error('src/mind.mjs 没导出 createMind');
  // ★ 每次造 mind 都开一份新账本：这个 mind 的「想过几回」只属于它自己。
  // ★ keepsPending 必须一路透传 —— 这是「第四扇门」（2026-10-27）：
  //   我修了 thinker 的三个出口，却忘了这个包装层**根本没把它传进去**，
  //   于是 buildMind({ keepsPending: true }) 传到这里就消失了。
  //   教训照旧：验一个开关，要从「调用方传参」一直验到「最底层收到」。
  const synth = kernelSynth(brain, createLedger(), { keepsPending });
  // 真内核的时钟要可控：不给 now() 它会用 Date.now()，同一份输入两次跑会得到不同热度判定。
  let t = 1_700_000_000_000;
  const clock = typeof now === 'function' ? now : () => (t += 1000);
  const m = await createMind({
    synth,
    now: clock,
    rand: typeof rand === 'function' ? rand : makeRand(),
    limits,
  });
  // 把 synth 挂回去，验收脚本要数「模型被调了几次」
  m.__synth = synth;
  // 记录「实现抛了几次」：只在报告里展示，判据仍然看它有没有做到该做的事。
  m.__errors = [];
  const wrapped = guardMind(m);
  wrapped.onError = (name, err) => {
    const msg = `${name}: ${err?.constructor?.name ?? 'Error'}: ${err?.message ?? err}`;
    if (m.__errors.length < 5) m.__errors.push(msg);
    m.__lastError = msg;
  };
  wrapped.__synth = synth;
  wrapped.__errors = m.__errors;
  return wrapped;
}

/** 确定性随机源：同一个种子永远同一串。真内核留了 opts.rand 的注入口，就按它的规矩来。 */
export function makeRand(seed = 42) {
  let x = seed >>> 0;
  return () => {
    // xorshift32：够用且完全确定
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x1_0000_0000;
  };
}

/** 统一入口：加载真模块并造 mind。加载不了就抛出，调用方据 SKIP 处理。 */
export async function openRealMind(opts = {}) {
  const mod = await import('../src/mind.mjs');
  return buildMind(mod, opts);
}

/**
 * 把真实现的所有对外方法都包一层「异常 → 明确错误值」。
 *
 * 为什么必须包：内核正在被改的时候，`render()` 里一个拼错的函数名
 * （比如 `longestSharedRun is not defined`）会让 `ingest` 抛出。
 * 抛出本身没问题，问题是：
 *   · 验收脚本在 for 循环里 await ingest，一个异常就把整份报告打断，
 *     屏幕上一个字都没有 —— 外面看到的是「挂死」；
 *   · 崩掉的调用还可能留下内部状态，后面的断言全在废墟上跑。
 *
 * 所以这里把所有异常都收成一个**能被判据读到的失败值**：
 * 调用方看到 verdict='__threw__'，照样能数、能报红，并且报告里一定会有
 * 「实现在这条输入上抛了」的证据行。**这不放宽任何判据**：
 * 抛异常的调用一律按「没有做到」处理（stored=false / notes 不变）。
 */
export function guardMind(mind) {
  const guarded = Object.create(mind);
  const wrap = (name, fallback) => {
    const fn = mind[name];
    if (typeof fn !== 'function') return;
    guarded[name] = async (...args) => {
      try {
        return await fn.apply(mind, args);
      } catch (err) {
        if (typeof guarded.onError === 'function') guarded.onError(name, err);
        return typeof fallback === 'function' ? fallback(err, ...args) : fallback;
      }
    };
  };
  wrap('ingest', (err) => ({ stored: false, verdict: '__threw__', reason: String(err?.message ?? err), judgment: null, triggered: [], because: [], dropped: [] }));
  wrap('consider', (err) => ({ stored: false, kept: false, verdict: '__threw__', reason: String(err?.message ?? err), judgment: null }));
  wrap('snapshot', () => ({ notes: [], __error: 'snapshot threw' }));
  wrap('recall', () => []);
  wrap('pendingQuestions', () => []);
  wrap('digest', () => ({ __error: 'digest threw' }));
  return guarded;
}
