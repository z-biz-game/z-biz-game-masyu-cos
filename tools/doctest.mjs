// 文档是被断言的面：README / DESIGN 里印出去的每一个「现值」都必须等于代码或闸的现在值。
//
// 为什么要有这个文件：本仓的散文抄的是引擎与工具的读数（67 条断言、十条规则、八档 ×32 = 256 盘、
// steps p50、分数 p50/p95、盘均珠数/候选、门 2 抽废、端口 5276/9376、七个键 / 五档菜单 / 八档…）。
// 引擎断言由 rule-test / pencil-test / counter-test / generator-probe 复测，难度表由 balance 复测，
// 屏幕读数由 verify.sh 在真实 Chrome 里复测 —— 只有「文档抄的数 == 代码或闸的现在值」这一条
// 没有命令守着。散文可以一直抄下去，直到某天代码改了字、文档还在引用上一个世界的数。
//
// 六条规矩（照 z-biz-game-kurotto-cos / z-biz-game-nurikabe-cos 的 doctest 机制走，不自创一套）：
//   1. 每一条等式都配一条「解析到几行」的反空转断言 —— 正则没命中不是绿，是红；
//   2. 期望值只来自代码或现跑的工次，绝不拿文档里的数当基准：文档说谎就在这里红，红了就改文档；
//      唯一允许的例外是「文档同一句里两个数的算术自洽」（如 boot+render+…+hint == 99）；
//   3. 只比现值，不复测读数：ms/秒这类本机墙钟量只以「文档自己写明这一列会漂」的关系出现（D14），
//      绝不重新计时，也不把新测的毫秒写回文档；
//   4. 文档改形状（表格列、句子措辞、引用格式）不算通过的理由：解析不到就是红；
//   5. 引用 `file:NN` 的每一条都跑一次范围与锚点检查 —— 代码改一个字，行号就漂；
//   6. 本闸自己的组数与项数都自钉（D18），verify.sh 的 DOCTEST_EXPECT_* 再从外面钉一次 ——
//      删一条断言不改这两处就是红。`DOC_GROUPS=D1,D6 node tools/doctest.mjs` 是子集跑，必须打 NOTE。
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SIZES, SIZE_TABLE } from '../js/engine/generate.js';
import { RULE_ORDER, RULE_TEXT, edgeCount } from '../js/engine/pencil.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const fail = [];
const emitted = new Set();
let rows = 0;
const ok = (cond, label, detail) => {
  rows++;
  const m = label.match(/^D\d+/);
  if (!m) throw new Error(`断言标签必须以 D<N> 开头：${label}`);
  emitted.add(m[0]);
  if (!cond) fail.push(label);
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label} · ${detail}`);
};
// 子集跑：只跑点名的组（破坏试验每把刀只需要红在它那一个组上，全套跑五遍既慢又没更多信息）
const ONLY = (process.env.DOC_GROUPS || '').trim().split(/[\s,]+/).filter(Boolean);
const want = (g) => ONLY.length === 0 || ONLY.includes(g);
// 本闸自己的规模：组数与整闸跑的项数（= STAMP 那一行的 rows）。三处同钉：这里、README 抄的那句、
// verify.sh 的 DOCTEST_EXPECT_*。删一条断言 → 这里红；偷偷把这里改小 → verify.sh 那两处红。
const EXPECT_GROUPS = 18;
const EXPECT_ROWS = 233;

// 「注释里写着没有 X」不等于「代码里没有 X」：判代码就得先把注释剥掉。
const codeOnly = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const fromCN = (s) => (CN[s] !== undefined ? CN[s] : Number(s));

const README = read('README.md');
const DESIGN = read('DESIGN.md');
const DOCS = README + '\n' + DESIGN;
const ONE = DOCS.replace(/\n\s*/g, ' '); // 跨行抄的句子：把折行压平再对
const CI = read('.github/workflows/ci.yml');
const PAGES = read('.github/workflows/pages.yml');
const VERIFY = read('tools/verify.sh');
const PKG = JSON.parse(read('package.json'));
const SERVER = read('server.cjs');
const BAL_SRC = read('tools/balance.mjs');
const SCEN = read('tools/scenarios.js');
const GEN_SRC = read('js/engine/generate.js');
const PENCIL_SRC = read('js/engine/pencil.js');
const COUNTER_SRC = read('js/engine/counter.js');
const LOOP_SRC = read('js/engine/loop.js');
const RNG_SRC = read('js/engine/rng.js');
const STORE_SRC = read('js/store.js');
const MAIN_SRC = read('js/main.js');
const GAME_SRC = read('js/ui/game.js');
const HTML = read('index.html');
const ENGINE_ALL = [GEN_SRC, PENCIL_SRC, COUNTER_SRC, LOOP_SRC, RNG_SRC, STORE_SRC, MAIN_SRC, GAME_SRC,
  read('js/render/board.js'), read('js/theme.js')].join('\n');

const run = (cmd, env, ms) => {
  const r = spawnSync('bash', ['-c', cmd], { cwd: ROOT, encoding: 'utf8', timeout: ms, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } });
  return { rc: r.status === null ? -1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
};
// 现值来源全是本仓自己的工具，都是纯 Node 的逻辑跑（不开浏览器）
const BAL = want('D2') || want('D3') || want('D4') ? run('node tools/balance.mjs', { SAMPLES: '32' }, 420000) : null;
const RULE = want('D2') || want('D5') ? run('node tools/rule-test.mjs', {}, 120000) : null;
const PENCIL = want('D5') ? run('node tools/pencil-test.mjs', {}, 300000) : null;
const COUNTER = want('D5') ? run('node tools/counter-test.mjs', {}, 420000) : null;
const PROBE = want('D5') ? run('node tools/generator-probe.mjs', {}, 300000) : null;

// ---- D1 尺寸与菜单：README/DESIGN 抄的档名、键数、默认档、边数 == generate.js / main.js / pencil.js ----
if (want('D1')) {
  const menuM = README.match(/菜单五档：([^（\n]+)（/);
  const menuDoc = (menuM ? menuM[1] : '').split('、').map((s) => s.trim().replace(/×/g, 'x')).filter(Boolean);
  ok(menuDoc.length === SIZES.length, `D1a README 的「菜单五档」解析到 ${SIZES.length} 个档名（解析不到就是形状改了）`,
    `解析 ${menuDoc.length} 个 vs SIZES ${SIZES.length} 档：${menuDoc.join('/')}`);
  ok(menuDoc.join(',') === SIZES.join(','), `D1b 菜单档名与顺序逐格等于 generate.js 的 SIZES 现值`,
    `文档 ${menuDoc.join('/')} vs 代码 ${SIZES.join('/')}`);
  const tableKeys = Object.keys(SIZE_TABLE);
  const docSeven = DOCS.match(/SIZE_TABLE`? ?只有([一二三四五六七八九十\d]+)个键/);
  ok(tableKeys.length === 8 && !!docSeven && fromCN(docSeven[1]) === tableKeys.length,
    `D1c SIZE_TABLE 现值 ${tableKeys.length} 个键 == DESIGN 那句「只有 ${docSeven ? docSeven[1] : '?'} 个键」`,
    `代码 ${tableKeys.length}（${tableKeys.join('/')}）· 文档 ${docSeven ? docSeven[1] : '未解析'}`);
  const extra = tableKeys.filter((k) => !SIZES.includes(k));
  const docExtra = README.match(/另外三个长方形（([^）]+)）/);
  const docExtraList = (docExtra ? docExtra[1] : '').split('、').map((s) => s.trim().replace(/×/g, 'x')).filter(Boolean);
  ok(docExtraList.length === extra.length && docExtraList.join(',') === extra.join(','),
    `D1d 不进菜单的对照组（代码 ${extra.join('/')}）与 README 点名的三个逐格相同`,
    `文档 ${docExtraList.join('/')} vs 代码 ${extra.join('/')}`);
  const defM = MAIN_SRC.match(/const DEFAULT_SIZE = '(\d+x\d+)'/);
  const docDef = README.match(/默认 (\d+)×(\d+)/);
  ok(!!defM && !!docDef && `${docDef[1]}x${docDef[2]}` === defM[1],
    `D1e 默认档 ${defM ? defM[1] : '解析不到'} == main.js 的 DEFAULT_SIZE 现值`,
    `文档 ${docDef ? `${docDef[1]}×${docDef[2]}` : '未解析'} vs 代码 ${defM ? defM[1] : '?'}`);
  const fillLine = MAIN_SRC.split('\n').findIndex((l) => /^for \(const s of SIZES\) \{/.test(l)) + 1;
  const docFill = README.match(/下拉框就是遍历它，\n?\s*`js\/main\.js:(\d+)`/);
  ok(fillLine > 0 && !!docFill && +docFill[1] === fillLine,
    `D1f README 写的「下拉框遍历 SIZES」在 main.js:${fillLine}（文档现在写的是 ${docFill ? docFill[1] : '未解析'}）`,
    `代码第 ${fillLine} 行 · 文档 ${docFill ? docFill[1] : '未解析'}`);
  const ladders = [...DOCS.matchAll(/([一二三四五六七八九十]|\d+)档 ×(\d+) = (\d+) 盘/g)];
  ok(ladders.length >= 2 && ladders.every((m) => fromCN(m[1]) === tableKeys.length && +m[3] === fromCN(m[1]) * +m[2]),
    `D1g 「N档 ×样本 = 盘」这类合计解析到 ${ladders.length} 处：档数 == SIZE_TABLE 现值 ${tableKeys.length}，乘法也自洽`,
    ladders.map((m) => `${fromCN(m[1])}×${m[2]}=${m[3]}`).join(' | '));
  const edges6 = edgeCount(6, 6), edges10 = edgeCount(10, 10);
  ok(/6×6 是 60 条，10×10 是 180 条/.test(DOCS) && edges6 === 60 && edges10 === 180,
    `D1h DESIGN 那句「6×6 是 60 条，10×10 是 180 条」== edgeCount 现算 ${edges6}/${edges10}`,
    `edgeCount(6,6)=${edges6} · edgeCount(10,10)=${edges10}`);
  ok(/6×6 永远 60、10×10 永远 180/.test(README) && edges6 === 60 && edges10 === 180,
    `D1i README 的 steps 恒等式那句还在，且数字 == 现算（改 edgeCount 的公式就得同时改它）`,
    `现算 ${edges6}/${edges10}`);
  const biggest = Math.max(...tableKeys.map((k) => SIZE_TABLE[k][0] * SIZE_TABLE[k][1]));
  ok(biggest === 100 && !/UNSHIPPABLE/.test(ENGINE_ALL),
    `D1j 最大出货尺寸就是 10×10（${biggest} 格），代码里也长不出「UNSHIPPABLE 表」——「没量过 ≠ 能出」有代码背书`,
    `最大 ${biggest} 格 · 代码 UNSHIPPABLE 命中=${/UNSHIPPABLE/.test(ENGINE_ALL)}`);
}

