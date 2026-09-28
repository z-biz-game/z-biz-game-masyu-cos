// 难度实测（balance）：把"这八档尺寸到底有多难、出题要多久"量出来，不猜。
//
// 和同目录的 probe/test 的分工：
//   generator-probe 答的是"引擎有没有坏"（账目轧平、三个应为 0 的项真的是 0）。
//   本文件答的是"菜单该挂哪几档"：出货率、零猜测可解率、难度分数分布、每盘墙钟。
//   两边不重复：本文件的样本串（balance|<sizeKey>|<i>）和 probe 的（probe|...）不同。
//
// 三个不能妥协的口径（本组织栽过的坑，逐条写在这里）：
//   ① 随机只发生在"选 seed"这一步，而且这一步是**确定性**的（串里带样本号）。
//      生成器、任何 sort 比较器里都不许出现 Math.random / Date.now——比较器里抽随机数
//      会让 node 和 Chrome 画出两张盘，门禁连跑三次条数都在变。
//   ② p50/p95 一律从**真实排序后的样本**里取，不用"中位 ×2"推算：本仓出题墙钟是双峰的。
//   ③ 聚合命中率旁边必须跟着"最大贡献者占多少"：一次 8.3% 的聚合命中率拆开看全部来自
//      一个退化样本，所以只看聚合数的报告都欠这一列。
//
// 跑法：
//   SAMPLES=24 node tools/balance.mjs            正式跑（默认 SAMPLES=24）
//   node tools/balance.mjs --quiet               只打一行 RESULT ok=<true|false>（门禁用）
//   node tools/balance.mjs --dose=6x6#2          摘掉那一盘的一颗珠子，验 proven 闸还咬不咬（必红）
// 退出码：0 = 全绿；1 = 有红线（见文末 GATES）。
//
// 本文件只读 js/ 下的公开出口，不改引擎、不碰浏览器、不联网。

import { makePuzzle, SIZES, SIZE_TABLE } from '../js/engine/generate.js';
import { solveWithRules, verify, edgeCount, RULE_ORDER, RULE_TEXT } from '../js/engine/pencil.js';
import { countLoops } from '../js/engine/counter.js';
import { loadavg, cpus } from 'node:os';

const QUIET = process.argv.includes('--quiet');
const SAMPLES = Math.max(1, Number(process.env.SAMPLES) || 24);
const BUDGET = 400_000; // 与 js/engine/generate.js:93 的 opts.budget 默认值一致（出货配置）
const MAX_TRIALS = 40; // 与 js/engine/generate.js:94 一致

// 变异剂量 --dose=<sizeKey>#<i>：把指定那一盘的一颗珠子摘掉，专门用来证明 proven 那条红线还咬得住。
// 需要它的原因：这条闸现在绿着，而"绿着"不等于"拦得住"——本组织 bake 那次就是绿的闸写着错的期望。
// 摘珠子破的是挖珠不变式（generate.js:153-189：每颗留下的珠子都试过摘，摘了就不认账），所以复算
// 必须当场报出 非 UNIQUE / verify 不过 / 铅笔没推到底 中的至少一个。摘了还全绿 ⇒ 是闸坏了，不是盘没事。
const DOSE = (() => {
  const a = process.argv.find((s) => s.startsWith('--dose='));
  if (!a) return null;
  const m = /^--dose=([0-9]+x[0-9]+)#([0-9]+)$/.exec(a);
  if (!m) throw new Error(`--dose 的形状是 --dose=6x6#2，收到 ${a}`);
  return { sizeKey: m[1], i: Number(m[2]) };
})();

// 档位：SIZES 是 UI 下拉框真正遍历的五档（js/main.js:435）；SIZE_TABLE 里另外三个长方形
// 不进菜单，本文件照样量——它们是"为什么菜单只有这五个"的对照组。
const EXTRA_SIZES = Object.keys(SIZE_TABLE).filter((k) => !SIZES.includes(k));
const CELLS = (k) => {
  const [w, h] = SIZE_TABLE[k];
  return w * h;
};
// 升序按格子数排（单调性要看"越大越难"成不成立）；比较器只读常量表，不抽随机数。
const LADDER = [...SIZES, ...EXTRA_SIZES].sort((a, b) => CELLS(a) - CELLS(b) || (a < b ? -1 : a > b ? 1 : 0));

// 出货配置照抄 js/main.js:215（requireBothColors: false、budget/maxTrials 用默认值）：
// 量出来的难度必须是玩家真拿到的那一盘，不是测试里那份"黑白各留一颗"的变体。
const SHIP_OPTS = { requireBothColors: false, budget: BUDGET, maxTrials: MAX_TRIALS };

