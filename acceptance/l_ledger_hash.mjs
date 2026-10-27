/**
 * l_ledger_hash.mjs —— 验收⑤：账本指纹必须只算「想法」，不算「时间与次数」
 *
 * ============== 它凭什么在这儿 ==============
 *
 * 要判「账本动没动」，内核得给判断库算个指纹（`hashLedger`）。
 * 但这个指纹怎么算，决定整条止损阀有没有意义。主人把话说死了：
 *
 *   **不许对整条 note 算哈希。**
 *   因为 `lastTouched` / 命中次数这类字段会在「库没变」的情况下也变，
 *   对整条算哈希会把「没变」算成「变了」——冻结库也会被算成在变，判据就废了。
 *
 *   只许算：`relation / polarity / weight（整数档） / 条数 / open 的 id 集合`
 *   不许算：时间戳、计数器
 *
 * 这条验收测的就是这个区分：
 *   H-1  同一批想法、只动时间戳/计数器 → 指纹必须**一模一样**
 *   H-2  真的改了 relation / polarity → 指纹必须**变**
 *   H-3  条数变了 / open 集合变了 → 指纹必须**变**
 *   H-4  指纹对 key 的顺序不敏感（同一批判断换个顺序，必须是同一个指纹）
 */

import { createHarness, loadRealModule, skip, EXIT } from './_harness.mjs';
import { isMain } from './_run.mjs';

/** 一份「想法没变」的判断库：只带时间戳和计数器，用来喂给指纹。 */
function baseNotes() {
  return [
    {
      id: 'n1', status: 'held', themeKey: 'is|他', relation: 'is', polarity: 1, weight: 0.6,
      from: 3, why: '有理由的。', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000,
      lastTouched: 1_700_000_100_000, hits: 7, turns: [{ text: '甲', at: 1 }],
    },
    {
      id: 'n2', status: 'open', themeKey: 'wants|他', relation: 'wants', polarity: 1, weight: 0.35,
      from: 1, why: '还没定。', createdAt: 1_700_000_200_000, updatedAt: 1_700_000_300_000,
      lastTouched: 1_700_000_300_000, hits: 2, turns: [{ text: '乙', at: 2 }],
    },
  ];
}

/** 同样的想法，但时间戳与计数器全动了（库其实没变）。 */
function noiseOnlyNotes() {
  const n = baseNotes();
  n[0].lastTouched = 1_800_000_000_000;
  n[0].updatedAt = 1_800_000_000_000;
  n[0].hits = 99;
  n[0].from = 12;
  n[1].lastTouched = 1_800_000_500_000;
  n[1].updatedAt = 1_800_000_500_000;
  n[1].hits = 55;
  return n;
}

/** 真的改了想法：relation 换掉。 */
function relationChanged() {
  const n = baseNotes();
  n[0].relation = 'is_because';
  n[0].themeKey = 'is_because|他';
  return n;
}

/** 真的改了想法：polarity 翻。 */
function polarityChanged() {
  const n = baseNotes();
  n[0].polarity = -1;
  return n;
}

/** 条数变了。 */
function countChanged() {
  const n = baseNotes();
  n.push({
    id: 'n3', status: 'held', themeKey: 'fears|他', relation: 'fears', polarity: -1, weight: 0.5,
    from: 1, why: '新的一条。', createdAt: 1_700_000_400_000, updatedAt: 1_700_000_400_000, turns: [],
  });
  return n;
}

/** open 集合变了（一条从 open 转 held）。 */
function openSetChanged() {
  const n = baseNotes();
  n[1].status = 'held';
  return n;
}

/** 顺序换了，但内容一样。 */
function reordered() {
  return [baseNotes()[1], baseNotes()[0]];
}

export function runAgainst(mod) {
  const h = createHarness('l_ledger_hash · 账本指纹只算「想法」，不算「时间与次数」', {
    capability: '止损阀的前提：分得清「库没变」和「库变了」（主人点名的哈希口径）',
    purpose: '若对整条算哈希，冻结库也会被算成在变，那条判据就废了',
  });
  h.armWatchdog();

  const hash = mod?.hashLedger;
  if (typeof hash !== 'function') {
    h.untested('L0.hashLedger_not_provided',
      'src/wake.mjs 还没导出 hashLedger —— 这不是失败，是还没开始测');
    return h;
  }
  h.check('L0.hashLedger_present', true, 'hashLedger 可用');

  const H = (notes) => {
    try {
      return String(hash(notes));
    } catch (err) {
      return `ERR:${err?.message ?? err}`;
    }
  };

  const base = H(baseNotes());

  // H-1 只动时间戳/计数器 → 指纹必须完全一样
  const noisy = H(noiseOnlyNotes());
  h.check('L1.time_and_counters_ignored', noisy === base,
    `只动时间戳/计数器/from 时指纹必须不变（否则冻结库会被算成在变）：base=${base.slice(0, 24)} noisy=${noisy.slice(0, 24)}`);

  // H-2 真改想法 → 必须变
  h.check('L2.relation_change_detected', H(relationChanged()) !== base,
    'relation 变了，指纹必须变');
  h.check('L2b.polarity_change_detected', H(polarityChanged()) !== base,
    'polarity 翻了，指纹必须变');
  h.check('L2c.weight_change_detected', H((() => { const n = baseNotes(); n[0].weight = 0.9; return n; })()) !== base,
    'weight 换了档，指纹必须变（份量是想法的一部分）');

  // H-3 结构变化 → 必须变
  h.check('L3.count_change_detected', H(countChanged()) !== base,
    '条数变了，指纹必须变');
  h.check('L3b.open_set_change_detected', H(openSetChanged()) !== base,
    'open 集合变了，指纹必须变');

  // H-4 顺序不敏感
  h.check('L4.order_insensitive', H(reordered()) === base,
    `同一批判断换个顺序必须是同一个指纹：base=${base.slice(0, 24)} reordered=${H(reordered()).slice(0, 24)}`);

  // 信息行：指纹取到的是什么样子，方便排查
  h.info('L5.sample_hash', base.slice(0, 40));
  h.info('L5b.noisy_equal_base', noisy === base ? '是（正确）' : '否（时间戳污染了指纹）');

  return h;
}

async function main() {
  const rel = await loadRealModule('../src/wake.mjs');
  if (!rel.ok) return skip('l_ledger_hash', `src/wake.mjs 加载不了：${rel.error?.message ?? rel.error}`);
  const h = runAgainst(rel.mod);
  h.exit();
  h.forceExit();
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error('l 崩了：', e);
    process.exitCode = EXIT.FAIL;
  });
}

export { baseNotes, noiseOnlyNotes, relationChanged, polarityChanged, countChanged, openSetChanged, reordered };
