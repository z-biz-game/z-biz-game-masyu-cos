// 接线：DOM、指针、键盘、时钟、存档，以及验收 harness 驱动的 window.masyu 那层门面。
//
// window.masyu.engine 挂的就是页面自己 import 的那张模块图（不是为测试另抄一份），所以
// 门禁在浏览器里绿一次，等于玩家那侧的出题器/推理机同时绿一次。
//
// 这里没有一条 Masyu 规则：落笔写进引擎的边数组，赢不赢问 verify()，画什么由 render/board.js
// 读同一批数字。「提示」也不在这里判断任何事——它只是问 nextDeduction 要一条被迫的结论，
// 再把那个边号交给 Game 的公开入口，和玩家自己拖的一笔是同一条路。
// 唯一留在这层的判断是「指针这一下落在哪一格、连着上一格的方向是什么」，
// 而那也要经 view.dirFromTo → loop.js 的 dirBetween/neighbor。

import { Palette, Space, applyThemeVars, setReduceMotion, systemPrefersReducedMotion } from './theme.js';
import { Store } from './store.js';
import { makePuzzle, toView, SIZES, parseSize } from './engine/generate.js';
import { edgeIdOf, edgeCount, neighbor, dirBetween, checkLoop, loopOrder, UP, RIGHT, DOWN, LEFT, BLACK, WHITE } from './engine/loop.js';
import { createState, verify, solveWithRules, nextDeduction, RULE_ORDER, RULE_TEXT, edgeOf, valOf, unknownCount, LOOP, CUT, UNKNOWN } from './engine/pencil.js';
import { BoardView } from './render/board.js';
import { Game } from './ui/game.js';
import { Sound } from './sound.js';
import { Fx } from './fx.js';

const VERSION = '0.1.0';
const DEFAULT_SIZE = '6x6';
const $ = (id) => document.getElementById(id);

applyThemeVars();
// reduceMotion 有两个来源：系统偏好（OS 说了算）与顶栏那枚手动开关（存档说了算）。
// 任意为真都算「要减动效」——只认存档的那个实现，等于把系统设置当耳旁风。
const motionReduced = () => Store.setting('reduceMotion') === true || systemPrefersReducedMotion();
setReduceMotion(motionReduced());

const canvas = $('board');
const wrap = $('board-wrap');
const veil = $('win-veil');
const pauseVeil = $('pause-veil');
const fxCanvas = $('fx');
const stateLine = $('state-line');
const srCell = $('sr-cell');
const sizeSelect = $('size-select');
const verifyLine = $('verify-line');

const view = new BoardView(canvas);
const fx = new Fx(fxCanvas);
fx.reduceMotion = motionReduced();
let game = null;
// 三支笔，对着引擎的三态：画环=LOOP、排除叉=CUT、擦掉=UNKNOWN。
// 「排除叉」是一支真的笔，不是「擦掉」的别名：它把一条边写成 CUT，画出来是一个小叉。
let mode = 'loop'; // 'loop' | 'cut' | 'erase'
const PEN = { loop: LOOP, cut: CUT, erase: UNKNOWN };
let drag = null;
let cursor = -1; // 键盘光标
let anchor = -1; // 键盘连线锚点
let won = false;
// 提示说过的那句话，以及它挂在哪一步之后。玩家再落一笔（或撤一步、换一局）它就过期——
// 一句「珠子必须在环上」还挂在状态行上，而盘已经变了三回，那是假线索。
let hintNote = null;
let noteMoves = -1;

