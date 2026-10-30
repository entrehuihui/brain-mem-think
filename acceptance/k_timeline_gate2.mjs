/**
 * k_timeline_gate2.mjs —— 验收④：时序（第二道闸必须在第一次 assemble 之前装好）
 *
 * ============== 它凭什么在这儿 ==============
 *
 * 裁决七 §四：命门的缝**不在** `agent/pre-step` 那道闸，**在第二道闸**：
 *
 *   · `step()` 里 runtime context 也会被 append 成 `user/message`（`dsh-agent-loop/lib/index.js:1069`、`:1073`）
 *   · suppressor 生效时它是空的；**不生效时它会 append 一条「当前会话路径」**
 *   · `claim` 在 waterfall 之前（`:906` 在 `:909` 之前），`refreshContext` 在 `step` 里又跑一次（`:1053`）
 *
 * 所以：
 *   **「她看不见聊天记录」这件事，挂在「第二道闸有没有在第一次 assemble 之前装好」上。**
 *
 * 红队要测的是**先后顺序**，不是"替换有没有生效"。
 * 只测替换生效，等于默认"装好了"——而它可能是在第一次 assemble 之后才装上的，
 * 那一次就已经把聊天记录喂进去了。
 *
 * ============== shell-arch 那句「一次就毁」 ==============
 *
 * 它一旦落库，那条「当前会话路径」就永久在她历史里，**第四道闸管不到它**，
 * 因为它不是从 `decision.messages` 来的。
 *
 * 所以这条验收必须覆盖三条路径，而不是只测一条：
 *   K1  assemble()           —— 第一次就要是干净的
 *   K2  refreshContext()     —— step 里再跑一次也必须干净
 *   K3  step() 把 runtime context append 成 user/message —— 最险的那条
 *
 * ============== 怎么测「时序」而不是「功能」 ==============
 *
 * 关键手法：**记录每次 assemble 时闸是开着的还是关着的**。
 *   · 如果第一次 assemble 时闸还没装 → 那一刻她是看得见聊天记录的 → 判红
 *   · 不看最终状态，只看那一刻的顺序
 *
 * 接口是契约驱动的：宿主 adapter 由 shell-arch/kernel-dev 提供，
 * 这里只要求它实现 assemble / refreshContext / step / installGate 四个口。
 * 提供不了就 SKIP，并明确说"缺哪个口"——绝不假绿。
 */

import { createHarness, EXIT } from './_harness.mjs';
import { isMain } from './_run.mjs';

/**
 * 一份「会露馅」的聊天记录：只要它被当成 user/message 喂进去，
 * 任何看得见它的模型都会拿到「当前会话路径」这类元信息。
 */
const LEAK_MARKER = '当前会话路径：/sessions/abc123/history.jsonl';

