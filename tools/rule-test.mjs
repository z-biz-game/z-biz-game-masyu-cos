// 逐条规则的"选中性"检查：每条规则都得在一个人工构造的局面上**发一次**，
// 并且在一个只差一点的 near-miss 局面上**不发声**。
// 一条规则如果什么局面都发，它就没有选择性，等于把推理核变成乱枪打鸟——那是 FAIL。
//
// 用法：node tools/rule-test.mjs
// 退出码：0 = 全部通过；1 = 有用例不通过（会列出是哪条规则的哪一类用例）。
//
// 局面的写法：1 基坐标 [行, 列]，方向用 UP/RIGHT/DOWN/LEFT，值用 L(环边)/C(切断)/?(未定)。
// 每个局面只喂给**一条**规则（runRule），所以别的规则会不会发与本题无关。
// 注意：棋盘边缘之外**没有边**（环不能走出棋盘），edgeOf 在那里返回 -1。
// 局面里写了越界的边就是 fixture 自己写错了 —— 不当机（那会盖掉别的用例的结果），
// 而是记一条 FAIL，让"局面写错了"和"规则没发声"一样看得见。

import {
  createState,
  runRule,
  RULE_ORDER,
  RULE_TEXT,
  ruleKeys,
  edgeOf,
  cellName,
  LOOP,
  CUT,
  BLACK,
  WHITE,
  UP,
  RIGHT,
  DOWN,
  LEFT,
} from '../js/engine/pencil.js';

const D = { UP, RIGHT, DOWN, LEFT };
const DN = ['上', '右', '下', '左'];
const V = { L: LOOP, C: CUT };

// 造一个局面：pearls = [[r,c,'B'|'W'], ...]，edges = [[r,c,'UP'|..., 'L'|'C'], ...]
function build(w, h, pearls, edges) {
  const arr = new Int8Array(w * h);
  for (const [r, c, t] of pearls) {
    arr[(r - 1) * w + (c - 1)] = t === 'B' ? BLACK : WHITE;
  }
  const st = createState({ w, h, pearls: arr });
  for (const [r, c, d, v] of edges) {
    const e = edgeOf(st, (r - 1) * w + (c - 1), D[d]);
    if (e < 0) throw new Error(`局面写错了：${name(r, c)} 往 ${d} 没有边`);
    if (st.edges[e] !== 0 && st.edges[e] !== V[v]) throw new Error(`局面自相矛盾：同一条边被写了两次不同值`);
    st.edges[e] = V[v];
  }
  return st;
}
const name = (r, c) => `R${r}C${c}`;