// ── 时钟 ────────────────────────────────────────────────────────────────
let startedAt = 0;
let baseElapsed = 0;
let paused = false;
const clock = () => baseElapsed + (startedAt ? Date.now() - startedAt : 0);
function startClock() {
  // 暂停态不起表：玩家按 P 之后还能用键盘撤错笔（Z）与换画笔（E），那些不该计费。
  if (!startedAt && !paused) startedAt = Date.now();
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
setInterval(() => {
  $('stat-time').textContent = fmt(clock());
}, 500);

// ── 暂停 ────────────────────────────────────────────────────────────────
// 「暂停」成立的判据不是有个盖层，而是三件事同时停：计时表（baseElapsed 结算 + startedAt 归零）、
// 仿真（fx.paused 之后累加器连喂都不喂，见 js/fx.js 的 frame()）、声音（AudioContext 真的
// suspend()，见 js/sound.js）。恢复反向做一遍，且一个字节的状态都不动。
function setPaused(next) {
  const v = !!next;
  if (v === paused || !game) return paused;
  paused = v;
  if (paused) {
    baseElapsed = clock();
    startedAt = 0;
    fx.paused = true;
    Sound.suspendForPause();
    $('pause-meta').textContent = `${fmt(baseElapsed)} · ${game.moves} 步 · 已画 ${game.loopEdges().length} 段`;
    pauseVeil.hidden = false;
    $('btn-pause').setAttribute('aria-pressed', 'true');
    $('btn-pause').textContent = '继续';
    stateLine.className = 'state-line hint';
    stateLine.textContent = '已暂停：计时与动效都停在这里，笔迹与步数原样保留。按 P 或点「继续」接着走。';
    window.masyu.state = 'paused';
  } else {
    fx.paused = false;
    Sound.resumeFromPause();
    pauseVeil.hidden = true;
    startedAt = Date.now(); // 从恢复这一刻起重新走表，暂停掉的时长永远不计入
    $('btn-pause').setAttribute('aria-pressed', 'false');
    $('btn-pause').textContent = '暂停';
    window.masyu.state = won ? 'won' : 'playing';
    render();
  }
  return paused;
}

function togglePause() {
  return setPaused(!paused);
}

// 一次落笔的反馈：涟漪画在 #fx 上、音从 Sound 出。两者都不判断任何事，也不写引擎一个字节。
function pulse(kind, cell) {
  if (cell >= 0 && view.geo.cell) {
    const c = view.centerOf(cell);
    fx.spawn(c.x, c.y, kind);
  }
  Sound.play(kind);
}

// ── seed ────────────────────────────────────────────────────────────────
// 「换一局」必须真的换一局。日期当默认 seed 是两个隔壁仓刚踩过的坑：那个按钮叫换一局，
// 结果一整天都在发同一张盘。所以随机只发生在**选 seed**这一步，生成器内部一点随机都不许有。
let seedCounter = 0;
function mintSeed() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  seedCounter++;
  return `m${seedCounter.toString(36)}-${hex}`;
}

// ── 渲染 ────────────────────────────────────────────────────────────────
function avail() {
  const w = Math.max(280, wrap.clientWidth || 520);
  const h = Math.max(280, Math.min(w, window.innerHeight - 220));
  return { w, h };
}

function render() {
  if (!game) return;
  const preview = [];
  if (anchor >= 0 && cursor >= 0 && anchor !== cursor) {
    const d = view.dirFromTo(anchor, cursor);
    if (d >= 0) preview.push([anchor, d]);
  }
  view.draw(game, { preview, cursor, won });
  paintStats();
}

function paintStats() {
  const p = game.puzzle;
  const bad = game.badCells();
  const ends = game.endpoints();
  const segs = game.loopEdges();
  const cuts = game.cutEdges();
  $('stat-seed').textContent = `seed ${game.seed}`;
  $('stat-black').textContent = String(p.black);
  $('stat-white').textContent = String(p.white);
  $('stat-segs').textContent = String(segs.length);
  $('stat-cuts').textContent = String(cuts.length);
  $('stat-ends').textContent = String(ends.length);
  const badEl = $('stat-bad');
  badEl.textContent = String(bad.length);
  badEl.classList.toggle('bad', bad.length > 0);
  $('stat-moves').textContent = String(game.moves);
  $('stat-time').textContent = fmt(clock());
  const v = game.status();
  const vEl = $('stat-verify');
  vEl.textContent = v.ok ? `闭环 ${v.length} 格` : '未成';
  vEl.classList.toggle('good', !!v.ok);
  vEl.classList.remove('bad');
  verifyLine.textContent = v.ok
    ? `verify() → { ok: true, length: ${v.length} }`
    : `verify() → ${v.why}`;
  if (!won) {
    stateLine.className = 'state-line' + (bad.length ? ' bad' : '');
    stateLine.textContent = bad.length
      ? `${bad.length} 格引出了 3 条以上的环边 —— 那里不可能接成一条环。${v.why || ''}`
      : segs.length === 0
        ? '拖拽相邻两格连一段环；右键落在哪条边上就把那条边画成排除叉。黑珠那格必须拐，白珠那格必须直穿。'
        : `已画 ${segs.length} 段、排除 ${cuts.length} 条，${ends.length} 个没接上的端点。引擎说：${v.why || '成环了'}`;
  }
  // 提示那句话盖在进度播报之上：它是「刚刚发生的那件事」，而进度行每一帧都能重算出来。
  // 过期条件是步数变了（或者这局已经赢了），不是这里现编一个计时器。
  if (hintNote && !won && game.moves === noteMoves) {
    stateLine.className = 'state-line hint';
    stateLine.textContent = hintNote;
  } else {
    hintNote = null;
    noteMoves = -1;
  }
}

