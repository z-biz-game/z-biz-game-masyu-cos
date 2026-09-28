// 出题器：先有一条参考环，再从环上"长"出珠子，最后把珠子一颗颗挖掉、只留必要的。
//
// 流程（全都只吃 seed，没有 Math.random / Date.now / 任何时钟参与判定）：
//   ① 鼓包/缩包随机行走造一条参考环（loop.js）。
//   ② 门 0：把"全部合法放珠位置"当题面，计数器必须说 UNIQUE。
//      不唯一就整条环丢掉——因为候选集是"闭于子集"的（见下方注释），
//      全集都不唯一的话，任何子集都不唯一，挖下去必然白干。
//   ③ 门 1：同一份题面，铅笔必须在零猜测下推到全满。做不到也整条丢掉。
//   ④ 挖珠（门 2）：按 rng 定好的顺序逐颗试着删。推不完 / 不唯一 ⇒ 这颗证过必要，放回去；
//      计数器超预算 ⇒ 数不完，既没证必要也没证不必要 ⇒ 这颗是"预算逼着留下的"，整条环作废重抽。
//      于是端出去的每一颗珠子都带着"删不得"的证据，而 OVERBUDGET 的候选与盘都不出货。
//
// "闭于子集"：一颗珠子能不能放，只取决于参考环在 (前一格, 本格, 后一格) 三格上的形状，
// 删掉别的珠子不改变这三格的形状 ⇒ 参考环始终是题面的一个解。
// 于是题面越删越松（解集单调变大）：全集有唯一解是任何子集有唯一解的必要条件，②才敢当硬门用。
//
// 本文件只 import loop / pencil / counter / rng，不共享它们的规则表：
// 铅笔和计数器各自独立实现（谁都不 import 谁），两边都点头才出货。
//
// 浏览器可用：本文件不碰 process / fs；计时由调用方注入（opts.now），默认不计时。

import { makeRng } from './rng.js';
import { candidatesOf, randomLoop, checkLoop, neighbor, edgeIdOf, BLACK, WHITE, NONE } from './loop.js';
import { solveWithRules, verify, LOOP as P_LOOP, CUT as P_CUT } from './pencil.js';
import { countLoops, satisfies } from './counter.js';

export { BLACK, WHITE, NONE };

// 出货尺寸：主尺寸是正方形，另外带上 Masyu 题库常见的长方形。
export const SIZES = ['6x6', '7x7', '8x8', '9x9', '10x10'];
export const SIZE_TABLE = {
  '6x6': [6, 6],
  '7x7': [7, 7],
  '8x8': [8, 8],
  '9x9': [9, 9],
  '10x10': [10, 10],
  '7x6': [7, 6],
  '8x7': [8, 7],
  '10x9': [10, 9],
};

export function parseSize(sizeKey) {
  const pair = SIZE_TABLE[sizeKey];
  if (pair) return { w: pair[0], h: pair[1] };
  const m = /^(\d+)x(\d+)$/.exec(String(sizeKey));
  if (!m) throw new Error(`未知尺寸 ${sizeKey}`);
  return { w: Number(m[1]), h: Number(m[2]) };
}

// 把题面 + 参考环压成一个稳定指纹：同样的题面永远得到同样的串，全程无浮点。
// 环边用 "01" 串再切 8 位一组转十六进制，末尾不足 8 位补 0 并标出有效位数，避免歧义。
export function fingerprint(w, h, pearls, edges) {
  let p = '';
  for (let i = 0; i < pearls.length; i++) {
    if (!pearls[i]) continue;
    p += `${i}${pearls[i] === BLACK ? 'B' : 'W'}`;
  }
  let bits = '';
  for (let i = 0; i < edges.length; i++) bits += edges[i] ? '1' : '0';
  let hex = '';
  for (let i = 0; i < bits.length; i += 8) {
    hex += parseInt(bits.slice(i, i + 8).padEnd(8, '0'), 2).toString(16).padStart(2, '0');
  }
  return `${w}x${h}|${p}|${bits.length.toString(16)}|${hex}`;
}

export function newStats() {
  return {
    trials: 0,
    illegalLoop: 0, // 参考环自己就不合法（应为 0，出现即 loop.js 有 bug）
    refRejected: 0, // 参考环被计数器/自检判不合格（应为 0，出现即两边有一边写错）
    notUniqueFull: 0, // 门 0：全候选仍有多解
    overbudgetFull: 0, // 门 0：连最紧的题面都数不完预算
    pencilStuckFull: 0, // 门 1：全候选铅笔推不完
    loopsAccepted: 0, // 过了门 0/1 的环数 = rejectedByMinimal + (出货 ? 1 : 0)
    rejectedByMinimal: 0, // 门 2：挖珠撞预算 ⇒ 那颗珠子是"预算逼着留的"而非"证过必要的" ⇒ 整条环作废
    dropTried: 0,
    dropKept: 0, // 真正挖掉的珠子数（= 候选数 − 出货珠数）
    dropByPencil: 0,
    dropByCounter: 0,
    dropByOverbudget: 0, // 珠级：被预算逼着放回去的珠子（严格模式下整条环会因此作废）
    dropByMismatch: 0, // 铅笔定出来的环和参考环不一致（应为 0）
    dropByColor: 0, // 为了让黑白两种珠子都留一颗而不挖（opts.requireBothColors）
    msLoop: 0,
    msGate: 0,
    msDig: 0,
    msTotal: 0,
  };
}

