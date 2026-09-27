// 独立计数器：穷举所有"每格 0 条或 2 条环边"的边集，逐个数出满足题面规则的闭环。
//
// 它和 pencil.js 互不相干：没有规则表、没有 nextDeduction、不 import 任何同仓库的引擎文件
// （连几何编码都另写一份）。它也不看答案——答案就是它自己找出来的。
// 搜索方式：按行优先给每格挑一个"形状"（不出环 / 6 种两两成对的边），
// 每格的挑选会同时定下它与右邻、下邻之间的边（每条边恰好被决定一次），
// 因此天然覆盖全部可能性，不会漏也不会重。
//
// 剪枝只有两类，且都是**题面文字本身**，不是 pencil.js 的规则：
//   1) 边的取值必须两边一致（一条边不能既是环边又被切断）；
//   2) 已经能算出来的珠子条件（黑珠两侧直穿、白珠前后至少一拐），能当场算就当场算，
//      算不出的挂成"义务"等到邻格定了再算；叶子处再用另一套走法整体复核一遍。
// 叶子复核（satisfies）是按环序走一圈、用"这一格拐不拐"表达规则文字，
// 和增量检查是两种不同的写法——两边不一致就是 bug，counter-test 就是来抓这个的。
//
// 全整数运算，没有浮点累加，也没有拿浮点做判据的比较。

const UP = 0;
const RIGHT = 1;
const DOWN = 2;
const LEFT = 3;
const DR = [-1, 0, 1, 0];
const DC = [0, 1, 0, -1];
const OP = [2, 3, 0, 1];
const BLACK = 1;
const WHITE = 2;

// 一格的 7 种形状：0 = 不在环上；其余是 6 种"两条边"的位掩码
const PAIR_MASKS = [
  (1 << UP) | (1 << DOWN), // 竖着直穿
  (1 << LEFT) | (1 << RIGHT), // 横着直穿
  (1 << UP) | (1 << RIGHT),
  (1 << RIGHT) | (1 << DOWN),
  (1 << DOWN) | (1 << LEFT),
  (1 << LEFT) | (1 << UP),
];
const STRAIGHT = [PAIR_MASKS[0], PAIR_MASKS[1]];
const TURN = PAIR_MASKS.slice(2);
const OPTIONS = [0, ...PAIR_MASKS];
const isTurnMask = (m) => m > 0 && TURN.includes(m);
const bits = (a, b) => (1 << a) | (1 << b);

function normalize(puzzle) {
  const w = puzzle.w;
  const h = puzzle.h;
  const pearls = new Int8Array(w * h);
  if (typeof puzzle.pearls === 'string') for (let i = 0; i < pearls.length; i++) pearls[i] = puzzle.pearls.charCodeAt(i) - 48;
  else pearls.set(puzzle.pearls);
  return { w, h, pearls };
}

// 叶子处的整体复核：按环走一圈，用"拐弯/直穿"直接翻译题面文字。
// 也对外导出，给测试当"第三种写法"用（它和 DFS 的增量判据是两套表达）。
// edges 编码：1 = 环边，其它（0 或 2）= 不在环上。
export function satisfies(w, h, pearls, edges) {
  const n = w * h;
  const H = h * (w - 1);
  const eid = (r, c, d) => (d === RIGHT ? r * (w - 1) + c : d === LEFT ? r * (w - 1) + c - 1 : d === DOWN ? H + r * w + c : H + (r - 1) * w + c);
  const adj = Array.from({ length: n }, () => []);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      for (const d of [RIGHT, DOWN]) {
        const rr = r + DR[d];
        const cc = c + DC[d];
        if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
        // 只认"值恰好是 1"当环边：DFS 传进来的数组里 2 = 切断，拿真值判断会把切断当成环
        // （counter-test 之前，这个洞让参考解自己被判成不合法，count 恒为 0）。
        if (edges[eid(r, c, d)] !== 1) continue;
        adj[r * w + c].push(rr * w + cc);
        adj[rr * w + cc].push(r * w + c);
      }
    }
  }
  let used = 0;
  for (let cell = 0; cell < n; cell++) {
    if (adj[cell].length === 2) used++;
    else if (adj[cell].length !== 0) return false;
    if (pearls[cell] && adj[cell].length !== 2) return false;
  }
  if (used < 4) return false;
  // 一条环走到底
  const order = [];
  const seen = new Uint8Array(n);
  let cur = adj.findIndex((a) => a.length === 2);
  let prev = -1;
  for (let i = 0; i < used; i++) {
    if (seen[cur]) return false;
    seen[cur] = 1;
    order.push(cur);
    const nxt = adj[cur][0] === prev ? adj[cur][1] : adj[cur][0];
    prev = cur;
    cur = nxt;
  }
  if (cur !== order[0]) return false;
  // 环序上的"拐弯"：进来的方向和出去的方向不共线
  const dirTo = (a, b) => {
    const dr = Math.floor(b / w) - Math.floor(a / w);
    const dc = (b % w) - (a % w);
    return dr === -1 ? UP : dc === 1 ? RIGHT : dr === 1 ? DOWN : LEFT;
  };
  const L = order.length;
  const turns = new Uint8Array(L);
  for (let i = 0; i < L; i++) {
    const p = order[(i - 1 + L) % L];
    const c2 = order[i];
    const q = order[(i + 1) % L];
    turns[i] = dirTo(p, c2) === dirTo(c2, q) ? 0 : 1;
  }
  for (let i = 0; i < L; i++) {
    const kind = pearls[order[i]];
    if (!kind) continue;
    const before = turns[(i - 1 + L) % L];
    const after = turns[(i + 1) % L];
    if (kind === BLACK) {
      if (!turns[i]) return false; // 黑珠这一格必须拐弯
      if (before || after) return false; // 进出的那两格必须直穿
    } else {
      if (turns[i]) return false; // 白珠这一格必须直穿
      if (!before && !after) return false; // 前后两格至少一格拐弯
    }
  }
  return true;
}