// ---- D2 十条规则：规则数、顺序、权重、死规则地位、摘稀步数 == RULE_ORDER / balance / rule-test ----
if (want('D2')) {
  // 「一条规则只能宣布…」是量词用法，不是条数声明；条数声明一律带「十条」或数字，后面不接「只」。
  const cnCount = [...DOCS.matchAll(/([一二三四五六七八九十\d]+)条(?:局部规则|铅笔规则|命名规则|规则)(?![只])/g)].map((m) => fromCN(m[1]));
  ok(cnCount.length >= 4 && cnCount.every((x) => x === RULE_ORDER.length),
    `D2a 文档每一处「N 条规则」都等于 RULE_ORDER 现值 ${RULE_ORDER.length}（解析到 ${cnCount.length} 处）`, cnCount.join('/'));
  const firstFive = (DESIGN.match(/先做只盯一颗珠子的局部结论（([^）]+)）/) || [, ''])[1].split('、').map((s) => s.replace(/`/g, '').trim()).filter(Boolean);
  ok(firstFive.length === 5 && firstFive.join(',') === RULE_ORDER.slice(0, 5).join(','),
    `D2b DESIGN §6 前半组五条规则名与顺序 == RULE_ORDER 前五个现值`,
    `文档 ${firstFive.join('/')} vs 代码 ${RULE_ORDER.slice(0, 5).join('/')}`);
  const midTwo = (DESIGN.match(/再做整格计数（([^）]+)）/) || [, ''])[1].split('、').map((s) => s.replace(/`/g, '').trim()).filter(Boolean);
  ok(midTwo.length === 2 && midTwo.join(',') === RULE_ORDER.slice(5, 7).join(','),
    `D2c DESIGN §6 中间两条整格计数 == RULE_ORDER 第 6~7 条现值`,
    `文档 ${midTwo.join('/')} vs 代码 ${RULE_ORDER.slice(5, 7).join('/')}`);
  const lastThree = (DESIGN.match(/最后才是看整圈整块的（([^）]+)）/) || [, ''])[1].split('、').map((s) => s.replace(/`/g, '').trim()).filter(Boolean);
  ok(lastThree.length === 3 && lastThree.join(',') === RULE_ORDER.slice(7).join(','),
    `D2d DESIGN §6 最后三条全局规则 == RULE_ORDER 第 8~10 条现值`,
    `文档 ${lastThree.join('/')} vs 代码 ${RULE_ORDER.slice(7).join('/')}`);
  ok(Object.keys(RULE_TEXT).join(',') === RULE_ORDER.join(','),
    `D2e 引擎的 RULE_TEXT 键集与 RULE_ORDER 逐格相同（${RULE_ORDER.length} 条都有文案）`,
    `RULE_TEXT ${Object.keys(RULE_TEXT).length} · RULE_ORDER ${RULE_ORDER.length}`);
  const weightSrc = (BAL_SRC.match(/const RULE_WEIGHT = \{([\s\S]*?)\n\};/) || [, ''])[1];
  const weights = {};
  for (const m of weightSrc.matchAll(/'([\w-]+)': (\d+)/g)) weights[m[1]] = +m[2];
  ok(Object.keys(weights).length === RULE_ORDER.length && RULE_ORDER.every((k) => weights[k] != null),
    `D2f balance 的 RULE_WEIGHT 覆盖全部 ${RULE_ORDER.length} 条规则（解析到 ${Object.keys(weights).length} 条）`,
    Object.entries(weights).map(([k, v]) => `${k}=${v}`).join(' '));
  const wdoc = README.match(/只看本格 (\d+) \/ 珠子四邻 ([\d~]+) \/ 2×2 (\d+) \/ 整圈整块 (\d+)/);
  const oneSet = RULE_ORDER.filter((k) => weights[k] === +wdoc?.[1]).sort().join(',');
  ok(!!wdoc && oneSet === 'cell-degree-two,pearl-degree', `D2g 「只看本格 ${wdoc ? wdoc[1] : '?'} 分」的规则集 == 权重表现值`,
    `权重 1 的规则：${oneSet || '解析不到'}`);
  const nearSet = RULE_ORDER.filter((k) => weights[k] === 2 || weights[k] === 3).sort().join(',');
  ok(!!wdoc && wdoc[2] === '2~3' && nearSet === 'black-straight,black-turn,no-dead-end,white-straight,white-turn',
    `D2h 「珠子四邻 ${wdoc ? wdoc[2] : '?'} 分」的规则集 == 权重表现值（2 与 3 两档合起来那五条）`,
    `权重 2~3 的规则：${nearSet}`);
  ok(!!wdoc && weights['no-2x2-square'] === +wdoc[3] && weights['single-loop'] === +wdoc[4] && weights['no-island'] === +wdoc[4],
    `D2i 「2×2 ${wdoc ? wdoc[3] : '?'} 分 / 整圈整块 ${wdoc ? wdoc[4] : '?'} 分」== 权重表现值`,
    `代码 no-2x2-square=${weights['no-2x2-square']} · single-loop/no-island=${weights['single-loop']}/${weights['no-island']}`);
  ok(!/scoreOf/.test(ENGINE_ALL) && /function scoreOf/.test(BAL_SRC),
    `D2j 引擎侧确实长不出 scoreOf（README 那句「引擎里没有 scoreOf」由代码成立）`,
    `引擎命中=${/scoreOf/.test(ENGINE_ALL)} · balance 命中=${/function scoreOf/.test(BAL_SRC)}`);
  const rankM = [...ONE.matchAll(/`no-2x2-square`[^。]{0,44}?第([一二三四五六七八九十\d]+)/g)].map((m) => fromCN(m[1]));
  const rank = RULE_ORDER.indexOf('no-2x2-square') + 1;
  ok(rankM.length >= 2 && rankM.every((x) => x === rank), `D2k 「no-2x2-square 排第${rankM[0] || '?'}」（文档 ${rankM.length} 处都这么写）== RULE_ORDER 现位置 ${rank}`,
    `文档 第${rankM.join('/') || '未解析'} vs 代码 第${rank}`);
  const digSteps = [...ONE.matchAll(/(\d+) 步里[^0-9]{0,6}前件成立 0 次/g)].map((m) => +m[1]);
  const expectSteps = 24 * edgeCount(8, 8);
  ok(digSteps.length === 2 && digSteps.every((x) => x === expectSteps),
    `D2l 「24 张 8×8 逐步查前件」那一句的步数合计 == 24 × edgeCount(8,8) = ${expectSteps}（解析 ${digSteps.join('/')}）`,
    `文档 ${digSteps.join('/')} vs 现算 24×${edgeCount(8, 8)}=${expectSteps}`);
  if (BAL) {
    const 全景 = BAL.out.match(/规则全景（八档 ×(\d+) 盘）：(.+)/);
    const hits = {};
    if (全景) for (const m of 全景[2].matchAll(/([\w-]+) 命中 (\d+) 次\/覆盖 (\d+) 盘/g)) hits[m[1]] = { n: +m[2], boards: +m[3] };
    const totalBoards = 全景 ? 8 * +全景[1] : -1;
    ok(!!全景 && Object.keys(hits).length === RULE_ORDER.length && 全景[1] === '32',
      `D2m balance 的规则全景解析到 ${Object.keys(hits).length} 条规则 × 八档 ×${全景 ? 全景[1] : '?'} 盘 = ${totalBoards}（现跑 SAMPLES=32）`,
      `全景 ${Object.keys(hits).length} 条 · 合计 ${totalBoards} 盘`);
    const dead = hits['no-2x2-square'];
    ok(!!dead && dead.n === 0 && dead.boards === 0 && /一次都没命中/.test(README),
      `D2n 死规则现跑就是 0 命中（${dead ? `${dead.n} 次 / ${dead.boards} 盘` : '解析不到'}）——「一次都没命中」有现跑背书`,
      `现跑 no-2x2-square ${dead ? `${dead.n}/${dead.boards}` : '?'}`);
    const usedNine = RULE_ORDER.filter((k) => hits[k] && hits[k].n > 0).length;
    ok(usedNine === 9 && /实际只用九条/.test(DOCS), `D2o 出货盘上真的「只用九条」（现跑非零命中 ${usedNine} 条）`,
      `非零命中 ${usedNine} 条 vs 文档「九条」`);
    const sl = hits['single-loop'], ni = hits['no-island'];
    const docSl = ONE.match(/single-loop`?\s*只在 (\d+)\/(\d+) 盘上命中过\*{0,2}（\s*`?no-island`?\s*(\d+)\/(\d+)/);
    ok(!!sl && !!ni && !!docSl && +docSl[1] === sl.boards && +docSl[2] === totalBoards && +docSl[2] === +docSl[4] && +docSl[3] === ni.boards,
      `D2p DESIGN §9.2 的 single-loop ${docSl ? docSl[1] : '?'} 盘 / no-island ${docSl ? docSl[3] : '?'} 盘 == 现跑 ${sl ? sl.boards : '?'}/${ni ? ni.boards : '?'}（共 ${totalBoards} 盘）`,
      `现跑 single-loop=${sl ? sl.boards : '?'} no-island=${ni ? ni.boards : '?'}`);
    const docIdle = DESIGN.match(/有 (\d+) 盘整局没用过[\s\S]{0,10}`single-loop`/);
    ok(!!docIdle && !!sl && +docIdle[1] === totalBoards - sl.boards,
      `D2q 「有 ${docIdle ? docIdle[1] : '?'} 盘整局没用过 single-loop」== 现跑 ${sl ? totalBoards - sl.boards : '?'}（${totalBoards}−${sl ? sl.boards : '?'}）`,
      `文档 ${docIdle ? docIdle[1] : '未解析'} vs 现算 ${sl ? totalBoards - sl.boards : '?'}`);
    const docZeroNine = README.match(/它对难度分数的贡献是 (\d+) 分/);
    ok(!docZeroNine || weights['no-2x2-square'] === +docZeroNine[1],
      `D2r 死规则那条权重的说法与现值同阶（现跑 ${weights['no-2x2-square']} 分 × 0 次命中 = 0 贡献）`,
      `权重 ${weights['no-2x2-square']} · 命中 0`);
  } else console.log('  NOTE D2 的 balance 依赖项本次跳过（DOC_GROUPS 子集跑）');
  if (RULE) {
    const perRule = RULE.out.match(/no-2x2-square\(发(\d+)\/ contra (\d+)\/ 静(\d+)\)/);
    const docCases = [...DOCS.matchAll(/发 (\d+) \/ contra (\d+) \/ 静 (\d+)/g)].map((m) => [+m[1], +m[2], +m[3]]);
    ok(!!perRule && docCases.length >= 2 && docCases.every((c) => c.join(',') === [perRule[1], perRule[2], perRule[3]].join(',')),
      `D2s no-2x2-square 的三件事（发/contra/静）文档两处 ${docCases.map((c) => c.join('/')).join(' 和 ')} == rule-test 现跑 ${perRule ? `${perRule[1]}/${perRule[2]}/${perRule[3]}` : '未解析'}`,
      `现跑 ${perRule ? perRule.slice(1).join('/') : '?'}`);
  } else console.log('  NOTE D2 的 rule-test 依赖项本次跳过（DOC_GROUPS 子集跑）');
}

// ---- D3 难度表：README 那八行逐格等于 SAMPLES=32 现场跑的 balance（墙钟列除外，见 D14/D15）----
const docRows = [...README.matchAll(
  /^\| (\d+)×(\d+) \| (✓|对照) \| (\d+)\/(\d+) \| (\d+%) \| (\d+) \| (\d+) \/ (\d+) \| ([\d.]+) \/ ([\d.]+) \| \d+ \/ \d+ \/ \d+ ms \| (\d+) \/ (\d+) 盘 \| (\d+)\/(\d+) \|$/gm)];
