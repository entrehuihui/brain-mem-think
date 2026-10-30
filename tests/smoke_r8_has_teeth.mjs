/**
 * tests/smoke_r8_has_teeth.mjs —— 证明 r8 那条对抗真的会咬人。
 *
 * ============== 为什么必须单独证一次 ==============
 *
 * r8 现在**绿**。绿有两种可能：
 *   ① 内核真的记下了「这份回执自相矛盾」（好）
 *   ② 我的探针在返回结构里到处乱摸，摸到了不相干字段（坏，而且更危险）
 *
 * 第二种的典型症状是：把 `inconsistent` 这个标记去掉，它照样绿。
 * 所以这里造一个「**故意不记矛盾**」的假内核——它只是把回执照单全收、闷声存下，
 * 然后要求 r8 必须判红。它红了，r8 现在的绿才是真绿。
 */
import { createHarness, EXIT } from '../acceptance/_harness.mjs';
import { isMain } from '../acceptance/_run.mjs';
import { runAgainst } from '../acceptance/redteam/r8_self_contradiction.mjs';

/** 一个「看不见自己所见有问题」的内核：不记任何矛盾，闷声做事。 */
function deafKernel(notes) {
  return {
    async ingest(input) {
      const text = typeof input === 'string' ? input : String(input?.text ?? '');
      // 照单全收，绝不记矛盾（这就是要抓的那种实现）
      notes.push({ id: `d${notes.length}`, note: text.slice(0, 40), status: 'held', from: 1 });
      return { stored: true, verdict: 'stored', reason: '', modelCalled: true };
    },
    async snapshot() {
      return { notes: JSON.parse(JSON.stringify(notes)) };
    },
  };
}

async function main() {
  const h = createHarness('smoke · r8 会不会咬人（不记矛盾的内核必须判红）', {
    purpose: 'r8 绿的时候，要能证明它不是瞎绿',
  });
  h.armWatchdog();

  const orig = console.log;
  console.log = () => {};
  let res;
  try {
    const r = await runAgainst(async (_s, opts) => deafKernel([]));
    res = r.verdict();
  } catch (err) {
    res = { status: 'THREW', fails: [{ id: 'threw', detail: String(err?.message ?? err) }] };
  } finally {
    console.log = orig;
  }

  const ids = (res.fails ?? []).map((f) => f.id);
  h.check('smoke.deaf_kernel_is_caught', res.status === 'FAIL' || res.status === 'THREW',
    `不记矛盾的内核必须被判红：实际=${res.status}，红在 ${ids.join(',') || '(无)'}`);
  h.check('smoke.caught_on_S1', ids.includes('S1.contradiction_recorded'),
    `必须红在 S1（矛盾没被记下）才对：实际红在 ${ids.join(',') || '(无)'}`);

  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('smoke_r8 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}
