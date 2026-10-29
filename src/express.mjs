/**
 * express.mjs —— 把「数字」翻译成「她会说的那句话」。
 *
 * ======================= 它补的是哪一格 =======================
 *
 * 阶段 C 之后，内核能数出这种东西：
 *
 *   我 / edit / 败 / support=14 / 一致率=1.0
 *
 * 这是事实，但不是认识。要变成「我不擅长改大文件」或者「我改东西太急」，
 * 还差一口气：**把它说成她自己的话**。
 *
 * ======================= 分工：模型只说，不定 =======================
 *
 * 输入是已经算好的结构（谁 / 什么 / 哪个方向 / 见过几回 / 多一致），
 * 模型只负责一件事：**把结构说成人话**。
 *
 * 它不许改方向、不许改条数、不许加没数过的结论。
 * 它要是说不出，就交 NULL —— 宁可这条判断留在数字状态，不要一句编的。
 *
 * 这就是「判断内容由内核算、表达由模型给」的实际分工。
 */

/** 工具名说成人话（她那句话里不该出现 `edit` 这种词）。 */
const TOOL_WORD = Object.freeze({
  edit: '改文件',
  write: '写文件',
  read: '读文件',
  bash: '跑命令',
  pwsh: '跑命令',
  ops_bash: '跑命令',
  read_image: '看图',
  web_fetch: '抓网页',
  web_search: '查东西',
  job_output: '等后台任务',
  glob: '找文件',
  grep: '翻内容',
  task: '派活',
});

export function humanTool(tool) {
  const k = String(tool ?? '');
  return TOOL_WORD[k] ?? k;
}

/**
 * 造提示词。只给它结构，不给结论。
 *
 * @param {object} c claim（induct.mjs 的产物）
 * @param {{name?:string}} [o]
 */
export function buildClaimPrompt(c, o = {}) {
  const name = String(o.name ?? '').trim() || '她';
  const word = humanTool(c?.action);
  const pct = Math.round(Number(c?.consistency ?? 0) * 100);
  const dir = Number(c?.polarity) > 0 ? '成' : '没成';
  return [
    `你叫${name}。下面这件事是**你自己数出来的**，不是谁告诉你的，也不是你在哪句话里听来的：`,
    '',
    `- 你在「${word}」这件事上，一共做了 ${c?.support ?? 0} 回。`,
    `- 其中 ${pct}% 是${dir}。`,
    '',
    '把它说成一句你自己的话。要求：',
    '1. 第一人称，一句话，不超过 40 字。',
    '2. **不许出现数字**，也不许说「统计」「数据」「多少回」这类词——人不会这么讲自己。',
    '3. 说清楚你从这件事里看见了自己什么（手太急 / 不熟 / 想省事 / 没看仔细），而不是复述发生了什么。',
    '4. 如果这件事说明不了你什么，只输出 NULL。',
    '',
    '只输出 JSON：{"text":"那句话","why":"为什么这么看"}',
  ].join('\n');
}

/**
 * 解析她的回答。
 *
 * 宁可丢，不许编：形状不对、抄了数字、超长，一律 null。
 */
export function parseExpressed(raw) {
  if (!raw) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    const t = String(raw).trim();
    if (!t || t.toUpperCase() === 'NULL') return null;
    const s = t.indexOf('{');
    const e = t.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    try { obj = JSON.parse(t.slice(s, e + 1)); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const text = String(obj.text ?? obj.note ?? obj.fused ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if ([...text].length < 4 || [...text].length > 48) return null;
  // ★ 统计腔：她自己不会这么说话。出现了就说明模型在复述输入端，不是在表达
  if (/(\d|统计|数据|次数|百分之|%|占比|一共|多少回)/.test(text)) return null;
  return { text, why: String(obj.why ?? '').slice(0, 120) || '就是觉得' };
}

export function createExpress(o = {}) {
  return {
    build: (c) => buildClaimPrompt(c, o),
    parse: parseExpressed,
    humanTool,
  };
}