const blocks = {};
if (BAL) {
  for (const p of BAL.out.split(/^── /m).slice(1)) {
    const head = p.match(/^(\d+x\d+)（(\d+) 格，(菜单|不进菜单)）样本 (\d+) ──/);
    if (!head) continue;
    const g = (re) => p.match(re);
    const ship = g(/1\) 出货率 (\d+)\/(\d+) = (\d+)%/);
    const zero = g(/2\) 零猜测可解率 (\d+)\/(\d+) = (\d+)%/);
    const score = g(/3\) 分数\(balance 自定义\) p50 (\d+) p95 (\d+) max (\d+) min (\d+)｜steps p50 (\d+)/);
    const pearl = g(/出货盘均候选 ([\d.]+) 颗 → 端出 ([\d.]+) 颗\/盘/);
    const min2 = g(/门 2 抽废的环（rejectedByMinimal）合计 (\d+) 条、发生在 (\d+)\/(\d+) 盘/);
    const brk = g(/破口 (\d+)\/(\d+) 盘/);
    const dep = g(/平均推理深度 score\/steps ([\d.]+)/);
    blocks[head[1]] = {
      cells: +head[2], menu: head[3], n: +head[4],
      ship: ship && [+ship[1], +ship[2]], zero: zero && [+zero[1], +zero[2], +zero[3]],
      score: score && { p50: +score[1], p95: +score[2], max: +score[3], min: +score[4], steps: +score[5] },
      pearl: pearl && { cand: +pearl[1], shipped: +pearl[2] },
      min2: min2 && { loops: +min2[1], boards: +min2[2] },
      brk: brk && [+brk[1], +brk[2]], depth: dep ? +dep[1] : NaN,
    };
  }
}
const names = Object.keys(blocks);
const sumOf = (f) => names.reduce((a, k) => a + f(blocks[k]), 0);
if (want('D3')) {
  // balance 的 rc 只允许一种非 0 的理由：本机争用把「墙钟 p95 ≤ 8000ms」这条绝对毫秒红线顶过线
  // （这一列文档自己写明会漂，见 D14/D15a）。其它任何红线都说明表里的读数不是现值 ⇒ 红。
  const sumTail = BAL ? BAL.out.slice(BAL.out.indexOf('\n红线汇总：')) : '';
  const balFlags = [...sumTail.matchAll(/^  - (.*)$/gm)].map((x) => x[1]);
  const onlyWall = balFlags.length > 0 && balFlags.every((f) => /墙钟 p95 \d+ms > \d+ms/.test(f));
  ok(!!BAL && (BAL.rc === 0 || onlyWall),
    `D3a balance SAMPLES=32 现场跑 rc=${BAL ? BAL.rc : '未跑'}${onlyWall ? '（非 0，但唯一的红线就是那条声明会漂的墙钟列）' : ''}`,
    `rc=${BAL ? BAL.rc : '-'} · 红线 ${balFlags.length} 项：${balFlags.join('；').slice(0, 220) || '全绿'}`);
  ok(names.length === 8, `D3b balance 的逐档明细解析到 ${names.length} 个档（解析不到就是标题行换了措辞）`, names.join('/'));
  ok(docRows.length === 8, `D3c README 难度表解析到 ${docRows.length} 行（每行一档；列名或形状一改就红在这里）`, `${docRows.length} 行`);
  if (BAL) {
    for (const m of docRows) {
      const key = `${m[1]}x${m[2]}`, b = blocks[key];
      ok(!!b, `D3 ${key} 在 balance 的现场明细里还在`, b ? '在' : '现跑没有这一档');
      if (!b) continue;
      ok(b.menu === (m[3] === '✓' ? '菜单' : '不进菜单') && SIZES.includes(key) === (m[3] === '✓'),
        `D3 ${key} 的「${m[3] === '✓' ? '✓（菜单）' : '对照'}」列 == 现跑归属 ${b.menu} 与 SIZES 现值`,
        `文档 ${m[3]} vs 现跑 ${b.menu}`);
      ok(+m[4] === b.ship[0] && +m[5] === b.ship[1] && b.n === +m[5],
        `D3 ${key} 出货 ${m[4]}/${m[5]} == balance 现跑 ${b.ship.join('/')}`, `文档 ${m[4]}/${m[5]} vs 现跑 ${b.ship.join('/')}`);
      ok(parseInt(m[6], 10) === Math.round((100 * b.zero[0]) / b.zero[1]) && parseInt(m[6], 10) === b.zero[2],
        `D3 ${key} 零猜测 ${m[6]} == balance 现跑 ${b.zero[0]}/${b.zero[1]} = ${b.zero[2]}%`,
        `文档 ${m[6]}% vs 现跑 ${b.zero.join('/')}`);
      ok(+m[7] === b.score.steps && b.score.steps === edgeCount(+m[1], +m[2]),
        `D3 ${key} steps p50 ${m[7]} == balance 现跑 ${b.score.steps} == edgeCount(${m[1]},${m[2]})（恒等式，不是抄来的）`,
        `文档 ${m[7]} vs balance ${b.score.steps} vs 代码 ${edgeCount(+m[1], +m[2])}`);
      ok(+m[8] === b.score.p50 && +m[9] === b.score.p95,
        `D3 ${key} 分数 p50/p95 ${m[8]}/${m[9]} == balance 现跑 ${b.score.p50}/${b.score.p95}`,
        `文档 ${m[8]}/${m[9]} vs 现跑 ${b.score.p50}/${b.score.p95}`);
      ok(+m[10] === b.pearl.shipped && +m[11] === b.pearl.cand,
        `D3 ${key} 盘均珠数/候选 ${m[10]}/${m[11]} == balance 现跑 ${b.pearl.shipped}/${b.pearl.cand}`,
        `文档 ${m[10]}/${m[11]} vs 现跑 ${b.pearl.shipped}/${b.pearl.cand}`);
      ok(+m[12] === b.min2.loops && +m[13] === b.min2.boards,
        `D3 ${key} 门 2 抽废 ${m[12]} 环/${m[13]} 盘 == balance 现跑 ${b.min2.loops}/${b.min2.boards}`,
        `文档 ${m[12]}/${m[13]} vs 现跑 ${b.min2.loops}/${b.min2.boards}`);
      ok(+m[14] === b.brk[0] && +m[15] === b.brk[1], `D3 ${key} 极小破口 ${m[14]}/${m[15]} == balance 现跑 ${b.brk.join('/')}`,
        `文档 ${m[14]}/${m[15]} vs 现跑 ${b.brk.join('/')}`);
    }
    const docTotal = README.match(/八档 ×32 = (\d+) 盘/g);
    ok(!!docTotal && docTotal.every((s) => s.includes('256')) && sumOf((b) => b.ship[0]) === 256,
      `D3d 「八档 ×32 = 256 盘」在文档 ${docTotal ? docTotal.length : 0} 处，且 == 现跑出货合计 ${sumOf((b) => b.ship[0])}`,
      `Σ出货 ${sumOf((b) => b.ship[0])} · Σ样本 ${sumOf((b) => b.ship[1])}`);
    ok(/非 UNIQUE 0、verify 不过 0、铅笔没推到底 0/.test(ONE) &&
      (BAL.out.match(/复算不认账：非 UNIQUE 0 盘 -、verify 不过 0 盘 -、铅笔没推到底 0 盘 -/g) || []).length === 8,
      'D3e 承诺栏那句「非 UNIQUE 0、verify 不过 0、铅笔没推到底 0」在现跑八档明细里逐档成立',
      `现跑 ${(BAL.out.match(/非 UNIQUE 0 盘/g) || []).length}/8 档`);
    ok(/三本账 256\/256 轧平/.test(ONE) && sumOf((b) => b.ship[0]) === 256 && !/不平的：/.test(BAL.out),
      `D3f 「三本账 256/256 轧平」== 现跑（八档各 32/32 且没有不平的样本）`,
      `Σ出货 ${sumOf((b) => b.ship[0])} · 不平的行 ${(BAL.out.match(/不平的：/g) || []).length}`);
    const docLoops = ONE.match(/本轮 (\d+) 盘里有 (\d+) 条环死在这道上（([^）]+)）/);
    const loopSum = sumOf((b) => b.min2.loops);
    ok(!!docLoops && +docLoops[1] === 256 && +docLoops[2] === loopSum,
      `D3g 「本轮 256 盘里有 ${docLoops ? docLoops[2] : '?'} 条环死在门 2 上」== 现跑合计 ${loopSum}`,
      `文档 ${docLoops ? docLoops[2] : '未解析'} vs 现跑 ${loopSum}`);
    if (docLoops) {
      const parts = [...docLoops[3].matchAll(/(\d+)×(\d+) (\d+) 盘/g)].map((x) => ({ k: `${x[1]}x${x[2]}`, v: +x[3] }));
      const bad = parts.filter((p) => !blocks[p.k] || blocks[p.k].min2.boards !== p.v);
      const withBreak = names.filter((k) => blocks[k].min2.boards > 0).sort().join(',');
      ok(parts.length === 4 && bad.length === 0 && parts.map((p) => p.k).sort().join(',') === withBreak,
        `D3h 「各挨过至少一次」那四档（${parts.map((p) => `${p.k}:${p.v}`).join(' ')}）逐格 == 现跑，且现跑有破口的档正好是这四档`,
        `现跑有破口：${withBreak} · 不符 ${bad.length}`);
    }
    const docMin = README.match(/摘得掉 (\d+) 颗、没证据 (\d+) 颗/);
    ok(!!docMin && +docMin[1] === 0 && +docMin[2] === 0 &&
      (BAL.out.match(/摘得掉 0 颗、超预算数不完 0 颗/g) || []).length === 8,
      `D3i 「摘得掉 ${docMin ? docMin[1] : '?'} 颗、没证据 ${docMin ? docMin[2] : '?'} 颗」== 现跑八档明细全 0`,
      `现跑 ${(BAL.out.match(/摘得掉 0 颗/g) || []).length}/8 档`);
    const wallSrcCap = (BAL_SRC.match(/wallP95Ms: (\d+)/) || [, '?'])[1];
    const wallLines = [...BAL.out.matchAll(/5\) 墙钟 Date\.now\(\)：p50 (\d+)ms p95 (\d+)ms max (\d+)ms[^|｜]*[|｜]?红线 p95 ≤ (\d+)ms/g)];
    ok(wallLines.length === 8 && wallLines.every((x) => +x[1] <= +x[2] && +x[2] <= +x[3]) &&
      wallLines.every((x) => x[4] === wallSrcCap),
      `D3j 难度表那一 ms 列在现跑里是八个**排序取出**的分位数（p50 ≤ p95 ≤ max），且现跑打印的门槛数 == balance 源码的 wallP95Ms=${wallSrcCap}`,
      `解析 ${wallLines.length} 档 · 门槛 ${[...new Set(wallLines.map((x) => x[4]))].join('/')} · 源码 ${wallSrcCap}（绝对值本身会漂，所以只比排序与门槛，不比值——见 D15a）`);
  } else console.log('  NOTE D3 本次未跑（DOC_GROUPS 子集跑把 balance 省掉了）——本组项数不计入本次自钉');
}

