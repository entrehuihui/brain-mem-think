/**
 * _deadline.mjs —— 给「一次验收算到底」加个硬上限。
 *
 * ======================= 它凭什么在这儿 =======================
 *
 * 主人实跑过一版验收脚本：60 秒没完，120 秒还在转，一个字都没吐。
 * 对红队来说这比红还坏——红了有人会去看，挂死了就没人敢跑。
 *
 * 坑在哪（记下来，别再踩）：
 *   我在 _selftest_all.mjs 里把「自检脚本自己」也当成了被检对象，
 *   它 import 自己、再 import 自己……模块图成环，进程永远连不上退出。
 *   与此同时 _fake_synth / _fake_kernels 里点下的 setTimeout 和循环
 *   也在同一轮里堆着，于是看起来像「异步没 await」。
 *
 * 这里是最后一道闸：任何一个 async 阶段超过 ms 就抛，调用方转成 FAIL。
 * 和 _harness 的 watchdog 一起用：watchdog 管「整个脚本」，这里管「单段」。
 */
export class Deadline extends Error {
  constructor(ms) {
    super(`超过 ${ms}ms 没算完`);
    this.name = 'Deadline';
    this.ms = ms;
  }
}

export function withDeadline(promise, ms, label = 'stage') {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Deadline(`${label} 超过 ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}
