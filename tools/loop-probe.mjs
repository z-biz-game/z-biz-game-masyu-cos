// 一次性探针（throwaway）：在把鼓包/缩包方法用到任何下游代码之前，先量它到底行不行。
// 跑法：node tools/loop-probe.mjs [每档种子数]
//
// 要量四件事：
//   1) 终止性/合法性：每个产出的环都必须过独立复核 checkLoop（度 2 + 一条环走到底）；
//   2) 环长分布：6×6…10×10 各 300+ 种子，看是不是只产某一两个长度；
//   3) 形状是否退化：逐格占用率热力（环是不是贴着角落/边）、质心偏移、去重后的形状数；
//   4) 游走是否"到了目标长度"（早停 = 无路可走）。
import { randomLoop, checkLoop, edgeCount, edgeIdOf, candidatesOf } from '../js/engine/loop.js';
import { countLoops } from '../js/engine/counter.js';

const SAMPLES = Number(process.argv[2] || 300);
// 传 'unique' 就顺带量"这条环的全部候选能不能钉死唯一解"——那正是偏置走法的目的。
const UNIQUE_TEST = process.argv[3] === 'unique';
const SIZES = [
  [6, 6],
  [7, 6],
  [7, 7],
  [8, 7],
  [8, 8],
  [9, 8],
  [9, 9],
  [10, 9],
  [10, 10],
];

// 另一套完全独立的复核（换一种枚举方式 + 并查集数连通块），专门用来抓 checkLoop 自己的洞。
function ownCheck(w, h, edges) {
  const DR = [-1, 0, 1, 0];
  const DC = [0, 1, 0, -1];
  const deg = new Int16Array(w * h);
  const parent = Array.from({ length: w * h }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  let loopEdges = 0;
  for (let cell = 0; cell < w * h; cell++) {
    const r = Math.floor(cell / w);
    const c = cell % w;
    for (let d = 0; d < 4; d++) {
      const rr = r + DR[d];
      const cc = c + DC[d];
      if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
      if (!edges[edgeIdOf(w, h, r, c, d)]) continue;
      loopEdges++;
      deg[cell]++;
      const nb = rr * w + cc;
      const a = find(cell);
      const b = find(nb);
      if (a !== b) parent[a] = b;
    }
  }
  const used = [...deg].filter((x) => x > 0).length;
  for (let i = 0; i < deg.length; i++) if (deg[i] !== 0 && deg[i] !== 2) return { ok: false, why: `格 ${i} 度 ${deg[i]}` };
  if (loopEdges / 2 !== used) return { ok: false, why: `边数 ${loopEdges / 2} ≠ 格数 ${used}` };
  const roots = new Set();
  for (let i = 0; i < deg.length; i++) if (deg[i] === 2) roots.add(find(i));
  if (roots.size !== 1) return { ok: false, why: `连通块 ${roots.size} 个` };
  return { ok: true, length: used };
}

let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) {
    fails++;
    console.log(`FAIL  ${name}${detail ? '  ' + detail : ''}`);
  }
};

