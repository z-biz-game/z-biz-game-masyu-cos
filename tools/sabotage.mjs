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
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (rel) => join(ROOT, rel);

// 四把刀，各打 doctest 的一个不同组：D1 菜单档位、D6 端口默认号、D8 侧栏规则条数、D9 存档键名。
// 全是纯逻辑的常量改动，不碰浏览器也不碰 balance（子集跑因此每把刀只要几秒）。
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
    const sabotaged = original.replace(k.from, k.to);
    if (sabotaged === original) { problems.push(`${k.id}: 替换没生效（from 与 to 相同？）`); continue; }
    writeFileSync(p(k.file), sabotaged, 'utf8');
    let gate;
    try {
      gate = runGate(`${k.group}`);
    } finally {
      writeFileSync(p(k.file), original, 'utf8'); // 无论闸跑成什么、有没有抛，都用内存里的原始字节写回去
    }
    const restored = readFileSync(p(k.file), 'utf8') === original; // 逐字节回读校验
    const tripped = gate.rc !== 0 && k.assert.test(gate.out);
    const named = (gate.out.match(k.assert) || ['(日志里没有点名的那条 FAIL)'])[0].trim();
    k.rc = String(gate.rc);
    ledger.push({ id: k.id, group: k.group, breaks: k.breaks, rc: gate.rc, tripped, restored, named });
    say(`  [${tripped ? '逼红' : '未逼红'}] ${k.id} → ${k.group} · 破坏「${k.breaks}」 · doctest rc=${gate.rc}（DOC_GROUPS=${k.group} 子集跑）`);
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
