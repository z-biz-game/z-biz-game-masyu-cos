// 铅笔推理核的**可靠性**检查：在真实生成的盘上，铅笔每下一个结论都要和出题器的参考环逐边对上。
//
// 两个数分开报，含义完全不同：
//   推错了 = 结论和参考环矛盾 ⇒ 规则不 sound（**必须为 0**，出现即引擎 bug）
//   推不动 = 规则轮询一圈没话说了 ⇒ 只是不完全，允许，但必须计数、必须打印
// 参考环为什么一定是题面的解？因为出题器的珠子全部长在环的合法放珠位置上，
// 而"放珠判据"只看 (前一格, 本格, 后一格) 的形状 ⇒ 摘掉任何珠子参考环依然是解。
// 所以把珠子随机摘稀再跑铅笔，就是在"铅笔看不见答案"的条件下量它会不会说错话。
//
// 另外两件事：
//   · solveWithRules 在出货盘上必须 status='solved' 且 verify 通过；
//   · verify 作为终局判据：参考环必须收，单边改动必须一律拒（打印喂了多少条、拒对多少条）。
//
// 用法：node tools/pencil-test.mjs [尺寸] [每档样本数]
// 样本数默认很小（SAMPLES / 8），10×10 请自己按需放大 —— 这块工具能量到分钟级。
// 退出码：0 = 全部通过；1 = 有失败。

import { makePuzzle } from '../js/engine/generate.js';
import { createState, nextDeduction, applyDeduction, solveWithRules, verify, RULE_ORDER, unknownCount, LOOP, CUT } from '../js/engine/pencil.js';
import { candidatesOf, checkLoop } from '../js/engine/loop.js';
import { satisfies } from '../js/engine/counter.js';
import { makeRng } from '../js/engine/rng.js';

const SIZES = process.argv[2] ? [process.argv[2]] : ['6x6', '8x8'];
const SAMPLES = Number(process.env.SAMPLES || process.argv[3] || 8);
const SUBSETS_PER_BOARD = Number(process.env.SUBSETS || 12);

let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) {
    fails++;
    console.log(`FAIL  ${name}${detail ? '  ' + detail : ''}`);
  }
};

// 参考环的边值：1 = 环边，0 = 不在环上（出题器 solution 就是这个形状）
const wantOf = (ref, e) => (ref[e] ? LOOP : CUT);

// 从零开始一步步跑铅笔，逐条结论和参考环对账。
// "推不动"只看**还有边没定**（规则轮询一圈没话说、但盘已推满是正常收工，不算不完全）。
// 返回 { wrong, contra, stuck, unknown, steps, fired, firstWrong }
function walkWithReference(w, h, pearls, ref, maxSteps = 5000) {
  const st = createState({ w, h, pearls });
  let wrong = 0;
  let contra = 0;
  let steps = 0;
  const fired = {};
  const firstWrong = [];
  for (;;) {
    if (steps >= maxSteps) return { wrong, contra, stuck: unknownCount(st) > 0, unknown: unknownCount(st), steps, fired, firstWrong, why: '步数上限' };
    const d = nextDeduction(st);
    if (d.contradiction) {
      // 参考环就在题面里 ⇒ 说"打脸了"而参考环却合法 ⇒ 这条矛盾本身是错的
      contra++;
      wrong++;
      if (firstWrong.length < 3) firstWrong.push(`矛盾（参考环却是题面的解）：${d.rule}: ${d.why}`);
      return { wrong, contra, stuck: true, unknown: unknownCount(st), steps, fired, firstWrong, why: d.why };
    }
    if (d.stalled) return { wrong, contra, stuck: unknownCount(st) > 0, unknown: unknownCount(st), steps, fired, firstWrong, why: d.why };
    fired[d.rule] = (fired[d.rule] || 0) + 1;
    if (st.edges[d.edge] !== 0) {
      wrong++;
      if (firstWrong.length < 3) firstWrong.push(`规则要改一条已定的边 #${d.edge}`);
    }
    if (d.value !== wantOf(ref, d.edge)) {
      wrong++;
      if (firstWrong.length < 3) firstWrong.push(`${d.rule} 判边#${d.edge}=${d.value === LOOP ? 'LOOP' : 'CUT'}，参考环是 ${ref[d.edge] ? 'LOOP' : 'CUT'}：${d.why}`);
    }
    applyDeduction(st, d);
    steps++;
  }
}

// 终局态逐边对账（比逐结论更严：铅笔写下的每一条边都得和参考环一样）
function compareState(st, ref) {
  let bad = 0;
  for (let e = 0; e < ref.length; e++) {
    if (st.edges[e] === 0) continue; // 没定，不算错
    if (st.edges[e] !== wantOf(ref, e)) bad++;
  }
  return bad;
}

const clock = () => Number(process.hrtime.bigint() / 1000n) / 1000;