// ---- D4 分数带宽与支配概率：README 抄的两个区间、一个概率、一个门槛 == balance 现跑 ----
if (want('D4')) {
  if (BAL) {
    const mono = BAL.out.match(/区分力 P\(10x10 分数 > 6x6\) = ([\d.]+)（门槛 ([\d.]+)）；两档区间 6x6 \[(\d+)\.\.(\d+)\] vs 10x10 \[(\d+)\.\.(\d+)\]/);
    const docBand = README.match(/[（(]6×6 \[(\d+)\.\.(\d+)\] vs 10×10 \[(\d+)\.\.(\d+)\]/);
    const docDom = README.match(/支配概率 ≥ ([\d.]+)（本轮 ([\d.]+)）/), docGate = ONE.match(/（门槛 ([\d.]+)）/) || [];
    const domCode = BAL_SRC.match(/dominance: ([\d.]+)/);
    ok(!!mono && !!docBand, `D4a 现跑的单调性行与 README 的带宽句都解析到（解析不到就是措辞换了）`,
      `现跑 ${mono ? mono.slice(3, 7).join('/') : '未解析'} · 文档 ${docBand ? docBand.slice(1).join('/') : '未解析'}`);
    ok(!!mono && !!docBand && docBand.slice(1).join(',') === mono.slice(3, 7).join(','),
      `D4 分数带宽：文档 ${docBand ? `[${docBand[1]}..${docBand[2]}] vs [${docBand[3]}..${docBand[4]}]` : '未解析'} == 现跑 ${mono ? `[${mono[3]}..${mono[4]}] vs [${mono[5]}..${mono[6]}]` : '未解析'}`,
      `六个数逐格比 · 现跑 ${mono ? mono.slice(3, 7).join('/') : '?'}`);
    ok(!!mono && !!docDom && +docDom[2] === +mono[1], `D4 支配概率文档 ${docDom ? docDom[2] : '未解析'} == 现跑 ${mono ? mono[1] : '未解析'}`,
      `现跑 P=${mono ? mono[1] : '?'}`);
    ok(!!mono && !!domCode && +domCode[1] === +mono[2] && +docDom?.[1] === +domCode[1] && +docGate[1] === +domCode[1] &&
      /门槛里的「支配概率」是 Mann-Whitney U 换算的 AUC/.test(README),
      `D4c 门槛三处同源：balance 现值 ${domCode ? domCode[1] : '?'} == 现跑打印 ${mono ? mono[2] : '?'} == 文档两处（${docDom ? docDom[1] : '未解析'}/${docGate[1] || '未解析'}）`,
      `代码 dominance=${domCode ? domCode[1] : '?'} · 现跑 ${mono ? mono[2] : '?'} · 文档 ${docDom ? docDom[1] : '?'}/${docGate[1] || '?'}`);
    const depths = names.map((k) => blocks[k].depth).filter(Number.isFinite);
    const docDepth = README.match(/score\/steps ≈ ([\d.]+)/);
    ok(!!docDepth && depths.length === 8 && depths.every((d) => Math.abs(d - +docDepth[1]) <= 0.15),
      `D4d 「score/steps ≈ ${docDepth ? docDepth[1] : '?'}」与现跑八个深度值同阶（文档写了 ≈，这里按 ±0.15 校，别当恒等）`,
      `现跑 ${depths.join('/')} · 文档 ${docDepth ? docDepth[1] : '未解析'}`);
    ok(/不重叠/.test(README) && !!mono && +mono[4] < +mono[5],
      `D4e 那句「两档区间不重叠」在现跑下成立（${mono ? `${mono[3]}..${mono[4]} vs ${mono[5]}..${mono[6]}` : '?'}）`,
      `现跑上界 ${mono ? mono[4] : '?'} < ${mono ? mono[5] : '?'} 下界`);
  } else console.log('  NOTE D4 本次未跑（DOC_GROUPS 子集跑）');
}

// ---- D5 断言数与测试台账：四套纯 Node 闸的现场条数 == README/DESIGN 抄的数 ----
if (want('D5')) {
  const runs = [['rule-test', RULE], ['pencil-test', PENCIL], ['counter-test', COUNTER], ['generator-probe', PROBE]];
  if (runs.every(([, r]) => r)) {
    for (const [name, r] of runs) ok(r.rc === 0, `D5 ${name} 现场跑 rc=${r.rc}（文档抄的是绿跑的读数，不绿的不是现值）`, `rc=${r.rc}`);
    const ruleLine = RULE.out.match(/合计 (\d+) 条通过，(\d+) 条失败/);
    const docRule = [...DOCS.matchAll(/(\d+) 条断言/g)].map((m) => +m[1]);
    ok(!!ruleLine && docRule.length >= 2 && docRule.every((x) => x === +ruleLine[1]) && +ruleLine[2] === 0,
      `D5a rule-test 现跑 ${ruleLine ? `${ruleLine[1]} 条 / ${ruleLine[2]} 失败` : '未解析'} == 文档所有「N 条断言」（解析 ${docRule.join('/')}）`,
      `现跑 ${ruleLine ? ruleLine.slice(1).join('/') : '?'}`);
    const penDed = PENCIL.out.match(/逐结论对账：(\d+) 次推演 \/ (\d+) 条结论/);
    const docPen = ONE.match(/逐结论对账 (\d+) 次推演 \/ (\d+) 条结论/);
    ok(!!penDed && !!docPen && +docPen[1] === +penDed[1] && +docPen[2] === +penDed[2],
      `D5b pencil-test 现跑 ${penDed ? `${penDed[1]} 次推演 / ${penDed[2]} 条结论` : '未解析'} == README 那句 ${docPen ? `${docPen[1]}/${docPen[2]}` : '未解析'}`,
      `现跑 ${penDed ? penDed.slice(1).join('/') : '?'}`);
    const docTwice = [...DOCS.matchAll(/(\d+) 条结论/g)].map((m) => +m[1]);
    ok(!!penDed && docTwice.length >= 2 && docTwice.every((x) => x === +penDed[2]),
      `D5c 文档 ${docTwice.length} 处「N 条结论」都等于现跑 ${penDed ? penDed[2] : '?'}`, docTwice.join('/'));
    const wrong = PENCIL.out.match(/推错了 = (\d+)/);
    ok(!!wrong && +wrong[1] === 0 && /推错了 = 0/.test(ONE) && /推错 0/.test(ONE),
      `D5d 「推错 0」是现跑读数（pencil-test 现打 ${wrong ? wrong[1] : '未解析'}）`, `现跑 ${wrong ? wrong[1] : '?'}`);
    const thin = PENCIL.out.match(/摘稀 (\d+)\/(\d+)（不完全性/);
    const docThin = README.match(/(\d+) 组里有 \*\*(\d+) 组推不动\*\*/);
    ok(!!thin && !!docThin && +docThin[1] === +thin[2] && +docThin[2] === +thin[1],
      `D5e 摘稀的不完全性：文档 ${docThin ? `${docThin[1]} 组里 ${docThin[2]} 组推不动` : '未解析'} == 现跑 ${thin ? `${thin[1]}/${thin[2]}` : '未解析'}`,
      `现跑 ${thin ? thin.slice(1).join('/') : '?'}`);
    const boards = PENCIL.out.match(/样本：6x6,8x8 × (\d+) 盘\/档 = (\d+) 盘/);
    ok(!!boards && +boards[1] * 2 === +boards[2] && /×8 盘 = 16 盘/.test(ONE),
      `D5j pencil-test 的盘数口径：现跑 ${boards ? `${boards[1]}×2=${boards[2]}` : '未解析'} == README「×8 盘 = 16 盘」`,
      `现跑 ${boards ? boards.slice(1).join('/') : '?'}`);
    const solvedPen = PENCIL.out.match(/出货盘 solveWithRules solved = (\d+)\/(\d+)/);
    const docSolved = ONE.match(/solveWithRules`? solved (\d+)\/(\d+)/);
    ok(!!solvedPen && !!docSolved && solvedPen[1] === solvedPen[2] && +docSolved[1] === +solvedPen[1] && +docSolved[2] === +solvedPen[2],
      `D5i 出货盘 solved 现跑 ${solvedPen ? solvedPen.slice(1).join('/') : '未解析'} == README ${docSolved ? docSolved.slice(1).join('/') : '未解析'}`,
      `现跑 ${solvedPen ? solvedPen.slice(1).join('/') : '?'}`);
    const single = PENCIL.out.match(/单边改动：喂 (\d+) 条，verify 正确拒掉 (\d+) 条/);
    const docSingle = ONE.match(/单边改动喂 (\d+) 条、`verify` 拒掉 (\d+) 条/);
    ok(!!single && +single[1] === +single[2] && !!docSingle && +docSingle[1] === +single[1] && +docSingle[2] === +single[2],
      `D5f 单边改动现跑 ${single ? `${single[1]} 喂 / ${single[2]} 拒` : '未解析'} == README ${docSingle ? `${docSingle[1]}/${docSingle[2]}` : '未解析'}`,
      `现跑 ${single ? single.slice(1).join('/') : '?'} · 文档 ${docSingle ? docSingle.slice(1).join('/') : '?'}`);
    const flip = PENCIL.out.match(/2×2 翻边（度数保持）：喂 (\d+) 条，verify 与 counter\.satisfies 意见一致 (\d+) 条/);
    const docFlip = ONE.match(/2×2 翻边 (\d+) 条，\s*`verify` 与 `counter\.satisfies` 意见一致 (\d+) 条/);
    ok(!!flip && +flip[1] === +flip[2] && !!docFlip && +docFlip[1] === +flip[1] && +docFlip[2] === +flip[2],
      `D5g 2×2 翻边现跑 ${flip ? `${flip[1]}/${flip[2]}` : '未解析'} == README ${docFlip ? `${docFlip[1]}/${docFlip[2]}` : '未解析'}`,
      `现跑 ${flip ? flip.slice(1).join('/') : '?'} · 文档 ${docFlip ? docFlip.slice(1).join('/') : '?'}`);
    const doc1376 = DESIGN.match(/（(\d+) 条单边改动全要拒）/);
    ok(!!single && !!doc1376 && +doc1376[1] === +single[1],
      `D5h DESIGN 门禁表那句「${doc1376 ? doc1376[1] : '?'} 条单边改动全要拒」== 现跑 ${single ? single[1] : '未解析'}`,
      `现跑 ${single ? single[1] : '?'} · 文档 ${doc1376 ? doc1376[1] : '未解析'}`);
    const sections = [...new Set([...COUNTER.out.matchAll(/# ([①②③④⑤])/g)].map((m) => m[1]))];
    ok(sections.length === 5 && /五节/.test(README) && /counter-test[^）\n]{0,14}（五节）/.test(DESIGN),
      `D5k counter-test 现跑 ${sections.length} 节（${sections.join('')}）== 文档那句「五节」`, sections.join(''));
    const cross = COUNTER.out.match(/对账：(\d+) 个配置，一致 (\d+)，不一致 (\d+)；其中 (\d+) 个配置解数 >1/);
    const docCross = ONE.match(/(\d+) 个配置逐一对账，其中 (\d+) 个配置解数 >1/);
    ok(!!cross && +cross[3] === 0 && !!docCross && +docCross[1] === +cross[1] && +docCross[2] === +cross[4],
      `D5l 朴素枚举对账现跑 ${cross ? `${cross[1]} 配置 / 不一致 ${cross[3]} / >1 的 ${cross[4]}` : '未解析'} == README ${docCross ? `${docCross[1]}/${docCross[2]}` : '未解析'}`,
      `现跑 ${cross ? cross.slice(1).join('/') : '?'}`);
    const docCrossDesign = DESIGN.match(/(\d+) 个配置逐一对账/);
    ok(!!cross && !!docCrossDesign && +docCrossDesign[1] === +cross[1],
      `D5m DESIGN 那句「${docCrossDesign ? docCrossDesign[1] : '?'} 个配置逐一对账」== 现跑 ${cross ? cross[1] : '未解析'}`,
      `现跑 ${cross ? cross[1] : '?'}`);
    const budget = COUNTER.out.match(/10×10 全候选 (\d+) 珠，预算 (\d+) → OVERBUDGET（用了 (\d+) 节点，count=(\d+)）/);
    const docBudget = ONE.match(/10×10 全候选 (\d+) 珠、预算压到 (\d+) ⇒ `OVERBUDGET`\s*（用了 (\d+) 节点，`count=(\d+)`）/);
    ok(!!budget && !!docBudget && budget.slice(1).join(',') === docBudget.slice(1).join(','),
      `D5n 预算不足的证人：现跑 ${budget ? budget.slice(1).join('/') : '未解析'} == DESIGN ${docBudget ? docBudget.slice(1).join('/') : '未解析'}`,
      `现跑 ${budget ? budget.slice(1).join('/') : '?'}`);
    const lowRun = COUNTER.out.match(/低预算跑 makePuzzle：出货 (\d+) 盘，no-loop (\d+) 次，overbudgetFull 累计 (\d+)，dropByOverbudget 累计 (\d+)；出货盘中"预算外唯一性"的违规 (\d+)/);
    const docLowR = ONE.match(/([两\d])个预算档 ×(\d+) 盘共 (\d+) 次 `makePuzzle`：出货 (\d+)、no-loop (\d+)、\s*`overbudgetFull` 累计 (\d+)、\s*`dropByOverbudget` 累计 (\d+)/);
    ok(!!lowRun && !!docLowR && fromCN(docLowR[1]) * +docLowR[2] === +docLowR[3] && +docLowR[4] === +lowRun[1] && +docLowR[5] === +lowRun[2] &&
      +docLowR[6] === +lowRun[3] && +docLowR[7] === +lowRun[4] && +lowRun[5] === 0,
      `D5o 低预算流水线现跑 ${lowRun ? lowRun.slice(1).join('/') : '未解析'} == README ${docLowR ? docLowR.slice(1).join('/') : '未解析'}（违规必须 0）`,
      `现跑 ${lowRun ? lowRun.slice(1).join('/') : '?'}`);
    const docLowD = ONE.match(/同一份低预算配置跑([两\d])个预算档 ×(\d+) 盘共 (\d+) 次 `makePuzzle`，出货 (\d+)、no-loop (\d+)、\s*`dropByOverbudget` 累计 (\d+)/);
    ok(!!lowRun && !!docLowD && fromCN(docLowD[1]) * +docLowD[2] === +docLowD[3] && +docLowD[4] === +lowRun[1] && +docLowD[5] === +lowRun[2] && +docLowD[6] === +lowRun[4],
      `D5p DESIGN 那一串（出货 ${docLowD ? docLowD[4] : '?'}／no-loop ${docLowD ? docLowD[5] : '?'}／dropByOverbudget ${docLowD ? docLowD[6] : '?'}）== 现跑`,
      `现跑 ${lowRun ? lowRun.slice(1).join('/') : '?'}`);
    const probeHeader = PROBE.out.match(/样本 (\d+) \/ 尺寸 ([\dx]+(?:, [\dx]+)*)/);
    const docProbe = README.match(/默认五档菜单 ×(\d+) 盘/);
    const probeSizes = probeHeader ? probeHeader[2].split(/, /) : [];
    ok(!!probeHeader && !!docProbe && probeSizes.join(',') === SIZES.join(',') && +probeHeader[1] === +docProbe[1],
      `D5q generator-probe 现跑的尺寸表（${probeSizes.join('/')} ×${probeHeader ? probeHeader[1] : '?'}）== README「默认五档菜单 ×${docProbe ? docProbe[1] : '?'} 盘」`,
      `现跑 ${probeSizes.length} 档 ×${probeHeader ? probeHeader[1] : '?'} · 文档 五档 ×${docProbe ? docProbe[1] : '?'}`);
    const probeRows = [...PROBE.out.matchAll(/^(\d+x\d+)\s+ok=(\d+)\/(\d+)/gm)];
    ok(probeRows.length === SIZES.length && probeRows.every((r) => +r[2] === +r[3]),
      `D5r probe 每一档都「全出货」（${probeRows.map((r) => `${r[1]}:${r[2]}/${r[3]}`).join(' ')}）== README 那句「且全部出货」`,
      `${probeRows.length} 档解析到`);
    const zeroish = [...PROBE.out.matchAll(/"(illegalLoop|refRejected|dropByMismatch)":(\d+)/g)];
    ok(zeroish.length === probeRows.length * 3 && zeroish.every((m) => +m[2] === 0),
      `D5s 三个「只该为 0」的项在现跑每一档都是 0（解析 ${zeroish.length} 格 == ${probeRows.length} 档 ×3）`,
      zeroish.slice(0, 6).map((m) => `${m[1]}=${m[2]}`).join(' '));
  } else console.log('  NOTE D5 本次未跑（DOC_GROUPS 子集跑；四套闸的 rc 与条数本次没检查）');
}

// ---- D6 端口：README / package.json / server.cjs / verify.sh 四处的默认号必须同源 ----
if (want('D6')) {
  const httpV = (VERIFY.match(/HTTP=\$\{HTTP_PORT:-(\d+)\}/) || [])[1];
  const cdpV = (VERIFY.match(/PORT=\$\{CDP_PORT:-(\d+)\}/) || [])[1];
  const devP = (PKG.scripts?.dev || '').match(/server\.cjs\s+(\d+)/);
  const srvP = (SERVER.match(/const DEFAULT_PORT = (\d+);/) || [])[1];
  const descP = PKG.description.match(/HTTP (\d+) \/ CDP (\d+)/) || [];
  const docP = README.match(/端口对本仓占 (\d+) \/ (\d+)/);
  ok(!!httpV && !!cdpV && !!devP && !!srvP,
    `D6a 四个号都解析到（HTTP ${httpV} · CDP ${cdpV} · dev ${devP ? devP[1] : '?'} · server ${srvP}）`,
    `verify ${httpV}/${cdpV} · package ${devP ? devP[1] : '?'} · server ${srvP}`);
  ok(!!docP && +docP[1] === +httpV && !!devP && +devP[1] === +httpV && +srvP === +httpV,
    `D6 HTTP 默认号三处同源：README:164 ${docP ? docP[1] : '?'} == verify.sh ${httpV} == package dev ${devP ? devP[1] : '?'} == server.cjs ${srvP}`,
    `文档 ${docP ? docP[1] : '未解析'} · verify ${httpV} · dev ${devP ? devP[1] : '?'} · server ${srvP}`);
  ok(!!descP[1] && !!descP[2] && +descP[1] === +httpV && +descP[2] === +cdpV,
    `D6b package.json description 里的端口对 ${descP[1]}/${descP[2]} == verify.sh 现值 ${httpV}/${cdpV}`,
    `package ${descP[1] ? `${descP[1]}/${descP[2]}` : '未解析'} vs verify ${httpV}/${cdpV}`);
  ok(!!docP && +docP[2] === +cdpV, `D6c CDP 默认号：README 写的 ${docP ? docP[2] : '?'} == verify.sh 的 ${cdpV}`,
    `文档 ${docP ? docP[2] : '未解析'} vs verify.sh ${cdpV}`);
  ok(!!httpV && !!cdpV && httpV !== cdpV && !/9334|9335|9347/.test(DOCS + VERIFY + SERVER),
    `D6d HTTP/CDP 两个号不同也不撞家族里的公共汽车（9334/9335/9347 在本仓一次都没出现）`,
    `CDP=${cdpV} · HTTP=${httpV}`);
  const srvCode = SERVER.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const nSrvCode = (srvCode.match(new RegExp(`\\b${httpV}\\b`, 'g')) || []).length;
  const nSrvAll = (SERVER.match(new RegExp(`\\b${httpV}\\b`, 'g')) || []).length;
  ok(/这个数在本文件里只写一次（DEFAULT_PORT）/.test(SERVER) && nSrvCode === 1 && nSrvAll === 2,
    `D6e server.cjs 那句「这个数在本文件里只写一次（DEFAULT_PORT）」是代码成立的：配置行一次（现跑 ${nSrvCode} 次），另一次就是它自己的来历注释（全文 ${nSrvAll} 次）`,
    `代码行 ${nSrvCode} · 含注释 ${nSrvAll} · DEFAULT_PORT=${srvP}`);
}

// ---- D7 屏幕那一层的清单与项数分解（Chrome 读数本身留给 verify.sh，见 D15）----
if (want('D7')) {
  const list = (VERIFY.match(/for s in \$\{SCENARIOS:-([^}]+)\}/) || [, ''])[1].trim().split(/\s+/).filter(Boolean);
  const docLine = (README.match(/(?:\w+ \d+ \/ )+\w+ \d+ = \*\*\d+ 项 0 红\*\*/) || [, ''])[0];
  const docList = [...docLine.matchAll(/(\w+) (\d+)/g)].map((m) => m[1]);
  ok(list.length === 6 && docList.length === list.length && docList.join(',') === list.join(','),
    `D7a verify.sh 的默认场景序列（${list.join(' ')}）与 README 分场分解点名的场次逐格相同`, `现值 ${list.length} 场 · 文档 ${docList.join(' ') || '未解析'}`);
  const breakdown = ONE.match(/boot (\d+) \/ render (\d+) \/ play (\d+) \/ marks (\d+) \/ resume (\d+) \/ hint (\d+) = \*\*(\d+) 项 0 红\*\*/);
  ok(!!breakdown, `D7b README 那行六场分解解析到（解析不到就是分解格式被改了）`,
    breakdown ? breakdown.slice(1, 8).join('/') : '未解析');
  if (breakdown) {
    const per = breakdown.slice(1, 7).map(Number);
    const total = +breakdown[7];
    ok(per.length === list.length, `D7c 分解项数 ${per.length} 项 == verify.sh 的场景数 ${list.length}（加一场不回填分解就红）`, per.join('/'));
    ok(per.reduce((a, b) => a + b, 0) === total, `D7d 分解之和 ${per.reduce((a, b) => a + b, 0)} == 文档合计「${total} 项 0 红」`,
      `Σ=${per.reduce((a, b) => a + b, 0)} vs ${total}`);
    const designTotal = (DESIGN.match(/verify\.sh`（(\d+) 项）/) || [])[1];
    ok(!!designTotal && +designTotal === total, `D7e DESIGN 门禁表那句「（${designTotal || '?'} 项）」与 README 的合计同源`,
      `DESIGN ${designTotal || '未解析'} vs README ${total}`);
    const hintDoc = ONE.match(/hint 场景在真实 Chrome 里量 (\d+) 项/);
    const resumeDoc = ONE.match(/resume 那场 (\d+) 项/);
    ok(!!hintDoc && +hintDoc[1] === per[5], `D7f hint 那场的两处说法一致（${hintDoc ? hintDoc[1] : '?'} vs 分解 ${per[5]}）`,
      `分解 hint=${per[5]}`);
    ok(!!resumeDoc && +resumeDoc[1] === per[4], `D7g resume 那场的两处说法一致（${resumeDoc ? resumeDoc[1] : '?'} vs 分解 ${per[4]}）`,
      `分解 resume=${per[4]}`);
  }
  const marksResume = VERIFY.indexOf('marks') < VERIFY.indexOf('resume') && VERIFY.indexOf('resume') < VERIFY.indexOf('hint');
  ok(marksResume, 'D7h verify.sh 里 marks→resume→hint 的顺序没换（DESIGN §8 那条硬要求）',
    `marks@${VERIFY.indexOf('marks')} resume@${VERIFY.indexOf('resume')} hint@${VERIFY.indexOf('hint')}`);
}

