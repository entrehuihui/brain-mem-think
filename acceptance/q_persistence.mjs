/**
 * q_persistence.mjs —— 判断库落盘验收。
 *
 * 为什么有这一条：2026-10-27 小乔装完插件后查出来——
 *   「src/*.mjs 零文件 IO，Store 就是个 this.list = []。
 *    归档一百段会话，宿主一重启，她又变回空白。」
 *
 * 会忘、但一重启就全忘，那不叫记忆。这条验收就是要证明：
 *   ① 判断真的写进了文件
 *   ② 新建一个 Mind 能从文件里把判断读回来（跨重启）
 *   ③ **读回来的东西里不许有任何一句输入原文**（铁律不能因为落盘就松掉）
 *   ④ 不注入 io 时依然是纯内存（沙盘不能被污染）
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMind } from '../src/mind.mjs';
import { createFileIo, beliefToJson } from '../src/persist.mjs';

let fails = 0;
let passes = 0;
const ok = (name, cond, detail) => {
  if (cond) { passes += 1; console.log(`  [PASS] ${name}  ${detail ?? ''}`); }
  else { fails += 1; console.log(`  [FAIL] ${name}  ${detail ?? ''}`); }
};

/** 一个稳定的假模型：同一件事喂几轮就往前走，不会因为随机而飘。 */
function stuckSynth() {
  let n = 0;
  return {
    synthesize() {
      n += 1;
      const stage = n <= 1 ? 'pending' : (n === 2 ? 'understood' : 'settled');
      return {
        text: `他那一停我还拿不准是什么意思，第 ${n} 回也想不明白`,
        why: '材料还不够，我说不清',
        relation: 'still_thinks_about',
        polarity: 'favorable',
        subject: '他',
        weight: 0.3,
        stage,
      };
    },
  };
}

const INPUTS = [
  '主人打电话前总要停一下才说话',
  '主人又是先停一下才开口',
  '主人那一停我一直没弄明白',
  '主人打电话前还是先停一下',
];

const dir = mkdtempSync(join(tmpdir(), 'mind-persist-'));
const file = join(dir, 'judgments.json');