const t0 = Date.now();
for (const [w, h] of SIZES) {
  const n = w * h;
  const occ = new Float64Array(n);
  const lens = [];
  const shapes = new Set();
  let bad = 0;
  let earlyStop = 0;
  let oddLen = 0;
  let centroidDist = 0;
  let reachMax = 0;
  const bucket = new Array(10).fill(0); // 环长占格子数的十分位直方图
  let candSum = 0;
  let candMin = 1e9;
  let uniq = 0;
  let multi = 0;
  let over = 0;
  const cellR = (i) => Math.floor(i / w);
  const cellC = (i) => i % w;
  const gcR = (h - 1) / 2;
  const gcC = (w - 1) / 2;
  for (let s = 0; s < SAMPLES; s++) {
    const r = randomLoop(w, h, `probe-${s}`);
    if (!r.ok) {
      bad++;
      continue;
    }
    // 两套互不相干的复核：checkLoop（沿环走一圈）+ ownCheck（并查集数连通块），都要说合法
    const chk = checkLoop(w, h, r.edges);
    const own = ownCheck(w, h, r.edges);
    if (!chk.ok || chk.length !== r.length || !own.ok || own.length !== r.length) {
      bad++;
      console.log(`  非法环 seed=probe-${s} length=${r.length} checkLoop=${chk.ok ? chk.length : chk.why} own=${own.ok ? own.length : own.why}`);
      continue;
    }
    lens.push(r.length);
    if (r.length % 2) oddLen++;
    if (r.steps < r.stepsPlanned - 1) earlyStop++;
    bucket[Math.min(bucket.length - 1, Math.floor((r.length / n) * bucket.length))]++;
    let key = '';
    let cr = 0;
    let cc = 0;
    let used = 0;
    for (let e = 0; e < edgeCount(w, h); e++) if (r.edges[e]) key += e.toString(36) + ',';
    for (let i = 0; i < n; i++) {
      if (r.deg[i] === 2) {
        occ[i]++;
        cr += cellR(i);
        cc += cellC(i);
        used++;
      }
      if (r.deg[i] !== 0 && r.deg[i] !== 2) bad++;
    }
    shapes.add(key);
    candSum += r.cand;
    candMin = Math.min(candMin, r.cand);
    if (UNIQUE_TEST) {
      const cl = countLoops({ w, h, pearls: candidatesOf(w, h, r.edges).pearls }, { budget: 400_000, cap: 2 });
      if (cl.overbudget) over++;
      else if (cl.status === 'UNIQUE') uniq++;
      else multi++;
    }
    centroidDist += Math.hypot(cr / used - gcR, cc / used - gcC);
    reachMax = Math.max(reachMax, used);
  }
  lens.sort((a, b) => a - b);
  const q = (p) => (lens.length ? lens[Math.min(lens.length - 1, Math.floor(p * lens.length))] : 0);
  const mean = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
  // 占用率热力：按四分块看有没有"贴着角落"
  const block = (r0, r1, c0, c1) => {
    let sum = 0;
    let cnt = 0;
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) { sum += occ[r * w + c]; cnt++; }
    return sum / cnt / (lens.length || 1);
  };
  const hh = Math.ceil(h / 2);
  const hw = Math.ceil(w / 2);
  console.log(
    `${w}×${h}  seeds=${SAMPLES} 合法=${lens.length} 坏=${bad} 早停=${earlyStop}` +
      `  长度 mean=${mean.toFixed(1)} p5=${q(0.05)} p25=${q(0.25)} 中位=${q(0.5)} p75=${q(0.75)} p95=${q(0.95)} min=${q(0)} max=${q(0.999)}` +
      `  不同形状=${shapes.size}/${lens.length}  质心偏移=${(centroidDist / (lens.length || 1)).toFixed(2)}` +
      `  象限占用 TL=${block(0, hh, 0, hw).toFixed(2)} TR=${block(0, hh, hw, w).toFixed(2)} BL=${block(hh, h, 0, hw).toFixed(2)} BR=${block(hh, h, hw, w).toFixed(2)}`,
  );
  check(`${w}×${h} 有非法环`, bad === 0);
  check(`${w}×${h} 出现奇数环长（网格是二分图，不可能）`, oddLen === 0, `${oddLen}`);
  console.log(`  候选位置 mean=${(candSum / (lens.length || 1)).toFixed(1)} min=${candMin === 1e9 ? 0 : candMin}` + (UNIQUE_TEST ? `  全部候选跑计数器: UNIQUE=${uniq} MULTIPLE=${multi} OVERBUDGET=${over} / ${lens.length}` : ''));
  const hist = bucket.map((v, i) => `${Math.round((i / bucket.length) * n)}-${Math.round(((i + 1) / bucket.length) * n)}:${v}`).filter((s) => !s.endsWith(':0'));
  console.log(`  长度直方图(占格子数比例分桶) ${hist.join(' ')}`);
  // 形状去重：6×6 的"高候选环"本来就少，300 个种子能撞到 225 种不同环（75%）；
  // 真正要盯的是"别退化成同一种花纹"，所以门槛定 60%，具体数字每档都打印出来。
  check(`${w}×${h} 形状数太少（退化）`, shapes.size >= lens.length * 0.6, `${shapes.size}/${lens.length}`);
  check(`${w}×${h} 环长铺不开（分位跨度 < 6）`, q(0.95) - q(0.05) >= 6, `${q(0.05)}..${q(0.95)}`);
  check(`${w}×${h} 大部分种子早停`, earlyStop <= lens.length * 0.1, `${earlyStop}`);
  const quad = [block(0, hh, 0, hw), block(0, hh, hw, w), block(hh, h, 0, hw), block(hh, h, hw, w)];
  const mx = Math.max(...quad);
  const mn = Math.min(...quad);
  check(`${w}×${h} 象限占用偏斜 > ${'1.6'}`, mx / Math.max(mn, 1e-9) <= 1.6, `max/min=${(mx / Math.max(mn, 1e-9)).toFixed(2)}`);
}
console.log(`\n探针耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(fails ? 1 : 0);