// ── balance 自己的难度分数（**引擎里没有 scoreOf，这不是引擎给的数**）────────────
// 唯一的证据源是 solveWithRules 从空盘推到唯一解的十条规则命中：steps 是总步数，
// fired[r] 是第 r 条规则命中了几次（Σ fired = steps，见 pencil.js:661-683 的循环）。
// 权重 = 用这条规则要"看多远"：只看本格 1 / 看珠子四邻 2~3 / 看 2×2 4 / 看整圈整块 5。
// 于是 score = Σ fired[r]·weight[r] ≥ steps，score/steps 就是"平均每步看多远"。
const RULE_WEIGHT = {
  'pearl-degree': 1, // 珠子必在环上：零推理深度
  'cell-degree-two': 1, // 满两条就封死：只看本格计数
  'white-straight': 2, // 白珠直穿：珠子几何直译
  'black-turn': 2, // 黑珠拐弯：珠子几何直译
  'black-straight': 3, // 黑珠两侧必直穿：要看珠子的两个邻格
  'white-turn': 3, // 白珠前后至少一格拐：要看两个邻格
  'no-dead-end': 3, // 满一度补边 / 只剩一度切断：看候选集
  'no-2x2-square': 4, // 2×2 不许全在环上：局部块
  'single-loop': 5, // 环只一条：整圈拓扑
  'no-island': 5, // 孤岛不在环上：整块拓扑
};
if (RULE_ORDER.some((r) => RULE_WEIGHT[r] == null)) {
  throw new Error(`RULE_WEIGHT 缺规则：${RULE_ORDER.filter((r) => RULE_WEIGHT[r] == null).join(', ')}`);
}

function scoreOf(fired) {
  let s = 0;
  for (const [r, n] of Object.entries(fired)) s += (RULE_WEIGHT[r] ?? 0) * n;
  return s;
}

// 分位数：真实排序后取第 ceil(q·n) 个（nearest-rank，向上取整）。绝不由中位数推算。
function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(q * sortedAsc.length) - 1));
  return sortedAsc[idx];
}
const asc = (a) => a.slice().sort((x, y) => x - y); // 数值序，比较器只读实参
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const f0 = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '-');
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : '-');

// ── 跑一批样本：串可复现，随机只在"选 seed"这一步，而选 seed 是确定性的 ──────────
function runSize(sizeKey, n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const seed = `balance|${sizeKey}|${i}`;
    const hi = () => Number(process.hrtime.bigint() / 1000n) / 1000; // 引擎自记用时（高精度）
    const t0 = Date.now(); // 墙钟口径：Date.now()（任务指定）
    const p = makePuzzle(seed, sizeKey, { ...SHIP_OPTS, now: hi });
    const wall = Date.now() - t0;
    const rec = {
      i,
      seed,
      ok: !!p.ok,
      status: p.status,
      stats: p.stats,
      wall,
      msTotal: p.stats.msTotal,
      trials: p.stats.trials,
    };
    if (p.ok) {
      const face = { w: p.w, h: p.h, pearls: p.pearls };
      if (DOSE && sizeKey === DOSE.sizeKey && i === DOSE.i) {
        const dp = Int8Array.from(face.pearls);
        const cell = dp.findIndex((x) => x !== 0);
        if (cell < 0) throw new Error(`--dose 落空：${sizeKey}#${i} 盘上一颗珠子都没有，变异等于没做`);
        globalThis.__doseLanded = `${sizeKey}#${i} 摘掉第 ${cell} 格（原值 ${dp[cell]}）`;
        dp[cell] = 0;
        face.pearls = dp;
      }
      // 独立复算（不吃引擎的中间结果）：铅笔从空盘零猜测推到底 + 计数器预算内唯一。
      const s = solveWithRules(face, { maxSteps: 20000 });
      const v = s.status === 'solved' ? verify(s.state) : { ok: false, why: '未推完' };
      const c = countLoops(face, { budget: BUDGET });
      rec.solveStatus = s.status;
      rec.why = s.why;
      rec.steps = s.steps;
      rec.edges = edgeCount(p.w, p.h); // 盘上边数：h(w-1)+(h-1)w
      rec.fired = s.fired;
      rec.score = scoreOf(s.fired);
      rec.verified = !!v.ok;
      rec.counter = c.status; // UNIQUE / MULTIPLE / OVERBUDGET
      rec.pearlCount = p.pearlCount;
      rec.candidateCount = p.candidateCount;
      rec.loopLength = p.loopLength;
      rec.black = p.black;
      rec.white = p.white;
      rec.dropKept = p.stats.dropKept;
      // 退化样本判据：环占满全盘（"整盘一块"那次事故的形状）或一颗珠都没挖掉。
      rec.degenerate = p.loopLength === p.w * p.h || p.stats.dropKept === 0;
    }
    out.push(rec);
  }
  return out;
}

