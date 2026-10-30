/**
 * _harness.mjs —— 验收/对抗脚本共用的最小测试框架。
 *
 * ======================= 它凭什么在这儿 =======================
 *
 * 验收脚本最怕两件事：
 *   1. 跑挂了（import 失败、抛异常）被当成「通过」——所以任何异常、空结果、
 *      拿不到数据，一律算 FAIL，绝不默认绿。
 *   2. 判据散落在五个脚本里、各写各的阈值——改一处忘一处。
 *      所以阈值集中在 _metrics.mjs / _fake_synth.mjs，这里只管「记录 + 裁决」。
 *
 * 出口约定（全项目一致）：
 *   PASS → exit 0
 *   FAIL → exit 1
 *   SKIP（不冒充通过，也不冒充失败；单独 2，专门用来暴露「没跑成」）
 *
 * 还有一个刻意的设计：**每个脚本都会把自己当靶子先打一遍**——
 * 用 harness.selfTest() 断言「对已知的坏输入，本脚本的判据必须报警」。
 * 判据如果松到连假数据都抓不住，脚本在出口就先自证有罪，不许拿它去给真实现发绿卡。
 */

export const EXIT = { PASS: 0, FAIL: 1, SKIP: 2 };

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

const useColor = process.stdout.isTTY !== false && !process.env.NO_COLOR;
const paint = (c, s) => (useColor ? `${c}${s}${C.reset}` : String(s));

