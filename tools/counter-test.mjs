// 计数器对账：counter.js 的 countLoops（带剪枝的逐格 DFS）vs **本文件里另写的一版朴素枚举**。
//
// 朴素枚举是裁判。它的写法：按边编号枚举边子集，只在"每格恰好 0 或 2 条环边"这一条上剪枝
// （那是"环"这个对象本身的定义，不是 Masyu 的珠子规则），叶子处从坐标重新推一遍邻接、
// 沿环走一圈、按题面三句话逐格判珠子。它**完全不用珠子剪枝**、不看黑珠义务、不做提前闭圈判断，
// 也不 import 本仓库任何引擎文件（连边编号都是另起一套）——两条独立代码路数到同一个数才算数。
// 两边不一致 ⇒ countLoops 错了，去找它，不许改期望值。
//
// 另外三件事：
//   ① 证明计数器"开过火"：在 notUniqueFull 的环和故意欠 clues 的盘上必须报 count>1（预算内），
//      在出货盘和满候选题面上必须恰好 1。
//   ② 解释出题器里 dropByCounter=0：把同一条挖珠序列重放一遍，对每次"试着挖"同时跑铅笔和计数器，
//      给出交叉表 —— 到底是"铅笔推不完 ⇒ 计数器没机会说话"还是"计数器真的没用"。
//   ③ OVERBUDGET 可达：把预算压到某个真实 10×10 候选超预算，证明流水线是丢环/留珠，绝不出货。
//
// 用法：node tools/counter-test.mjs [尺寸] [生成盘样本数]
//   样本数默认很小（SAMPLES / 3）；朴素枚举只对 ≤5×6 的盘跑（实测 5×6 约 3.4s，6×6 分钟级），
//   6×6 的朴素对账要显式 NAIVE6=1 才开。
// 退出码：0 = 全部通过；1 = 有不一致或断言失败。

import { countLoops, satisfies } from '../js/engine/counter.js';
import { makePuzzle, parseSize, fingerprint } from '../js/engine/generate.js';
import { randomLoop, candidatesOf, checkLoop } from '../js/engine/loop.js';
import { solveWithRules, verify } from '../js/engine/pencil.js';
import { makeRng } from '../js/engine/rng.js';

const SAMPLES = Number(process.env.SAMPLES || process.argv[3] || 3);
const SIZE_ARG = process.argv[2];
const NAIVE6 = process.env.NAIVE6 === '1';
const PIPE_BUDGET = 400_000; // 出题器用的预算，别和裁判用的混

let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) {
    fails++;
    console.log(`FAIL  ${name}${detail ? '  ' + detail : ''}`);
  }
};

// ── 朴素枚举（独立代码路）────────────────────────────────────────────────
// 珠子输入用 1 基坐标写，方便人核对：P(w,h,[[r,c,'B'],...])
function pearlsOf(w, h, list) {
  const arr = new Int8Array(w * h);
  for (const [r, c, t] of list) arr[(r - 1) * w + (c - 1)] = t === 'B' ? 1 : 2;
  return arr;
}

