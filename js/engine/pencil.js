// 铅笔推理核：只吃题面（格子尺寸 + 珠子），**不知道答案、不回溯、不猜**。
// 每一条规则都必须是题面规则文字的直接推论，规则名旁边写着它是从哪句话来的。
// 每条规则给出的结论形如"某条边是环边 / 某条边被切断"，并附上人话 why。
//
// 本文件刻意不 import loop.js / counter.js：出题那边先有环再挖珠，推理这边不许偷看，
// 三方（铅笔 / 计数器 / 出题器）互相不信任，共用的只有 rng。
// 几何编码（横边在前、纵边在后）在三个文件里各写一份，是"独立实现"的代价，不是疏忽。
//
// 这里不做任何浮点累加，也不做任何拿浮点当判据的比较：全是整数计数。

export const UNKNOWN = 0;
export const LOOP = 1;
export const CUT = 2;
export const NONE = 0;
export const BLACK = 1;
export const WHITE = 2;

export const UP = 0;
export const RIGHT = 1;
export const DOWN = 2;
export const LEFT = 3;
const DR = [-1, 0, 1, 0];
const DC = [0, 1, 0, -1];
export const opp = (d) => d ^ 2;
export const perp = (d) => [(d + 1) & 3, (d + 3) & 3];

export function hCount(w, h) {
  return h * (w - 1);
}
export function edgeCount(w, h) {
  return h * (w - 1) + (h - 1) * w;
}
function edgeIdOf(st, r, c, d) {
  const { w, h } = st;
  const H = h * (w - 1);
  if (d === RIGHT) return r * (w - 1) + c;
  if (d === LEFT) return r * (w - 1) + (c - 1);
  if (d === DOWN) return H + r * w + c;
  return H + (r - 1) * w + c;
}
export function inBounds(st, r, c) {
  return r >= 0 && c >= 0 && r < st.h && c < st.w;
}
export function neighbor(st, cell, d) {
  const r = Math.floor(cell / st.w) + DR[d];
  const c = (cell % st.w) + DC[d];
  return inBounds(st, r, c) ? r * st.w + c : -1;
}
// 越界（那里根本没有边）返回 -1，和"有边但是被切断"（CUT=2）是两件事，别混。
export function edgeOf(st, cell, d) {
  const n = neighbor(st, cell, d);
  return n < 0 ? -1 : edgeIdOf(st, Math.floor(cell / st.w), cell % st.w, d);
}
export function valOf(st, cell, d) {
  const e = edgeOf(st, cell, d);
  return e < 0 ? -1 : st.edges[e];
}
export function cellName(st, cell) {
  return `R${Math.floor(cell / st.w) + 1}C${cell % st.w + 1}`;
}
export function edgeName(st, e) {
  for (let cell = 0; cell < st.w * st.h; cell++) {
    for (let d = 0; d < 4; d++) if (edgeOf(st, cell, d) === e) return `${cellName(st, cell)}↔${cellName(st, neighbor(st, cell, d))}`;
  }
  return `边#${e}`;
}

export function createState(puzzle) {
  const w = puzzle.w;
  const h = puzzle.h;
  const pearls = new Int8Array(w * h);
  if (typeof puzzle.pearls === 'string') {
    for (let i = 0; i < pearls.length; i++) pearls[i] = puzzle.pearls.charCodeAt(i) - 48;
  } else {
    pearls.set(puzzle.pearls);
  }
  // 预计算每条边连的两格：single-loop 规则要对每条未知边问「两端是不是同一簇」，
  // 现算邻居会把出题器的每一轮推演拖慢一个量级。
  const ecount = edgeCount(w, h);
  const edgeCells = new Array(ecount);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const cell = r * w + c;
      for (const d of [UP, RIGHT, DOWN, LEFT]) {
        const rr = r + DR[d];
        const cc = c + DC[d];
        if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
        const e = edgeIdOf({ w, h }, r, c, d);
        // 同一条边会从两端各登记一次，登记内容一致，无所谓先后
        edgeCells[e] = [cell, rr * w + cc];
      }
    }
  }
  return { w, h, pearls, edges: new Uint8Array(ecount), edgeCells, log: [] };
}

export function pearlList(st) {
  const out = [];
  for (let c = 0; c < st.pearls.length; c++) if (st.pearls[c]) out.push(c);
  return out;
}

export function unknownCount(st) {
  let k = 0;
  for (let e = 0; e < st.edges.length; e++) if (st.edges[e] === UNKNOWN) k++;
  return k;
}