export function countLoops(puzzle, opts = {}) {
  const { w, h, pearls } = normalize(puzzle);
  const budget = opts.budget ?? 400_000;
  const cap = opts.cap ?? 2;
  const n = w * h;
  const H = h * (w - 1);
  const edges = new Uint8Array(H + (h - 1) * w); // 0 未定 / 1 环边 / 2 切断
  const mask = new Int8Array(n).fill(-1);
  const mustA = new Int8Array(n).fill(-1); // 黑珠压给邻格的"你必须恰好走这两条边"
  const mustB = new Int8Array(n).fill(-1);
  const mustTurn = new Uint8Array(n); // 白珠压给邻格的"你必须拐弯"
  const avail = new Uint8Array(n); // 这格有哪几个方向在盘内
  for (let cell = 0; cell < n; cell++) {
    const r = Math.floor(cell / w);
    const c = cell % w;
    let m = 0;
    for (let d = 0; d < 4; d++) {
      const rr = r + DR[d];
      const cc = c + DC[d];
      if (rr >= 0 && cc >= 0 && rr < h && cc < w) m |= 1 << d;
    }
    avail[cell] = m;
  }
  const nb = (cell, d) => {
    const r = Math.floor(cell / w) + DR[d];
    const c = (cell % w) + DC[d];
    return r < 0 || c < 0 || r >= h || c >= w ? -1 : r * w + c;
  };
  const eid = (cell, d) => {
    const r = Math.floor(cell / w);
    const c = cell % w;
    if (d === RIGHT) return r * (w - 1) + c;
    if (d === LEFT) return r * (w - 1) + c - 1;
    if (d === DOWN) return H + r * w + c;
    return H + (r - 1) * w + c;
  };

  let nodes = 0;
  let count = 0;
  let overbudget = false;
  let peakDepth = 0;
  const solutions = [];

  const obligationOk = (cell, om) => {
    if (mustA[cell] >= 0 && om !== bits(mustA[cell], mustB[cell])) return false;
    if (mustTurn[cell] && !isTurnMask(om)) return false;
    if (pearls[cell] === BLACK && !isTurnMask(om)) return false;
    if (pearls[cell] === WHITE && !STRAIGHT.includes(om)) return false;
    if (pearls[cell] && om === 0) return false;
    return true;
  };

  // 「环只有一条」的剪枝：刚定下 cell 这一格之后，如果已定的环边里出现了一个闭合圈，
  // 而圈外还有任何"必须在环上"的格子（珠子、或者已经挂上环边的格子），这一支就死了——
  // 圈里的格子度数是 2，接不出去，那条环永远连不上这些格子。
  const cycleIsDead = (from) => {
    const cells = [];
    let prev = -1;
    let cur = from;
    for (;;) {
      if (cur === from && cells.length) break;
      if (cur < 0 || mask[cur] < 0) return false; // 走到没定的格子：路还开着
      cells.push(cur);
      let nxt = -1;
      let stepped = false;
      for (let d = 0; d < 4; d++) {
        if (edges[eid(cur, d)] !== 1) continue;
        const y = nb(cur, d);
        if (y === prev) continue;
        nxt = y;
        stepped = true;
      }
      if (!stepped) return false;
      prev = cur;
      cur = nxt;
      if (cells.length > n) return false;
    }
    const inCycle = new Uint8Array(n);
    for (const x of cells) inCycle[x] = 1;
    for (let x = 0; x < n; x++) {
      if (inCycle[x]) continue;
      if (pearls[x]) return true;
      for (let d = 0; d < 4; d++) {
        if (nb(x, d) < 0) continue;
        if (edges[eid(x, d)] === 1) return true; // 这格已经挂了环边，却被关在圈外
      }
    }
    return false;
  };

  const walk = (cell) => {
    if (overbudget || count >= cap) return; // 只要证明"不止一解"就够了，找到 cap 个立刻收工
    if (cell === n) {
      if (satisfies(w, h, pearls, edges)) {
        count++;
        if (opts.collect && solutions.length < opts.collect) solutions.push(edges.slice());
      }
      return;
    }
    if (++nodes > budget) {
      overbudget = true;
      return;
    }
    peakDepth++;
    for (const om of OPTIONS) {
      if (om & ~avail[cell]) continue;
      if (!obligationOk(cell, om)) continue;
      // 落边：这格和四个邻居之间的四条边，在形状里的就是环边，不在的就是切断
      const touched = [];
      let ok = true;
      for (let d = 0; d < 4; d++) {
        if (nb(cell, d) < 0) continue; // 盘外没有边
        const e = eid(cell, d);
        const want = (om >> d) & 1 ? 1 : 2;
        if (edges[e] && edges[e] !== want) {
          ok = false;
          break;
        }
        if (!edges[e]) {
          edges[e] = want;
          touched.push(e);
        }
      }
      if (!ok) {
        for (const e of touched) edges[e] = 0;
        continue;
      }
      mask[cell] = om;
      // 黑珠压义务：两侧那两格必须直穿
      const undoPair = [];
      const undoTurn = [];
      if (pearls[cell] === BLACK && om) {
        for (let d = 0; d < 4 && ok; d++) {
          if (!((om >> d) & 1)) continue;
          const x = nb(cell, d);
          const y = nb(x, d);
          if (y < 0) {
            ok = false;
            break;
          }
          const need = bits(OP[d], d);
          if (mask[x] >= 0) {
            if (mask[x] !== need) ok = false;
          } else if (mustA[x] >= 0) {
            if (mustA[x] !== OP[d] || mustB[x] !== d) ok = false;
          } else {
            mustA[x] = OP[d];
            mustB[x] = d;
            undoPair.push(x);
          }
        }
      }
      // 白珠压义务：前后两格至少一格拐弯
      if (ok && pearls[cell] === WHITE && om) {
        let line = -1;
        for (let d = 0; d < 2; d++) if (om === bits(d, OP[d])) line = d;
        const back = nb(cell, OP[line]);
        const fwd = nb(cell, line);
        const known = (x) => (x < 0 ? false : mask[x] >= 0 ? isTurnMask(mask[x]) : null);
        const bk = known(back);
        const fk = known(fwd);
        // "另一头必须拐弯"是可以被好几颗白珠同时要求的，不是冲突；只有从没压过时才登记（才需要撤销）
        const pushTurn = (x) => {
          if (x < 0) return;
          if (mustTurn[x]) return;
          mustTurn[x] = 1;
          undoTurn.push(x);
        };
        if (bk === false && fk === false) ok = false;
        else if (bk === false && fk === null) pushTurn(fwd);
        if (ok && fk === false && bk === null) pushTurn(back);
      }
      if (ok && cycleIsDead(cell)) ok = false;
      if (ok) walk(cell + 1);
      for (const x of undoTurn) mustTurn[x] = 0;
      for (const x of undoPair) {
        mustA[x] = -1;
        mustB[x] = -1;
      }
      mask[cell] = -1;
      for (const e of touched) edges[e] = 0;
    }
    peakDepth--;
  };

  walk(0);

  // MULTIPLE 的意思就是"数到了 >1"，和 cap 无关：cap 只是"早点收工"的开关。
  // 之前写成 count >= cap，于是把 cap 放大去精确数的时候，40 解会被报成 NONE。
  const status = overbudget ? 'OVERBUDGET' : count > 1 ? 'MULTIPLE' : count === 1 ? 'UNIQUE' : 'NONE';
  return { count, nodes, budget, budgetUsed: nodes, overbudget, status, cap, peakDepth, solutions };
}
