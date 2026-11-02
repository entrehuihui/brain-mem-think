/**
 * saw.mjs —— 「我亲手看过」的证据。
 *
 * ======================= 它解决的是一道我自己认下来的缝 =======================
 *
 * `motive.mjs` 里四种冲动，一直只有两种能用：
 *
 *   resolve   未解张力   ✓ 有数据（悬案被碰过、挂了很久）
 *   indulge   偏好       ✓ 有数据（做过、做完心里是松的）
 *   verify    二手空白   ✗ 空的
 *   identity  身份张力   ✗ 空的
 *
 * 原因不是没写，是**结构上没有数据**：这两种都要 `source:'self'` 的观测，
 * 而 `collect.mjs` 的白名单只认 `user/human/owner`。「她的话不是经历」——
 * 这条规矩是对的，我不拆它：一旦她自己的回话能进熔炉，她就会越说越确信，
 * 最后满库都是她给自己造的证据。
 *
 * ======================= 所以这条边门开在哪里 =======================
 *
 * 开在**她出门回来之后**，不开在她说出口之后。
 *
 *   她说「我觉得他其实在等我」 → 不进库。这是话。
 *   她出门查了一遍、看了文件、跑了命令、翻了网页 → 回来带一句
 *   「我看了，那行字是这么写的」 → **这条可以进**。这是看。
 *
 * 区别不在于谁说的，在于**有没有一个动作产生过新东西**。
 * 一句话可以编；一次 `read`、一次命令输出、一次抓回来的网页，编不出来。
 *
 * ======================= 三条纪律 =======================
 *
 * ① **只收「看」的，不收「说」的。** `kind` 必须在白名单里（read / run / fetch / look）。
 *    `say` / `think` 一律拒收——那还是话，换个字段名也不行。
 *
 * ② **必须带凭据。** 每一条 saw 都要 mount（看的是哪个文件 / 跑的是哪条命令 / 哪个网址）。
 *    没有 mount 的「我看过」不算看过。
 *
 * ③ **两种证据分开记账。** saw 不进 Belief 库、不进 Event 流（那一支是给
 *    「他说过什么」用的）。它自己单独一条，只在两处被读：
 *    `motive` 判 verify（我还没亲手看过的那些二手空白）、
 *    `world` 摆出来（我最近自己看过什么）。
 */

export const SAW_DEFAULTS = Object.freeze({
  /** 只认这几类动作：它们都会产出新东西，编不出来。 */
  kinds: ['read', 'run', 'fetch', 'look'],
  /** 一条 saw 的正文上限：看得见了什么，一句话就够。 */
  maxChars: 120,
  /** 保留多久。超过这个天数的「我看过」不再拿出来当理由。 */
  ttlMs: 30 * 86400e3,
  /** 最多存几条。多了按时间淘汰——这一支是佐证，不是账本。 */
  max: 200,
});

/** 这条记录是不是「我真的做了个动作、看见了个东西」。 */
export function isSaw(raw) {
  if (!raw || typeof raw !== 'object') return false;
  return SAW_DEFAULTS.kinds.includes(String(raw.kind ?? ''));
}

/**
 * 把一次「看过」收进来。
 *
 * 拒收的三种，都返回 null（不是抛错：这一支坏了不该拖垮主的路径）：
 *   · kind 不在白名单（`say` / `think` / 空）
 *   · 没有 mount（说不出看的是哪儿）
 *   · 正文空
 *
 * @param {object} raw { kind, mount, saw, at, target }
 * @param {number} [now]
 * @returns {{id, kind, mount, saw, target, at}|null}
 */
