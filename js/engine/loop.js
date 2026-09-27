// 参考环的生成：先有一条合法的闭环，再谈珠子。
//
// 做法是"鼓包 / 缩包"随机行走（inflate / deflate）：
//   · 从一个 2×2 的四格环起步；
//   · 鼓包：找一条环边 u–v，让它在某一侧补出的单位方格另外两角 w、x 都还在环外，
//     于是把 u–v 换成 u–w–x–v。环长 +2；u、v 度数不变（还是 2），w、x 各得 2 条边。
//   · 缩包：反过来的那一步，环长 −2。
// 两个动作都把"一条路径换成绕远两格的路径"，所以"每个环格恰好 2 条环边 + 全环一格连到底"
// 这两条性质是**结构性保证**的（不是事后筛出来的）——checkLoop 只是独立复核。
//
// 网格是二分图，所以环长永远是偶数；起步 4，故所有产出的环长 ∈ {4,6,8,…}。
//
// 本文件不认识珠子，也不含任何推理规则（那是 pencil.js / counter.js 的活，且它们不许 import 这里）。

import { makeRng } from './rng.js';

export const UP = 0;
export const RIGHT = 1;
export const DOWN = 2;
export const LEFT = 3;
export const NONE = 0;
export const BLACK = 1;
export const WHITE = 2;
export const DR = [-1, 0, 1, 0];
export const DC = [0, 1, 0, -1];
export const opp = (d) => d ^ 2;

export function hEdgeCount(w, h) {
  return h * (w - 1);
}
export function edgeCount(w, h) {
  return h * (w - 1) + (h - 1) * w;
}
export function edgeIdOf(w, h, r, c, d) {
  const H = h * (w - 1);
  if (d === RIGHT) return r * (w - 1) + c;
  if (d === LEFT) return r * (w - 1) + (c - 1);
  if (d === DOWN) return H + r * w + c;
  return H + (r - 1) * w + c; // UP
}
export function inBounds(w, h, r, c) {
  return r >= 0 && c >= 0 && r < h && c < w;
}
export function neighbor(w, h, cell, d) {
  const r = Math.floor(cell / w) + DR[d];
  const c = (cell % w) + DC[d];
  return inBounds(w, h, r, c) ? r * w + c : -1;
}
export function dirBetween(w, from, to) {
  const dr = Math.floor(to / w) - Math.floor(from / w);
  const dc = (to % w) - (from % w);
  if (dr === -1) return UP;
  if (dc === 1) return RIGHT;
  if (dr === 1) return DOWN;
  return LEFT;
}

