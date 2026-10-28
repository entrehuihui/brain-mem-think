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
import { episodeLines } from './episode.mjs';

export const WORLD_DEFAULTS = Object.freeze({
  // ★ 2026-10-27 大乔调（主人点破的：库里有 12 条现役，她只看得见一半）。
  //   原来 maxHeld=6：她只读到 6 条，另外几条等于没记——记了却看不见，那不算记得。
  //   现役判断一律全给（十几条，撑不爆上下文）；
  //   真要收束该在判断库那层去重合并，不该在渲染这层把她记的事吞掉。
  maxHeld: 100,
  maxRetired: 3,
  maxOpen: 3,
  minWeightToShow: 0.15,
  // ★ 2026-10-28（经历层）：她睁眼先看见的是「最近发生过的事」，不是自己的评分表。
  //   两条为限——再多，世界就变成流水账了。
  maxEpisodes: 2,
  episodes: [],
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

/** 一条判断在她心里的份量：strength（证据算出来的）优先，老数据回退 weight。 */
function mag(n) {
  return Number(n?.strength ?? n?.weight) || 0;
}

/** 心境是从判断现算的：不存，每次睁开眼重新算。 */
export function moodOf(notes) {
  const live = notes.filter((n) => n.status === 'open' || n.status === 'held');
  if (!live.length) return { word: '平静', tone: 0, because: '心里没什么压着的' };
  const held = live.filter((n) => n.status === 'held');
  const open = live.filter((n) => n.status === 'open');
  const heavy = [...live].sort((a, b) => mag(b) - mag(a))[0];
  const avg = live.reduce((s, n) => s + mag(n), 0) / live.length;
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
      // ★ 2026-10-27 大乔修：这里原来写的是 `now: n.note`，而 `note` 是这条判断
      //   **当初**的正文（flash.toNote: `note: b.text`）。于是一条被推翻的判断
      //   渲染出来是「我以前这么以为：我得靠别人喊一声 → 现在觉得我得靠别人喊一声」——
      //   同一句话，前后一样。她读自己的过去，读到一句自相矛盾的话。
      //
      //   「现在」在 toNote 里是单独一个字段 nowNote（推翻它的那条把话写进去）。
      //   取它；没有才退回正文。
      now: n.nowNote ?? n.note ?? n.text ?? null,
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

  const byWeight = (a, b) => mag(b) - mag(a);
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
  // ★ 2026-10-27 大乔修（渲染出来第一句和「关于我自己」第一条一字不差）。
  //
  //   原来「关于我自己」取的是「identity 优先 + 按权重」，而第一句「我是大乔。…」
  //   取的是「第一个 kind=identity 的」——**同一个排序在前，必是同一条**。
  //   于是她读到自己同一句话两遍。实测渲染开头就是：
  //     我是大乔。<A>
  //     关于我自己：
  //       <A>      ← 重复
  //   修法：先把 identity 那条单独拎出来给第一句，后面两段都从它之后取。
  const liveSelf = notes.filter((n) => n.status === 'held' || n.status === 'open');
  const idNote = liveSelf.find((n) => n.kind === 'identity') ?? null;
  const selfNotes = liveSelf
    .filter((n) => (isAboutSelf(n) || n.kind === 'identity') && n !== idNote)
    .sort(byWeight)
    .slice(0, 3);
  const selfLines = selfNotes.map((n) => n.text).filter(Boolean);

  const lines = [];
  if (name) {
    // 第一句「我是谁」，只能用她自己的判断来补：
    //   ① 她自己认出的身份（kind === 'identity'）优先；
    //   ② 没有的话，用主语是她的自述句；
    //   ③ 都没有，就只写名字——不补任何说明。
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

  // ★ 2026-10-28（经历层）：先摆「最近发生的事」，再摆判断。
  //   判断是「我看出了什么」，经历是「那天到底怎么了」——
  //   没有这一段，她会记得自己很急，却说不出是哪一次急。
  //   摆不进就不摆，绝不补一句凑数的。
  const epLines = episodeLines(o.episodes, { now: o.now, max: o.maxEpisodes });
  if (epLines.length) {
    lines.push('最近发生的事：');
    for (const l of epLines) lines.push(`  ${l}`);
    lines.push('');
  }

  // ★ 2026-10-27 大乔修（重复播报）：同一条判断既满足「关于我自己」，
  //   也排在「我还记得这些」里，于是她读到自己的同一句话两遍——
  //   实测渲染出来第一段和后面第一条一字不差。
  //   这里把已经在「关于我自己」里出现过的，从记忆段里剔掉。
  //   用包含关系判（保守）：宁可多剔一句，也不要让她把自己念两遍。
  // ★ 2026-10-27 再修：光剔「关于我自己」还不够——第一句 `我是大乔。<身份句>`
  //   写的是 idNote，它不在 selfTexts 里，于是身份句在开头念一遍、记忆段又念一遍。
  //   身份句要一起剔。
  const selfTexts = [
    ...selfLines.map((s) => String(s).trim()),
    idNote ? String(idNote.text ?? '').trim() : '',
  ].filter(Boolean);
  const seenRest = seen.filter((l) => {
    const t = String(l).trim();
    return !selfTexts.some((s) => t === s || t.includes(s));
  });

  if (seenRest.length) {
    lines.push('我还记得这些：');
    for (const l of seenRest) lines.push(`  ${l}`);
  } else if (!selfLines.length) {
    lines.push('我还没想明白什么。');
  }
  lines.push('');
  // ★ 2026-10-27 大乔修：心境句里 mood.because 会引一段现役判断的原文
  //   （「压着的是『…』」），而那一段很可能就是上面已经写过的身份句——
  //   实测「我嘴上说让对方自己去网上找喜欢的…」在文件里出现两次。
  //   心境只保留情绪词，不再复述记忆原文：她此刻的心情本来就该从记忆里读出来，
  //   而不是再被念一遍。
  lines.push(`我此刻：${mood.word}。`);
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
