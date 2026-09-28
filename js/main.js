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

import { Palette, Space, applyThemeVars, setReduceMotion } from './theme.js';
import { Store } from './store.js';
import { makePuzzle, toView, SIZES, parseSize } from './engine/generate.js';
import { edgeIdOf, edgeCount, neighbor, dirBetween, checkLoop, loopOrder, UP, RIGHT, DOWN, LEFT, BLACK, WHITE } from './engine/loop.js';
import { createState, verify, solveWithRules, nextDeduction, RULE_ORDER, RULE_TEXT, edgeOf, valOf, unknownCount, LOOP, CUT, UNKNOWN } from './engine/pencil.js';
import { BoardView } from './render/board.js';
import { Game } from './ui/game.js';

const VERSION = '0.1.0';
const DEFAULT_SIZE = '6x6';
const $ = (id) => document.getElementById(id);

applyThemeVars();
setReduceMotion(Store.setting('reduceMotion') === true);

const canvas = $('board');
const wrap = $('board-wrap');
const veil = $('win-veil');
const stateLine = $('state-line');
const srCell = $('sr-cell');
const sizeSelect = $('size-select');
const verifyLine = $('verify-line');

const view = new BoardView(canvas);
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
const clock = () => baseElapsed + (startedAt ? Date.now() - startedAt : 0);
function startClock() {
  if (!startedAt) startedAt = Date.now();
}
function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
setInterval(() => {
  $('stat-time').textContent = fmt(clock());
}, 500);

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
  veil.hidden = false;
  $('win-meta').textContent = `环长 ${v.length} 格 · ${game.puzzle.pearlCount} 颗珠 · ${game.moves} 步 · ${fmt(clock())}`;
  stateLine.className = 'state-line good';
  stateLine.textContent = `verify() 判定通过：一条 ${v.length} 格的闭环，每颗珠子都服帖。`;
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
    if (hit) game.toggleCut(hit.cell, hit.d); // 不在手势里：setEdge 自己就是一组
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
  if (!game || !drag) return;
  const cell = view.hitCell(ev.clientX, ev.clientY);
  if (cell < 0) return;
  const last = drag.cells[drag.cells.length - 1];
  if (cell === last) return;
  const d = view.dirFromTo(last, cell);
  if (d < 0) return; // 不相邻：只挪笔，不连线
  drag.cells.push(cell);
  game.setEdge(last, d, drag.kind);
  cursor = cell;
  render();
});

async function endDrag() {
  if (!drag) return;
  drag = null;
  game.endGesture();
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
      if (d >= 0) {
        // 叉那支笔在键盘上是**翻**的：同一条边回车一次画叉、光标挪回来再回车一次擦回没落笔
        //（左键拖拽那支是铺笔，经过哪条写哪条，不翻转——一次拖拽翻一堆边会把人绕晕）。
        if (mode === 'cut') game.toggleCut(anchor, d);
        else game.setEdge(anchor, d, PEN[mode]);
      }
      game.endGesture();
      anchor = cursor;
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
    game.eraseAt(cursor);
    render();
    persist();
  } else if (k === 'z' || k === 'Z') {
    game.undo();
    render();
    persist();
  } else if (k === 'h' || k === 'H') {
    hint(); // 与按钮同一条路：点击与键盘按的是同一个函数，落的是同一个 Game 入口
  } else if (k === 'e' || k === 'E') {
    // 三支笔轮着切：画环 → 排除叉 → 擦掉 → 画环
    const order = ['loop', 'cut', 'erase'];
    setMode(order[(order.indexOf(mode) + 1) % order.length]);
    srCell.textContent = `画笔：${mode === 'loop' ? '画环' : mode === 'cut' ? '排除叉' : '擦掉'}`;
  } else if (k === 'n' || k === 'N') {
    await newGame({});
    return;
  } else return;
  render();
});

// ── 按钮 ────────────────────────────────────────────────────────────────
$('btn-new').addEventListener('click', () => newGame({}));
$('btn-again').addEventListener('click', () => newGame({}));
$('btn-close-veil').addEventListener('click', () => hideVeil());
$('btn-hint').addEventListener('click', () => hint());
$('btn-undo').addEventListener('click', async () => {
  if (!game) return;
  game.undo();
  render();
  persist();
});
$('btn-clear').addEventListener('click', () => {
  if (!game) return;
  game.clearAll();
  won = false;
  hideVeil();
  render();
  persist();
});
$('btn-mode-loop').addEventListener('click', () => setMode('loop'));
$('btn-mode-cut').addEventListener('click', () => setMode('cut'));
$('btn-mode-erase').addEventListener('click', () => setMode('erase'));
$('btn-motion').addEventListener('click', (ev) => {
  const next = !(ev.currentTarget.getAttribute('aria-pressed') === 'true');
  ev.currentTarget.setAttribute('aria-pressed', String(next));
  ev.currentTarget.textContent = next ? '动效 减' : '动效 全';
  setReduceMotion(next);
  Store.setSetting('reduceMotion', next);
});
$('btn-reset').addEventListener('click', () => {
  Store.reset();
  newGame({});
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
};

// ── 启动 ────────────────────────────────────────────────────────────────
(async function boot() {
  setMode('loop');
  // 先只看"有没有一份形状正确的存档"，笔迹/步数不在这里搬：newGame 要用存档里的 seed 重画出盘，
  // 再拿那张盘的真实指纹向 Store.resume(指纹) 对一次账（对不上就作废存档、开新局并说给玩家听）。
  // 续局要把存下的步数一并交回去：只搬笔迹不搬步数，画面就会显示「0 步」，
  // 而盘上明明已经画了十几段——这两个数都由 newGame 从存档里自己取，不在这里转手。
  const pending = Store.pendingResume();
  let started = null;
  if (pending) started = await newGame({ seed: pending.seed, sizeKey: pending.sizeKey, resumeFrom: pending });
  if (!started) await newGame({});
  window.masyu.state = 'ready';
})();