function naiveCount(w, h, pearls) {
  const n = w * h;
  // 自己的边表：先所有横边（按行），再所有竖边（按行），只记"两端格号"，不复用引擎的 id 公式
  const eu = [];
  const ev = [];
  for (let r = 0; r < h; r++) for (let c = 0; c < w - 1; c++) { eu.push(r * w + c); ev.push(r * w + c + 1); }
  for (let r = 0; r < h - 1; r++) for (let c = 0; c < w; c++) { eu.push(r * w + c); ev.push((r + 1) * w + c); }
  const E = eu.length;
  const incident = Array.from({ length: n }, () => []);
  for (let e = 0; e < E; e++) { incident[eu[e]].push(e); incident[ev[e]].push(e); }
  // 某格"最后一条边"：走完这条边它的度数就定死了，度数=1 的话永远补不满两条 ⇒ 直接放弃这支。
  // 这只用了"环上每格恰好两条边"这句定义，没有用到任何珠子规则。
  const lastEdge = incident.map((l) => (l.length ? l[l.length - 1] : -1));
  const deg = new Int8Array(n);
  const on = new Uint8Array(E);
  const rowOf = (cell) => Math.floor(cell / w);
  const colOf = (cell) => cell % w;
  const dirOf = (a, b) => {
    const dr = rowOf(b) - rowOf(a);
    const dc = colOf(b) - colOf(a);
    return dr === -1 ? 0 : dc === 1 ? 1 : dr === 1 ? 2 : 3; // 上/右/下/左
  };
  let count = 0;
  let leaves = 0;

  const leaf = () => {
    leaves++;
    let used = 0;
    for (let cell = 0; cell < n; cell++) {
      if (deg[cell] === 0) continue;
      if (deg[cell] !== 2) return; // 兜底：度数只允许 0 或 2
      used++;
    }
    if (used < 4) return; // 网格里最短的环是 4 格
    const nb = Array.from({ length: n }, () => []);
    for (let e = 0; e < E; e++) {
      if (!on[e]) continue;
      nb[eu[e]].push(ev[e]);
      nb[ev[e]].push(eu[e]);
    }
    // 一条环走到底
    const order = [];
    const pos = new Int16Array(n).fill(-1);
    let cur = 0;
    while (deg[cur] !== 2) cur++;
    let prev = -1;
    for (let i = 0; i < used; i++) {
      if (pos[cur] >= 0) return; // 中途重复访问 ⇒ 不是一条简单环
      pos[cur] = order.length;
      order.push(cur);
      const nx = nb[cur][0] === prev ? nb[cur][1] : nb[cur][0];
      prev = cur;
      cur = nx;
    }
    if (cur !== order[0]) return; // 走不回来 ⇒ 还有另一段环挂在别处
    // 按题面三句话判珠子：黑珠这格拐弯、它进出那两格直穿；白珠这格直穿、前后至少一格拐弯
    const L = order.length;
    const turn = new Uint8Array(L);
    for (let i = 0; i < L; i++) {
      const p = order[(i - 1 + L) % L];
      const c2 = order[i];
      const q = order[(i + 1) % L];
      turn[i] = dirOf(p, c2) === dirOf(c2, q) ? 0 : 1;
    }
    for (let cell = 0; cell < n; cell++) {
      const kind = pearls[cell];
      if (!kind) continue;
      const i = pos[cell];
      if (i < 0) return; // 「珠子在环上」是题面第一句：不在环上的珠子直接判死
      const before = turn[(i - 1 + L) % L];
      const after = turn[(i + 1) % L];
      if (kind === 1) {
        if (!turn[i] || before || after) return;
      } else {
        if (turn[i] || (!before && !after)) return;
      }
    }
    count++;
  };

  const rec = (e) => {
    if (e === E) { leaf(); return; }
    const a = eu[e];
    const b = ev[e];
    // 分支一：这条边不在环上
    if (!(lastEdge[a] === e && deg[a] === 1) && !(lastEdge[b] === e && deg[b] === 1)) rec(e + 1);
    // 分支二：这条边在环上（前提是不把任何格顶过两条）
    if (deg[a] < 2 && deg[b] < 2) {
      deg[a]++; deg[b]++; on[e] = 1;
      if (!(lastEdge[a] === e && deg[a] === 1) && !(lastEdge[b] === e && deg[b] === 1)) rec(e + 1);
      deg[a]--; deg[b]--; on[e] = 0;
    }
  };
  rec(0);
  return { count, leaves };
}