// ── 判胜：唯一的入口是引擎的 verify，UI 不给自己记账 ─────────────────────
function checkWin() {
  if (won) return true;
  const v = game.status();
  if (!v.ok) return false;
  won = true;
  window.masyu.state = 'won';
  veil.hidden = false;
  $('win-meta').textContent = `环长 ${v.length} 格 · ${game.puzzle.pearlCount} 颗珠 · ${game.moves} 步 · ${fmt(clock())}`;
  stateLine.className = 'state-line good';
  stateLine.textContent = `verify() 判定通过：一条 ${v.length} 格的闭环，每颗珠子都服帖。`;
  // 胜利反馈沿引擎自己算出来的环顺序撒点（loopOrder 来自 loop.js），不是在这层现推一遍路径。
  // reduceMotion 时 fx.spawn 自己会一个粒子都不产，这里不需要再加一支 if。
  const order = loopOrder(game.w, game.h, game.st.edges) || [];
  for (let i = 0; i < order.length; i += Math.max(1, Math.ceil(order.length / 14))) {
    const c = view.centerOf(order[i]);
    fx.spawn(c.x, c.y, 'win');
  }
  Sound.play('win');
  Store.recordSolve(clock(), game.moves);
  Store.clearResume();
  render();
  return true;
}

// ── 提示：引擎的下一条被迫结论，落笔仍然只经 Game 的公开入口 ──────────────────
// 关键不在「有个按钮」，而在**它和玩家自己画的是同一个写入者**：nextDeduction 只给一个边号，
// 边号 →（格, 方向）由 Game.setEdgeById 现取引擎预计算的 st.edgeCells 和 loop.js 的 dirBetween，
// 再走 setEdge。于是提示落的每一笔都进撤销栈、在 moves 上记一步：玩家撤得掉，门禁也数得出。
// 反过来，只要有一句结论绕过 Game 直接写 st.edges，那一步就不在账上 —— 撤销计数与存档就开始
// 各说一套。所以这里**不**用引擎自带的 applyDeduction（它写数组、记自己的 log，不认识撤销栈），
// window.masyu.engine 里也就不挂它：页面上没有一条能把结论直接写进边数组的路。
//
// nextDeduction 只有三种回话（见 js/engine/pencil.js 的函数注释），这里就只有三个分支：
// 被迫结论 / 盘自己打脸 / 推不动了。没有第四支「那提示替你猜一个」——猜就是读答案的另一面，
// 而答案（puzzle.solution、face.segs）在这一条路上一个字节都没被碰过。
function hint() {
  if (!game || won) return null;
  startClock();
  const d = nextDeduction(game.st);
  const mv = game.moves;
  if (d && d.contradiction) {
    // 打脸的时候铅笔不肯再往前推：该撤哪一笔是玩家自己的判断。这里不落笔，也不装成落了一笔。
    hintNote = `盘上自己打脸了（${d.rule}）：${d.why}。提示这一步什么都不画 —— 先撤掉那笔再说。`;
    noteMoves = mv;
    render();
    return { kind: 'contradiction', d, moved: false };
  }
  if (!d || d.stalled) {
    hintNote = `铅笔推不动了：${d && d.why ? d.why : `${RULE_ORDER.length} 条规则轮了一圈，没话可说`}。提示不会替你猜，也不会去读答案 —— 剩下的得你自己接。`;
    noteMoves = mv;
    render();
    return { kind: 'stalled', d, moved: false };
  }
  const rec = game.setEdgeById(d.edge, d.value);
  if (!rec) {
    // Game 拒收了引擎给的那一条（边号在盘外，或那条已经是这个值）。落不下去就照直说落不下去，
    // 不许退回「那按我们自己算的画」——那正是第二记分板的开头。
    hintNote = `提示这次没落下去：引擎给的是边号 ${d.edge}，Game 拒收（不在盘上或已经这样了）。再按一次。`;
    noteMoves = mv;
    render();
    return { kind: 'noop', d, moved: false };
  }
  hintNote = `${d.ruleText} —— ${d.why}`;
  noteMoves = game.moves; // 这一笔已经记上了，所以这句话挂在「这一笔之后」的那个步数上
  pulse(d.value === CUT ? 'cut' : 'hint', rec.cell); // 提示落笔与玩家落笔同一种反馈
  render();
  checkWin();
  persist();
  return { kind: d.value === CUT ? 'cut' : 'loop', d, rec, moved: true };
}