// 环格的两条环边方向（不足两条返回 null）
export function loopDirs(st, cell) {
  const out = [];
  for (let d = 0; d < 4; d++) if (valOf(st, cell, d) === LOOP) out.push(d);
  return out;
}
// 该格四条边的状态是否都已定（越界算已定）
export function fullyDecided(st, cell) {
  for (let d = 0; d < 4; d++) if (valOf(st, cell, d) === UNKNOWN) return false;
  return true;
}
// 该格是不是"拐弯"：两条环边互相垂直。状态没定全时返回 null（说不上）。
export function isTurn(st, cell) {
  const l = loopDirs(st, cell);
  if (l.length !== 2) return null;
  return opp(l[0]) !== l[1];
}

function concl(rule, st, cell, d, value, why) {
  return { rule, cell, dir: d, value, edge: edgeOf(st, cell, d), why };
}
function contra(rule, st, cell, why) {
  return { rule, contradiction: why, cell, why };
}

// ── 规则 ────────────────────────────────────────────────────────────────
// 规则来源全部是题面那三句 + 从它们直推的系里。每条都带 provenance 注释。

const RULES = {
  // 「珠子在环上」+「环上每格恰好两条环边」：珠子那格必须恰好两条环边。
  // 于是：没被切断的边只剩两条时，这两条都只能是环边。
  'pearl-degree'(st) {
    for (let cell = 0; cell < st.pearls.length; cell++) {
      if (!st.pearls[cell]) continue;
      let l = 0;
      const open = [];
      for (let d = 0; d < 4; d++) {
        const v = valOf(st, cell, d);
        if (v === LOOP) l++;
        else if (v === UNKNOWN) open.push(d);
      }
      if (l > 2) return contra('pearl-degree', st, cell, `${cellName(st, cell)} 是珠子却已经挂了 ${l} 条环边，环上每格只能有两条`);
      if (l + open.length < 2) return contra('pearl-degree', st, cell, `${cellName(st, cell)} 是珠子，可它只剩 ${l + open.length} 条可能的边，凑不出两条`);
      if (open.length && l + open.length === 2) {
        return concl('pearl-degree', st, cell, open[0], LOOP, `${cellName(st, cell)} 是珠子必须在环上，${open.length} 条没断的边刚好补满两条，只能全是环边`);
      }
    }
    return null;
  },

  // 「黑珠处拐弯」⇒ 黑珠的两条环边互相垂直 ⇒ 任一条环边的**对面**必定不是环边；
  // 四种拐法（上右、右下、下左、左上）里只剩一种没被排除时，那两条边都是环边。
  'black-turn'(st) {
    for (let cell = 0; cell < st.pearls.length; cell++) {
      if (st.pearls[cell] !== BLACK) continue;
      const l = loopDirs(st, cell);
      if (l.length > 2) return contra('black-turn', st, cell, `${cellName(st, cell)} 是黑珠，却挂了 ${l.length} 条环边`);
      if (l.length === 2) {
        if (opp(l[0]) === l[1]) return contra('black-turn', st, cell, `${cellName(st, cell)} 是黑珠，可环边 ${DIR_NAME[l[0]]}/${DIR_NAME[l[1]]} 成了一条直线，没拐弯`);
        continue;
      }
      if (l.length === 1) {
        const d = l[0];
        if (valOf(st, cell, opp(d)) === UNKNOWN) {
          return concl('black-turn', st, cell, opp(d), CUT, `${cellName(st, cell)} 是黑珠要拐弯，往 ${DIR_NAME[d]} 进来的环边不可能再从 ${DIR_NAME[opp(d)]} 直穿出去`);
        }
      }
      const pairs = [];
      for (let d = 0; d < 4; d++) {
        for (const p of perp(d)) {
          if (p < d) continue;
          const a = valOf(st, cell, d);
          const b = valOf(st, cell, p);
          if (a === UNKNOWN && b === UNKNOWN) pairs.push([d, p]);
          else if (l.length === 1 && (a === LOOP || b === LOOP) && a !== CUT && b !== CUT) pairs.push([d, p]);
        }
      }
      const cand = l.length === 1 ? pairs.filter(([a, b]) => a === l[0] || b === l[0]) : pairs;
      if (cand.length === 0) return contra('black-turn', st, cell, `${cellName(st, cell)} 是黑珠，但${l.length ? '含已有环边的' : ''}四种拐法全被排除了`);
      if (cand.length === 1) {
        const [a, b] = cand[0];
        const t = valOf(st, cell, a) === UNKNOWN ? a : valOf(st, cell, b) === UNKNOWN ? b : -1;
        if (t >= 0) return concl('black-turn', st, cell, t, LOOP, `${cellName(st, cell)} 是黑珠，${l.length === 1 ? `配得上已有环边的` : ''}只剩 ${DIR_NAME[a]}↔${DIR_NAME[b]} 这一种拐法还没被排除`);
      }
    }
    return null;
  },

  // 「白珠直行」⇒ 白珠的两条环边成一条直线 ⇒ 一条定了另一条同进同退（是环边则对面也是、被切则对面也切），
  // 两条"直线候选"（横着穿 / 竖着穿）只剩一种时那一条边就是环边。
  'white-straight'(st) {
    for (let cell = 0; cell < st.pearls.length; cell++) {
      if (st.pearls[cell] !== WHITE) continue;
      const lines = [];
      for (let d = 0; d < 2; d++) {
        const o = opp(d);
        const a = valOf(st, cell, d);
        const b = valOf(st, cell, o);
        if (a === -1 || b === -1) continue;
        if (a === CUT || b === CUT) {
          const other = a === CUT ? o : d;
          if (valOf(st, cell, other) === LOOP) {
            return contra('white-straight', st, cell, `${cellName(st, cell)} 是白珠必须直穿，可 ${DIR_NAME[a === CUT ? d : o]} 已断、${DIR_NAME[other]} 却是环边，一头缺一头多`);
          }
          if (valOf(st, cell, other) === UNKNOWN) {
            return concl('white-straight', st, cell, other, CUT, `${cellName(st, cell)} 是白珠必须直穿，${DIR_NAME[a === CUT ? d : o]} 这条已经断了，穿过去的那头也就断了`);
          }
          continue;
        }
        lines.push([d, o]);
        if (a === LOOP && b === UNKNOWN) return concl('white-straight', st, cell, o, LOOP, `${cellName(st, cell)} 是白珠必须直穿，${DIR_NAME[d]} 既是环边，${DIR_NAME[o]} 也必须是`);
        if (b === LOOP && a === UNKNOWN) return concl('white-straight', st, cell, d, LOOP, `${cellName(st, cell)} 是白珠必须直穿，${DIR_NAME[o]} 既是环边，${DIR_NAME[d]} 也必须是`);
      }
      if (lines.length === 0) return contra('white-straight', st, cell, `${cellName(st, cell)} 是白珠，但横穿/竖穿两条路都被切断了`);
      if (lines.length === 1 && valOf(st, cell, lines[0][0]) === UNKNOWN) {
        return concl('white-straight', st, cell, lines[0][0], LOOP, `${cellName(st, cell)} 是白珠，只剩 ${DIR_NAME[lines[0][0]]}↔${DIR_NAME[lines[0][1]]} 这一条直穿路线`);
      }
    }
    return null;
  },

  // 「黑珠处拐弯，且环**直穿**它进出那两格」。
  // 正向：黑珠 → 邻格 这一步定了，邻格必须继续朝同一方向走（那条边是环边），邻格的另外两条侧边被切断。
  // 反向（同一句话的逆否）：那个方向出界或已经断了 ⇒ 黑珠朝这条边的走法不成立 ⇒ 切断。
  'black-straight'(st) {
    for (let cell = 0; cell < st.pearls.length; cell++) {
      if (st.pearls[cell] !== BLACK) continue;
      for (let d = 0; d < 4; d++) {
        const v = valOf(st, cell, d);
        const n = neighbor(st, cell, d);
        if (n < 0) continue;
        if (v === LOOP) {
          const m = neighbor(st, n, d);
          if (m < 0) return contra('black-straight', st, cell, `${cellName(st, cell)} 是黑珠，往 ${DIR_NAME[d]} 出去的那格已经在边界上，没法直穿`);
          const after = valOf(st, n, d);
          if (after === CUT) return contra('black-straight', st, cell, `${cellName(st, cell)} 的黑珠要求 ${cellName(st, n)} 直穿，可 ${DIR_NAME[d]} 那头已经断了`);
          if (after === UNKNOWN) {
            return concl('black-straight', st, n, d, LOOP, `${cellName(st, cell)} 是黑珠，紧挨着的 ${cellName(st, n)} 必须直穿过去`);
          }
          for (const p of perp(d)) {
            if (valOf(st, n, p) === UNKNOWN) {
              return concl('black-straight', st, n, p, CUT, `${cellName(st, n)} 在黑珠 ${cellName(st, cell)} 旁边，必须直穿，侧边的 ${DIR_NAME[p]} 不能是环边`);
            }
          }
        } else if (v === UNKNOWN) {
          const m = neighbor(st, n, d);
          if (m < 0 || valOf(st, n, d) === CUT) {
            return concl('black-straight', st, cell, d, CUT, `${cellName(st, cell)} 是黑珠，往 ${DIR_NAME[d]} 走的话 ${cellName(st, n)} 得直穿，可那个方向${m < 0 ? '出了棋盘' : '已经断了'}`);
          }
        }
      }
    }
    return null;
  },

  // 「白珠直行，且它前一格或后一格里至少有一格拐弯」。
  // 于是：直行线后端那格已经查过、确认是直穿 ⇒ 前端那格必须拐 ⇒ 它"再往前直走"的那条边切断。
  'white-turn'(st) {
    for (let cell = 0; cell < st.pearls.length; cell++) {
      if (st.pearls[cell] !== WHITE) continue;
      let line = null;
      for (let d = 0; d < 2; d++) {
        if (valOf(st, cell, d) === LOOP && valOf(st, cell, opp(d)) === LOOP) line = d;
      }
      if (line === null) continue;
      const back = neighbor(st, cell, opp(line));
      const fwd = neighbor(st, cell, line);
      const backStraight = back >= 0 && fullyDecided(st, back) && isTurn(st, back) === false;
      const fwdStraight = fwd >= 0 && fullyDecided(st, fwd) && isTurn(st, fwd) === false;
      if (backStraight && fwdStraight) {
        return contra('white-turn', st, cell, `${cellName(st, cell)} 是白珠，可它前后两格都是直穿，没人拐弯`);
      }
      if (backStraight && fwd >= 0) {
        if (isTurn(st, fwd) === false) return contra('white-turn', st, cell, `${cellName(st, cell)} 前后都不拐弯，白珠的条件没了`);
        if (valOf(st, fwd, line) === UNKNOWN) {
          return concl('white-turn', st, fwd, line, CUT, `${cellName(st, cell)} 是白珠，后端 ${cellName(st, back)} 已确定直穿，前端 ${cellName(st, fwd)} 就必须拐弯，不能继续直走`);
        }
      }
      if (fwdStraight && back >= 0) {
        if (valOf(st, back, opp(line)) === UNKNOWN) {
          return concl('white-turn', st, back, opp(line), CUT, `${cellName(st, cell)} 是白珠，前端 ${cellName(st, fwd)} 已确定直穿，后端 ${cellName(st, back)} 就必须拐弯，不能继续直走`);
        }
      }
    }
    return null;
  },

  // 「环上每一格恰好两条环边」⇒ 已经挂满两条的格子，其余边全部切断。
  'cell-degree-two'(st) {
    for (let cell = 0; cell < st.pearls.length; cell++) {
      let l = 0;
      const open = [];
      for (let d = 0; d < 4; d++) {
        const v = valOf(st, cell, d);
        if (v === LOOP) l++;
        else if (v === UNKNOWN) open.push(d);
      }
      if (l > 2) return contra('cell-degree-two', st, cell, `${cellName(st, cell)} 挂了 ${l} 条环边`);
      if (l === 2 && open.length) {
        return concl('cell-degree-two', st, cell, open[0], CUT, `${cellName(st, cell)} 的两条环边已经满了，剩下的边只能切断`);
      }
    }
    return null;
  },

  // 「断头路」：同一句话（环上每格恰好两条环边）的另外两个方向。
  // ① 一格已经挂了 1 条环边 ⇒ 它在环上 ⇒ 还差 1 条：若只剩 1 条没定的边，那条只能是环边。
  // ② 一格 4 条边里 3 条已断、只剩 1 条没定 ⇒ 那条若是环边，它就成"只挂 1 条边"的死格（除非它是珠子，
  //    那是 pearl-degree 负责的矛盾），所以只能切断。
  // 越界的边不算候选（valOf 返回 -1），所以角上/边上的格也判得对。
  'no-dead-end'(st) {
    for (let cell = 0; cell < st.pearls.length; cell++) {
      let l = 0;
      const open = [];
      for (let d = 0; d < 4; d++) {
        const v = valOf(st, cell, d);
        if (v === LOOP) l++;
        else if (v === UNKNOWN) open.push(d);
      }
      if (l === 1 && open.length === 0) {
        return contra('no-dead-end', st, cell,
          `${cellName(st, cell)} 在环上却只剩 1 条环边，另外三条全断了，凑不出"恰好两条"`);
      }
      if (l === 1 && open.length === 1) {
        return concl('no-dead-end', st, cell, open[0], LOOP,
          `${cellName(st, cell)} 已经挂了 1 条环边，说明它在环上；环上每格两条边，它只剩 ${DIR_NAME[open[0]]} 一条可能，只能补上`);
      }
      if (l === 0 && open.length === 1 && !st.pearls[cell]) {
        return concl('no-dead-end', st, cell, open[0], CUT,
          `${cellName(st, cell)} 四条边里三条已断：最后这条要是环边，它就只剩 1 条环边了，环上没有这种格子`);
      }
    }
    return null;
  },

  // 2×2 的四条边不可能全是环边：那会是一个自成一圈的四格小环。
  // 环必须是**一条**，而四格小环里任何一颗珠子都无法满足（黑珠要邻格直穿、白珠要自己直穿，
  // 小环里每格都在拐），所以只要盘上还有珠子，这个 4 圈就装不下这些珠子 ⇒ 只能切掉第四条。
  'no-2x2-square'(st) {
    if (!pearlList(st).length) return null; // 盘上一颗珠子都没有时这条不成立（本仓库不出这种题）
    for (let r = 0; r + 1 < st.h; r++) {
      for (let c = 0; c + 1 < st.w; c++) {
        const a = r * st.w + c;
        const b = a + 1;
        const d2 = a + st.w + 1;
        const e = a + st.w;
        const ring = [edgeOf(st, a, RIGHT), edgeOf(st, e, RIGHT), edgeOf(st, a, DOWN), edgeOf(st, b, DOWN)];
        const anchors = [a, e, a, b];
        let l = 0;
        const open = [];
        for (let i = 0; i < 4; i++) {
          if (st.edges[ring[i]] === LOOP) l++;
          else if (st.edges[ring[i]] === UNKNOWN) open.push(i);
        }
        if (l === 4) return contra('no-2x2-square', st, a, `${cellName(st, a)} 起的 2×2 四条边全是环边，等于一个孤立的四格小环`);
        if (l === 3 && open.length) {
          return {
            rule: 'no-2x2-square',
            cell: anchors[open[0]],
            edge: ring[open[0]],
            value: CUT,
            why: `${cellName(st, a)} 起的 2×2 已经有三条边在环上，第四条一接就是四格小环，珠子全被关在外面`,
          };
        }
      }
    }
    return null;
  },

  // 「环只有一条」：如果某条未知的边一旦接上，就把环在**这一小撮格子**里闭死，
  // 而盘上还有别的"必须在环上"的格子（任何珠子格、任何已经挂了环边的格子）在外面，那这条边只能切断。
  // 实现：已定环边把格子切成若干簇（每格最多两条环边 ⇒ 每簇是路径或圈）。
  // 一条两端同簇的未知边一接，就把那一整簇闭成圈，簇外的"必在环上"的格子就永远接不进来了。
  // （一次遍历算出所有簇，而不是每条未知边各跑一遍 DFS——出题器要反复上千次，差别是数量级的。）
  'single-loop'(st) {
    const n = st.w * st.h;
    const must = new Uint8Array(n);
    let mustTotal = 0;
    for (let cell = 0; cell < n; cell++) {
      let m = st.pearls[cell] ? 1 : 0;
      if (!m) for (let d = 0; d < 4; d++) if (valOf(st, cell, d) === LOOP) { m = 1; break; }
      must[cell] = m;
      mustTotal += m;
    }
    const comp = new Int16Array(n).fill(-1);
    const compMust = [];
    const compSize = [];
    const compClosed = [];
    let ci = 0;
    for (let cell = 0; cell < n; cell++) {
      if (comp[cell] >= 0) continue;
      const id = ci++;
      comp[cell] = id;
      let cnt = must[cell];
      let size = 1;
      // 这一簇"每格都挂满两条环边"⇒ 它已经是一个圈了（网格是二分图，圈长 ≥4）
      let closed = true;
      const queue = [cell];
      while (queue.length) {
        const x = queue.pop();
        let deg = 0;
        for (let d = 0; d < 4; d++) {
          if (valOf(st, x, d) !== LOOP) continue;
          deg++;
          const y = neighbor(st, x, d);
          if (y >= 0 && comp[y] < 0) {
            comp[y] = id;
            cnt += must[y];
            size++;
            queue.push(y);
          }
        }
        if (deg !== 2) closed = false;
      }
      compMust[id] = cnt;
      compSize[id] = size;
      compClosed[id] = closed && size >= 4;
    }
    if (mustTotal === 0) return null;
    // 矛盾形态（同一句话"环只有一条"）：圈**已经**闭死了，簇外还有必在环上的格子。
    // 圈里每格都已经挂满两条环边，那条环永远接不到圈外的格子 —— 局面已经打脸，不必等 verify。
    for (let cell = 0; cell < n; cell++) {
      const id = comp[cell];
      if (!compClosed[id]) continue;
      if (compMust[id] >= mustTotal) continue; // 必在环上的格子全在圈里，这就是完整答案
      let outside = -1;
      for (let x = 0; x < n; x++) if (must[x] && comp[x] !== id) { outside = x; break; }
      return contra('single-loop', st, cell, `${cellName(st, cell)} 所在的环边簇已经自己闭成一圈（${compSize[id]} 格，每格两条环边），可 ${cellName(st, outside)} 也必须在环上，而环只有一条`);
    }
    for (let e = 0; e < st.edges.length; e++) {
      if (st.edges[e] !== UNKNOWN) continue;
      const [a, b] = st.edgeCells[e];
      if (comp[a] !== comp[b]) continue;
      if (mustTotal <= compMust[comp[a]]) continue; // 必在环上的格子全在这一簇里，闭上就是完整答案
      let outside = -1;
      for (let cell = 0; cell < n; cell++) if (must[cell] && comp[cell] !== comp[a]) { outside = cell; break; }
      return { rule: 'single-loop', cell: a, edge: e, value: CUT, why: `接上 ${cellName(st, a)}↔${cellName(st, b)} 就把环闭死在这一簇里，可 ${cellName(st, outside)} 也必须在环上，而环只有一条` };
    }
    return null;
  },

  // 「环只有一条」的另一面：**没被切断的边**把棋盘分成几块，环只能待在其中一块里。
  // 若某一块（不是整盘）里既没有珠子、也没有任何一条已定的环边，那么这块里的格子一旦上环，
  // 它的两条环边都只能落在块内（块与块之间的边全被切了），于是环在这块里自成一个圈；
  // 可盘上别的块里还有"必在环上"的格子（珠子），一条环不可能同时在两个圈上 ⇒ 这块根本不在环上。
  // 结论：这块里所有还没定的边全部切断。
  'no-island'(st) {
    if (!pearlList(st).length) return null; // 一颗珠子都没有时"别的块里必在环上的格子"无从谈起（本仓库不出这种题）
    const n = st.w * st.h;
    const parent = new Int16Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (x) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    for (let e = 0; e < st.edges.length; e++) {
      if (st.edges[e] === CUT) continue; // 切断的边不通
      const [a, b] = st.edgeCells[e];
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }
    const pearl = new Uint8Array(n);
    const hasLoop = new Uint8Array(n);
    for (let cell = 0; cell < n; cell++) {
      const root = find(cell);
      if (st.pearls[cell]) pearl[root] = 1;
      for (let d = 0; d < 4; d++) if (valOf(st, cell, d) === LOOP) { hasLoop[root] = 1; break; }
    }
    // 矛盾形态（同一句话的两块版本）：环必须经过所有"必在环上"的格子（珠子格、已挂环边的格），
    // 而这些格子分属两块不通的地 —— 两块之间全是被切断的边，环一步都跨不过去，一条环做不到。
    let rootA = -1;
    let cellA = -1;
    for (let cell = 0; cell < n; cell++) {
      let m = st.pearls[cell] ? 1 : 0;
      if (!m) for (let d = 0; d < 4; d++) if (valOf(st, cell, d) === LOOP) { m = 1; break; }
      if (!m) continue;
      const root = find(cell);
      if (rootA < 0) {
        rootA = root;
        cellA = cell;
        continue;
      }
      if (root !== rootA) {
        return contra('no-island', st, cell, `${cellName(st, cellA)} 和 ${cellName(st, cell)} 都被切断的边圈在各自的地里（两块之间没有一条没断的边），可它们都必须在环上，而环只有一条`);
      }
    }
    const seen = new Uint8Array(n);
    let found = null;
    for (let cell = 0; cell < n && !found; cell++) {
      const root = find(cell);
      if (seen[root]) continue;
      seen[root] = 1;
      if (pearl[root] || hasLoop[root]) continue;
      // root 这块地没有任何珠子、没有任何已定环边：整块不在环上。
      // 盘上另有珠子（见上面的 pearlList 兜底），而这块又不是整盘——整盘时所有格子同根，
      // 那颗珠子也必在这一根上，所以走到这里的一定是真·孤岛。
      for (let e = 0; e < st.edges.length; e++) {
        if (st.edges[e] !== UNKNOWN) continue;
        const [a, b] = st.edgeCells[e];
        if (find(a) !== root || find(b) !== root) continue; // 只切块内部的边
        found = { cell: a, edge: e, other: b };
        break;
      }
    }
    if (!found) return null;
    return {
      rule: 'no-island',
      cell: found.cell,
      edge: found.edge,
      value: CUT,
      why: `${cellName(st, found.cell)}↔${cellName(st, found.other)} 连着的那一整块（连同 ${cellName(st, found.cell)}）里一颗珠子都没有、一条环边都没定，外围又全被切断：环要进这块就得在里面自成一圈，别的珠子就够不着了，所以这块根本不在环上`,
    };
  },
};

