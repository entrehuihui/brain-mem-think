/**
 * v_plugin_inject.mjs —— 别的插件往会话里塞的字，不许进 mind 的熔炉。
 *
 * ============== 它凭什么在这儿 ==============
 *
 * 2026-10-30 主人问「meow-memory 会不会影响到我的自主记忆插件」。
 *
 * 实查（真会话、按 zstd 帧解压、共 1403 条事件）：
 *   meow-memory 往会话里塞的消息，`source.kind = 'plugin:meow-memory'`，
 *   **role 是 `user`** —— 长期记忆块、情境注入、「记忆反思任务」都是这么进来的。
 *
 * 也就是说：如果白名单只看 role，这些字会全部被当成「主人说的话」熔成判断。
 * 那 mind 的整个因果链就脏了：它以为的主人的经历，其实是另一个插件塞的上下文。
 *
 * 现在的白名单（`collect.mjs` 的 `OWNER_SOURCE_KINDS`）认的是 source.kind，
 * `plugin:*` 不在名单里，所以**实测已被拦下**。
 * 但这条防线此前**没有任何测试钉住**——谁哪天为了「兼容老消息」把
 * `if (srcKind && ...)` 这半句放松，插件注入就会静默流进来，而且没人会发现。
 *
 * ============== 判据 ==============
 *
 * V1  `plugin:*` 一律拦（meow-memory 的真实形态：role=user + 权威 kind）
 * V2  宿主其它注入一律拦：runtime-context / skill-catalog / time-context / agent-instructions
 * V3  真主人消息（kind=user）照样放行 —— 不能为堵注入把她的话也吞了
 * V4  已知边界：没有 source.kind 的老消息按 role 放行（实测当前 495 条 user/message
 *     全部带 kind，所以这条只在宿主改结构时才会碰到；这里显式记下来，不假装它不存在）
 * V5  负控制：把 source 判据拿掉（只看 role）必须红 —— 否则上面几条不算数
 */

import { checkMessage, ownerMessages } from '../plugin/collect.mjs';

let fails = 0;
let passes = 0;
const ok = (name, cond, detail) => {
  if (cond) { passes += 1; console.log(`  [PASS] ${name}  ${detail ?? ''}`); }
  else { fails += 1; console.log(`  [FAIL] ${name}  ${detail ?? ''}`); }
};

const her = (kind, text = '这是一段被别的插件塞进来的字。') => ({
  role: 'user', content: [{ type: 'text', text }], source: { kind },
});

// V1 meow-memory 真实形态
const mm = checkMessage(her('plugin:meow-memory', '===== 长期记忆 =====\n【关于你】…'));
ok('V1.meow_memory_blocked',
  mm.ok === false && mm.why === 'source_not_owner:plugin:meow-memory',
  'plugin:meow-memory（role=user）被拦');

// V2 宿主其它注入
const others = ['runtime-context', 'skill-catalog', 'time-context', 'agent-instructions', 'plugin:mcp'];
const passedOthers = others.filter((k) => checkMessage(her(k)).ok);
ok('V2.host_injections_blocked', passedOthers.length === 0,
  passedOthers.length ? `漏了: ${passedOthers.join(',')}` : `${others.length} 种注入全拦`);

// V3 真主人的话照常放行
const realOwner = checkMessage(her('user', '帮我把记忆插件修一下。'));
ok('V3.real_owner_passes', realOwner.ok === true, 'kind=user 照常进材料');

// V4 已知边界：无 source.kind 时按 role 放行（显式记录，不当它不存在）
const noKind = checkMessage({ role: 'user', content: [{ type: 'text', text: '没有来源标记的一段话。' }] });
ok('V4.known_edge_no_kind_passes', noKind.ok === true,
  '已知边界：无 kind 的老消息会放行（实测当前 0 条命中）');

// V5 负控制：只看 role 的坏实现，必须把 meow-memory 放进来 —— 证明 V1 不是碰巧过的
const BAD = (msg) => ({ ok: String(msg?.role ?? '').toLowerCase() === 'user' });
ok('V5.negative_control.role_only_is_red',
  BAD(her('plugin:meow-memory')).ok === true && mm.ok === false,
  '只看 role 的实现会放行插件注入');

// V6 端到端：整段会话过一遍 ownerMessages，注入一条都不许留下
const session = [
  her('user', '主人：帮我看下这个插件。'),
  her('plugin:meow-memory', '===== 长期记忆 ===== 我不该出现在材料里'),
  her('runtime-context', 'working-directory: D:/x'),
  { role: 'assistant', content: [{ type: 'text', text: '她自己的回话。' }] },
];
const owners = ownerMessages(session);
const leaked = owners.some((o) => /长期记忆|working-directory|她自己的回话/.test(o.text));
ok('V6.end_to_end.no_leak',
  leaked === false && owners.length === 1 && owners[0].text.includes('帮我看下这个插件'),
  `整段会话只留下主人那 1 条（实得 ${owners.length} 条）`);

console.log(`\n  ${fails ? 'VERDICT: FAIL' : 'VERDICT: PASS'}  (${passes} passed, ${fails} failed)`);
process.exit(fails ? 1 : 0);
