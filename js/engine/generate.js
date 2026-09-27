// 出题器：先有一条参考环，再从环上"长"出珠子，最后把珠子一颗颗挖掉、只留必要的。
//
// 流程（全都只吃 seed，没有 Math.random / Date.now / 任何时钟参与判定）：
//   ① 鼓包/缩包随机行走造一条参考环（loop.js）。
//   ② 门 0：把"全部合法放珠位置"当题面，计数器必须说 UNIQUE。
//      不唯一就整条环丢掉——因为候选集是"闭于子集"的（见下方注释），
//      全集都不唯一的话，任何子集都不唯一，挖下去必然白干。
//   ③ 门 1：同一份题面，铅笔必须在零猜测下推到全满。做不到也整条丢掉。
//   ④ 挖珠：按 rng 定好的顺序逐颗试着删。删掉后"铅笔推得完"且"计数器 UNIQUE（预算内）"
//      才保留；任何一道门没过就把这颗珠子放回去。超预算＝这颗珠子必须留着，
//      所以**最终端出去的题一定是预算内 UNIQUE 的，OVERBUDGET 的候选永远不出货**。
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
    loopsAccepted: 0,
    dropTried: 0,
    dropKept: 0, // 真正挖掉的珠子数（= 候选数 − 出货珠数）
    dropByPencil: 0,
    dropByCounter: 0,
    dropByOverbudget: 0,
    dropByMismatch: 0, // 铅笔定出来的环和参考环不一致（应为 0）
    dropByColor: 0, // 为了让黑白两种珠子都留一颗而不挖（opts.requireBothColors）
    msLoop: 0,
    msGate: 0,
    msDig: 0,
    msTotal: 0,
  };
}

// 造一题。opts: { maxTrials=40, budget=400000, requireBothColors=false, now=null, loopOpts }
export function makePuzzle(seed, sizeKey = '8x8', opts = {}) {
  const { w, h } = parseSize(sizeKey);
  const budget = opts.budget ?? 400_000;
  const maxTrials = opts.maxTrials ?? 40;
  const requireBothColors = opts.requireBothColors ?? false;
  const clock = opts.now || null;
  const lap = clock ? () => clock() : () => 0;
  const st = newStats();
  const t00 = lap();
  // 挖珠顺序用一条跟 seed 绑定的独立随机流，和参考环的流互不干扰：
  // 换一条环不该把挖珠顺序搅乱（否则"重试次数"会连带改答案）。
  const rng = makeRng(`${seed}|dig|${w}x${h}`);
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
    accepted = { lr, cand, pearls: Int8Array.from(cand.pearls) };
    break;
  }

  if (!accepted) {
    st.msTotal = lap() - t00;
    return { ok: false, status: 'no-loop', seed, sizeKey, w, h, stats: st };
  }

  // ── 挖珠 ────────────────────────────────────────────────────────────
  const tDig = lap();
  const cells = [];
  for (let i = 0; i < accepted.pearls.length; i++) if (accepted.pearls[i]) cells.push(i);
  const order = rng.shuffle(cells); // 顺序只由 rng 决定，不由 Map 迭代序决定
  let blackLeft = accepted.cand.black;
  let whiteLeft = accepted.cand.white;
  for (const cell of order) {
    const saved = accepted.pearls[cell];
    const isBlack = saved === BLACK;
    accepted.pearls[cell] = NONE;
    const afterB = blackLeft - (isBlack ? 1 : 0);
    const afterW = whiteLeft - (isBlack ? 0 : 1);
    if (requireBothColors && (afterB === 0 || afterW === 0)) {
      accepted.pearls[cell] = saved;
      st.dropByColor++;
      continue;
    }
    st.dropTried++;
    const g = solveGate({ w, h, pearls: accepted.pearls }, accepted.lr.edges, budget, st);
    if (g.pencil !== 'solved') {
      accepted.pearls[cell] = saved;
      st.dropByPencil++;
      continue;
    }
    if (g.counter === 'OVERBUDGET') {
      accepted.pearls[cell] = saved;
      st.dropByOverbudget++;
      continue;
    }
    if (g.counter !== 'UNIQUE') {
      accepted.pearls[cell] = saved;
      st.dropByCounter++;
      continue;
    }
    if (g.mismatch) {
      accepted.pearls[cell] = saved;
      st.dropByMismatch++;
      continue;
    }
    if (isBlack) blackLeft--;
    else whiteLeft--;
    st.dropKept++;
  }
  st.msDig = lap() - tDig;

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
    black: blackLeft,
    white: whiteLeft,
    pearlCount: blackLeft + whiteLeft,
    candidateCount: accepted.cand.total,
    loopLength: accepted.lr.length,
    solution: edges, // 0/1 的环边数组：参考环本体，round 2 拿来判对错
    fingerprint: fingerprint(w, h, pearls, edges),
    stats: st,
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