// ---- D8 玩家看到的那三条规则：index.html 的规则列表 == README 说的三条 ----
if (want('D8')) {
  const start = HTML.indexOf('<ol class="rules">');
  const lis = start < 0 ? -1 : [...HTML.slice(start, HTML.indexOf('</ol>', start)).matchAll(/<li>/g)].length;
  const docThree = DOCS.match(/侧栏那(\S)条就是规则本体/);
  ok(lis === 3 && !!docThree && fromCN(docThree[1]) === lis,
    `D8a index.html 的规则表解析到 ${lis} 条 == README 那句「那${docThree ? docThree[1] : '?'}条就是规则本体」`,
    `页面 ${lis} 条 · 文档 ${docThree ? docThree[1] : '未解析'}`);
  const h3 = (HTML.match(/这三条就是全部规则/) || [])[0];
  ok(!!h3 && lis === 3, `D8b 页面标题那句「这三条就是全部规则」与 <li> 的条数同为 3`, `页面标题在=${!!h3} · li=${lis}`);
  const keysInDoc = [...README.matchAll(/`([a-z0-9-]+)` \/ `([a-z0-9-]+)`/g)].flatMap((m) => [m[1], m[2]]);
  const missing = keysInDoc.filter((k) => !RULE_ORDER.includes(k));
  ok(keysInDoc.length === 6 && new Set(keysInDoc).size === 6 && missing.length === 0,
    `D8c README 给三条规则配的 ${keysInDoc.length} 个引擎谓词名全部在 RULE_ORDER 里（谓词改名就红在这里）`,
    keysInDoc.join('/') + (missing.length ? ` · 不在表里：${missing.join('/')}` : ''));
  const rulesAt = README.match(/（`index\.html:(\d+)-(\d+)`）/);
  const olLine = HTML.split('\n').findIndex((l) => l.includes('<ol class="rules">')) + 1;
  ok(!!rulesAt && +rulesAt[1] <= olLine && +rulesAt[2] >= olLine,
    `D8d README 写的 index.html:${rulesAt ? `${rulesAt[1]}-${rulesAt[2]}` : '未解析'} 罩住那条 <ol class="rules">（现在第 ${olLine} 行）`,
    `<ol> 第 ${olLine} 行 · 文档 ${rulesAt ? rulesAt.slice(1).join('-') : '未解析'}`);
  const statCells = [...HTML.matchAll(/<div class="stat"><span>([^<]+)<\/span>/g)].map((m) => m[1]);
  const keyHint = (README.match(/`index\.html:(\d+)`，实现在/) || [])[1];
  ok(statCells.length === 8 && !!keyHint && HTML.split('\n')[+keyHint - 1].includes('keyhint'),
    `D8e 侧栏读数单元 ${statCells.length} 个（${statCells.join('/')}），且 README 引用的 index.html:${keyHint || '?'} 真的坐在快捷键那一行`,
    `stat=${statCells.length} · 引用行=${keyHint ? HTML.split('\n')[+keyHint - 1].slice(0, 24) : '未解析'}`);
}