// 造一题。opts: { maxTrials=40, budget=400000, requireBothColors=false, strictMinimal=true, now=null, loopOpts }
// strictMinimal 默认开；能关掉它的只有 tools/balance.mjs 的 --dose=minimal（把门 2 摘掉，
// 好证明这条红线真的咬得住）。出货路径 js/main.js 从不传它，所以"每颗珠子都证过删不得"没有第二条实现。
export function makePuzzle(seed, sizeKey = '8x8', opts = {}) {
  const { w, h } = parseSize(sizeKey);
  const budget = opts.budget ?? 400_000;
  const maxTrials = opts.maxTrials ?? 40;
  const requireBothColors = opts.requireBothColors ?? false;
  const strictMinimal = opts.strictMinimal !== false;
  const clock = opts.now || null;
  const lap = clock ? () => clock() : () => 0;
  const st = newStats();
  const t00 = lap();
  let accepted = null;

  for (let t = 0; t < maxTrials; t++) {
    st.trials++;
    const tA = lap();
    const lr = randomLoop(w, h, `${seed}|loop#${t}`, opts.loopOpts);
    st.msLoop += lap() - tA;
    if (!lr.ok) {
      st.illegalLoop++;
      continue;
    }
    const cand = candidatesOf(w, h, lr.edges);
    const pz = { w, h, pearls: cand.pearls };
    // 自证：参考环必须同时通过两套独立校验（loop.js 的 checkLoop 与 counter.js 的 satisfies）
    if (!checkLoop(w, h, lr.edges).ok || !satisfies(w, h, cand.pearls, lr.edges)) {
      st.refRejected++;
      continue;
    }
    const tB = lap();
    const g = solveGate(pz, lr.edges, budget, st);
    st.msGate += lap() - tB;
    if (g.counter === 'OVERBUDGET') {
      st.overbudgetFull++;
      continue;
    }
    if (g.counter !== 'UNIQUE') {
      st.notUniqueFull++;
      continue;
    }
    if (g.pencil !== 'solved') {
      st.pencilStuckFull++;
      continue;
    }
    st.loopsAccepted++;
    // 门 2：挖珠。挖珠顺序只由 seed 决定（串里没有 trial 号），所以"重试了几条环"不会连带改答案；
    // tools/counter-test.mjs ④ 正是照这条串复刻整个挖珠过程的。
    const tDig = lap();
    const dig = digPearls({ w, h, cand, refEdges: lr.edges, digKey: `${seed}|dig|${w}x${h}`, budget, st, requireBothColors, strictMinimal });
    st.msDig += lap() - tDig;
    if (dig.budgetForced && strictMinimal) {
      st.rejectedByMinimal++; // 有一颗珠子只是"预算逼着留下的" ⇒ 整条环作废，回 ① 重抽
      continue;
    }
    accepted = { lr, cand, pearls: dig.pearls, black: dig.black, white: dig.white, tally: dig.tally };
    break;
  }

  if (!accepted) {
    st.msTotal = lap() - t00;
    return { ok: false, status: 'no-loop', seed, sizeKey, w, h, stats: st };
  }

  const pearls = accepted.pearls;
  const edges = accepted.lr.edges;
  st.msTotal = lap() - t00;
  return {
    ok: true,
    status: 'ok',
    seed,
    sizeKey,
    w,
    h,
    pearls,
    black: accepted.black,
    white: accepted.white,
    pearlCount: accepted.black + accepted.white,
    candidateCount: accepted.cand.total,
    // 出货那条环的挖珠账（盘级）：严格模式下 byOverbudget 必为 0，balance 逐样本核对这句话。
    minimality: accepted.tally,
    loopLength: accepted.lr.length,
    solution: edges, // 0/1 的环边数组：参考环本体，round 2 拿来判对错
    fingerprint: fingerprint(w, h, pearls, edges),
    stats: st,
  };
}