function hideVeil() {
  veil.hidden = true;
}

// ── 开局 ────────────────────────────────────────────────────────────────
let busy = false;
async function generate(seed, sizeKey) {
  busy = true;
  $('btn-new').disabled = true;
  $('btn-new').textContent = '生成中…';
  stateLine.className = 'state-line';
  stateLine.textContent = '正在出题：铅笔要零猜测推得完、计数器要说唯一、每颗珠子要证过删不得——三道门都过了才发给你。';
  // 生成器是同步的（6x6 实测几百毫秒），让出一帧好让「生成中」真的看得见
  await new Promise((r) => setTimeout(r, 0));
  const p = makePuzzle(seed, sizeKey, { requireBothColors: false });
  busy = false;
  $('btn-new').disabled = false;
  $('btn-new').textContent = '换一局';
  return p;
}

async function newGame({ seed = mintSeed(), sizeKey = game ? game.sizeKey : DEFAULT_SIZE, marks = null, moves = 0, elapsedMs = 0, resumeFrom = null } = {}) {
  const p = await generate(seed, sizeKey);
  if (!p.ok) {
    stateLine.className = 'state-line bad';
    stateLine.textContent = `这个 seed 出不了盘（${p.status}）：换一个。`;
    return null;
  }
  game = new Game(p);
  // 续局的判据不是「有没有这份存档」，而是「存档里那张盘和现在重画出来的是不是同一张」：
  // 存档存的正是 seed（js/store.js 头部），生成器一改版（本轮加的挖珠门 2）seed→题面 就换人，
  // 旧笔迹贴上去就是让玩家在自己没玩过的盘上续命。Store.resume(指纹) 对不上会返回 null 并作废存档。
  const resume = resumeFrom ? Store.resume(p.fingerprint) : null;
  const carry = resume ? { marks: resume.marks, moves: resume.moves, elapsedMs: resume.elapsedMs } : { marks, moves, elapsedMs };
  // 存档的字符串长度必须正好对上这张盘的边数——对不上就不搬（尺寸换过、串被截断都算）。
  // 步数只在笔迹真的搬过来之后才跟着搬：盘是空的却说「这局走了 12 步」又是另一句谎话。
  if (typeof carry.marks === 'string' && carry.marks.length === edgeCount(p.w, p.h)) game.decode(carry.marks, carry.moves);
  // 新一局（含续局重建）不带上上一局的提示：那句话讲的是上一张盘的最后一步，挂在这张盘上是假线索。
  hintNote = null;
  noteMoves = -1;
  won = false;
  hideVeil();
  // 暂停态与上一局的涟漪都不许跨过「换一局」活下来：只调一次 init() 而漏掉缓存层，
  // 新一局的第一帧就还在画旧局的粒子，而盖层还压在盘上按不动。
  paused = false;
  pauseVeil.hidden = true;
  $('btn-pause').setAttribute('aria-pressed', 'false');
  $('btn-pause').textContent = '暂停';
  fx.paused = false;
  fx.clear();
  window.masyu.state = 'playing';
  // 键盘光标只在真的用键盘之后才出现：一个刚用鼠标点开游戏的玩家不该先看见一圈虚线
  cursor = -1;
  anchor = -1;
  baseElapsed = carry.elapsedMs || 0;
  startedAt = Date.now();
  relayout();
  render();
  persist();
  // 作废的那份存档要当着玩家说清楚：这一局是新的，不是他那一局（原因是生成器改版重算了题面）。
  // 写在 persist() 之后，因为 persist 已经把这张新盘存下去了，玩家下一次刷新就是正常续局。
  if (resumeFrom && !resume) {
    stateLine.className = 'state-line hint';
    stateLine.textContent = '这一局的存档与现在重画出来的题面对不上（存档存的是 seed，出题器改版后同一个 seed 是另一张盘）：旧笔迹没有搬过来，这一局重新开始。';
  }
  return game;
}