// 用例：{ rule, title, cases: [ { kind: 'fire'|'contra'|'quiet', w, h, pearls, edges, at?, expect? } ] }
// fire  : 必须发声，且结论落在 at=[r,c,dir] 那条边上、值为 expect('L'/'C')
// contra: 必须报矛盾
// quiet : 必须不发声（near-miss）
const CASES = [
  {
    rule: 'pearl-degree',
    title: '珠子格必须凑满两条环边',
    cases: [
      { kind: 'fire', w: 5, h: 5, pearls: [[3, 3, 'B']], edges: [[3, 3, 'UP', 'C'], [3, 3, 'LEFT', 'C']], at: [3, 3, 'RIGHT'], expect: 'L', note: '黑珠只剩两条可能的边，正好补满' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[3, 3, 'B']], edges: [[3, 3, 'UP', 'C']], note: 'near-miss：还剩三条可能，说不上' },
      { kind: 'contra', w: 5, h: 5, pearls: [[3, 3, 'B']], edges: [[3, 3, 'UP', 'C'], [3, 3, 'LEFT', 'C'], [3, 3, 'DOWN', 'C']], note: '黑珠只剩一条可能的边，凑不出两条' },
    ],
  },
  {
    rule: 'white-straight',
    title: '白珠直穿：进出两边成一条直线',
    cases: [
      { kind: 'fire', w: 5, h: 5, pearls: [[3, 3, 'W']], edges: [[3, 3, 'UP', 'L']], at: [3, 3, 'DOWN'], expect: 'L', note: '白珠往上的环边逼出往下那条也是环边' },
      { kind: 'fire', w: 5, h: 5, pearls: [[3, 3, 'W']], edges: [[3, 3, 'LEFT', 'C'], [3, 3, 'RIGHT', 'C']], at: [3, 3, 'UP'], expect: 'L', note: '横着穿不过去了 ⇒ 竖穿是唯一路线 ⇒ 上那条是环边' },
      { kind: 'fire', w: 5, h: 5, pearls: [[3, 3, 'W']], edges: [[3, 3, 'LEFT', 'C']], at: [3, 3, 'RIGHT'], expect: 'C', note: '直穿要两头都在 ⇒ 同一根线上断了一头，另一头也就断了' },
      { kind: 'contra', w: 5, h: 5, pearls: [[3, 3, 'W']], edges: [[3, 3, 'UP', 'L'], [3, 3, 'LEFT', 'C'], [3, 3, 'DOWN', 'C']], note: '白珠必须直穿，可竖线一头是环边一头已断' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[3, 3, 'W']], edges: [[3, 3, 'UP', 'L'], [3, 3, 'DOWN', 'L']], note: 'near-miss：竖穿已经落地，横竖两条线还说不清下一条' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[3, 3, 'W']], edges: [], note: 'near-miss：四条边全没定' },
    ],
  },
  {
    rule: 'black-turn',
    title: '黑珠拐弯：两条环边互相垂直',
    cases: [
      { kind: 'fire', w: 5, h: 5, pearls: [[3, 3, 'B']], edges: [[3, 3, 'UP', 'L']], at: [3, 3, 'DOWN'], expect: 'C', note: '往上进来的黑珠不可能再直穿往下' },
      { kind: 'fire', w: 5, h: 5, pearls: [[3, 3, 'B']], edges: [[3, 3, 'UP', 'L'], [3, 3, 'DOWN', 'C'], [3, 3, 'LEFT', 'C']], at: [3, 3, 'RIGHT'], expect: 'L', note: '只剩右上这一种拐法' },
      { kind: 'contra', w: 5, h: 5, pearls: [[3, 3, 'B']], edges: [[3, 3, 'UP', 'L'], [3, 3, 'DOWN', 'L']], note: '黑珠摆成了一条直线' },
      { kind: 'contra', w: 5, h: 5, pearls: [[3, 3, 'B']], edges: [[3, 3, 'UP', 'C'], [3, 3, 'DOWN', 'C'], [3, 3, 'LEFT', 'C'], [3, 3, 'RIGHT', 'C']], note: '四种拐法全被排除，黑珠没地方拐了' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[3, 3, 'B']], edges: [[3, 3, 'UP', 'L'], [3, 3, 'DOWN', 'C']], note: 'near-miss：左、右两种拐法都还活着' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[3, 3, 'W']], edges: [[3, 3, 'UP', 'L']], note: 'near-miss：同一形状但那是白珠，黑珠规则不该管' },
    ],
  },
  {
    rule: 'black-straight',
    title: '黑珠两侧那两格必须直穿',
    cases: [
      { kind: 'fire', w: 5, h: 5, pearls: [[3, 2, 'B']], edges: [[3, 2, 'UP', 'L']], at: [2, 2, 'UP'], expect: 'L', note: '黑珠上方的格子得继续往上直穿' },
      { kind: 'fire', w: 5, h: 5, pearls: [[3, 2, 'B']], edges: [[3, 2, 'UP', 'L'], [2, 2, 'UP', 'L'], [2, 2, 'LEFT', 'C']], at: [2, 2, 'RIGHT'], expect: 'C', note: '直穿格不许有侧边' },
      { kind: 'fire', w: 4, h: 4, pearls: [[2, 2, 'B']], edges: [], at: [2, 2, 'UP'], expect: 'C', note: '反着推：往上走的话顶格没法直穿，所以黑珠不能往上' },
      { kind: 'contra', w: 5, h: 5, pearls: [[3, 2, 'B']], edges: [[3, 2, 'UP', 'L'], [2, 2, 'UP', 'C']], note: '黑珠往上直穿不了（上方那格往上已经断了）' },
      { kind: 'contra', w: 4, h: 4, pearls: [[2, 2, 'B']], edges: [[2, 2, 'UP', 'L']], note: '黑珠往上出去的那格贴着边界，直穿无从谈起' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[3, 3, 'B']], edges: [], note: 'near-miss：黑珠四条边都还没定，而四个方向都还有两格余量' },
      { kind: 'quiet', w: 4, h: 4, pearls: [[2, 2, 'W']], edges: [], note: 'near-miss：同形状但那是白珠' },
    ],
  },
  {
    rule: 'white-turn',
    title: '白珠前后两格里至少一格拐弯',
    cases: [
      { kind: 'fire', w: 5, h: 5, pearls: [[3, 3, 'W']],
        edges: [[3, 3, 'LEFT', 'L'], [3, 3, 'RIGHT', 'L'], [3, 3, 'UP', 'C'], [3, 3, 'DOWN', 'C'],
          [3, 2, 'LEFT', 'L'], [3, 2, 'UP', 'C'], [3, 2, 'DOWN', 'C']],
        at: [3, 4, 'RIGHT'], expect: 'C', note: '后端已确认直穿，前端就必须拐弯 → 不能再直走' },
      { kind: 'fire', w: 5, h: 5, pearls: [[3, 3, 'W']],
        edges: [[3, 3, 'LEFT', 'L'], [3, 3, 'RIGHT', 'L'], [3, 3, 'UP', 'C'], [3, 3, 'DOWN', 'C'],
          [3, 4, 'RIGHT', 'L'], [3, 4, 'UP', 'C'], [3, 4, 'DOWN', 'C']],
        at: [3, 2, 'LEFT'], expect: 'C', note: '镜像：前端直穿，后端拐弯' },
      { kind: 'contra', w: 5, h: 5, pearls: [[3, 3, 'W']],
        edges: [[3, 3, 'LEFT', 'L'], [3, 3, 'RIGHT', 'L'], [3, 3, 'UP', 'C'], [3, 3, 'DOWN', 'C'],
          [3, 2, 'LEFT', 'L'], [3, 2, 'UP', 'C'], [3, 2, 'DOWN', 'C'],
          [3, 4, 'RIGHT', 'L'], [3, 4, 'UP', 'C'], [3, 4, 'DOWN', 'C']],
        note: '前后两格都直穿，白珠的条件没人满足' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[3, 3, 'W']],
        edges: [[3, 3, 'LEFT', 'L'], [3, 3, 'RIGHT', 'L'], [3, 3, 'UP', 'C'], [3, 3, 'DOWN', 'C'],
          [3, 2, 'UP', 'L'], [3, 2, 'LEFT', 'C'], [3, 2, 'DOWN', 'C'],
          [3, 4, 'RIGHT', 'L'], [3, 4, 'UP', 'C'], [3, 4, 'DOWN', 'C']],
        note: 'near-miss：后端已经拐弯（上+左），白珠条件已满足，前端不用动' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[3, 3, 'W']],
        edges: [[3, 3, 'LEFT', 'L'], [3, 3, 'RIGHT', 'L'], [3, 3, 'UP', 'C'], [3, 3, 'DOWN', 'C'],
          [3, 4, 'UP', 'L'], [3, 4, 'RIGHT', 'C'], [3, 4, 'DOWN', 'C']],
        note: 'near-miss：前端已确定拐弯，后端那条直走边轮不到这条规则断' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[3, 3, 'W']],
        edges: [[3, 3, 'LEFT', 'L'], [3, 3, 'RIGHT', 'C'], [3, 3, 'UP', 'C']],
        note: 'near-miss：白珠自己那条穿线还没定死，前后两格谈不上' },
    ],
  },
  {
    rule: 'cell-degree-two',
    title: '环上每格恰好两条环边：满两条就封边',
    cases: [
      { kind: 'fire', w: 5, h: 5, pearls: [[1, 1, 'B']], edges: [[3, 3, 'UP', 'L'], [3, 3, 'RIGHT', 'L'], [3, 3, 'LEFT', 'C']], at: [3, 3, 'DOWN'], expect: 'C', note: '非珠格挂满两条，第四条只能断' },
      { kind: 'contra', w: 5, h: 5, pearls: [[1, 1, 'B']], edges: [[3, 3, 'UP', 'L'], [3, 3, 'RIGHT', 'L'], [3, 3, 'DOWN', 'L']], note: '一格挂了三条环边' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[1, 1, 'B']], edges: [[3, 3, 'UP', 'L'], [3, 3, 'LEFT', 'C'], [3, 3, 'DOWN', 'C']], note: 'near-miss：只挂了一条，还有两条边可选' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[1, 1, 'B']], edges: [[3, 3, 'UP', 'L'], [3, 3, 'RIGHT', 'L'], [3, 3, 'LEFT', 'C'], [3, 3, 'DOWN', 'C']], note: 'near-miss：满两条且另外两条早就断了，无事可做' },
    ],
  },
  {
    rule: 'no-dead-end',
    title: '环上没有只挂一条边的格子',
    cases: [
      { kind: 'fire', w: 5, h: 5, pearls: [[1, 1, 'B']], edges: [[3, 3, 'UP', 'L'], [3, 3, 'LEFT', 'C'], [3, 3, 'DOWN', 'C']], at: [3, 3, 'RIGHT'], expect: 'L', note: '已在环上的格只剩一条可能 → 那条必是环边' },
      { kind: 'fire', w: 5, h: 5, pearls: [[1, 1, 'B']], edges: [[3, 3, 'LEFT', 'C'], [3, 3, 'DOWN', 'C'], [3, 3, 'RIGHT', 'C']], at: [3, 3, 'UP'], expect: 'C', note: '三条已断的非珠格：第四条若是环边就成断头路 → 断' },
      { kind: 'fire', w: 2, h: 4, pearls: [[1, 1, 'B']], edges: [[4, 2, 'UP', 'C']], at: [4, 2, 'LEFT'], expect: 'C', note: '角上格子只有两条实际边：一条断了，另一条也不能是环边' },
      { kind: 'contra', w: 5, h: 5, pearls: [[1, 1, 'B']], edges: [[3, 3, 'UP', 'L'], [3, 3, 'LEFT', 'C'], [3, 3, 'DOWN', 'C'], [3, 3, 'RIGHT', 'C']], note: '挂了一条边却被三面切断，凑不出两条' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[1, 1, 'B']], edges: [[3, 3, 'UP', 'L'], [3, 3, 'LEFT', 'C']], note: 'near-miss：还差一条但有两处可补' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[1, 1, 'B'], [3, 3, 'W']], edges: [[3, 3, 'LEFT', 'C'], [3, 3, 'DOWN', 'C'], [3, 3, 'RIGHT', 'C']], note: 'near-miss：同样只剩一条可能，但那格是白珠，归 pearl-degree 管' },
      { kind: 'quiet', w: 2, h: 4, pearls: [[1, 1, 'B']], edges: [], note: 'near-miss：角上的格两条边都没定，说不上' },
    ],
  },
  {
    rule: 'no-2x2-square',
    title: '2×2 的四条边不能全在环上',
    cases: [
      { kind: 'fire', w: 5, h: 5, pearls: [[1, 1, 'B']], edges: [[1, 1, 'RIGHT', 'L'], [2, 1, 'RIGHT', 'L'], [1, 1, 'DOWN', 'L']], at: [1, 2, 'DOWN'], expect: 'C', note: '2×2 已有三条环边，第四条一接就是四格小环' },
      { kind: 'contra', w: 5, h: 5, pearls: [[1, 1, 'B']], edges: [[1, 1, 'RIGHT', 'L'], [2, 1, 'RIGHT', 'L'], [1, 1, 'DOWN', 'L'], [1, 2, 'DOWN', 'L']], note: '四条全接上了' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[1, 1, 'B']], edges: [[1, 1, 'RIGHT', 'L'], [2, 1, 'RIGHT', 'L']], note: 'near-miss：只有两条，接不满一圈' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[1, 1, 'B']], edges: [[1, 1, 'RIGHT', 'L'], [2, 1, 'RIGHT', 'L'], [1, 1, 'DOWN', 'L'], [1, 2, 'DOWN', 'C']], note: 'near-miss：第四条早就断了，这个小环接不起来' },
      { kind: 'quiet', w: 5, h: 5, pearls: [], edges: [[1, 1, 'RIGHT', 'L'], [2, 1, 'RIGHT', 'L'], [1, 1, 'DOWN', 'L']], note: 'near-miss：盘上一颗珠子都没有，四格小环本身就是合法答案' },
    ],
  },
  {
    rule: 'single-loop',
    title: '环只有一条：不许提前闭死',
    cases: [
      { kind: 'fire', w: 5, h: 5, pearls: [[1, 4, 'B']],
        edges: [[1, 1, 'RIGHT', 'L'], [1, 2, 'RIGHT', 'L'], [1, 3, 'DOWN', 'L'], [2, 3, 'LEFT', 'L'], [2, 2, 'LEFT', 'L']],
        at: [1, 1, 'DOWN'], expect: 'C', note: '接上就是六格小圈，可 R1C4 的珠子还在圈外' },
      { kind: 'contra', w: 5, h: 5, pearls: [[1, 4, 'B']],
        edges: [[1, 1, 'RIGHT', 'L'], [1, 2, 'RIGHT', 'L'], [1, 3, 'DOWN', 'L'], [2, 3, 'LEFT', 'L'], [2, 2, 'LEFT', 'L'], [1, 1, 'DOWN', 'L'], [1, 2, 'DOWN', 'C']],
        note: '六格小圈已经闭死了，R1C4 的珠子还在圈外，接不上来' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[1, 1, 'W']],
        edges: [[1, 1, 'RIGHT', 'L'], [1, 2, 'RIGHT', 'L'], [1, 3, 'DOWN', 'L'], [2, 3, 'LEFT', 'L'], [2, 2, 'LEFT', 'L']],
        note: 'near-miss：同样的六格路径，但珠子就在这条路径里 —— 接上它就是完整答案' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[1, 4, 'B']],
        edges: [[1, 1, 'RIGHT', 'L'], [1, 2, 'RIGHT', 'L'], [1, 3, 'DOWN', 'L'], [2, 3, 'LEFT', 'L'], [2, 2, 'LEFT', 'L'],
          [1, 1, 'DOWN', 'C'], [1, 2, 'DOWN', 'C']],
        note: 'near-miss：能在这个簇里连成圈的两条边（封口边 + 中间的弦）都断了，规则无事可做' },
    ],
  },
  {
    rule: 'no-island',
    title: '被切断的边圈出的孤岛不在环上',
    cases: [
      { kind: 'fire', w: 5, h: 5, pearls: [[1, 1, 'B']],
        edges: [[4, 4, 'UP', 'C'], [4, 4, 'LEFT', 'C'], [4, 5, 'UP', 'C'], [5, 4, 'LEFT', 'C']],
        expectBlock: [[4, 4, 'RIGHT'], [4, 4, 'DOWN'], [4, 5, 'DOWN'], [5, 4, 'RIGHT']], expect: 'C',
        note: '右下角 2×2 被完全切断、里面既没珠子也没环边 → 块内边全断' },
      { kind: 'contra', w: 5, h: 5, pearls: [[1, 1, 'B'], [5, 5, 'B']],
        edges: [[5, 5, 'UP', 'C'], [5, 5, 'LEFT', 'C']],
        note: '两颗珠子被切断的边分在两块地里，一条环不可能同时在两块里' },
      { kind: 'contra', w: 5, h: 5, pearls: [[1, 1, 'B'], [5, 5, 'W']],
        edges: [[4, 4, 'UP', 'C'], [4, 4, 'LEFT', 'C'], [4, 5, 'UP', 'C'], [5, 4, 'LEFT', 'C']],
        note: '右下角那块地里确实有珠子（R5C5），可它和 R1C4 那边被四面切断：珠子照样上不了环 ⇒ 矛盾' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[1, 1, 'B']],
        edges: [[4, 4, 'UP', 'C'], [4, 4, 'LEFT', 'C'], [4, 5, 'UP', 'C']],
        note: 'near-miss：只差一条边没断（R5C4 左边还通着），右下角就不是孤岛' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[1, 1, 'B']],
        edges: [[3, 3, 'RIGHT', 'C']],
        note: 'near-miss：断了一条边可棋盘还是连成一片，没有块可判' },
      { kind: 'quiet', w: 5, h: 5, pearls: [[1, 1, 'B']],
        edges: [[4, 4, 'UP', 'C'], [4, 4, 'LEFT', 'C'], [4, 5, 'UP', 'C'], [5, 4, 'LEFT', 'C'],
          [4, 4, 'RIGHT', 'C'], [4, 4, 'DOWN', 'C'], [4, 5, 'DOWN', 'C'], [5, 4, 'RIGHT', 'C']],
        note: 'near-miss：那块地早就整块出局（块内每条边都断了），没有可断的边' },
      { kind: 'quiet', w: 5, h: 5, pearls: [],
        edges: [[4, 4, 'UP', 'C'], [4, 4, 'LEFT', 'C'], [4, 5, 'UP', 'C'], [5, 4, 'LEFT', 'C'],
          [1, 1, 'RIGHT', 'L'], [1, 1, 'DOWN', 'L'], [1, 2, 'DOWN', 'L'], [2, 1, 'RIGHT', 'L']],
        note: 'near-miss：盘上没珠子，"别的块里必在环上的格子"就不成立' },
    ],
  },
];