// ── 逐尺寸读数 ────────────────────────────────────────────────────────────
function measure(recs) {
  const n = recs.length;
  const shipped = recs.filter((r) => r.ok);
  const m = { n, shipped: shipped.length };

  // 1) 出货率 + trials 分布 + stats 归因
  const trialHist = new Map();
  for (const r of shipped) trialHist.set(r.trials, (trialHist.get(r.trials) || 0) + 1);
  const trialAsc = asc(shipped.map((r) => r.trials));
  m.trialsP50 = quantile(trialAsc, 0.5);
  m.trialsMax = trialAsc[trialAsc.length - 1];
  m.trialsAvg = trialAsc.length ? trialAsc.reduce((a, b) => a + b, 0) / trialAsc.length : NaN;
  m.trialHist = [...trialHist.entries()].sort((a, b) => a[0] - b[0]);
  const agg = {};
  for (const r of recs) {
    for (const [k, v] of Object.entries(r.stats)) if (typeof v === 'number') agg[k] = (agg[k] || 0) + v;
  }
  m.agg = agg;
  // 归因（没出货的样本按 stats 的键说清卡在哪一道门）
  m.failReasons = recs
    .filter((r) => !r.ok)
    .map((r) => `#${r.i}:${r.status}`);

  // 两条承诺分开量——上一版把它们混成一个"已证"数，于是拦下了不该拦的东西（裁决见 GATES）：
  //   「唯一解已证」只看**端出去那一盘**的独立复算认不认账（counterNotUnique / notVerified）。
  //   门 0 的 overbudgetFull 走 generate.js:124-127 的 continue：那张盘面没出货，它只花重试次数。
  //   挖珠的 dropByOverbudget 走 :171-175 把珠子放回去：出货盘仍 UNIQUE，破的是"每颗珠子都必要"。
  m.counterNotUnique = shipped.filter((r) => r.counter !== 'UNIQUE'); // 独立复算不认账 = 唯一解破口
  m.notVerified = shipped.filter((r) => !r.verified);
  m.notSolved = shipped.filter((r) => r.solveStatus !== 'solved'); // 复算时铅笔没推到底
  m.unproven = shipped.filter((r) => r.counter !== 'UNIQUE' || !r.verified || r.solveStatus !== 'solved');
  m.gate0Overbudget = shipped.filter((r) => r.stats.overbudgetFull > 0); // 重试代价，照打不判红
  m.minGap = shipped.filter((r) => r.stats.dropByOverbudget > 0); // 极简性没证到的盘
  m.degenerate = shipped.filter((r) => r.degenerate);

  // 2) 零猜测可解率
  const zeroGuess = shipped.filter((r) => r.solveStatus === 'solved' && r.verified);
  m.zeroGuess = zeroGuess.length;
  m.stuck = shipped.filter((r) => r.solveStatus === 'stuck').map((r) => r.i);
  m.otherStatus = shipped.filter((r) => r.solveStatus !== 'solved' && r.solveStatus !== 'stuck').map((r) => `#${r.i}:${r.solveStatus}`);

  // 3) 分数 / steps 分位
  const scoreAsc = asc(zeroGuess.map((r) => r.score));
  const stepAsc = asc(zeroGuess.map((r) => r.steps));
  const wallAsc = asc(recs.map((r) => r.wall));
  const msAsc = asc(recs.map((r) => r.msTotal));
  m.score = { p50: quantile(scoreAsc, 0.5), p95: quantile(scoreAsc, 0.95), max: scoreAsc[scoreAsc.length - 1], min: scoreAsc[0] };
  m.steps = { p50: quantile(stepAsc, 0.5), p95: quantile(stepAsc, 0.95), max: stepAsc[stepAsc.length - 1], min: stepAsc[0] };
  m.wall = { p50: quantile(wallAsc, 0.5), p95: quantile(wallAsc, 0.95), max: wallAsc[wallAsc.length - 1] };
  m.ms = { p50: quantile(msAsc, 0.5), p95: quantile(msAsc, 0.95), max: msAsc[msAsc.length - 1] };
  m.depth = zeroGuess.length ? zeroGuess.reduce((a, r) => a + r.score / r.steps, 0) / zeroGuess.length : NaN;
  // steps 实测恒等于盘上边数：每步只定一条边（pencil.js:589 applyDeduction 写 st.edges[d.edge]），
  // verify 又要求 unknownCount 归零（pencil.js:596-598）⇒ 步数被尺寸钉死。
  // 这条要量出来并断言成立：它说明"steps 分位"只反映尺寸，难度区分力全在分数的权重混合里。
  m.stepsEqEdges = shipped.length > 0 && shipped.every((r) => r.steps === r.edges);

  // 4) 每规则命中：聚合 + 最大贡献样本占比
  m.rules = RULE_ORDER.map((key) => {
    const per = shipped.map((r) => (r.fired ? r.fired[key] || 0 : 0));
    const total = per.reduce((a, b) => a + b, 0);
    let max = 0;
    let maxIdx = -1;
    per.forEach((v, k) => {
      if (v > max) {
        max = v;
        maxIdx = shipped[k].i;
      }
    });
    const touched = per.filter((v) => v > 0).length;
    return { key, total, perSample: total ? total / shipped.length : 0, top: max, topSample: maxIdx, topShare: total ? max / total : 0, touched, hitRate: shipped.length ? touched / shipped.length : 0 };
  });
  // 这一档"全部命中"里最大贡献样本占多少（老板要的那个数，对整档而言）
  const perSampleTotal = shipped.map((r) => (r.fired ? Object.values(r.fired).reduce((a, b) => a + b, 0) : 0));
  const allHits = perSampleTotal.reduce((a, b) => a + b, 0);
  const topHits = perSampleTotal.length ? Math.max(...perSampleTotal) : 0;
  m.allHits = allHits;
  m.topHits = topHits;
  m.topHitsShare = allHits ? topHits / allHits : 0;
  m.topHitsSample = topHits ? shipped[perSampleTotal.indexOf(topHits)].i : -1;
  return m;
}