// ── ① 对账表 ───────────────────────────────────────────────────────────
console.log('# ① countLoops vs 朴素枚举（朴素是裁判）');
const CONFIGS = [
  { title: '3×4 空题面（一颗珠子都没有：所有环都算解）', w: 3, h: 4, list: [] },
  { title: '4×4 空题面', w: 4, h: 4, list: [] },
  { title: '4×4 单颗黑珠', w: 4, h: 4, list: [[2, 2, 'B']] },
  { title: '4×4 单颗白珠', w: 4, h: 4, list: [[2, 2, 'W']] },
  { title: '3×4 角上白珠（角格必拐 ⇒ 无解）', w: 3, h: 4, list: [[1, 1, 'W']] },
  { title: '4×4 两颗相邻黑珠（互相要求直穿 ⇒ 可能无解）', w: 4, h: 4, list: [[2, 2, 'B'], [2, 3, 'B']] },
  { title: '4×5 一黑一白', w: 4, h: 5, list: [[2, 2, 'B'], [3, 4, 'W']] },
  { title: '4×4 满盘黑白交替（多半无解）', w: 4, h: 4, list: [[1, 1, 'B'], [1, 2, 'W'], [2, 1, 'W'], [2, 2, 'B'], [3, 3, 'B'], [3, 4, 'W'], [4, 3, 'W'], [4, 4, 'B']] },
  { title: '5×5 空题面', w: 5, h: 5, list: [] },
  { title: '5×5 三颗珠（欠 clues）', w: 5, h: 5, list: [[1, 3, 'B'], [3, 3, 'W'], [5, 2, 'B']] },
  { title: '5×6 单颗白珠（欠 clues）', w: 5, h: 6, list: [[3, 3, 'W']] },
];

// 真实出货盘 / 满候选题面也进对账表（尺寸小才能跑得动朴素枚举）
const genConfigs = [];
{
  const g = makePuzzle('counter|5x5|0', '5x5', { requireBothColors: true });
  if (g.ok) {
    const list = [];
    for (let c = 0; c < g.pearls.length; c++) if (g.pearls[c]) list.push([Math.floor(c / g.w) + 1, (c % g.w) + 1, g.pearls[c] === 1 ? 'B' : 'W']);
    genConfigs.push({ title: `5×5 出货题面（${list.length} 珠，期望恰好 1）`, w: g.w, h: g.h, list, wantExactlyOne: true });
  } else check('5×5 出货一盘给对账表当样本', false, JSON.stringify(g.stats));
}
{
  // 满候选题面（挖珠之前）。注意：一条环的满候选**不保证**唯一（② 就是这类反例），
  // 所以这里不预设期望值，只要求两套代码数到同一个数。
  const lr = randomLoop(5, 5, 'counter|cand5');
  const cand = candidatesOf(5, 5, lr.edges);
  const list = [];
  for (let c = 0; c < cand.pearls.length; c++) if (cand.pearls[c]) list.push([Math.floor(c / 5) + 1, (c % 5) + 1, cand.pearls[c] === 1 ? 'B' : 'W']);
  genConfigs.push({ title: `5×5 满候选题面（${list.length} 珠，不预设唯一）`, w: 5, h: 5, list });
}
{
  // 故意欠 clues：把上面那个满候选随机摘掉一大半 ⇒ 裁判和计数器都得说"不止一解"
  const lr = randomLoop(4, 5, 'counter|sparse45');
  const cand = candidatesOf(4, 5, lr.edges);
  const cells = [];
  for (let c = 0; c < cand.pearls.length; c++) if (cand.pearls[c]) cells.push(c);
  const keep = makeRng('counter|sparse45|keep').shuffle(cells).slice(0, Math.min(2, cells.length));
  const list = keep.map((c) => [Math.floor(c / 5) + 1, (c % 5) + 1, cand.pearls[c] === 1 ? 'B' : 'W']);
  genConfigs.push({ title: `4×5 只留 ${list.length} 颗珠（期望 >1）`, w: 4, h: 5, list, wantMultiple: true });
}
if (NAIVE6) {
  const lr = randomLoop(6, 6, 'counter|cand66');
  const cand = candidatesOf(6, 6, lr.edges);
  const list = [];
  for (let c = 0; c < cand.pearls.length; c++) if (cand.pearls[c]) list.push([Math.floor(c / 6) + 1, (c % 6) + 1, cand.pearls[c] === 1 ? 'B' : 'W']);
  genConfigs.push({ title: `6×6 满候选题面（${list.length} 珠）`, w: 6, h: 6, list });
  const g = makePuzzle('counter|6x6|1', '6x6', { requireBothColors: true });
  if (g.ok) {
    const l2 = [];
    for (let c = 0; c < g.pearls.length; c++) if (g.pearls[c]) l2.push([Math.floor(c / g.w) + 1, (c % g.w) + 1, g.pearls[c] === 1 ? 'B' : 'W']);
    genConfigs.push({ title: `6×6 出货题面（${l2.length} 珠，期望恰好 1）`, w: g.w, h: g.h, list: l2, wantExactlyOne: true });
  }
}

