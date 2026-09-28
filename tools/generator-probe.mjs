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
//   ④ 门 2 的三本账逐样本轧平（出货盘的 minimality、盘级 trials、候选=出货+挖掉），
//      以及 seed→题面 的版本护栏：同 seed 两次出题指纹必须逐字节相同，
//      而存档里指纹与当下这张盘不一致时 Store.resume() 不许把笔迹交回去。
//
// 用法：node tools/generator-probe.mjs [尺寸] [每尺寸样本数]
//   默认 6x6..10x10 各 8 盘（实测约 6 秒）；只跑一个尺寸就传尺寸，样本数也认 env.SAMPLES。
//   迭代引擎时把样本压到 2–3（或只跑 6x6），别在调 fixture 的当口跑大批。
// 退出码：0 = 三个"应为 0"的项全 0、账目轧平且全部出货；1 = 有异常。

import { makePuzzle, fingerprint } from '../js/engine/generate.js';
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
  let rejSum = 0; // 门 2 作废的环数合计（rejectedByMinimal）
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
    // 门 2 的账逐样本轧平（恒等式写在 generate.js:189-192）：st 是跨条环累计的，
    // 出货那条环自己的账在 p.minimality 里，严格模式下它不许出现"预算逼着留下的珠子"。
    const bd = p.stats;
    const mini = p.minimality;
    const loopBook = (bd.illegalLoop || 0) + (bd.refRejected || 0) + (bd.notUniqueFull || 0) + (bd.overbudgetFull || 0) + (bd.pencilStuckFull || 0) + bd.loopsAccepted;
    const beadBook = mini.kept + mini.byPencil + mini.byCounter + mini.byOverbudget + mini.byMismatch;
    check(`${sizeKey}#${i} 盘级账轧平（trials = 各门丢的 + loopsAccepted）`, bd.trials === loopBook, `trials=${bd.trials} 账上=${loopBook}`);
    check(`${sizeKey}#${i} loopsAccepted = rejectedByMinimal + 1（出货这一盘）`, bd.loopsAccepted === bd.rejectedByMinimal + 1, `${bd.loopsAccepted} vs ${bd.rejectedByMinimal}+1`);
    check(`${sizeKey}#${i} 出货盘没有"预算逼着留下的珠子"（minimality.byOverbudget = 0）`, mini.byOverbudget === 0, `${mini.byOverbudget}`);
    check(`${sizeKey}#${i} 出货盘挖珠账轧平（tried = kept + 各门拦下）`, mini.tried === beadBook, `tried=${mini.tried} 账上=${beadBook}`);
    check(`${sizeKey}#${i} 候选 = 出货珠 + 挖掉的珠`, p.candidateCount === p.pearlCount + mini.kept, `候选=${p.candidateCount} 出货=${p.pearlCount} 挖掉=${mini.kept}`);
    rejSum += bd.rejectedByMinimal;
  }
  const rounded = Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, k.startsWith('ms') ? Number((v / N).toFixed(1)) : Math.round(v)]));
  console.log(`\n${sizeKey}  ok=${ok}/${N}  avg trials ${(trials / N).toFixed(2)}  avg ms ${(ms / N).toFixed(1)}  max ms ${maxMs.toFixed(1)}  avgPearls ${ok ? (pearls / ok).toFixed(1) : '-'}  avgCand ${ok ? (cand / ok).toFixed(1) : '-'}  avgLoopLen ${ok ? (loopLen / ok).toFixed(1) : '-'}  门2作废 ${rejSum} 条环`);
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

// ── ④ seed→题面 的版本护栏 ───────────────────────────────────────────────
// 存档存的是原始 seed（js/store.js:3-5 那句"同一个 seed 在任何一台机器上都画同一张盘"），
// 它只在同一版生成器里成立。本轮把挖珠变成门 2（严格作废重抽），同一个 seed 画的盘就可能换一条环，
// 于是 saveResume 写进存档的 fingerprint 必须被 resume() 读回来对账：
//   同 seed 连打两次 ⇒ 指纹逐字节相同（确定性，也是 ④b 复刻能成立的前提）；
//   指纹不一致 / 存档里没指纹 ⇒ resume() 返回 null、把这份存档清掉、原因写进 resumeDiscarded；
//   指纹一致 ⇒ 笔迹原样交回去（这才是"续局"而不是"重开一局"）。
console.log('\n④ seed→题面 的版本护栏（确定性 + 指纹对账）');
{
  const seedA = 'probe|guard|A';
  const a1 = makePuzzle(seedA, '7x7', { requireBothColors: true, now: clock });
  const a2 = makePuzzle(seedA, '7x7', { requireBothColors: true, now: clock });
  check('同 seed 两次出题：指纹逐字节相同', a1.fingerprint === a2.fingerprint, `${a1.fingerprint} vs ${a2.fingerprint}`);
  check('出货盘的指纹 = 独立重算（尺寸+珠子+环边）', a1.fingerprint === fingerprint(a1.w, a1.h, a1.pearls, a1.solution), `${a1.fingerprint}`);

  // js/store.js 直接读全局 localStorage（浏览器才有），Node 这边给一个内存版，够它跑对账
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  const { Store } = await import('../js/store.js');
  const { Game } = await import('../js/ui/game.js');

  const game = new Game(a1);
  game.setEdgeById(0, 1); // 玩家画了一笔：续局必须把它带回来
  Store.saveResume(game, 1500);
  const onDisk = JSON.parse(mem.get('masyu.save.v1') || '{}');
  check('存档里确实写着这一盘的指纹', onDisk.resume && onDisk.resume.fingerprint === a1.fingerprint, `${onDisk.resume && onDisk.resume.fingerprint}`);
  check('指纹一致 ⇒ 笔迹交得回去（不是 null）', Store.resume(a1.fingerprint) !== null, 'null');

  game.setEdgeById(0, 0);
  Store.saveResume(game, 1500);
  const b = makePuzzle('probe|guard|B', '7x7', { requireBothColors: true, now: clock });
  const got = Store.resume(b.fingerprint); // 生成器改版后同一个 seed 的另一张盘
  check('指纹不一致 ⇒ 不能续局（返回 null）', got === null, JSON.stringify(got));
  check('不一致时被拒的存档就地清掉（不会下一次再骗人）', Store.data.resume === null, JSON.stringify(Store.data.resume));
  check('拒收原因写进 resumeDiscarded 给 UI 说给玩家听', Store.resumeDiscarded && Store.resumeDiscarded.why === '指纹不一致', JSON.stringify(Store.resumeDiscarded));
  check('清掉之后 pendingResume() 也只读形状，读不出这份废档', Store.pendingResume() === null, '非 null');

  Store.data.resume = { seed: 'probe|guard|A', sizeKey: '7x7', marks: game.encode(), moves: 1, elapsedMs: 1500 }; // 旧版本写的存档：没有指纹字段
  const legacy = Store.resume(a1.fingerprint);
  check('存档里没有指纹字段 ⇒ 同样拒收', legacy === null, JSON.stringify(legacy));
  check('拒收原因分清"没有指纹"和"指纹不一致"', Store.resumeDiscarded && Store.resumeDiscarded.why === '存档里没有指纹', JSON.stringify(Store.resumeDiscarded));
}

console.log(`\n${fails ? `FAIL ${fails} 项` : 'OK'} generator-probe`);
process.exit(fails ? 1 : 0);