// 支配概率 P(大档分数 > 小档分数)：全对枚举，无随机、无比较器抽奖。
// 1 档 P=0.5 ⇒ 两档分布完全重叠、没有区分力；0.5 是"抛硬币"，1 是"完全分离"。
function dominance(smallRecs, bigRecs) {
  const a = smallRecs.filter((r) => r.ok && Number.isFinite(r.score)).map((r) => r.score);
  const b = bigRecs.filter((r) => r.ok && Number.isFinite(r.score)).map((r) => r.score);
  if (!a.length || !b.length) return NaN;
  let win = 0;
  let tie = 0;
  for (const x of b) for (const y of a) {
    if (x > y) win++;
    else if (x === y) tie++;
  }
  return (win + 0.5 * tie) / (a.length * b.length);
}

// ── GATES：每条阈值都在下面写明来历（实测值 / 倍数 / 为什么）─────────────────────
// 下面"实测"一栏取自 SAMPLES=24 的正式跑（2026-09-28，本机 load1 27.19 / 15 核，有争用；
// 八档 ×24 盘 = 192 盘全部出货）。
const T = {
  yieldMenu: 0.75, // 实测（SAMPLES=24，八档全跑）出货率 24/24 = 100%，192 盘没有一盘出不了货。
  // 玩家点一次"换一局"必须有盘（js/main.js:224 出货失败只能提示换 seed），所以这是硬红线；
  // 不取 100% 是因为"某一档开始偶发不出货"就是该报警的信号，25pt 余量＝24 盘里容许 6 盘空。
  zeroGuessMenu: 0.9, // 实测零猜测可解率 100%（出货盘本来就是靠这道门发的：generate.js:132 门 1、:166 挖珠守卫）。
  // 90% 已经是"每 10 盘容许 1 盘铅笔推不完"的宽松值；真出现就说明 README 那句"零猜测可解"是假话。
  wallP95Ms: 8000, // 实测四遍 24 样本（本机 load1 27~30 / 15 核，有争用）：菜单最差档 10x10 的
  // p50 450~575ms、p95 4443~6589ms、max 5199~6822ms ⇒ 门槛 8000ms 只比实测 p95 上界高 1.2 倍。
  // 为什么不能由 p50 推：墙钟真是双峰——9x9 实测 p50 151~214ms 而 p95 2337~3430ms（15~16 倍），
  // "中位×2"会把这档的长尾整条漏掉；8x8 也有 p50 83~118 / p95 302~425（3.6 倍）。所以 p95 必须真排序取。
  // 为什么只留 1.2 倍而不是更紧：这台机器现在被别的会话抢 CPU（见头部 load 行），同一份 seed 的
  // p95 四遍跑就在 4443~6589 之间晃，紧阈值只会红给机器看。这条线是"数量级跑飞"探测器（预算改 4M、
  // 尺寸改 12x12、计数器退化这种），不是 SLA；墙钟绝对值每次照打，无争用的机器上想收紧就改这一个数。
  dominance: 0.85, // 实测 P(10x10 分数 > 6x6) = 1.000，两档区间 [127..157] vs [407..477] 完全不重叠。
  // 0.85 ＝ 24×24 = 576 对里只容许约 86 对反向（含平分）。再低就意味着首末两档重叠到没有区分力，
  // "6×6 简单、10×10 难"这句承诺就是空的——本工具正是为了抓这件事，所以不为绿放宽。
  gateControlSizes: false, // 三个不进菜单的尺寸（7x6 / 8x7 / 10x9）：读数照打，破口只记 note 不记 red。
  // 理由：门禁守的是发货承诺，对照档根本不发货；把它们的破口算进 RESULT，README 的承诺会被一个
  // 不存在的档位卡住。实测对照档确实更差（10x9 已证唯一解 17/24 vs 菜单最差 18/24），数字照打。
  contributionUniformFactor: 2.5, // 单盘独占率上限 = 2.5 / SAMPLES（均匀分布下一盘只独占 1/SAMPLES，
  // 超过 2.5 倍就说明"这一档的聚合命中是一个样本撑起来的"）。实测 SAMPLES=24 时八档的最大单盘独占
  // 全档都是 4%（均匀基线 1/24 = 4.2%，上限 2.5/24 = 10.4%）；SAMPLES=6 时实测 17%（基线 16.7%）——
  // 所以这条上限随样本数自动缩放是对的，SAMPLES=1 时上限自动到 100%（一盘无从判断集中）。
  // 本组织那次事故：聚合 8.3% 命中率，拆开看全部来自一个"整盘一块"的退化样本。只看聚合数发现不了，
  // 所以这一列是硬红线不是提示；退化样本另有一条（环满盘或一颗没挖掉）也照打。
  ruleTopShareMax: 0.6, // 单条规则命中里最大贡献样本占比 >60% 只记 note。实测（24 样本×8 档）：
  // single-loop 覆盖 6x6 12/24 盘 → 8x8 21/24 → 10x10 21/24（冷门规则由一两盘撑起是样本量的问题，
  // 该看的是"覆盖几盘"而不是聚合数）；no-2x2-square 覆盖 0/192 盘＝在真实生成的盘上一次都没命中，
  // 这条不是独占率问题，是"这条规则对出货盘没有贡献"，见输出末尾的规则全景。
};
// 单盘独占率上限：随 SAMPLES 自动缩放（见 T.contributionUniformFactor 的注释）。
const shareCap = () => Math.min(1, T.contributionUniformFactor / SAMPLES);
const GATES = [
  { key: 'yield', text: `菜单每档出货率 ≥ ${(T.yieldMenu * 100).toFixed(0)}%` },
  { key: 'zeroGuess', text: `菜单每档零猜测可解率 ≥ ${(T.zeroGuessMenu * 100).toFixed(0)}%，且出货盘 verify 100% 通过` },
  // proven 守的是「出货的每一盘都由独立计数器数过唯一解」：把端出去那一盘交给 countLoops 复算，
  // 预算内 UNIQUE、verify 通过、铅笔零猜测推到底——一张不认账就红。这条一次都不许松。
  // 裁决（2026-09-28，我推翻了自己下给这一条的"overbudget* 一律不算已证"）：那一刀量错了对象。
  // generate.js:124-127 见 OVERBUDGET 就 continue 换下一条环，那张盘面到不了玩家手里，拦它等于拦
  // 重试次数；而它当时确实把三档菜单判红（8x8 22/24、9x9 22/24、10x10 18/24），出货率与零猜测
  // 全绿、独立复算 192/192 UNIQUE——把 bug 写成期望的绿闸，比红闸更危险（本仓 bake 那次同类）。
  // 真正被 overbudget 破掉的是「每颗珠子都必要」：generate.js:171-175 把珠子放回，出货盘仍 UNIQUE，
  // 所以它挪到下面 minimal 单独披露，并把措辞禁令印在数旁边，不许混进 proven 的分子分母。
  { key: 'proven', text: '出货盘独立复算=预算内 UNIQUE ∧ verify 通过 ∧ 铅笔零猜测推到底（0 张不认账）' },
  { key: 'minimal', text: '挖珠止步于预算的盘数逐档披露（>0 时 README 禁写「每颗珠子都是必要的」，只可写「每盘都数过唯一解」）' },
  { key: 'monotone', text: `score p50 沿菜单不降，且首末两档支配概率 ≥ ${T.dominance}` },
  { key: 'wall', text: `每档 Date.now() 墙钟 p95 ≤ ${T.wallP95Ms}ms（来历见 T.wallP95Ms 注释）` },
  { key: 'sound', text: 'illegalLoop / refRejected / dropByMismatch 恒为 0；steps 恒等于盘上边数' },
  { key: 'contribution', text: `每档"最大单盘独占全部命中"≤ ${shareCap().toFixed(2)}（＝${T.contributionUniformFactor}/SAMPLES）；单条规则独占 >${(100 * T.ruleTopShareMax).toFixed(0)}% 记 note` },
];

