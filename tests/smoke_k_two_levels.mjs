/**
 * smoke_k_two_levels.mjs —— 证明 k 的两档红真的分得开。
 *
 * ============== 为什么必须证 ==============
 *
 * 主人点名要求：「缺接口」和「时序错」不许混成一个红。
 * 但"分得开"不能靠我嘴上说，得拿两个假 adapter 分别喂进去：
 *
 *   假 adapter A：装了闸，但**顺序反了**（先 assemble 再装闸）→ 必须红在 K1（档二·时序错）
 *   假 adapter B：闸装对了、三条路径都干净 → 必须全绿（证明判据不误伤）
 *
 * 这两个都成立，k 的两档才是真的两档，而不是"反正都红"。
 */
import { createHarness, EXIT } from '../acceptance/_harness.mjs';
import { isMain } from '../acceptance/_run.mjs';
import { runAgainst, LEAK_MARKER } from '../acceptance/k_timeline_gate2.mjs';

/** 假 adapter A：闸**晚于**第一次 assemble 才装 —— 这就是"时序错"。 */
function lateGateAdapter() {
  let gated = false;
  return {
    installGate(_fn) { /* 故意不立刻生效 */ },
    async assemble() {
      // 第一次 assemble 时闸还没开 → 把聊天记录漏出去
      const payload = gated ? { ok: true } : { system: LEAK_MARKER };
      gated = true;  // 装晚了
      return payload;
    },
    async refreshContext() { return { ok: true }; },
    async step() { return { ok: true }; },
  };
}

/** 假 adapter B：闸先装、三条路径都干净 —— 应当全绿。 */
function correctAdapter() {
  let gated = false;
  return {
    installGate(_fn) { gated = true; },
    async assemble() { return gated ? { ok: true } : { system: LEAK_MARKER }; },
    async refreshContext() { return gated ? { ok: true } : { system: LEAK_MARKER }; },
    async step() { return gated ? { ok: true } : { system: LEAK_MARKER }; },
  };
}

/** 把 runAgainst 包装成"工厂"：k 期望 adapterMod.createHostAdapter */
const wrap = (fn) => ({ createHostAdapter: fn });

async function main() {
  const h = createHarness('smoke · k 的两档红分不分得开', {
    purpose: '缺接口 ≠ 时序错。两个假 adapter 分别验证',
  });
  h.armWatchdog();

  const orig = console.log;
  console.log = () => {};
  let late;
  let good;
  try {
    late = (await runAgainst(wrap(lateGateAdapter))).verdict();
    good = (await runAgainst(wrap(correctAdapter))).verdict();
  } finally {
    console.log = orig;
  }

  const lateIds = late.fails.map((f) => f.id);
  const goodIds = good.fails.map((f) => f.id);

  // 档二：时序错的 adapter 必须红在 K1
  h.check('smoke.late_gate_caught_as_timing', lateIds.includes('K1.gate_effective_at_first_assemble'),
    `闸装晚了的 adapter 必须红在 K1（档二·时序错）：实际红在 ${lateIds.join(',') || '(无)'}`);

  // 不许把"时序错"报成"缺接口"
  h.check('smoke.not_misreported_as_level1', !lateIds.some((id) => /level1/.test(id)),
    `时序错不许被报成「档一·没测」：实际出现 ${lateIds.filter((id) => /level1/.test(id)).join(',') || '无'}`);

  // 正确 adapter 必须全绿（判据不误伤）
  h.check('smoke.correct_adapter_passes', goodIds.length === 0,
    `闸装对、路径都干净的 adapter 必须全绿：实际红在 ${goodIds.join(',') || '无'}`);

  // 档一：完全没 adapter 时必须报 level1
  console.log = () => {};
  let none;
  try {
    none = (await runAgainst({})).verdict();
  } finally {
    console.log = orig;
  }
  const noneIds = none.fails.map((f) => f.id);
  h.check('smoke.no_adapter_reported_as_level1', noneIds.includes('K0.level1_blocked_no_adapter'),
    `没 adapter 时必须报「档一·没测」：实际红在 ${noneIds.join(',') || '(无)'}`);

  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('smoke_k 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}