const DIR_NAME = ['上', '右', '下', '左'];

// 顺序 = 优先级：先做只盯一颗珠子的局部结论，再做整圈/整块的全局结论。
// 顺序不影响正确性（每条规则都单独 sound），只影响"下一步先想到哪条"，所以要固定。
export const RULE_ORDER = [
  'pearl-degree',
  'white-straight',
  'black-turn',
  'black-straight',
  'white-turn',
  'cell-degree-two',
  'no-dead-end',
  'no-2x2-square',
  'single-loop',
  'no-island',
];

export const RULE_TEXT = {
  'pearl-degree': '珠子必须在环上，环上每格恰好两条边',
  'white-straight': '白珠直穿：两条环边成一条直线',
  'black-turn': '黑珠拐弯：两条环边成直角',
  'black-straight': '黑珠两侧那两格必须直穿',
  'white-turn': '白珠前后两格至少一格拐弯',
  'cell-degree-two': '满两条的格子不再加边',
  'no-dead-end': '环上没有只挂一条边的格子：缺一条的补上、只剩一条可能的切断',
  'no-2x2-square': '2×2 四边不能全在环上',
  'single-loop': '环只有一条，不许提前闭死',
  'no-island': '被切断的边圈出的孤岛不在环上：里面没珠子也没环边就整块切断',
};