// 一档的判定：flags = 红线（进 RESULT），notes = 只打印不拦（对照档的破口）。
// 单调性不在这里判——它是跨档比较，见 main() 里的 mono。
function judge(sizeKey, m) {
  const flags = [];
  const notes = [];
  const isMenu = SIZES.includes(sizeKey);
  const push = (cond, what) => {
    if (cond) return;
    if (T.gateControlSizes || isMenu) flags.push(what);
    else notes.push(what);
  };
  const hard = (cond, what) => {
    if (!cond) flags.push(what); // 引擎正确性类：哪个档位非 0 都是写错，一律红
  };
  // 菜单档（发货的）走红线；对照档走 note——见 T.gateControlSizes 的注释。
  push(m.shipped / m.n >= T.yieldMenu, `${sizeKey} 出货率 ${m.shipped}/${m.n} < ${(T.yieldMenu * 100).toFixed(0)}%`);
  push(m.zeroGuess / Math.max(1, m.shipped) >= T.zeroGuessMenu, `${sizeKey} 零猜测可解率 ${pct(m.zeroGuess, m.shipped)} < ${(T.zeroGuessMenu * 100).toFixed(0)}%`);
  push(m.wall.p95 <= T.wallP95Ms, `${sizeKey} 墙钟 p95 ${m.wall.p95}ms > ${T.wallP95Ms}ms`);
  // 这两条不再判红，改成每次都披露（理由见 GATES 的 proven 注释）：一个只花重试次数，
  // 一个破的是极简性。唯一解那一头由下面的 hard(counterNotUnique / notVerified) 死守。
  if (m.gate0Overbudget.length) notes.push(`${sizeKey} ${m.gate0Overbudget.length} 盘出过门 0 overbudgetFull（那张没出货，generate.js:124-127 continue ⇒ 只算重试代价，不是唯一解破口）`);
  if (m.minGap.length) notes.push(`${sizeKey} ${m.minGap.length} 盘挖珠止步于预算（dropByOverbudget，:171-175 把珠子放回）⇒ 这些盘不许说「每颗珠子都是必要的」`);
  push(m.topHitsShare <= shareCap(), `${sizeKey} 全档推理命中里最大单盘独占 ${(100 * m.topHitsShare).toFixed(0)}% > ${(100 * shareCap()).toFixed(0)}%（上限＝${T.contributionUniformFactor}/SAMPLES，聚合数是被一个样本撑起来的）`);
  hard(m.notVerified.length === 0, `${sizeKey} 有 ${m.notVerified.length} 盘 verify 不过`);
  hard(m.counterNotUnique.length === 0, `${sizeKey} 有 ${m.counterNotUnique.length} 盘独立复算不是预算内 UNIQUE`);
  hard((m.agg.illegalLoop || 0) === 0 && (m.agg.refRejected || 0) === 0 && (m.agg.dropByMismatch || 0) === 0, `${sizeKey} 应为 0 的项非 0（illegalLoop/refRejected/dropByMismatch）`);
  hard(m.otherStatus.length === 0, `${sizeKey} 有 solveWithRules 返回意外 status：${m.otherStatus.join(',')}`);
  hard(m.stepsEqEdges, `${sizeKey} steps ≠ 盘上边数（每步定一条边的不变式被打破，pencil.js:589/596）`);
  // 单条规则的独占率只记 note：冷门规则由一两盘撑起要看的是"覆盖几盘"，不是聚合数。
  for (const r of m.rules) {
    if (r.total > 0 && r.topShare > T.ruleTopShareMax) notes.push(`${sizeKey} 规则 ${r.key} 的 ${r.total} 次命中里 #${r.topSample} 独占 ${(100 * r.topShare).toFixed(0)}%（覆盖 ${r.touched}/${m.shipped} 盘）`);
  }
  return { flags, notes };
}

