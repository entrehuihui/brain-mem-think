/**
 * tests/smoke_fake_synth.mjs —— 先证明「假模型自己会说话」，再去跑验收。
 *
 * 为什么这条单列：我重写 thinker 之后漏了一行 `const n = materialSize(...)`，
 * 结果**所有**验收都变成 `threw`——判据没错、内核没错，是陪考的那位哑了。
 * 以后每次动 _fake_synth，先跑这一条。
 */
import { createHarness, EXIT } from '../acceptance/_harness.mjs';
import { isMain } from '../acceptance/_run.mjs';
import { fakeSynth, makeExperience, TOPICS, SAME_EVENT_WORDINGS } from '../acceptance/_fake_synth.mjs';

async function main() {
  const h = createHarness('smoke · 假模型自己会不会说话', {
    purpose: '假模型哑了会让整套验收变成假绿或全 threw，所以先单独验它',
  });
  h.armWatchdog();

  const s = fakeSynth({ brain: 'thinker' });
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    const e = makeExperience('t_deploy', i);
    const r = s.synthesize({ material: e.text });
    seen.push(r);
  }
  h.check('fake.returns_objects', seen.every((r) => r && typeof r.note === 'string' && r.note.length > 6),
    `每一轮都要给出一句话：${seen.map((r) => (r ? r.stance : 'null')).join(',')}`);

  const stances = seen.map((r) => r?.stance);
  h.equal('fake.first_is_open', stances[0], 'open', '第 1 条该是悬而未决');
  h.check('fake.second_is_held', stances[1] === 'pos',
    `★ 主人点名的那条：第 2 条起必须敢下结论（不是永远 open）。实际=${stances[1]}`);
  h.check('fake.later_still_held', stances[2] === 'pos' && stances[3] === 'pos',
    `后续也必须 held：${stances.join(',')}`);

  // 不许抄原句：判断正文里不能出现输入的连续片段
  const { longestCommonRunAny } = await import('../acceptance/_metrics.mjs');
  const worst = Math.max(...seen.map((r, i) => (r ? longestCommonRunAny(r.note, [makeExperience('t_deploy', i).text]) : 99)));
  h.atMost('fake.does_not_copy_source', worst, 8, `判断正文与输入原句最长连续重合 ${worst} 字`);

  // 会给反证
  const counter = s.synthesize({ material: `KX9-素罗 ${TOPICS.t_deploy.topic}。这回我看清了：${TOPICS.t_deploy.neg}。` });
  h.equal('fake.can_flip', counter?.stance, 'neg', '见到自己的反证时立场必须转向');

  // 陌生说法也认
  const unknownHit = SAME_EVENT_WORDINGS.filter((w) => {
    const t = s.synthesize({ material: `${w.text}。` });
    return t && t.topicId;
  });
  h.atLeast('fake.recognizes_unknown_wording', unknownHit.length, 4,
    `5 种说法里认出 ${unknownHit.length} 种（词表外的最少要认 4 种，否则验收测的是词表不是意思）`);

  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('smoke_fake_synth 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}