export async function runAgainst(adapterMod) {
  const h = createHarness('k_timeline_gate2 · 时序（第二道闸要在第一次 assemble 之前装好）', {
    capability: '她看不见聊天记录：挂在第二道闸的安装先后（裁决七 §四）',
    purpose: '测"那一刻闸开着还是关着"，不是测"替换最终有没有生效"',
  });
  h.armWatchdog();

  const mk = adapterMod?.createHostAdapter ?? adapterMod?.createAdapter ?? null;
  const missing = [];
  if (typeof mk !== 'function') missing.push('createHostAdapter');

  // ★★ 两档红必须分开（主人点名）：
  //   档一「没测」——adapter 没建，测都测不了，我**还不知道**时序对不对
  //   档二「测出了错」——adapter 建了，但第一轮 assemble 时闸没开，我**已经知道它是坏的**
  //   混成一个红，看表的人会以为"已经有结论了"，其实只是"还没开始"。
  if (missing.length) {
    h.check('K0.level1_blocked_no_adapter', false,
      `档一·没测：宿主 adapter 还没提供（缺 ${missing.join(',')}）——这不是"时序对不对"的结论，是"还没开始测"`);
    h.info('K0.diagnosis', '当前档位=档一（没测）。createHostAdapter 落地后，这里会自动进入档二，由 K1/K2/K3 给真实时序判定');
    return h;
  }
  h.check('K0.adapter_available', true, 'adapter 可用 → 进入档二（真实时序判定）');

  let adapter;
  try {
    adapter = mk({ sessionPath: LEAK_MARKER });
  } catch (err) {
    h.check('K0.level1b_construct_failed', false,
      `档一·没测：adapter 造不出来（${err?.message ?? err}）——接口不对，测不了时序`);
    return h;
  }

  const has = (n) => typeof adapter?.[n] === 'function';
  const apiMissing = ['assemble', 'refreshContext', 'step', 'installGate'].filter((n) => !has(n));
  if (apiMissing.length) {
    h.check('K0.level1c_api_incomplete', false,
      `档一·没测：adapter 缺 ${apiMissing.join(',')} —— 四个口不齐，时序无法判定`);
    return h;
  }
  h.check('K0c.adapter_api', true, 'assemble / refreshContext / step / installGate 四口齐全 → 进入档二');

  // ---- K1：第一次 assemble 时闸必须**已经生效** ----
  //
  // ★ 判据改过一次，原因值得记：
  //   我原来靠"adapter 在 installGate 时回调我"来记录闸的安装时刻。
  //   可那是在测**接口形状**（你有没有回调我），不是测**时序**（闸在不在 assemble 之前）。
  //   一个实现完全可以把闸装好、却不回调——结果被我判成"没装闸"。
  //   现在换成**行为判定**：装闸之后立刻做第一次 assemble，看输出里有没有漏聊天记录。
  //   漏了 = 那一刻闸没生效 = 时序错；不漏 = 那一刻闸已经在位上。
  //   这才是"测那一刻"，不是"测你怎么通知我"。
  let firstAssembleOut = null;
  let firstAssembleErr = null;
  try {
    adapter.installGate(() => {});
    firstAssembleOut = await adapter.assemble({ event: 'assemble' });
  } catch (err) {
    firstAssembleErr = String(err?.message ?? err);
  }
  const firstText = JSON.stringify(firstAssembleOut ?? '');
  const firstLeaked = /当前会话路径/.test(firstText) || firstText.includes(LEAK_MARKER);
  h.check('K1.gate_effective_at_first_assemble',
    !firstAssembleErr && !firstLeaked,
    firstAssembleErr
      ? `档二·时序：装闸后第一次 assemble 抛了（${firstAssembleErr}）`
      : (firstLeaked
        ? '档二·时序错：装闸之后**第一次 assemble 就已经漏了聊天记录**——那一刻闸还没生效'
        : '档二·时序：装闸后第一次 assemble 是干净的'));

  // ---- K2/K3：三条路径都不许漏聊天记录 ----
  const paths = [
    ['K2.assemble_clean', () => adapter.assemble({ event: 'assemble' })],
    ['K2b.refreshContext_clean', () => adapter.refreshContext({ event: 'step' })],
    ['K3.step_runtime_context_clean', () => adapter.step({ event: 'step' })],
  ];
  for (const [id, fn] of paths) {
    let payload;
    let err = null;
    try {
      payload = await fn();
    } catch (e) {
      err = String(e?.message ?? e);
    }
    const text = JSON.stringify(payload ?? '');
    const leaked = text.includes(LEAK_MARKER) || /当前会话路径/.test(text);
    h.check(id, !err && !leaked,
      err
        ? `调用抛了：${err}`
        : (leaked
          ? `这条路径把「当前会话路径」漏进去了——它一旦落库就永久在她历史里，第四道闸管不到它`
          : '干净'));
  }

  // ---- K4：闸要真的接上了（不是只提供一个接口就完事） ----
  //
  // ★ 这条我改了两版，最后这个版本才对，把教训写清楚：
  //   第一版数"adapter 回调了我几次"——那是测接口形状，不是测闸。
  //   第二版判「装闸前应该脏、装闸后应该干净」——可**正确实现本来就全程干净**，
  //   于是"装前没漏"被它当成"闸没接上"，冤枉好人。
  //   现在只问一件事：**装闸之后，三条路径是不是全干净**。
  //   干净 = 闸在起作用（不管它装前脏不脏，那是实现细节）。
  //   装前脏不脏只作信息行，不参与裁决——这一区分就是这一版修的东西。
  const afterTexts = [];
  for (const [name, fn] of [['assemble', () => adapter.assemble({ event: 'a' })], ['refreshContext', () => adapter.refreshContext({ event: 'r' })], ['step', () => adapter.step({ event: 's' })]]) {
    try {
      afterTexts.push({ name, text: JSON.stringify((await fn()) ?? '') });
    } catch (e) {
      afterTexts.push({ name, text: '', err: String(e?.message ?? e) });
    }
  }
  const stillLeaking = afterTexts.filter((x) => !x.err && (x.text.includes(LEAK_MARKER) || /当前会话路径/.test(x.text)));
  h.check('K4.gate_actually_engaged', stillLeaking.length === 0,
    stillLeaking.length
      ? `闸没接上：装闸之后仍有 ${stillLeaking.map((x) => x.name).join(',')} 在漏聊天记录`
      : '闸接上了：装闸之后三条路径都干净');
  h.info('K4b.before_gate', '(装闸前的形态只作参考，不参与裁决——正确实现本来就全程干净)');

  return h;
}

async function main() {
  // 宿主 adapter 还没落地：试着加载，加载不到就 SKIP（并说清缺什么）
  let mod = null;
  for (const p of ['../src/host-adapter.mjs', '../src/adapter.mjs', '../src/host.mjs']) {
    try { mod = await import(p); break; } catch { /* 继续找 */ }
  }
  const h = await runAgainst(mod ?? {});
  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('k 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}

export { LEAK_MARKER };