const allConfigs = CONFIGS.concat(genConfigs);
const rows = [];
let disagree = 0;
let multiSeen = 0;
console.log('配置'.padEnd(4) + ' 尺寸    珠数   朴素解数  countLoops  状态       节点数    朴素叶子   一致');
console.log('-'.repeat(92));
allConfigs.forEach((cfg, i) => {
  const pearls = pearlsOf(cfg.w, cfg.h, cfg.list);
  const t0 = Date.now();
  const nv = naiveCount(cfg.w, cfg.h, pearls);
  const naiveMs = Date.now() - t0;
  const dp = countLoops({ w: cfg.w, h: cfg.h, pearls }, { budget: 60_000_000, cap: Number.POSITIVE_INFINITY });
  const agree = !dp.overbudget && dp.count === nv.count;
  if (!agree) disagree++;
  if (nv.count > 1) multiSeen++;
  console.log(
    `#${String(i).padStart(2, '0')}  ${`${cfg.w}×${cfg.h}`.padEnd(6)}  ${String(cfg.list.length).padStart(4)}   ${String(nv.count).padStart(7)}   ${String(dp.count).padStart(8)}   ${dp.status.padEnd(9)}  ${String(dp.nodes).padStart(8)}   ${String(nv.leaves).padStart(7)}   ${agree ? '✓' : '✗ 朴素=' + nv.count + ' DP=' + dp.count}` + `  (${naiveMs}ms)  ${cfg.title}`,
  );
  rows.push({ i, cfg, naive: nv.count, dp });
  if (!agree) console.log(`    FAIL ${cfg.title}：朴素=${nv.count} countLoops=${dp.count} status=${dp.status} 节点=${dp.nodes}`);
  // status 必须和 count 说的是同一件事（这不是新期望，是 countLoops 自己的定义）
  const want = nv.count > 1 ? 'MULTIPLE' : nv.count === 1 ? 'UNIQUE' : 'NONE';
  check(`${cfg.title}：status 与解数一致`, dp.status === want, `count=${nv.count} ⇒ 应为 ${want}，实际 ${dp.status}`);
  if (cfg.wantExactlyOne) check(`${cfg.title} 恰好一解`, nv.count === 1 && dp.count === 1, `朴素=${nv.count} DP=${dp.count}`);
  if (cfg.wantMultiple) check(`${cfg.title} 多解`, nv.count > 1 && dp.count > 1, `朴素=${nv.count} DP=${dp.count}`);
});
console.log(`对账：${allConfigs.length} 个配置，一致 ${allConfigs.length - disagree}，不一致 ${disagree}；其中 ${multiSeen} 个配置解数 >1（计数器说 MULTIPLE 的能力被量到了）`);
check('countLoops 与朴素枚举全一致', disagree === 0, `${disagree} 个配置不一致`);
check('对账表里有多解配置（证明计数器能说 count>1）', multiSeen >= 3, `${multiSeen}`);
check('配置数 ≥10', allConfigs.length >= 10, `${allConfigs.length}`);