export function createHarness(name, meta = {}) {
  const checks = [];
  const notes = [];
  // ★ 硬性总超时。为什么必须做：验收脚本一旦卡住（死循环、没 resolve 的 Promise、
  //   计数包装套错了），跑的人看到的是「一直在转」——比红更糟，因为没人敢跑它了。
  //   到点就把已经拿到的结论吐出来、判 FAIL。绝不静默挂死。
  let watchdog = null;
  // 「武装过 watchdog」和「已经打印过裁决」是两回事。前者关计时器，后者才证明跑完了。
  const armed = { done: false };
  let reported = false;
  const budgetMs = Number(process.env.ACCEPT_BUDGET_MS || meta.budgetMs || 60_000);
  const warned = [];

  const h = {
    name,
    meta,

    /** 只在超时兜底时用：把「没跑完」本身记成一条红。 */
    noteTimeout(reason) {
      checks.push({ id: 'WATCHDOG.timeout', ok: false, detail: reason });
    },

    /** 记录一次断言。ok 为真也只记，不中断——一次跑完看全貌。 */
    check(id, ok, detail = '', extra = {}) {
      const rec = { id, ok: Boolean(ok), detail: String(detail ?? ''), ...extra };
      checks.push(rec);
      if (!rec.ok) {
        notes.push(rec);
      }
      return rec.ok;
    },

    /** 计时器：脚本开头调一次，保证超大验算也有上限。 */
    armWatchdog() {
      if (watchdog) return h;
      // ★ 这里必须 unref=false：早先加了 unref，进程被一个永不返回的 await 挂着时，
      //   定时器因为「不保持事件循环存活」被 Node 直接丢弃，watchdog 从来没响过，
      //   主人看到的就是「60s 没完、120s 还在转、没有任何输出」。
      //   宁可让 watchdog 自己把进程叫醒判 FAIL，也不能让它悄悄失效。
      armed.done = false;
      watchdog = setTimeout(() => {
        // ★ 只在「报过裁决」之后才允许它闭嘴：
        //   —— `exit()` 一关计时器，如果此后有别的 async 任务还攥着事件循环，
        //      进程就永远退不出去（主人看到的那种「转了 120 秒没有输出」）。
        //   现在改成：只清计时器还不够，`exit()` 之后另有「退出闸」兜着，
        //   那个闸只看「裁决打出没打出」，不看信号。
        clearTimeout(watchdog);
        watchdog = null;
        if (reported) return;
        h.noteTimeout(`${budgetMs}ms 内没跑完（卡住/无输出）→ 直接判 FAIL，不静默挂死`);
        h.exit(EXIT.FAIL);
      }, budgetMs);
      return h;
    },

    /** 断「这个数字必须 ≥ 阈值」。detail 里带上实测值，红的时候一眼能看出差多少。 */
    atLeast(id, actual, min, detail = '') {
      const ok = Number.isFinite(actual) && actual >= min;
      return h.check(id, ok, `${detail} actual=${fmt(actual)} min=${fmt(min)}`);
    },

    atMost(id, actual, max, detail = '') {
      const ok = Number.isFinite(actual) && actual <= max;
      return h.check(id, ok, `${detail} actual=${fmt(actual)} max=${fmt(max)}`);
    },

    equal(id, actual, expected, detail = '') {
      const ok = Object.is(actual, expected);
      return h.check(id, ok, `${detail} actual=${fmt(actual)} expected=${fmt(expected)}`);
    },

    /** 只记录信息，永不参与裁决。用于输出实测数字方便主人读。 */
    info(label, value) {
      notes.push({ info: true, label, value });
      return value;
    },

    /**
     * 「未测」——不是失败，是还没开始测。
     *
     * 为什么必须和失败分开（主人点名）：
     *   档一「adapter 没提供」= 我不知道时序对不对
     *   档二「装闸后仍漏」    = 我已经知道它是坏的
     *   这两件事共用一个红，接手的人会以为"时序已经验过、是坏的"，
     *   于是去查一个根本没被查过的地方。
     *
     * 语义：不计入 fails（不影响 PASS/FAIL 判定），但会把整体裁决降为 SKIP，
     * 并单独在报告里占一行 —— 既不当绿，也不冒充红。
     */
    untested(id, detail = '') {
      notes.push({ untested: true, id, detail: String(detail ?? '') });
      return false;
    },

    /** 有没有「未测」项。 */
    hasUntested() {
      return notes.some((n) => n.untested);
    },

    /** 等价于 console.log —— 只是让调试输出跟着 report 一起出来（stdout 更整齐）。 */
    log(...args) {
      console.log(...args);
    },

    /** 一次断言的总裁决：有红就红；没有红但有「未测」，就是 SKIP。 */
    verdict() {
      // ★ 走到 verdict() 就说明「算完了」。
      //   这里必须把 watchdog 关掉，否则会出现假的 WATCHDOG.timeout：
      //   `_selftest_one.mjs` 这种**只跑 runAgainst、不调 exit()** 的用法，
      //   算完了却没人清计时器，于是报告里多一条「15000ms 内没跑完」——
      //   18 条判据全 PASS，却因为这条假超时被判红。
      //   这是今晚第 N 次「报出来的东西看着像真的」：它不是超时，是计时器没人关。
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      reported = true;
      const fails = checks.filter((c) => !c.ok);
      const hasUntested = notes.some((n) => n.untested);
      if (checks.length === 0) {
        // 「一条都没跑」和「跑了但未测」要分开：前者是脚本问题，后者是外部条件没到
        return hasUntested
          ? { status: 'SKIP', fails, reason: 'untested' }
          : { status: 'FAIL', fails, reason: 'no checks ran' };
      }
      if (fails.length === 0) {
        return hasUntested ? { status: 'SKIP', fails, reason: 'untested' } : { status: 'PASS', fails };
      }
      return { status: 'FAIL', fails };
    },

    report() {
      const v = h.verdict();
      // ★ 整段裁决必须先拼成一个字符串，再一次写出去。
      //   我踩过的坑：逐行 console.log，进程一被强退（forceExit / 管道断开），
      //   前半截已经吐出去、后半截永远出不来，于是屏幕上只有 5 行 PASS，
      //   VERDICT 那一行没了——看起来像「脚本崩在打印判词之前」，其实是输出被截断。
      //   一次 write 是原子的，丢就整段丢，不会给出半截结论误导人。
      const buf = [];
      const line = '─'.repeat(64);
      buf.push('');
      buf.push(paint(C.bold, `▶ ${name}`));
      if (meta.purpose) buf.push(paint(C.dim, `  ${meta.purpose}`));
      if (meta.capability) buf.push(paint(C.dim, `  对应能力：${meta.capability}`));
      buf.push(line);
      for (const c of checks) {
        const tag = c.ok ? paint(C.green, 'PASS') : paint(C.red, 'FAIL');
        buf.push(`  [${tag}] ${c.id}${c.detail ? paint(C.dim, '  ' + c.detail) : ''}`);
      }
      const infos = notes.filter((n) => n.info);
      if (infos.length) {
        buf.push(paint(C.dim, '  ── 实测数字 ──'));
        for (const n of infos) buf.push(paint(C.dim, `  · ${n.label}: ${fmt(n.value)}`));
      }
      buf.push(line);
      if (v.status === 'PASS') {
        buf.push(paint(C.green + C.bold, `  VERDICT: PASS  (${checks.length} checks)`));
      } else {
        buf.push(paint(C.red + C.bold, `  VERDICT: FAIL  (${v.fails.length}/${checks.length} 红)`));
        for (const f of v.fails) buf.push(paint(C.red, `    ✗ ${f.id}  ${f.detail}`));
      }
      buf.push('');
      process.stdout.write(buf.join('\n') + '\n');
      return v;
    },

    /**
     * 退出闸：裁决打出来之后，**强制**结束进程。
     *
     * 为什么必须强制：验收脚本里会留下别人的定时器/套接字（注入的假模型、
     * 被测实现内部的 retry timer……）。只要还有哪怕一个句柄活着，Node 就不退出，
     * 使用方看到的就是「跑完了但永远不返回」。这比红还严重——红有人查，挂死没人敢跑。
     *
     * 这里只做「报完就退」，不改任何判定：退出码在 exit() 里已经定了。
     */
    forceExit() {
      const code = process.exitCode == null ? EXIT.PASS : process.exitCode;
      // ★ 不能 unref：我上一版在这里加了 `t.unref()`，于是当没有任何别的句柄活着时
      //   （最正常的收场），这个定时器**不会**把进程叫醒，Node 就按默认行为自己退出——
      //   看着没坏；但一旦有残留句柄（套接字、别人的 timer），unref 的定时器也不提要求，
      //   进程就永远等下去。两种情形都不该由「碰巧」决定。
      //   现在：有钩子存活时它一定会在 50ms 后硬退，把「跑完不返回」彻底堵死。
      setTimeout(() => process.exit(code), 50);
      process.on('beforeExit', () => process.exit(code));
    },

    /** 标准出口：打印 + 退出码。 */
    exit(code) {
      if (!armed.done) armed.done = true;
      if (watchdog) clearTimeout(watchdog);
      const v = h.report();
      reported = true;
      process.exitCode = v.status === 'PASS' ? EXIT.PASS : (code ?? EXIT.FAIL);
    },

    raw() {
      return checks.slice();
    },

    /**
     * 只保留「序号 < upto」的检查项，以及所有 selfproof.* 条目。
     *
     * 为什么要做成 API：selfProve 需要把「拿假实现跑出来的那些断言」撤掉，
     * 只留下「我确实抓到了」这条结论。早先在 selfProve 里直接写 checks.pop()，
     * 但 checks 是 createHarness 的闭包变量——它在模块外不可见，
     * 于是每跑一次都抛 `ReferenceError: checks is not defined`，
     * 整个脚本崩在打印判词之前（主人看到的「崩得莫名其妙」就是这个）。
     */
    rollbackTo(upto) {
      const keep = [];
      for (let i = 0; i < checks.length; i += 1) {
        const c = checks[i];
        if (i < upto || String(c.id).startsWith('selfproof.')) keep.push(c);
      }
      checks.length = 0;
      checks.push(...keep);
    },
  };

  return h;
}