function relayout() {
  if (!game) return;
  const a = avail();
  view.resize(game, a.w, a.h);
  // 反馈层与盘面必须逐像素同尺寸：CSS 里它们叠在同一格，尺寸差一点涟漪就偏一点。
  fx.resize(view.geo.w, view.geo.h, view.geo.dpr);
}

function persist() {
  if (!game || won) return;
  Store.saveResume(game, clock());
}

function setMode(next) {
  // 判「这个笔名认不认」用 in，不用取值真假：擦掉那支笔的 kind 就是 UNKNOWN=0，
  // 写成 PEN[next] ? next : 'loop' 会把「擦掉」当成没认出来、悄悄退回画环。
  mode = next in PEN ? next : 'loop';
  $('btn-mode-loop').setAttribute('aria-pressed', String(mode === 'loop'));
  $('btn-mode-cut').setAttribute('aria-pressed', String(mode === 'cut'));
  $('btn-mode-erase').setAttribute('aria-pressed', String(mode === 'erase'));
  canvas.style.cursor = mode === 'erase' ? 'cell' : 'crosshair';
}

// ── 指针 ────────────────────────────────────────────────────────────────
// 拖拽走的是「相邻格心」：每一段都问 view 要方向，view 再问 loop.js。
// 不相邻的两格（甩太快）只会挪锚点，不会凭空长出一条斜边。
// 左键是**铺笔**：经过的每一条边都写成当前那支笔（loop→LOOP、cut→CUT、erase→UNKNOWN），
// 一整笔拖拽是一组撤销。右键是**就动指针压着的那一条边**：叉 ↔ 没落笔（LOOP 先变叉），
// 一次点击一组撤销一步。
canvas.addEventListener('pointerdown', (ev) => {
  if (!game) return;
  if (paused) return; // 暂停就是暂停：盖层之下不许再落任何一笔，否则「暂停」只是块半透明贴纸
  const cell = view.hitCell(ev.clientX, ev.clientY);
  if (cell < 0) return;
  ev.preventDefault();
  try {
    canvas.setPointerCapture(ev.pointerId);
  } catch {
    /* 合成事件没有真的 pointerId：下面的 move/up 仍然按 clientX/Y 走同一条路 */
  }
  startClock();
  if (ev.button === 2) {
    const hit = view.hitEdge(ev.clientX, ev.clientY);
    if (hit) {
      game.toggleCut(hit.cell, hit.d);
      pulse('cut', hit.cell);
    }
    render();
    persist();
    return;
  }
  const kind = PEN[mode];
  game.beginGesture();
  drag = { cells: [cell], kind };
  cursor = cell;
  if (mode === 'erase') game.eraseAt(cell);
  else if (mode === 'cut') {
    const hit = view.hitEdge(ev.clientX, ev.clientY);
    if (hit) game.setEdge(hit.cell, hit.d, CUT);
  }
  render();
});

canvas.addEventListener('pointermove', (ev) => {
  if (!game || !drag || paused) return;
  const cell = view.hitCell(ev.clientX, ev.clientY);
  if (cell < 0) return;
  const last = drag.cells[drag.cells.length - 1];
  if (cell === last) return;
  const d = view.dirFromTo(last, cell);
  if (d < 0) return; // 不相邻：只挪笔，不连线
  drag.cells.push(cell);
  if (game.setEdge(last, d, drag.kind)) {
    // 拖一笔经过十几格，逐格发声就是一串机关枪：这一层只发涟漪，音留到收笔那一下放一次。
    const c = view.centerOf(cell);
    fx.spawn(c.x, c.y, mode === 'erase' ? 'erase' : mode === 'cut' ? 'cut' : 'loop');
  }
  cursor = cell;
  render();
});