// ---- D9 存档与默认 seed 策略：文档说的键名、字符表、随机来源 == store / game / main / rng ----
if (want('D9')) {
  const key = (STORE_SRC.match(/const KEY = '([^']+)'/) || [])[1];
  const docKey = README.match(/存档只有一个键 `([^`]+)`/);
  ok(!!key && !!docKey && docKey[1] === key, `D9a 存档键 ${key || '解析不到'} == README 抄的「${docKey ? docKey[1] : '未解析'}」`,
    `代码 ${key || '?'} vs 文档 ${docKey ? docKey[1] : '?'}`);
  const markChars = [...GAME_SRC.matchAll(/\[([A-Z]+)\]: '(\d)'/g)].map((m) => `${m[1]}=${m[2]}`);
  ok(markChars.join(',') === 'UNKNOWN=0,LOOP=1,CUT=2' && /`'0'\/'1'\/'2'`/.test(README),
    `D9b 三态字符表 ${markChars.join(' ')} == README 那句 '0'/'1'/'2'（一条边三态在存储里的形状）`, markChars.join('/'));
  const mintBody = MAIN_SRC.match(/function mintSeed\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  ok(/crypto\.getRandomValues/.test(mintBody) && !/Date\.now|new Date/.test(mintBody),
    `D9c 「换一局」的 seed 由 crypto 现造、不是日期函数（README 那句有代码背书）`,
    `mintSeed crypto=${/crypto\.getRandomValues/.test(mintBody)} · Date=${/Date\.now|new Date/.test(mintBody)}`);
  ok(!/dailySeed|daily/i.test(RNG_SRC) && !/<input[^>]*seed/i.test(HTML),
    `D9d rng.js 里没有日课种子、index.html 里没有 seed 输入框（README「这一仓没做，别说」是代码成立的说法）`,
    `rng daily 命中=${/daily/i.test(RNG_SRC)} · seed 输入框命中=${/<input[^>]*seed/i.test(HTML)}`);
  const engCode = codeOnly(GEN_SRC + PENCIL_SRC + COUNTER_SRC + LOOP_SRC + RNG_SRC);
  ok(!/Math\.random|Date\.now|performance\.now|new Date/.test(engCode) && /一点随机都没有/.test(README),
    `D9e 五个引擎文件（剥掉注释后的代码）里没有 Math.random、也没有任何时钟读数（README 那句「生成器内部一点随机都没有」）`,
    `剥注释后 Math.random=${/Math\.random/.test(engCode)} · 时钟=${/Date\.now|performance\.now|new Date/.test(engCode)}（generate.js:3 那句注释自己就写着这件事，所以判的必须是剥掉注释的代码）`);
  ok(/export const UNKNOWN = 0;/.test(PENCIL_SRC) && /export const LOOP = 1;/.test(PENCIL_SRC) && /export const CUT = 2;/.test(PENCIL_SRC) &&
    /边数组是 `Uint8Array\(edgeCount\(w,h\)\)`/.test(DESIGN) && /const ecount = edgeCount\(w, h\);/.test(PENCIL_SRC) &&
    /edges: new Uint8Array\(ecount\)/.test(PENCIL_SRC),
    `D9f 三态常量 0/1/2 与 DESIGN 那句「边数组是 Uint8Array(edgeCount(w,h))」都有代码背书（createState 现在就这两步：pencil.js:79 与 :94）`,
    `三态=${/export const UNKNOWN = 0;/.test(PENCIL_SRC)} · ecount=edgeCount(w, h)=${/const ecount = edgeCount\(w, h\);/.test(PENCIL_SRC)} · new Uint8Array(ecount)=${/edges: new Uint8Array\(ecount\)/.test(PENCIL_SRC)}`);
  ok(!/UNSHIPPABLE/.test(ENGINE_ALL) && /本仓没有 `UNSHIPPABLE` 那一张表/.test(DESIGN),
    `D9g DESIGN 那句「本仓没有 UNSHIPPABLE 那一张表」== 代码现在确实长不出它`, `代码命中=${/UNSHIPPABLE/.test(ENGINE_ALL)}`);
  ok(/t\.solved\+\+/.test(STORE_SRC) && !/hint/i.test(STORE_SRC.match(/recordSolve[\s\S]*?\n  \}/)?.[0] || '') &&
    /没有\*\*"无提示通关"的纪录口径/.test(DESIGN),
    `D9h 「提示次数不入账」是代码成立的说法（recordSolve 只累计 solved/moves/ms）`,
    `recordSolve 里 hint 命中=${/hint/i.test(STORE_SRC.match(/recordSolve[\s\S]*?\n  \}/)?.[0] || '')}`);
}

// ---- D10 符号锚点：文档为某个文件写的 `file:NN`，必须真的罩到该符号现在的行 ----
if (want('D10')) {
  const lineOf = (file, re) => { const a = read(file).split('\n'); for (let i = 0; i < a.length; i++) if (re.test(a[i])) return i + 1; return -1; };
  const rangesFor = (file) => {
    const esc = file.replace(/[./]/g, '\\$&');
    return [...DOCS.matchAll(new RegExp('`' + esc + ':(\\d+)(?:-(\\d+))?`', 'g'))].map((m) => [+(m[1]), +(m[2] || m[1])]);
  };
  // 文档凡是「名字 + 位置」同现的引用——`name`（`file:NN-MM`）或（`file:NN-MM` 的 `name`）——逐条核：
  // 那个名字现在真的落在被引的那几行里吗？这是文档自己许下的「代码在哪一行」的说法，代码挪了位
  // 而文档没跟着改，就红在这里。删掉一条这种引用，本闸少一项，D18 立刻红（所以这里不怕"引用变少"）。
  const resolveFile = (p) => {
    if (existsSync(join(ROOT, p))) return p;
    const base = p.split('/').pop();
    for (const d of ['tools/', 'js/engine/', 'js/', 'js/ui/', 'js/render/', 'css/', 'electron/', '']) if (existsSync(join(ROOT, d + base))) return d + base;
    return null;
  };
  const named = [];
  for (const m of DOCS.matchAll(/`([A-Za-z_][\w.$-]*(?:\(\))?)`\s*[（(]\s*`([\w./-]+?\.(?:js|mjs|cjs|sh|json|html|yml)):(\d+)(?:-(\d+))?`/g)) {
    named.push({ name: m[1], file: m[2], a: +m[3], b: +(m[4] || m[3]) });
  }
  for (const m of DOCS.matchAll(/`([\w./-]+?\.(?:js|mjs|cjs|sh|json|html|yml)):(\d+)(?:-(\d+))?`\s*的\s*`([A-Za-z_][\w.$-]*(?:\(\))?)`/g)) {
    named.push({ name: m[4], file: m[1], a: +m[2], b: +(m[3] || m[2]) });
  }
  const uniq = [];
  const seen = new Set();
  for (const c of named) {
    const k = `${c.name}|${c.file}|${c.a}|${c.b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(c);
  }
  ok(uniq.length >= 12, `D10a 文档里「名字 + 行号」同现的引用解析到 ${uniq.length} 条（少于 12 条就是引用格式被改了，整组会空转）`,
    `${uniq.length} 条：${uniq.slice(0, 3).map((c) => `${c.name}@${c.file}:${c.a}`).join(' ')}`);
  for (const c of uniq) {
    const rp = resolveFile(c.file);
    const lines = rp ? read(rp).split('\n') : null;
    const bare = c.name.replace(/\(\)$/, '');
    const cands = [bare, bare.split('.').pop()].filter((x) => x.length > 1);
    const seg = lines ? lines.slice(c.a - 1, c.b).join('\n') : '';
    const at = lines ? lines.findIndex((l, i) => i + 1 >= c.a && i + 1 <= c.b && cands.some((n) => l.includes(n))) + 1 : 0;
    ok(!!rp && at > 0, `D10 ${c.file}:${c.a}${c.b !== c.a ? `-${c.b}` : ''} 指的「${c.name}」现在还在那几行里`,
      rp ? `代码第 ${at || '——'} 行 · 该范围内 ${cands.join('/')} 命中=${at > 0}` : '文件不在树里');
  }
  const scenLine = lineOf('tools/scenarios.js', /seed: 'gate-render-6'/);
  const scenCite = (DOCS.match(/`tools\/scenarios\.js:(\d+)`/) || [])[1];
  ok(scenLine > 0 && !!scenCite && +scenCite === scenLine,
    `D10 「scenarios.js:${scenCite || '未解析'}」指的就是 gate-render-6 那一行（现在第 ${scenLine} 行）`, `代码 ${scenLine} · 文档 ${scenCite || '?'}`);
  const orderLine = lineOf('tools/verify.sh', /marks → resume 是一对/);
  const verifyCite = DESIGN.match(/`tools\/verify\.sh:(\d+)-(\d+)`/);
  ok(orderLine > 0 && !!verifyCite && +verifyCite[1] <= orderLine && +verifyCite[2] >= orderLine + 2,
    `D10 DESIGN 写的 verify.sh:${verifyCite ? `${verifyCite[1]}-${verifyCite[2]}` : '未解析'} 罩住「marks→resume 成对」那条纪律（现在第 ${orderLine} 行起）`,
    `verify.sh 第 ${orderLine} 行 · 文档 ${verifyCite ? verifyCite.slice(1).join('-') : '未解析'}`);
  const resumeRange = [...DOCS.matchAll(/`tools\/scenarios\.js:(\d+)-(\d+)`/g)].map((m) => [+m[1], +m[2]]);
  const guardLine = lineOf('tools/scenarios.js', /版本护栏在浏览器这一侧也要走一遍/);
  ok(guardLine > 0 && resumeRange.some(([a, b]) => guardLine >= a && guardLine <= b),
    `D10 README 写的 scenarios.js:${resumeRange.map(([a, b]) => `${a}-${b}`).join('/') || '未解析'} 罩住续局护栏那一场（现在第 ${guardLine} 行）`,
    `代码第 ${guardLine} 行`);
}