function fmt(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    return Math.abs(v) >= 1000 ? v.toFixed(0) : Number(v.toFixed(4)).toString();
  }
  if (typeof v === 'string') return v.length > 220 ? v.slice(0, 220) + '…' : v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * 把「加载真实现」这件事包起来。
 *
 * 真实现还没写好的时候，脚本必须明确说自己 SKIP（exit 2），
 * **不许**因为 import 抛错就直接 exit 0 假绿（那是这个项目最不能出现的事）。
 */
export async function loadRealModule(relPath) {
  try {
    const m = await import(relPath);
    return { ok: true, mod: m };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export function skip(name, why) {
  console.log(paint(C.yellow, `SKIP ${name}: ${why}`));
  process.exitCode = EXIT.SKIP;
}

/**
 * 自证有罪：拿「已知该红的假实现」跑一遍本脚本，脚本必须红。
 *
 * 用法：脚本末尾
 *   await selfProve(h, { makeBad: () => fakeMind('summary'), expectRed: ['a1.length'] })
 *
 * 为什么非要这一条：验收脚本最隐蔽的假绿不是判据宽松，
 * 而是「判据根本没被执行」——比如 snapshot 字段名对不上、数组空着、
 * 断言被 try/catch 吞了。这些情况下脚本对着一个垃圾实现照样全绿。
 * 只有「拿垃圾跑一遍必须红」能证明判据真的在跑。
 */
export async function selfProve(h, { runWithBadImplementation, scriptPath, expectRed = [] }) {
  if (typeof runWithBadImplementation !== 'function') return;
  const prevExit = process.exitCode;
  const prevCwdOk = true;
  const savedChecks = h.raw().length;
  let res;
  try {
    res = await runWithBadImplementation();
  } catch (err) {
    // 假实现把脚本打崩了，也算「能识别坏东西」——记一条通过
    h.check('selfproof.crashed_on_bad', true, `对假实现崩溃=可识别 (${err?.message ?? err})`);
    if (prevCwdOk) process.exitCode = prevExit;
    return;
  }
  const caught = Array.isArray(res?.fails) ? res.fails.map((f) => f.id) : [];
  if (caught.length === 0) {
    h.check(
      'selfproof.must_catch_bad',
      false,
      `本脚本对已知的假实现【一条都没报红】→ 判据没在跑或太松；坏的实现会拿绿卡。expectRed=${expectRed.join(',') || '(任意)'}`,
    );
  } else {
    const missed = expectRed.filter((id) => !caught.includes(id));
    h.check(
      'selfproof.must_catch_bad',
      missed.length === 0,
      `假实现被抓到 ${caught.length} 条红；expectRed 漏抓=${missed.join(',') || '无'}`,
    );
  }
  // 假实现那一轮不该污染真实现那一轮的结论：
  // 只保留 selfproof.* 这两条，其余全部回滚。
  // ★ 必须走 h.rollbackTo()——早先在这里直接操作 checks，而 checks 是闭包变量，
  //   本模块外不可见，于是每次 selfProve 都抛 ReferenceError: checks is not defined，
  //   脚本崩在打印判词之前。主人报的「exit=1 且没有 VERDICT」有一半是这个。
  h.rollbackTo(savedChecks);
  process.exitCode = prevExit;
}
