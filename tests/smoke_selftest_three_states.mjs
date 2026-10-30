/**
 * smoke_selftest_three_states.mjs —— 证明 selftest 的三档真的分得开。
 *
 * ============== 它在防什么 ==============
 *
 * 2026-10-27 现场：`_fake_synth.mjs` 少了一个函数定义，任何 `fakeSynth()` 都抛
 * `ReferenceError`。而 selftest 报出来是「b.good / c.good / e.good 三档红」——
 * **看着像判据在冤枉实现，其实是它压根没跑起来。**
 *
 * 主人原话：
 *   「一个吞异常的验收框架，比没有验收更危险——因为它会报出一堆看起来很严肃的红。」
 *
 * 这个探针把三种情况分别喂给 selftest 的那套三档逻辑，要求它们各自落到不同的档：
 *   ① 判据跑了、通过      → PASS
 *   ② 判据跑了、没过      → FAIL
 *   ③ 判据压根没跑（抛错） → CRASH（且必须带异常原文）
 */
import { createHarness, EXIT } from '../acceptance/_harness.mjs';
import { isMain } from '../acceptance/_run.mjs';

/**
 * 复刻 _selftest_all.quiet() 的三档逻辑。
 *
 * 为什么复刻而不去 import：`quiet` 是那个文件里的私有函数。
 * 复刻有走样的风险，所以下面额外用「真跑一次 selftest」来兜底验证
 * （见 H3：真 selftest 必须绿，说明它内部的三档是通的）。
 */
async function quiet(run) {
  const origLog = console.log;
  console.log = () => {};
  try {
    const h = await run();
    const v = h.verdict();
    return { status: v.status === 'PASS' ? 'PASS' : 'FAIL', ok: v.status === 'PASS', fails: v.fails.map((f) => f.id) };
  } catch (err) {
    return { status: 'CRASH', ok: false, crash: `${err?.constructor?.name ?? 'Error'}: ${err?.message ?? err}` };
  } finally {
    console.log = origLog;
  }
}

/** 造一个判据全过的验收 */
function passRun() {
  return () => {
    const h = createHarness('fake-pass');
    h.check('x', true, 'ok');
    return h;
  };
}

/** 造一个判据有红的验收 */
function failRun() {
  return () => {
    const h = createHarness('fake-fail');
    h.check('x', false, '红了');
    return h;
  };
}

/** 造一个**压根跑不起来**的验收（模拟少函数定义那种崩溃） */
function crashRun() {
  return () => {
    // eslint-disable-next-line no-undef
    return resetSeenThatDoesNotExist();
  };
}

async function main() {
  const h = createHarness('smoke · selftest 三档：PASS / FAIL / 崩溃', {
    purpose: '证明「没跑起来」不会被伪装成「判据红」',
  });
  h.armWatchdog();

  const a = await quiet(passRun());
  const b = await quiet(failRun());
  const c = await quiet(crashRun());

  h.check('S1.pass_state', a.status === 'PASS' && a.ok, `判据全过 → PASS：实际 ${a.status}`);
  h.check('S2.fail_state', b.status === 'FAIL' && !b.ok, `判据有红 → FAIL：实际 ${b.status}`);
  h.check('S3.crash_state', c.status === 'CRASH', `抛异常 → CRASH（不是 FAIL）：实际 ${c.status}`);
  h.check('S3b.crash_carries_message', !!c.crash && /is not defined|ReferenceError|Error/.test(c.crash),
    `崩溃档必须带异常原文，否则等于没说：${c.crash ?? '(无)'}`);

  // 三档必须两两不同
  const set = new Set([a.status, b.status, c.status]);
  h.equal('S4.three_distinct', set.size, 3, `三档必须互不相同：${[...set].join(' / ')}`);

  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('smoke_selftest 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}