export class LoopBuilder {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.deg = new Uint8Array(w * h);
    this.edges = new Uint8Array(edgeCount(w, h)); // 1 = 在环上
    this.length = 0;
  }

  edge(cell, d) {
    return edgeIdOf(this.w, this.h, Math.floor(cell / this.w), cell % this.w, d);
  }

  addEdge(cell, d) {
    const e = this.edge(cell, d);
    if (this.edges[e]) return false;
    this.edges[e] = 1;
    const n = neighbor(this.w, this.h, cell, d);
    this.deg[cell]++;
    this.deg[n]++;
    this.length++;
    return true;
  }

  removeEdge(cell, d) {
    const e = this.edge(cell, d);
    if (!this.edges[e]) return false;
    this.edges[e] = 0;
    const n = neighbor(this.w, this.h, cell, d);
    this.deg[cell]--;
    this.deg[n]--;
    this.length--;
    return true;
  }

  // 2×2 方格：以 (r,c) 为左上角，四角按顺时针 p0=左上 p1=右上 p2=右下 p3=左下，
  // 四条环边 e0=p0–p1(右) e1=p1–p2(下) e2=p2–p3(左) e3=p3–p0(上)。
  squares() {
    const out = [];
    for (let r = 0; r + 1 < this.h; r++) {
      for (let c = 0; c + 1 < this.w; c++) {
        const w = this.w;
        out.push([r * w + c, r * w + c + 1, (r + 1) * w + c + 1, (r + 1) * w + c]);
      }
    }
    return out;
  }

  // 枚举所有合法的鼓包 / 缩包动作。每个动作 = 一个方格 + 一个 i（被换掉/换回来的那条边的序号）。
  // i 这条边记作 e_i，端点 p_i、p_{i+1}；对面那条边 e_{i+2} 的端点 p_{i+2}、p_{i+3}。
  moves() {
    const out = [];
    for (const sq of this.squares()) {
      for (let i = 0; i < 4; i++) {
        const a = sq[i];
        const b = sq[(i + 1) % 4];
        const c2 = sq[(i + 2) % 4];
        const d2 = sq[(i + 3) % 4];
        const dab = this.dirFromTo(a, b);
        const eab = this.edge(a, dab);
        if (this.edges[eab] && this.deg[c2] === 0 && this.deg[d2] === 0) {
          out.push({ kind: 'inflate', sq, i });
        }
        // 缩包 = 鼓包的逆操作：被踢出环的是 c2、d2 那两格（鼓包时它们是唯一在环外的两格），
        // 所以判据是"另外三条边都在环上、e_i 不在、且 c2/d2 度数恰好 2"——与鼓包严格对称。
        if (!this.edges[eab] && this.deg[c2] === 2 && this.deg[d2] === 2) {
          const eda = this.dirFromTo(d2, a);
          const ecd = this.dirFromTo(c2, d2);
          const ebc = this.dirFromTo(b, c2);
          if (this.edges[this.edge(d2, eda)] && this.edges[this.edge(c2, ecd)] && this.edges[this.edge(b, ebc)]) {
            out.push({ kind: 'deflate', sq, i });
          }
        }
      }
    }
    return out;
  }

  dirFromTo(from, to) {
    return dirBetween(this.w, from, to);
  }

  apply(m) {
    const { sq, i, kind } = m;
    const a = sq[i];
    const b = sq[(i + 1) % 4];
    const c2 = sq[(i + 2) % 4];
    const d2 = sq[(i + 3) % 4];
    if (kind === 'inflate') {
      this.removeEdge(a, this.dirFromTo(a, b));
      this.addEdge(a, this.dirFromTo(a, d2));
      this.addEdge(d2, this.dirFromTo(d2, c2));
      this.addEdge(c2, this.dirFromTo(c2, b));
    } else {
      this.removeEdge(a, this.dirFromTo(a, d2));
      this.removeEdge(d2, this.dirFromTo(d2, c2));
      this.removeEdge(c2, this.dirFromTo(c2, b));
      this.addEdge(a, this.dirFromTo(a, b));
    }
  }

  snapshot() {
    return { edges: this.edges.slice(), deg: this.deg.slice(), length: this.length };
  }

  restore(s) {
    this.edges.set(s.edges);
    this.deg.set(s.deg);
    this.length = s.length;
  }
}

// 独立的复核：不参考生成过程，只看边集，验"每格 0 或 2 条边 + 一条环走到底"。
// 只走真实存在的边：横向边只从 c<w-1 的格出发，纵向边只从 r<h-1 的格出发。
// （少了这个约束会把"第 r 行最右格的 RIGHT"读成第 r+1 行第一条横边——越界幻影边，
//   本文件第一版的复核器就是这么误判了 80% 的合法环，被 loop-probe 当场抓住。）
export function adjacency(w, h, edges) {
  const adj = Array.from({ length: w * h }, () => []);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w - 1; c++) {
      if (!edges[edgeIdOf(w, h, r, c, RIGHT)]) continue;
      adj[r * w + c].push(r * w + c + 1);
      adj[r * w + c + 1].push(r * w + c);
    }
  }
  for (let r = 0; r < h - 1; r++) {
    for (let c = 0; c < w; c++) {
      if (!edges[edgeIdOf(w, h, r, c, DOWN)]) continue;
      adj[r * w + c].push((r + 1) * w + c);
      adj[(r + 1) * w + c].push(r * w + c);
    }
  }
  return adj;
}

