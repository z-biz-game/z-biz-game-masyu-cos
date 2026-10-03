// 破坏试验台账：把「文档抄的是一个已经不存在的数」这件事，一类谎一类谎地塞回代码里，
// 证明 tools/doctest.mjs 真的会红，而且红的就是文档点名的那一条断言 —— 不是随便一条别的红。
//
// 为什么要这道闸：doctest 是绿的，但「绿」有两种：一种是被断言真的守住了，一种是解析器集体扑空
// （表格改了形状、锚点被删空、balance 没跑起来）。前者绿是成绩，后者绿是假账。唯一的分辨办法是
// 主动把代码改坏，看这道闸是不是立刻变红并且报出对应的那一条。这里就把每一类谎固化成一把刀。
//
// 五条规矩：
//   1. 每把刀改一个真实的代码文件（不是改文档），当场跑 tools/doctest.mjs（DOC_GROUPS 只跑那一组，
//      子集跑会打 NOTE，不会静默跳过自钉），读回真实 rc；
//   2. rc 必须 != 0，而且日志里必须出现「文档点名的那条断言」的 FAIL 行 —— 只红在别处不算逼到；
//   3. 复原只用内存里读回来的原始字节 writeFileSync，绝不借 git 命令复原；复原后再逐字节回读比对；
//   4. 台账的 rc 一格是「从脚本读回来的真实读数」，自钉必须幂等：本文件把整个台账跑两遍，
//      两遍的输出必须逐字节相同（刀数、rc、点名的断言都不许变）；
//   5. 最后跑一遍「对照」：不带任何破坏的完整 doctest 必须是绿的，证明台账不是靠把闸改坏来让自己变绿。
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (rel) => join(ROOT, rel);