async function endDrag() {
  if (!drag) return;
  const kind = drag.kind;
  drag = null;
  const changed = game.endGesture();
  if (changed) {
    Sound.play(mode === 'erase' ? 'erase' : kind === CUT ? 'cut' : 'loop');
    // 收笔之后盘上多出「接不通」的格：给一声低音，它是那一圈红的听觉版本，不是新判断。
    if (game.badCells().length) Sound.play('bad');
  }
  render();
  await checkWin();
  persist();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

// ── 键盘 ────────────────────────────────────────────────────────────────
window.addEventListener('keydown', async (ev) => {
  if (!game) return;
  if (ev.target && /INPUT|SELECT|TEXTAREA/.test(ev.target.tagName)) return;
  const k = ev.key;
  // 四个全局控制键站在那道「暂停就不接键」的闸之前：暂停中按 P 必须能回来，按 M 要能开关
  // 声音，按 R/N 要能换一局（newGame 自己会把暂停态解掉）。它们都不改盘上的一个字节。
  if (k === 'p' || k === 'P') {
    ev.preventDefault();
    togglePause();
    return;
  }
  if (k === 'm' || k === 'M') {
    ev.preventDefault();
    setMutedUI(Sound.toggleMuted());
    return;
  }
  if (k === 'f' || k === 'F') {
    ev.preventDefault();
    toggleFullscreen();
    return;
  }
  if (k === 'r' || k === 'R' || k === 'n' || k === 'N') {
    ev.preventDefault();
    await newGame({});
    return;
  }
  if (k === '?') {
    // 教学不另写一份文案：把面板里那三条规则滚到眼前，并原样念给读屏（同一批 DOM 文本）。
    const ol = document.querySelector('.rules');
    if (ol) {
      ol.scrollIntoView({ block: 'center' });
      srCell.textContent = ol.textContent;
    }
    return;
  }
  if (paused) return; // 暂停态下任何会改盘、会挪光标的键都不接
  const w = game.w;
  const h = game.h;
  const move = (dr, dc) => {
    if (cursor < 0) cursor = 0;
    const r = Math.min(h - 1, Math.max(0, Math.floor(cursor / w) + dr));
    const c = Math.min(w - 1, Math.max(0, (cursor % w) + dc));
    cursor = r * w + c;
    anchor = -1;
    srCell.textContent = game.cellReport(cursor);
  };
  if (k === 'ArrowUp') move(-1, 0);
  else if (k === 'ArrowDown') move(1, 0);
  else if (k === 'ArrowLeft') move(0, -1);
  else if (k === 'ArrowRight') move(0, 1);
  else if (k === 'Enter' || k === ' ') {
    ev.preventDefault();
    startClock();
    if (cursor < 0) cursor = 0; // 纯键盘进场的玩家可能还没碰过方向键
    if (anchor < 0) {
      anchor = cursor;
      srCell.textContent = `锚在第 ${Math.floor(cursor / w) + 1} 行第 ${cursor % w + 1} 列`;
    } else if (anchor !== cursor) {
      const d = view.dirFromTo(anchor, cursor);
      game.beginGesture();
      let wrote = null;
      if (d >= 0) {
        // 叉那支笔在键盘上是**翻**的：同一条边回车一次画叉、光标挪回来再回车一次擦回没落笔
        //（左键拖拽那支是铺笔，经过哪条写哪条，不翻转——一次拖拽翻一堆边会把人绕晕）。
        if (mode === 'cut') wrote = game.toggleCut(anchor, d);
        else wrote = game.setEdge(anchor, d, PEN[mode]);
      }
      game.endGesture();
      anchor = cursor;
      if (wrote) pulse(mode === 'erase' ? 'erase' : mode === 'cut' ? 'cut' : 'loop', cursor);
      render();
      await checkWin();
      persist();
    }
  } else if (k === 'Escape') {
    anchor = -1;
    hideVeil();
  } else if (k === 'Backspace' || k === 'Delete') {
    ev.preventDefault();
    startClock();
    // eraseAt 不在拖拽组里时自己就把这一步压进撤销栈了，别再 undo 一次抵消掉
    if (game.eraseAt(cursor)) pulse('erase', cursor);
    render();
    persist();
  } else if (k === 'z' || k === 'Z') {
    game.undo();
    Sound.play('erase');
    render();
    persist();
  } else if (k === 'h' || k === 'H') {
    hint(); // 与按钮同一条路：点击与键盘按的是同一个函数，落的是同一个 Game 入口
  } else if (k === 'e' || k === 'E') {
    // 三支笔轮着切：画环 → 排除叉 → 擦掉 → 画环
    const order = ['loop', 'cut', 'erase'];
    setMode(order[(order.indexOf(mode) + 1) % order.length]);
    srCell.textContent = `画笔：${mode === 'loop' ? '画环' : mode === 'cut' ? '排除叉' : '擦掉'}`;
  } else return;
  render();
});

// ── 按钮 ────────────────────────────────────────────────────────────────
// 静音与全屏的标签只有一个写的人：setMutedUI / syncFullscreenLabel。点击、键盘 M/F、
// 以及浏览器自己发的 fullscreenchange 都只能经它们改文案——两处写就能出现「按钮写着开、
// AudioContext 其实停着」这种各说一套。
function setMutedUI(muted) {
  const b = $('btn-sound');
  b.setAttribute('aria-pressed', String(!muted));
  b.textContent = muted ? '音效 关' : '音效 开';
  if (!muted) Sound.play('hint'); // 刚开声就给一声确认：不然玩家不知道自己到底开了没有
  return muted;
}

function toggleFullscreen() {
  const d = document;
  if (d.fullscreenElement || d.webkitFullscreenElement || d.msFullscreenElement) {
    const exit = d.exitFullscreen || d.webkitExitFullscreen || d.msExitFullscreen;
    if (exit) Promise.resolve(exit.call(d)).catch(() => {});
    return;
  }
  const el = $('app') || d.documentElement;
  // 三套前缀都探：老 Edge 只认 ms 前缀（它把 msRequestFullscreen 挂在元素上）。
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if (!req) {
    stateLine.className = 'state-line hint';
    stateLine.textContent = '这台设备没给全屏接口（requestFullscreen 不存在）：这一条我做不到，盘面照常能玩。';
    return;
  }
  Promise.resolve(req.call(el)).catch(() => {
    stateLine.className = 'state-line hint';
    stateLine.textContent = '全屏被系统拒了（通常是浏览器要求先进手势）：再点一次，或者用 F。';
  });
}

function syncFullscreenLabel() {
  const on = !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
  const b = $('btn-fullscreen');
  b.setAttribute('aria-pressed', String(on));
  b.textContent = on ? '退出全屏' : '全屏';
}

$('btn-new').addEventListener('click', () => newGame({}));
$('btn-again').addEventListener('click', () => newGame({}));
$('btn-close-veil').addEventListener('click', () => hideVeil());
$('btn-hint').addEventListener('click', () => hint());
$('btn-pause').addEventListener('click', () => setPaused(!paused));
$('btn-resume').addEventListener('click', () => setPaused(false));
$('btn-sound').addEventListener('click', () => setMutedUI(Sound.toggleMuted()));
$('btn-fullscreen').addEventListener('click', () => toggleFullscreen());
document.addEventListener('fullscreenchange', syncFullscreenLabel);
document.addEventListener('webkitfullscreenchange', syncFullscreenLabel);
$('btn-undo').addEventListener('click', async () => {
  if (!game) return;
  game.undo();
  Sound.play('erase');
  render();
  persist();
});
$('btn-clear').addEventListener('click', () => {
  if (!game) return;
  game.clearAll();
  won = false;
  hideVeil();
  fx.clear();
  Sound.play('erase');
  render();
  persist();
});
// 暂停按钮的接线只有上面那一条（btn-clear 那组之后就是它）：
// 并线时这一颗按钮上挂了两个处理器 ⇒ 一次点击进出各一次，净效果是"按了没反应"。
$('btn-mode-loop').addEventListener('click', () => setMode('loop'));
$('btn-mode-cut').addEventListener('click', () => setMode('cut'));
$('btn-mode-erase').addEventListener('click', () => setMode('erase'));
$('btn-motion').addEventListener('click', (ev) => {
  const next = !(ev.currentTarget.getAttribute('aria-pressed') === 'true');
  ev.currentTarget.setAttribute('aria-pressed', String(next));
  ev.currentTarget.textContent = next ? '动效 减' : '动效 全';
  setReduceMotion(next);
  Store.setSetting('reduceMotion', next);
  // 关掉动效之后屏幕上还在飘旧粒子 = 没关。所以这里既翻开关，也当场清场。
  fx.reduceMotion = motionReduced();
  if (fx.reduceMotion) fx.clear();
});
$('btn-reset').addEventListener('click', () => {
  Store.reset();
  newGame({});
});

// 切到后台就自动暂停：玩家看不见的那几分钟不该算进本局耗时，也不该让涟漪在看不见时推进。
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game && !won && !paused) setPaused(true);
});

