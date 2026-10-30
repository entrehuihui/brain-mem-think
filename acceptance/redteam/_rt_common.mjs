/**
 * redteam/_rt_common.mjs —— 红队对抗脚本的公共骨架。
 *
 * ======================= 它凭什么在这儿 =======================
 *
 * 「假绿」最要命的形态是：验收脚本看起来绿了，其实它压根没在测。
 * 对抗脚本的任务就是**故意制造假绿场景**，然后要求验收判据必须报红。
 *
 * 每个对抗脚本的结构都固定两步：
 *   ① 用「已知坏的实现」跑对应验收 → 判据必须红（否则说明书是假的）
 *   ② 用「真 src 实现」跑同一验收 → 报出真结论
 * 任何一步不合预期都让本脚本红。
 *
 * 只做①也不够：②是为了让对抗脚本不是「孤立玩具」——
 * 它对真实现给出的是同一套判据下的真实结论。
 */

import { createHarness, EXIT } from '../_harness.mjs';
import { isMain } from '../_run.mjs';
import { withDeadline } from '../_deadline.mjs';

export const BUDGET_MS = 45_000;

/** 静默跑一个验收（不打印中间过程），只取结论。 */
export async function silent(run) {
  const orig = console.log;
  console.log = () => {};
  try {
    const h = await withDeadline(Promise.resolve().then(run), BUDGET_MS, 'adversarial-run');
    const v = h.verdict();
    return { status: v.status, fails: v.fails.map((f) => ({ id: f.id, detail: f.detail })), checks: h.raw() };
  } catch (err) {
    return { status: 'THREW', fails: [{ id: 'threw', detail: String(err?.message ?? err) }], checks: [] };
  } finally {
    console.log = orig;
  }
}

/**
 * 对抗裁决器。
 *
 * fakeImpls: [{ label, describe, impl, expectRed }]
 *   - impl 为函数时：直接作为「假内核工厂」喂给验收
 *   - impl 为 null 时：用 _fake_kernels 里 label 同名的已知坏实现
 *   - expectRed：这个假样子**必须**命中的判据 id（每条假样子命中自己的那把刀）
 *
 * ★ 别把「命中某一条特定判据」当成充分条件。
 *   我第一版要求所有换皮都必须红在 B1（字面相似度）上，
 *   结果「套话式换皮」明明被抓到了（B2/B4 红），却因为没红在 B1 被判失败——
 *   判据在干活，我的裁决器在误伤。换皮有四种，刀也该有四把。
 */
export async function adjudicate(h, { accept, fakeImpls }) {
  const { runAgainst } = await import(accept);
  const { makeFakeKernel } = await import('../_fake_kernels.mjs');

  // ① 假实现必须红，且命中它该命的刀
  for (const item of fakeImpls) {
    if (!item.impl) {
      // 已知坏实现由 _fake_kernels 提供；直接点名
    }
    const factory = item.impl
      ? (synth, opts) => item.impl(synth, opts)
      : (synth, opts) => makeFakeKernel(item.label, synth, opts);
    const res = await silent(() => runAgainst(async (synth, opts) => factory(synth, opts)));
    const caught = res.fails.map((f) => f.id);
    const wasRed = res.status === 'FAIL' || res.status === 'THREW';
    h.check(
      `adversarial.${item.label}.must_be_caught`,
      wasRed,
      `${item.describe} → 验收判它「${res.status}」；必须红${wasRed ? '' : '（判据被这个假样子骗过去了！）'}`,
    );
    const expect = item.expectRed ?? [];
    if (expect.length) {
      const missed = expect.filter((id) => !caught.includes(id));
      h.check(
        `adversarial.${item.label}.caught_by_the_right_blade`,
        missed.length === 0,
        `该命中的判据：${expect.join(',')}；漏了 ${missed.join(',') || '无'}（实际红在：${caught.slice(0, 8).join(',') || '无'}）`,
      );
    }
  }

  // ② 真实现：如实报
  //    ★ 加载失败要能说出来**是哪个 import 挂的**，而不是只给一句 LOAD_ERROR。
  //      内核在被人改的时候（flash/forge 频繁动），这一条决定了我能不能分清
  //      「实现真错」和「脚手架自己崩」。
  let real = null;
  let loadError = null;
  try {
    // ★ 路径基准要写死成「相对本文件」，不是相对 cwd：
    //   `acceptance/redteam/` 往上两层才是项目根。早先这里写成 ../src/mind.mjs，
    //   从 redteam 目录算过去会变成 acceptance/src/mind.mjs（多了一层），
    //   于是所有对抗脚本一律 LOAD_ERROR，看着像「真实现对判据加载不上」。
    const mod = await withDeadline(import('../../src/mind.mjs'), 15_000, 'load-src');
    const createMind = mod.createMind ?? mod.default;
    if (typeof createMind !== 'function') {
      loadError = '../../src/mind.mjs 没有导出 createMind / default';
    } else {
      const { buildMind } = await import('../_real_mind.mjs');
      // 走和验收同一层适配：假模型的话要翻译成真内核要的 JSON 形状
      real = await silent(() => runAgainst(async (_synth, opts) => buildMind(mod, { ...opts, brain: 'thinker' })));
    }
  } catch (err) {
    loadError = `加载 src 失败：${err?.constructor?.name ?? 'Error'}: ${err?.message ?? err}`;
    if (err?.stack) loadError += ` | ${String(err.stack).split('\n').slice(0, 3).join(' ← ')}`;
  }
  if (!real) {
    h.check('adversarial.real_src_reachable', false, loadError ?? '真实现不可用');
    return { real: null, loadError };
  }
  h.check('adversarial.real_src_reachable', true,
    `真实现对判据的裁决：${real.status}${real.fails.length ? '（红：' + real.fails.slice(0, 6).map((f) => f.id).join(',') + '）' : ''}`);
  return { real, loadError: null };
}

export function finish(h) {
  // 裁决已经打出来了。真实现还留着别人的句柄也不许拖住进程——
  // 「跑完了但永远不返回」比红更坏（红有人查，挂死没人敢跑）。
  h.exit();
  h.forceExit();
}

export { createHarness, EXIT, isMain };