// 十八把刀，doctest 的十八个组一组一把（D1 菜单档位、D2 权重表、D3 档位全景、D4 支配门槛、D5 四套闸的
// 条数、D6 端口默认号、D7 场景序列、D8 侧栏规则条数、D9 存档键名、D10 符号锚点、D11 引用越界、
// D12 承诺表点名的路径、D13 接线、D14 毫秒红线、D15 unpinned needle、D16 台账自己、D17 站点拷贝清单、
// D18 本闸项数）。除 D2/D3/D4/D5/D18 之外都是纯文本/常量的最小扰动，子集跑每把只要零点几秒；
// 那四把要现跑 balance 或 rule-test，D18 只能整闸跑（自钉在子集跑里被 NOTE 跳过，见下面 full）。
// 两把刀用别的落法：D12 的靶面是「文档点名的路径还在不在树里」，只能把文件挪开（rename）；
// D16 的靶面是台账自己，所以它改的是本文件里另一把刀的组名。
const KNIVES = [
  {
    id: 'K1', group: 'D1', file: 'js/engine/generate.js',
    from: "export const SIZES = ['6x6', '7x7', '8x8', '9x9', '10x10'];",
    to: "export const SIZES = ['6x6', '7x7', '8x8', '9x9'];",
    breaks: '把菜单最后一档 10×10 从 SIZES 里删掉（文档难度表与「菜单五档」写的都是五档）',
    assert: /^.*FAIL .*D1a README 的「菜单五档」解析到.*$/m,
    rc: '1',
  },
  {
    id: 'K2', group: 'D6', file: 'server.cjs',
    from: 'const DEFAULT_PORT = 5276;', to: 'const DEFAULT_PORT = 5277;',
    breaks: '把 server.cjs 的默认端口从 5276 改成 5277（文档、verify.sh、package.json dev 三处都还写着 5276，四处不再同源）',
    assert: /^.*FAIL .*D6 HTTP 默认号三处同源.*$/m,
    rc: '1',
  },
  {
    id: 'K3', group: 'D8', file: 'index.html',
    from: '          <li><b>白珠</b>', to: '          <li-x><b>白珠</b>',
    breaks: '把侧栏规则列表第二条的 <li> 改成别的标签（文档明写「侧栏那三条就是规则本体」，页面只剩两条）',
    assert: /^.*FAIL .*D8a index\.html 的规则表解析到.*$/m,
    rc: '1',
  },
  {
    id: 'K4', group: 'D9', file: 'js/store.js',
    from: "const KEY = 'masyu.save.v1';", to: "const KEY = 'masyu.save.v2';",
    breaks: '把存档键改成 v2（README 抄的是 `masyu.save.v1`，键名一改旧存档就不是那一份了）',
    assert: /^.*FAIL .*D9a 存档键 .* == README 抄的.*$/m,
    rc: '1',
  },
  {
    id: 'K5', group: 'D2', file: 'tools/balance.mjs',
    from: "'no-2x2-square': 4,", to: "'no-2x2-square': 6,",
    breaks: '把 2×2 那条规则的权重从 4 分改成 6 分（README 的规则权重句写的就是「2×2 4 分」，代码一改文档就成了抄来的谎）',
    assert: /^.*FAIL .*D2i .*权重表现值.*$/m,
    rc: '1',
  },
  {
    id: 'K6', group: 'D3', file: 'tools/balance.mjs',
    from: 'const EXTRA_SIZES = Object.keys(SIZE_TABLE).filter((k) => !SIZES.includes(k));',
    to: "const EXTRA_SIZES = Object.keys(SIZE_TABLE).filter((k) => !SIZES.includes(k) && k !== '7x6');",
    breaks: '让 balance 的档位全景少测一档（7x6 那组对照不再进 LADDER，难度表却还写着八行）',
    assert: /^.*FAIL .*D3b balance 的逐档明细解析到.*$/m,
    rc: '1',
  },
  {
    id: 'K7', group: 'D4', file: 'tools/balance.mjs',
    from: 'dominance: 0.85,', to: 'dominance: 0.86,',
    breaks: '把「支配概率」的门槛从 0.85 抬到 0.86（文档三处都还写着 0.85 与「门槛 0.85」）',
    assert: /^.*FAIL .*D4c 门槛三处同源.*$/m,
    rc: '?',
  },
  {
    id: 'K8', group: 'D5', file: 'tools/rule-test.mjs',
    from: "check(extra.length === 0, '用例里没有已删除的规则', `多：${extra.join(', ')}`);\n", to: '',
    breaks: '删掉 rule-test 的一条断言（它现场报的「合计 N 条通过」立刻少 1，而文档抄的是删之前的条数）',
    assert: /^.*FAIL .*D5a rule-test 现跑.*$/m,
    rc: '1',
  },
  {
    id: 'K9', group: 'D7', file: 'tools/verify.sh',
    from: 'for s in ${SCENARIOS:-boot render play marks resume hint}; do',
    to: 'for s in ${SCENARIOS:-boot render play marks resume hint extra}; do',
    breaks: '给默认场景序列加第七场却不回填 README 的六场分解（分解之和与合计就此对不上）',
    assert: /^.*FAIL .*D7a verify\.sh 的默认场景序列.*$/m,
    rc: '1',
  },
  {
    id: 'K10', group: 'D10', file: 'tools/scenarios.js',
    from: '// 浏览器里的场景套件，由 tools/playtest.cjs 注入真实页面后跑。六个场景：',
    to: '// （台账刀：临时在最前面插一行，让下面每一行的行号都漂 1）\n// 浏览器里的场景套件，由 tools/playtest.cjs 注入真实页面后跑。六个场景：',
    breaks: '在 scenarios.js 顶部插一行（文档为 gate-render-6 那一行写的 `tools/scenarios.js:NN` 立刻指到隔壁行）',
    assert: /^.*FAIL .*scenarios\.js:\d+」指的就是 gate-render-6 那一行.*$/m,
    rc: '1',
  },
  {
    id: 'K11', group: 'D11', file: 'js/engine/counter.js',
    from: '  // MULTIPLE 的意思就是"数到了 >1"，和 cap 无关：cap 只是"早点收工"的开关。\n'
      + '  // 之前写成 count >= cap，于是把 cap 放大去精确数的时候，40 解会被报成 NONE。\n'
      + "  const status = overbudget ? 'OVERBUDGET' : count > 1 ? 'MULTIPLE' : count === 1 ? 'UNIQUE' : 'NONE';\n",
    to: '',
    breaks: '把 counter.js 末尾三行删掉（文件短了 3 行，文档里那条 `js/engine/counter.js:125-315` 的引用就出了界）',
    assert: /^.*FAIL .*D11 每一条 path:NN 引用都落在真实文件的行数内.*$/m,
    rc: '1',
  },
  {
    id: 'K12', group: 'D12', file: 'tools/pencil-test.mjs', rename: 'tools/pencil-test.mjs.off',
    breaks: '把承诺表那一行点名的 tools/pencil-test.mjs 挪出树（这一组的靶面就是「文档点名的路径还在不在」，只能挪文件，不改内容）',
    assert: /^.*FAIL .*那一行点名的每一处 path 都在树里.*$/m,
    rc: '1',
  },
  {
    id: 'K13', group: 'D13', file: 'package.json',
    from: '"doctest": "node tools/doctest.mjs",', to: '"doctestOff": "node tools/doctest.mjs",',
    breaks: '把 package.json 的 doctest script 改名（npm run doctest 不再存在，D13 那句「两条 script 都在」就空了）',
    assert: /^.*FAIL .*D13a package\.json 有 doctest 与 sabotage.*$/m,
    rc: '1',
  },
  {
    id: 'K14', group: 'D14', file: 'tools/balance.mjs',
    from: 'wallP95Ms: 8000,', to: 'wallP95Ms: 8001,',
    breaks: '把那条绝对毫秒红线抬 1ms（DESIGN 写的「p95 ≤ 8000ms」与代码不再是同一个数——这一组不比现跑，比的正是这层同源）',
    assert: /^.*FAIL .*D14b 那条绝对毫秒红线在代码与文档里是同一个数.*$/m,
    rc: '1',
  },
  {
    id: 'K15', group: 'D15', file: 'tools/doctest.mjs',
    from: ', /boot 11 \\/ render 6/, false],', to: ', /boot 11 \\/ render 66/, false],',
    breaks: '把 unpinned 台账里 U4 那条 needle 改宽（正则一旦扑空，那条读数就从「还在文档里」变成没人看着——D15a 的反空转就是为这个写的）',
    assert: /^.*FAIL .*D15 U4「.*$/m,
    rc: '1',
  },
  {
    id: 'K16', group: 'D16', file: 'tools/sabotage.mjs',
    // 这一把的靶面是本文件自己的 KNIVES 数组，所以针必须拆成两段写：连着写的话 K16 的 from 字面量里
    // 也有一份同样的文本，前置的「恰好命中一次」就会拒落这把刀（试过一次，报的是命中 3 次）。
    from: "    id: 'K3', group: 'D8', " + "file: 'index.html',",
    to: "    id: 'K3', group: 'D6', " + "file: 'index.html',",
    breaks: '让两把刀打同一组（K3 的组名改成 D6，与 K2 撞车）——「一组一把」是这一组唯一的判据',
    assert: /^.*FAIL .*D16b 每把刀打的是不同断言组.*$/m,
    rc: '1',
  },
  {
    id: 'K17', group: 'D17', file: '.github/workflows/pages.yml',
    from: '          cp -r css js _site/', to: '          cp -r css js tools _site/',
    breaks: '往 pages 的拷贝清单里加一个 tools（README 那句「tools/ 不进站点」与 DESIGN 那句「三项」同时失去代码背书）',
    assert: /^.*FAIL .*D17b pages\.yml 拷进 artifact 的就是.*$/m,
    rc: '1',
  },
  {
    id: 'K18', group: 'D18', file: 'tools/doctest.mjs',
    from: 'const EXPECT_ROWS = 232;', to: 'const EXPECT_ROWS = 231;',
    full: 1,
    breaks: '把本闸自己钉的项数悄悄改小 1（子集跑会 NOTE 掉自钉，所以这把必须整闸跑——那正是「删一条断言不改两处锁」这类谎的形状）',
    assert: /^.*FAIL .*D18b 本闸项数.*$/m,
    rc: '1',
  },
];