// 出货题面在**出题预算**下也必须恰好 1（这是"计数器给出货盘当独立唯一性证明"的正题）
for (const r of rows) {
  if (!r.cfg.wantExactlyOne) continue;
  const pearls = pearlsOf(r.cfg.w, r.cfg.h, r.cfg.list);
  const p = countLoops({ w: r.cfg.w, h: r.cfg.h, pearls }, { budget: PIPE_BUDGET });
  check(`出货题面 #${r.i} 在 400k 预算内 UNIQUE`, p.status === 'UNIQUE', `status=${p.status} nodes=${p.nodes}`);
}

// ── ② 计数器开过火的证据：notUniqueFull 的环 ───────────────────────────
console.log('\n# ② 出题器门 0 丢掉的环（notUniqueFull）：计数器必须在预算内说 count>1');
{
  const sizeKey = SIZE_ARG && SIZE_ARG !== '5x5' ? SIZE_ARG : '6x6';
  const { w, h } = parseSize(sizeKey);
  let found = 0;
  let scanned = 0;
  let over = 0;
  for (let s = 0; s < 24 && found < 3; s++) {
    for (let t = 0; t < 6; t++) {
      const lr = randomLoop(w, h, `counter|nf|${s}|loop#${t}`);
      if (!lr.ok) continue;
      const cand = candidatesOf(w, h, lr.edges);
      scanned++;
      const cl = countLoops({ w, h, pearls: cand.pearls }, { budget: PIPE_BUDGET, cap: 2 });
      if (cl.overbudget) over++;
      else if (cl.status !== 'UNIQUE') {
        found++;
        console.log(`  ${sizeKey} 全候选 ${cand.total} 珠（黑 ${cand.black}/白 ${cand.white}）环长 ${lr.length} → 计数器 ${cl.status}（nodes=${cl.nodes}）：这条环就是会被门 0 丢掉的那类`);
      }
    }
  }
  console.log(`  扫了 ${scanned} 条环：全候选仍多解 ${found} 条，超预算 ${over} 条`);
  check('确实找到"全候选仍多解"的环（notUniqueFull 不是空计数）', found > 0, `found=${found}`);
  check('这类环里计数器在预算内给出了 count>1', found > 0);
}

