/**
 * t_collect_hook.mjs —— 小乔实测出来的三条「写完了没接上」，逐条打。
 *
 * ① 系统注入被当成主人说的话
 *      宿主把 AGENTS.md 标成 role:'user' + source.kind:'agent-instructions'，
 *      10960 字整份灌进火炉。注释写着「不是系统注入」，**代码里没有这条判据**。
 *
 * ② 取文本的形状错了
 *      `msgs.filter(isValidMessage).map(x => ({text: x.text}))`
 *      filter 留下的是宿主原始对象，只有 content 数组、没有 text 字段 →
 *      每条都是 undefined → 材料 0 字 → 永远 too_little。
 *
 * ③ 归档钩子只包不收
 *      每 disable/enable 一次就多叠一层，旧层闭包抓着已销毁实例。
 *      她数出来：29 次进钩子，21 次失败。真熔通之后同一次归档会熔 N 遍。
 */

import { checkMessage, ownerMessages } from '../plugin/collect.mjs';

let fails = 0;
let passes = 0;
const ok = (name, cond, detail) => {
  if (cond) { passes += 1; console.log(`  [PASS] ${name}  ${detail ?? ''}`); }
  else { fails += 1; console.log(`  [FAIL] ${name}  ${detail ?? ''}`); }
};

// ── 造宿主形状的消息（跟小乔实测抓到的一致）──
const hostUser = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
const hostSystem = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'agent-instructions' } });
const herReply = (text) => ({ role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } });

console.log('\n【一】系统注入不许当成主人的话');
{
  const sys = hostSystem('你是 DSH 的 agent。这是一份 10960 字的系统提示……');
  const r = checkMessage(sys);
  ok('T1.system_injection_rejected', r.ok === false, `why=${r.why}`);

  const mixed = [hostUser('主人真说的话'), sys, herReply('她自己的回话'), hostUser('主人又说一句')];
  const owners = ownerMessages(mixed);
  ok('T2.only_owner_left', owners.length === 2, `留下 ${owners.length} 条（应为 2）`);
  ok('T3.text_is_string', owners.every((o) => typeof o.text === 'string' && o.text.length > 0),
    `形状: ${JSON.stringify(owners.map((o) => typeof o.text))}`);
  ok('T4.no_system_text_leaked', !owners.some((o) => o.text.includes('10960')),
    '系统提示的正文没有漏进来');

  // 负控制：她自己的话必须被挡住（否则她会自己给自己造证据）
  ok('T5.her_reply_rejected', checkMessage(herReply('我记得……')).ok === false, '她的话不收');
}

console.log('\n【二】取文本：content 数组要能取出来，不能是 undefined');
{
  // 这是 BUG-② 的原始现场：role 对，但没有 text 字段
  const m = { role: 'user', content: [{ type: 'text', text: '主人凌晨还在改插件' }] };
  ok('T6.text_from_content', m.text === undefined && checkMessage(m).text === '主人凌晨还在改插件',
    '原始对象没有 .text，但 checkMessage 能从 content 里取出来');

  const multi = { role: 'user', content: [{ type: 'text', text: '前半句。' }, { type: 'text', text: '后半句。' }] };
  ok('T7.multi_part_joined', checkMessage(multi).text === '前半句。后半句。', checkMessage(multi).text);
}


console.log('\n【三】归档钩子必须能还原，不许叠层');
{
  const mod = await import('../plugin/index.mjs');

  /** 造一个假宿主：注入回调先收着，effect 的清理函数也收着。 */
  const makeCtx = () => {
    const disposers = [];
    const injected = [];
    return {
      disposers, injected,
      logger: { info: () => {}, debug: () => {}, warn: () => {} },
      get: () => undefined,
      inject(names, fn) { injected.push({ names, fn }); },
      effect(fn) {
        const d = typeof fn === 'function' ? fn() : null;
        if (typeof d === 'function') disposers.push(d);
        return () => {};
      },
      on: () => () => {},
    };
  };

  /** 装一次：只触发归档那块的注入，返回 {reg, orig}。 */
  const installOnce = async (reg) => {
    const ctx = makeCtx();
    mod.apply(ctx, { enabled: true, digestOnArchive: true, injectOnTurn: false, wake: false, name: '大乔' });
    const inj = ctx.injected.find((x) => x.names.includes('workspaceRegistry'));
    if (!inj) return { ctx, wrapped: false };
    await inj.fn({ workspaceRegistry: reg, sessions: { get: () => null } });
    return { ctx, wrapped: true };
  };

  const disposeAll = (ctx) => {
    for (const d of [...ctx.disposers].reverse()) {
      try { d(); } catch { /* 其它清理可能依赖别的东西，忽略 */ }
    }
  };

  // ① 装上去必须真的包一层
  {
    const orig = async function originalArchive() { return 'archived'; };
    const reg = { archiveSession: orig };
    const { ctx, wrapped } = await installOnce(reg);
    ok('T8.hook_wrapped', wrapped && reg.archiveSession !== orig,
      wrapped ? '被包了一层' : '注入块没找到');
    // ② 卸载必须还原
    disposeAll(ctx);
    ok('T9.hook_restored_on_dispose', reg.archiveSession === orig,
      reg.archiveSession === orig ? '已还原成原来的函数' : '还是包装，没还原');
  }

  // ③ 连装/卸两轮，不许叠层
  {
    const orig = async function originalArchive2() { return 'archived'; };
    const reg = { archiveSession: orig };
    for (let round = 0; round < 2; round += 1) {
      const { ctx } = await installOnce(reg);
      disposeAll(ctx);
    }
    ok('T10.no_stacking', reg.archiveSession === orig,
      reg.archiveSession === orig ? '两轮之后仍是原始函数' : '叠层了');
  }

  // ④ 负控制：不还原会怎样 —— 证明 T9/T10 有牙
  {
    const orig = async function originalArchive3() { return 'archived'; };
    const reg = { archiveSession: orig };
    await installOnce(reg);           // 装但**不卸**
    ok('T11.negative_control', reg.archiveSession !== orig,
      '（负控制）不卸时确实不等，说明 T9/T10 能咬住');
  }
}

console.log('\n' + '═'.repeat(62));
console.log(fails === 0 ? `采集与钩子验收：PASS  ${passes} 项全过` : `采集与钩子验收：FAIL  ${fails} 项没过 / ${passes} 项过`);
console.log('═'.repeat(62));
process.exit(fails === 0 ? 0 : 1);