const runGate = (groups) => {
  const r = spawnSync('node', ['tools/doctest.mjs'], {
    cwd: ROOT, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(groups ? { DOC_GROUPS: groups } : {}) },
  });
  return { rc: r.status === null ? -1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
};

// 干净树前提：**刀要落的那个文件**必须是已提交的那一版（未跟踪的新工具文件、正在改的文档都不算脏——
// 文档正是本闸要核的面，把它算成"脏"就等于不让核文档）。
const targets = [...new Set(KNIVES.map((k) => k.file))];
let dirty = [];
try {
  dirty = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', ...targets], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
} catch (e) {
  console.log('  前置：git 读不到（台账要求刀口所在文件是已提交版本）'); process.exit(2);
}
if (dirty.length) { console.log(`  刀口不干净：${dirty.join(' ')} 有未提交的 tracked 改动 —— 台账要在定稿的树上落刀，不然"复原"就没了参照`); process.exit(2); }
console.log(`前置：${targets.join(' ')} 都是已提交的那一版（逐字节可复原）`);

const problems = [];
for (const k of KNIVES) {
  if (k.rename) { // 挪文件那把：靶面是「路径还在不在树里」，所以先确认两边都如预期
    if (!existsSync(p(k.file))) problems.push(`${k.id}: 要挪走的 ${k.file} 不在树里`);
    if (existsSync(p(k.rename))) problems.push(`${k.id}: 落点 ${k.rename} 已经存在，不敢挪`);
    continue;
  }
  const src = readFileSync(p(k.file), 'utf8');
  const nFrom = src.split(k.from).length - 1;
  if (nFrom !== 1) problems.push(`${k.id}: ${k.file} 里 from 命中 ${nFrom} 次（必须恰好 1 次才敢改）`);
}
if (problems.length) { for (const x of problems) console.log(`  前置不干净：${x}`); process.exit(1); }