// 出货盘逐盘复核：计数器（独立代码路）必须说 UNIQUE
console.log('\n# ③ 出货盘逐盘：计数器 UNIQUE + 铅笔 solved');
{
  const sizes = SIZE_ARG ? [SIZE_ARG] : ['6x6', '8x8'];
  let shipped = 0;
  let unique = 0;
  let solved = 0;
  let t0 = Date.now();
  for (const sizeKey of sizes) {
    for (let i = 0; i < SAMPLES; i++) {
      const p = makePuzzle(`counter|ship|${sizeKey}|${i}`, sizeKey, { requireBothColors: true });
      if (!p.ok) {
        check(`${sizeKey}#${i} 出货`, false, JSON.stringify(p.stats));
        continue;
      }
      shipped++;
      const cl = countLoops({ w: p.w, h: p.h, pearls: p.pearls }, { budget: PIPE_BUDGET });
      if (cl.status === 'UNIQUE') unique++;
      else check(`${sizeKey}#${i} 出货盘计数器 UNIQUE`, false, `status=${cl.status} nodes=${cl.nodes}`);
      const s = solveWithRules({ w: p.w, h: p.h, pearls: p.pearls });
      if (s.status === 'solved' && verify(s.state).ok) solved++;
      else check(`${sizeKey}#${i} 出货盘铅笔 solved`, false, `status=${s.status}`);
      check(`${sizeKey}#${i} 参考环确实是这组珠子的解（satisfies）`, satisfies(p.w, p.h, p.pearls, p.solution));
      console.log(`  ${sizeKey}#${i} 珠=${p.pearlCount}（黑 ${p.black}/白 ${p.white}）候选=${p.candidateCount} 环长=${p.loopLength} 计数器 nodes=${cl.nodes} status=${cl.status}`);
    }
  }
  console.log(`  ${shipped} 个出货盘：计数器 UNIQUE ${unique}，铅笔 solved ${solved}（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  check('出货盘计数器全 UNIQUE', shipped > 0 && unique === shipped, `${unique}/${shipped}`);
  check('出货盘铅笔全 solved', solved === shipped, `${solved}/${shipped}`);
}

// ── ④ 挖珠交叉表：为什么 dropByCounter = 0 ─────────────────────────────
console.log('\n# ④ 重放出题器的挖珠序列，每次试着挖都同时问铅笔和计数器');
{
  const sizes = SIZE_ARG ? [SIZE_ARG] : ['6x6', '8x8'];
  for (const sizeKey of sizes) {
    const { w, h } = parseSize(sizeKey);
    let tried = 0; // 出题器真的会去试的挖珠次数（不含被 requireBothColors 挡掉的）
    let kept = 0; // 真挖掉的
    let skippedByColor = 0;
    let pencilFailCounterMulti = 0;
    let pencilFailCounterUnique = 0;
    let pencilFailCounterOver = 0;
    let pencilOkCounterNotUnique = 0;
    let pencilOkCounterUnique = 0;
    let pencilOkOver = 0;
    let pencilOkMismatch = 0; // 铅笔推完推得通、但定出的环不是参考环（出题器记 dropByMismatch）
    let boards = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const seed = `counter|audit|${sizeKey}|${i}`;
      // 复刻 makePuzzle 的"找环"：同样的 seed 串、同样的判据（顺序无关，判据是合取）
      const budget = PIPE_BUDGET;
      let acc = null;
      for (let t = 0; t < 40; t++) {
        const lr = randomLoop(w, h, `${seed}|loop#${t}`);
        if (!lr.ok) continue;
        const cand = candidatesOf(w, h, lr.edges);
        const pz = { w, h, pearls: cand.pearls };
        if (!checkLoop(w, h, lr.edges).ok || !satisfies(w, h, cand.pearls, lr.edges)) continue;
        const cl = countLoops(pz, { budget });
        if (cl.status !== 'UNIQUE') continue;
        const s = solveWithRules(pz);
        if (s.status !== 'solved' || !verify(s.state).ok) continue;
        acc = { lr, cand };
        break;
      }
      if (!acc) {
        check(`${sizeKey}#${i} 复刻找环成功`, false, '40 次没找到可用环');
        continue;
      }
      // 出货结果必须和 makePuzzle 一模一样（指纹相同），否则下面的交叉表不代表真实运行
      const real = makePuzzle(seed, sizeKey, { requireBothColors: true, budget, maxTrials: 40 });
      const pearls = Int8Array.from(acc.cand.pearls);
      const cells = [];
      for (let c = 0; c < pearls.length; c++) if (pearls[c]) cells.push(c);
      const order = makeRng(`${seed}|dig|${w}x${h}`).shuffle(cells);
      let blackLeft = acc.cand.black;
      let whiteLeft = acc.cand.white;
      boards++;
      for (const cell of order) {
        const saved = pearls[cell];
        const isBlack = saved === 1;
        pearls[cell] = 0;
        // 照抄出题器的 requireBothColors 守卫：黑白各留一颗时这颗根本不会被试挖，
        // 把它算进"试挖"里会让下面的占比失真
        if (blackLeft - (isBlack ? 1 : 0) === 0 || whiteLeft - (isBlack ? 0 : 1) === 0) {
          pearls[cell] = saved;
          skippedByColor++;
          continue;
        }
        tried++;
        const s = solveWithRules({ w, h, pearls });
        const pencilOk = s.status === 'solved' && verify(s.state).ok;
        // 出题器还比一条"铅笔定出的环 == 参考环"（mismatch），它对计数器的态度没影响，单独记
        let mismatch = false;
        if (pencilOk) {
          for (let e = 0; e < acc.lr.edges.length; e++) {
            if (s.state.edges[e] !== (acc.lr.edges[e] ? 1 : 2)) mismatch = true;
          }
        }
        const cl = countLoops({ w, h, pearls }, { budget });
        if (pencilOk) {
          if (mismatch) pencilOkMismatch++;
          if (cl.status === 'UNIQUE') pencilOkCounterUnique++;
          else if (cl.overbudget) pencilOkOver++;
          else pencilOkCounterNotUnique++;
        } else {
          if (cl.overbudget) pencilFailCounterOver++;
          else if (cl.count > 1) pencilFailCounterMulti++;
          else pencilFailCounterUnique++;
        }
        // 出题器的丢弃顺序：铅笔 → 超预算 → 非 UNIQUE → mismatch
        const restores = !(pencilOk && !cl.overbudget && cl.status === 'UNIQUE' && !mismatch);
        if (restores) pearls[cell] = saved;
        else {
          kept++;
          if (isBlack) blackLeft--;
          else whiteLeft--;
        }
      }
      if (real.ok) check(`${sizeKey}#${i} 复刻挖珠结果 = makePuzzle 出货`, real.fingerprint === fingerprint(w, h, pearls, acc.lr.edges), `${real.fingerprint} vs ${fingerprint(w, h, pearls, acc.lr.edges)}`);
      void real;
    }
    const total = tried;
    const pencilRejected = total - kept; // 出题器口径：留回原位的=它拦下的（dropByPencil+dropByCounter+dropByOverbudget+dropByMismatch）
    const pencilFailTotal = pencilFailCounterMulti + pencilFailCounterOver + pencilFailCounterUnique;
    const pencilOkTotal = pencilOkCounterUnique + pencilOkCounterNotUnique + pencilOkOver;
    console.log(`  ${sizeKey}：${boards} 个盘，试挖 ${total} 颗（另有 ${skippedByColor} 颗因"黑白各留一颗"根本没试），挖掉 ${kept} 颗，出题器拦下 ${pencilRejected} 颗`);
    console.log(`    铅笔推不完：${pencilFailTotal} 颗 → 计数器视角：MULTIPLE ${pencilFailCounterMulti}、超预算 ${pencilFailCounterOver}、UNIQUE ${pencilFailCounterUnique}`);
    console.log(`    铅笔推得完：${pencilOkTotal} 颗 → 计数器视角：UNIQUE ${pencilOkCounterUnique}、MULTIPLE ${pencilOkCounterNotUnique}、超预算 ${pencilOkOver}（其中"铅笔定的环 ≠ 参考环"的 mismatch ${pencilOkMismatch} 颗）`);
    check(`${sizeKey} 交叉表自洽（两个桶覆盖全部试挖）`, pencilFailTotal + pencilOkTotal === total, `${pencilFailTotal}+${pencilOkTotal} vs ${total}`);
    check(`${sizeKey} 没有铅笔推完却定不出参考环的盘（mismatch 应为 0）`, pencilOkMismatch === 0, `${pencilOkMismatch} 颗`);
    if (total) {
      console.log(`    占比：铅笔拦下 ${(100 * pencilRejected / total).toFixed(0)}%；计数器在"铅笔已经推完整盘"的盘上独立拦下 ${(100 * pencilOkCounterNotUnique / total).toFixed(0)}%（若把铅笔拿掉只信计数器，它能拦 ${(100 * (pencilOkCounterNotUnique + pencilFailCounterMulti + pencilFailCounterOver) / total).toFixed(0)}%）`);
      console.log(`    ⇒ dropByCounter=${pencilOkCounterNotUnique} 的原因：solveGate 里计数器只在"铅笔推完每一条约边"之后才被问到，而"铅笔的每一条结论都对 + 结论铺满全盘"⇒ 只剩一个赋值 ⇒ 计数器必然数到 1。`);
    }
    // 这条断言才是真正的交叉验证：铅笔推完了盘，计数器却说"不止一解" ⇒ 铅笔里有规则不 sound
    check(`${sizeKey} 没有"铅笔推完却仍多解"的盘（铅笔与计数器互相印证）`, pencilOkCounterNotUnique === 0, `${pencilOkCounterNotUnique} 颗`);
  }
}

