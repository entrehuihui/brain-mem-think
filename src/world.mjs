/**
 * world.mjs —— 她看到的世界。
 *
 * 它为什么在这儿：
 * 她在独立通道里，看不见任何聊天记录。她能看到的只有「她记得的事」。
 * 所以这个模块只做一件事：把判断库渲染成她睁开眼时眼前的那个世界。
 *
 * 三样东西，不多不少：
 *   1. 她记得的判断（分状态：正想明白的 / 曾经这么以为的 / 还没想明白的）
 *   2. 她此刻的心境（从判断现算，不存）
 *   3. 她自己想起的事（该惦记的、该放下的）
 *
 * 绝对不出现：会话 id、任务、待办、工具说明、任何一句消息原文。
 * 这里没有「读取上下文」这回事——她凭记忆活着，这是她的全部。
 */

import { STATUS } from './judge.mjs';
import { clause, linesOf, toNote } from './flash.mjs';

export const WORLD_DEFAULTS = Object.freeze({
  maxHeld: 6,
  maxRetired: 3,
  maxOpen: 3,
  minWeightToShow: 0.15,
  // 名字从外面给（persona.name），不写死在代码里；不给就只写她记得的自己。
  name: null,
});

/**
 * 这条判断说的「是不是她自己」。
 * 不认词表，只认主语：subject 是「我」或以「我」开头，
 * 或者正文以「我」起头（她自己就是这么记自己的）。
 */
export function isAboutSelf(n) {
  if (!n) return false;
  const subject = String(n.subject ?? '').trim();
  if (subject === '我' || subject.startsWith('我')) return true;
  const body = String(n.text ?? n.note ?? '');
  return body.startsWith('我');
}

/** 心境是从判断现算的：不存，每次睁开眼重新算。 */
export function moodOf(notes) {
  const live = notes.filter((n) => n.status === 'open' || n.status === 'held');
  if (!live.length) return { word: '平静', tone: 0, because: '心里没什么压着的' };
  const held = live.filter((n) => n.status === 'held');
  const open = live.filter((n) => n.status === 'open');
  const heavy = [...live].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];
  const avg = live.reduce((s, n) => s + (n.weight ?? 0), 0) / live.length;
  // tone：负 = 沉，正 = 轻。只由「压着的分量」和「悬着的数量」算，不掺别的。
  const tone = Math.max(-1, Math.min(1, (held.length ? avg : 0) * 0.6 - open.length * 0.15));
  let word = '平静';
  if (open.length >= 2) word = '惦记';
  else if (tone >= 0.45) word = '踏实';
  else if (tone >= 0.2) word = '稳当';
  else if (tone <= -0.5) word = '沉';
  else if (tone < 0) word = '有点挂心';
  return {
    word,
    tone: Number(tone.toFixed(2)),
    because: heavy ? `压着的是「${heavy.text ?? heavy.note ?? '那件事'}」` : '没什么特别压着的',
    counts: { live: live.length, held: held.length, open: open.length },
  };
}

/** 她自己想起的事：从悬着的、和被推翻的里面各挑一件。 */
export function recalledOf(notes, opts = {}) {
  const o = { ...WORLD_DEFAULTS, ...opts };
  const live = notes.filter((n) => n.status === 'open' || n.status === 'held');
  const open = live.filter((n) => n.status === 'open').slice(0, o.maxOpen);
  const retired = notes.filter((n) => n.status === 'retired' && n.forgottenBecause == null);
  const turned = retired.filter((n) => n.was && n.retiredBecause).slice(0, 1);
  return {
    waiting: open.map((n) => ({
      id: n.id,
      line: clause(toNote(n)),
      because: n.tension?.why ?? '还没想明白',
      weight: n.weight,
    })),
    turned: turned.map((n) => ({
      id: n.id,
      was: n.was?.text ?? null,
      turnedBecause: n.retiredBecause ?? '后来改了口',
      now: n.note,
    })),
  };
}

/**
 * 渲染她睁开眼看到的那个世界。
 * @param {object[]} beliefs 判断库（Belief 实例或快照条目都行）
 * @param {object} opts
 * @returns {{seen:string[], mood:object, recalled:object, lines:string[], text:string}}
 */