function runPass() {
  const lines = [];
  const ledger = [];
  const say = (s) => { lines.push(s); console.log(s); };
  for (const k of KNIVES) {
    const original = readFileSync(p(k.file), 'utf8'); // 原始字节进内存，复原只认这份
    const how = k.full ? '完整跑（自钉只在整闸跑里检查）' : `DOC_GROUPS=${k.group} 子集跑`;
    let gate;
    if (k.rename) {
      const srcPath = p(k.file), dstPath = p(k.rename);
      renameSync(srcPath, dstPath);
      try {
        gate = runGate(k.full ? null : k.group);
      } finally {
        renameSync(dstPath, srcPath); // 落点必须回到原路径，闸跑成什么都不影响这一步
      }
    } else {
      const sabotaged = original.replace(k.from, k.to);
      if (sabotaged === original) { problems.push(`${k.id}: 替换没生效（from 与 to 相同？）`); continue; }
      writeFileSync(p(k.file), sabotaged, 'utf8');
      try {
        gate = runGate(k.full ? null : k.group);
      } finally {
        writeFileSync(p(k.file), original, 'utf8'); // 无论闸跑成什么、有没有抛，都用内存里的原始字节写回去
      }
    }
    const restored = readFileSync(p(k.file), 'utf8') === original && !existsSync(p(k.rename || '__none__')); // 逐字节回读校验
    const tripped = gate.rc !== 0 && k.assert.test(gate.out);
    const named = (gate.out.match(k.assert) || ['(日志里没有点名的那条 FAIL)'])[0].trim();
    k.rc = String(gate.rc);
    ledger.push({ id: k.id, group: k.group, breaks: k.breaks, rc: gate.rc, tripped, restored, named });
    say(`  [${tripped ? '逼红' : '未逼红'}] ${k.id} → ${k.group} · 破坏「${k.breaks}」 · doctest rc=${gate.rc}（${how}）`);
    say(`      点名的断言：${named}`);
    if (!restored) problems.push(`${k.id}: 复原后逐字节不一致（还原没做到）`);
    if (gate.rc === 0) problems.push(`${k.id}: 塞了这类谎 doctest 却还是 rc=0 —— 这一类谎没人守`);
    else if (!k.assert.test(gate.out)) problems.push(`${k.id}: doctest 红了但不是红在点名的那条（${k.group}）`);
  }
  const ctl = runGate(null); // 对照：完整跑一遍（自钉与四套闸的现跑都在这一次里）
  say(`对照（干净树 · 完整 doctest）：rc=${ctl.rc}`);
  if (ctl.rc !== 0) say(ctl.out.split('\n').filter((l) => l.includes('FAIL')).slice(0, 12).join('\n'));
  say('');
  say('== 破坏试验台账（rc 均为本次从闸读回的真实读数）==');
  say('| 刀 | 打哪组 | 破坏 | 逼到的断言 | 真实 rc |');
  say('|---|---|---|---|---|');
  for (const r of ledger) say(`| ${r.id} | ${r.group} | ${r.breaks} | ${r.named.slice(0, 44)} | ${r.rc} |`);
  say(`KNIVES=${ledger.length}`);
  return { lines, ctl, ledger };
}

const first = runPass();

// 自钉：把读回来的真实 rc 写进本文件的台账（幂等 —— 同样的刀只会得到同样的 rc）。
const selfPath = fileURLToPath(import.meta.url);
const selfSrc = readFileSync(selfPath, 'utf8');
let stamped = selfSrc;
for (const k of KNIVES) {
  const re = new RegExp(`(id: '${k.id}'[\\s\\S]*?rc: ')[^']*(')`);
  if (!re.test(stamped)) { problems.push(`自钉：找不到 ${k.id} 的 rc 槽`); continue; }
  stamped = stamped.replace(re, `$1${k.rc}$2`);
}
if (stamped !== selfSrc) writeFileSync(selfPath, stamped, 'utf8'); // 幂等：干净重跑时这里 no-op

console.log('\n—— 第二遍（幂等核对）——');
const second = runPass();
const identical = first.lines.join('\n') === second.lines.join('\n');
console.log(`\n幂等 stamping：两遍输出${identical ? '逐字节相同 ✓' : '不同 ✗'} · 刀数 ${second.ledger.length} · 本文件 rc 槽已钉成 ${KNIVES.map((k) => k.rc).join('/')}`);
if (!identical) {
  const a = first.lines, b = second.lines;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) console.log(`  第 ${i} 行不同：\n   一：${a[i]}\n   二：${b[i]}`);
}

if (problems.length) { console.log('\n台账不绿：'); for (const x of problems) console.log(`  - ${x}`); process.exit(1); }
if (!identical) { console.log('台账不绿：两遍输出不一致（自钉不幂等）'); process.exit(1); }
if (second.ctl.rc !== 0) { console.log('对照不绿：闸在干净树上是红的'); process.exit(1); }
console.log(`\n台账全绿：${second.ledger.length} 把刀各自逼红了点名的断言，复原逐字节一致，两遍输出相同，干净树对照 doctest 绿。`);
process.exit(0);