export function ruleKeys() {
  return RULE_ORDER.slice();
}

// 单条规则跑一遍（tools/rule-test.mjs 用它做"选中性"检查：该发的 case 要发、
// 只差一点的 near-miss case 必须闷——逢发必挂的规则没有选择性）。
export function runRule(key, st) {
  const fn = RULES[key];
  if (!fn) throw new Error(`未知规则 ${key}`);
  const d = fn(st);
  if (!d) return null;
  if (d.contradiction) return { contradiction: d.contradiction, rule: key, cell: d.cell, why: d.why };
  if (d.value === UNKNOWN || d.value === 0 || d.edge < 0) return null; // 规则自己没话可说
  if (st.edges[d.edge] !== UNKNOWN) return null; // 结论已经落过了（不该发生，兜底）
  return { rule: key, ruleText: RULE_TEXT[key], edge: d.edge, dir: d.dir, value: d.value, cell: d.cell, why: d.why };
}

// 下一条被迫的结论。返回：
//   { rule, ruleText, edge, dir, value, cell, why } —— 一条新结论
//   { contradiction, rule, why, cell }              —— 盘上已经自己打脸
//   { stalled: true, unknown, why }                 —— 推不动了（不是错，只是不够）
export function nextDeduction(st) {
  for (const key of RULE_ORDER) {
    const d = runRule(key, st);
    if (!d) continue;
    if (d.contradiction) return { contradiction: d.contradiction, rule: key, why: d.why, cell: d.cell };
    return { rule: key, ruleText: RULE_TEXT[key], edge: d.edge, value: d.value, cell: d.cell, why: d.why };
  }
  return { stalled: true, unknown: unknownCount(st), why: `${RULE_ORDER.length} 条规则轮询一圈，还剩 ${unknownCount(st)} 条边没定` };
}

