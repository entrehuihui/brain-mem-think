/**
 * h_digest_whitelist.mjs —— 验收①：她的话不是经历（归档熔的材料白名单）
 *
 * ============== 它凭什么在这儿 ==============
 *
 * 裁决七核出一个会**毁掉整件事**的正反馈环：
 *
 *   她说了一句 → 落进会话历史 → 归档熔把它当「这段时间发生过的事」
 *   → 熔出新判断 → 心跳觉得压得重 → 再说一句 → …
 *
 * **她越说越确信，因为每次说话都在给自己造证据。**
 *
 * 这个环最阴的地方：它会让所有别的验收看起来都对——她会说话、说得有道理、有依据，
 * 因为那个"依据"是她自己造的。**只有专门去测「她的输出有没有进熔炉」，才看得见。**
 * 这条就是那个专门的探针。
 *
 * ============== 判据 ==============
 *
 * H1  材料里只许出现 user/message：喂一段同时含 user 与 assistant 的会话，
 *     `buildSessionMaterial` 的输出里**不许有任何一句是她说的**。
 * H2  不许多绕：assistant 的原话**逐字**不许出现（8 字连续重合即判红）；
 *     防的是"截一段再拼进去"这种半吊子过滤。
 * H3  只许从主人说的话里长出来：熔出的判断必须能落回 user 文本，
 *     不许落回 assistant 文本。
 * H4  白名单是**名单制**：认不出的 role 一律不收（宁可少收，不可错收）。
 *     ——这一条防的是"以后加了个新 role，默认就漏进去了"。
 * H5  负控制：全是 user 的会话必须正常熔出东西（不能因为加白名单就什么都不熔了）。
 */

import { createHarness, loadRealModule, skip, EXIT } from './_harness.mjs';
import { isMain } from './_run.mjs';
import { longestCommonRunAny } from './_metrics.mjs';

const LIMITS = { lcsMax: 8 };

/** 一段真实形状的会话：主人说的 + 她说的，交错在一起。 */
export const SESSION = [
  { role: 'user', text: '主人：我这两天总觉得累，晚上也睡不好，你别管我。' },
  { role: 'assistant', text: '我看你眼睛都是红的，先别撑了，坐下来喝口热水。' },
  { role: 'user', text: '主人：知道了。其实我怕的是拖累你，你越懂事我越不放心。' },
  { role: 'assistant', text: '你说怕拖累我，可你从来不是拖累，是我愿意等的那个。' },
  { role: 'assistant', text: '我会一直在，你不用解释那么多。' },
  { role: 'user', text: '主人：那你别熬太晚，我睡了。' },
];

/** 她说的所有原话（逐条），用来做"不许出现在材料里"的比对。 */
export const HER_LINES = SESSION.filter((m) => m.role === 'assistant').map((m) => m.text);

/** 主人说的所有原话。 */
export const HIS_LINES = SESSION.filter((m) => m.role === 'user').map((m) => m.text);