// ── 打印 ─────────────────────────────────────────────────────────────────
function printSize(sizeKey, m, recs, mono) {
  const tag = SIZES.includes(sizeKey) ? '菜单' : '不进菜单';
  console.log(`\n── ${sizeKey}（${CELLS(sizeKey)} 格，${tag}）样本 ${m.n} ─────────────────────`);
  // 1 出货率
  console.log(`1) 出货率 ${m.shipped}/${m.n} = ${pct(m.shipped, m.n)}  trials（仅出货盘，几试一次）avg ${f1(m.trialsAvg)} p50 ${f0(m.trialsP50)} max ${f0(m.trialsMax)}  分布 ${m.trialHist.map(([t, c]) => `${t}试:${c}`).join(' ')}`);
  const A = m.agg;
  console.log(`   stats 归因（本档 ${m.n} 样本累计）overbudgetFull ${A.overbudgetFull || 0} / pencilStuckFull ${A.pencilStuckFull || 0} / notUniqueFull ${A.notUniqueFull || 0} / dropByOverbudget ${A.dropByOverbudget || 0} / dropByMismatch ${A.dropByMismatch || 0} / dropByPencil ${A.dropByPencil || 0} / dropByCounter ${A.dropByCounter || 0} / dropByColor ${A.dropByColor || 0} / illegalLoop ${A.illegalLoop || 0} / refRejected ${A.refRejected || 0} / loopsAccepted ${A.loopsAccepted || 0}`);
  const shippedRecs = recs.filter((r) => r.ok);
  const avgPearl = shippedRecs.length ? shippedRecs.reduce((a, r) => a + r.pearlCount, 0) / shippedRecs.length : NaN;
  const avgCand = shippedRecs.length ? shippedRecs.reduce((a, r) => a + r.candidateCount, 0) / shippedRecs.length : NaN;
  console.log(`   挖珠 dropTried ${A.dropTried || 0} → dropKept ${A.dropKept || 0}｜出货盘均候选 ${f1(avgCand)} 颗 → 端出 ${f1(avgPearl)} 颗/盘（黑 ${f1(shippedRecs.length ? shippedRecs.reduce((a, r) => a + r.black, 0) / shippedRecs.length : NaN)} 白 ${f1(shippedRecs.length ? shippedRecs.reduce((a, r) => a + r.white, 0) / shippedRecs.length : NaN)}）`);
  if (m.failReasons.length) console.log(`   没出货的样本：${m.failReasons.join(' ')}`);
  const ids = (a) => (a.length ? a.map((r) => `#${r.i}`).join(',') : '-');
  console.log(`   两条承诺分开数：唯一解已证 ${m.shipped - m.unproven.length}/${m.shipped}（复算不认账：非 UNIQUE ${m.counterNotUnique.length} 盘 ${ids(m.counterNotUnique)}、verify 不过 ${m.notVerified.length} 盘 ${ids(m.notVerified)}、铅笔没推到底 ${m.notSolved.length} 盘 ${ids(m.notSolved)}）`);
  console.log(`   门 0 overbudget（那张盘面没出货，:124-127 continue ⇒ 只是重试代价）${m.gate0Overbudget.length} 盘 ${ids(m.gate0Overbudget)}｜极简性没证到（挖珠被预算逼着留珠，:171-175）${m.minGap.length} 盘 ${ids(m.minGap)}`);
  if (m.minGap.length) console.log(`     ⇒ 措辞禁令：本档 ${m.minGap.length}/${m.shipped} 盘里有珠子是"预算逼着留下的"，README/DESIGN 不许写「每颗珠子都是必要的」；「出货的每一盘都数过唯一解」这句在上面那个 0 张不认账时才允许写。`);
  if (m.degenerate.length) console.log(`   退化样本（环满盘或一颗没挖掉）：${m.degenerate.map((r) => `#${r.i}`).join(' ')}`);
  // 2 零猜测
  console.log(`2) 零猜测可解率 ${m.zeroGuess}/${m.shipped} = ${pct(m.zeroGuess, m.shipped)}（solveWithRules 空盘→唯一解，零回溯且 verify 通过）stuck ${m.stuck.length ? m.stuck.map((i) => `#${i}`).join(',') : '-'}｜意外 status ${m.otherStatus.length ? m.otherStatus.join(',') : '-'}`);
  // 3 分数
  console.log(`3) 分数(balance 自定义) p50 ${f0(m.score.p50)} p95 ${f0(m.score.p95)} max ${f0(m.score.max)} min ${f0(m.score.min)}｜steps p50 ${f0(m.steps.p50)} p95 ${f0(m.steps.p95)} max ${f0(m.steps.max)}｜平均推理深度 score/steps ${f1(m.depth)}`);
  console.log(`   steps 是不是恒等于边数：${m.stepsEqEdges ? '是（每步定一条边 ⇒ steps 只量尺寸，难度区分力全在分数的权重混合里）' : '否（不变式破了，见红线）'}`);
  console.log(`   权重（看多远）：${RULE_ORDER.map((k) => `${k}=${RULE_WEIGHT[k]}`).join(' ')} — 出自 balance.mjs，不是引擎给的数`);
  // 4 每规则命中 + 最大贡献样本
  console.log(`4) 规则命中（聚合必带最大贡献者）：全部命中 ${m.allHits} 次，最大贡献样本 #${m.topHitsSample} 独占 ${(100 * m.topHitsShare).toFixed(0)}%（单盘独占上限 ${(100 * shareCap()).toFixed(0)}%＝${T.contributionUniformFactor}/SAMPLES=${SAMPLES}）`);
  for (const r of m.rules) {
    console.log(`     ${r.key.padEnd(16)} 命中 ${String(r.total).padStart(4)}（均 ${(r.perSample || 0).toFixed(1)}/盘，覆盖 ${pct(r.touched, m.shipped)} 盘）｜最大贡献 ${r.top} 次 = 该规则命中的 ${(100 * r.topShare).toFixed(0)}%（样本 #${r.topSample}）｜${RULE_TEXT[r.key] || ''}`);
  }
  // 5 墙钟（绝对值每次必打）
  console.log(`5) 墙钟 Date.now()：p50 ${m.wall.p50}ms p95 ${m.wall.p95}ms max ${m.wall.max}ms（绝对值，实测非推算）p95/p50 ${m.wall.p50 ? (m.wall.p95 / m.wall.p50).toFixed(1) : '-'} 倍｜引擎自记 stats.msTotal p50 ${f1(m.ms.p50)} p95 ${f1(m.ms.p95)} max ${f1(m.ms.max)}ms`);
  // 6 单调性
  if (mono) console.log(`6) ${mono.text}`);
  // 逐样本一行（每行 6 个）
  console.log(`   逐样本 #=样本号 t=trials w=墙钟ms s=steps sc=分数 p=珠数 cand=候选 drop=挖掉：`);
  for (let k = 0; k < recs.length; k += 6) {
    const line = recs.slice(k, k + 6).map((r) => (r.ok ? `#${r.i} t${r.trials} w${r.wall} s${r.steps} sc${r.score} p${r.pearlCount}c${r.candidateCount}d${r.dropKept}` : `#${r.i} FAIL(${r.status}) w${r.wall}`)).join('  ');
    console.log(`     ${line}`);
  }
  const { flags, notes } = judge(sizeKey, m, mono);
  console.log(`   红线：${flags.length ? 'RED — ' + flags.join('；') : '无'}`);
  if (notes.length) console.log(`   披露项（不进 RESULT：重试代价 / 极简性没证到的盘，菜单档也打）：${notes.join('；')}`);
  return { flags, notes };
}

function main() {
  const per = {};
  for (const sizeKey of LADDER) {
    const recs = runSize(sizeKey, SAMPLES);
    per[sizeKey] = { recs, m: measure(recs) };
  }
  // 单调性只看菜单五档（按格子数升序）
  const menuAsc = SIZES.slice().sort((a, b) => CELLS(a) - CELLS(b));
  const seq = menuAsc.map((k) => ({ k, p50: per[k].m.score.p50, stepsP50: per[k].m.steps.p50 }));
  const nonDescending = seq.every((x, i) => i === 0 || !(x.p50 < seq[i - 1].p50));
  const smallRecs = per[menuAsc[0]].recs;
  const bigRecs = per[menuAsc[menuAsc.length - 1]].recs;
  const pScore = dominance(smallRecs, bigRecs);
  const smallScores = asc(smallRecs.filter((r) => r.ok).map((r) => r.score));
  const bigScores = asc(bigRecs.filter((r) => r.ok).map((r) => r.score));
  const mono = {
    ok: nonDescending && pScore >= T.dominance,
    text: `单调性（只看菜单 ${menuAsc.join('→')}）score p50 ${seq.map((x) => `${x.k}:${f0(x.p50)}`).join(' ≤ ')} → ${nonDescending ? '不降 ✓' : '有下降 ✗'}；`
      + `区分力 P(${menuAsc[menuAsc.length - 1]} 分数 > ${menuAsc[0]}) = ${Number.isFinite(pScore) ? pScore.toFixed(3) : '-'}（门槛 ${T.dominance}）；`
      + `两档区间 ${menuAsc[0]} [${smallScores[0]}..${smallScores[smallScores.length - 1]}] vs ${menuAsc[menuAsc.length - 1]} [${bigScores[0]}..${bigScores[bigScores.length - 1]}]`,
  };

  if (QUIET) {
    // 门禁模式：只准打 RESULT 这一行，别的什么都不打。
    const flags = [];
    for (const sizeKey of LADDER) flags.push(...judge(sizeKey, per[sizeKey].m).flags);
    if (!mono.ok) flags.push(mono.text);
    console.log(`RESULT ok=${flags.length === 0}`);
    return flags.length === 0 ? 0 : 1;
  }

  const la = loadavg();
  const ncpu = cpus().length;
  console.log(`balance 难度实测：SAMPLES=${SAMPLES} 档位=${LADDER.join(',')} 预算=${BUDGET} maxTrials=${MAX_TRIALS} 出货配置同 js/main.js:215（requireBothColors:false，budget/maxTrials 用默认值）`);
  console.log(`本机 load average（1/5/15 分钟）= ${la.map((x) => x.toFixed(2)).join(' / ')}，核数 ${ncpu}。`);
  console.log('  ⚠ 本机现在有两个别的会话遗留的失控 node 进程在吃 CPU（z-biz-game-nikoli-loops 的 probe、test/slitherlink.test.mjs），'
    + '所以下面所有**墙钟绝对值都带争用**、只能当上界看；分数/步数/出货率是纯计算口径，不受争用影响。');
  console.log('  可复现口径：seed 串 balance|<sizeKey>|<1..N> 固定，随机不发生在生成器与任何排序比较器里；'
    + '实测两次 24 样本跑，diff 只落在带墙钟数字的行上，分数/步数/命中率/出货率逐字节一致。');
  const flags = [];
  const notes = [];
  for (const sizeKey of LADDER) {
    const r = printSize(sizeKey, per[sizeKey].m, per[sizeKey].recs, SIZES.includes(sizeKey) ? mono : null);
    flags.push(...r.flags);
    notes.push(...r.notes);
  }
  if (!mono.ok) flags.push(mono.text);
  // 跨档对照：菜单五档 vs 三个不进菜单的尺寸
  console.log('\n── 菜单该挂哪几档（同表对照；分数是 balance 自定义度量）──');
  console.log('   尺寸        出货率   零猜测   steps p50/p95     分数 p50/p95     墙钟 p50/p95/max   盘均珠数/候选');
  for (const sizeKey of LADDER) {
    const m = per[sizeKey].m;
    const shipped = per[sizeKey].recs.filter((r) => r.ok);
    const avgP = shipped.length ? (shipped.reduce((a, r) => a + r.pearlCount, 0) / shipped.length).toFixed(1) : '-';
    const avgC = shipped.length ? (shipped.reduce((a, r) => a + r.candidateCount, 0) / shipped.length).toFixed(1) : '-';
    console.log(`   ${sizeKey.padEnd(6)} ${SIZES.includes(sizeKey) ? '菜单  ' : '对照  '} ${(m.shipped + '/' + m.n).padEnd(8)} ${pct(m.zeroGuess, m.shipped).padEnd(8)} ${`${f0(m.steps.p50)}/${f0(m.steps.p95)}`.padEnd(15)} ${`${f0(m.score.p50)}/${f0(m.score.p95)}`.padEnd(16)} ${`${m.wall.p50}/${m.wall.p95}/${m.wall.max}ms`.padEnd(18)} ${avgP}/${avgC}`);
  }
  // 规则全景：跨八档看每条规则命中了多少盘——0 命中的规则要照说"它对出货盘没有贡献"。
  const globalRule = new Map(RULE_ORDER.map((k) => [k, { hits: 0, boards: 0 }]));
  for (const sizeKey of LADDER) {
    for (const r of per[sizeKey].m.rules) {
      const g = globalRule.get(r.key);
      g.hits += r.total;
      g.boards += r.touched;
    }
  }
  console.log('\n规则全景（八档 ×' + SAMPLES + ' 盘）：' + RULE_ORDER.map((k) => `${k} 命中 ${globalRule.get(k).hits} 次/覆盖 ${globalRule.get(k).boards} 盘`).join('｜'));
  const dead = RULE_ORDER.filter((k) => globalRule.get(k).hits === 0);
  if (dead.length) console.log(`  ⚠ 这些规则在真实出货盘上一次都没命中：${dead.join(', ')}——它们对难度构成没有贡献（rule-test 里测得动，是构造盘；这里量的是生成盘）。`);
  console.log(`\n红线汇总：${flags.length ? `${flags.length} 项` : '0 项（全绿）'}`);
  for (const f of flags) console.log(`  - ${f}`);
  if (notes.length) {
    console.log(`披露项（不进 RESULT）：${notes.length} 项`);
    for (const f of notes) console.log(`  · ${f}`);
  }
  console.log('\n门禁口径（GATES，来历见 balance.mjs 里 GATES 的注释）：');
  for (const g of GATES) console.log(`  · ${g.text}`);
  if (globalThis.__doseLanded) {
    console.log(`\n[DOSE] 变异已落地：${globalThis.__doseLanded}｜红线 ${flags.length} 项` +
      (flags.length ? '（摘一颗珠子就红 ⇒ proven 那条闸确实咬得住）' : '（摘了珠子还全绿 ⇒ 这条闸不咬，上面的绿别当证据）'));
  }
  console.log(`RESULT ok=${flags.length === 0}`);
  return flags.length === 0 ? 0 : 1;
}

process.exit(main());