let boards = 0;
let deductionsChecked = 0;
let totalWrong = 0;
let totalStuck = 0;
let totalRuns = 0;
let shippedSolved = 0;
let shippedMismatch = 0;
let subsetStuck = 0;
let subsetRuns = 0;
let candStuck = 0;
let candRuns = 0;
const firedAll = {};
let mutFed = 0;
let mutCaught = 0;
let flipFed = 0;
let flipAgree = 0;
let flipAccepted = 0;
let verifyAcceptedRef = 0;

for (const sizeKey of SIZES) {
  for (let i = 0; i < SAMPLES; i++) {
    const seed = `pencil|${sizeKey}|${i}`;
    const p = makePuzzle(seed, sizeKey, { requireBothColors: true, now: clock });
    if (!p.ok) {
      check(`${sizeKey} seed=${seed} 出货`, false, `makePuzzle 没出货：${JSON.stringify(p.stats)}`);
      continue;
    }
    boards++;
    const ref = p.solution;
    const cand = candidatesOf(p.w, p.h, ref).pearls;

    // ① 出货题面：铅笔必须推到全满，且每一步都对
    const s = solveWithRules({ w: p.w, h: p.h, pearls: p.pearls });
    if (s.status === 'solved' && s.verified) shippedSolved++;
    const v = verify(s.state);
    const w1 = walkWithReference(p.w, p.h, p.pearls, ref);
    deductionsChecked += w1.steps;
    totalWrong += w1.wrong;
    totalRuns++;
    for (const [k, n] of Object.entries(w1.fired)) firedAll[k] = (firedAll[k] || 0) + n;
    const mismatch = compareState(s.state, ref);
    if (mismatch) shippedMismatch++;
    check(`[${sizeKey}#${i}] solveWithRules 出货盘 status=solved`, s.status === 'solved', `status=${s.status} why=${s.why || ''}`);
    check(`[${sizeKey}#${i}] verify(铅笔终局) 通过`, v.ok, v.why);
    check(`[${sizeKey}#${i}] 铅笔终局与参考环逐边一致`, mismatch === 0, `有 ${mismatch} 条边不一致`);
    check(`[${sizeKey}#${i}] 出货盘逐步对账 推错了=0`, w1.wrong === 0, (w1.firstWrong || []).join(' | '));

    // ② 参考环必须被 verify 收（它是答案，不收就是判据写错了）
    const stRef = createState({ w: p.w, h: p.h, pearls: p.pearls });
    for (let e = 0; e < ref.length; e++) stRef.edges[e] = wantOf(ref, e);
    const vr = verify(stRef);
    if (vr.ok) verifyAcceptedRef++;
    check(`[${sizeKey}#${i}] verify 接受参考环`, vr.ok, vr.why);

    // ②' 退化输入必须被拒：满盘 CUT、无珠 → 走环零步收工。这条判据属于引擎（"环是闭环"的直接读法，
    // loop.js 的 checkLoop 同此），一旦让它退回到界面里补一个 length>=4，UI 就在偷偷记账定胜负了。
    const stNil = createState({ w: p.w, h: p.h, pearls: new Int8Array(p.w * p.h) });
    stNil.edges.fill(CUT);
    const vn = verify(stNil);
    check(`[${sizeKey}#${i}] 空盘（全 CUT、无珠）被 verify 拒绝`, !vn.ok, JSON.stringify(vn));
    const cn = checkLoop(p.w, p.h, new Uint8Array(stRef.edges.length));
    check(`[${sizeKey}#${i}] 空盘在两套独立判据里同见`, !cn.ok, JSON.stringify(cn));

    // ③ 摘稀：出货题面的随机子集 + 全候选集，都是"参考环仍是解"的合法题面
    const rng = makeRng(`${seed}|subset`);
    const pearlCells = [];
    for (let c = 0; c < p.pearls.length; c++) if (p.pearls[c]) pearlCells.push(c);
    const packs = [Int8Array.from(cand)]; // 全候选集（挖珠之前的满题面）
    for (let k = 0; k < SUBSETS_PER_BOARD; k++) {
      // 至少留一颗珠子：零珠盘面下 no-2x2-square / no-island / single-loop 三条全局规则按题目设定
      // 就不该发声（本仓库不出无珠题），拿它计进"推不动"是噪声。
      const keep = rng.shuffle(pearlCells).slice(0, 1 + rng.int(pearlCells.length));
      const arr = new Int8Array(p.w * p.h);
      for (const c of keep) arr[c] = p.pearls[c];
      packs.push(arr);
    }
    for (let pk = 0; pk < packs.length; pk++) {
      const pack = packs[pk];
      // 先把本测试自己的前提钉住：参考环必须是这组珠子的解。前提不成立就是工具（或 candidatesOf）写错了，
      // 不能拿它去怪铅笔。
      const satRef = satisfies(p.w, p.h, pack, ref);
      check(`[${sizeKey}#${i}] 摘稀前提：参考环满足这组珠子（${[...pack].filter((x) => x).length} 颗）`, satRef, 'satisfies=false');
      if (!satRef) continue;
      const r = walkWithReference(p.w, p.h, pack, ref);
      deductionsChecked += r.steps;
      totalWrong += r.wrong;
      totalRuns++;
      subsetRuns++;
      if (r.stuck) {
        totalStuck++;
        if (pk === 0) candStuck++;
        else subsetStuck++;
      }
      if (pk === 0) {
        candRuns++;
        check(`[${sizeKey}#${i}] 满候选题面推得完（门 1 的复述）`, !r.stuck && r.wrong === 0, `剩 ${r.unknown} 条边没定 / 推错 ${r.wrong}：${(r.firstWrong || []).join(' | ')}`);
      }
      if (r.wrong) {
        check(`[${sizeKey}#${i}] 摘稀盘 推错了=0`, false, (r.firstWrong || []).join(' | '));
      }
    }

    // ④ 单边改动：verify 必须一律拒（一条都不能放过，否则 win-check 形同虚设）
    for (let e = 0; e < ref.length; e++) {
      const mutated = Uint8Array.from(ref);
      mutated[e] = mutated[e] ? 0 : 1;
      const st2 = createState({ w: p.w, h: p.h, pearls: p.pearls });
      for (let x = 0; x < mutated.length; x++) st2.edges[x] = wantOf(mutated, x);
      const mv = verify(st2);
      mutFed++;
      if (!mv.ok) mutCaught++;
      else check(`[${sizeKey}#${i}] 单边改动 #${e} 被 verify 收下了`, false, mv.why);
    }

    // ⑤ 度数保持的"整圈翻边"改动：verify 和 counter.satisfies 是两套独立写法，必须逐条同意见
    for (let r = 0; r + 1 < p.h; r++) {
      for (let c = 0; c + 1 < p.w; c++) {
        const H = p.h * (p.w - 1);
        const ids = [r * (p.w - 1) + c, (r + 1) * (p.w - 1) + c, H + r * p.w + c, H + r * p.w + c + 1]; // 2×2 的四条边
        const flipped = Uint8Array.from(ref);
        for (const id of ids) flipped[id] = flipped[id] ? 0 : 1;
        const st3 = createState({ w: p.w, h: p.h, pearls: p.pearls });
        for (let x = 0; x < flipped.length; x++) st3.edges[x] = wantOf(flipped, x);
        const a = verify(st3).ok;
        const b = satisfies(p.w, p.h, p.pearls, flipped);
        flipFed++;
        if (a === b) flipAgree++;
        else check(`[${sizeKey}#${i}] 2×2 翻边 @(${r},${c})：verify=${a} 但 satisfies=${b}`, false);
        if (a) flipAccepted++;
      }
    }
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log(`样本：${SIZES.join(',')} × ${SAMPLES} 盘/档 = ${boards} 盘；每题盘面跑 ${SUBSETS_PER_BOARD + 1} 组摘稀`);
console.log(`逐结论对账：${totalRuns} 次推演 / ${deductionsChecked} 条结论`);
console.log(`  推错了 = ${totalWrong}（必须 0）`);
console.log(`  推不动 = ${totalStuck} 组：满候选 ${candStuck}/${candRuns}（应为 0，出题器门 1 就要求推得完），摘稀 ${subsetStuck}/${subsetRuns - candRuns}（不完全性，允许但必须看见）`);
console.log(`出货盘 solveWithRules solved = ${shippedSolved}/${boards}；逐边不一致的盘 = ${shippedMismatch}`);
console.log(`verify 接受参考环 = ${verifyAcceptedRef}/${boards}`);
console.log(`单边改动：喂 ${mutFed} 条，verify 正确拒掉 ${mutCaught} 条（${mutFed ? ((mutCaught / mutFed) * 100).toFixed(1) : '-'}%）`);
console.log(`2×2 翻边（度数保持）：喂 ${flipFed} 条，verify 与 counter.satisfies 意见一致 ${flipAgree} 条，其中 ${flipAccepted} 条两边都判"仍是合法解"`);
console.log('规则触发次数（出货盘逐步）：', Object.entries(firedAll).map(([k, v]) => `${k}=${v}`).join(' '));
const unfired = RULE_ORDER.filter((k) => !firedAll[k]);
if (unfired.length) console.log(`  这些规则在出货盘上一次都没发过：${unfired.join(', ')}`);

check('推错了 == 0', totalWrong === 0, `${totalWrong} 条结论与参考环矛盾`);
check('每盘都出货', boards === SIZES.length * SAMPLES, `${boards}/${SIZES.length * SAMPLES}`);
check('出货盘全部 solved', shippedSolved === boards, `${shippedSolved}/${boards}`);
check('verify 收参考环', verifyAcceptedRef === boards, `${verifyAcceptedRef}/${boards}`);
check('单边改动 100% 拒收', mutCaught === mutFed && mutFed > 0, `${mutCaught}/${mutFed}`);
check('verify 与 satisfies 在翻边改动上全部一致', flipAgree === flipFed && flipFed > 0, `${flipAgree}/${flipFed}`);
check('摘稀盘确实出现了推不动（否则不完全性没被量到）', subsetStuck > 0, `${subsetStuck}`);

console.log(`\n${fails ? `FAIL ${fails} 项` : 'OK'} pencil-test`);
process.exit(fails ? 1 : 0);