// ── 门 2：挖珠 ──────────────────────────────────────────────────────────
// 每颗珠子试删之后只有五种下场，三种"放回去"里前两种是**证据**、最后一种是**没有证据**：
//   推不完 ⇒ dropByPencil（删了就推不到底，这颗证过必要）
//   不唯一 ⇒ dropByCounter（删了就不止一个解，这颗证过必要）
//   推完却定出另一条环 ⇒ dropByMismatch（应为 0）
//   数不完（OVERBUDGET）⇒ dropByOverbudget：超预算既不等于"删得掉"也不等于"删不得"。
//     严格模式（出货路径）在这里就收工——这条环已经废了，剩下的珠子再问也是白问；
//     "作废"的判据与早不早停无关，所以早停不改任何一张出货的盘，只省下必丢的那半截工。
//   requireBothColors 的"黑白各留一颗"根本没试删（不占 dropTried），所以它不在这本账里。
// 两本账都要能自检（balance / generator-probe 逐样本核对）：
//   珠级 dropTried = dropKept + dropByPencil + dropByCounter + dropByOverbudget + dropByMismatch
//   盘级 trials = illegalLoop + refRejected + notUniqueFull + overbudgetFull + pencilStuckFull + loopsAccepted
//        且 loopsAccepted = rejectedByMinimal + (出货 ? 1 : 0)
function digPearls({ w, h, cand, refEdges, digKey, budget, st, requireBothColors, strictMinimal }) {
  const pearls = Int8Array.from(cand.pearls);
  const cells = [];
  for (let i = 0; i < pearls.length; i++) if (pearls[i]) cells.push(i);
  const order = makeRng(digKey).shuffle(cells); // 顺序只由 rng 决定，不由 Map 迭代序决定
  let blackLeft = cand.black;
  let whiteLeft = cand.white;
  let budgetForced = 0;
  // 这一本"珠级账"单独抄一份出来（st 是跨条环累计的，光看 st 分不出"出货那条环"的账）
  const mark = { dropTried: st.dropTried, dropKept: st.dropKept, dropByPencil: st.dropByPencil, dropByCounter: st.dropByCounter, dropByMismatch: st.dropByMismatch };
  for (const cell of order) {
    const saved = pearls[cell];
    const isBlack = saved === BLACK;
    pearls[cell] = NONE;
    const afterB = blackLeft - (isBlack ? 1 : 0);
    const afterW = whiteLeft - (isBlack ? 0 : 1);
    if (requireBothColors && (afterB === 0 || afterW === 0)) {
      pearls[cell] = saved;
      st.dropByColor++;
      continue;
    }
    st.dropTried++;
    const g = solveGate({ w, h, pearls }, refEdges, budget, st);
    if (g.pencil !== 'solved') {
      pearls[cell] = saved;
      st.dropByPencil++;
      continue;
    }
    if (g.counter === 'OVERBUDGET') {
      pearls[cell] = saved;
      st.dropByOverbudget++;
      budgetForced++;
      if (strictMinimal) break; // 这颗珠子给不出"删不得"的证据 ⇒ 交给调用方判这条环的死刑
      continue;
    }
    if (g.counter !== 'UNIQUE') {
      pearls[cell] = saved;
      st.dropByCounter++;
      continue;
    }
    if (g.mismatch) {
      pearls[cell] = saved;
      st.dropByMismatch++;
      continue;
    }
    if (isBlack) blackLeft--;
    else whiteLeft--;
    st.dropKept++;
  }
  return {
    pearls,
    black: blackLeft,
    white: whiteLeft,
    budgetForced,
    tally: {
      tried: st.dropTried - mark.dropTried,
      kept: st.dropKept - mark.dropKept,
      byPencil: st.dropByPencil - mark.dropByPencil,
      byCounter: st.dropByCounter - mark.dropByCounter,
      byOverbudget: budgetForced,
      byMismatch: st.dropByMismatch - mark.dropByMismatch,
    },
  };
}

// 两道门一起跑：铅笔先跑（便宜，且它推不完就直接否），再跑计数器。
// mismatch = 铅笔定出来的环边和参考环不一致——那等于"题面还有第二个解"的另一半证据，必须当失败。
// 顺带把计数器的节点数累加进出参的 stats，census 要看总量。
function solveGate(pz, refEdges, budget, st) {
  const s = solveWithRules(pz);
  if (s.status !== 'solved') return { pencil: s.status, counter: '-', mismatch: false };
  const v = verify(s.state);
  if (!v.ok) return { pencil: 'stuck', counter: '-', mismatch: false };
  let mismatch = false;
  for (let e = 0; e < refEdges.length; e++) {
    const got = s.state.edges[e];
    const want = refEdges[e] ? P_LOOP : P_CUT;
    if (got !== want) mismatch = true;
  }
  const c = countLoops(pz, { budget });
  if (st) st.counterNodes = (st.counterNodes || 0) + c.nodes;
  return { pencil: 'solved', counter: c.status, mismatch, nodes: c.nodes };
}

// 给 round 2 的便捷出口：把题面拆成 UI 好画的形状（不做任何绘制）
export function toView(puzzle) {
  const rows = [];
  for (let r = 0; r < puzzle.h; r++) {
    const row = [];
    for (let c = 0; c < puzzle.w; c++) {
      const p = puzzle.pearls[r * puzzle.w + c];
      row.push(p === BLACK ? 'black' : p === WHITE ? 'white' : null);
    }
    rows.push(row);
  }
  const segs = [];
  for (let r = 0; r < puzzle.h; r++) {
    for (let c = 0; c < puzzle.w; c++) {
      for (const d of [1, 2]) {
        const nb = neighbor(puzzle.w, puzzle.h, r * puzzle.w + c, d);
        if (nb < 0) continue;
        if (puzzle.solution[edgeIdOf(puzzle.w, puzzle.h, r, c, d)]) segs.push([r, c, d === 1 ? 'h' : 'v']);
      }
    }
  }
  return { w: puzzle.w, h: puzzle.h, pearls: rows, segs };
}