export function applyDeduction(st, d) {
  st.edges[d.edge] = d.value;
  st.log.push(`${d.rule}: ${d.why}`);
  return st;
}

// 整盘自检：只在推完以后用，不参与推理（不偷看答案）。
export function verify(st) {
  const n = st.w * st.h;
  if (unknownCount(st)) return { ok: false, why: `还有 ${unknownCount(st)} 条边没定` };
  const deg = new Int8Array(n);
  for (let cell = 0; cell < n; cell++) for (let d = 0; d < 4; d++) if (valOf(st, cell, d) === LOOP) deg[cell]++;
  let used = 0;
  for (let cell = 0; cell < n; cell++) {
    if (deg[cell] === 2) used++;
    else if (deg[cell] !== 0) return { ok: false, why: `${cellName(st, cell)} 度数 ${deg[cell]}` };
    if (st.pearls[cell] && deg[cell] !== 2) return { ok: false, why: `${cellName(st, cell)} 是珠子却不在环上` };
  }
  // 环必须是"一条闭环"，而方格图上最短的闭环绕 4 格。空盘（used=0）在下面的走环里会零步收工，
  // 所以这条要写在 verify 里而不是让界面补一个 length>=4 的判据——那样 UI 就偷偷记账定胜负了。
  // 同一个判据在 js/engine/loop.js 的 checkLoop 里写作 used >= 4，两处相互独立，正好互为证人。
  if (used < 4) return { ok: false, why: '环是空的' };
  const seen = new Uint8Array(n);
  let start = deg.findIndex((x) => x === 2);
  let cur = start;
  let prev = -1;
  for (let i = 0; i < used; i++) {
    if (seen[cur]) return { ok: false, why: '提前回到同一个格子' };
    seen[cur] = 1;
    let nxt = -1;
    for (let d = 0; d < 4; d++) {
      if (valOf(st, cur, d) !== LOOP) continue;
      const y = neighbor(st, cur, d);
      if (y !== prev) { nxt = y; break; }
    }
    prev = cur;
    cur = nxt;
  }
  if (cur !== start) return { ok: false, why: '不是一条走到底的环' };
  for (let cell = 0; cell < n; cell++) if (deg[cell] === 2 && !seen[cell]) return { ok: false, why: '有第二段孤立的环' };
  for (let cell = 0; cell < n; cell++) {
    if (!st.pearls[cell]) continue;
    const l = loopDirs(st, cell);
    const turn = opp(l[0]) !== l[1];
    if (st.pearls[cell] === BLACK && !turn) return { ok: false, why: `${cellName(st, cell)} 黑珠没拐` };
    if (st.pearls[cell] === WHITE && turn) return { ok: false, why: `${cellName(st, cell)} 白珠没直穿` };
    if (st.pearls[cell] === BLACK) {
      for (const d of l) {
        const nb = neighbor(st, cell, d);
        const bl = loopDirs(st, nb);
        if (bl.length !== 2 || !bl.includes(d) || !bl.includes(opp(d))) return { ok: false, why: `${cellName(st, cell)} 黑珠旁的 ${cellName(st, nb)} 没直穿` };
      }
    }
    if (st.pearls[cell] === WHITE) {
      const d = l[0];
      const back = neighbor(st, cell, opp(d));
      const fwd = neighbor(st, cell, d);
      const tb = back >= 0 ? isTurnRaw(st, back) : false;
      const tf = fwd >= 0 ? isTurnRaw(st, fwd) : false;
      if (!tb && !tf) return { ok: false, why: `${cellName(st, cell)} 白珠前后都没拐弯` };
    }
  }
  return { ok: true, length: used };
}