// ---- D11 泛引用范围：README + DESIGN 里每一条 path:NN / path:NN-MM 都落在真实文件行数内 ----
if (want('D11')) {
  const cites = [...DOCS.matchAll(/((?:\.github\/workflows\/|js\/|tools\/|css\/|electron\/)?[\w./-]+\.(?:js|mjs|cjs|sh|json|html|yml)):(\d+)(?:-(\d+))?/g)];
  const resolve = (p) => {
    if (existsSync(join(ROOT, p))) return p;
    const base = p.split('/').pop();
    for (const d of ['tools/', 'js/engine/', 'js/', 'js/ui/', 'js/render/', 'css/', 'electron/', '']) if (existsSync(join(ROOT, d + base))) return d + base;
    return null;
  };
  const bad = [];
  for (const c of cites) {
    const rp = resolve(c[1]);
    if (!rp) { bad.push(`${c[1]}:${c[2]}（文件不存在）`); continue; }
    const n = read(rp).split('\n').length;
    if (+c[2] > n || (+c[3] && +c[3] > n)) bad.push(`${c[1]}:${c[2]}${c[3] ? '-' + c[3] : ''}（该文件只有 ${n} 行）`);
  }
  ok(cites.length >= 50, `D11a 文档里的 path:NN 引用解析到 ${cites.length} 条（少于 50 条就是引用格式被改了）`, `${cites.length} 条`);
  ok(bad.length === 0, `D11 每一条 path:NN 引用都落在真实文件的行数内（改了代码不重编行号就红在这里）`,
    bad.length ? `越界：${bad.slice(0, 6).join('，')}${bad.length > 6 ? ` …共 ${bad.length} 条` : ''}` : `${cites.length} 条全部在范围内`);
}