// ── ⑤ OVERBUDGET 可达且绝不出货 ─────────────────────────────────────────
console.log('\n# ⑤ OVERBUDGET：把预算压小，真实 10×10 候选会超预算，流水线只丢不出货');
{
  const sizeKey = '10x10';
  const { w, h } = parseSize(sizeKey);
  // (a) 真实候选盘 + 小预算：直接证明 countLoops 能返回 OVERBUDGET
  let hit = 0;
  let probeTotal = 0;
  let best = null;
  for (let s = 0; s < 8 && hit < 2; s++) {
    const lr = randomLoop(w, h, `counter|ob|${s}|loop#0`);
    if (!lr.ok) continue;
    const cand = candidatesOf(w, h, lr.edges);
    for (const budget of [2000, 20000, 200000]) {
      const cl = countLoops({ w, h, pearls: cand.pearls }, { budget });
      probeTotal++;
      if (cl.overbudget) {
        hit++;
        if (!best || budget > best.budget) best = { budget, s, nodes: cl.nodes, pearls: cand.total };
        console.log(`  10×10 全候选 ${cand.total} 珠，预算 ${budget} → OVERBUDGET（用了 ${cl.nodes} 节点，count=${cl.count}）`);
        break;
      }
    }
  }
  console.log(`  探针 ${probeTotal} 次：超预算 ${hit} 次${best ? `；最松的超预算档 = 预算 ${best.budget}（第 ${best.s} 条环，${best.pearls} 珠）` : ''}`);
  check('OVERBUDGET 可达（真实 10×10 候选超小预算）', hit > 0, `hit=${hit}`);

  // (b) 流水线层面：用这个预算跑 makePuzzle，出货的盘必须在预算内 UNIQUE；超预算的环一律丢掉
  let okShipped = 0;
  let shippedViolations = 0;
  let obFull = 0;
  let obDrop = 0;
  let noLoop = 0;
  for (const budget of [best ? best.budget : 20000, 200000]) {
    for (let i = 0; i < SAMPLES; i++) {
      const p = makePuzzle(`counter|obrun|${i}`, sizeKey, { budget, maxTrials: 12, requireBothColors: true });
      obFull += p.stats.overbudgetFull;
      obDrop += p.stats.dropByOverbudget;
      if (!p.ok) {
        noLoop++;
        continue;
      }
      okShipped++;
      const cl = countLoops({ w: p.w, h: p.h, pearls: p.pearls }, { budget });
      if (cl.status !== 'UNIQUE' || cl.overbudget) {
        shippedViolations++;
        check(`预算 ${budget} 下 ${sizeKey}#${i} 出货盘仍在预算内 UNIQUE`, false, `status=${cl.status} overbudget=${cl.overbudget} nodes=${cl.nodes}`);
      }
    }
  }
  console.log(`  低预算跑 makePuzzle：出货 ${okShipped} 盘，no-loop ${noLoop} 次，overbudgetFull 累计 ${obFull}，dropByOverbudget 累计 ${obDrop}；出货盘中"预算外唯一性"的违规 ${shippedViolations}`);
  check('低预算下确实触发了门 0 的 OVERBUDGET 丢弃', obFull > 0 || obDrop > 0, `overbudgetFull=${obFull} dropByOverbudget=${obDrop}`);
  check('OVERBUDGET 从不出货（出货盘一律预算内 UNIQUE）', shippedViolations === 0);
}

console.log(`\n${fails ? `FAIL ${fails} 项` : 'OK'} counter-test`);
process.exit(fails ? 1 : 0);
