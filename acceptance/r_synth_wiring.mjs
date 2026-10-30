/**
 * r_synth_wiring.mjs —— 「模型真的被接上了没有」的验收。
 *
 * 为什么单独一条：2026-10-27 小乔装完插件后查出来——
 *   「`synth` 从头到尾没被赋值过。熔 → nothing_to_digest → 库永远空
 *    → 追问没东西可追 → restored 恒 0 → 注入恒空。」
 *
 * 而当时落盘验收 15 项全绿——因为它用的是**假 synth**。
 * **验收绿了，产品是哑的。** 这正是这个项目自己的「反假绿」要抓的东西。
 *
 * 所以这条验收的重点不是「函数能跑」，而是：
 *   ① 宿主的 llm 真被调到了（不是被 promise 包了一层就完事）
 *   ② 内核给的材料**原样**送进去，没有被截断或改写
 *   ③ **熔那条路真的通了** —— 喂经历 → 模型被问 → 判断落库
 *   ④ 模型没答上来 / 没配模型 / 流抛错，都必须安静地返回 null，不许把这一轮带崩
 */

import { createSynth } from '../plugin/synth.mjs';
import { createMind } from '../src/mind.mjs';

let fails = 0;
let passes = 0;
const ok = (name, cond, detail) => {
  if (cond) { passes += 1; console.log(`  [PASS] ${name}  ${detail ?? ''}`); }
  else { fails += 1; console.log(`  [FAIL] ${name}  ${detail ?? ''}`); }
};

/** 造一个假的宿主 llm：它只吐 text-delta，形状跟真的流一致。 */
function fakeLlm(reply, { throwOnStream = false } = {}) {
  const calls = [];
  return {
    calls,
    stream(req) {
      calls.push(req);
      if (throwOnStream) throw new Error('stream boom');
      return (async function* gen() {
        for (const piece of String(reply).match(/[\s\S]{1,12}/g) ?? []) {
          yield { type: 'text-delta', text: piece };
        }
      })();
    },
  };
}

const scopeWith = (llm, sel = { provider: 'p', model: 'm' }) => ({
  llm,
  agentDefaultModel: { currentSelection: () => sel },
});

// ══════════════════════════════════════════════════════════════
console.log('\n【一】合成器本身');
{
  const llm = fakeLlm('{"text":"他累了"}');
  const s = createSynth(scopeWith(llm), {});
  ok('R1.created', !!s, s ? `route=${s.route}` : '没造出来');
  const out = await s.synthesize('材料甲：他说没事');
  ok('R2.returns_text', out === '{"text":"他累了"}', `模型原话: ${JSON.stringify(out)}`);
  ok('R3.llm_called_once', llm.calls.length === 1, `llm.stream 被调 ${llm.calls.length} 次`);
  ok('R4.material_passthrough', llm.calls[0]?.messages?.[0]?.content?.[0]?.text === '材料甲：他说没事',
    '材料原样送进去，没被截断或改写');
  ok('R5.route_used', llm.calls[0]?.provider === 'p' && llm.calls[0]?.model === 'm',
    `provider=${llm.calls[0]?.provider} model=${llm.calls[0]?.model}`);

  // 负控制：空材料不调模型
  const llm2 = fakeLlm('x');
  const s2 = createSynth(scopeWith(llm2), {});
  ok('R6.empty_material_no_call', (await s2.synthesize('   ')) === null && llm2.calls.length === 0,
    '空材料返回 null，且没浪费一次模型调用');
}

console.log('\n【二】拿不到服务 / 出错时，必须安静地返回 null');
{
  ok('R7.no_llm', createSynth({ agentDefaultModel: {} }, {}) === null, '没有 llm 服务 → 返回 null');
  ok('R8.llm_without_stream', createSynth({ llm: {}, agentDefaultModel: {} }, {}) === null, 'llm 没有 stream → null');

  const llm = fakeLlm('x');
  const s = createSynth({ llm, agentDefaultModel: { currentSelection: () => null } }, {});
  ok('R9.no_model', (await s.synthesize('材料')) === null && llm.calls.length === 0,
    '选不到模型 → null，且没发起调用');

  const boom = fakeLlm('x', { throwOnStream: true });
  let errSeen = null;
  const s2 = createSynth(scopeWith(boom), {}, (m) => { errSeen = m; });
  let threw = null;
  let out;
  try { out = await s2.synthesize('材料'); } catch (e) { threw = e; }
  ok('R10.stream_error_returns_null', out === null && threw === null,
    `返回 ${out}，没抛（${threw ? '抛了: ' + threw.message : '安静'}）`);
  ok('R10b.error_reported', !!errSeen, `错误被报出来: ${String(errSeen).slice(0, 40)}`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n【三】★ 熔那条路真的通了（这条才是关键）');
{
  // 模型这次给出**合格判断**：谓词在闭集里、正文跟材料能对上、不抄原句
  const good = JSON.stringify({
    text: '他不是不累，是舍不得睡',
    why: '连着几回都是后半夜还在说话',
    relation: 'endures',
    subject: '他',
    polarity: 'favorable',
    weight: 0.6,
    stage: 'understood',
  });
  const llm = fakeLlm(good);
  const synth = createSynth(scopeWith(llm), {});
  const m = await createMind({ synth, name: '大乔' });

  const inputs = [
    '主人熬夜到后半夜才开始说话',
    '主人又是熬夜到后半夜',
    '主人熬夜到很晚还在跟我说话',
  ];
  for (const t of inputs) await m.ingest(t);

  ok('R11.synth_actually_called', llm.calls.length > 0,
    `喂 ${inputs.length} 条，模型被问 ${llm.calls.length} 次（0 次 = 熔的路是哑的）`);
  ok('R12.material_has_requirements', (llm.calls[0]?.messages?.[0]?.content?.[0]?.text ?? '').includes('要求'),
    '送进模型的是 forge 拼好的完整提示词（含「要求」段）');

  const snap = m.snapshot();
  ok('R13.judgment_landed', snap.size >= 1,
    `库 ${snap.size} 条` + (snap.size ? `：${String((snap.notes ?? [])[0]?.note ?? '').slice(0, 30)}` : '（一条都没有）'));

  // 负控制：模型只会说 NULL → 库必须还是空的（证明判断是熔出来的，不是凭空造的）
  const nullLlm = fakeLlm('NULL');
  const nullSynth = createSynth(scopeWith(nullLlm), {});
  const m2 = await createMind({ synth: nullSynth, name: '大乔' });
  for (const t of inputs) await m2.ingest(t);
  ok('R14.null_model_leaves_empty', m2.snapshot().size === 0 && nullLlm.calls.length > 0,
    `模型说 NULL 时库 ${m2.snapshot().size} 条（应为 0），但确实被问了 ${nullLlm.calls.length} 次`);
}

console.log('\n' + '═'.repeat(62));
console.log(fails === 0 ? `接线验收：PASS  ${passes} 项全过` : `接线验收：FAIL  ${fails} 项没过 / ${passes} 项过`);
console.log('═'.repeat(62));
process.exit(fails === 0 ? 0 : 1);