for (const s of SIZES) {
  const o = document.createElement('option');
  o.value = s;
  o.textContent = s;
  sizeSelect.appendChild(o);
}
sizeSelect.value = DEFAULT_SIZE;
sizeSelect.addEventListener('change', async () => {
  const { w } = parseSize(sizeSelect.value);
  // 尺寸一换就是新一局：不同 w×h 的边数组长度不同，旧存档的笔迹没法搬过去
  await newGame({ sizeKey: sizeSelect.value });
});

window.addEventListener('resize', () => {
  relayout();
  render();
});
window.addEventListener('pagehide', persist);

// ── 门面 ────────────────────────────────────────────────────────────────
window.masyu = {
  version: VERSION,
  state: 'booting',
  engine: {
    makePuzzle, toView, parseSize, SIZES, verify, createState, solveWithRules, nextDeduction, RULE_ORDER, RULE_TEXT,
    edgeIdOf, edgeCount, neighbor, dirBetween, checkLoop, loopOrder,
    edgeOf, valOf, unknownCount,
    UP, RIGHT, DOWN, LEFT, LOOP, CUT, UNKNOWN, BLACK, WHITE,
    // 有意不挂 applyDeduction：它是「直接把结论写进边数组」的那条旁路。页面上（以及门禁里）
    // 落结论只有 Game.setEdgeById 一个入口，于是撤销栈与 moves 不可能被提示绕过。
  },
  view,
  // 反馈层与声音的真状态：探针要能自己判断「暂停期间仿真到底推没推」，
  // 而不是听这里写的一句字符串。fx.state() 里是 clock/simSteps/accum/particles。
  fx,
  sound: Sound,
  // —— 暂停：给闸台读的那张脸 ——
  get paused() {
    return paused;
  },
  get elapsedMs() {
    return clock();
  },
  setPaused,
  togglePause,
  toggleFullscreen,
  toggleMuted: () => setMutedUI(Sound.toggleMuted()),
  get game() {
    return game;
  },
  get won() {
    return won;
  },
  get mode() {
    return mode;
  },
  setMode,
  hint,
  newGame,
  mintSeed,
  checkWin,
  render,
  relayout,
  hideVeil,
  store: Store,
  palette: Palette,
  space: Space,
  /** 正在推进的那个数（毫秒）。暂停时它必须一毫秒不动 —— 这就是"真冻结"的判据。 */
  simClock: () => clock(),
};