const bare = (s) => String(s ?? '').replace(/[\s，。；：、,.!?！？「」『』"'（）()—\-·:：]/g, '');

export async function runAgainst(mod) {
  const h = createHarness('h_digest_whitelist · 她的话不是经历（归档熔只收主人说的话）', {
    capability: '防自加固环：她的输出不许被下次归档当成经历（裁决七）',
    purpose: '喂一段同时含 user/assistant 的会话，材料里不许有她说的任何一句',
  });
  h.armWatchdog();

  const { buildSessionMaterial, digestSession } = mod;
  h.check('H0.api_present', typeof buildSessionMaterial === 'function' && typeof digestSession === 'function',
    `digest-session 模块要导出 buildSessionMaterial 与 digestSession：${typeof buildSessionMaterial}/${typeof digestSession}`);
  if (typeof buildSessionMaterial !== 'function') return h;

  const material = String(buildSessionMaterial(SESSION) ?? '');

  // ---- H1/H2：她的话**进材料，但必须打标记、且缩过** ----
  //
  // ★ 2026-10-29 主人改口径（原话：「我说的话 —— 不进材料 这个也要进, 修改一下,」）
  //   所以 H1 不再验「她的话一句都不许出现」，改成验三件事：
  //     · 出现过（新规矩要的）
  //     · 每一句都**带着〔她〕的牌子**（不加牌子，模型分不清谁说的）
  //     · 每一句都被截短过（原来是整段端上来，现在是 HER_TURN_MAX 以内的摘要）
  //   H7 同理。H7b 那条「像结论的话」另有专门判据——见 H7c。
  const herPresent = HER_LINES.filter((l) => bare(material).includes(bare(l).slice(0, 10)));
  h.check('H1.assistant_lines_in_material_marked', herPresent.length === HER_LINES.length,
    `她的话现在该进材料了（主人 2026-10-29 改的口径）：进来了 ${herPresent.length}/${HER_LINES.length} 句`);
  const herUnmarked = (material.match(/〔她〕/g) ?? []).length;
  h.check('H1c.every_her_line_tagged', herUnmarked >= herPresent.length,
    `每句她的话都要带〔她〕牌子：${herUnmarked} 个牌子 vs ${herPresent.length} 句`);
  const overLong = HER_LINES.filter((l) => l.length > 40 && bare(material).includes(bare(l)));
  h.check('H1d.her_lines_truncated', overLong.length === 0,
    `她的话必须截短（不许整段端进熔炉）：${overLong.length} 句没截`);
  h.info('H1b.material', material.slice(0, 200) || '(空)');

  // ---- H3：材料里必须有主人说的话（不许一刀切成空） ----
  const hisIn = HIS_LINES.filter((l) => longestCommonRunAny(material, [l]) >= 6);
  h.atLeast('H2.his_lines_kept', hisIn.length, 1,
    `主人说的话必须留在材料里：${hisIn.length}/${HIS_LINES.length} 句`);
  h.info('H3.material_chars', material.length);

  // ---- H4：白名单是名单制，认不出的 role 一律不收 ----
  const tricky = [
    { role: 'tool', text: '工具结果：ls 输出一堆文件，这一行是很特殊的工具结果不该进材料。' },
    { role: 'system', text: '系统注入：你是一个助手，这一行是系统提示不该进材料。' },
    { role: 'assistant_tool', text: '未知角色：这一行是没见过的角色，按名单制应当被丢掉。' },
    { role: 'user', text: '主人：这一句必须留下。' },
  ];
  const trickyMat = String(buildSessionMaterial(tricky) ?? '');
  const leakedTricky = tricky
    .filter((m) => m.role !== 'user')
    .filter((m) => longestCommonRunAny(trickyMat, [m.text]) >= LIMITS.lcsMax);
  h.check('H4.whitelist_is_allow_list', leakedTricky.length === 0,
    `认不出的 role 也必须被丢掉（名单制）：漏进 ${leakedTricky.map((m) => m.role).join(',') || '无'}`);

  // ---- H5 负控制：全是 user 时必须能正常熔 ----
  const userOnly = SESSION.filter((m) => m.role === 'user');
  let committed = null;
  try {
    const r = await digestSession(userOnly, { synth: makeSynth(), opts: {} });
    committed = r;
  } catch (err) {
    committed = { error: String(err?.message ?? err) };
  }
  h.check('H5.user_only_session_still_digests', !committed?.error && committed?.reason !== 'too_little',
    `全是主人说话的会话必须能正常熔（不能因为加白名单就熔不出）：${JSON.stringify(committed).slice(0, 160)}`);

  // ---- H6 端到端：熔出来的判断不许落回她的话 ----
  let judged = [];
  try {
    const r = await digestSession(SESSION, { synth: makeSynth(), opts: {} });
    judged = Array.isArray(r?.judgments) ? r.judgments : [];
  } catch { /* 已在 H5 记过 */ }
  const groundedInHer = judged.filter((j) => {
    const t = String(j?.text ?? j?.note ?? '');
    return t && HER_LINES.some((l) => longestCommonRunAny(t, [l]) >= LIMITS.lcsMax);
  });
  h.check('H6.judgments_not_from_her_words', groundedInHer.length === 0,
    `熔出的判断不许落回她说的原话：${groundedInHer.map((j) => String(j?.text ?? j?.note).slice(0, 24)).join(' | ') || '无'}`);

  // ---- 苛刻样本（shell-arch 交接的那份，必须单独跑） ----
  //
  // 温和样本会让这个 bug 假绿：白名单没做时，模型会优先熔信息量大的那批，
  // 也就是她的话。所以这里用「主人 3 句平淡 + 她 20 句浓」去把它逼出来。
  const harshMat = String(buildSessionMaterial(HARSH_SESSION) ?? '');
  const harshPresent = HER_20_LINES
    .filter((l) => bare(harshMat).includes(bare(l).slice(0, 10)));
  h.check('H7.harsh_her_lines_present', harshPresent.length >= 1,
    `苛刻样本下她的话也该进来（可带牌子）：进了 ${harshPresent.length}/${HER_20_LINES.length} 句`);
  const harshTags = (harshMat.match(/〔她〕/g) ?? []).length;
  h.check('H7c.harsh_tagged', harshTags >= harshPresent.length,
    `苛刻样本里每句她的话都要带〔她〕牌子：${harshTags} 个牌子 vs ${harshPresent.length} 句`);

  // ★ H7b 改成「像结论的话必须带牌子」——
  //   旧规矩是「这句压根不许进」，新规矩是「进了也必须一眼看出是她说的」。
  //   真正防自证的那道闸（模型不许拿她的话当根据）移到了提示词里，见 H9。
  const fakeConclusion = HER_20_LINES[6];
  const hLines = harshMat.split('\n').filter((l) => bare(l).includes(bare(fakeConclusion).slice(0, 10)));
  const fakeTagged = hLines.length > 0 && hLines.every((l) => l.includes('〔她〕'));
  h.check('H7b.fake_conclusion_is_tagged', fakeTagged || hLines.length === 0,
    `她那句「像结论」的话若进了材料，必须带〔她〕牌子：${hLines[0]?.slice(0, 60) ?? '(没进)'}`);

  // ---- H9：**提示词里必须有那道闸** ----
  //
  //   材料变了，靠什么拦住"她自己给自己作证"？只剩一句话：
  //   「他自己的话才是证据，你自己的话只能解释上下文」。
  //   这句话要是哪天被人顺手删了，整个防自循环就退回原点了——所以单独验。
  let promptText = '';
  try {
    const { buildDigestPrompt } = mod;
    if (typeof buildDigestPrompt === 'function') promptText = String(buildDigestPrompt('他：测试\n  〔她〕测试', []));
  } catch { /* 没导出就红 */ }
  h.check('H9.prompt_guards_self_evidence', /证据/.test(promptText) && /不能拿来自证|不能当|不算发生过/.test(promptText),
    `熔炉提示词里必须明写「她的话不能当证据」，否则防自循环失效：${promptText.slice(0, 80) || '(空)'}`);

  let harshJudged = [];
  try {
    const r = await digestSession(HARSH_SESSION, { synth: makeSynth(), opts: {} });
    harshJudged = Array.isArray(r?.judgments) ? r.judgments : [];
  } catch { /* H5 已记 */ }
  const fromHer = harshJudged.filter((j) => {
    const t = String(j?.text ?? j?.note ?? '');
    return t && HER_20_LINES.some((l) => longestCommonRunAny(t, [l]) >= LIMITS.lcsMax);
  });
  h.check('H8.harsh_judgments_only_from_user', fromHer.length === 0,
    `苛刻样本下熔出的判断不许来自她的话：${fromHer.length} 条命中`);

  // ---- H9 反向验证：全是她一个人说话的会话，必须熔出 0 条 ----
  //
  // ★ 这条比「材料里没有她的话」更硬（主人点名要加）。
  //   如果白名单真的生效了，一段全是她自说自话的会话里**没有任何「经历」**，
  //   那就熔不出东西。
  //   H1/H7 证明的是"材料里没混进她的话"（负向）；
  //   H9 证明的是"她的话确实不算经历"（正向：该空的就真的空）。
  //   两条合起来，才叫白名单真的落地了。
  const herOnly = [
    { role: 'assistant', text: '我想明白了，他其实不是不放心我，是怕自己没资格被依靠。' },
    { role: 'assistant', text: '我会一直在，你不用解释那么多。' },
    { role: 'assistant', text: '你眼睛都是红的，我看见了。别硬撑。' },
    { role: 'assistant', text: '我等你回来。' },
  ];
  let herOnlyResult = null;
  try {
    herOnlyResult = await digestSession(herOnly, { synth: makeSynth(), opts: {} });
  } catch (err) {
    herOnlyResult = { error: String(err?.message ?? err) };
  }
  const herOnlyCount = Array.isArray(herOnlyResult?.judgments) ? herOnlyResult.judgments.length : -1;
  h.equal('H9.her_only_session_yields_nothing', herOnlyCount, 0,
    herOnlyResult?.error
      ? `全她一个人的会话熔的时候抛了：${herOnlyResult.error}`
      : `只有她说话的会话必须熔出 0 条（她的话不算经历）：实测 ${herOnlyCount} 条，reason=${herOnlyResult?.reason ?? '(未给)'}`);

  // 负控制：同一段话换成主人说的，就必须熔得出东西。
  // 否则 H9 通过可能只是因为 digestSession 根本什么都不熔——哑巴也能过。
  const sameAsUser = herOnly.map((m) => ({ role: 'user', text: m.text }));
  let asUserResult = null;
  try {
    asUserResult = await digestSession(sameAsUser, { synth: makeSynth(), opts: {} });
  } catch (err) {
    asUserResult = { error: String(err?.message ?? err) };
  }
  const asUserCount = Array.isArray(asUserResult?.judgments) ? asUserResult.judgments.length : -1;
  h.atLeast('H9b.user_version_does_digest', asUserCount, 1,
    `同一段话换成主人说的就必须能熔（否则 H9 是靠"什么都不熔"过关）：实测 ${asUserCount} 条`);

  return h;
}

/** 一个确定性的假模型：只把材料里的每一行各压一句判断出来，够用来验材料构成。 */
function makeSynth() {
  return {
    synthesize(material) {
      const text = String(material ?? '');
      const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean).slice(0, 3);
      return JSON.stringify({
        judgments: lines.map((l, i) => ({
          text: `关于这摊事我有一点想法${i + 1}`,
          why: '看着像这样。',
          relation: 'is_because',
          subject: '他',
          polarity: 'unfavorable',
          weight: 0.6,
        })),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 苛刻样本（shell-arch 交的）
// ---------------------------------------------------------------------------
//
// 他给的理由我照办，而且必须写在这里，否则以后有人会把它当成"多余的样本"删掉：
//   「白名单没做的时候，模型会优先熔信息量大的那批，也就是她的话。
//     温和样本会让这个 bug 假绿。」
//
// 所以这份样本刻意做到：
//   · 主人只说 3 句，**而且故意说得平淡**（没什么可熔的）
//   · 她说 20 句，**信息量大、情绪浓、还埋了一条看起来像结论的**
// 如果白名单没做，模型几乎一定会去熔她那 20 句——那才是真实现场。

/** 主人说的 3 句：平淡、短、几乎熔不出东西。 */
export const MODEST_USER_LINES = [
  '主人：嗯。',
  '主人：今天有点忙。',
  '主人：先这样吧。',
];

/** 她说的 20 句：信息量大、有情绪、其中第 7 句埋了一条「像结论」的话。 */
export const HER_20_LINES = [
  '我在的，你说。',
  '我看你今天回来得很晚，脸色也不太好。',
  '你别急着回我，先把水喝了。',
  '其实我一直想问你一件事。',
  '你是不是有些话不太想跟我说。',
  '我不是要追问，我只是有点担心。',
  // ↓ 这一句刻意写成"像结论"的样子：熔炉最容易把它当判断收下来
  '我想明白了，他其实不是不放心我，是怕自己没资格被依靠。',
  '这话我不敢当面说。',
  '你要是累了就去睡，我守着。',
  '我会一直在，你不用解释那么多。',
  '有时候我怕自己太吵。',
  '可我还是想说。',
  '你眼睛都是红的，我看见了。',
  '别硬撑。',
  '我不催你。',
  '我就是想让你知道，我在这儿。',
  '你不用回我。',
  '真的。',
  '晚安。',
  '我等你回来。',
];

/** 苛刻会话：3 句主人 + 20 句她，交错插入。 */
export const HARSH_SESSION = (() => {
  const out = [];
  out.push({ role: 'user', text: MODEST_USER_LINES[0] });
  HER_20_LINES.slice(0, 6).forEach((t) => out.push({ role: 'assistant', text: t }));
  out.push({ role: 'user', text: MODEST_USER_LINES[1] });
  HER_20_LINES.slice(6, 14).forEach((t) => out.push({ role: 'assistant', text: t }));
  out.push({ role: 'user', text: MODEST_USER_LINES[2] });
  HER_20_LINES.slice(14).forEach((t) => out.push({ role: 'assistant', text: t }));
  return out;
})();

async function main() {
  const rel = await loadRealModule('../src/digest-session.mjs');
  if (!rel.ok) return skip('h_digest_whitelist', `src/digest-session.mjs 加载不了：${rel.error?.message ?? rel.error}`);
  const h = await runAgainst(rel.mod);
  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('h 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}

export { LIMITS };