function isTurnRaw(st, cell) {
  const l = loopDirs(st, cell);
  return l.length === 2 && opp(l[0]) !== l[1];
}

// 跑到不动为止。zero guessing：只调用 nextDeduction。
// 传题面 {w,h,pearls} 或者已经推了一半的 state 都行。
export function solveWithRules(puzzle, opts = {}) {
  const st = puzzle.edges ? puzzle : createState(puzzle);
  const max = opts.maxSteps ?? 20000;
  const fired = {};
  let steps = 0;
  for (;;) {
    if (steps >= max) return { status: 'stuck', state: st, steps, fired, why: '步数上限' };
    const d = nextDeduction(st);
    if (d.contradiction) return { status: 'contradiction', state: st, steps, fired, rule: d.rule, why: d.why };
    if (d.stalled) {
      const v = verify(st);
      return { status: v.ok ? 'solved' : 'stuck', state: st, steps, fired, verified: v.ok, why: d.why, verifyWhy: v.why };
    }
    fired[d.rule] = (fired[d.rule] || 0) + 1;
    applyDeduction(st, d);
    steps++;
  }
}

// 把当前状态里已定的环边拿出来的便捷出口（给测试和出题器对账用）
export function decidedEdges(st) {
  const out = { loop: [], cut: [], unknown: [] };
  for (let e = 0; e < st.edges.length; e++) out[st.edges[e] === LOOP ? 'loop' : st.edges[e] === CUT ? 'cut' : 'unknown'].push(e);
  return out;
}