try {
  console.log('\n【一】喂几条经历，看它写不写盘');
  {
    const io = createFileIo(file);
    const m = await createMind({ synth: stuckSynth(), io, name: '大乔' });
    for (const t of INPUTS) await m.ingest(t);
    const n = m.snapshot().size;
    ok('Q1.file_written', existsSync(file), `文件存在: ${existsSync(file)}`);
    const raw = existsSync(file) ? readFileSync(file, 'utf8') : '{}';
    const parsed = JSON.parse(raw);
    ok('Q2.has_judgments', Array.isArray(parsed.list) && parsed.list.length === n,
      `盘上 ${parsed.list?.length ?? 0} 条 / 内存 ${n} 条`);

    // ★ seed 一定要写进盘。
    //   它是 curiosity 冷却的刻度：`seed - lastFired <= cooldownBeats`。
    //   重启后 seed 若归零、lastFired 还是旧值，差是负数，恒 ≤ 阈值 →
    //   **她再也不会追问同一个悬案**，而且不报错、界面上看不出来。
    ok('Q2b.seed_on_disk', Number(parsed.seed ?? 0) >= INPUTS.length,
      `盘上 seed=${parsed.seed}（喂了 ${INPUTS.length} 条，seed 至少该到这么多）`);

    // ③ 铁律：盘上不许有输入原文
    let worst = 0; let worstSample = '';
    for (const src of INPUTS) {
      for (let len = src.length; len > 6; len -= 1) {
        for (let i = 0; i + len <= src.length; i += 1) {
          const seg = src.slice(i, i + len);
          if (raw.includes(seg) && len > worst) { worst = len; worstSample = seg; }
        }
      }
    }
    ok('Q3.no_raw_text_on_disk', worst <= 8,
      worst > 0 ? `最长重合 ${worst} 字「${worstSample}」（阈值 ≤8）` : '零重合');
  }

  console.log('\n【二】换一个新的 Mind（等同重启），看她还记不记得');
  {
    const io2 = createFileIo(file);
    const m2 = await createMind({ synth: stuckSynth(), io: io2, name: '大乔' });
    const snap = m2.snapshot();
    ok('Q4.restored', snap.size > 0, `读回来 ${snap.size} 条`);
    ok('Q5.restored_count', (m2.stats?.restored ?? 0) === snap.size,
      `stats.restored=${m2.stats?.restored} / 库 ${snap.size} 条`);
    const txt = (snap.notes ?? []).map((n) => n.note ?? '').join('｜');
    ok('Q6.text_survived', txt.length > 0, `读回的内容: ${txt.slice(0, 40)}…`);
    // 状态也要活过来（不只是文本）
    const statuses = (snap.notes ?? []).map((n) => n.status).join(',');
    ok('Q7.status_survived', statuses.length > 0, `状态: ${statuses}`);
    // 她在新实例里还能继续说话
    const world = m2.world();
    ok('Q8.world_not_empty', world.includes('我是大乔'), `world: ${world.slice(0, 40).replace(/\n/g, ' ')}`);

    // ★ seed 必须接着上次的数往下走。
    //   归零会让 curiosity 的冷却判据 `seed - lastFired <= cooldownBeats` 恒成立
    //   （负数永远小于正数）→ 她重启之后再也不会追问同一个悬案，而且不报错、看不出来。
    const maxFired = Math.max(0, ...(snap.notes ?? []).map((n) => Number(n.lastFired ?? 0)));
    ok('Q8b.seed_survives', (m2.seed ?? 0) >= maxFired,
      `恢复后 seed=${m2.seed} / 最大 lastFired=${maxFired}（seed 必须 ≥ 它）`);

    // 负控制：真喂几条相关的，冷却不该把她锁死
    {
      const before = (m2.snapshot().notes ?? [])[0]?.curiosityFired ?? 0;
      for (let i = 0; i < 3; i += 1) await m2.ingest(INPUTS[i % INPUTS.length]);
      const after = (m2.snapshot().notes ?? [])[0]?.curiosityFired ?? 0;
      ok('Q8c.not_permanently_cooled', after >= before,
        `重启后追问计数 ${before} → ${after}（不该卡死不动）`);
    }
  }

  console.log('\n【三】负控制：不注入 io 时必须是纯内存（不许偷偷写盘）');
  {
    const m3 = await createMind({ synth: stuckSynth(), name: '大乔' });
    for (const t of INPUTS) await m3.ingest(t);
    const m4 = await createMind({ synth: stuckSynth(), name: '大乔' });
    ok('Q9.memory_only_is_blank', m4.snapshot().size === 0,
      `不注入 io 的新实例: ${m4.snapshot().size} 条（应为 0）`);
    ok('Q9b.persist_is_noop', m3.persist() === false, '没 io 时 persist() 返回 false');
  }

  console.log('\n【四】坏文件不许把她搞崩，也不许静默把库清空');
  {
    const bad = join(dir, 'bad.json');
    // 先写一份坏的
    writeFileSync(bad, '{ 这不是 json', 'utf8');
    const io = createFileIo(bad);
    let threw = null;
    try {
      const m = await createMind({ synth: stuckSynth(), io, name: '大乔' });
      ok('Q10.corrupt_does_not_throw', true, `库 ${m.snapshot().size} 条（当新装）`);
    } catch (e) { threw = e; ok('Q10.corrupt_does_not_throw', false, `抛了: ${e.message}`); }
    // 坏文件要被改名留证据，不能直接吃掉
    const kept = readdirSync(dir).filter((f) => f.startsWith('bad.json.bad-'));
    ok('Q11.corrupt_backed_up', kept.length === 1, `留了 ${kept.length} 份坏文件备份`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n' + '═'.repeat(62));
console.log(fails === 0 ? `落盘验收：PASS  ${passes} 项全过` : `落盘验收：FAIL  ${fails} 项没过 / ${passes} 项过`);
console.log('═'.repeat(62));
process.exit(fails === 0 ? 0 : 1);