// 独立的复核：不参考生成过程，只看边集，验"每格 0 或 2 条边 + 一条环走到底"。
export function checkLoop(w, h, edges) {
  const n = w * h;
  const adj = adjacency(w, h, edges);
  let used = 0;
  for (let cell = 0; cell < n; cell++) {
    if (adj[cell].length === 2) used++;
    else if (adj[cell].length !== 0) return { ok: false, why: `格 ${cell} 度数 ${adj[cell].length}` };
  }
  if (used < 4) return { ok: false, why: `环长 ${used} 太短` };
  const seen = new Uint8Array(n);
  const start = adj.findIndex((a) => a.length === 2);
  let cur = start;
  let prev = -1;
  for (let step = 0; step < used; step++) {
    if (seen[cur]) return { ok: false, why: '提前回到已访问格（不是一条简单环）' };
    seen[cur] = 1;
    const nxt = adj[cur].find((x) => x !== prev);
    prev = cur;
    cur = nxt;
  }
  if (cur !== start) return { ok: false, why: '走不完一圈' };
  for (let cell = 0; cell < n; cell++) if (adj[cell].length === 2 && !seen[cell]) return { ok: false, why: `格 ${cell} 在另一条环上` };
  return { ok: true, length: used };
}

// 环的有序走法：从编号最小的环格出发，沿环走一圈。
export function loopOrder(w, h, edges) {
  const adj = adjacency(w, h, edges);
  const start = adj.findIndex((a) => a.length === 2);
  const order = [start];
  let prev = -1;
  let cur = start;
  while (true) {
    const nxt = adj[cur].find((x) => x !== prev);
    if (nxt === undefined || nxt === start) break;
    order.push(nxt);
    prev = cur;
    cur = nxt;
  }
  return order;
}

const MIN_LEN = 8;

// 这条环上"能放珠子的位置"——纯几何量，不涉及任何推理：
//   · 黑珠候选：这一格拐弯，且沿环的前后两格都直穿（黑珠的文字要求那两格直穿）；
//   · 白珠候选：这一格直穿，且沿环的前后两格里至少一格拐弯（白珠的文字要求前后有一拐）。
// 反过来不成立的格子放了珠子就和参考环矛盾，所以这就是候选的全部。
// 注意：环上一个拐点会把它两侧的格子变成"必须直穿"，于是**相邻的两个拐点都当不了黑珠**——
// 单纯随机行走产出的环爱出"楼梯"（连着拐），候选极少，量出来只有 2% 的环能被自己的全部候选钉死
// （见 tools/loop-probe.mjs 的实测），所以走法要按这个数来挑。
export function candidatesOf(w, h, edges) {
  const order = loopOrder(w, h, edges);
  const L = order.length;
  const turns = new Uint8Array(L);
  for (let i = 0; i < L; i++) {
    const p = order[(i - 1 + L) % L];
    const c2 = order[i];
    const q = order[(i + 1) % L];
    turns[i] = dirBetween(w, p, c2) === dirBetween(w, c2, q) ? 0 : 1;
  }
  const pearls = new Int8Array(w * h);
  let black = 0;
  let white = 0;
  for (let i = 0; i < L; i++) {
    const t = turns[i];
    const pb = turns[(i - 1 + L) % L];
    const pa = turns[(i + 1) % L];
    if (t && !pb && !pa) {
      pearls[order[i]] = BLACK;
      black++;
    } else if (!t && (pb || pa)) {
      pearls[order[i]] = WHITE;
      white++;
    }
  }
  return { order, pearls, black, white, total: black + white, length: L };
}