export function normalizeSaw(raw, now = Date.now()) {
  if (!isSaw(raw)) return null;
  const mount = String(raw.mount ?? '').trim();
  if (!mount) return null;
  const body = String(raw.saw ?? raw.text ?? '').trim();
  if (!body) return null;
  const at = Number.isFinite(Number(raw.at)) && Number(raw.at) > 0 ? Number(raw.at) : now;
  return {
    // 同一处、同一句话，就是同一条：重复看见不该被记成看见了两次。
    id: `saw:${String(raw.kind)}:${mount}:${body.slice(0, 40)}`,
    kind: String(raw.kind),
    mount: mount.slice(0, 200),
    saw: body.slice(0, SAW_DEFAULTS.maxChars),
    target: String(raw.target ?? '').trim().slice(0, 80) || null,
    at,
  };
}

/** 收进来、去重、按时间淘汰、封顶。纯函数。 */
export function addSaw(list, raw, opts = {}) {
  const o = { ...SAW_DEFAULTS, ...(opts ?? {}) };
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const one = normalizeSaw(raw, now);
  const old = (Array.isArray(list) ? list : []).filter((e) => e && now - Number(e.at ?? 0) <= o.ttlMs);
  if (!one) return old;
  if (old.some((e) => e.id === one.id)) return old;
  const next = [...old, one].sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0));
  return next.length > o.max ? next.slice(next.length - o.max) : next;
}

/**
 * 「我还没亲手看过的」——给 `verify` 这种冲动供料。
 *
 * 判据：这条判断的主题上，还没有一条 saw 落地。
 *
 * ★ 判据写过一版是坏的，记在这儿：
 *   第一版用「saw.target === note.themeKey」比。可 saw 的 target 是
 *   `pushes|他` 这种**主题键**，而人出门看东西时看见的是文件、命令输出、网页，
 *   它天然不会是一个主题键——于是这个比法永远不命中，
 *   `unverified` 会把全库都当成「没看过」，verify 就变成每天重跑一遍相同的事。
 *
 *   现在的口径：**看过就算看过，按主题倒推**。
 *   一条 saw 在采集时会带 `target`（这次出门是为了哪条判断）；
 *   没有 target 的 saw（顺手看了一眼），归到它那条活动所指向的主题上。
 *   两头都空，就不算数——宁可多跑一趟，也不假装看过了。
 *
 * @param {object[]} notes 归一化后的判断
 * @param {object[]} saws  已知的 saw 记录
 * @param {object} [opts]
 * @returns {object[]} 二手空白的判断（还没被我亲手核实过的）
 */
export function unverifiedOf(notes, saws, opts = {}) {
  const o = { ...SAW_DEFAULTS, ...(opts ?? {}) };
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const live = (Array.isArray(notes) ? notes : [])
    .filter((n) => n && (n.status === 'held' || n.status === 'open'));

  // 只看「还在保质期内、并且指明了看的是哪条判断」的 saw。
  const covered = new Set(
    (Array.isArray(saws) ? saws : [])
      .filter((s) => s && now - Number(s.at ?? 0) <= o.ttlMs)
      .map((s) => String(s.target ?? '').trim())
      .filter((t) => t.startsWith('belief:'))
      .map((t) => t.slice('belief:'.length)),
  );

  return live.filter((n) => {
    // 没有主题键的判断没法挂 saw，也就不该派她去看——它连「看哪儿」都说不出来。
    if (!n.themeKey) return false;
    return !covered.has(String(n.id));
  });
}

/** 她世界里的那一段：「我最近自己看过什么」。最多三条，不摆就不摆。 */
export function sawLines(saws, opts = {}) {
  const o = { ...SAW_DEFAULTS, ...(opts ?? {}) };
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const max = Number(opts.max ?? 3);
  const list = (Array.isArray(saws) ? saws : [])
    .filter((e) => e?.saw && now - Number(e.at ?? 0) <= o.ttlMs)
    .sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0))
    .slice(0, max);
  if (!list.length) return [];
  return ['我自己去看过的：', ...list.map((e) => `  ${e.saw}`)];
}

export function createSaw(opts = {}) {
  return {
    ...SAW_DEFAULTS,
    ...opts,
    add: (list, raw) => addSaw(list, raw, opts),
    unverified: (notes, saws) => unverifiedOf(notes, saws, opts),
    lines: (saws) => sawLines(saws, opts),
  };
}