// ── 执行 ────────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures = [];
const fired = {};

function check(ok, label, detail) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(`${label} —— ${detail}`);
    console.log(`  ✗ ${label}\n      ${detail}`);
  }
}

for (const group of CASES) {
  console.log(`\n[${group.rule}] ${group.title}`);
  let nFire = 0;
  let nQuiet = 0;
  let nContra = 0;
  for (const c of group.cases) {
    let st = null;
    let broken = null;
    try {
      st = build(c.w, c.h, c.pearls, c.edges);
    } catch (err) {
      broken = err.message;
    }
    const at = c.at || (c.edges.length ? [c.edges[0][0], c.edges[0][1]] : [1, 1]);
    const where = c.at ? `${name(c.at[0], c.at[1])}→${DN[D[c.at[2]]]}` : '';
    const label = `${c.kind.padEnd(6)} ${name(at[0], at[1])}${where ? ' @' + where : ''} ${(c.note || '').slice(0, 34)}`;
    if (broken) {
      check(false, label, `局面本身写错了：${broken}`);
      continue;
    }
    const r = runRule(group.rule, st);
    if (c.kind === 'quiet') {
      nQuiet++;
      check(r === null, label, r ? `规则居然发声了：${r.why}` : 'ok');
      continue;
    }
    if (c.kind === 'contra') {
      nFire++;
      nContra++;
      check(!!(r && r.contradiction), label, r ? `只给了结论 ${r.value === LOOP ? 'LOOP' : 'CUT'}，没报矛盾` : '规则完全没发声');
      continue;
    }
    nFire++;
    if (!r || r.contradiction) {
      check(false, label, r ? `报的是矛盾：${r.why}` : '规则没发声');
      continue;
    }
    if (c.expectBlock) {
      const okBlock = c.expectBlock.some(([br, bc, bd]) => edgeOf(st, (br - 1) * c.w + (bc - 1), D[bd]) === r.edge);
      check(okBlock && r.value === V[c.expect], label, `结论边不在预期的块内边里（实际 ${r.edge}=${r.value === LOOP ? 'LOOP' : 'CUT'}）：${r.why}`);
    } else {
      const e = edgeOf(st, (c.at[0] - 1) * c.w + (c.at[1] - 1), D[c.at[2]]);
      check(r.edge === e && r.value === V[c.expect], label,
        `预期 ${name(c.at[0], c.at[1])}→${DN[D[c.at[2]]]} = ${c.expect === 'L' ? 'LOOP' : 'CUT'}，实际边#${r.edge}(应边#${e}) = ${r.value === LOOP ? 'LOOP' : 'CUT'}：${r.why}`);
    }
  }
  fired[group.rule] = { nFire, nQuiet, nContra };
  console.log(`  说明 ${r_string(group.rule)}`);
}