// 一条随机环：鼓包/缩包随机行走，但每一步在"合法动作"里偏向**放珠位置更多**的那几个
// （只在分数的最前一档里随机挑，不是纯贪心，所以还是会四处游走、不会长成固定花纹）。
// 不做这个偏置的话，随机行走爱产楼梯（相邻拐点），参考环自己的全部候选都钉不住唯一解。
export function randomLoop(w, h, seed, opts = {}) {
  const rng = makeRng(`${seed}|loop|${w}x${h}`);
  const cells = w * h;
  const maxTarget = opts.maxTarget ?? Math.round(cells * (opts.maxFrac ?? 0.8));
  const minTarget = opts.minTarget ?? Math.max(MIN_LEN, Math.round(cells * (opts.minFrac ?? 0.5)));
  // 目标环长：偶数，落在 [minTarget, maxTarget]。分布刻意铺满，不预设"越长越好"。
  const span = Math.max(0, (maxTarget - minTarget) / 2);
  const target = opts.target ?? minTarget + 2 * rng.int(span + 1);
  const builder = new LoopBuilder(w, h);
  // 起步的 2×2 放在随机位置（放死在角上是"环贴着角落长"的第一个来源）
  const r0 = rng.int(h - 1);
  const c0 = rng.int(w - 1);
  const sq0 = [r0 * w + c0, r0 * w + c0 + 1, (r0 + 1) * w + c0 + 1, (r0 + 1) * w + c0];
  builder.addEdge(sq0[0], RIGHT);
  builder.addEdge(sq0[1], DOWN);
  builder.addEdge(sq0[2], LEFT);
  builder.addEdge(sq0[3], UP);

  const steps = opts.steps ?? Math.max(150, cells * 6);
  const breadth = opts.breadth ?? 0.18; // 在分数最好的前 18% 里随机挑
  let inflated = 0;
  let deflated = 0;
  let used = 0;
  for (let s = 0; s < steps; s++) {
    const moves = builder.moves();
    if (!moves.length) break;
    used++;
    let want;
    if (builder.length < target) want = 'inflate';
    else if (builder.length > target) want = 'deflate';
    else want = rng.chance(0.5) ? 'inflate' : 'deflate';
    // 想要的方向没棋可走就退回另一侧（例如已经鼓到最大、只能缩）
    let pool = moves.filter((m) => m.kind === want);
    if (!pool.length) pool = moves;
    let m;
    if (opts.greedy === false || pool.length < 3) {
      m = rng.pick(pool);
    } else {
      // 先把每个动作落完之后的"放珠位置数"算出来存进数组，再按分数排序——
      // 排序里不抽随机数（比较器里一旦有 rng，node 和 Chrome 就会挑出两条不同的环），
      // 所以**先给每个动作预先抽一个随机键**，同分时按随机键定序。
      // 少了这个随机键，同分动作会按下标定序，而按下标就是"从左上往右下数"，
      // 实测把环的占用率压向左上（6×6 左上 0.80 vs 右下 0.57），是看得见的偏。
      const snap = builder.snapshot();
      const keys = pool.map(() => rng.next());
      const scored = pool.map((mm, i) => {
        builder.restore(snap);
        builder.apply(mm);
        return { i, v: candidatesOf(w, h, builder.edges).total, k: keys[i] };
      });
      builder.restore(snap);
      scored.sort((a, b) => b.v - a.v || a.k - b.k);
      const top = scored.slice(0, Math.max(1, Math.round(scored.length * breadth)));
      m = pool[rng.pick(top).i];
    }
    const before = builder.length;
    builder.apply(m);
    if (builder.length > before) inflated++;
    else deflated++;
  }
  const edges = builder.edges;
  const chk = checkLoop(w, h, edges);
  const cand = candidatesOf(w, h, edges);
  return {
    ok: chk.ok,
    w,
    h,
    edges: edges.slice(),
    deg: builder.deg.slice(),
    length: builder.length,
    target,
    inflated,
    deflated,
    steps: used,
    stepsPlanned: steps,
    cand: cand.total,
    black: cand.black,
    white: cand.white,
    reason: chk.ok ? '' : chk.why,
  };
}