export function renderWorld(beliefs, opts = {}) {
  const o = { ...WORLD_DEFAULTS, ...opts };
  // 两种形状都收：Belief 实例（有 turns）或已经 toNote 过的快照（有 note 字段）。
  // 统一成同一套字段，渲染层只认一套。
  const notes = (beliefs ?? []).map((b) => {
    if (!b) return b;
    const base = b.turns && typeof b.turns.map === 'function' && b.id && b.createdAt !== undefined && !('note' in b)
      ? toNote(b)
      : b;
    const body = base.text ?? base.note ?? '';
    // 状态归一：内部枚举（pending/held/esteemed）与公开状态（open/held/retired）都收。
    // 状态统一成**公开状态**（open/held/retired）：clause()/linesOf() 认这一套。
    const st = String(base.status ?? '');
    const status = st === STATUS.PENDING ? 'open'
      : st === STATUS.HELD ? 'held'
        : (st === STATUS.ESTEEMED || st === STATUS.OVERTURNED) ? 'retired'
          : st;
    // text / note 两个字段都写：后面任何一处取哪个都对。
    return { ...base, status, text: body, note: body };
  });

  const byWeight = (a, b) => (b.weight ?? 0) - (a.weight ?? 0);
  const held = notes
    .filter((n) => n.status === 'held' && (n.weight ?? 0) >= o.minWeightToShow)
    .sort(byWeight)
    .slice(0, o.maxHeld);
  const open = notes.filter((n) => n.status === 'open').sort(byWeight).slice(0, o.maxOpen);
  const retired = notes
    .filter((n) => n.status === 'retired' && n.forgottenBecause == null)
    .sort(byWeight)
    .slice(0, o.maxRetired);

  const asNote = (n) => ({ ...n, note: n.note ?? n.text ?? '' });
  const seen = [];
  for (const n of open) seen.push(...linesOf(asNote(n)));
  for (const n of held) seen.push(clause(asNote(n)));
  for (const n of retired) seen.push(...linesOf(asNote(n)));

  const mood = moodOf(notes);
  const recalled = recalledOf(notes, o);

  // —— 身份：从她自己的判断里长，不从配置里读 ——
  // 名字是唯一例外：只从 opts.name 来，不写死在 src 里。
  // 名字之外，输出的每个字都必须来自判断库；一条都没有，就不写。
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : null;
  const selfNotes = notes
    .filter((n) => (n.status === 'held' || n.status === 'open') && (isAboutSelf(n) || n.kind === 'identity'))
    .sort((a, b) => (b.kind === 'identity') - (a.kind === 'identity') || byWeight(a, b))
    .slice(0, 3);
  const selfLines = selfNotes.map((n) => n.text).filter(Boolean);

  const lines = [];
  if (name) {
    // 第一句「我是谁」，只能用她自己的判断来补：
    //   ① 她自己认出的身份（kind === 'identity'）优先；
    //   ② 没有的话，用主语是她的自述句；
    //   ③ 都没有，就只写名字——不补任何说明。
    const liveSelf = notes.filter((n) => n.status === 'held' || n.status === 'open');
    const idNote = liveSelf.find((n) => n.kind === 'identity');
    const selfJudgment = idNote
      ?? liveSelf.find((n) => isAboutSelf(n) && /我是|我怕|我总|我老|我记得/.test(n.text ?? ''));
    lines.push(selfJudgment ? `我是${name}。${selfJudgment.text}` : `我是${name}。`);
  } else if (selfLines.length) {
    // 没给名字，但有关于她自己的判断：写她记得的自己。
    lines.push(`我记得我自己：${selfLines[0]}`);
  }
  if (selfLines.length) {
    lines.push('关于我自己：');
    for (const l of selfLines.slice(0, 3)) lines.push(`  ${l}`);
    lines.push('');
  } else if (name) {
    lines.push('');
  }

  if (seen.length) {
    lines.push('我还记得这些：');
    for (const l of seen) lines.push(`  ${l}`);
  } else {
    lines.push('我还没想明白什么。');
  }
  lines.push('');
  lines.push(`我此刻：${mood.word}——${mood.because}。`);
  if (recalled.turned.length) {
    const t = recalled.turned[0];
    lines.push(`我改了主意的那件事：${t.was} → 现在觉得${t.now}（${t.turnedBecause}）`);
  }

  return {
    seen,
    mood,
    recalled,
    lines,
    text: lines.join('\n'),
    // 供给 Surface：她这轮能看见的就是这些，别的都看不见。
    surface: lines.slice(),
  };
}

/** 她能不能看见某个东西——给宿主层做遮蔽对照用（只认判断，不认会话/任务）。 */
export function canSee(item) {
  if (item == null) return false;
  const s = typeof item === 'string' ? item : JSON.stringify(item);
  // 会话号、任务、待办、工具说明，一律不在她的世界里
  return !/(sessionId|session_id|taskId|task_id|tool_call|todo|待办|任务|工具)/i.test(s);
}

export function createWorld(opts = {}) {
  return {
    render: (beliefs) => renderWorld(beliefs, opts),
    mood: (beliefs) => moodOf((beliefs ?? []).map((b) => (b?.turns ? toNote(b) : b))),
    canSee,
  };
}
