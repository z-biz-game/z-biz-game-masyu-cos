// 出题器普查（census）：makePuzzle 在真实尺寸上跑一批，把 stats 里的每一项累计出来给人看。
//
// 它回答三个问题：
//   ① 出货率与耗时：每个尺寸 N 个 seed 里成了几个、平均试几条环、平均多少毫秒。
//   ② 两道门各自拦了多少：门 0（全候选盘）notUniqueFull/overbudgetFull、挖珠阶段
//      dropByPencil/dropByCounter/dropByOverbudget/dropByMismatch/dropByColor。
//      dropByCounter 长期是 0 —— 这不是 bug，rule-test/pencil-test/counter-test 里已经解释了原因，
//      这里只负责把它"一直是 0"这件事本身量出来。
//   ③ 只该为 0 的项必须真的是 0：illegalLoop（参考环自己不合法 = loop.js 写错）、
//      refRejected（参考环过不了自己的 satisfies = 两边有一边写错）、
//      dropByMismatch（铅笔推完却定出另一个环 = 铅笔不 sound）。
//
// 用法：node tools/generator-probe.mjs [尺寸] [每尺寸样本数]
//   默认 6x6..10x10 各 8 盘（实测约 17 秒）；只跑一个尺寸就传尺寸，样本数也认 env.SAMPLES。
//   迭代引擎时把样本压到 2–3（或只跑 6x6），别在调 fixture 的当口跑大批。
// 退出码：0 = 三个"应为 0"的项全 0 且全部出货；1 = 有异常。

import { makePuzzle } from '../js/engine/generate.js';
import { solveWithRules, verify } from '../js/engine/pencil.js';
import { satisfies, countLoops } from '../js/engine/counter.js';
import { checkLoop } from '../js/engine/loop.js';

const ALL = ['6x6', '7x7', '8x8', '9x9', '10x10'];
const arg1 = process.argv[2];
const sizes = arg1 && arg1 !== 'all' ? [arg1] : ALL;
const N = Number(process.env.SAMPLES || process.argv[3] || 8);

const clock = () => Number(process.hrtime.bigint() / 1000n) / 1000;
let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) {
    fails++;
    console.log(`FAIL  ${name}${detail ? '  ' + detail : ''}`);
  }
};

console.log(`出题器普查：样本 ${N} / 尺寸 ${sizes.join(', ')}（requireBothColors，预算 400k）`);
for (const sizeKey of sizes) {
  let ok = 0;
  let ms = 0;
  let pearls = 0;
  let cand = 0;
  let trials = 0;
  let loopLen = 0;
  let maxMs = 0;
  const agg = {};
  for (let i = 0; i < N; i++) {
    const p = makePuzzle(`probe|${sizeKey}|${i}`, sizeKey, { now: clock, requireBothColors: true });
    trials += p.stats.trials;
    ms += p.stats.msTotal;
    if (p.stats.msTotal > maxMs) maxMs = p.stats.msTotal;
    for (const [k, v] of Object.entries(p.stats)) {
      if (typeof v === 'number' && k !== 'msTotal') agg[k] = (agg[k] || 0) + v;
    }
    if (!p.ok) continue;
    ok++;
    pearls += p.pearlCount;
    cand += p.candidateCount;
    loopLen += p.loopLength;
    // 出货盘三件独立的事：环合法、铅笔能推完并自证、计数器预算内唯一、参考环过 satisfies
    const s = solveWithRules({ w: p.w, h: p.h, pearls: p.pearls });
    const cl = countLoops({ w: p.w, h: p.h, pearls: p.pearls }, { budget: 400_000 });
    check(`${sizeKey}#${i} 出货盘自检`, checkLoop(p.w, p.h, p.solution).ok && s.status === 'solved' && verify(s.state).ok && cl.status === 'UNIQUE' && satisfies(p.w, p.h, p.pearls, p.solution), `pencil=${s.status} counter=${cl.status}`);
  }
  const rounded = Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, k.startsWith('ms') ? Number((v / N).toFixed(1)) : Math.round(v)]));
  console.log(`\n${sizeKey}  ok=${ok}/${N}  avg trials ${(trials / N).toFixed(2)}  avg ms ${(ms / N).toFixed(1)}  max ms ${maxMs.toFixed(1)}  avgPearls ${ok ? (pearls / ok).toFixed(1) : '-'}  avgCand ${ok ? (cand / ok).toFixed(1) : '-'}  avgLoopLen ${ok ? (loopLen / ok).toFixed(1) : '-'}`);
  console.log(`  stats(累计，ms 类为均值) ${JSON.stringify(rounded)}`);
  check(`${sizeKey} 全部出货`, ok === N, `${ok}/${N}`);
  check(`${sizeKey} illegalLoop = 0`, agg.illegalLoop === 0, `${agg.illegalLoop || 0}`);
  check(`${sizeKey} refRejected = 0`, agg.refRejected === 0, `${agg.refRejected || 0}`);
  check(`${sizeKey} dropByMismatch = 0`, agg.dropByMismatch === 0, `${agg.dropByMismatch || 0}`);
  // 挖珠账目要能轧平：试过的每一颗要么留下要么被某一门拦下（dropByColor 是"根本没试"，不在账内）
  const booked = (agg.dropKept || 0) + (agg.dropByPencil || 0) + (agg.dropByCounter || 0) + (agg.dropByOverbudget || 0) + (agg.dropByMismatch || 0);
  check(`${sizeKey} 挖珠账目轧平（dropTried = dropKept + 各门拦下）`, agg.dropTried === booked, `dropTried=${agg.dropTried} 账上=${booked}`);
  if (ok) {
    const keptRatio = agg.dropKept / (agg.dropKept + pearls);
    console.log(`  挖珠效率：候选 ${(cand / ok).toFixed(1)} 颗 → 出货 ${(pearls / ok).toFixed(1)} 颗（丢弃率 ${(100 * keptRatio).toFixed(0)}%），门 0 丢环 ${(agg.notUniqueFull || 0) + (agg.overbudgetFull || 0)} 次，计数器节点累计 ${agg.counterNodes}`);
  }
}

console.log(`\n${fails ? `FAIL ${fails} 项` : 'OK'} generator-probe`);
process.exit(fails ? 1 : 0);