function r_string(k) {
  return RULE_TEXT[k];
}

// 覆盖率：RULE_ORDER 里每条都必须有用例
const missing = ruleKeys().filter((k) => !CASES.some((g) => g.rule === k));
console.log('\n[覆盖] 每条规则都要有用例');
check(missing.length === 0, `RULE_ORDER ${RULE_ORDER.length} 条规则全部有用例`, `缺：${missing.join(', ')}`);
const extra = CASES.filter((g) => !RULE_ORDER.includes(g.rule)).map((g) => g.rule);
check(extra.length === 0, '用例里没有已删除的规则', `多：${extra.join(', ')}`);

// 选中性：每条规则都要有 ①至少一个"精确命中预期边+值"的发声用例 ②至少一个矛盾用例
// ③至少一个 near-miss 不发。缺任何一类都不算证到：
// 逢发必挂的规则（缺 ③）等于乱枪打鸟；只会下结论却从不判矛盾的规则（缺 ②）没验过它读得懂"打脸"。
console.log('\n[选择性] 每条规则：fire（精确边+值）/ contra（矛盾）/ quiet（near-miss）三类齐备');
for (const group of CASES) {
  const quiet = group.cases.filter((c) => c.kind === 'quiet').length;
  const fire = group.cases.filter((c) => c.kind === 'fire').length;
  const contra = group.cases.filter((c) => c.kind === 'contra').length;
  const exact = group.cases.filter((c) => c.kind === 'fire' && (c.at || c.expectBlock)).length;
  check(fire >= 1 && contra >= 1 && quiet >= 1 && exact === fire,
    `${group.rule}：${fire} 个 fire（都带预期边+值）/ ${contra} 个 contra / ${quiet} 个 near-miss`,
    '缺一类就不算选中性，或 fire 没写预期的边和值');
}

console.log(`\n合计 ${pass} 条通过，${fail} 条失败`);
console.log('逐规则用例数：', Object.entries(fired).map(([k, v]) => `${k}(发${v.nFire}/ contra ${v.nContra}/ 静${v.nQuiet})`).join(' '));
if (fail) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(' -', f);
}
process.exit(fail ? 1 : 0);