// ── 启动 ────────────────────────────────────────────────────────────────
(async function boot() {
  setMode('loop');
  // 音效按钮的初值由 Sound 手里那个真标志决定（它读的是存档里的 sound 设置），
  // 不是这里另写一遍「默认关」——两处写默认值，早晚会有一处和 AudioContext 的状态打架。
  setMutedUI(Sound.muted());
  syncFullscreenLabel();
  fx.start();
  // 粒子条是盘上真有的文件（assets/gen/gen_art.py 产的 art/fx-sprites.png）。经
  // document.baseURI 解析：Pages 的 /前缀/ 下硬编相对路径会 404。取不到就退回程序化画圆环，不抛。
  // 另一张 art/board-texture.png 走 CSS（页面底 + 暂停盖层）：canvas 里那些点被门禁逐颗取样，
  // 织纹铺进盘底就是在改量具的参照物。
  await fx.loadSprite(new URL('art/fx-sprites.png', document.baseURI).href);
  // 先只看"有没有一份形状正确的存档"，笔迹/步数不在这里搬：newGame 要用存档里的 seed 重画出盘，
  // 再拿那张盘的真实指纹向 Store.resume(指纹) 对一次账（对不上就作废存档、开新局并说给玩家听）。
  // 续局要把存下的步数一并交回去：只搬笔迹不搬步数，画面就会显示「0 步」，
  // 而盘上明明已经画了十几段——这两个数都由 newGame 从存档里自己取，不在这里转手。
  const pending = Store.pendingResume();
  let started = null;
  if (pending) started = await newGame({ seed: pending.seed, sizeKey: pending.sizeKey, resumeFrom: pending });
  if (!started) await newGame({});
  window.masyu.state = paused ? 'paused' : 'playing';
})();