// ---- D12 承诺表：README 那张表每行点得到真东西，标题那句「N 条」等于行数 ----
if (want('D12')) {
  const hIndex = DOCS.search(/## 这[一二三四五六七八九十\d]+条承诺/);
  const heading = (README.match(/^## 这(\S)条承诺/m) || [])[1];
  const section = README.slice(hIndex < 0 ? 0 : hIndex, README.indexOf('## 这个仓**不承诺**什么'));
  const promiseRows = section.split('\n').filter((l) => /^\| \*\*/.test(l))
    .map((l) => { const cells = l.split('|').slice(1, -1).map((s) => s.trim()); return { name: cells[0], body: cells[1] || '' }; });
  ok(promiseRows.length >= 4, `D12a 承诺表解析到 ${promiseRows.length} 行（0 行就是整节被删）`, `${promiseRows.length} 行`);
  ok(!!heading && fromCN(heading) === promiseRows.length,
    `D12b 标题那句「这${heading || '?'}条承诺」== 表里现在的行数 ${promiseRows.length}（加了承诺不改标题就红在这里）`,
    `标题 ${heading || '未解析'} vs 行数 ${promiseRows.length}`);
  for (const r of promiseRows) {
    const targets = [...r.body.matchAll(/(?:js|tools)\/[\w./-]+?\.(?:js|mjs|cjs|sh)/g)].map((x) => x[0]);
    const real = targets.filter((p) => existsSync(join(ROOT, p)));
    ok(targets.length >= 1 && real.length === targets.length, `D12 ${r.name.slice(0, 8)}… 那一行点名的每一处 path 都在树里`,
      `点名 ${targets.length} · 在树 ${real.length}${real.length !== targets.length ? ` · 缺：${targets.filter((t) => !real.includes(t)).join(',')}` : ''}`);
  }
}

// ---- D13 接线：doctest 与 sabotage 进 verify.sh 的逻辑段、CI 的 check job、package.json 的 scripts ----
if (want('D13')) {
  const pkgHas = (k) => (PKG.scripts?.[k] || '').includes(`tools/${k}.mjs`);
  ok(pkgHas('doctest') && pkgHas('sabotage'), `D13a package.json 有 doctest 与 sabotage 两条 script 且都指向本仓 tools/`,
    `doctest=${PKG.scripts?.doctest || '无'} · sabotage=${PKG.scripts?.sabotage || '无'}`);
  ok(/node tools\/doctest\.mjs/.test(VERIFY) && /node tools\/sabotage\.mjs/.test(VERIFY),
    'D13b verify.sh 接了这两道逻辑闸（npm run verify 与 bash tools/verify.sh 跑同一件事）',
    `doctest=${/node tools\/doctest\.mjs/.test(VERIFY)} · sabotage=${/node tools\/sabotage\.mjs/.test(VERIFY)}`);
  const iD = VERIFY.indexOf('node tools/doctest.mjs'), iS = VERIFY.indexOf('node tools/sabotage.mjs'), iC = VERIFY.indexOf('"$CHROME" --headless=new');
  ok(iD >= 0 && iS >= 0 && iD < iC && iS < iC, 'D13c 两道闸都排在起 Chrome 之前（浏览器一红就不看文档了，顺序是这道闸的定义）',
    `doctest@${iD} · sabotage@${iS} · chrome@${iC}`);
  const foldD = /node tools\/doctest\.mjs[\s\S]{0,900}?LOGIC_FAILED=1/.test(VERIFY);
  const foldS = /node tools\/sabotage\.mjs[\s\S]{0,900}?LOGIC_FAILED=1/.test(VERIFY);
  const handoff = /FAILED=\$LOGIC_FAILED/.test(VERIFY);
  ok(foldD && foldS && handoff, 'D13d 两道闸的 rc 都折进 LOGIC_FAILED，并且 LOGIC_FAILED 交给 FAILED（只 echo 一声不算接线）',
    `doctest 折入=${foldD} · sabotage 折入=${foldS} · 交给 FAILED=${handoff}`);
  const subsetLock = /subset=none/.test(VERIFY) && /GOT_ROWS/.test(VERIFY);
  ok(subsetLock, 'D13e verify.sh 读的是闸自己打印的 STAMP/KNIVES 机器可行读数，并且拒绝「子集跑冒充整闸跑」',
    `subset=none 在=${/subset=none/.test(VERIFY)} · 行数控在=${/GOT_ROWS/.test(VERIFY)}`);
  const expG = +(VERIFY.match(/DOCTEST_EXPECT_GROUPS=(\d+)/) || [])[1];
  const expR = +(VERIFY.match(/DOCTEST_EXPECT_ROWS=(\d+)/) || [])[1];
  const expK = +(VERIFY.match(/SABOTAGE_EXPECT_KNIVES=(\d+)/) || [])[1];
  ok(expG > 0 && expR > 0 && expK >= 4, `D13f verify.sh 的期望表钉着本闸组/项与刀数（${expG}/${expR}/${expK}）——闸内自钉之外的第二把锁`,
    `verify.sh 期望 groups=${expG || '无'} rows=${expR || '无'} knives=${expK || '无'}`);
  const ciCheck = CI.slice(CI.indexOf('check:'), CI.indexOf('Entry files exist'));
  ok(/node tools\/doctest\.mjs/.test(ciCheck) && /node tools\/sabotage\.mjs/.test(ciCheck),
    'D13g ci.yml 的 check job 里同时接了 doctest 与 sabotage（本地绿＝CI 绿；不许有只在一侧才跑的那道）',
    `check 块 doctest=${/node tools\/doctest\.mjs/.test(ciCheck)} · sabotage=${/node tools\/sabotage\.mjs/.test(ciCheck)}`);
  ok(!/verify\.sh \|\|bash|bash tools\/verify\.sh|playtest\.cjs scenario|--headless/i.test(CI),
    'D13h CI 里确实没有浏览器闸（README/DESIGN 那句「CI 里没有浏览器门禁」继续成立）',
    `CI 命中 headless=${/--headless/i.test(CI)} · scenario=${/scenario/i.test(CI)}`);
  const docCiR = ONE.match(/只跑 `npm run check` \+ 那四套纯 Node([^；。]*)/);
  const docCiD = ONE.match(/只跑 `check` \+ 四套纯 Node([^）]*)/);
  ok(!!docCiR && /doctest/.test(docCiR[1]) && /sabotage/.test(docCiR[1]),
    'D13i README 那句「CI 跑什么」已经把这两道闸算进去了（接线改了不回填文档，就红在这里）',
    `README 那半句：${docCiR ? docCiR[1].trim().slice(0, 48) : '未解析'}`);
  ok(!!docCiD && /doctest/.test(docCiD[1]) && /sabotage/.test(docCiD[1]),
    'D13j DESIGN §9.6 那句「CI 只跑…」同样回填了这两道闸', `DESIGN 那半句：${docCiD ? docCiD[1].trim().slice(0, 48) : '未解析'}`);
  ok(PKG.scripts?.verify === 'bash tools/verify.sh', 'D13k npm run verify 就是那条本地闸命令（CI 不整跑它，因为它要真 Chrome）',
    `pkg.verify=${PKG.scripts?.verify}`);
  const docSize = ONE.match(/文档数字闸（(\d+) 组 \/ (\d+) 项）/);
  ok(!!docSize && +docSize[1] === EXPECT_GROUPS && +docSize[2] === EXPECT_ROWS,
    `D13l README 抄的本闸规模「${docSize ? `${docSize[1]} 组 / ${docSize[2]} 项` : '未解析'}」== 闸里钉的 ${EXPECT_GROUPS} 组 / ${EXPECT_ROWS} 项（闸自己的规模也是一个印出去的数）`,
    `README ${docSize ? docSize.slice(1).join('/') : '未解析'} vs 钉的 ${EXPECT_GROUPS}/${EXPECT_ROWS} · verify.sh ${(VERIFY.match(/DOCTEST_EXPECT_ROWS=(\d+)/) || [])[1] || '?'}`);
}

// ---- D14 墙钟那一类：只比「文档自己声明会漂」这层关系，绝不重测、也不把毫秒写回文档 ----
if (want('D14')) {
  const notes = [...DOCS.matchAll(/(墙钟那一列带争用|绝对毫秒只当上界看|不是对玩家的等待承诺|那个数是上界不是基线|墙钟真是双峰|别拿它当 SLA)/g)].map((m) => m[1]);
  ok(notes.length >= 4, `D14a 文档里四处以上写明「墙钟 ms 带争用／只当上界／不作承诺」（少了就是有人又把毫秒当基线写）`,
    `${notes.length} 处：${notes.join('、')}`);
  ok(/wallP95Ms: (\d+)/.test(BAL_SRC) && /每档墙钟 p95 ≤ (\d+)ms/.test(DESIGN) &&
    (BAL_SRC.match(/wallP95Ms: (\d+)/) || [])[1] === (DESIGN.match(/p95 ≤ (\d+)ms/) || [])[1],
    `D14b 那条绝对毫秒红线在代码与文档里是同一个数`, `代码 ${(BAL_SRC.match(/wallP95Ms: (\d+)/) || [])[1]} · 文档 ${(DESIGN.match(/p95 ≤ (\d+)ms/) || [])[1]}`);
  ok(/分位数：真实排序后取第 ceil\(q·n\) 个（nearest-rank，向上取整）。绝不由中位数推算/.test(BAL_SRC),
    `D14c「p50/p95 一律真排序取、不由中位推算」这句纪律在 balance 里是代码`, `注释命中=${/绝不由中位数推算/.test(BAL_SRC)}`);
  ok(!/\|\s*\d+ \/ \d+ \/ \d+ ms\s*\|.*→/.test(README) && /seed 串 balance\|<sizeKey>\|<1\.\.N> 固定/.test(BAL_SRC),
    `D14d 本闸不复测任何 ms，且 balance 的现跑口径是可复现 seed（墙钟列只以「文档声明它带争用」出现）`,
    `seed 口径=${/seed 串 balance\|<sizeKey>\|<1\.\.N> 固定/.test(BAL_SRC)}`);
}

// ---- D15 UNPINNED 台账：需要本机/浏览器才有值的读数不进等式，但每条都得「还在文档里」----
const UNPINNED = [
  ['U1', 'README 难度表的墙钟列（6 / 20 / 21 ms … 226 / 1341 / 1616 ms）', /\| 墙钟 p50\/p95\/max \|/, false],
  ['U2', 'SAMPLES=24 那一批 10×10 的旧墙钟（497 / 4841 / 5687 ms）', /497 \/ 4841 \/ 5687 ms/, false],
  ['U3', 'generator-probe 那一跑的合计秒数（实测 7.2 秒）', /实测 7\.2 秒/, false],
  ['U4', 'verify.sh 那一次浏览器的 99 项分解（本机 Chrome 才有值；本闸只核它的算术自洽）', /boot 11 \/ render 6/, false],
  ['U5', 'DESIGN §4 的 SAMPLES=24 门 0 丢环那串（10/10/16/33/43/18/24/37 = 191）', /按档排：10 \/ 10 \/ 16 \/ 33 \/ 43 \/ 18 \/ 24 \/ 37/, false],
  ['U6', '那几轮的时间戳与本机 load（2026-09-28 20:38 / load1 4.23 / 15 核）', /load1 4\.23 \/ 15 核/, false],
];
if (want('D15')) {
  UNPINNED.forEach(([id, what, re]) => {
    const hits = (DOCS.match(re) || []).length;
    ok(hits >= 1, `D15 ${id}「${what}」还写在文档里（钉不住 ≠ 可以删；删了就是这一条红）`, `${hits} 处`);
  });
  const found = UNPINNED.filter(([, , re]) => re.test(DOCS)).length;
  ok(found === UNPINNED.length, `D15a 反空转：${UNPINNED.length} 条 unpinned 逐条在文档里找到 needle`, `${found}/${UNPINNED.length}`);
  ok(/门 0 一共丢了 191 次环/.test(DESIGN) && [10, 10, 16, 33, 43, 18, 24, 37].reduce((a, b) => a + b, 0) === 191 &&
    /各抽 24 盘|SAMPLES=24/.test(DESIGN),
    `D15b unpinned 那一串只做算术自洽（八个数之和 == 文档写的 191），不拿它当现跑等式（它是 SAMPLES=24 的读数）`,
    `Σ=${[10, 10, 16, 33, 43, 18, 24, 37].reduce((a, b) => a + b, 0)} vs 文档 191`);
}

// ---- D16 破坏试验台账：文档抄的刀数 == sabotage.mjs 的 KNIVES；每格 rc 是读回来的数字 ----
if (want('D16')) {
  const sabSrc = existsSync(join(ROOT, 'tools/sabotage.mjs')) ? read('tools/sabotage.mjs') : '';
  const heads = [...sabSrc.matchAll(/^    id: '(K\d+)', group: '(D\d+[a-z]?)'/gm)]; // 行首锚定：刀自己的 from/to 字面量里也写着 id/group，不锚定就会把刀数成 20 把
  const knifeIds = heads.map((m) => m[1]), groups = heads.map((m) => m[2]);
  ok(knifeIds.length >= 18, `D16a sabotage.mjs 里十八把刀一把不少（当前 ${knifeIds.length} 把：${knifeIds.join(' ')}）`, `${knifeIds.length} 把`);
  ok(new Set(groups).size === groups.length && groups.length === knifeIds.length,
    `D16b 每把刀打的是不同断言组（刀 ${knifeIds.length} 把 · 组 ${groups.join(' ')}）`, groups.join('/'));
  const knifeDoc = (README.match(/破坏试验台账（(\d+) 把刀）/) || [])[1];
  ok(!!knifeDoc && +knifeDoc === knifeIds.length, `D16c README 那句「台账（${knifeDoc || '?'} 把刀）」== 脚本里的刀数`,
    `文档 ${knifeDoc || '未解析'} vs 脚本 ${knifeIds.length}`);
  const rcCells = knifeIds.map((id) => { const m = sabSrc.match(new RegExp(`id: '${id}'[\\s\\S]*?rc: '(\\d+|\\?)'`)); return m ? m[1] : null; });
  ok(rcCells.every((x) => x && /^\d+$/.test(x)), `D16d 台账每一格 rc 都是从闸读回来的数字（'?' 表示这一版还没整跑过）`, rcCells.join(' / '));
  const asserts = [...sabSrc.matchAll(/assert: \//g)];
  ok(asserts.length === knifeIds.length, `D16e 每把刀都配了一条「点名的 FAIL 行」正则（解析到 ${asserts.length} 条）`, `${asserts.length}/${knifeIds.length}`);
}

// ---- D17 站点形态与运行前提：README/DESIGN 抄的依赖、pages 拷贝清单、模块口径 ----
if (want('D17')) {
  const depKeys = Object.keys(PKG.dependencies || {});
  const dev = Object.keys(PKG.devDependencies || {});
  ok(depKeys.length === 0 && dev.length === 1 && dev[0] === 'electron' && /运行时零依赖/.test(README),
    `D17a 运行时零依赖：dependencies ${depKeys.length} 项 / devDependencies [${dev}]（README 那句「只有 devDependencies 的 Electron」）`,
    `deps=[${depKeys}] dev=[${dev}]`);
  // 拷贝清单的出处只许有一个。旧形状是 pages.yml 手抄 `cp` 行；新形状是 pages.yml 调
  // tools/assemble-site.sh，那份清单同时被本地部署集闸拿去拷临时目录——上线那份与验的那份于是同一份。
  // 两处都在说"拷哪些"就是清单分家（这一轮的坏法本身），所以先数出处，再把数出来的集合与
  // README 点名的集合逐字比；集合相等是等式，不是"包含 index.html 就算绿"。
  const cpArgs = (l) => l.trim().split(/\s+/)
    .filter((t) => t !== '-r' && !t.includes('$') && !t.includes('_site'))
    .map((t) => t.replace(/"/g, '').replace(/\/$/, '')).filter(Boolean);
  const cpOf = (text, dest) => [...text.matchAll(/^[ \t]*cp (.+)$/gm)].map((m) => m[1])
    .filter((l) => l.includes(dest)).flatMap(cpArgs);
  const ASSEMBLE_SRC = existsSync(join(ROOT, 'tools/assemble-site.sh')) ? read('tools/assemble-site.sh') : '';
  const handCp = cpOf(PAGES, '_site');
  const scriptCp = cpOf(ASSEMBLE_SRC, '$DEST');
  const loopDirs = /^\s*for d in ([^;]+); do/gm.test(ASSEMBLE_SRC) && /\[ -d "\$d" \] && cp -r "\$d"/.test(ASSEMBLE_SRC)
    ? [...ASSEMBLE_SRC.matchAll(/^\s*for d in ([^;]+); do/gm)].flatMap((m) => m[1].trim().split(/\s+/))
      .filter((d) => existsSync(join(ROOT, d)))
    : [];
  const sources = [scriptCp.length ? 'tools/assemble-site.sh' : '', handCp.length ? 'pages.yml 的 cp 行' : ''].filter(Boolean);
  const copies = [...new Set(sources.length === 1 ? scriptCp.concat(handCp, loopDirs) : [])].sort();
  const docDecl = ((README.match(/站点里现在是：([^\n]*?)——/) || ['', ''])[1]).trim().split(/\s+/)
    .map((t) => t.replace(/`/g, '')).filter(Boolean).sort();
  ok(copies.length > 0 && copies.join(' ') === docDecl.join(' ') && !copies.includes('tools'),
    `D17b 拷进 artifact 的清单只有一处（${sources.join(' 与 ') || '没有出处'}）：数出来 ${copies.length} 项 == README 点名的 ${docDecl.length} 项，tools 不在其中`,
    `${sources[0] || '?'} → ${copies.join(' + ')}`);
  ok(!/golden/i.test(SCEN) && !existsSync(join(ROOT, 'tools/fixtures')) && /没有 golden 夹具/.test(README),
    `D17c「这一仓没有 golden 夹具」成立（scenarios.js 里没有冻结答案表，tools/ 下也没有 fixtures 目录）`,
    `scenarios 命中=${/golden/i.test(SCEN)} · tools/fixtures=${existsSync(join(ROOT, 'tools/fixtures'))}`);
  ok(PKG.type === 'module' && !/require\(/.test(PENCIL_SRC + GEN_SRC) && /<script type="module"/.test(HTML),
    `D17d 引擎是 plain ES 模块（package.json type=${PKG.type}、index.html 用 type="module"、引擎里没有 require）`,
    `type=${PKG.type} · 引擎 require=${/require\(/.test(PENCIL_SRC + GEN_SRC)} · html module=${/<script type="module"/.test(HTML)}`);
  ok(/`tools\/` 不进站点/.test(README) && !copies.some((c) => c === 'tools' || c.startsWith('tools/')),
    `D17e「tools/ 不进站点」这句与清单（${sources[0] || '没有出处'}）一致`, `清单 ${copies.join(' + ')}`);
}

// ---- D18 自数：这道闸自己发出的组数与项数都钉死 —— 删一条 test/少解析一行就是这里红 ----
if (ONLY.length) {
  console.log(`  NOTE 子集跑（DOC_GROUPS=${ONLY.join(',')}）：本次只发 ${emitted.size} 组 / ${rows} 项；`
    + `自钉（${EXPECT_GROUPS} 组 / ${EXPECT_ROWS} 项）与 balance、四套闸的现跑本次没检查`);
} else {
  ok(emitted.size + 1 === EXPECT_GROUPS, `D18a 本闸发出 ${emitted.size} 组 + 本条所在的 D18 == 钉的 ${EXPECT_GROUPS} 组（删一组就红在这里）`,
    [...emitted, 'D18'].sort((a, b) => +a.slice(1) - +b.slice(1)).join(' '));
  // 自数要对着**最终**项数比：本条之后还有一条 D18c，所以这里是 rows + 2 而不是 rows + 1。
  ok(rows + 2 === EXPECT_ROWS, `D18b 本闸项数（含本条与后面那条 D18c）== 钉的 ${EXPECT_ROWS}，与 verify.sh 的 DOCTEST_EXPECT_ROWS 同一把锁（增/删一条 ok() 都要同时改这两处）`,
    `本条之前 ${rows} 项，本条 + D18c 之后 ${rows + 2} 项`);
  ok(VERIFY.includes(`DOCTEST_EXPECT_GROUPS=${EXPECT_GROUPS}`) && VERIFY.includes(`DOCTEST_EXPECT_ROWS=${rows + 1}`),
    'D18c 两把锁现在真的是同一个数：verify.sh 的 DOCTEST_EXPECT_GROUPS/ROWS 与本闸的 EXPECT_GROUPS 与本次项数逐字相同',
    `verify.sh ${EXPECT_GROUPS}/${rows + 1} vs 本闸 ${EXPECT_GROUPS}/${rows + 1}`);
}

console.log(`\n合计 ${rows} 项，${fail.length} 项失败`);
console.log(`STAMP groups=${emitted.size} rows=${rows} subset=${ONLY.length ? ONLY.join(',') : 'none'}`);
if (fail.length) { for (const f of fail) console.log(`  未过：${f}`); process.exit(1); }
process.exit(0);
