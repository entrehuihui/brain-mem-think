/**
 * plugin 的验收 —— 验的是「壳」这一层，不是内核。
 *
 * 内核那边四能力已经有 22 条绿了。这里验三件壳最容易犯的错：
 *   一、出口只有一条（`followup(` 全目录唯一）
 *   二、六步顺序是契约（状态 → 归档 → 去重 → 发送 → flush → 记账）
 *   三、账本坏掉时一律往「不说」倒，而且不许变成永远哑
 *
 * 一件都不许「看起来对」——每一条都有负控制。
 */

import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { speakToOwner } from '../plugin/wake-exit.mjs';
import { readWake, writeWake, hashMessage, normMessage, emptyState } from '../plugin/wake-store.mjs';
import { ownerMessages } from '../plugin/collect.mjs';
import { planWake, applyWake } from '../plugin/awake.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..', 'plugin');

let fails = 0;
let passes = 0;
const ok = (name, cond, detail) => {
  if (cond) { passes += 1; console.log(`  [PASS] ${name}  ${detail ?? ''}`); } else { fails += 1; console.log(`  [FAIL] ${name}  ${detail ?? ''}`); }
};

/** 造一个假的 agent + ctx，用来驱动唯一出口。 */
function fakeAgent({ status = 'idle', flushOk = true } = {}) {
  const calls = [];
  let flushed = 0;
  const agent = {
    status,
    session: { id: 'sess-1' },
    followup(msg) { calls.push(msg); },
  };
  const ctx = {
    sessions: { async flush() { flushed += 1; return flushOk; } },
    workspaceRegistry: { archivedSessionIds: [] },
  };
  return { agent, ctx, calls, get flushed() { return flushed; } };
}

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'mind-wake-'));
  return { dir, path: join(dir, 'wake.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ══════════════════════════════════════════════════════════════
console.log('\n【一】出口只有一条');
{
  // 静态扫：plugin/ 下所有 .mjs 里，`followup(` 必须恰好出现 1 次
  let count = 0;
  const hits = [];
  for (const f of readdirSync(PLUGIN)) {
    if (!f.endsWith('.mjs')) continue;
    const text = readFileSync(join(PLUGIN, f), 'utf8');
    // 去掉注释行再数，免得注释里的 followup( 被算进去
    const code = text.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    const n = (code.match(/\.followup\(/g) ?? []).length;
    if (n) hits.push(`${f}:${n}`);
    count += n;
  }
  ok('X1.one_exit_only', count === 1, `plugin/ 下 .followup( 命中 ${count} 处（要求恰好 1）：${hits.join(', ') || '无'}`);

  // 旁路：不许有 steer / send
  let side = 0;
  for (const f of readdirSync(PLUGIN)) {
    if (!f.endsWith('.mjs')) continue;
    const code = readFileSync(join(PLUGIN, f), 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    side += (code.match(/\.steer\(|\.send\(/g) ?? []).length;
  }
  ok('X2.no_side_channel', side === 0, `旁路调用 ${side} 处（要求 0）`);

  // 负控制：塞一句 followup 进去，扫描必须能数出来
  const probe = `${PLUGIN}/.probe-followup.mjs`;
  writeFileSync(probe, 'export const x = () => agent.followup({});\n');
  let probeCount = 0;
  for (const f of readdirSync(PLUGIN)) {
    if (!f.endsWith('.mjs')) continue;
    const code = readFileSync(join(PLUGIN, f), 'utf8');
    probeCount += (code.match(/\.followup\(/g) ?? []).length;
  }
  rmSync(probe, { force: true });
  ok('X1b.probe_catches_extra', probeCount === 2, `塞一条假出口后命中 ${probeCount} 处（应为 2，证明这把刀能咬人）`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n【二】六步顺序是契约');
{
  const s = tmpStore();
  try {
    // 2a 忙 → 不排队，也不调 followup
    {
      const f = fakeAgent({ status: 'running' });
      const r = await speakToOwner({ agent: f.agent, sessionId: 'sess-1', message: '我想说一句', ctx: f.ctx, storePath: s.path });
      ok('X3.busy_skips', r.sent === false && r.why === 'busy' && f.calls.length === 0,
        `busy 时 sent=${r.sent} why=${r.why} followup 调了 ${f.calls.length} 次`);
    }
    // 2b 归档 → 不发
    {
      const f = fakeAgent();
      f.ctx.workspaceRegistry.archivedSessionIds = ['sess-1'];
      const r = await speakToOwner({ agent: f.agent, sessionId: 'sess-1', message: '我想说一句', ctx: f.ctx, storePath: s.path });
      ok('X4.archived_skips', r.sent === false && r.why === 'archived' && f.calls.length === 0,
        `归档时 sent=${r.sent} why=${r.why} followup 调了 ${f.calls.length} 次`);
    }
    // 2c 正常 → 发、flush、记账
    {
      const f = fakeAgent();
      const r = await speakToOwner({ agent: f.agent, sessionId: 'sess-1', message: '他今天没说话', ctx: f.ctx, storePath: s.path, now: 1000 });
      const st = readWake(s.path);
      ok('X5.send_and_record', r.sent === true && f.calls.length === 1 && f.flushed === 1 && st.lastSpokeAt === 1000,
        `sent=${r.sent} followup=${f.calls.length} flush=${f.flushed} lastSpokeAt=${st.lastSpokeAt}`);
    }
    // 2d 重复 → 挡住（负控制：换一句话必须能发）
    {
      const f = fakeAgent();
      const r1 = await speakToOwner({ agent: f.agent, sessionId: 'sess-1', message: '他今天没说话', ctx: f.ctx, storePath: s.path, now: 2000 });
      const r2 = await speakToOwner({ agent: f.agent, sessionId: 'sess-1', message: '他今天没说话', ctx: f.ctx, storePath: s.path, now: 3000 });
      const f2 = fakeAgent();
      const r3 = await speakToOwner({ agent: f2.agent, sessionId: 'sess-1', message: '我有点想他', ctx: f2.ctx, storePath: s.path, now: 4000 });
      ok('X6.repeat_blocked', r2.sent === false && r2.why === 'repeat',
        `同一句第二次 sent=${r2.sent} why=${r2.why}`);
      ok('X6b.new_line_passes', r3.sent === true,
        `换一句 sent=${r3.sent}（负控制：证明不是全都挡住了）`);
    }
    // 2e flush 失败 → 不记账、算没发
    {
      const f = fakeAgent({ flushOk: false });
      const r = await speakToOwner({ agent: f.agent, sessionId: 'sess-1', message: '另一句', ctx: f.ctx, storePath: s.path, now: 5000 });
      const st = readWake(s.path);
      ok('X7.flush_failed_no_record', r.sent === false && r.why === 'flush-unavailable' && st.lastSpokeAt !== 5000,
        `flush 失败时 sent=${r.sent} why=${r.why} lastSpokeAt=${st.lastSpokeAt}（不该是 5000）`);
    }
  } finally { s.cleanup(); }
}

// ══════════════════════════════════════════════════════════════
console.log('\n【三】账本坏掉，一律往「不说」倒');
{
  const s = tmpStore();
  try {
    // 3a 文件不存在 → 能说（全新安装不该一上来就哑）
    const st0 = readWake(s.path);
    ok('X8.missing_allows', st0.degraded === undefined && st0.lastSpokeAt === 0,
      `文件不存在 degraded=${st0.degraded} lastSpokeAt=${st0.lastSpokeAt}`);

    // 3b JSON 坏了 → 当作刚说完话，而且备份原文件
    writeFileSync(s.path, '{这不是 json', 'utf8');
    const st1 = readWake(s.path);
    ok('X9.corrupt_blocks', st1.degraded === 'corrupt-json' && st1.lastSpokeAt > 0,
      `坏 JSON degraded=${st1.degraded} lastSpokeAt=${st1.lastSpokeAt}（>0 说明进了冷却）`);
    const bak = readdirSync(s.dir).filter((f) => f.includes('.bad-'));
    ok('X9b.corrupt_backedup', bak.length === 1, `备份文件 ${bak.length} 个（应 1 个）`);

    // 3c schema 不对 → 同样闭嘴
    writeFileSync(s.path, JSON.stringify({ version: 999, nope: true }), 'utf8');
    const st2 = readWake(s.path);
    ok('X10.bad_schema_blocks', st2.degraded === 'bad-schema' && st2.lastSpokeAt > 0,
      `schema 不对 degraded=${st2.degraded} lastSpokeAt=${st2.lastSpokeAt}`);

    // 3d 崩在写盘中间 → 看到标记就闭嘴
    //
    // ★ 这里必须用 crashOnly：正常 writeWake 的最后一步一定会把标记改回 false。
    //   这正是它该有的行为——「写完了就没崩」。要模拟「崩了一半」，
    //   只能停在第 ① 步。我第一次写成正常 writeWake，读出来 degraded=undefined，
    //   判据当场就咬住了：**它证明这把刀能分清「写完」和「写了一半」。**
    writeWake(s.path, { ...emptyState(), lastSpokeAt: 777 }, { crashOnly: true });
    const st3 = readWake(s.path);
    ok('X11.crash_flag', st3.degraded === 'crashed-mid-wake',
      `崩溃标记 degraded=${st3.degraded} lastSpokeAt=${st3.lastSpokeAt}`);
    // 负控制：正常写完，标记必须消失
    writeWake(s.path, { ...emptyState(), lastSpokeAt: 888 });
    const st3b = readWake(s.path);
    ok('X11b.crash_flag_cleared', st3b.degraded === undefined,
      `正常写完 degraded=${st3b.degraded}（负控制：证明不是永远带着标记）`);

    // 3e 正常写读 → 字段对得上（负控制：证明不是永远闭嘴）
    writeWake(s.path, { ...emptyState(), lastSpokeAt: 1234, spokenHashes: [{ hash: 'abc', at: 1 }] });
    const st4 = readWake(s.path);
    ok('X12.roundtrip', st4.lastSpokeAt === 1234 && st4.spokenHashes.length === 1 && st4.degraded === undefined,
      `写读往返 lastSpokeAt=${st4.lastSpokeAt} hashes=${st4.spokenHashes.length} degraded=${st4.degraded}`);
  } finally { s.cleanup(); }
}

// ══════════════════════════════════════════════════════════════
console.log('\n【四】账本里不许出现她说过的原文');
{
  const s = tmpStore();
  try {
    const f = fakeAgent();
    const line = '他今天没跟我说话，我有点担心他';
    await speakToOwner({ agent: f.agent, sessionId: 'sess-1', message: line, ctx: f.ctx, storePath: s.path, now: 9000 });
    const raw = readFileSync(s.path, 'utf8');
    const leaked = raw.includes(normMessage(line)) || raw.includes(line);
    ok('X13.no_raw_text', !leaked, `账本里${leaked ? '出现了' : '没有'}她的原话（只该存哈希）`);
    ok('X13b.hash_present', raw.includes(hashMessage(line)), '账本里存了归一化后的哈希');
  } finally { s.cleanup(); }
}

// ══════════════════════════════════════════════════════════════
console.log('\n【五】归档熔只收主人说的话（裁决七：她的话不是经历）');
{
  const mixed = [
    { role: 'user', content: '我在阳台给你留了个角落' },
    { role: 'assistant', content: '我想明白了，你其实不是不放心我，是怕我没资格被依靠' },
    { role: 'user', content: '铺了软垫，你随时可以去' },
    { role: 'tool', content: '{"ok":true}' },
    { role: 'system', content: 'You are an AI agent running on DeepSeek Harness.' },
    { role: 'assistant', content: '我记得这件事，我会一直记着' },
    { role: 'unknownish', content: '认不出的角色' },
  ];
  const kept = ownerMessages(mixed);
  ok('Y1.only_owner_lines', kept.length === 2, `7 条里只收下 ${kept.length} 条（应是 2 条主人的话）`);
  ok('Y2.her_lines_dropped', !kept.some((k) => k.text.includes('我想明白了') || k.text.includes('我会一直记着')),
    '她说的话一条都没进材料');
  ok('Y3.tool_and_system_dropped', !kept.some((k) => k.text.includes('ok') || k.text.includes('DeepSeek Harness')),
    '工具结果和系统注入都没进材料');

  // 负控制：一段全是她说话的会话，必须收 0 条
  const hersOnly = [
    { role: 'assistant', content: '我想明白了，他其实不是不放心我' },
    { role: 'assistant', content: '这件事我记得' },
  ];
  ok('Y4.her_only_session_empty', ownerMessages(hersOnly).length === 0,
    '全是她说话的会话收下 0 条（负控制：证明不是什么都收）');

  // 负控制：一段全是主人说的，必须都收下
  const hisOnly = [
    { role: 'user', content: '今天有点累' },
    { role: 'user', content: '晚上吃点好的' },
  ];
  ok('Y5.owner_only_session_kept', ownerMessages(hisOnly).length === 2,
    '全是主人说话的会话收下 2 条（负控制：证明不是什么都丢）');
}

// ══════════════════════════════════════════════════════════════
console.log('\n【六】唤醒：醒 ≠ 说');
{
  const s = tmpStore();
  try {
    // 空库：醒来也不该说话
    const emptyMind = { notes: () => [] };
    let spoke = 0;
    for (let i = 0; i < 10; i += 1) {
      const plan = await planWake({ mind: emptyMind, state: { ...emptyState(), lastWakeAt: 0 }, now: 1_000_000 + i * 3_600_000, cfg: {} });
      if (plan.action === 'speak') spoke += 1;
    }
    ok('Z1.empty_library_silent', spoke === 0, `空库醒 10 次，开口 ${spoke} 次（应为 0）`);

    // 崩溃标记 → 强制沉默
    const plan = await planWake({ mind: emptyMind, state: { ...emptyState(), degraded: 'crashed-mid-wake' }, now: 9e12, cfg: {} });
    ok('Z2.crash_forces_silent', plan.action === 'silent' && /没写完/.test(plan.because),
      `崩溃标记下 action=${plan.action} because=${plan.because}`);

    // 记账：说了没说成，lastSpokeAt 不许动
    const st1 = readWake(s.path);
    applyWake(s.path, { action: 'speak', why: 't', sent: false, now: 5000 });
    const after = readWake(s.path);
    ok('Z3.failed_send_no_spoke_at', after.lastSpokeAt === (st1.lastSpokeAt ?? 0),
      `发失败后 lastSpokeAt=${after.lastSpokeAt}（不该变成 5000）`);
    ok('Z3b.window_recorded', after.lastWakeAt === 5000 && after.window.length === 1,
      `窗口记了 ${after.window.length} 条，lastWakeAt=${after.lastWakeAt}`);
  } finally { s.cleanup(); }
}

console.log('\n' + '═'.repeat(64));
console.log(fails === 0 ? `plugin 验收：PASS  ${passes} 项全过` : `plugin 验收：FAIL  ${fails} 项没过 / ${passes} 项过`);
console.log('═'.repeat(64));
process.exit(fails === 0 ? 0 : 1);
